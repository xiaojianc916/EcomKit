import { describe, expect, it } from 'vitest';
import { ProductSnapshot } from '../../kernel/model/product';
import { isAllowedCdnUrl } from '../registry';
import { DraftAccumulator } from '../shared/merge';
import { DY_COMMON_EXPECTED, DY_COMMON_PAYLOAD } from './__fixtures__/capture-common';
import { DY_MULTI_SKU_EXPECTED, DY_MULTI_SKU_PAYLOAD } from './__fixtures__/capture-multi-sku';
import {
  DY_H265_ONLY_PAYLOAD,
  DY_VIDEO_EXPECTED,
  DY_VIDEO_PAYLOAD,
} from './__fixtures__/capture-with-video';
import dyManifest from './manifest';
import { detectDyBlocker, draftFromPayload } from './resolver';

/**
 * 平台回归测试（方案 §15）：fixture → draft，快照比对结构。
 * 放在平台目录根下而不是 __fixtures__/ 里：tsconfig 的 exclude 会把 __fixtures__ 整个排除。
 */

const PAGE_URL = new URL(
  'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=3637489912345678901',
);
const CTX = {
  url: PAGE_URL,
  document: new DOMParser().parseFromString('<html></html>', 'text/html'),
};

function draftOf(payload: unknown) {
  const draft = draftFromPayload(payload, CTX, 'capture');
  expect(draft).not.toBeNull();
  return draft as NonNullable<ReturnType<typeof draftFromPayload>>;
}

describe('douyin fixture：普通商品', () => {
  const draft = draftOf(DY_COMMON_PAYLOAD);

  it('标题、店铺、价格', () => {
    expect(draft.title).toBe(DY_COMMON_EXPECTED.title);
    expect(draft.shopName).toBe(DY_COMMON_EXPECTED.shopName);
    expect(draft.price).toBe(DY_COMMON_EXPECTED.price);
  });

  it('主图 / 详情图 / 视频数量', () => {
    const by = (kind: string) => (draft.assets ?? []).filter((a) => a.kind === kind);
    expect(by('main')).toHaveLength(DY_COMMON_EXPECTED.mainCount);
    expect(by('detail')).toHaveLength(DY_COMMON_EXPECTED.detailCount);
    expect(by('video')).toHaveLength(DY_COMMON_EXPECTED.videoCount);
  });

  it('主图候选是 [原图 ~tplv-obj.image, 页面原始 URL]', () => {
    const first = (draft.assets ?? []).find((a) => a.kind === 'main');
    expect(first?.candidates[0]).toContain('~tplv-obj.image');
    expect(first?.candidates[1]).toContain('~c5_720x720.webp');
  });

  it('详情图来自富文本 HTML，且按文档顺序', () => {
    const details = (draft.assets ?? []).filter((a) => a.kind === 'detail');
    expect(details.map((a) => a.index)).toEqual([0, 1]);
    expect(details[0]?.candidates[0]).toContain('detail-01');
    expect(details[1]?.candidates[0]).toContain('detail-02');
  });

  it('所有候选地址都通过 isAllowedCdnUrl()', () => {
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
          "key": "p3.douyinpic.com/aweme/pajama-01~tplv-obj.image",
          "kind": "main",
        },
        {
          "index": 1,
          "key": "p6.douyinpic.com/aweme/pajama-02~tplv-obj.image",
          "kind": "main",
        },
        {
          "index": 0,
          "key": "p3.douyinpic.com/aweme/detail-01~tplv-obj.image",
          "kind": "detail",
        },
        {
          "index": 1,
          "key": "p9.douyinpic.com/aweme/detail-02~tplv-obj.image",
          "kind": "detail",
        },
        {
          "index": 0,
          "key": "video-v.douyinvod.com/aweme/main-video.mp4",
          "kind": "video",
        },
      ]
    `);
  });
});

describe('douyin fixture：多 SKU', () => {
  const draft = draftOf(DY_MULTI_SKU_PAYLOAD);

  it('SKU 数量与共用图去重', () => {
    expect(draft.skus).toHaveLength(DY_MULTI_SKU_EXPECTED.skuCount);
    expect((draft.assets ?? []).filter((a) => a.kind === 'sku')).toHaveLength(
      DY_MULTI_SKU_EXPECTED.skuAssetCount,
    );
  });

  it('共用同一张图的 SKU 指向同一个 imageKey', () => {
    const [a, b, c] = draft.skus ?? [];
    expect(a?.imageKey).toBeDefined();
    expect(a?.imageKey).toBe(b?.imageKey);
    expect(c?.imageKey).not.toBe(a?.imageKey);
  });

  it('两种规格写法都能解码', () => {
    expect(draft.skus?.[0]?.specs).toEqual([
      { name: '颜色', value: '藏青' },
      { name: '规格', value: '单只' },
    ]);
    expect(draft.skus?.[2]?.specs).toEqual([{ name: '颜色', value: '藕粉' }]);
  });

  it('价格按分转元', () => {
    expect(draft.skus?.[0]?.price).toBe('¥39.00');
    expect(draft.skus?.[2]?.price).toBe('¥43.00');
  });
});

describe('douyin fixture：带多编码视频', () => {
  const draft = draftOf(DY_VIDEO_PAYLOAD);
  const video = (draft.assets ?? []).find((a) => a.kind === 'video');

  it('只产出一个视频素材', () => {
    expect((draft.assets ?? []).filter((a) => a.kind === 'video')).toHaveLength(
      DY_VIDEO_EXPECTED.videoCount,
    );
  });

  it('Windows 关键点：H.264 优先，即使 H.265 分辨率更高（§7.6.3）', () => {
    expect(video?.video?.codec).toBe(DY_VIDEO_EXPECTED.pickedCodec);
    expect(video?.video?.width).toBe(DY_VIDEO_EXPECTED.pickedWidth);
  });

  it('选中地址的过期参数被解析（§7.6.4）', () => {
    // 选中的 720p 那档没有过期参数，所以 expiresAt 不出现
    expect(video?.video).not.toHaveProperty('expiresAt');
  });

  it('视频带封面，且封面在白名单内', () => {
    expect(video?.video?.cover).toBeDefined();
    expect(isAllowedCdnUrl(video?.video?.cover ?? '')).toBe(true);
  });

  it('视频的 preview 就是封面，不是 mp4 直链（面板缩略图用）', () => {
    expect(video?.preview).toBe(video?.video?.cover);
    expect(video?.preview).not.toBe(video?.candidates[0]);
  });

  it('视频地址在白名单内', () => {
    expect(isAllowedCdnUrl(video?.candidates[0] ?? '')).toBe(true);
  });
});

describe('douyin fixture：只有 H.265', () => {
  const draft = draftOf(DY_H265_ONLY_PAYLOAD);
  const video = (draft.assets ?? []).find((a) => a.kind === 'video');

  it('照常下载，codec 标成 h265（UI 依据它显示「H.265」）', () => {
    expect(video?.video?.codec).toBe('h265');
  });
});

describe('douyin 阻断判定（FINDINGS §1 实测文案）', () => {
  const APP_ONLY_HTML =
    '<html><body><div class="detail-abnormal">' +
    '<img class="na-rq-code" src="https://p3.douyinpic.com/img/aweme-qrcode/x~c5_720x720.webp">' +
    '<div class="err-common-text">请使用抖音APP扫码或</div>' +
    '<div class="err-reason-text">检测到当前环境存在安全风险，请进入抖音查看商品详情</div>' +
    '</div></body></html>';

  it('扫码页 → APP_ONLY', () => {
    const doc = new DOMParser().parseFromString(APP_ONLY_HTML, 'text/html');
    expect(detectDyBlocker(doc, PAGE_URL)).toBe('APP_ONLY');
  });

  it('只有二维码元素、没有商品图 → APP_ONLY（第二个信号）', () => {
    const html =
      '<html><body><img class="na-rq-code" src="https://p3.douyinpic.com/qr.webp"></body></html>';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(detectDyBlocker(doc, PAGE_URL)).toBe('APP_ONLY');
  });

  it('有商品数据时不误判成 APP_ONLY', () => {
    const html =
      '<html><body><div class="gallery"><img src="https://p3.douyinpic.com/a.webp" width="800"></div>' +
      '<p>请使用抖音APP扫码</p></body></html>';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(detectDyBlocker(doc, PAGE_URL)).toBeNull();
  });

  it('「商品已下架」→ PRODUCT_GONE', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body>该商品已下架</body></html>',
      'text/html',
    );
    expect(detectDyBlocker(doc, PAGE_URL)).toBe('PRODUCT_GONE');
  });

  it('空页面不误判', () => {
    const doc = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
    expect(detectDyBlocker(doc, PAGE_URL)).toBeNull();
  });
});

describe('douyin manifest（FINDINGS §1、§1.5）', () => {
  it('supportsMobileMode: false（改 UA 无效）', () => {
    expect(dyManifest.supportsMobileMode).toBe(false);
  });

  it('不填 referer（CDN 不需要 Referer）', () => {
    expect(dyManifest.referer).toBeUndefined();
  });

  it('CDN 白名单包含 FINDINGS 列出的全部域名', () => {
    for (const host of [
      '*.ecombdimg.com',
      '*.byteimg.com',
      '*.douyinpic.com',
      '*.douyinvod.com',
      '*.bytecdn.cn',
      '*.ibyteimg.com',
    ]) {
      expect(dyManifest.cdnHosts).toContain(host);
    }
  });

  it('页面类型含当前路径和历史路径', () => {
    const kinds = dyManifest.pageKinds.map((k) => k.kind);
    expect(kinds).toContain('dy.haohuo');
    const matches = dyManifest.pageKinds.flatMap((k) => k.matches).join(' ');
    expect(matches).toContain('ecommerce/trade/detail/index.html');
    expect(matches).toContain('views/product');
  });

  it('抓包规则包含主源 /aweme/v2/shop/promotion/pack/h5/', () => {
    const patterns = dyManifest.capture.map((c) => c.urlPattern).join(' ');
    expect(patterns).toContain('/aweme/v2/shop/promotion/pack/h5/');
  });
});

describe('douyin fixture：能组装成合法 ProductSnapshot', () => {
  it('ProductDraft 经合并后通过 ProductSnapshot 校验', () => {
    const acc = new DraftAccumulator();
    acc.add(draftOf(DY_COMMON_PAYLOAD));
    const snapshot = acc.toSnapshot({
      platform: 'douyin',
      pageKind: 'dy.haohuo',
      productId: '3637489912345678901',
      fallbackUrl: PAGE_URL.toString(),
      capturedAt: 1_700_000_000_000,
    });
    expect(snapshot).not.toBeNull();
    expect(ProductSnapshot.safeParse(snapshot).success).toBe(true);
  });
});
