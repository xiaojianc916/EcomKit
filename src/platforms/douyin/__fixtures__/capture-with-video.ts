/**
 * 抖音抓包样本 —— 带多编码视频（H.264 + H.265 同时存在，Windows 关键点 §7.6.3）。
 *
 * 结构依据：方案 §7.6「视频选择（Windows 关键点）」。
 * bit_rate[] 里 is_h265 的取值（1 / 0）来自抖音公开的 H5 接口形状，属推测，标「待验证」。
 * 采样日期：2026-11-05。
 *
 * 为什么不是真实样本：Phase 0 任何 UA 下都只给扫码页（FINDINGS §1），
 * 拿不到成功响应体。视频地址用真实 CDN 域名 + 假路径，内容为脱敏虚构数据。
 */

export const DY_VIDEO_PAYLOAD = {
  status_code: 0,
  data: {
    product: {
      product_id: '3637489912345678903',
      title: '不锈钢保温杯大容量',
      shop: { name: '户外装备店' },
      min_price: 6900,
      images: [{ url_list: ['https://p3.douyinpic.com/aweme/cup-01~c5_720x720.webp'] }],
      detail_html: '',
      skus: [],
      video: {
        // H.265 分辨率更高，但 Windows 自带播放器很可能放不了 → 必须选 H.264
        bit_rate: [
          {
            gear_name: 'adapt_540_1',
            bit_rate: 1_200_000,
            is_h265: 0,
            play_addr: {
              url_list: ['https://v.douyinvod.com/aweme/cup-h264-540.mp4?x-expires=1793890600'],
              width: 540,
              height: 960,
            },
          },
          {
            gear_name: 'adapt_1080_1',
            bit_rate: 5_000_000,
            is_h265: 1,
            play_addr: {
              url_list: ['https://v.douyinvod.com/aweme/cup-h265-1080.mp4'],
              width: 1080,
              height: 1920,
            },
          },
          {
            gear_name: 'adapt_720_1',
            bit_rate: 2_500_000,
            is_h265: 0,
            play_addr: {
              url_list: ['https://v.douyinvod.com/aweme/cup-h264-720.mp4'],
              width: 720,
              height: 1280,
            },
          },
        ],
        cover: { url_list: ['https://p3.douyinpic.com/aweme/cup-cover.webp'] },
        duration: 20,
      },
    },
  },
};

export const DY_VIDEO_EXPECTED = {
  title: '不锈钢保温杯大容量',
  videoCount: 1,
  /** 选中的是 H.264 1080 里分辨率最高的那档 */
  pickedCodec: 'h264',
  pickedWidth: 720,
};

/**
 * 只有 H.265 的样本：照常下载，但 UI 依据 video.codec === 'h265' 标「H.265」。
 */
export const DY_H265_ONLY_PAYLOAD = {
  status_code: 0,
  data: {
    product: {
      product_id: '3637489912345678904',
      title: '折叠登山杖轻量便携',
      images: [{ url_list: ['https://p3.douyinpic.com/aweme/pole-01~c5_720x720.webp'] }],
      detail_html: '',
      skus: [],
      video: {
        bit_rate: [
          {
            gear_name: 'adapt_1080_1',
            bit_rate: 4_000_000,
            is_h265: 1,
            play_addr: { url_list: ['https://v.douyinvod.com/aweme/pole-h265.mp4'] },
          },
        ],
      },
    },
  },
};
