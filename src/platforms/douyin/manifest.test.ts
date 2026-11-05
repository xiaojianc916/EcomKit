import { describe, expect, it } from 'vitest';
import { DyManifestSelfCheck } from './manifest-self-check';

/**
 * 抖音 manifest 自检：页面识别、CDN 白名单、抓包规则、Phase 0 结论（FINDINGS §1、§1.5）。
 */

describe('douyin manifest', () => {
  const manifest = DyManifestSelfCheck.assertValid();

  it('supportsMobileMode 显式为 false（改 UA 无效，FINDINGS §1）', () => {
    expect(manifest.supportsMobileMode).toBe(false);
  });

  it('不填 referer（CDN 不需要 Referer，FINDINGS §1.5）', () => {
    expect(manifest.referer).toBeUndefined();
  });

  it('brandColor 是 #161823，且带 #25F4EE 描边（§10.6）', () => {
    expect(manifest.brandColor).toBe('#161823');
    expect(manifest.brandRing).toBe('#25F4EE');
  });

  it('CDN 白名单是 FINDINGS §2-5 列出的 6 个域', () => {
    expect(manifest.cdnHosts).toEqual([
      '*.ecombdimg.com',
      '*.byteimg.com',
      '*.douyinpic.com',
      '*.douyinvod.com',
      '*.bytecdn.cn',
      '*.ibyteimg.com',
    ]);
  });

  it('当前详情页路径能被 registry 命中', () => {
    expect(
      DyManifestSelfCheck.findPageKind(
        'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=3637489912345678901',
      ),
    ).toEqual({ kind: 'dy.haohuo', productId: '3637489912345678901' });
  });

  it('历史路径 /views/product/* 也能命中（方案 §7.6 待验证路径）', () => {
    expect(
      DyManifestSelfCheck.findPageKind(
        'https://haohuo.jinritemai.com/views/product/item2?id=3637489912345678901',
      ),
    ).toEqual({ kind: 'dy.haohuo', productId: '3637489912345678901' });
  });

  it('商品 ID 不是纯数字时不命中', () => {
    expect(
      DyManifestSelfCheck.findPageKind(
        'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=abc',
      ),
    ).toBeNull();
  });

  it('抓包主源规则精确到 /aweme/v2/shop/promotion/pack/h5/', () => {
    const pack = manifest.capture.find((c) => c.id === 'dy.product-pack');
    expect(pack?.urlPattern).toBe('/aweme/v2/shop/promotion/pack/h5/');
    expect(pack?.pageKinds).toEqual(['dy.haohuo']);
  });

  it('globals 白名单是数组且不为空（bridge 读取用）', () => {
    expect(Array.isArray(manifest.globals)).toBe(true);
    expect(manifest.globals.length).toBeGreaterThan(0);
  });
});
