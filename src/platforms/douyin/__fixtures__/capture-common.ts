/**
 * 抖音抓包样本 —— 普通商品（主图 + 富文本详情 + 单个 mp4 视频）。
 *
 * 结构依据：方案 §7.6「解析要点」+ docs/phase0/FINDINGS.md §1 实测到的接口清单
 * （`/aweme/v2/shop/promotion/pack/h5/`、`/ecom/product/detail/h5/sc/`）。
 * 采样日期：2026-11-05。
 *
 * 为什么不是真实样本：Phase 0 实测任何桌面 / 手机 UA 下页面都只给扫码页
 * （「请使用抖音APP扫码」「检测到当前环境存在安全风险」），页面从不发成功的商品接口，
 * 拿不到 `/aweme/v2/shop/promotion/pack/h5/` 的正常响应体（FINDINGS §1、§3）。
 * 所以字段名按抖音电商 H5 接口的公开形状（play_addr.url_list / bit_rate[] / is_h265）
 * 构造，**商品内容全部是脱敏虚构数据**，图片 / 视频地址用真实 CDN 域名 + 假路径，
 * 保证能通过 isAllowedCdnUrl() 白名单。
 */

export const DY_COMMON_PAYLOAD = {
  status_code: 0,
  data: {
    product: {
      product_id: '3637489912345678901',
      title: '秋冬加厚珊瑚绒睡衣女套装',
      shop: { name: '暖居家纺旗舰店' },
      min_price: 8900,
      images: [
        { url_list: ['https://p3.douyinpic.com/aweme/pajama-01~c5_720x720.webp?from=1'] },
        { url_list: ['https://p6.douyinpic.com/aweme/pajama-02~c5_720x720.webp?from=1'] },
      ],
      // 详情是富文本 HTML（§7.6.1）
      detail_html:
        '<div><img src="https://p3.douyinpic.com/aweme/detail-01~c5_720x720.webp"><img src="https://p9.douyinpic.com/aweme/detail-02~c5_720x720.webp"></div>',
      skus: [],
      video: {
        play_addr: {
          url_list: ['https://v.douyinvod.com/aweme/main-video.mp4'],
          width: 1080,
          height: 1920,
        },
        cover: { url_list: ['https://p3.douyinpic.com/aweme/cover.webp'] },
        duration: 15,
      },
    },
  },
};

export const DY_COMMON_EXPECTED = {
  title: '秋冬加厚珊瑚绒睡衣女套装',
  shopName: '暖居家纺旗舰店',
  price: '¥89.00',
  mainCount: 2,
  detailCount: 2,
  videoCount: 1,
};
