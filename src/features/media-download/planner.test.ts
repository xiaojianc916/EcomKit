import { describe, expect, it } from 'vitest';
import type { Asset } from '../../kernel/model/asset';
import type { ProductSnapshot } from '../../kernel/model/product';
import { type PlannerSettings, planCounts, planDownload } from './planner';

const NOW = new Date(2026, 10, 5, 9, 0).getTime();

const SETTINGS: PlannerSettings = {
  folderTemplate: '{platform}_商品ID_{id}',
  dirNames: { main: '主图', sku: 'SKU图', detail: '详情图', video: '视频' },
  videoCover: false,
  detailMinWidth: 0,
};

function asset(patch: Partial<Asset> & Pick<Asset, 'key' | 'kind' | 'index'>): Asset {
  return {
    candidates: [`https://img.pddpic.com/${patch.key}.jpg`],
    ...patch,
  };
}

function images(kind: 'main' | 'detail', count: number): Asset[] {
  return Array.from({ length: count }, (_, i) =>
    asset({ key: `${kind}-${i + 1}`, kind, index: i }),
  );
}

function snapshot(patch: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    platform: 'pinduoduo',
    pageKind: 'pdd.goods',
    productId: '482319937501',
    title: '夏季新款显瘦连衣裙女小个子法式复古方领泡泡袖碎花裙',
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=482319937501',
    skus: [],
    assets: [],
    sources: ['ssr'],
    completeness: 'full',
    capturedAt: NOW,
    ...patch,
  };
}

function plan(
  snapshotValue: ProductSnapshot,
  selection: { kinds: ('main' | 'sku' | 'detail' | 'video')[]; keys?: string[] },
  settings: Partial<PlannerSettings> = {},
) {
  return planDownload({
    snapshot: snapshotValue,
    selection,
    settings: { ...SETTINGS, ...settings },
    platformDisplayName: '拼多多',
    now: NOW,
  });
}

describe('商品文件夹（§9.1、§9.3）', () => {
  it('根目录下直接就是 平台_商品ID_商品ID，不再套平台目录层', () => {
    const p = plan(snapshot({ assets: images('main', 1) }), { kinds: ['main'] });
    expect(p.folder).toEqual(['拼多多_商品ID_482319937501']);
  });

  it('模板里的 {platform} 用平台显示名', () => {
    const p = plan(
      snapshot({ assets: images('main', 1) }),
      { kinds: ['main'] },
      {
        folderTemplate: '{platform}_{id}',
      },
    );
    expect(p.folder).toEqual(['拼多多_482319937501']);
  });

  it('模板里的 {title} 按字素截断（§9.2）', () => {
    const long = '一二三四五六七八九十'.repeat(4); // 40 字素
    const p = plan(
      snapshot({ title: long, assets: images('main', 1) }),
      { kinds: ['main'] },
      { folderTemplate: '{title:30}_{id}' },
    );
    expect(p.folder).toEqual([`${'一二三四五六七八九十'.repeat(3)}_482319937501`]);
  });

  it('截断按字素算，不会切出半个 emoji（§9.2）', () => {
    const emoji = '👗';
    const p = plan(
      snapshot({ title: emoji.repeat(40), assets: images('main', 1) }),
      { kinds: ['main'] },
      { folderTemplate: '{title:30}_{id}' },
    );
    const name = p.folder[0] ?? '';
    const titlePart = name.slice(0, name.lastIndexOf('_'));
    expect(
      Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(titlePart)),
    ).toHaveLength(30);
    // 没有半个代理对：孤立代理项的码点区间是 D800–DFFF
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(titlePart),
    ).toBe(false);
    expect(titlePart).toBe(emoji.repeat(30));
  });

  it('模板缺少 {id} 时抛错（ADR-6）', () => {
    expect(() =>
      plan(
        snapshot({ assets: images('main', 1) }),
        { kinds: ['main'] },
        { folderTemplate: '{title}' },
      ),
    ).toThrow();
  });
});

describe('文件名（§9.1）', () => {
  it('主图是 主图01，详情图是 详情图01', () => {
    const p = plan(snapshot({ assets: [...images('main', 2), ...images('detail', 1)] }), {
      kinds: ['main', 'detail'],
    });
    expect(p.items.map((i) => [i.stem, i.dir])).toEqual([
      ['主图01', ['主图']],
      ['主图02', ['主图']],
      ['详情图01', ['详情图']],
    ]);
  });

  it('编号以整个类别为基准：只选第 3 张详情图，文件名仍是 详情图03', () => {
    const p = plan(snapshot({ assets: images('detail', 26) }), {
      kinds: ['detail'],
      keys: ['detail-3'],
    });
    expect(p.items).toHaveLength(1);
    expect(p.items[0]?.stem).toBe('详情图03');
    expect(p.items[0]?.dir).toEqual(['详情图']);
  });

  it('只在选中范围内产出条目，但序号保留原始位置', () => {
    const p = plan(snapshot({ assets: images('detail', 5) }), {
      kinds: ['detail'],
      keys: ['detail-2', 'detail-5'],
    });
    expect(p.items.map((i) => i.stem)).toEqual(['详情图02', '详情图05']);
  });

  it('总数 ≥ 100 时补到三位', () => {
    const p = plan(snapshot({ assets: images('detail', 100) }), { kinds: ['detail'] });
    expect(p.items[0]?.stem).toBe('详情图001');
    expect(p.items[99]?.stem).toBe('详情图100');
  });

  it('总数 ≤ 99 时补到两位', () => {
    const p = plan(snapshot({ assets: images('detail', 9) }), { kinds: ['detail'] });
    expect(p.items[0]?.stem).toBe('详情图01');
  });
});

describe('itemKey 唯一（§9.5）', () => {
  it('同一计划里不出现重复 itemKey', () => {
    const p = plan(
      snapshot({
        assets: [
          ...images('main', 3),
          ...images('detail', 3),
          asset({ key: 'shared', kind: 'main', index: 3 }),
        ],
      }),
      { kinds: ['main', 'detail'] },
    );
    const keys = p.items.map((i) => i.itemKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('平台给重复 key 时只保留一份', () => {
    const p = plan(
      snapshot({
        assets: [
          asset({ key: 'dup', kind: 'main', index: 0 }),
          asset({ key: 'dup', kind: 'main', index: 1 }),
        ],
      }),
      { kinds: ['main'] },
    );
    expect(p.items).toHaveLength(1);
  });

  it('按页面原始顺序（index）编号，不受数组顺序影响', () => {
    const p = plan(
      snapshot({
        assets: [
          asset({ key: 'b', kind: 'main', index: 1 }),
          asset({ key: 'a', kind: 'main', index: 0 }),
        ],
      }),
      { kinds: ['main'] },
    );
    expect(p.items.map((i) => [i.itemKey, i.stem])).toEqual([
      ['main:a', '主图01'],
      ['main:b', '主图02'],
    ]);
  });
});

describe('SKU 图（§9.1）', () => {
  it('文件名是 SKU序号_规格', () => {
    const p = plan(
      snapshot({
        assets: [asset({ key: 'sku-a', kind: 'sku', index: 0 })],
        skus: [
          {
            id: '1',
            specs: [
              { name: '颜色', value: '杏色' },
              { name: '尺码', value: 'S' },
            ],
            imageKey: 'sku-a',
          },
          {
            id: '2',
            specs: [
              { name: '颜色', value: '杏色' },
              { name: '尺码', value: 'M' },
            ],
            imageKey: 'sku-a',
          },
        ],
      }),
      { kinds: ['sku'] },
    );
    expect(p.items[0]?.stem).toBe('SKU01_杏色');
  });

  it('找不到规格标签时退化成纯序号', () => {
    const p = plan(snapshot({ assets: [asset({ key: 'sku-a', kind: 'sku', index: 0 })] }), {
      kinds: ['sku'],
    });
    expect(p.items[0]?.stem).toBe('SKU01');
  });

  it('多个 SKU 图各自带自己的规格文字', () => {
    const p = plan(
      snapshot({
        assets: [
          asset({ key: 'sku-a', kind: 'sku', index: 0 }),
          asset({ key: 'sku-b', kind: 'sku', index: 1 }),
        ],
        skus: [
          { id: '1', specs: [{ name: '颜色', value: '杏色' }], imageKey: 'sku-a' },
          { id: '2', specs: [{ name: '颜色', value: '藏青' }], imageKey: 'sku-b' },
        ],
      }),
      { kinds: ['sku'] },
    );
    expect(p.items.map((i) => i.stem)).toEqual(['SKU01_杏色', 'SKU02_藏青']);
  });
});

describe('视频（§9.1、§9.9）', () => {
  const videos = [
    asset({ key: 'v1', kind: 'video', index: 0, label: '主图视频' }),
    asset({ key: 'v2', kind: 'video', index: 1, label: '讲解视频' }),
    asset({ key: 'v3', kind: 'video', index: 2 }),
  ];

  it('视频统一是 视频序号，不区分主图视频还是讲解视频', () => {
    const p = plan(snapshot({ assets: videos }), { kinds: ['video'] });
    expect(p.items.map((i) => i.stem)).toEqual(['视频01', '视频02', '视频03']);
  });

  it('expect 是 video', () => {
    const p = plan(snapshot({ assets: videos }), { kinds: ['video'] });
    expect(p.items.every((i) => i.expect === 'video')).toBe(true);
  });

  it('开启视频封面时额外产出一条图片条目', () => {
    const p = plan(
      snapshot({
        assets: [
          asset({
            key: 'v1',
            kind: 'video',
            index: 0,
            label: '主图视频',
            video: { codec: 'h264', container: 'mp4', cover: 'https://p1.pddpic.com/cover.jpg' },
          }),
        ],
      }),
      { kinds: ['video'] },
      { videoCover: true },
    );
    expect(p.items).toHaveLength(2);
    expect(p.items[1]?.stem).toBe('视频01_封面');
    expect(p.items[1]?.expect).toBe('image');
  });

  it('关闭视频封面时不产出额外条目', () => {
    const p = plan(
      snapshot({
        assets: [
          asset({
            key: 'v1',
            kind: 'video',
            index: 0,
            label: '主图视频',
            video: { codec: 'h264', container: 'mp4', cover: 'https://p1.pddpic.com/cover.jpg' },
          }),
        ],
      }),
      { kinds: ['video'] },
    );
    expect(p.items).toHaveLength(1);
  });
});

describe('详情图宽度过滤（§11 detailMinWidth）', () => {
  it('宽度小于阈值的详情图不下载', () => {
    const p = plan(
      snapshot({
        assets: [
          asset({ key: 'd1', kind: 'detail', index: 0, width: 120 }),
          asset({ key: 'd2', kind: 'detail', index: 1, width: 750 }),
        ],
      }),
      { kinds: ['detail'] },
      { detailMinWidth: 200 },
    );
    expect(p.items.map((i) => i.itemKey)).toEqual(['detail:d2']);
  });

  it('宽度未知时保留（宁可多下也不要静默漏图）', () => {
    const p = plan(
      snapshot({ assets: [asset({ key: 'd1', kind: 'detail', index: 0 })] }),
      { kinds: ['detail'] },
      { detailMinWidth: 200 },
    );
    expect(p.items).toHaveLength(1);
  });

  it('阈值 0 表示不过滤', () => {
    const p = plan(
      snapshot({ assets: [asset({ key: 'd1', kind: 'detail', index: 0, width: 10 })] }),
      { kinds: ['detail'] },
      { detailMinWidth: 0 },
    );
    expect(p.items).toHaveLength(1);
  });
});

describe('计划里没有任何侧录文件（用户要求）', () => {
  it('WritePlan 只有 folder 和 items，不含 extras', () => {
    const p = plan(snapshot({ assets: images('main', 1) }), { kinds: ['main'] });
    expect(Object.keys(p).sort()).toEqual(['folder', 'items']);
  });
});

describe('planCounts', () => {
  it('按类别统计条目数', () => {
    const p = plan(snapshot({ assets: [...images('main', 2), ...images('detail', 3)] }), {
      kinds: ['main', 'detail'],
    });
    expect(planCounts(p)).toEqual({ main: 2, sku: 0, detail: 3, video: 0 });
  });
});
