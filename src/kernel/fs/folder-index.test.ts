import { describe, expect, it } from 'vitest';
import { createFolderIndex, createMemoryFolderIndex, folderIndexKey } from './folder-index';

describe('folder-index（§6.5、§9.3）', () => {
  it('key 由 rootId、平台、商品 ID 拼成', () => {
    expect(folderIndexKey('r1', 'pinduoduo', '482319937501')).toBe('r1:pinduoduo:482319937501');
  });

  it('写入后能读回，并记录 lastAt', async () => {
    const index = createMemoryFolderIndex();
    await index.set('r1', 'pinduoduo', '123456', '夏季连衣裙_123456');
    const entry = await index.get('r1', 'pinduoduo', '123456');
    expect(entry?.folderName).toBe('夏季连衣裙_123456');
    expect(entry?.lastAt).toBeGreaterThan(0);
  });

  it('没记录时返回 null', async () => {
    const index = createMemoryFolderIndex();
    expect(await index.get('r1', 'pinduoduo', '999')).toBeNull();
  });

  it('不同 rootId 之间互不影响（换根目录不串目录）', async () => {
    const index = createMemoryFolderIndex();
    await index.set('r1', 'pinduoduo', '123456', 'A_123456');
    expect(await index.get('r2', 'pinduoduo', '123456')).toBeNull();
    await index.set('r2', 'pinduoduo', '123456', 'B_123456');
    expect((await index.get('r1', 'pinduoduo', '123456'))?.folderName).toBe('A_123456');
    expect((await index.get('r2', 'pinduoduo', '123456'))?.folderName).toBe('B_123456');
  });

  it('不同平台之间互不影响', async () => {
    const index = createMemoryFolderIndex();
    await index.set('r1', 'pinduoduo', '123456', '拼多多_123456');
    expect(await index.get('r1', 'douyin', '123456')).toBeNull();
  });

  it('del 之后读不到', async () => {
    const index = createMemoryFolderIndex();
    await index.set('r1', 'pinduoduo', '123456', 'A_123456');
    await index.del('r1', 'pinduoduo', '123456');
    expect(await index.get('r1', 'pinduoduo', '123456')).toBeNull();
  });

  it('clearRoot 只清掉该根目录的索引', async () => {
    const index = createMemoryFolderIndex();
    await index.set('r1', 'pinduoduo', '1', 'A_1');
    await index.set('r1', 'douyin', '2', 'B_2');
    await index.set('r2', 'pinduoduo', '1', 'C_1');
    await index.clearRoot('r1');
    expect(await index.get('r1', 'pinduoduo', '1')).toBeNull();
    expect(await index.get('r1', 'douyin', '2')).toBeNull();
    expect((await index.get('r2', 'pinduoduo', '1'))?.folderName).toBe('C_1');
  });

  it('存坏的数据（空名字）当作没有记录', async () => {
    const store = new Map<string, { folderName: string; lastAt: number }>();
    store.set('r1:pinduoduo:1', { folderName: '', lastAt: 1 });
    const index = createFolderIndex({
      get: async (key) => store.get(key),
      set: async (key, value) => {
        store.set(key, value);
      },
      del: async (key) => {
        store.delete(key);
      },
      keys: async () => [...store.keys()],
    });
    expect(await index.get('r1', 'pinduoduo', '1')).toBeNull();
  });
});
