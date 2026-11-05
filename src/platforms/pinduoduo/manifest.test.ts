import { describe, expect, it } from 'vitest';
import { PlatformSnapshotSelfCheck } from './manifest-self-check';

/**
 * 两个平台 manifest 的共同自检（方案 §7.1、§12、附录 A）：
 * match pattern 能被 registry 的判定器命中、CDN 白名单可用、抓包规则形状正确。
 * 平台目录不能 import 别的平台，所以这里只测 pinduoduo 自己的清单。
 */

describe('pinduoduo manifest', () => {
  it('页面类型是 pdd.goods，商品 ID 参数是 goods_id', () => {
    const check = PlatformSnapshotSelfCheck.assertValid();
    expect(check.pageKinds.map((k) => k.kind)).toEqual(['pdd.goods']);
    expect(check.pageKinds[0]?.productIdParam).toBe('goods_id');
  });

  it('覆盖 mobile.yangkeduo.com 和 mobile.pinduoduo.com 两个域（方案 §7.5）', () => {
    const matches = PlatformSnapshotSelfCheck.assertValid()
      .pageKinds.flatMap((k) => k.matches)
      .join(' ');
    expect(matches).toContain('mobile.yangkeduo.com');
    expect(matches).toContain('mobile.pinduoduo.com');
  });

  it('CDN 白名单只有 FINDINGS §2-5 列出的两个域', () => {
    expect(PlatformSnapshotSelfCheck.assertValid().cdnHosts).toEqual([
      '*.pddpic.com',
      '*.yangkeduo.com',
    ]);
  });

  it('不填 referer（FINDINGS §1.5：CDN 不需要 Referer）', () => {
    expect(PlatformSnapshotSelfCheck.assertValid().referer).toBeUndefined();
  });

  it('README 里的第二个域能真的被 registry 命中', () => {
    expect(
      PlatformSnapshotSelfCheck.findPageKind(
        'https://mobile.pinduoduo.com/goods.html?goods_id=482319937501',
      ),
    ).toEqual({ kind: 'pdd.goods', productId: '482319937501' });
  });
});
