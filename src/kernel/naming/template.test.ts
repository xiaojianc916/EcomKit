import { describe, expect, it } from 'vitest';
import { EcError } from '../errors/ec-error';
import {
  collectTemplateVars,
  formatTemplateDate,
  renderProductFolderName,
  renderTemplate,
  validateTemplate,
} from './template';

const NOW = new Date(2026, 10, 5).getTime();

describe('renderTemplate（§9.1）', () => {
  it('渲染全部可用变量', () => {
    expect(
      renderTemplate('{platform}_{shop:3}_{title:5}_{id}_{date}', {
        platform: '拼多多',
        shop: '旗舰店',
        title: '夏季连衣裙',
        id: '482319937501',
        date: NOW,
      }),
    ).toBe('拼多多_旗舰店_夏季连衣裙_482319937501_20261105');
  });

  it('N 按字素截断', () => {
    expect(renderTemplate('{title:2}', { title: '👗👗👗' })).toBe('👗👗');
  });

  it('缺 {id} 时直接抛错', () => {
    expect(() => renderTemplate('{title}_{id}', { title: '连衣裙' })).toThrow(EcError);
    try {
      renderTemplate('{title}_{id}', { title: '连衣裙' });
    } catch (e) {
      expect(EcError.is(e) && e.code).toBe('INTERNAL');
    }
  });

  it('缺可选变量时该段变空，不留悬空的分隔符', () => {
    expect(renderTemplate('{title}_{shop}', { title: '连衣裙' })).toBe('连衣裙_');
  });

  it('未知变量原样保留', () => {
    expect(renderTemplate('{title}_{foo}', { title: '连衣裙' })).toBe('连衣裙_{foo}');
  });

  it('没有 :N 的限制时整段输出', () => {
    expect(renderTemplate('{title}', { title: '一'.repeat(60) })).toBe('一'.repeat(60));
  });
});

describe('formatTemplateDate', () => {
  it('输出紧凑的 YYYYMMDD 本地时间', () => {
    expect(formatTemplateDate(NOW)).toBe('20261105');
    expect(formatTemplateDate(new Date(2026, 0, 9))).toBe('20260109');
  });
});

describe('validateTemplate', () => {
  it('默认模板可用', () => {
    expect(validateTemplate('{title:30}_{id}')).toEqual([]);
  });

  it('缺 {id} 报错', () => {
    expect(validateTemplate('{title:30}')).toEqual([{ kind: 'missing-id', detail: '{id}' }]);
  });

  it('未知变量报错', () => {
    expect(validateTemplate('{title}_{id}_{foo}')).toEqual([
      { kind: 'unknown-var', detail: 'foo' },
    ]);
  });

  it('同时缺 {id} 和未知变量时两条都报', () => {
    expect(validateTemplate('{title}_{foo}')).toEqual([
      { kind: 'unknown-var', detail: 'foo' },
      { kind: 'missing-id', detail: '{id}' },
    ]);
  });

  it('长度 0 报错', () => {
    expect(validateTemplate('{title:0}_{id}')).toEqual([
      { kind: 'bad-length', detail: '{title:0}' },
    ]);
  });
});

describe('collectTemplateVars', () => {
  it('去重且保持出现顺序', () => {
    expect(collectTemplateVars('{id}_{title:3}_{id}')).toEqual(['id', 'title']);
  });
});

describe('renderProductFolderName', () => {
  it('渲染并清洗', () => {
    expect(
      renderProductFolderName('{title:30}_{id}', {
        title: '夏季新款/显瘦连衣裙【】',
        id: '482319937501',
      }),
    ).toBe('夏季新款／显瘦连衣裙_482319937501');
  });

  it('商品文件夹不超过 50 字素', () => {
    const name = renderProductFolderName('{title}_{id}', {
      title: '一'.repeat(80),
      id: '482319937501',
    });
    expect(name.length).toBeLessThanOrEqual(50);
  });

  it('模板缺 {id} 时抛错', () => {
    expect(() => renderProductFolderName('{title}', { title: '连衣裙', id: '1' })).toThrow(EcError);
  });
});
