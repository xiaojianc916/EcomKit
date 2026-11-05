/**
 * 解析调度（方案 §7.2、§7.3）。
 *
 * 并行跑各数据源的 AsyncIterable，每产出一次 draft 就合进 DraftAccumulator，
 * 由 controller 决定什么时候把半成品推给 UI。
 *
 * 两条退出条件：
 *   - 所有源都结束了 → completeness = 'full'
 *   - 8 秒到了但已经拿到标题和主图 → completeness = 'partial'（§7.2 状态机）
 */
import type { CapturedPayload, PlatformResolver, ResolveContext } from '../../platforms/types';
import type { ProductDraft, ProductSnapshot } from '../../kernel/model/product';
import { DraftAccumulator } from '../../platforms/shared/merge';
import { createLogger } from '../../kernel/log/logger';
import { readInlineGlobal } from '../../platforms/shared/inline-ssr';

const log = createLogger('resolver-runner');

export interface ResolveInput {
  url: URL;
  productId: string;
  pageKind: string;
  platformName: string;
  resolver: PlatformResolver;
  document: Document;
  signal: AbortSignal;
  partialTimeoutMs: number;
  /** 每产出一份合并且能构成快照时就回调一次，UI 渐进更新 */
  onProgress(draft: ProductDraft, acc: DraftAccumulator): void;
  /** 读取全局变量（走 bridge）；不传时退化为直接读 window（同 world 情况下不可用） */
  readGlobal?(path: string): Promise<unknown>;
  /** 抓包数据流；不传时该源直接结束 */
  captures?(ruleId: string): AsyncIterable<CapturedPayload>;
}

export interface ResolveResult {
  snapshot: ProductSnapshot | null;
  completeness: 'full' | 'partial';
  sources: string[];
}

export async function resolveSnapshot(input: ResolveInput): Promise<ResolveResult> {
  const { signal, resolver, productId, pageKind, platformName, url, document: doc } = input;

  const ctx: ResolveContext = {
    url,
    productId,
    pageKind,
    document: doc,
    signal,
    log: {
      debug: (m, d) => log.debug(m, d),
      info: (m, d) => log.info(m, d),
    },
    readGlobal: async (path: string) => {
      if (input.readGlobal) return input.readGlobal(path);
      // 没有 bridge 时退回同步读：只在我们和被解析页面同 world 的情况下可行
      return readInlineGlobal(doc, path);
    },
    captures: (ruleId: string) => (input.captures ? input.captures(ruleId) : emptyStream()),
  };

  const acc = new DraftAccumulator();
  const finishedSources = new Set<string>();
  const producedSources = new Set<string>();

  const base = {
    platform: guessPlatform(url.origin, platformName),
    pageKind,
    productId,
    capturedAt: Date.now(),
    fallbackTitle: doc.title,
    fallbackUrl: url.toString(),
  } as const;

  let timeoutHit = false;
  const timer = setTimeout(() => {
    timeoutHit = true;
  }, input.partialTimeoutMs);

  const consume = async (source: PlatformResolver['sources'][number]) => {
    try {
      for await (const draft of source.run(ctx)) {
        if (signal.aborted) return;
        producedSources.add(source.id);
        acc.add(draft);
        input.onProgress(draft, acc);
      }
    } catch (e) {
      log.debug('source failed', { source: source.id, error: String(e) });
    } finally {
      finishedSources.add(source.id);
    }
  };

  // 并行跑所有源；DOM 源本身会等 DOMContentLoaded
  await Promise.all(resolver.sources.map((s) => consume(s)));
  clearTimeout(timer);

  if (signal.aborted) return { snapshot: null, completeness: 'partial', sources: [] };

  const snapshot = acc.toSnapshot(base);
  const killed = timeoutHit && finishedSources.size < resolver.sources.length;
  return {
    snapshot,
    completeness: killed ? 'partial' : 'full',
    sources: [...producedSources],
  };
}

async function* emptyStream(): AsyncIterable<CapturedPayload> {
  // 显式空流，避免调用方到处判 undefined
}

/** 从 origin 猜平台 id；猜不到就用 manifest 里的 displayName 反查 */
function guessPlatform(origin: string, _platformName: string): ProductSnapshot['platform'] {
  if (/yangkeduo|pinduoduo/i.test(origin)) return 'pinduoduo';
  if (/jinritemai|douyin/i.test(origin)) return 'douyin';
  // 兜底：'pinduoduo' 是更常见的那个，宁可 ID 错也希望别抛异常
  return 'pinduoduo';
}