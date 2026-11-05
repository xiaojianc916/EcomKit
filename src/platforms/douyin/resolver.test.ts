import { describe, expect, it } from 'vitest';
import type { ProductDraft } from '../../kernel/model/product';
import type { CapturedPayload, ResolveContext } from '../types';
import { DY_COMMON_PAYLOAD } from './__fixtures__/capture-common';
import dyManifest from './manifest';
import {
  captureSource,
  detectDyBlocker,
  domSource,
  douyinResolver,
  draftFromPayload,
  ssrSource,
} from './resolver';

const PAGE_URL = new URL(
  'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=3637489912345678901',
);

function emptyDoc(html = '<html><body></body></html>'): Document {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  Object.defineProperty(doc, 'readyState', { value: 'complete', configurable: true });
  return doc;
}

function makeCtx(
  over: {
    global?: Record<string, unknown>;
    captures?: CapturedPayload[];
    document?: Document;
    signal?: AbortSignal;
  } = {},
): ResolveContext {
  const pushed = over.captures ?? [];
  return {
    url: PAGE_URL,
    productId: '3637489912345678901',
    pageKind: 'dy.haohuo',
    document: over.document ?? emptyDoc(),
    signal: over.signal ?? new AbortController().signal,
    readGlobal: async (path: string) => over.global?.[path],
    captures: (ruleId: string) => ({
      async *[Symbol.asyncIterator]() {
        for (const item of pushed) if (item.ruleId === ruleId) yield item;
      },
    }),
    log: { debug() {}, info() {} },
  };
}

async function collect(
  source: { run(ctx: ResolveContext): AsyncIterable<ProductDraft> },
  ctx: ResolveContext,
): Promise<ProductDraft[]> {
  const out: ProductDraft[] = [];
  for await (const draft of source.run(ctx)) out.push(draft);
  return out;
}

const RULE_PACK =
  dyManifest.capture.find((c) => c.id === 'dy.product-pack')?.id ?? 'dy.product-pack';
const RULE_DETAIL =
  dyManifest.capture.find((c) => c.id === 'dy.product-detail')?.id ?? 'dy.product-detail';

describe('dy 三源顺序（§7.6：capture 为主）', () => {
  it('capture → ssr → dom', () => {
    expect(douyinResolver.sources.map((s) => s.id)).toEqual(['capture', 'ssr', 'dom']);
  });
});

describe('captureSource：两条规则同时旁听', () => {
  it('主源规则的响应能产出 draft', async () => {
    const ctx = makeCtx({
      captures: [
        {
          ruleId: RULE_PACK,
          url: 'https://haohuo.jinritemai.com/aweme/v2/shop/promotion/pack/h5/',
          json: DY_COMMON_PAYLOAD,
          at: 1,
        },
      ],
    });
    const drafts = await collect(captureSource, ctx);
    expect(drafts.length).toBeGreaterThanOrEqual(1);
    expect(drafts[0]?.title).toBe('秋冬加厚珊瑚绒睡衣女套装');
  });

  it('两条规则的响应都能产出，不互相阻塞', async () => {
    const ctx = makeCtx({
      captures: [
        { ruleId: RULE_PACK, url: 'https://a', json: DY_COMMON_PAYLOAD, at: 1 },
        {
          ruleId: RULE_DETAIL,
          url: 'https://b',
          json: {
            data: { product: { product_id: '3637489912345678901', title: '详情接口标题' } },
          },
          at: 2,
        },
      ],
    });
    const drafts = await collect(captureSource, ctx);
    expect(drafts.map((d) => d.title).sort()).toEqual(
      ['详情接口标题', '秋冬加厚珊瑚绒睡衣女套装'].sort(),
    );
  });

  it('商品 ID 不一致的响应被丢弃', async () => {
    const ctx = makeCtx({
      captures: [
        {
          ruleId: RULE_PACK,
          url: 'https://a',
          json: { data: { product: { product_id: '1111111111111111111', title: '别的商品' } } },
          at: 1,
        },
      ],
    });
    expect(await collect(captureSource, ctx)).toHaveLength(0);
  });

  it('接口返回失败码时跳过', async () => {
    const ctx = makeCtx({
      captures: [
        { ruleId: RULE_PACK, url: 'https://a', json: { status_code: 10008, msg: '失败' }, at: 1 },
      ],
    });
    expect(await collect(captureSource, ctx)).toHaveLength(0);
  });

  it('json 为 null 时跳过', async () => {
    const ctx = makeCtx({ captures: [{ ruleId: RULE_PACK, url: 'https://a', json: null, at: 1 }] });
    expect(await collect(captureSource, ctx)).toHaveLength(0);
  });
});

describe('ssrSource：抖音目前没有 SSR 全局变量', () => {
  it('读不到任何全局时一份都不产出', async () => {
    expect(await collect(ssrSource, makeCtx())).toHaveLength(0);
  });

  it('日后平台补了 SSR 全局变量时能解析', async () => {
    const ctx = makeCtx({ global: { __INITIAL_STATE__: DY_COMMON_PAYLOAD } });
    const drafts = await collect(ssrSource, ctx);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.source).toBe('ssr');
  });
});

describe('domSource', () => {
  it('从轮播容器抓到图并标 fromDom', async () => {
    const doc = emptyDoc(
      '<html><body><div class="swiper"><div class="img"><img src="https://p3.douyinpic.com/a~c5_720x720.webp"></div></div></body></html>',
    );
    const drafts = await collect(domSource, makeCtx({ document: doc }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.assets?.[0]?.fromDom).toBe(true);
  });

  it('signal 已取消时立即返回', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await collect(domSource, makeCtx({ signal: controller.signal }))).toHaveLength(0);
  });
});

describe('detectBlocker：APP_ONLY 的两个信号（FINDINGS §1）', () => {
  it('信号①：文案「检测到当前环境存在安全风险」+ 无商品图', () => {
    const doc = emptyDoc(
      '<html><body>检测到当前环境存在安全风险，请进入抖音查看商品详情</body></html>',
    );
    expect(detectDyBlocker(doc, PAGE_URL)).toBe('APP_ONLY');
  });

  it('信号②：页面只有二维码元素且无商品数据', () => {
    const doc = emptyDoc(
      '<html><body><img class="na-rq-code" src="https://p3.douyinpic.com/qr.webp"></body></html>',
    );
    expect(detectDyBlocker(doc, PAGE_URL)).toBe('APP_ONLY');
  });

  it('有商品数据时不误判（已登录用户的浏览器里能正常出数据）', () => {
    const doc = emptyDoc(
      '<html><body><div class="gallery"><img src="https://p3.douyinpic.com/a.webp" width="800"></div><p>请使用抖音APP扫码</p></body></html>',
    );
    expect(detectDyBlocker(doc, PAGE_URL)).toBeNull();
  });

  it('商品已下架 → PRODUCT_GONE', () => {
    const doc = emptyDoc(
      '<html><body><img src="https://p3.douyinpic.com/a.webp" width="800">商品已下架</body></html>',
    );
    expect(detectDyBlocker(doc, PAGE_URL)).toBe('PRODUCT_GONE');
  });

  it('Phase 0 抓到的真实扫码页结构（.detail-abnormal）→ APP_ONLY，不依赖文案', () => {
    const doc = emptyDoc(
      '<html><body><div class="detail-abnormal"><div class="detail-abnormal__shop">' +
        '<img class="na-rq-code" src="https://p3.douyinpic.com/qr.webp">' +
        '<div class="err-reason-text">请打开应用</div></div></div></body></html>',
    );
    expect(detectDyBlocker(doc, PAGE_URL)).toBe('APP_ONLY');
  });

  it('有商品数据时，残留的扫码提示不导致误判', () => {
    const doc = emptyDoc(
      '<html><body><div class="gallery"><img src="https://p3.douyinpic.com/a.webp" width="800"></div>' +
        '<div class="detail-abnormal">检测到当前环境存在安全风险</div></body></html>',
    );
    expect(detectDyBlocker(doc, PAGE_URL)).toBeNull();
  });
});

describe('draftFromPayload：抖音细节', () => {
  const ctx = { url: PAGE_URL, document: emptyDoc() };

  it('没有商品容器时返回 null', () => {
    expect(draftFromPayload({}, ctx, 'capture')).toBeNull();
    expect(draftFromPayload(null, ctx, 'capture')).toBeNull();
  });

  it('详情富文本里的图片走原图规则（~tplv-obj.image）', () => {
    const draft = draftFromPayload(DY_COMMON_PAYLOAD, ctx, 'capture');
    const detail = (draft?.assets ?? []).find((a) => a.kind === 'detail');
    expect(detail?.candidates[0]).toContain('~tplv-obj.image');
    expect(detail?.preview).toContain('~c5_720x720.webp');
  });

  it('价格字符串「12.90」格式化成 ¥12.90', () => {
    const draft = draftFromPayload(
      { data: { product: { title: 'T', min_price: '12.90' } } },
      ctx,
      'capture',
    );
    expect(draft?.price).toBe('¥12.90');
  });
});
