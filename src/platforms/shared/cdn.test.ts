import { describe, expect, it } from 'vitest';
import { allowedUrls, hostMatchesPattern, isAllowedCdnUrl } from './cdn';

const HOSTS = ['*.pddpic.com', '*.yangkeduo.com'];

describe('hostMatchesPattern', () => {
  it('通配符匹配子域，也匹配根域', () => {
    expect(hostMatchesPattern('img.pddpic.com', '*.pddpic.com')).toBe(true);
    expect(hostMatchesPattern('a.b.pddpic.com', '*.pddpic.com')).toBe(true);
    expect(hostMatchesPattern('pddpic.com', '*.pddpic.com')).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(hostMatchesPattern('IMG.PDDPIC.COM', '*.pddpic.com')).toBe(true);
  });

  it('相似但不相同的域不算命中（防止 pddpic.com.evil.com 绕过）', () => {
    expect(hostMatchesPattern('pddpic.com.evil.com', '*.pddpic.com')).toBe(false);
    expect(hostMatchesPattern('evilpddpic.com', '*.pddpic.com')).toBe(false);
  });
});

describe('isAllowedCdnUrl', () => {
  it('白名单内的 https 地址通过', () => {
    expect(isAllowedCdnUrl('https://img.pddpic.com/a.jpg', HOSTS)).toBe(true);
    expect(isAllowedCdnUrl('https://t00img.yangkeduo.com/a.jpg', HOSTS)).toBe(true);
  });

  it('白名单外的域名拒绝（伪造抓包数据的最后一道闸）', () => {
    expect(isAllowedCdnUrl('https://evil.com/a.jpg', HOSTS)).toBe(false);
    expect(isAllowedCdnUrl('https://pddpic.com.evil.com/a.jpg', HOSTS)).toBe(false);
  });

  it('非 http(s) 协议拒绝', () => {
    expect(isAllowedCdnUrl('data:image/png;base64,AA', HOSTS)).toBe(false);
    expect(isAllowedCdnUrl('blob:https://img.pddpic.com/1', HOSTS)).toBe(false);
    expect(isAllowedCdnUrl('ftp://img.pddpic.com/a.jpg', HOSTS)).toBe(false);
  });

  it('非法 URL 拒绝而不抛异常', () => {
    expect(isAllowedCdnUrl('不是地址', HOSTS)).toBe(false);
    expect(isAllowedCdnUrl('', HOSTS)).toBe(false);
  });
});

describe('allowedUrls', () => {
  it('规范化 + 白名单 + 去重 + 保序', () => {
    expect(
      allowedUrls(
        [
          '//img.pddpic.com/a.jpg',
          'https://img.pddpic.com/a.jpg',
          'https://evil.com/x.jpg',
          'http://funimg.pddpic.com/b.jpg',
        ],
        HOSTS,
      ),
    ).toEqual(['https://img.pddpic.com/a.jpg', 'https://funimg.pddpic.com/b.jpg']);
  });

  it('可以传 base 解析相对地址', () => {
    expect(allowedUrls(['/img/a.jpg'], HOSTS, 'https://mobile.yangkeduo.com/goods.html')).toEqual([
      'https://mobile.yangkeduo.com/img/a.jpg',
    ]);
  });
});
