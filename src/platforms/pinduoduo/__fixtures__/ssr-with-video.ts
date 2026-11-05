/**
 * 拼多多 SSR 样本 —— 带主图视频。
 *
 * 结构依据：方案 §7.5「视频：goods.videoGallery[]，或者 goods.video 一类的 mp4 地址」。
 * 采样日期：2026-11-05。
 *
 * 为什么不是真实样本：Phase 0 未登录必被登录墙拦下（docs/phase0/FINDINGS.md §1），
 * 且 FINDINGS §3 明确把「视频字段（编码、过期参数）」列为待补项。
 * videoGallery 的元素形状同时给了「字符串」和「对象」两种，覆盖解码器的两条分支。
 */

export const PDD_VIDEO_RAW_DATA = {
  store: {
    initDataObj: {
      goods: {
        goodsId: 482319937503,
        goodsName: '折叠收纳箱家用大容量',
        topGallery: ['https://img.pddpic.com/mms-material-img/2026-06-03/box-main-01.jpeg'],
        detailGallery: [
          {
            url: 'https://img.pddpic.com/mms-material-img/2026-06-03/box-detail-01.jpeg',
            width: 800,
            height: 800,
          },
        ],
        minGroupPrice: 1990,
        skus: [],
        // 混合形状：第一条是对象（带封面和分辨率），第二条是纯地址字符串
        videoGallery: [
          {
            videoUrl: 'https://v.pddpic.com/mms-video/2026-06-03/box-main.mp4?x-expires=1793890600',
            coverUrl: 'https://img.pddpic.com/mms-material-img/2026-06-03/box-cover.jpeg',
            width: 1080,
            height: 1080,
            duration: 12,
          },
          'https://v.pddpic.com/mms-video/2026-06-03/box-detail.mp4',
        ],
      },
      mall: { mallName: '收纳生活馆' },
    },
  },
};

export const PDD_VIDEO_EXPECTED = {
  title: '折叠收纳箱家用大容量',
  videoCount: 2,
  /** 第一条视频带 x-expires=1793890600 */
  firstVideoExpiresAt: 1_793_890_600_000,
};
