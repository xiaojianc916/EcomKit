import { describe, expect, it } from 'vitest';
import type { ProductSnapshot } from '../../kernel/model/product';
import { buildInfoTxt, CRLF, infoTxtBytes, UTF8_BOM } from './info-txt';

const AT = new Date(2026, 10, 5, 9, 0).getTime();

function snapshot(patch: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    platform: 'pinduoduo',
    pageKind: 'pdd.goods',
    productId: '482319937501',
    title: '夏季新款显瘦连衣裙女小个子法式复古方领泡泡袖碎花裙',
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=482319937501',
    skus: [],
    assets: [],
    sources: ['ssr'],
    completeness: 'full',
    capturedAt: AT,
    ...patch,
  };
}

describe('buildInfoTxt（§9.12）', () => {
  it('以 UTF-8 BOM 开头', () => {
    expect(buildInfoTxt({ snapshot: snapshot(), at: AT }).startsWith(UTF8_BOM)).toBe(true);
  });

  it('换行一律 CRLF，没有裸 LF', () => {
    const text = buildInfoTxt({
      snapshot: snapshot({ shopName: '某某旗舰店', price: '¥129' }),
      at: AT,
    });
    expect(text).not.toMatch(/[^\r]\n/);
    expect(text.includes(CRLF)).toBe(true);
  });

  it('包含标题、ID、链接、店铺、价格、下载时间', () => {
    const text = buildInfoTxt({
      snapshot: snapshot({ shopName: '某某旗舰店', price: '¥129' }),
      at: AT,
    });
    expect(text).toContain('标题：夏季新款显瘦连衣裙女小个子法式复古方领泡泡袖碎花裙');
    expect(text).toContain('商品 ID：482319937501');
    expect(text).toContain('链接：https://mobile.yangkeduo.com/goods.html?goods_id=482319937501');
    expect(text).toContain('店铺：某某旗舰店');
    expect(text).toContain('价格：¥129');
    expect(text).toContain('下载时间：11月5日 09:00');
  });

  it('缺失的字段整行省略，不留空冒号', () => {
    const text = buildInfoTxt({ snapshot: snapshot(), at: AT });
    expect(text).not.toContain('店铺：');
    expect(text).not.toContain('价格：');
  });

  it('有 SKU 时输出 SKU 表，含规格、价格、库存', () => {
    const text = buildInfoTxt({
      snapshot: snapshot({
        skus: [
          {
            id: '1',
            specs: [
              { name: '颜色', value: '杏色' },
              { name: '尺码', value: 'M' },
            ],
            price: '¥129',
            stock: 12,
          },
          { id: '2', specs: [{ name: '颜色', value: '黑色' }] },
        ],
      }),
      at: AT,
    });
    expect(text).toContain('SKU 表（规格 / 价格 / 库存）');
    expect(text).toContain('颜色=杏色 尺码=M\t¥129\t12');
    expect(text).toContain('颜色=黑色\r\n');
  });

  it('SKU 没有规格时占位 -', () => {
    const text = buildInfoTxt({
      snapshot: snapshot({ skus: [{ id: '1', specs: [] }] }),
      at: AT,
    });
    expect(text).toContain('-');
  });

  it('infoTxtBytes 和文本的 UTF-8 编码一致（含 BOM 3 字节）', () => {
    const text = buildInfoTxt({ snapshot: snapshot(), at: AT });
    const bytes = infoTxtBytes(text);
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    expect(bytes.length).toBe(new TextEncoder().encode(text).length);
  });
});
