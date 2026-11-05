import { describe, expect, it, vi } from 'vitest';
import type { ProductDraft } from '../../kernel/model/product';
import type { CapturedPayload, ResolveContext } from '../types';
import pddManifest from './manifest';
import {
  captureSource,
  detectPddBlocker,
  detectPddBlockerAsync,
  domSource,
  draftFromPayload,
  pddHasGoodsData,
  pinduoduoResolver,
  ssrSource,
} from './resolver';

const PAGE_URL = new URL('https://mobile.yangkeduo.com/goods.html?goods_id=482319937501');

function emptyDoc(html = '<html><body></body></html>'): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

interface CtxOverrides extends Omit<Partial<ResolveContext>, 'captures'> {
  /** 用来替代 ctx.captures() 的固定响应列表 */
  global?: unknown;
  captures?: CapturedPayload[];
}

function makeCtx(over: CtxOverrides = {}): { ctx: ResolveContext; pushed: CapturedPayload[] } {
  const pushed: CapturedPayload[] = over.captures ? [...over.captures] : [];
  const ctx: ResolveContext = {
    url: PAGE_URL,
    productId: '482319937501',
    pageKind: 'pdd.goods',
    document: over.document ?? emptyDoc(),
    signal: over.signal ?? new AbortController().signal,
    readGlobal: async (path: string) => (path === 'rawData' ? over.global : undefined),
    captures: (ruleId: string) => ({
      async *[Symbol.asyncIterator]() {
        for (const item of pushed) {
          if (item.ruleId === ruleId) yield item;
        }
      },
    }),
    log: { debug() {}, info() {} },
  };
  return { ctx, pushed };
}

async function collect(
  source: { run(ctx: ResolveContext): AsyncIterable<ProductDraft> },
  ctx: ResolveContext,
) {
  const out: ProductDraft[] = [];
  for await (const draft of source.run(ctx)) out.push(draft);
  return out;
}

/** docs/phase0/FINDINGS.md 里记录的真实未登录响应 */
const NEED_LOGIN_RAW_DATA = {
  store: { initDataObj: { needLogin: true } },
};

const GOODS_RAW_DATA = {
  store: {
    initDataObj: {
      goods: {
        goodsId: 482319937501,
        goodsName: '测试商品',
        topGallery: ['https://img.pddpic.com/a.jpg'],
      },
      mall: { mallName: '测试店铺' },
    },
  },
};

describe('detectBlocker：登录墙的三个信号（FINDINGS §1）', () => {
  it('信号①：location 被跳到 /login.html', () => {
    const url = new URL('https://mobile.yangkeduo.com/login.html?from=x');
    expect(detectPddBlocker(emptyDoc(), url)).toBe('LOGIN_REQUIRED');
  });

  it('信号②：页面出现登录表单且没有商品图', () => {
    const html =
      '<html><body><form class="login-ui-form"><input id="user-mobile"></form></body></html>';
    expect(detectPddBlocker(emptyDoc(html), PAGE_URL)).toBe('LOGIN_REQUIRED');
  });

  it('信号②（同步）：内联脚本里的 rawData 带 needLogin 且没有商品数据', () => {
    const html =
      '<html><head><script>window.rawData={"store":{"initDataObj":{"needLogin":true}}};</script></head>' +
      '<body><div id="main"></div></body></html>';
    expect(detectPddBlocker(emptyDoc(html), PAGE_URL)).toBe('LOGIN_REQUIRED');
  });

  it('内联 rawData 已有商品数据时，同步判定不误判为登录墙', () => {
    const html =
      '<html><head><script>window.rawData={"store":{"initDataObj":{"goods":{"goodsName":"T"}}}};</script></head>' +
      '<body><img src="https://img.pddpic.com/a.jpg" width="400"></body></html>';
    expect(detectPddBlocker(emptyDoc(html), PAGE_URL)).toBeNull();
  });

  it('信号②（异步兜底）：bridge 读到 needLogin', async () => {
    const { ctx } = makeCtx({ global: NEED_LOGIN_RAW_DATA });
    expect(await detectPddBlockerAsync(ctx)).toBe('LOGIN_REQUIRED');
  });

  it('登录后 initDataObj 带 goods 时不再判为登录墙', async () => {
    const { ctx } = makeCtx({ global: GOODS_RAW_DATA });
    expect(await detectPddBlockerAsync(ctx)).toBeNull();
  });

  it('needLogin 为 true 但已经有 goods 数据时，不判登录墙（避免误伤）', async () => {
    const mixed = {
      store: { initDataObj: { needLogin: true, ...GOODS_RAW_DATA.store.initDataObj } },
    };
    const { ctx } = makeCtx({ global: mixed });
    expect(await detectPddBlockerAsync(ctx)).toBeNull();
  });

  it('读不到 rawData 时不误判', async () => {
    const { ctx } = makeCtx({ global: undefined });
    expect(await detectPddBlockerAsync(ctx)).toBeNull();
  });

  it('「商品已下架」→ PRODUCT_GONE', () => {
    expect(detectPddBlocker(emptyDoc('<html><body>商品已下架</body></html>'), PAGE_URL)).toBe(
      'PRODUCT_GONE',
    );
  });

  it('正常商品页不误判', () => {
    const html = '<html><body><img src="https://img.pddpic.com/a.jpg" width="400"></body></html>';
    expect(detectPddBlocker(emptyDoc(html), PAGE_URL)).toBeNull();
  });

  it('pddHasGoodsData 只认有标题的 goods 子树', () => {
    expect(pddHasGoodsData(GOODS_RAW_DATA)).toBe(true);
    expect(pddHasGoodsData(NEED_LOGIN_RAW_DATA)).toBe(false);
    expect(pddHasGoodsData(undefined)).toBe(false);
  });
});

describe('ssrSource：一次产出完整 draft', () => {
  it('有商品数据时产出一份', async () => {
    const { ctx } = makeCtx({ global: GOODS_RAW_DATA });
    const drafts = await collect(ssrSource, ctx);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.source).toBe('ssr');
    expect(drafts[0]?.title).toBe('测试商品');
  });

  it('读不到全局变量时一份都不产出', async () => {
    const { ctx } = makeCtx({ global: undefined });
    expect(await collect(ssrSource, ctx)).toHaveLength(0);
  });

  it('未登录的 needLogin 数据产不出 draft', async () => {
    const { ctx } = makeCtx({ global: NEED_LOGIN_RAW_DATA });
    expect(await collect(ssrSource, ctx)).toHaveLength(0);
  });
});

describe('captureSource：每命中一条响应产出一份', () => {
  const ruleId = pddManifest.capture[0]?.id ?? 'pdd.goods-detail';

  it('两条响应产出两个 draft（渐进产出）', async () => {
    const { ctx } = makeCtx({
      captures: [
        { ruleId, url: 'https://mobile.yangkeduo.com/proxy/api/a', json: GOODS_RAW_DATA, at: 1 },
        {
          ruleId,
          url: 'https://mobile.yangkeduo.com/proxy/api/b',
          json: {
            store: { initDataObj: { goods: { goodsName: '第二条', goodsId: 482319937501 } } },
          },
          at: 2,
        },
      ],
    });
    const drafts = await collect(captureSource, ctx);
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.title)).toEqual(['测试商品', '第二条']);
  });

  it('商品 ID 不一致的抓包数据被丢弃（SPA 切换商品不串数据）', async () => {
    const { ctx } = makeCtx({
      captures: [
        {
          ruleId,
          url: 'https://mobile.yangkeduo.com/proxy/api/a',
          json: {
            store: { initDataObj: { goods: { goodsName: '别的商品', goodsId: 111111111111 } } },
          },
          at: 1,
        },
      ],
    });
    expect(await collect(captureSource, ctx)).toHaveLength(0);
  });

  it('没有商品 ID 的响应放行（部分接口不带 ID）', async () => {
    const { ctx } = makeCtx({
      captures: [
        { ruleId, url: 'https://mobile.yangkeduo.com/proxy/api/a', json: GOODS_RAW_DATA, at: 1 },
      ],
    });
    expect(await collect(captureSource, ctx)).toHaveLength(1);
  });

  it('json 为 null 的响应被跳过', async () => {
    const { ctx } = makeCtx({
      captures: [{ ruleId, url: 'https://mobile.yangkeduo.com/proxy/api/a', json: null, at: 1 }],
    });
    expect(await collect(captureSource, ctx)).toHaveLength(0);
  });
});

describe('domSource：DOMContentLoaded 后产出一份', () => {
  it('从主图容器抓到图并标 fromDom', async () => {
    const html =
      '<html><body><div class="goodsGallery"><img src="https://img.pddpic.com/a.jpg"></div></body></html>';
    const doc = emptyDoc(html);
    // happy-dom 解析完就是 complete，不需要等 DOMContentLoaded
    Object.defineProperty(doc, 'readyState', { value: 'complete', configurable: true });
    const { ctx } = makeCtx({ document: doc });
    const drafts = await collect(domSource, ctx);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.source).toBe('dom');
    expect(drafts[0]?.assets?.[0]?.fromDom).toBe(true);
  });

  it('页面上没有命中容器时一份都不产出', async () => {
    const doc = emptyDoc(
      '<html><body><div><img src="https://img.pddpic.com/a.jpg"></div></body></html>',
    );
    Object.defineProperty(doc, 'readyState', { value: 'complete', configurable: true });
    const { ctx } = makeCtx({ document: doc });
    vi.useFakeTimers();
    try {
      const result = collect(domSource, ctx);
      await vi.advanceTimersByTimeAsync(6600);
      expect(await result).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('signal 已经 abort 时立即返回', async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx } = makeCtx({ signal: controller.signal });
    expect(await collect(domSource, ctx)).toHaveLength(0);
  });
});

describe('resolver 装配', () => {
  it('三源顺序是 ssr → capture → dom（§7.5）', () => {
    expect(pinduoduoResolver.sources.map((s) => s.id)).toEqual(['ssr', 'capture', 'dom']);
  });

  it('detectBlocker 可直接当同步函数用', () => {
    expect(pinduoduoResolver.detectBlocker(emptyDoc(), PAGE_URL)).toBeNull();
  });
});

describe('draftFromPayload：视频与价格', () => {
  const ctx = { url: PAGE_URL, document: emptyDoc() };

  it('价格按分转元', () => {
    const draft = draftFromPayload({ goods: { goodsName: 'T', minGroupPrice: 5900 } }, ctx, 'ssr');
    expect(draft?.price).toBe('¥59.00');
  });

  it('没有商品数据时返回 null', () => {
    expect(draftFromPayload({}, ctx, 'ssr')).toBeNull();
    expect(draftFromPayload(null, ctx, 'ssr')).toBeNull();
  });

  it('视频候选过白名单，非 mp4 被丢弃', () => {
    const draft = draftFromPayload(
      {
        goods: {
          goodsName: 'T',
          topGallery: ['https://img.pddpic.com/a.jpg'],
          videoGallery: [{ videoUrl: 'https://v.pddpic.com/a.mp4', width: 1080, height: 1920 }],
        },
      },
      ctx,
      'ssr',
    );
    const videos = (draft?.assets ?? []).filter((a) => a.kind === 'video');
    expect(videos).toHaveLength(1);
    expect(videos[0]?.video?.codec).toBeDefined();
  });
});

describe('真实字段兼容与兜底（模拟数据）', () => {
  const ctx = { url: PAGE_URL, document: emptyDoc() };
  it('解析 banner 和单个 video 对象', () => {
    const payload = {
      store: {
        initDataObj: {
          goods: {
            goods_name: '样例商品',
            banner: [{ url: 'https://img.pddpic.com/a.jpg' }],
            video: { url: 'https://img.pddpic.com/v.mp4' },
          },
        },
      },
    };
    const d = draftFromPayload(payload, ctx, 'ssr');
    expect(d?.title).toBe('样例商品');
    expect(d?.assets?.map((a) => a.kind)).toEqual(['main', 'video']);
  });
  it('未知嵌套路径中扫描主图和详情图，排除推荐', () => {
    const payload = {
      goods: {
        goods_name: '样例',
        nested: {
          banner_pictures: ['https://img.pddpic.com/a.jpg'],
          description_pictures: ['https://img.pddpic.com/b.jpg'],
          recommend: { gallery: ['https://img.pddpic.com/wrong.jpg'] },
        },
      },
    };
    const d = draftFromPayload(payload, ctx, 'ssr');
    expect(d?.assets?.map((a) => a.kind)).toEqual(['main', 'detail']);
    expect(d?.assets?.every((a) => !a.candidates.some((u) => u.includes('wrong')))).toBe(true);
  });
  it('商品数据存在时不被扫码栏的登录表单误判', () => {
    const html =
      '<html><head><script>window.rawData={"store":{"initDataObj":{"goods":{"goods_name":"测试"}}}};</script></head><body><form class="login-ui-form"></form></body></html>';
    expect(detectPddBlocker(emptyDoc(html), PAGE_URL)).toBeNull();
  });
  it('无商品字段也无素材不生成空 draft', () => {
    expect(draftFromPayload({}, ctx, 'ssr')).toBeNull();
  });
});
