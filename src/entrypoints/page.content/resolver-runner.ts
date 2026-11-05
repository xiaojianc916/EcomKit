/**
 * 解析调度（方案 §7.2、§7.3）。
 *
 * 并行跑各数据源的 AsyncIterable，每产出一次 draft 就合进 DraftAccumulator，
 * 由 controller 决定什么时候把半成品推给 UI。
 *
 * 三条退出条件（都是**真的退出**，不是只记个标志位）：
 *   - 所有源都结束了 → completeness = 'full'
 *   - 只剩抓包源还在等、且已经能拼出快照 → 再等 CAPTURE_SETTLE_MS 收尾 → 'full'
 *     （抓包是无限流，没有这一条就只能等到总超时）
 *   - partialTimeoutMs 到了 → 中止所有源 → 'partial'（§7.2 状态机）
 *
 * 旧实现的问题：超时只设了 timeoutHit = true，`await Promise.all(sources)` 仍然等着
 * 永不结束的抓包流，resolveSnapshot 永远不返回，状态卡在 resolving。
 */

import { createLogger } from '../../kernel/log/logger';
import { readPath } from '../../kernel/messaging/page-bridge';
import type { PlatformId, ProductDraft, ProductSnapshot } from '../../kernel/model/product';
import { readInlineGlobal } from '../../platforms/shared/inline-ssr';
import { DraftAccumulator } from '../../platforms/shared/merge';
import type { CapturedPayload, PlatformResolver, ResolveContext } from '../../platforms/types';

const log = createLogger('resolver-runner');

/** 结构化来源都结束、快照已成形后，给抓包源的收尾窗口 */
export const CAPTURE_SETTLE_MS = 1200;

export interface ResolveInput {
  url: URL;
  productId: string;
  pageKind: string;
  /** 平台 id（以它为准）；旧调用方不传时才按 origin 猜 */
  platformId?: PlatformId;
  platformName: string;
  resolver: PlatformResolver;
  document: Document;
  signal: AbortSignal;
  partialTimeoutMs: number;
  /** 每产出一份合并且能构成快照时就回调一次，UI 渐进更新 */
  onProgress(draft: ProductDraft, acc: DraftAccumulator): void;
  /** 读取全局变量（走 bridge）；不传时只读内联 SSR */
  readGlobal?(path: string): Promise<unknown>;
  /** 抓包数据流；不传时该源直接结束。signal 中止时流必须结束 */
  captures?(ruleId: string, signal: AbortSignal): AsyncIterable<CapturedPayload>;
}

export interface ResolveResult {
  snapshot: ProductSnapshot | null;
  completeness: 'full' | 'partial';
  sources: string[];
}

const ABORTED = Symbol('aborted');

export async function resolveSnapshot(input: ResolveInput): Promise<ResolveResult> {
  const { signal, resolver, productId, pageKind, url, document: doc } = input;

  // 本轮识别的截止信号：外部中止（换商品）/ 总超时 / 收尾窗口结束，任一触发都中止所有源
  const deadline = new AbortController();
  const onOuterAbort = () => deadline.abort();
  if (signal.aborted) deadline.abort();
  else signal.addEventListener('abort', onOuterAbort, { once: true });

  const abortedPromise = new Promise<typeof ABORTED>((resolve) => {
    if (deadline.signal.aborted) resolve(ABORTED);
    else deadline.signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
  });

  const ctx: ResolveContext = {
    url,
    productId,
    pageKind,
    document: doc,
    signal: deadline.signal,
    log: {
      debug: (m, d) => log.debug(m, d),
      info: (m, d) => log.info(m, d),
    },
    readGlobal: async (path: string) => {
      // 快路径：SSR 数据是内联 <script> 里的 JSON，ISOLATED 直接读文本即可，0 等待
      const inline = readInlineSsr(doc, path);
      if (inline !== undefined) return inline;
      // 慢路径：内联读不到（不是 JSON 字面量 / 由 JS 生成）再问 MAIN
      if (input.readGlobal) return input.readGlobal(path);
      return undefined;
    },
    captures: (ruleId: string) =>
      input.captures ? input.captures(ruleId, deadline.signal) : emptyStream(),
  };

  const acc = new DraftAccumulator();
  const finishedSources = new Set<string>();
  const producedSources = new Set<string>();

  const base = {
    platform: input.platformId ?? guessPlatform(url.origin),
    pageKind,
    productId,
    capturedAt: Date.now(),
    fallbackTitle: doc.title,
    fallbackUrl: url.toString(),
  } as const;

  let timeoutHit = false;
  const timer = setTimeout(() => {
    timeoutHit = true;
    deadline.abort();
  }, input.partialTimeoutMs);

  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const maybeSettle = () => {
    if (settleTimer !== null || deadline.signal.aborted) return;
    const pending = resolver.sources.filter((s) => !finishedSources.has(s.id));
    if (pending.length === 0 || !pending.every((s) => s.id === 'capture')) return;
    if (acc.toSnapshot(base) === null) return;
    settleTimer = setTimeout(() => deadline.abort(), CAPTURE_SETTLE_MS);
  };

  const consume = async (source: PlatformResolver['sources'][number]) => {
    let it: AsyncIterator<ProductDraft> | null = null;
    try {
      it = source.run(ctx)[Symbol.asyncIterator]();
      while (true) {
        const next = it.next();
        next.catch(() => {}); // 输给截止信号后的 rejection 不要变成 unhandled
        const step = await Promise.race([next, abortedPromise]);
        if (step === ABORTED) {
          void it.return?.()?.catch?.(() => {});
          return;
        }
        if (step.done) return;
        producedSources.add(source.id);
        acc.add(step.value);
        input.onProgress(step.value, acc);
        maybeSettle(); // 抓包源自己产出了第一份可用快照时，也要开始收尾计时
      }
    } catch (e) {
      log.debug('source failed', { source: source.id, error: String(e) });
    } finally {
      finishedSources.add(source.id);
      maybeSettle();
    }
  };

  // 并行跑所有源；DOM 源本身会等 DOMContentLoaded
  await Promise.all(resolver.sources.map((s) => consume(s)));
  clearTimeout(timer);
  if (settleTimer !== null) clearTimeout(settleTimer);
  signal.removeEventListener('abort', onOuterAbort);

  if (signal.aborted) return { snapshot: null, completeness: 'partial', sources: [] };

  const snapshot = acc.toSnapshot(base);
  return {
    snapshot,
    completeness: timeoutHit ? 'partial' : 'full',
    sources: [...producedSources],
  };
}

/** 'rawData.store.initDataObj' → 先内联读 rawData，再按剩余路径取 */
function readInlineSsr(doc: Document, path: string): unknown {
  const [head, ...rest] = path.split('.');
  if (!head) return undefined;
  const root = readInlineGlobal(doc, head);
  if (root === undefined || rest.length === 0) return root;
  return readPath(root, rest.join('.'));
}

async function* emptyStream(): AsyncIterable<CapturedPayload> {
  // 显式空流，避免调用方到处判 undefined
}

/** 兜底：调用方没给 platformId 时按 origin 猜 */
function guessPlatform(origin: string): ProductSnapshot['platform'] {
  if (/jinritemai|douyin/i.test(origin)) return 'douyin';
  return 'pinduoduo';
}
