import { describe, expect, it } from 'vitest';
import { collectCategory, collectDomImages, type DomImageRules } from './dom-heuristics';

function docFrom(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const RULES: DomImageRules = {
  main: { containers: ['.main-gallery', '.goods-gallery'] },
  detail: { containers: ['.detail-gallery', '.goods-detail'] },
  sku: { containers: ['.sku-list'], limit: 20 },
  exclude: ['.recommend', '.mall-recommend'],
};

describe('collectDomImages', () => {
  it('主图 / 详情图 / SKU 图分开取', () => {
    const doc = docFrom(`
      <div class="main-gallery">
        <img src="https://img.pddpic.com/main-1.jpg">
        <img src="https://img.pddpic.com/main-2.jpg">
      </div>
      <div class="detail-gallery"><img src="https://img.pddpic.com/detail-1.jpg"></div>
      <div class="sku-list"><img src="https://img.pddpic.com/sku-1.jpg"></div>
    `);
    const out = collectDomImages(doc, RULES);
    expect(out.main.map((a) => a.candidates[0])).toEqual([
      'https://img.pddpic.com/main-1.jpg',
      'https://img.pddpic.com/main-2.jpg',
    ]);
    expect(out.detail).toHaveLength(1);
    expect(out.sku).toHaveLength(1);
  });

  it('DOM 补出来的素材一律标 fromDom: true', () => {
    const doc = docFrom('<div class="main-gallery"><img src="https://img.pddpic.com/a.jpg"></div>');
    expect(collectDomImages(doc, RULES).main[0]?.fromDom).toBe(true);
  });

  it('容器候选按顺序尝试，第一个能选到 img 的生效', () => {
    const doc = docFrom(
      '<div class="goods-gallery"><img src="https://img.pddpic.com/b.jpg"></div>',
    );
    const out = collectDomImages(doc, RULES);
    expect(out.main.map((a) => a.candidates[0])).toEqual(['https://img.pddpic.com/b.jpg']);
  });

  it('排除推荐位里的图片', () => {
    const doc = docFrom(`
      <div class="main-gallery">
        <img src="https://img.pddpic.com/real.jpg">
        <div class="recommend"><img src="https://img.pddpic.com/recommend.jpg"></div>
      </div>
    `);
    const out = collectDomImages(doc, RULES);
    expect(out.main.map((a) => a.candidates[0])).toEqual(['https://img.pddpic.com/real.jpg']);
  });

  it('没有任何容器时三类都是空数组', () => {
    const doc = docFrom('<div><img src="https://img.pddpic.com/x.jpg"></div>');
    const out = collectDomImages(doc, RULES);
    expect(out.main).toEqual([]);
    expect(out.detail).toEqual([]);
    expect(out.sku).toEqual([]);
  });

  it('懒加载图片优先用 data-src', () => {
    const doc = docFrom(
      '<div class="main-gallery"><img data-src="https://img.pddpic.com/real.jpg" src="data:image/gif;base64,R0lGOD"></div>',
    );
    expect(collectDomImages(doc, RULES).main[0]?.candidates[0]).toBe(
      'https://img.pddpic.com/real.jpg',
    );
  });

  it('同一张图出现多次只留一个素材', () => {
    const doc = docFrom(`
      <div class="main-gallery">
        <img src="https://img.pddpic.com/a.jpg">
        <img src="https://img.pddpic.com/a.jpg?imageView2/2/w/200">
      </div>
    `);
    expect(collectDomImages(doc, RULES).main).toHaveLength(1);
  });

  it('limit 生效', () => {
    const doc = docFrom(
      `<div class="sku-list">${Array.from({ length: 30 }, (_, i) => `<img src="https://img.pddpic.com/s${i}.jpg">`).join('')}</div>`,
    );
    expect(collectDomImages(doc, RULES).sku).toHaveLength(20);
  });

  it('index 从 0 连续编号', () => {
    const doc = docFrom(
      '<div class="detail-gallery"><img src="https://img.pddpic.com/d1.jpg"><img src="https://img.pddpic.com/d2.jpg"></div>',
    );
    expect(collectDomImages(doc, RULES).detail.map((a) => a.index)).toEqual([0, 1]);
  });
});

describe('collectCategory', () => {
  it('visibleOnly 时跳过 display:none 和 width=0 的图', () => {
    const doc = docFrom(`
      <div class="main-gallery">
        <img src="https://img.pddpic.com/a.jpg" style="display: none">
        <img src="https://img.pddpic.com/b.jpg" width="0">
        <img src="https://img.pddpic.com/c.jpg">
      </div>
    `);
    const out = collectCategory(doc, 'main', { containers: ['.main-gallery'], visibleOnly: true });
    expect(out.map((a) => a.candidates[0])).toEqual(['https://img.pddpic.com/c.jpg']);
  });

  it('attr-index 时按 data-index 排序', () => {
    const doc = docFrom(`
      <div class="main-gallery">
        <img src="https://img.pddpic.com/second.jpg" data-index="1">
        <img src="https://img.pddpic.com/first.jpg" data-index="0">
      </div>
    `);
    const out = collectCategory(doc, 'main', {
      containers: ['.main-gallery'],
      order: 'attr-index',
    });
    expect(out.map((a) => a.candidates[0])).toEqual([
      'https://img.pddpic.com/first.jpg',
      'https://img.pddpic.com/second.jpg',
    ]);
  });

  it('写错的选择器不影响其他规则', () => {
    const doc = docFrom('<div class="main-gallery"><img src="https://img.pddpic.com/a.jpg"></div>');
    const out = collectCategory(doc, 'main', { containers: [':::bad', '.main-gallery'] });
    expect(out).toHaveLength(1);
  });

  it('相对地址按 document.location 解析', () => {
    const doc = docFrom('<div class="main-gallery"><img src="/img/a.jpg"></div>');
    Object.defineProperty(doc, 'location', {
      value: { href: 'https://mobile.yangkeduo.com/goods.html?goods_id=1' },
      configurable: true,
    });
    const out = collectCategory(doc, 'main', { containers: ['.main-gallery'] });
    expect(out[0]?.candidates[0]).toBe('https://mobile.yangkeduo.com/img/a.jpg');
  });
});
