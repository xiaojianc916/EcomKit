import type { PlatformManifest } from '../types';

/**
 * 拼多多平台清单（纯数据，只能 import type）。
 *
 * 依据：方案 §7.5 + docs/phase0/FINDINGS.md。
 * - 未登录必然跳登录页（`rawData.store.initDataObj = { needLogin: true }`），见 FINDINGS §1；
 * - CDN 不需要 Referer，所以**不填 referer 字段**，bg 不装动态规则（FINDINGS §1.5）。
 */
const manifest: PlatformManifest = {
  id: 'pinduoduo',
  displayName: '拼多多',
  brandColor: '#E02E24',
  pageKinds: [
    {
      kind: 'pdd.goods',
      matches: [
        'https://mobile.yangkeduo.com/goods*.html*',
        'https://mobile.pinduoduo.com/goods*.html*',
      ],
      productIdParam: 'goods_id',
    },
  ],
  cdnHosts: ['*.pddpic.com', '*.yangkeduo.com'],
  capture: [
    {
      // 宽匹配 + 精确过滤（FINDINGS §2-4）：
      // MAIN 侧按接口路径粗筛，ISOLATED 侧再用 Zod 和 goods_id 校验。
      // 待验证：登录态下商品详情接口的确切路径，先覆盖 /proxy/api/ 下所有 goods 相关接口。
      id: 'pdd.goods-detail',
      pageKinds: ['pdd.goods'],
      // 商品页前端渲染时数据来自 /proxy/api/api/oak/integration/render（第三方实测），一并覆盖
      urlPattern: '/proxy/api/.*(goods|detail|sku|mall|render|integration).*',
    },
  ],
  // 允许 bridge 读取的全局变量白名单（§7.4）
  globals: ['rawData', 'rawData.store', 'rawData.store.initDataObj', '_oakRawData'],
};

export default manifest;
