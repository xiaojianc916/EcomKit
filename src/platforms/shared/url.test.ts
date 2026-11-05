import { describe, expect, it } from 'vitest';
import { normalizeUrl, normalizeUrls, pickUrlLike } from './url';

describe('normalizeUrl', () => {
  it('把 JSON 里被转义的斜杠还原', () => {
    expect(normalizeUrl('https:\\/\\/img.pddpic.com\\/a.jpg')).toBe('https://img.pddpic.com/a.jpg');
  });

  it('协议相对地址补 https', () => {
    expect(normalizeUrl('//p3.douyinpic.com/a.webp')).toBe('https://p3.douyinpic.com/a.webp');
  });

  it('http 升级成 https', () => {
    expect(normalizeUrl('http://img.pddpic.com/a.jpg')).toBe('https://img.pddpic.com/a.jpg');
  });

  it('相对地址按 base 解析，没有 base 就丢弃', () => {
    expect(normalizeUrl('/img/a.jpg', { base: 'https://mobile.yangkeduo.com/goods.html' })).toBe(
      'https://mobile.yangkeduo.com/img/a.jpg',
    );
    expect(normalizeUrl('/img/a.jpg')).toBeUndefined();
  });

  it('data: / blob: / javascript: / 空串直接丢弃', () => {
    expect(normalizeUrl('data:image/png;base64,AA')).toBeUndefined();
    expect(normalizeUrl('blob:https://x/1')).toBeUndefined();
    expect(normalizeUrl('javascript:void(0)')).toBeUndefined();
    expect(normalizeUrl('   ')).toBeUndefined();
  });
});

describe('normalizeUrls', () => {
  it('规范化 + 去重 + 保序', () => {
    expect(
      normalizeUrls([
        'https://a.com/1.jpg',
        '//a.com/1.jpg',
        'http://b.com/2.jpg',
        'data:image/png;base64,AA',
      ]),
    ).toEqual(['https://a.com/1.jpg', 'https://b.com/2.jpg']);
  });
});

describe('pickUrlLike', () => {
  it('字符串直接用', () => {
    expect(pickUrlLike('https://a.com/1.jpg', ['url'])).toBe('https://a.com/1.jpg');
  });

  it('对象按候选字段取第一个非空', () => {
    expect(pickUrlLike({ url: '', thumbUrl: 'https://a.com/t.jpg' }, ['url', 'thumbUrl'])).toBe(
      'https://a.com/t.jpg',
    );
  });

  it('非字符串非对象返回 undefined', () => {
    expect(pickUrlLike(42, ['url'])).toBeUndefined();
    expect(pickUrlLike(null, ['url'])).toBeUndefined();
  });
});
