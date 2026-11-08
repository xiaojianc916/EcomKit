import { describe, expect, it } from 'vitest';
import { formatBytes, formatCount } from './format';

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

describe('formatCount', () => {
  it('用斜杠连接', () => {
    expect(formatCount(23, 48)).toBe('23/48');
    expect(formatCount(3, 26)).toBe('3/26');
  });
});
