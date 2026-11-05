import { describe, expect, it } from 'vitest';
import {
  findPddRoots,
  isNeedLogin,
  normalizeImageLike,
  normalizeImageList,
  normalizeSkuLike,
  normalizeVideoLike,
  normalizeVideoList,
  pickGoodsId,
} from './schema';

describe('isNeedLogin', () => {
  it('Phase 0 真实样本：rawData.store.initDataObj = { needLogin: true }', () => {
    expect(isNeedLogin({ store: { initDataObj: { needLogin: true } } })).toBe(true);
  });

  it('needLogin 在顶层也能识别', () => {
    expect(isNeedLogin({ needLogin: true })).toBe(true);
    expect(isNeedLogin({ store: { needLogin: 'true' } })).toBe(true);
  });

  it('登录后 needLogin 消失或为 false 时返回 false', () => {
    expect(isNeedLogin({ store: { initDataObj: { goods: {} } } })).toBe(false);
    expect(isNeedLogin({ store: { initDataObj: { needLogin: false } } })).toBe(false);
    expect(isNeedLogin(null)).toBe(false);
    expect(isNeedLogin('不是对象')).toBe(false);
  });
});

describe('findPddRoots', () => {
  it('从 store.initDataObj 里取 goods / mall', () => {
    const payload = {
      store: { initDataObj: { goods: { goodsName: 'T' }, mall: { mallName: 'M' } } },
    };
    const roots = findPddRoots(payload);
    expect(roots?.goods).toEqual({ goodsName: 'T' });
    expect(roots?.mall).toEqual({ mallName: 'M' });
  });

  it('信封本身就是 goods 时也能识别', () => {
    const roots = findPddRoots({ goodsName: '直接就是商品', topGallery: [] });
    expect(roots?.goods).toMatchObject({ goodsName: '直接就是商品' });
  });

  it('data.result 这类接口信封也能识别', () => {
    const payload = { result: { goods_detail: { goodsName: '接口商品' } } };
    expect(findPddRoots(payload)?.goods).toMatchObject({ goodsName: '接口商品' });
  });

  it('没有商品数据返回 null', () => {
    expect(findPddRoots({})).toBeNull();
    expect(findPddRoots({ store: { initDataObj: { needLogin: true } } })).toBeNull();
    expect(findPddRoots(null)).toBeNull();
    expect(findPddRoots('x')).toBeNull();
  });
});

describe('normalizeImageLike', () => {
  it('字符串直接当 url', () => {
    expect(normalizeImageLike('https://img.pddpic.com/a.jpg')).toEqual({
      url: 'https://img.pddpic.com/a.jpg',
    });
  });

  it('对象按候选字段取 url，并带上宽高', () => {
    expect(
      normalizeImageLike({ thumbUrl: 'https://img.pddpic.com/a.jpg', width: 800, height: 800 }),
    ).toEqual({ url: 'https://img.pddpic.com/a.jpg', width: 800, height: 800 });
  });

  it('宽高是字符串时也接受', () => {
    expect(normalizeImageLike({ url: 'https://a.com/1.jpg', w: '400', h: '300' })).toEqual({
      url: 'https://a.com/1.jpg',
      width: 400,
      height: 300,
    });
  });

  it('拿不到 url 返回 null', () => {
    expect(normalizeImageLike({})).toBeNull();
    expect(normalizeImageLike({ url: '  ' })).toBeNull();
    expect(normalizeImageLike(42)).toBeNull();
    expect(normalizeImageLike('')).toBeNull();
  });

  it('列表里坏元素被跳过，不影响其他图片', () => {
    expect(normalizeImageList(['https://a.com/1.jpg', null, {}, 'https://a.com/2.jpg'])).toEqual([
      { url: 'https://a.com/1.jpg' },
      { url: 'https://a.com/2.jpg' },
    ]);
  });
});

describe('normalizeVideoLike', () => {
  it('字符串地址：按地址猜编码', () => {
    expect(normalizeVideoLike('https://v.pddpic.com/a.mp4')).toEqual({
      url: 'https://v.pddpic.com/a.mp4',
      codec: 'unknown',
    });
  });

  it('对象：videoUrl + coverUrl', () => {
    const video = normalizeVideoLike({
      videoUrl: 'https://v.pddpic.com/a.mp4',
      coverUrl: 'https://img.pddpic.com/cover.jpg',
      width: 1080,
      height: 1920,
      duration: 15,
    });
    expect(video).toMatchObject({
      url: 'https://v.pddpic.com/a.mp4',
      cover: 'https://img.pddpic.com/cover.jpg',
      width: 1080,
      height: 1920,
      duration: 15,
    });
  });

  it('codec 字段优先于地址猜测', () => {
    expect(normalizeVideoLike({ url: 'https://v.pddpic.com/a.mp4', codec: 'h265' })?.codec).toBe(
      'h265',
    );
  });

  it('拿不到 url 返回 null，列表里坏元素跳过', () => {
    expect(normalizeVideoLike({ cover: 'x' })).toBeNull();
    expect(normalizeVideoList([null, { url: 'https://v.pddpic.com/a.mp4' }])).toHaveLength(1);
  });
});

describe('normalizeSkuLike', () => {
  it('spec_key / spec_value 写法', () => {
    const sku = normalizeSkuLike(
      {
        skuId: 123,
        thumbUrl: 'https://img.pddpic.com/sku.jpg',
        specs: [{ spec_key: '颜色', spec_value: '杏色' }],
      },
      0,
    );
    expect(sku).toMatchObject({
      id: '123',
      imageUrl: 'https://img.pddpic.com/sku.jpg',
      specs: [{ name: '颜色', value: '杏色' }],
    });
  });

  it('specKey / specValue 写法也能识别', () => {
    const sku = normalizeSkuLike({ id: 's1', specs: [{ specKey: '尺码', specValue: 'M' }] }, 0);
    expect(sku?.specs).toEqual([{ name: '尺码', value: 'M' }]);
  });

  it('价格按分转成元', () => {
    const sku = normalizeSkuLike({ id: 's1', groupPrice: 1290 }, 0);
    expect(sku?.price).toBe('¥12.90');
  });

  it('没有 id 时用下标兜底', () => {
    expect(normalizeSkuLike({ specs: [] }, 3)?.id).toBe('sku-3');
  });

  it('非对象返回 null', () => {
    expect(normalizeSkuLike(null, 0)).toBeNull();
    expect(normalizeSkuLike('x', 0)).toBeNull();
  });
});

describe('pickGoodsId', () => {
  it('多种字段写法都能取到', () => {
    expect(pickGoodsId({ goodsId: 482319937501 })).toBe('482319937501');
    expect(pickGoodsId({ goods_id: '482319937501' })).toBe('482319937501');
    expect(pickGoodsId({ goods: { goodsId: 482319937501 } })).toBe('482319937501');
    expect(pickGoodsId({})).toBeUndefined();
  });
});
