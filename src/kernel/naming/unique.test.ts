import { describe, expect, it } from 'vitest';
import { splitExt, uniqueFileName, uniqueName } from './unique';

describe('uniqueName（§9.2）', () => {
  it('不冲突时原样返回', () => {
    expect(uniqueName('连衣裙_1', [])).toBe('连衣裙_1');
    expect(uniqueName('连衣裙_1', ['别的'])).toBe('连衣裙_1');
  });

  it('冲突时追加 (2)、(3)', () => {
    expect(uniqueName('连衣裙_1', ['连衣裙_1'])).toBe('连衣裙_1 (2)');
    expect(uniqueName('连衣裙_1', ['连衣裙_1', '连衣裙_1 (2)'])).toBe('连衣裙_1 (3)');
  });

  it('大小写不敏感比较', () => {
    expect(uniqueName('Main', ['main'])).toBe('Main (2)');
    expect(uniqueName('ABC', ['abc', 'Abc (2)'])).toBe('ABC (3)');
  });

  it('扩展名保持在最后', () => {
    expect(uniqueName('01.jpg', ['01.jpg'])).toBe('01 (2).jpg');
  });

  it('隐藏文件整体当主体', () => {
    expect(uniqueName('.ecbox.json', ['.ecbox.json'])).toBe('.ecbox (2).json');
  });
});

describe('uniqueFileName', () => {
  it('序号插在扩展名之前', () => {
    expect(uniqueFileName('01', 'jpg', ['01.jpg'])).toBe('01 (2).jpg');
  });

  it('扩展名带不带点都行', () => {
    expect(uniqueFileName('01', '.jpg', ['01.jpg'])).toBe('01 (2).jpg');
  });

  it('没有扩展名时不补点', () => {
    expect(uniqueFileName('视频', '', ['视频'])).toBe('视频 (2)');
  });
});

describe('splitExt', () => {
  it('拆出主体和扩展名', () => {
    expect(splitExt('01.jpg')).toEqual({ stem: '01', ext: '.jpg' });
    expect(splitExt('没有扩展名')).toEqual({ stem: '没有扩展名', ext: '' });
    expect(splitExt('.ecbox.json')).toEqual({ stem: '.ecbox', ext: '.json' });
    expect(splitExt('.gitignore')).toEqual({ stem: '.gitignore', ext: '' });
  });
});
