import { describe, expect, it } from 'vitest';
import {
  countGraphemes,
  FALLBACK_NAME,
  NAME_LIMITS,
  nameKey,
  needsSanitizing,
  sanitizeName,
  truncateGraphemes,
} from './sanitize';

describe('sanitizeName（§9.2）', () => {
  it('把 Windows 非法字符换成全角', () => {
    expect(sanitizeName('a/b\\c:d*e?f"g<h>i|j')).toBe('a／b＼c：d＊e？f＂g＜h＞i｜j');
  });

  it('SKU 规格里的斜杠保持可读（红色/XL → 红色／XL）', () => {
    expect(sanitizeName('红色/XL')).toBe('红色／XL');
  });

  it('移除控制符和零宽字符', () => {
    expect(sanitizeName('连\u0000衣\u200B裙\uFEFF')).toBe('连衣裙');
  });

  it('换行变空格，不会把两段名字粘在一起', () => {
    expect(sanitizeName('夏季\n连衣裙')).toBe('夏季 连衣裙');
  });

  it('去掉仅由符号和空白组成的空括号', () => {
    expect(sanitizeName('【】连衣裙')).toBe('连衣裙');
    expect(sanitizeName('连衣裙「」')).toBe('连衣裙');
    expect(sanitizeName('连衣裙（）')).toBe('连衣裙');
    expect(sanitizeName('（ ）连衣裙')).toBe('连衣裙');
    expect(sanitizeName('连衣裙()')).toBe('连衣裙');
  });

  it('括号里有内容时原样保留', () => {
    expect(sanitizeName('连衣裙（杏色）')).toBe('连衣裙（杏色）');
    expect(sanitizeName('夏季【爆款】连衣裙')).toBe('夏季【爆款】连衣裙');
  });

  it('嵌套的空括号一层层剥掉', () => {
    expect(sanitizeName('【「」】连衣裙')).toBe('连衣裙');
  });

  it('连续分隔符合并成一个', () => {
    expect(sanitizeName('a--b__c｜｜d')).toBe('a-b_c｜d');
    expect(sanitizeName('a-_-b')).toBe('a-b');
  });

  it('去掉末尾的点和空格', () => {
    expect(sanitizeName('连衣裙...')).toBe('连衣裙');
    expect(sanitizeName('连衣裙   ')).toBe('连衣裙');
    expect(sanitizeName('连衣裙 . .')).toBe('连衣裙');
  });

  it('按字素截断，不切开 emoji', () => {
    expect(sanitizeName('连衣裙👗夏季款', { maxLength: 3 })).toBe('连衣裙');
    expect(sanitizeName('👗👗👗👗', { maxLength: 2 })).toBe('👗👗');
  });

  it('截断后再清一次末尾的点和空格', () => {
    expect(sanitizeName('连衣裙。夏季款', { maxLength: 3 })).toBe('连衣裙');
  });

  it('规避 Windows 保留名', () => {
    expect(sanitizeName('CON')).toBe('_CON');
    expect(sanitizeName('con')).toBe('_con');
    expect(sanitizeName('NUL.txt')).toBe('_NUL.txt');
    expect(sanitizeName('com1')).toBe('_com1');
    expect(sanitizeName('LPT9')).toBe('_LPT9');
    // 保留名以外的不动
    expect(sanitizeName('CONSOLE')).toBe('CONSOLE');
    expect(sanitizeName('COM10')).toBe('COM10');
  });

  it('清洗后为空时给占位名', () => {
    expect(sanitizeName('')).toBe(FALLBACK_NAME);
    expect(sanitizeName('   ')).toBe(FALLBACK_NAME);
    expect(sanitizeName('\u200B\u200C')).toBe(FALLBACK_NAME);
  });

  it('幂等：再洗一次结果不变', () => {
    for (const input of ['a/b:c', '【】连衣裙', 'CON', 'a--b', '   ', '连衣裙...', '👗👗']) {
      const once = sanitizeName(input, { maxLength: 5 });
      expect(sanitizeName(once, { maxLength: 5 })).toBe(once);
    }
  });

  it('按 §9.2 的长度上限截断', () => {
    const long = '一'.repeat(80);
    expect(countGraphemes(sanitizeName(long, { maxLength: NAME_LIMITS.folder }))).toBe(
      NAME_LIMITS.folder,
    );
  });
});

describe('countGraphemes / truncateGraphemes', () => {
  it('emoji 和组合字符各算一个字素', () => {
    expect(countGraphemes('👗')).toBe(1);
    expect(countGraphemes('e\u0301')).toBe(1);
    expect(countGraphemes('abc')).toBe(3);
  });

  it('截断到 0 返回空串', () => {
    expect(truncateGraphemes('abc', 0)).toBe('');
    expect(truncateGraphemes('abc', -1)).toBe('');
  });
});

describe('nameKey / needsSanitizing', () => {
  it('nameKey 大小写不敏感', () => {
    expect(nameKey('Main.JPG')).toBe(nameKey('main.jpg'));
  });

  it('需要清洗时返回 true', () => {
    expect(needsSanitizing('主图', 10)).toBe(false);
    expect(needsSanitizing('主/图', 10)).toBe(true);
    expect(needsSanitizing('一'.repeat(11), 10)).toBe(true);
  });
});
