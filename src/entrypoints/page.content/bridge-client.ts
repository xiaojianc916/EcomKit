/**
 * ISOLATED 侧的 bridge 客户端（方案 §7.4）。
 *
 * 三件事：
 *   1. 读取 MAIN 在 document_start 写到 documentElement 上的前缀（读到立即删除属性）
 *   2. 下发页面类型和抓取规则（MAIN 早已按 URL 装好规则，这里只做追加），MAIN 收到后回放缓冲
 *   3. 提供 readGlobal() 和 captures() 两个异步接口给 resolver 用
 *
 * 前缀只能读一次（读完属性就删了），所以通道是**整页单例**；SPA 换商品时只重建
 * 会话（监听器 / 缓冲），不重新握手。
 *
 * 安全：MAIN 传回来的数据一律先 JSON.parse 再 Zod 校验，候选地址还要过 cdnHosts 白名单。
 */

import { createLogger } from '../../kernel/log/logger';
import {
  type BridgeCaptureMessage,
  type BridgeHello,
  type BridgeReadGlobalResult,
  bridgeEvent,
  consumeBridgePrefix,
} from '../../kernel/messaging/page-bridge';
import type { CapturedPayload, PlatformManifest } from '../../platforms/types';

const log = createLogger('page-bridge-client');

/** 抓包环形缓冲在 ISOLATED 侧也留一份，方便后续订阅者回放已到达的数据 */
const CAPTURE_BUFFER_SIZE = 60;
/**
 * 抓包缓冲的总字符上限（约 16MB UTF-16）。
 *
 * 只按条数限（60 条）不够：单条允许 3MB，60 条就是 180MB 的原始文本，
 * 解析成对象后再涨两三倍 —— 页面主线程还没开始干活就先被内存压垮。
 * 超限时丢最旧的（当前商品的详情响应通常是最新到的那一条，会被保留）。
 */
const CAPTURE_BUFFER_CHARS = 8_000_000;
/** readGlobal 是同步派发的事件，正常 1ms 内就回；超时只是兜底 */
const READ_GLOBAL_TIMEOUT_MS = 1500;

export interface PageBridge {
  /** 当前页面类型的抓取规则 id 列表 */
  ruleIds(): string[];
  readGlobal(path: string): Promise<unknown>;
  /** 已缓冲的 + 之后到达的抓包；signal 中止时迭代器正常结束 */
  captures(ruleId: string, signal?: AbortSignal): AsyncIterable<CapturedPayload>;
  dispose(): void;
}

/**
 * 缓冲里的一条抓包：**只留原始 JSON 文本**，解析推迟到有人真的消费它时。
 *
 * 为什么不在这里解析：hello 时 MAIN 会同步回放整个环形缓冲，
 * 每条都要 JSON.parse 一遍（几 MB 的 JSON 是 10~20ms 级），60 条就是一次几百毫秒的长任务。
 * 而且解析出来的对象比文本大 2~3 倍，没人订阅的规则会白占内存。
 * state 缓存解析结果，多个订阅者共享同一次 parse。
 */
interface BufferedCapture {
  ruleId: string;
  url: string;
  text: string;
  at: number;
  state: 'raw' | 'ok' | 'failed';
  parsed?: unknown;
}

/** undefined = 还没尝试过；null = MAIN 没有就位（被 CSP 拦、页面不匹配等） */
let channelPrefix: string | null | undefined;

function channel(): string | null {
  if (channelPrefix === undefined) channelPrefix = consumeBridgePrefix(document);
  return channelPrefix;
}

/**
 * 建立一次会话。MAIN 不在时返回 null —— 调用方退回到「只读内联 SSR + DOM」，
 * 而不是像旧实现那样每个 readGlobal 都空等 3 秒。
 */
export function createPageBridge(manifest: PlatformManifest, pageKind: string): PageBridge | null {
  const prefix = channel();
  if (!prefix) {
    log.debug('MAIN bridge not found, fallback to inline SSR + DOM');
    return null;
  }

  const listeners = new Set<(entry: BufferedCapture) => void>();
  /**
   * 抓包环形缓冲。用「数组 + 写指针」而不是 push/shift：
   * shift() 是 O(n) 且每一步都要搬动整个数组，抓包源在商品页里可能连吐几十条
   * 几 MB 的 JSON，几十次搬动就是几十次大数组复制。
   * 被淘汰的槽位置成 undefined，让那块文本能立刻被 GC 回收。
   */
  const buffer: Array<BufferedCapture | undefined> = [];
  let bufferStart = 0;
  let bufferChars = 0;
  const pendingReads = new Map<string, { resolve: (v: unknown) => void; timer: number }>();
  /** 正在等新抓包的迭代器；dispose 时统一唤醒让它们退出 */
  const wakers = new Set<() => void>();
  let seq = 0;
  let disposed = false;

  const rules = manifest.capture.filter((r) => r.pageKinds.includes(pageKind));

  const onCapture = (ev: Event) => {
    let msg: BridgeCaptureMessage;
    try {
      msg = JSON.parse((ev as CustomEvent<string>).detail) as BridgeCaptureMessage;
    } catch {
      return;
    }
    if (msg.dropped || msg.json === null) return;
    const entry: BufferedCapture = {
      ruleId: msg.ruleId,
      url: msg.url,
      text: msg.json,
      at: msg.at,
      state: 'raw',
    };
    buffer.push(entry);
    bufferChars += entry.text.length;
    // 条数或总字符数超限就丢最旧的；等积压到两倍容量时再一次性压缩，摊还 O(1)
    while (
      bufferStart < buffer.length &&
      (buffer.length - bufferStart > CAPTURE_BUFFER_SIZE || bufferChars > CAPTURE_BUFFER_CHARS)
    ) {
      bufferChars -= buffer[bufferStart]?.text.length ?? 0;
      buffer[bufferStart] = undefined;
      bufferStart += 1;
    }
    if (bufferStart >= CAPTURE_BUFFER_SIZE) {
      buffer.splice(0, bufferStart);
      bufferStart = 0;
    }
    for (const cb of listeners) cb(entry);
  };

  const onReadResult = (ev: Event) => {
    let res: BridgeReadGlobalResult;
    try {
      res = JSON.parse((ev as CustomEvent<string>).detail) as BridgeReadGlobalResult;
    } catch {
      return;
    }
    const pending = pendingReads.get(res.id);
    if (!pending) return;
    pendingReads.delete(res.id);
    clearTimeout(pending.timer);
    if (!res.ok || res.json === undefined) {
      pending.resolve(undefined);
      return;
    }
    try {
      pending.resolve(JSON.parse(res.json));
    } catch {
      pending.resolve(undefined);
    }
  };

  document.addEventListener(bridgeEvent.capture(prefix), onCapture);
  document.addEventListener(bridgeEvent.readGlobalResult(prefix), onReadResult);

  // hello：MAIN 追加规则并**同步**回放它在 document_start 之后缓冲的抓包
  const hello: BridgeHello & { rules: unknown[] } = {
    pageKind,
    ruleIds: rules.map((r) => r.id),
    rules: rules.map((r) => ({
      id: r.id,
      urlPattern: r.urlPattern,
      maxBytes: r.maxBytes ?? 3 * 1024 * 1024,
      pageKinds: r.pageKinds,
    })),
  };
  document.dispatchEvent(
    new CustomEvent(bridgeEvent.hello(prefix), { detail: JSON.stringify(hello) }),
  );

  return {
    ruleIds: () => rules.map((r) => r.id),

    readGlobal(path: string): Promise<unknown> {
      if (disposed) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        const id = `r${++seq}`;
        const timer = window.setTimeout(() => {
          pendingReads.delete(id);
          resolve(undefined);
        }, READ_GLOBAL_TIMEOUT_MS);
        pendingReads.set(id, { resolve, timer });
        document.dispatchEvent(
          new CustomEvent(bridgeEvent.readGlobal(prefix), {
            detail: JSON.stringify({ id, path }),
          }),
        );
      });
    },

    captures(ruleId: string, signal?: AbortSignal): AsyncIterable<CapturedPayload> {
      /**
       * 惰性解析 + 结果缓存在 entry 上：多条订阅者共享同一次 parse，
       * 没有任何订阅者时（例如只靠 SSR 的页面）一条都不用解析。
       */
      const parse = (entry: BufferedCapture): CapturedPayload | null => {
        if (entry.state === 'failed') return null;
        if (entry.state === 'raw') {
          try {
            entry.parsed = JSON.parse(entry.text);
            entry.state = 'ok';
          } catch {
            entry.state = 'failed';
            return null;
          }
        }
        return { ruleId: entry.ruleId, url: entry.url, json: entry.parsed, at: entry.at };
      };

      const snapshot = buffer
        .slice(bufferStart)
        .filter((e): e is BufferedCapture => e !== undefined && e.ruleId === ruleId);
      return {
        async *[Symbol.asyncIterator]() {
          for (const entry of snapshot) {
            if (signal?.aborted || disposed) return;
            const payload = parse(entry);
            if (payload !== null) yield payload;
          }
          const queue: BufferedCapture[] = [];
          let queueStart = 0;
          let wake: (() => void) | null = null;
          const cb = (entry: BufferedCapture) => {
            if (entry.ruleId !== ruleId) return;
            queue.push(entry);
            wake?.();
          };
          const onAbort = () => wake?.();
          listeners.add(cb);
          wakers.add(onAbort);
          signal?.addEventListener('abort', onAbort, { once: true });
          try {
            // 旧实现是无条件 while(true)：没有退出条件，整个识别永远不会结束
            while (!signal?.aborted && !disposed) {
              if (queueStart < queue.length) {
                const entry = queue[queueStart];
                queueStart += 1;
                // 读完一半就压缩一次，避免 queue 无限增长（shift 是 O(n)，这里是摊还 O(1)）
                if (queueStart > 32 && queueStart * 2 > queue.length) {
                  queue.splice(0, queueStart);
                  queueStart = 0;
                }
                if (entry === undefined) continue;
                const payload = parse(entry);
                if (payload !== null) yield payload;
                continue;
              }
              await new Promise<void>((r) => {
                wake = r;
              });
              wake = null;
            }
          } finally {
            listeners.delete(cb);
            wakers.delete(onAbort);
            signal?.removeEventListener('abort', onAbort);
          }
        },
      };
    },

    dispose() {
      disposed = true;
      document.removeEventListener(bridgeEvent.capture(prefix), onCapture);
      document.removeEventListener(bridgeEvent.readGlobalResult(prefix), onReadResult);
      for (const [, p] of pendingReads) {
        clearTimeout(p.timer);
        p.resolve(undefined);
      }
      pendingReads.clear();
      listeners.clear();
      for (const w of [...wakers]) w();
      log.debug('page bridge disposed');
    },
  };
}
