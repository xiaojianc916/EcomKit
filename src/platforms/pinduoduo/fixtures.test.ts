import { describe, expect, it } from 'vitest';
import { ProductSnapshot } from '../../kernel/model/product';
import { isAllowedCdnUrl } from '../registry';
import { DraftAccumulator } from '../shared/merge';
import { PDD_COMMON_EXPECTED, PDD_COMMON_RAW_DATA } from './__fixtures__/ssr-common';
import { PDD_MULTI_SKU_EXPECTED, PDD_MULTI_SKU_RAW_DATA } from './__fixtures__/ssr-multi-sku';
import { PDD_VIDEO_EXPECTED, PDD_VIDEO_RAW_DATA } from './__fixtures__/ssr-with-video';
import pddManifest from './manifest';
import { draftFromPayload } from './resolver';

/**
 * 平台回归测试（方案 §15）：用 fixture 跑一遍「原始数据 → draft」，快照比对结构。
 * 平台改版后重新采样，一眼就能看出差异。
 *
 * 放在平台目录根下而不是 __fixtures__/ 里：tsconfig 的 exclude 会把 __fixtures__ 整个排除，
 * 而 tsconfig 的 exclude 也会把该目录下的 *.test.ts 一并排除掉（依赖契约文件，不能改）。
 */

const PAGE_URL = new URL('https://mobile.yangkeduo.com/goods.html?goods_id=482319937501');
const CTX = {
  url: PAGE_URL,
  document: new DOMParser().parseFromString('<html></html>', 'text/html'),
};

function draftOf(payload: unknown) {
  const draft = draftFromPayload(payload, CTX, 'ssr');
  expect(draft).not.toBeNull();
  return draft as NonNullable<ReturnType<typeof draftFromPayload>>;
}

describe('pinduoduo fixture：普通商品', () => {
  const draft = draftOf(PDD_COMMON_RAW_DATA);

  it('标题、店铺、价格', () => {
    expect(draft.title).toBe(PDD_COMMON_EXPECTED.title);
    expect(draft.shopName).toBe(PDD_COMMON_EXPECTED.shopName);
    expect(draft.price).toBe(PDD_COMMON_EXPECTED.price);
  });

  it('主图 / 详情图 / SKU 图数量', () => {
    const by = (kind: string) => (draft.assets ?? []).filter((a) => a.kind === kind);
    expect(by('main')).toHaveLength(PDD_COMMON_EXPECTED.mainCount);
    expect(by('detail')).toHaveLength(PDD_COMMON_EXPECTED.detailCount);
    expect(by('sku')).toHaveLength(PDD_COMMON_EXPECTED.skuCount);
    expect(by('video')).toHaveLength(PDD_COMMON_EXPECTED.videoCount);
  });

  it('主图候选是 [原图, 页面原始 URL]，原图不带 imageView2', () => {
    const first = (draft.assets ?? []).find((a) => a.kind === 'main');
    expect(first?.candidates[0]).not.toContain('imageView2');
    expect(first?.candidates[1]).toContain('imageView2');
  });

  it('所有候选地址都通过 isAllowedCdnUrl()（§13.4）', () => {
    for (const asset of draft.assets ?? []) {
      for (const url of asset.candidates) {
        expect(isAllowedCdnUrl(url), `候选地址不在白名单：${url}`).toBe(true);
      }
      if (asset.preview) expect(isAllowedCdnUrl(asset.preview)).toBe(true);
    }
  });

  it('素材结构快照', () => {
    expect(
      (draft.assets ?? []).map((a) => ({ kind: a.kind, index: a.index, key: a.key })),
    ).toMatchInlineSnapshot(`
      [
        {
          "index": 0,
          "key": "img.pddpic.com/mms-material-img/2026-06-01/aaa111.jpeg",
          "kind": "main",
        },
        {
          "index": 1,
          "key": "img.pddpic.com/mms-material-img/2026-06-01/bbb222.jpeg",
          "kind": "main",
        },
        {
          "index": 2,
          "key": "t00img.yangkeduo.com/goods/images/ccc333.jpg",
          "kind": "main",
        },
        {
          "index": 0,
          "key": "img.pddpic.com/mms-material-img/2026-06-01/detail-01.jpeg",
          "kind": "detail",
        },
        {
          "index": 1,
          "key": "img.pddpic.com/mms-material-img/2026-06-01/detail-02.jpeg",
          "kind": "detail",
        },
        {
          "index": 0,
          "key": "img.pddpic.com/mms-material-img/2026-06-01/sku-01.jpeg",
          "kind": "sku",
        },
      ]
    `);
  });
});

describe('pinduoduo fixture：多 SKU', () => {
  const draft = draftOf(PDD_MULTI_SKU_RAW_DATA);

  it('SKU 数量与共用图的去重', () => {
    expect(draft.skus).toHaveLength(PDD_MULTI_SKU_EXPECTED.skuCount);
    expect((draft.assets ?? []).filter((a) => a.kind === 'sku')).toHaveLength(
      PDD_MULTI_SKU_EXPECTED.skuAssetCount,
    );
  });

  it('共用同一张图的 SKU 指向同一个 imageKey', () => {
    const [whiteM, whiteL, blackM] = draft.skus ?? [];
    expect(whiteM?.imageKey).toBeDefined();
    expect(whiteM?.imageKey).toBe(whiteL?.imageKey);
    expect(blackM?.imageKey).not.toBe(whiteM?.imageKey);
  });

  it('规格按 spec_key / spec_value 解码', () => {
    expect(draft.skus?.[0]?.specs).toEqual([
      { name: '颜色', value: '白色' },
      { name: '尺码', value: 'M' },
    ]);
  });

  it('SKU 价格按分转元', () => {
    expect(draft.skus?.[0]?.price).toBe('¥29.90');
    expect(draft.skus?.[2]?.price).toBe('¥31.90');
  });
});

describe('pinduoduo fixture：带视频', () => {
  const draft = draftOf(PDD_VIDEO_RAW_DATA);

  it('视频数量', () => {
    expect((draft.assets ?? []).filter((a) => a.kind === 'video')).toHaveLength(
      PDD_VIDEO_EXPECTED.videoCount,
    );
  });

  it('第一条视频的过期时间被解析出来（§7.6.4）', () => {
    const video = (draft.assets ?? []).find((a) => a.kind === 'video');
    expect(video?.video?.expiresAt).toBe(PDD_VIDEO_EXPECTED.firstVideoExpiresAt);
  });

  it('视频地址都在白名单内', () => {
    for (const asset of (draft.assets ?? []).filter((a) => a.kind === 'video')) {
      expect(isAllowedCdnUrl(asset.candidates[0] ?? '')).toBe(true);
    }
  });

  it('第一条视频带封面，且封面在白名单内', () => {
    const video = (draft.assets ?? []).find((a) => a.kind === 'video');
    expect(video?.video?.cover).toBeDefined();
    expect(isAllowedCdnUrl(video?.video?.cover ?? '')).toBe(true);
  });
});

describe('pinduoduo fixture：白名单外的地址被丢弃', () => {
  it('伪造的抓包数据无法把任意域名塞进候选', () => {
    const draft = draftFromPayload(
      {
        store: {
          initDataObj: {
            goods: {
              goodsName: '伪造商品',
              topGallery: ['https://evil.com/a.jpg', 'https://img.pddpic.com/real.jpg'],
            },
          },
        },
      },
      CTX,
      'capture',
    );
    const main = (draft?.assets ?? []).filter((a) => a.kind === 'main');
    expect(main).toHaveLength(1);
    expect(main[0]?.candidates[0]).toBe('https://img.pddpic.com/real.jpg');
  });
});

describe('pinduoduo fixture：能组装成合法 ProductSnapshot', () => {
  it('ProductDraft 经合并后通过 ProductSnapshot 校验', () => {
    const acc = new DraftAccumulator();
    acc.add(draftOf(PDD_COMMON_RAW_DATA));
    const snapshot = acc.toSnapshot({
      platform: 'pinduoduo',
      pageKind: 'pdd.goods',
      productId: '482319937501',
      fallbackUrl: PAGE_URL.toString(),
      capturedAt: 1_700_000_000_000,
    });
    expect(snapshot).not.toBeNull();
    const parsed = ProductSnapshot.safeParse(snapshot);
    expect(parsed.success).toBe(true);
  });

  it('manifest 的 CDN 白名单都是通配形式', () => {
    for (const host of pddManifest.cdnHosts) {
      expect(host.startsWith('*.')).toBe(true);
    }
  });
});
