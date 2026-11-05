/**
 * 拼多多 SSR 样本 —— 普通商品（单 SKU、有主图与详情图、无视频）。
 *
 * 结构依据：方案 §7.5「字段映射（候选）」+ docs/phase0/FINDINGS.md §1 实测的
 * `window.rawData` 信封（`{ store: { initDataObj: { … } } }`）。
 * 采样日期：2026-11-05。
 *
 * 为什么不是真实样本：Phase 0 实测未登录访问商品页**必然跳登录页**，
 * 服务端只返回 `initDataObj: { needLogin: true }`，拿不到 goods 子树（FINDINGS §1、§3）。
 * 所以这里的字段名和层级按方案 §7.5 的候选路径表构造，**商品数据全部是脱敏虚构内容**，
 * 图片地址用真实 CDN 域名 + 假路径，保证能通过 isAllowedCdnUrl() 白名单。
 * 拿到登录态真实样本后，用 scripts/phase0/import-fixtures.ts 覆盖本文件即可。
 */

export const PDD_COMMON_RAW_DATA = {
  store: {
    initDataObj: {
      goods: {
        goodsId: 482319937501,
        goodsName: '夏季新款显瘦连衣裙女小个子法式',
        goodsName2: '',
        // 主图：真实数据里 topGallery 的每一项可能是字符串，也可能是 { url }
        topGallery: [
          'https://img.pddpic.com/mms-material-img/2026-06-01/aaa111.jpeg?imageView2/2/w/800/q/70',
          { url: 'https://img.pddpic.com/mms-material-img/2026-06-01/bbb222.jpeg' },
          'https://t00img.yangkeduo.com/goods/images/ccc333.jpg?imageMogr2/thumbnail/800x800',
        ],
        // 详情图：带 width / height
        detailGallery: [
          {
            url: 'https://img.pddpic.com/mms-material-img/2026-06-01/detail-01.jpeg',
            width: 750,
            height: 1000,
          },
          {
            url: 'https://img.pddpic.com/mms-material-img/2026-06-01/detail-02.jpeg',
            width: 750,
            height: 1200,
          },
        ],
        skus: [
          {
            skuId: 880001,
            thumbUrl: 'https://img.pddpic.com/mms-material-img/2026-06-01/sku-01.jpeg',
            groupPrice: 5900,
            quantity: 120,
            specs: [{ spec_key: '颜色', spec_value: '杏色' }],
          },
        ],
        // 价格单位是「分」
        minGroupPrice: 5900,
        // 待验证：登录态下的视频字段（普通商品没有视频）
        videoGallery: [],
      },
      mall: {
        mallId: 770001,
        mallName: '素白女装旗舰店',
      },
    },
  },
};

export const PDD_COMMON_EXPECTED = {
  title: '夏季新款显瘦连衣裙女小个子法式',
  shopName: '素白女装旗舰店',
  price: '¥59.00',
  mainCount: 3,
  detailCount: 2,
  skuCount: 1,
  videoCount: 0,
};
