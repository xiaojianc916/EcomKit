/**
 * ISOLATED 侧的 bridge 客户端（方案 §7.4）。
 *
 * 三件事：
 *   1. document_start 时生成随机前缀写进 documentElement，MAIN 读到后立即删除属性
 *   2. 下发页面类型和抓取规则，MAIN 才开始包装 fetch/XHR
 *   3. 提供 readGlobal() 和 captures() 两个异步接口给 resolver 用
 *
 * 安全：MAIN 传回来的数据一律先 JSON.parse 再 Zod 校验，候选地址还要过 cdnHosts 白名单。
 */
import {
  bridgeEvent,
  publishBridgePrefix,
  type BridgeCaptureMessage,
  type BridgeHello,
  type BridgeReadGlobalResult,
} from '../../kernel/messaging/page-bridge';
import type { CapturedPayload } from '../../platforms/types';
import type { PlatformManifest } from '../../platforms/types';
import { createLogger } from '../../kernel/log/logger';

const log = createLogger('page-bridge-client');

/** 抓包环形缓冲在 ISOLATED 侧也留一份，方便后续订阅者回放已到达的数据 */
const CAPTURE_BUFFER_SIZE = 60;

export interface PageBridge {
  /** 当前页面类型的抓取规则 id 列表 */
  ruleIds(): string[];
  readGlobal(path: string): Promise<unknown>;
  captures(ruleId: string): AsyncIterable<CapturedPayload>;
  dispose(): void;
}

export function createPageBridge(manifest: PlatformManifest, pageKind: string): PageBridge {
  const prefix = publishBridgePrefix(document);
  const listeners = new Set<(p: CapturedPayload) => void>();
  const buffer: CapturedPayload[] = [];
  const pendingReads = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: number }
  >();
  let seq = 0;

  const rules = manifest.capture.filter((r) => r.pageKinds.includes(pageKind));

  const onCapture = (ev: Event) => {
    let msg: BridgeCaptureMessage;
    try {
      msg = JSON.parse((ev as CustomEvent<string>).detail) as BridgeCaptureMessage;
    } catch {
      return;
    }
    if (msg.dropped || msg.json === null) return;
    let json: unknown;
    try {
      json = JSON.parse(msg.json);
    } catch {
      return;
    }
    const payload: CapturedPayload = { ruleId: msg.ruleId, url: msg.url, json, at: msg.at };
    buffer.push(payload);
    if (buffer.length > CAPTURE_BUFFER_SIZE) buffer.shift();
    for (const cb of listeners) cb(payload);
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

  // 下发 hello：告诉 MAIN 只装载这些规则
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
      return new Promise((resolve) => {
        const id = 'r' + (++seq);
        const timer = window.setTimeout(() => {
          pendingReads.delete(id);
          resolve(undefined);
        }, 3000);
        pendingReads.set(id, { resolve, reject: resolve, timer });
        document.dispatchEvent(
          new CustomEvent(bridgeEvent.readGlobal(prefix), {
            detail: JSON.stringify({ id, path }),
          }),
        );
      });
    },

    captures(ruleId: string): AsyncIterable<CapturedPayload> {
      const snapshot = buffer.filter((p) => p.ruleId === ruleId);
      return {
        async *[Symbol.asyncIterator]() {
          for (const p of snapshot) yield p;
          // 之后到达的用监听器接力；signal 由调用方的 for-await 退出，这里用简单队列
          const queue: CapturedPayload[] = [];
          let wake: (() => void) | null = null;
          const cb = (p: CapturedPayload) => {
            if (p.ruleId !== ruleId) return;
            queue.push(p);
            wake?.();
          };
          listeners.add(cb);
          try {
            while (true) {
              if (queue.length > 0) {
                yield queue.shift() as CapturedPayload;
                continue;
              }
              await new Promise<void>((r) => {
                wake = r;
              });
              wake = null;
            }
          } finally {
            listeners.delete(cb);
          }
        },
      };
    },

    dispose() {
      document.removeEventListener(bridgeEvent.capture(prefix), onCapture);
      document.removeEventListener(bridgeEvent.readGlobalResult(prefix), onReadResult);
      for (const [, p] of pendingReads) clearTimeout(p.timer);
      pendingReads.clear();
      listeners.clear();
      log.debug('page bridge disposed');
    },
  };
}
