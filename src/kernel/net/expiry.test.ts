import { describe, expect, it } from 'vitest';
import { describeExpiry, expiryRemaining, isExpired, parseExpiry } from './expiry';

const NOW = 1_793_000_000_000; // 2026-10-xx，测试里固定时间

describe('parseExpiry', () => {
  it('解析 x-expires（秒）', () => {
    expect(parseExpiry(`https://v.douyinvod.com/a.mp4?x-expires=${Math.floor(NOW / 1000)}`)).toBe(
      Math.floor(NOW / 1000) * 1000,
    );
  });

  it('解析 expires（毫秒）', () => {
    expect(parseExpiry(`https://cdn.example.com/a.jpg?expires=${NOW}`)).toBe(NOW);
  });

  it('解析大写 Expires', () => {
    expect(parseExpiry(`https://cdn.example.com/a.jpg?Expires=${NOW}`)).toBe(NOW);
  });

  it('解析 e=（十六进制）', () => {
    const hex = NOW.toString(16);
    expect(parseExpiry(`https://cdn.example.com/a.mp4?e=${hex}`)).toBe(NOW);
  });

  it('解析 x-expiration', () => {
    expect(parseExpiry(`https://cdn.example.com/a.mp4?x-expiration=${NOW}`)).toBe(NOW);
  });

  it('解析 timestamp', () => {
    expect(parseExpiry(`https://cdn.example.com/a.mp4?timestamp=${NOW}`)).toBe(NOW);
  });

  it('没有过期参数返回 null', () => {
    expect(parseExpiry('https://cdn.example.com/a.jpg?imageMogr2/thumbnail/200x')).toBeNull();
    expect(parseExpiry('https://cdn.example.com/a.jpg')).toBeNull();
  });

  it('参数值不是时间戳时返回 null（不会把序号当时间）', () => {
    expect(parseExpiry('https://cdn.example.com/a.jpg?e=1')).toBeNull();
    expect(parseExpiry('https://cdn.example.com/a.jpg?e=abc')).toBeNull();
    expect(parseExpiry('https://cdn.example.com/a.jpg?e=')).toBeNull();
  });

  it('非法 URL 返回 null 而不是抛错', () => {
    expect(parseExpiry('not a url')).toBeNull();
  });

  it('hash 里的参数也看', () => {
    expect(parseExpiry(`https://cdn.example.com/a.mp4#x-expires=${NOW}`)).toBe(NOW);
  });

  it('多个参数时按候选顺序取第一个命中的', () => {
    const url = `https://cdn.example.com/a.mp4?x-expires=${Math.floor(NOW / 1000)}&timestamp=${NOW + 1000}`;
    expect(parseExpiry(url)).toBe(Math.floor(NOW / 1000) * 1000);
  });
});

describe('isExpired', () => {
  it('已过期返回 true', () => {
    expect(isExpired(`https://c.com/a.mp4?expires=${NOW - 120_000}`, 60_000, NOW)).toBe(true);
  });

  it('留 60 秒余量：剩 30 秒算过期', () => {
    expect(isExpired(`https://c.com/a.mp4?expires=${NOW + 30_000}`, 60_000, NOW)).toBe(true);
  });

  it('剩 5 分钟不算过期', () => {
    expect(isExpired(`https://c.com/a.mp4?expires=${NOW + 300_000}`, 60_000, NOW)).toBe(false);
  });

  it('没有过期参数时永远不算过期', () => {
    expect(isExpired('https://c.com/a.jpg', 60_000, NOW)).toBe(false);
  });
});

describe('expiryRemaining / describeExpiry', () => {
  it('返回剩余毫秒', () => {
    expect(expiryRemaining(`https://c.com/a.mp4?expires=${NOW + 5000}`, NOW)).toBe(5000);
    expect(expiryRemaining('https://c.com/a.mp4', NOW)).toBeNull();
  });

  it('描述文案带数量（§10.7）', () => {
    expect(describeExpiry(`https://c.com/a.mp4?expires=${NOW + 120_000}`, NOW)).toBe(
      '还剩 120 秒过期',
    );
    expect(describeExpiry(`https://c.com/a.mp4?expires=${NOW - 60_000}`, NOW)).toBe('已过期 60 秒');
    expect(describeExpiry('https://c.com/a.mp4', NOW)).toBe('无过期参数');
  });
});
