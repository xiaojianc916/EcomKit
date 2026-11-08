import { describe, expect, it } from 'vitest';
import { deepScanPdd } from './deep-scan';

const HOSTS = ['*.pddpic.com'];

describe('deepScanPdd 的记忆化', () => {
  it('同一个 payload + 同一个 base 只扫一次（返回同一对象）', () => {
    const root = {
      detailGallery: [{ url: 'https://img.pddpic.com/detail-1.jpg', width: 750, height: 1000 }],
    };
    const first = deepScanPdd(root, { cdnHosts: HOSTS });
    const second = deepScanPdd(root, { cdnHosts: HOSTS });
    expect(second).toBe(first);
    expect(first.detail).toHaveLength(1);
  });

  it('base 不同必须分别扫描：相对地址的解析结果不一样', () => {
    const root = { bannerList: ['/x.jpg'] };
    const allowed = deepScanPdd(root, {
      cdnHosts: HOSTS,
      base: 'https://img.pddpic.com/a/',
    });
    const notAllowed = deepScanPdd(root, {
      cdnHosts: HOSTS,
      base: 'https://mobile.yangkeduo.com/goods.html',
    });
    expect(allowed.main.map((img) => img.url)).toEqual(['/x.jpg']);
    expect(notAllowed.main).toEqual([]);
  });
});
