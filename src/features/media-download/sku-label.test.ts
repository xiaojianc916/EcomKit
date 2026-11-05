import { describe, expect, it } from 'vitest';
import type { Sku } from '../../kernel/model/product';
import { skuLabel, skuLabelsByImageKey } from './sku-label';

function sku(id: string, specs: [string, string][], imageKey?: string): Sku {
  return {
    id,
    specs: specs.map(([name, value]) => ({ name, value })),
    ...(imageKey === undefined ? {} : { imageKey }),
  };
}

describe('skuLabel（§9.1 共同规格值）', () => {
  it('尺码不同、颜色相同 → 只取颜色', () => {
    const group = [
      sku('1', [
        ['颜色', '杏色'],
        ['尺码', 'S'],
      ]),
      sku('2', [
        ['颜色', '杏色'],
        ['尺码', 'M'],
      ]),
      sku('3', [
        ['颜色', '杏色'],
        ['尺码', 'L'],
      ]),
    ];
    expect(skuLabel(group)).toBe('杏色');
  });

  it('多个维度都相同 → 全部保留，用 - 连接', () => {
    const group = [
      sku('1', [
        ['颜色', '黑色'],
        ['尺码', 'M'],
      ]),
      sku('2', [
        ['颜色', '黑色'],
        ['尺码', 'M'],
      ]),
    ];
    expect(skuLabel(group)).toBe('黑色-M');
  });

  it('没有共同规格 → 第一个 SKU 的全部规格用 - 连接', () => {
    const group = [
      sku('1', [
        ['颜色', '杏色'],
        ['尺码', 'S'],
      ]),
      sku('2', [
        ['颜色', '黑色'],
        ['尺码', 'M'],
      ]),
    ];
    expect(skuLabel(group)).toBe('杏色-S');
  });

  it('只有一个 SKU → 它的全部规格', () => {
    expect(
      skuLabel([
        sku('1', [
          ['颜色', '白色'],
          ['尺码', 'XL'],
        ]),
      ]),
    ).toBe('白色-XL');
  });

  it('规格值里的 / 保持原样（清洗在 kernel/naming 做）', () => {
    expect(skuLabel([sku('1', [['颜色', '红色/XL']])])).toBe('红色/XL');
  });

  it('某个 SKU 缺维度时不认为是共同规格', () => {
    const group = [
      sku('1', [['颜色', '杏色']]),
      sku('2', [
        ['颜色', '杏色'],
        ['尺码', 'M'],
      ]),
    ];
    expect(skuLabel(group)).toBe('杏色');
  });

  it('大小写不敏感地判断共同值', () => {
    const group = [sku('1', [['颜色', 'Black']]), sku('2', [['颜色', 'black']])];
    expect(skuLabel(group)).toBe('Black');
  });

  it('空数组、无规格都给空串', () => {
    expect(skuLabel([])).toBe('');
    expect(skuLabel([sku('1', [])])).toBe('');
  });

  it('规格值为空白视为没有', () => {
    expect(skuLabel([sku('1', [['颜色', '  ']])])).toBe('');
  });
});

describe('skuLabelsByImageKey', () => {
  it('按 imageKey 分组后各算各的标签', () => {
    const skus = [
      sku(
        '1',
        [
          ['颜色', '杏色'],
          ['尺码', 'S'],
        ],
        'img-a',
      ),
      sku(
        '2',
        [
          ['颜色', '杏色'],
          ['尺码', 'M'],
        ],
        'img-a',
      ),
      sku('3', [['颜色', '黑色']], 'img-b'),
    ];
    const labels = skuLabelsByImageKey(skus);
    expect(labels.get('img-a')).toBe('杏色');
    expect(labels.get('img-b')).toBe('黑色');
  });

  it('没有 imageKey 的 SKU 不进结果', () => {
    const labels = skuLabelsByImageKey([sku('1', [['颜色', '杏色']])]);
    expect(labels.size).toBe(0);
  });

  it('标签算出来是空串时不写进结果', () => {
    const labels = skuLabelsByImageKey([sku('1', [], 'img-a')]);
    expect(labels.has('img-a')).toBe(false);
  });
});
