import type { PlatformManifest } from '../types';

/**
 * 抖音商城平台清单（纯数据，只能 import type）。
 *
 * 依据：方案 §7.6 + docs/phase0/FINDINGS.md。
 * - 任何桌面 / 手机 UA 下都只给扫码页，改 UA 无效（FINDINGS §1），
 *   所以 supportsMobileMode 显式设 false：bg 不再提供 DNR 改 UA 的「以手机模式重新打开」；
 * - CDN 不需要 Referer，不填 referer 字段（FINDINGS §1.5）。
 */
const manifest: PlatformManifest = {
  id: 'douyin',
  displayName: '抖音',
  brandColor: '#161823',
  // §10.6：抖音的品牌色近黑，深色主题下会消失，需要 1px 描边
  brandRing: '#25F4EE',
  pageKinds: [
    {
      kind: 'dy.haohuo',
      matches: ['https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html*'],
      productIdParam: 'id',
    },
    {
      // 历史路径（方案 §7.6「待验证」）：match pattern 允许，能不能出数据由 resolver 决定
      kind: 'dy.haohuo',
      matches: ['https://haohuo.jinritemai.com/views/product/*'],
      productIdParam: 'id',
    },
  ],
  cdnHosts: [
    '*.ecombdimg.com',
    '*.byteimg.com',
    '*.douyinpic.com',
    '*.douyinvod.com',
    '*.bytecdn.cn',
    '*.ibyteimg.com',
  ],
  capture: [
    {
      // 主数据源（ADR-7：页面带签名，只能旁听页面自己的请求）
      id: 'dy.product-pack',
      pageKinds: ['dy.haohuo'],
      urlPattern: '/aweme/v2/shop/promotion/pack/h5/',
    },
    {
      // 待验证：详情接口有多个入口，先宽匹配，ISOLATED 侧再精筛
      id: 'dy.product-detail',
      pageKinds: ['dy.haohuo'],
      urlPattern: '/ecom/product/detail/.*',
    },
  ],
  // Phase 0 实测：无 SSR 全局变量（FINDINGS §1），白名单只留历史上见过的候选
  globals: ['__INITIAL_STATE__', '_ROUTER_DATA', '__SSR_DATA__', '__INITIAL_SSR_STATE__'],
  supportsMobileMode: false,
};

export default manifest;
