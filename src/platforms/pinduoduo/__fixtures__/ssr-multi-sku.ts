/**
 * 拼多多 SSR 样本 —— 多 SKU（两种规格维度，多个 SKU 共用一张图）。
 *
 * 结构依据：方案 §7.5「SKU：goods.skus[]，图片是 thumbUrl，规格是 specs[].spec_key / spec_value」。
 * 采样日期：2026-11-05。
 *
 * 为什么不是真实样本：Phase 0 未登录必被登录墙拦下（docs/phase0/FINDINGS.md §1），
 * 无法取得登录态的 goods.skus。字段名按方案 §7.5 构造，商品数据为脱敏虚构内容。
 * 这里特意保留了「3 个 SKU 共用 2 张图」的形状，用来验证 §7.3 的去重规则。
 */

export const PDD_MULTI_SKU_RAW_DATA = {
  store: {
    initDataObj: {
      goods: {
        goodsId: 482319937502,
        goodsName: '纯棉短袖T恤男女同款宽松',
        topGallery: [
          'https://img.pddpic.com/mms-material-img/2026-06-02/tee-main-01.jpeg?imageView2/2/w/800',
        ],
        detailGallery: [],
        minGroupPrice: 2990,
        skus: [
          {
            skuId: 990001,
            thumbUrl: 'https://img.pddpic.com/mms-material-img/2026-06-02/tee-white.jpeg',
            groupPrice: 2990,
            quantity: 88,
            specs: [
              { spec_key: '颜色', spec_value: '白色' },
              { spec_key: '尺码', spec_value: 'M' },
            ],
          },
          {
            skuId: 990002,
            thumbUrl: 'https://img.pddpic.com/mms-material-img/2026-06-02/tee-white.jpeg',
            groupPrice: 2990,
            quantity: 45,
            specs: [
              { spec_key: '颜色', spec_value: '白色' },
              { spec_key: '尺码', spec_value: 'L' },
            ],
          },
          {
            skuId: 990003,
            thumbUrl: 'https://img.pddpic.com/mms-material-img/2026-06-02/tee-black.jpeg',
            groupPrice: 3190,
            quantity: 12,
            specs: [
              { spec_key: '颜色', spec_value: '黑色' },
              { spec_key: '尺码', spec_value: 'M' },
            ],
          },
        ],
      },
      mall: { mallName: '基础款服饰工厂店' },
    },
  },
};

export const PDD_MULTI_SKU_EXPECTED = {
  title: '纯棉短袖T恤男女同款宽松',
  skuCount: 3,
  /** 3 个 SKU 共用 2 张图 → 只生成 2 个 sku 素材（§7.3、§9.1） */
  skuAssetCount: 2,
};
