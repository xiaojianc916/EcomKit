import { describe, expect, it } from 'vitest';
import type { Asset } from '../../kernel/model/asset';
import type { ProductSnapshot } from '../../kernel/model/product';
import { type PlannerSettings, planCounts, planDownload } from './planner';

const NOW = new Date(2026, 10, 5, 9, 0).getTime();

const SETTINGS: PlannerSettings = {
  byPlatform: true,
  folderTemplate: '{title:30}_{id}',
  dirNames: { main: '主图', sku: 'SKU图', detail: '详情图', video: '视频' },
  infoTxt: true,
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

describe('文件夹（§9.1、§9.3）', () => {
  it('按平台分文件夹（默认）', () => {
    const p = plan(snapshot({ assets: images('main', 1) }), { kinds: ['main'] });
    expect(p.folder[0]).toBe('拼多多');
    // 标题不到 30 个字素，不截断
    expect(p.folder[1]).toBe('夏季新款显瘦连衣裙女小个子法式复古方领泡泡袖碎花裙_482319937501');
  });

  it('{title:30} 按字素截断标题', () => {
    const long = '一二三四五六七八九十'.repeat(4); // 40 字素
    const p = plan(snapshot({ title: long, assets: images('main', 1) }), { kinds: ['main'] });
    expect(p.folder[1]).toBe(`${'一二三四五六七八九十'.repeat(3)}_482319937501`);
  });

  it('截断按字素算，不会切出半个 emoji（§9.2）', () => {
    // 每个 emoji 用 Intl.Segmenter 看是 1 个字素，但用 .length / 码点算会多出来
    const emoji = '👗';
    const title = emoji.repeat(40);
    const p = plan(snapshot({ title, assets: images('main', 1) }), { kinds: ['main'] });
    const name = p.folder[1] ?? '';
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

  it('关闭按平台分文件夹后直接放根目录', () => {
    const p = plan(
      snapshot({ assets: images('main', 1) }),
      { kinds: ['main'] },
      { byPlatform: false },
    );
    expect(p.folder).toHaveLength(1);
    expect(p.folder[0]).toContain('_482319937501');
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

describe('编号（§9.5、§9.1）', () => {
  it('编号以整个类别为基准：只选第 3 张详情图，文件名仍是 03', () => {
    const p = plan(snapshot({ assets: images('detail', 26) }), {
      kinds: ['detail'],
      keys: ['detail-3'],
    });
    expect(p.items).toHaveLength(1);
    expect(p.items[0]?.stem).toBe('03');
    expect(p.items[0]?.dir).toEqual(['详情图']);
  });

  it('只在选中范围内产出条目，但序号保留原始位置', () => {
    const p = plan(snapshot({ assets: images('detail', 5) }), {
      kinds: ['detail'],
      keys: ['detail-2', 'detail-5'],
    });
    expect(p.items.map((i) => i.stem)).toEqual(['02', '05']);
  });

  it('总数 ≥ 100 时补到三位', () => {
    const p = plan(snapshot({ assets: images('detail', 100) }), { kinds: ['detail'] });
    expect(p.items[0]?.stem).toBe('001');
    expect(p.items[99]?.stem).toBe('100');
  });

  it('总数 ≤ 99 时补到两位', () => {
    const p = plan(snapshot({ assets: images('detail', 9) }), { kinds: ['detail'] });
    expect(p.items[0]?.stem).toBe('01');
  });
});

describe('itemKey 唯一（§9.5）', () => {
  it('同一计划里不出现重复 itemKey', () => {
    const p = plan(
      snapshot({
        assets: [
          ...images('main', 3),
          ...images('detail', 3),
          // 故意造一个跨类别相同的 key：itemKey 带类别前缀，仍然唯一
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
      ['main:a', '01'],
      ['main:b', '02'],
    ]);
  });
});

describe('SKU 图（§9.1）', () => {
  it('文件名是 序号_规格', () => {
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
    expect(p.items[0]?.stem).toBe('01_杏色');
  });

  it('找不到规格标签时退化成纯序号', () => {
    const p = plan(snapshot({ assets: [asset({ key: 'sku-a', kind: 'sku', index: 0 })] }), {
      kinds: ['sku'],
    });
    expect(p.items[0]?.stem).toBe('01');
  });
});

describe('视频（§9.1、§9.9）', () => {
  const videos = [
    asset({ key: 'v1', kind: 'video', index: 0, label: '主图视频' }),
    asset({ key: 'v2', kind: 'video', index: 1, label: '讲解视频' }),
    asset({ key: 'v3', kind: 'video', index: 2 }),
  ];

  it('主图视频、带名字的视频、无名视频各自的命名', () => {
    const p = plan(snapshot({ assets: videos }), { kinds: ['video'] });
    expect(p.items.map((i) => i.stem)).toEqual(['主图视频', '讲解视频_02', '视频_03']);
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
    expect(p.items[1]?.stem).toBe('主图视频_封面');
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

describe('extras（§9.5、§9.12）', () => {
  it('总是写 .ecbox.json；开启后写商品信息.txt', () => {
    const p = plan(snapshot({ assets: images('main', 1) }), { kinds: ['main'] });
    expect(p.extras).toEqual(['folder-manifest', 'info-txt']);
  });

  it('关闭 infoTxt 时不写 txt', () => {
    const p = plan(
      snapshot({ assets: images('main', 1) }),
      { kinds: ['main'] },
      { infoTxt: false },
    );
    expect(p.extras).toEqual(['folder-manifest']);
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
