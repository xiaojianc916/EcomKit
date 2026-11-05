/**
 * 抖音抓包样本 —— 多 SKU（两个规格维度，部分 SKU 共用一张图）。
 *
 * 结构依据：方案 §7.6。抖音 sku 列表的形状是**推测**（FINDINGS §3 待补），
 * 所以这里同时给了 specs[{name,value}] 和 spec_detail 两种写法，覆盖解码的两条分支。
 * 采样日期：2026-11-05。
 *
 * 为什么不是真实样本：Phase 0 无人值守环境只拿到扫码页（FINDINGS §1），
 * 商品数据为脱敏虚构内容。
 */

export const DY_MULTI_SKU_PAYLOAD = {
  status_code: 0,
  data: {
    promotion: {
      product_id: '3637489912345678902',
      title: '真丝眼罩遮光透气',
      shop: { name: '睡眠研究所' },
      min_price: 3900,
      images: [{ url_list: ['https://p3.douyinpic.com/aweme/mask-01~c5_720x720.webp'] }],
      detail_html:
        '<p><img src="https://p3.douyinpic.com/aweme/mask-detail-01~c5_720x720.webp"></p>',
      skus: [
        {
          sku_id: '770001',
          price: 3900,
          stock: 120,
          image: { url_list: ['https://p3.douyinpic.com/aweme/mask-navy~c5_200x200.webp'] },
          specs: [
            { name: '颜色', value: '藏青' },
            { name: '规格', value: '单只' },
          ],
        },
        {
          sku_id: '770002',
          price: 3900,
          stock: 60,
          image: { url_list: ['https://p3.douyinpic.com/aweme/mask-navy~c5_200x200.webp'] },
          specs: [
            { name: '颜色', value: '藏青' },
            { name: '规格', value: '两只装' },
          ],
        },
        {
          sku_id: '770003',
          price: 4300,
          stock: 8,
          image: { url_list: ['https://p6.douyinpic.com/aweme/mask-pink~c5_200x200.webp'] },
          spec_detail: { 颜色: '藕粉' },
        },
      ],
      video: {},
    },
  },
};

export const DY_MULTI_SKU_EXPECTED = {
  title: '真丝眼罩遮光透气',
  skuCount: 3,
  /** 3 个 SKU 共用 2 张图 → 只生成 2 个 sku 素材 */
  skuAssetCount: 2,
};
