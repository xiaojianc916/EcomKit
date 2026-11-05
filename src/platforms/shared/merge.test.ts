import { describe, expect, it } from 'vitest';
import type { Asset } from '../../kernel/model/asset';
import type { ProductDraft } from '../../kernel/model/product';
import { DraftAccumulator, SOURCE_PRIORITY } from './merge';

const BASE = {
  platform: 'pinduoduo' as const,
  pageKind: 'pdd.goods',
  productId: '482319937501',
  capturedAt: 1_700_000_000_000,
  fallbackUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=482319937501',
};

function img(key: string, index: number, url: string, kind: Asset['kind'] = 'main'): Asset {
  return { key, kind, index, candidates: [url], preview: url };
}

describe('SOURCE_PRIORITY', () => {
  it('ssr > capture > dom（§7.3）', () => {
    expect(SOURCE_PRIORITY.ssr).toBeGreaterThan(SOURCE_PRIORITY.capture);
    expect(SOURCE_PRIORITY.capture).toBeGreaterThan(SOURCE_PRIORITY.dom);
  });
});

/** 标量用例要有素材，否则 toSnapshot() 会按「没拿到素材」返回 null */
const WITH_MAIN = [img('m1', 0, 'https://img.pddpic.com/m1.jpg')];

describe('标量合并', () => {
  it('按 ssr > capture > dom 取第一个非空值', () => {
    const acc = new DraftAccumulator();
    acc.add({ source: 'dom', title: '来自页面', shopName: 'DOM 店', assets: WITH_MAIN });
    acc.add({ source: 'ssr', title: '来自 SSR' });
    acc.add({ source: 'capture', title: '来自接口', price: '¥59' });

    const snap = acc.toSnapshot({ ...BASE, fallbackTitle: 'x' });
    expect(snap?.title).toBe('来自 SSR');
    // SSr 没给店铺，capture 也没给，才轮到 dom 的值
    expect(snap?.shopName).toBe('DOM 店');
    expect(snap?.price).toBe('¥59');
  });

  it('低优先级来源不会覆盖高优先级的值', () => {
    const acc = new DraftAccumulator();
    acc.add({ source: 'ssr', title: 'SSR 标题', assets: WITH_MAIN });
    acc.add({ source: 'capture', title: '接口标题' });
    acc.add({ source: 'dom', title: 'DOM 标题' });
    expect(acc.toSnapshot({ ...BASE })?.title).toBe('SSR 标题');
  });

  it('空串和纯空白不算值', () => {
    const acc = new DraftAccumulator();
    acc.add({ source: 'ssr', title: '   ', assets: WITH_MAIN });
    acc.add({ source: 'capture', title: '' });
    acc.add({ source: 'dom', title: 'DOM 标题' });
    expect(acc.toSnapshot({ ...BASE })?.title).toBe('DOM 标题');
  });
});

describe('素材合并', () => {
  it('按 kind + key 去重，跨来源同一个素材只出现一次', () => {
    const acc = new DraftAccumulator();
    acc.add({
      source: 'ssr',
      title: 'T',
      assets: [img('a', 0, 'https://img.pddpic.com/a.jpg')],
    });
    acc.add({
      source: 'capture',
      title: 'T',
      assets: [img('a', 0, 'https://img.pddpic.com/a.jpg')],
    });
    expect(acc.assetCount).toBe(1);
  });

  it('候选地址合并时高优先级来源的地址排在前面', () => {
    const acc = new DraftAccumulator();
    acc.add({
      source: 'capture',
      title: 'T',
      assets: [img('a', 0, 'https://img.pddpic.com/a@缩略.jpg')],
    });
    acc.add({
      source: 'ssr',
      title: 'T',
      assets: [img('a', 0, 'https://img.pddpic.com/a.jpg')],
    });
    const snap = acc.toSnapshot({ ...BASE });
    expect(snap?.assets[0]?.candidates).toEqual([
      'https://img.pddpic.com/a.jpg',
      'https://img.pddpic.com/a@缩略.jpg',
    ]);
  });

  it('同类素材顺序以最高优先级来源为准', () => {
    const acc = new DraftAccumulator();
    acc.add({
      source: 'dom',
      title: 'T',
      assets: [
        img('b', 1, 'https://img.pddpic.com/b.jpg'),
        img('a', 0, 'https://img.pddpic.com/a.jpg'),
      ],
    });
    acc.add({
      source: 'ssr',
      title: 'T',
      assets: [img('c', 0, 'https://img.pddpic.com/c.jpg')],
    });
    const snap = acc.toSnapshot({ ...BASE });
    // DOM 的 main 被整个丢弃（ssr 已经提供了 main），只剩 ssr 的那张
    expect(snap?.assets.map((a) => a.key)).toEqual(['c']);
  });

  it('DOM 只补空：结构化来源没有的类别才用 DOM', () => {
    const acc = new DraftAccumulator();
    acc.add({
      source: 'ssr',
      title: 'T',
      assets: [img('main-1', 0, 'https://img.pddpic.com/m1.jpg', 'main')],
    });
    acc.add({
      source: 'dom',
      title: 'T',
      assets: [
        img('dom-main', 0, 'https://img.pddpic.com/rec.jpg', 'main'),
        img('dom-detail', 0, 'https://img.pddpic.com/d1.jpg', 'detail'),
      ],
    });
    const snap = acc.toSnapshot({ ...BASE });
    const keys = snap?.assets.map((a) => a.key) ?? [];
    expect(keys).toEqual(['main-1', 'dom-detail']);
  });

  it('DOM 补上的素材标 fromDom: true', () => {
    const acc = new DraftAccumulator();
    acc.add({
      source: 'dom',
      title: 'T',
      assets: [img('d1', 0, 'https://img.pddpic.com/d1.jpg', 'detail')],
    });
    const snap = acc.toSnapshot({ ...BASE });
    expect(snap?.assets[0]?.fromDom).toBe(true);
  });

  it('结构化来源提供的素材不带 fromDom 字段', () => {
    const acc = new DraftAccumulator();
    acc.add({ source: 'ssr', title: 'T', assets: [img('m1', 0, 'https://img.pddpic.com/m1.jpg')] });
    const snap = acc.toSnapshot({ ...BASE });
    expect(snap?.assets[0]).not.toHaveProperty('fromDom');
  });

  it('DOM 结果即使先到，也不会被结构化数据覆盖成混合清单', () => {
    const acc = new DraftAccumulator();
    acc.add({ source: 'dom', title: 'T', assets: [img('d1', 0, 'https://img.pddpic.com/d1.jpg')] });
    acc.add({
      source: 'capture',
      title: 'T',
      assets: [img('c1', 0, 'https://img.pddpic.com/c1.jpg')],
    });
    const snap = acc.toSnapshot({ ...BASE });
    // capture 提供了 main，DOM 的 main 必须被丢弃
    expect(snap?.assets.map((a) => a.key)).toEqual(['c1']);
  });

  it('每一类素材的内部 index 从 0 连续编号', () => {
    const acc = new DraftAccumulator();
    acc.add({
      source: 'ssr',
      title: 'T',
      assets: [
        img('m1', 7, 'https://img.pddpic.com/m1.jpg', 'main'),
        img('m2', 9, 'https://img.pddpic.com/m2.jpg', 'main'),
        img('d1', 3, 'https://img.pddpic.com/d1.jpg', 'detail'),
      ],
    });
    const snap = acc.toSnapshot({ ...BASE });
    const mains = snap?.assets.filter((a) => a.kind === 'main') ?? [];
    const details = snap?.assets.filter((a) => a.kind === 'detail') ?? [];
    expect(mains.map((a) => a.index)).toEqual([0, 1]);
    expect(details.map((a) => a.index)).toEqual([0]);
  });
});

describe('SKU 合并', () => {
  it('SKU 整组取最高优先级来源', () => {
    const acc = new DraftAccumulator();
    acc.add({
      source: 'dom',
      title: 'T',
      assets: WITH_MAIN,
      skus: [{ id: 'dom', specs: [{ name: '颜色', value: '红' }] }],
    });
    acc.add({
      source: 'ssr',
      title: 'T',
      skus: [{ id: 'ssr', specs: [{ name: '颜色', value: '黑' }] }],
    });
    expect(acc.toSnapshot({ ...BASE })?.skus.map((s) => s.id)).toEqual(['ssr']);
  });

  it('imageKey 指向不存在的素材时丢掉这个字段', () => {
    const acc = new DraftAccumulator();
    acc.add({
      source: 'ssr',
      title: 'T',
      assets: [img('m1', 0, 'https://img.pddpic.com/m1.jpg')],
      skus: [{ id: 's1', specs: [], imageKey: '不存在的key' }],
    });
    expect(acc.toSnapshot({ ...BASE })?.skus[0]).not.toHaveProperty('imageKey');
  });

  it('imageKey 指向存在素材时保留', () => {
    const acc = new DraftAccumulator();
    acc.add({
      source: 'ssr',
      title: 'T',
      assets: [img('sku-1', 0, 'https://img.pddpic.com/s1.jpg', 'sku')],
      skus: [{ id: 's1', specs: [], imageKey: 'sku-1' }],
    });
    expect(acc.toSnapshot({ ...BASE })?.skus[0]?.imageKey).toBe('sku-1');
  });
});

describe('生成快照', () => {
  it('缺标题或没有素材时返回 null（调用方进 empty 状态）', () => {
    const acc = new DraftAccumulator();
    acc.add({ source: 'ssr', assets: [img('m1', 0, 'https://img.pddpic.com/m1.jpg')] });
    expect(acc.toSnapshot({ ...BASE })).toBeNull();

    const acc2 = new DraftAccumulator();
    acc2.add({ source: 'ssr', title: '有标题没素材' });
    expect(acc2.toSnapshot({ ...BASE })).toBeNull();
  });

  it('标题缺失时用 fallbackTitle（例如 document.title）', () => {
    const acc = new DraftAccumulator();
    acc.add({ source: 'dom', assets: [img('m1', 0, 'https://img.pddpic.com/m1.jpg')] });
    expect(acc.toSnapshot({ ...BASE, fallbackTitle: '页面标题' })?.title).toBe('页面标题');
  });

  it('sources 记录产出过内容的来源，按优先级排序', () => {
    const acc = new DraftAccumulator();
    acc.add({ source: 'dom', title: 'T', assets: [img('d', 0, 'https://img.pddpic.com/d.jpg')] });
    acc.add({ source: 'ssr', price: '¥1' });
    expect(acc.toSnapshot({ ...BASE })?.sources).toEqual(['ssr', 'dom']);
  });

  it('platform / pageKind / productId / capturedAt 原样带进快照', () => {
    const acc = new DraftAccumulator();
    acc.add({ source: 'ssr', title: 'T', assets: [img('m', 0, 'https://img.pddpic.com/m.jpg')] });
    const snap = acc.toSnapshot({ ...BASE });
    expect(snap).toMatchObject({
      platform: 'pinduoduo',
      pageKind: 'pdd.goods',
      productId: '482319937501',
      capturedAt: 1_700_000_000_000,
      completeness: 'partial',
    });
  });

  it('draft 里带 url 时以它为准，否则用 fallbackUrl', () => {
    const acc = new DraftAccumulator();
    acc.add({
      source: 'ssr',
      title: 'T',
      url: 'https://mobile.pinduoduo.com/goods.html?goods_id=482319937501',
      assets: [img('m', 0, 'https://img.pddpic.com/m.jpg')],
    });
    expect(acc.toSnapshot({ ...BASE })?.url).toBe(
      'https://mobile.pinduoduo.com/goods.html?goods_id=482319937501',
    );
  });

  it('重复合入同一个 draft 不会让素材翻倍', () => {
    const acc = new DraftAccumulator();
    const draft: ProductDraft = {
      source: 'capture',
      title: 'T',
      assets: [img('m', 0, 'https://img.pddpic.com/m.jpg')],
    };
    acc.add(draft);
    acc.add(draft);
    expect(acc.toSnapshot({ ...BASE })?.assets).toHaveLength(1);
  });
});
