import { describe, expect, it } from 'vitest';
import { draftFromPayload } from './resolver';

/**
 * 「没有 topGallery 的真实抓包」回归测试。
 *
 * 结构取自拼多多登录态真实响应（标题/ID/价格等值已匿名化），保留两个关键特征：
 *   1. **没有 topGallery** —— 主图数组缺失，只有一张 pdd_thumb_url 和 19 张详情图；
 *   2. **价格字段全是字符串 "0"** —— 未登录时平台就是这么下发的。
 *
 * 这两点以前各造成一个用户可见的 bug：
 *   · 19 张详情图全被 deep-scan 归成主图（主图 19 / 详情 0，目录结构全错）；
 *   · 商品信息.txt 里写着「价格：¥0.00」。
 */
function realLikePayload() {
  const detail = Array.from({ length: 19 }, (_, i) => ({
    url: `https://img.pddpic.com/mms-material-img/2023-11-30/detail-${String(i + 1).padStart(2, '0')}.jpeg.a.jpeg`,
    width: 790,
    height: 862,
  }));
  return {
    store: {
      initDataObj: {
        needLogin: false,
        goods: {
          goodsID: 733110622897,
          goodsName: '【热巴推荐】德佑洗脸巾悬挂式一次性绵柔巾干湿两用柔软亲肤洁面',
          // 关键 1：没有 topGallery / top_gallery
          pdd_thumb_url: 'https://img.pddpic.com/mms-goods-image/2026-07-13/main.jpeg.a.jpeg',
          // 关键 2：价格下发为 0
          minGroupPrice: '0',
          min_group_price: '0',
          groupPrice: '0',
          detailGallery: detail,
          skus: [],
        },
      },
    },
  };
}

const ctx = {
  url: new URL('https://mobile.yangkeduo.com/goods.html?goods_id=733110622897'),
  document: { title: '' } as Document,
};

describe('拼多多真实抓包结构（无 topGallery）', () => {
  it('详情图不会被当成主图（§9.4 素材分类）', () => {
    const draft = draftFromPayload(realLikePayload(), ctx, 'ssr');
    expect(draft).not.toBeNull();
    const counts = { main: 0, sku: 0, detail: 0, video: 0 };
    for (const asset of draft?.assets ?? []) counts[asset.kind] += 1;
    expect(counts.detail).toBeGreaterThanOrEqual(19);
    expect(counts.main).toBeLessThanOrEqual(1);
  });

  it('价格为 "0" 时不显示 ¥0.00（§9.12 商品信息.txt）', () => {
    const draft = draftFromPayload(realLikePayload(), ctx, 'ssr');
    expect(draft?.price).toBeUndefined();
  });

  it('标题和素材都能解析出来', () => {
    const draft = draftFromPayload(realLikePayload(), ctx, 'ssr');
    expect(draft?.title).toContain('德佑洗脸巾');
    expect((draft?.assets ?? []).length).toBeGreaterThanOrEqual(19);
  });
});
