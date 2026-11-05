import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductDraft } from '../../kernel/model/product';
import type { CapturedPayload, DataSource, PlatformResolver } from '../../platforms/types';
import { CAPTURE_SETTLE_MS, resolveSnapshot } from './resolver-runner';

const draft: ProductDraft = {
  source: 'ssr',
  title: '测试商品',
  assets: [
    { key: 'm1', kind: 'main', index: 0, candidates: ['https://img.pddpic.com/a.jpg'] },
  ],
};

/** 模拟真实抓包：永远不结束，只在 signal 中止时退出 */
const endlessCapture: DataSource = {
  id: 'capture',
  // biome-ignore lint/correctness/useYield: 模拟一直等不到数据的抓包流
  async *run(ctx) {
    for await (const _ of ctx.captures('rule')) {
      /* 不会有数据 */
    }
  },
};

const instantSsr: DataSource = {
  id: 'ssr',
  async *run() {
    yield draft;
  },
};

function input(resolver: PlatformResolver, extra: Partial<Parameters<typeof resolveSnapshot>[0]> = {}) {
  return {
    url: new URL('https://mobile.yangkeduo.com/goods.html?goods_id=123456'),
    productId: '123456',
    pageKind: 'pdd.goods',
    platformId: 'pinduoduo' as const,
    platformName: '拼多多',
    resolver,
    document,
    signal: new AbortController().signal,
    partialTimeoutMs: 8000,
    onProgress: vi.fn(),
    captures: (_id: string, signal: AbortSignal): AsyncIterable<CapturedPayload> => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
      },
    }),
    ...extra,
  };
}

describe('resolveSnapshot', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('SSR 已成形时只给抓包一个收尾窗口，不等总超时', async () => {
    const resolver: PlatformResolver = { detectBlocker: () => null, sources: [instantSsr, endlessCapture] };
    const p = resolveSnapshot(input(resolver));
    await vi.advanceTimersByTimeAsync(CAPTURE_SETTLE_MS + 10);
    const res = await p;
    expect(res.snapshot?.title).toBe('测试商品');
    expect(res.completeness).toBe('full');
  });

  it('总超时一到就真正返回（旧实现会永远挂起）', async () => {
    const hang: DataSource = {
      id: 'dom',
      run: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<ProductDraft>>(() => {}) }),
      }),
    };
    const resolver: PlatformResolver = { detectBlocker: () => null, sources: [hang, endlessCapture] };
    const p = resolveSnapshot(input(resolver, { partialTimeoutMs: 500 }));
    await vi.advanceTimersByTimeAsync(510);
    const res = await p;
    expect(res.snapshot).toBeNull();
    expect(res.completeness).toBe('partial');
  });

  it('外部中止（SPA 换商品）立即返回空结果', async () => {
    const ac = new AbortController();
    const resolver: PlatformResolver = { detectBlocker: () => null, sources: [endlessCapture] };
    const p = resolveSnapshot(input(resolver, { signal: ac.signal }));
    ac.abort();
    const res = await p;
    expect(res.snapshot).toBeNull();
  });

  it('readGlobal 优先读内联 SSR（JSON），不经过 bridge', async () => {
    const script = document.createElement('script');
    script.textContent = 'window.rawData = {"store":{"x":1}};';
    document.head.appendChild(script);
    const bridgeRead = vi.fn(async () => 'bridge');
    let seen: unknown;
    const probe: DataSource = {
      id: 'ssr',
      // biome-ignore lint/correctness/useYield: 只探测 readGlobal，不产出 draft
      async *run(ctx) {
        seen = await ctx.readGlobal('rawData.store');
      },
    };
    const resolver: PlatformResolver = { detectBlocker: () => null, sources: [probe] };
    await resolveSnapshot(input(resolver, { readGlobal: bridgeRead }));
    expect(seen).toEqual({ x: 1 });
    expect(bridgeRead).not.toHaveBeenCalled();
    script.remove();
  });
});
