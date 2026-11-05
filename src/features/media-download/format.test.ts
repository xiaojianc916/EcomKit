import { describe, expect, it } from 'vitest';
import { formatBytes, formatCount, formatDateTime, formatDuration } from './format';

describe('formatBytes', () => {
  it('小于 1KB 用字节', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('KB 取整', () => {
    expect(formatBytes(1024 * 12)).toBe('12 KB');
    expect(formatBytes(1024 * 12.4)).toBe('12 KB');
  });

  it('MB 保留一位小数且整数不带 .0', () => {
    expect(formatBytes(4.1 * 1024 * 1024)).toBe('4.1 MB');
    expect(formatBytes(12.4 * 1024 * 1024)).toBe('12.4 MB');
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB');
  });

  it('GB 保留一位小数', () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });
});

describe('formatDuration', () => {
  it('毫秒级给“不到 1 秒”', () => {
    expect(formatDuration(0)).toBe('0 秒');
    expect(formatDuration(320)).toBe('不到 1 秒');
  });

  it('秒级保留一位小数', () => {
    expect(formatDuration(3200)).toBe('3.2 秒');
    expect(formatDuration(12_000)).toBe('12 秒');
  });

  it('超过一分钟用“分 秒”', () => {
    expect(formatDuration(65_000)).toBe('1 分 5 秒');
    expect(formatDuration(120_000)).toBe('2 分');
  });
});

describe('formatDateTime', () => {
  it('同年只显示月日和时分', () => {
    const now = new Date(2026, 10, 5, 9, 0).getTime();
    const at = new Date(2026, 10, 3, 14, 20).getTime();
    expect(formatDateTime(at, now)).toBe('11月3日 14:20');
  });

  it('跨年带年份', () => {
    const now = new Date(2026, 0, 5, 9, 0).getTime();
    const at = new Date(2025, 10, 3, 14, 20).getTime();
    expect(formatDateTime(at, now)).toBe('2025年11月3日 14:20');
  });

  it('个位小时补零', () => {
    const now = new Date(2026, 10, 5, 9, 0).getTime();
    const at = new Date(2026, 10, 3, 8, 5).getTime();
    expect(formatDateTime(at, now)).toBe('11月3日 08:05');
  });
});

describe('formatCount', () => {
  it('用斜杠连接', () => {
    expect(formatCount(23, 48)).toBe('23/48');
    expect(formatCount(3, 26)).toBe('3/26');
  });
});
