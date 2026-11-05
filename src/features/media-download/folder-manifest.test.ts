import { describe, expect, it } from 'vitest';
import type { ProductSnapshot } from '../../kernel/model/product';
import {
  brokenManifestName,
  buildFolderManifest,
  MANIFEST_VERSION,
  mergeManifestFiles,
  parseFolderManifest,
  serializeFolderManifest,
  summarizeHistory,
} from './folder-manifest';

const AT = new Date(2026, 10, 5, 9, 0).getTime();

function snapshot(patch: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    platform: 'pinduoduo',
    pageKind: 'pdd.goods',
    productId: '482319937501',
    title: '夏季新款显瘦连衣裙',
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=482319937501',
    skus: [],
    assets: [],
    sources: ['ssr'],
    completeness: 'full',
    capturedAt: AT,
    ...patch,
  };
}

const VALID = {
  v: 1,
  platform: 'pinduoduo',
  productId: '482319937501',
  url: 'https://mobile.yangkeduo.com/goods.html?goods_id=482319937501',
  title: '夏季新款显瘦连衣裙',
  updatedAt: AT,
  files: { 'main:a': { path: '主图/01.jpg', size: 183402, at: AT } },
};

describe('parseFolderManifest（§9.11）', () => {
  it('结构正确时解析成功', () => {
    const result = parseFolderManifest(JSON.stringify(VALID));
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.manifest.files['main:a']?.size).toBe(183402);
  });

  it('空内容视为损坏', () => {
    expect(parseFolderManifest(null).kind).toBe('broken');
    expect(parseFolderManifest('   ').kind).toBe('broken');
  });

  it('非法 JSON 视为损坏', () => {
    const result = parseFolderManifest('{ not json');
    expect(result).toEqual({ kind: 'broken', reason: 'invalid-json' });
  });

  it('结构不对视为损坏', () => {
    const result = parseFolderManifest(JSON.stringify({ ...VALID, files: { a: { path: '' } } }));
    expect(result).toEqual({ kind: 'broken', reason: 'schema' });
  });

  it('版本号对不上视为需要迁移（当前当损坏处理）', () => {
    const result = parseFolderManifest(JSON.stringify({ ...VALID, v: 99 }));
    expect(result).toEqual({ kind: 'broken', reason: 'unsupported-version:99' });
  });
});

describe('brokenManifestName（§9.11 改名保留现场）', () => {
  it('生成 .ecbox.broken-<时间>.json', () => {
    expect(brokenManifestName(new Date(2026, 10, 5, 9, 7, 3).getTime())).toBe(
      '.ecbox.broken-20261105-090703.json',
    );
  });
});

describe('buildFolderManifest / serialize', () => {
  it('字段来自快照，版本号固定', () => {
    const manifest = buildFolderManifest({ snapshot: snapshot(), files: {}, at: AT });
    expect(manifest.v).toBe(MANIFEST_VERSION);
    expect(manifest.platform).toBe('pinduoduo');
    expect(manifest.productId).toBe('482319937501');
    expect(manifest.updatedAt).toBe(AT);
  });

  it('序列化后能被原样解析回来（往返一致）', () => {
    const manifest = buildFolderManifest({
      snapshot: snapshot(),
      files: { 'main:a': { path: '主图/01.jpg', size: 1, at: AT } },
      at: AT,
    });
    const text = serializeFolderManifest(manifest);
    const parsed = parseFolderManifest(text);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok') expect(parsed.manifest).toEqual(manifest);
  });

  it('以换行结尾、2 空格缩进', () => {
    const text = serializeFolderManifest(
      buildFolderManifest({ snapshot: snapshot(), files: {}, at: AT }),
    );
    expect(text.endsWith('\n')).toBe(true);
    expect(text.includes('\n  "v": 1')).toBe(true);
  });
});

describe('summarizeHistory（§9.11 历史提示）', () => {
  const manifest = buildFolderManifest({
    snapshot: snapshot(),
    files: {
      'main:a': { path: '主图/01.jpg', size: 100, at: AT },
      'main:b': { path: '主图/02.jpg', size: 200, at: AT },
    },
    at: AT,
  });

  it('没有清单时返回 null（不显示历史）', () => {
    expect(summarizeHistory(null, new Map())).toBeNull();
  });

  it('记录里已有的不算缺失', () => {
    const expected = new Map<string, number | undefined>([
      ['main:a', 100],
      ['main:b', 200],
    ]);
    expect(summarizeHistory(manifest, expected)).toEqual({ lastAt: AT, missing: [], total: 2 });
  });

  it('记录里没有的算缺失', () => {
    const expected = new Map<string, number | undefined>([
      ['main:a', 100],
      ['detail:c', 300],
    ]);
    const summary = summarizeHistory(manifest, expected);
    expect(summary?.missing).toEqual(['detail:c']);
  });

  it('大小不一致算缺失（文件被改过或下载不完整）', () => {
    const expected = new Map<string, number | undefined>([['main:a', 999]]);
    expect(summarizeHistory(manifest, expected)?.missing).toEqual(['main:a']);
  });

  it('期望大小未知时只比存在性', () => {
    const expected = new Map<string, number | undefined>([['main:a', undefined]]);
    expect(summarizeHistory(manifest, expected)?.missing).toEqual([]);
  });

  it('记录里有、当前快照没有的条目不报缺失（平台下架了图）', () => {
    const expected = new Map<string, number | undefined>([['main:a', 100]]);
    const summary = summarizeHistory(manifest, expected);
    expect(summary?.missing).toEqual([]);
    expect(summary?.total).toBe(2);
  });
});

describe('mergeManifestFiles', () => {
  it('新记录覆盖同名 itemKey，其余保留', () => {
    const previous = buildFolderManifest({
      snapshot: snapshot(),
      files: {
        'main:a': { path: '主图/01.jpg', size: 1, at: 1 },
        'main:b': { path: '主图/02.jpg', size: 2, at: 2 },
      },
      at: AT,
    });
    const merged = mergeManifestFiles(previous, {
      'main:a': { path: '主图/01.jpg', size: 9, at: 9 },
      'detail:c': { path: '详情图/01.jpg', size: 3, at: 3 },
    });
    expect(merged['main:a']?.size).toBe(9);
    expect(merged['main:b']?.size).toBe(2);
    expect(merged['detail:c']?.path).toBe('详情图/01.jpg');
  });

  it('没有旧清单时直接用新的', () => {
    expect(
      mergeManifestFiles(null, { 'main:a': { path: 'p', size: 1, at: 1 } })['main:a']?.size,
    ).toBe(1);
  });
});
