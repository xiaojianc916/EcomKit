import { describe, expect, it } from 'vitest';
import {
  firstNonEmpty,
  isEmptyValue,
  readArray,
  readNumber,
  readPath,
  readString,
  readStrings,
} from './read-path';

describe('readPath', () => {
  const root = {
    store: {
      initDataObj: { needLogin: true, goods: { goodsName: '连衣裙', topGallery: [{ url: 'a' }] } },
    },
    list: [{ v: 1 }, { v: 2 }],
  };

  it('按点号逐级读取', () => {
    expect(readPath(root, 'store.initDataObj.goods.goodsName')).toBe('连衣裙');
  });

  it('支持数组下标', () => {
    expect(readPath(root, 'store.initDataObj.goods.topGallery[0].url')).toBe('a');
    expect(readPath(root, 'list[1].v')).toBe(2);
  });

  it('路径不存在返回 undefined，不抛异常', () => {
    expect(readPath(root, 'store.nope.deep')).toBeUndefined();
    expect(readPath(root, 'list[9].v')).toBeUndefined();
    expect(readPath(null, 'a.b')).toBeUndefined();
    expect(readPath(root, 'store.initDataObj.goods.goodsName.x')).toBeUndefined();
  });
});

describe('isEmptyValue', () => {
  it('null / undefined / 空白串 / NaN / 空数组算空', () => {
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue(undefined)).toBe(true);
    expect(isEmptyValue('   ')).toBe(true);
    expect(isEmptyValue(Number.NaN)).toBe(true);
    expect(isEmptyValue([])).toBe(true);
  });

  it('0 / false / 非空串不算空（价格 0 元是合法值）', () => {
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue(false)).toBe(false);
    expect(isEmptyValue('0')).toBe(false);
  });
});

describe('firstNonEmpty', () => {
  it('取第一个命中的候选路径', () => {
    const root = { a: { b: '' }, c: { d: '命中' }, e: { f: '也命中' } };
    expect(firstNonEmpty(root, ['a.b', 'c.d', 'e.f'])).toBe('命中');
  });

  it('全部落空返回 undefined', () => {
    expect(firstNonEmpty({}, ['a', 'b.c'])).toBeUndefined();
  });
});

describe('readString / readNumber / readArray / readStrings', () => {
  it('字符串候选：数字转字符串，空白丢弃', () => {
    const root = { id: 482319937501, name: '  ', name2: ' 标题 ' };
    expect(readString(root, ['name', 'name2'])).toBe('标题');
    expect(readString(root, ['id'])).toBe('482319937501');
    expect(readString(root, ['missing'])).toBeUndefined();
  });

  it('数字候选：接受数字字符串', () => {
    expect(readNumber({ w: '1093' }, ['w'])).toBe(1093);
    expect(readNumber({ w: 'abc' }, ['w'])).toBeUndefined();
  });

  it('数组候选：非数组返回空数组', () => {
    expect(readArray({ list: [1, 2] }, ['list'])).toEqual([1, 2]);
    expect(readArray({ list: 'x' }, ['list'])).toEqual([]);
    expect(readArray({}, ['list'])).toEqual([]);
  });

  it('字符串数组候选：类型混杂时只保留字符串和数字', () => {
    expect(readStrings({ a: ['x', 2, null, { u: 1 }] }, ['a'])).toEqual(['x', '2']);
    expect(readStrings({ a: 'only' }, ['a'])).toEqual(['only']);
  });
});
