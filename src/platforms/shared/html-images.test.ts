import { describe, expect, it } from 'vitest';
import { assetKeyFromUrl, extractImageUrls, htmlToDetailAssets } from './html-images';

describe('extractImageUrls', () => {
  it('按文档顺序取 img，而不是按属性分组顺序', () => {
    const html = `
      <div><img src="https://p3.douyinpic.com/a~c5_720x720.webp"></div>
      <p><img data-src="https://p3.douyinpic.com/b~c5_720x720.webp"></p>
      <img src="https://p6.douyinpic.com/c~c5_720x720.webp">
    `;
    expect(extractImageUrls(html)).toEqual([
      'https://p3.douyinpic.com/a~c5_720x720.webp',
      'https://p3.douyinpic.com/b~c5_720x720.webp',
      'https://p6.douyinpic.com/c~c5_720x720.webp',
    ]);
  });

  it('懒加载：src 是占位图时用 data-src', () => {
    const html =
      '<img src="data:image/gif;base64,R0lGOD" data-src="https://p9.douyinpic.com/x.webp">';
    expect(extractImageUrls(html)).toEqual(['https://p9.douyinpic.com/x.webp']);
  });

  it('同一张图不同参数只保留一次', () => {
    const html =
      '<img src="https://p3.douyinpic.com/a.webp?from=1"><img src="https://p3.douyinpic.com/a.webp?from=2">';
    expect(extractImageUrls(html)).toEqual(['https://p3.douyinpic.com/a.webp?from=1']);
  });

  it('空串和没有 img 都返回空数组', () => {
    expect(extractImageUrls('')).toEqual([]);
    expect(extractImageUrls('<div>没有图片</div>')).toEqual([]);
  });

  it('可以用 skipSrcPrefixes 过滤占位图前缀', () => {
    const html =
      '<img src="https://s1.douyinpic.com/placeholder.png"><img src="https://p3.douyinpic.com/real.png">';
    expect(extractImageUrls(html, { skipSrcPrefixes: ['https://s1.douyinpic.com/'] })).toEqual([
      'https://p3.douyinpic.com/real.png',
    ]);
  });
});

describe('htmlToDetailAssets', () => {
  it('生成 detail 素材，index 按文档顺序连续', () => {
    const html =
      '<img src="https://p3.douyinpic.com/a.webp"><img src="https://p3.douyinpic.com/b.webp">';
    const assets = htmlToDetailAssets(html);
    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({ kind: 'detail', index: 0 });
    expect(assets[1]).toMatchObject({ kind: 'detail', index: 1 });
  });

  it('startIndex 可以接在其他详情图后面继续编号', () => {
    const html = '<img src="https://p3.douyinpic.com/a.webp">';
    expect(htmlToDetailAssets(html, { startIndex: 5 })[0]?.index).toBe(5);
  });
});

describe('assetKeyFromUrl', () => {
  it('同一个路径不同参数 key 相同', () => {
    expect(assetKeyFromUrl('https://p3.douyinpic.com/a.webp?x=1')).toBe(
      assetKeyFromUrl('https://p3.douyinpic.com/a.webp?x=2'),
    );
  });

  it('不同域名 key 不同', () => {
    expect(assetKeyFromUrl('https://p3.douyinpic.com/a.webp')).not.toBe(
      assetKeyFromUrl('https://p6.douyinpic.com/a.webp'),
    );
  });

  it('非 URL 原样返回', () => {
    expect(assetKeyFromUrl('abc')).toBe('abc');
  });
});
