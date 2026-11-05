import { describe, expect, it } from 'vitest';
import {
  originalImageCandidates,
  originalImageUrl,
  stripProcessingParams,
  thumbnailUrl,
  toPddImageAsset,
} from './media';

describe('stripProcessingParams', () => {
  it('去掉 imageView2 / imageMogr2 参数，保留其他参数', () => {
    const out = stripProcessingParams(
      new URL('https://img.pddpic.com/a.jpg?imageView2/2/w/200/q/80&from=abc'),
    );
    expect(out.toString()).toBe('https://img.pddpic.com/a.jpg?from=abc');
  });

  it('只剩处理参数时得到干净的原图地址', () => {
    const out = stripProcessingParams(
      new URL('https://img.pddpic.com/a.jpg?imageMogr2/thumbnail/400x400'),
    );
    expect(out.toString()).toBe('https://img.pddpic.com/a.jpg');
  });

  it('参数名大小写不敏感', () => {
    const out = stripProcessingParams(new URL('https://img.pddpic.com/a.jpg?ImageView2/2/w/200'));
    expect(out.toString()).toBe('https://img.pddpic.com/a.jpg');
  });

  it('没有查询串时原样返回', () => {
    const out = stripProcessingParams(new URL('https://img.pddpic.com/a.jpg'));
    expect(out.toString()).toBe('https://img.pddpic.com/a.jpg');
  });

  it('不会误删名字相近但不相干的参数', () => {
    const out = stripProcessingParams(new URL('https://img.pddpic.com/a.jpg?imageWidth=2'));
    expect(out.toString()).toBe('https://img.pddpic.com/a.jpg?imageWidth=2');
  });
});

describe('originalImageUrl', () => {
  it('http 升级成 https，并去掉处理参数', () => {
    expect(originalImageUrl('http://img.pddpic.com/a.jpg?imageView2/2/w/200')).toBe(
      'https://img.pddpic.com/a.jpg',
    );
  });

  it('还原 JSON 转义斜杠后仍然能解析', () => {
    expect(originalImageUrl('https://img.pddpic.com/a.jpg')).toBe('https://img.pddpic.com/a.jpg');
  });

  it('不可用地址返回 undefined', () => {
    expect(originalImageUrl('data:image/png;base64,AA')).toBeUndefined();
    expect(originalImageUrl('')).toBeUndefined();
  });
});

describe('originalImageCandidates', () => {
  it('候选顺序是 [原图, 页面原始 URL]', () => {
    expect(originalImageCandidates('https://img.pddpic.com/a.jpg?imageView2/2/w/200')).toEqual([
      'https://img.pddpic.com/a.jpg',
      'https://img.pddpic.com/a.jpg?imageView2/2/w/200',
    ]);
  });

  it('原图和原始 URL 相同时只留一个', () => {
    expect(originalImageCandidates('https://img.pddpic.com/a.jpg')).toEqual([
      'https://img.pddpic.com/a.jpg',
    ]);
  });

  it('不可用地址返回空数组', () => {
    expect(originalImageCandidates('blob:https://x/1')).toEqual([]);
  });
});

describe('thumbnailUrl', () => {
  it('在原图地址上加 imageView2/2/w/200/q/80', () => {
    expect(thumbnailUrl('https://img.pddpic.com/a.jpg?imageView2/2/w/800')).toBe(
      'https://img.pddpic.com/a.jpg?imageView2/2/w/200/q/80',
    );
  });

  it('宽度可配置', () => {
    expect(thumbnailUrl('https://img.pddpic.com/a.jpg', 120)).toBe(
      'https://img.pddpic.com/a.jpg?imageView2/2/w/120/q/80',
    );
  });

  it('不可用地址返回 undefined', () => {
    expect(thumbnailUrl('data:image/png;base64,AA')).toBeUndefined();
  });
});

describe('toPddImageAsset', () => {
  it('生成 main 素材：key 用原图路径，preview 用小图', () => {
    const asset = toPddImageAsset(
      { url: 'https://img.pddpic.com/a.jpg?imageView2/2/w/800', width: 800, height: 800 },
      { kind: 'main', index: 0 },
    );
    expect(asset).toMatchObject({
      kind: 'main',
      index: 0,
      candidates: [
        'https://img.pddpic.com/a.jpg',
        'https://img.pddpic.com/a.jpg?imageView2/2/w/800',
      ],
      preview: 'https://img.pddpic.com/a.jpg?imageView2/2/w/200/q/80',
      width: 800,
      height: 800,
    });
  });

  it('label 为空串时不写这个字段', () => {
    const asset = toPddImageAsset(
      { url: 'https://img.pddpic.com/a.jpg' },
      { kind: 'sku', index: 1, label: '' },
    );
    expect(asset).not.toHaveProperty('label');
  });

  it('label 有值时写进去', () => {
    const asset = toPddImageAsset(
      { url: 'https://img.pddpic.com/a.jpg' },
      { kind: 'sku', index: 1, label: '杏色' },
    );
    expect(asset?.label).toBe('杏色');
  });

  it('地址不可用返回 null', () => {
    expect(
      toPddImageAsset({ url: 'data:image/png;base64,AA' }, { kind: 'main', index: 0 }),
    ).toBeNull();
  });
});
