import { describe, expect, it } from 'vitest';
import { createFolderIndex } from './folder-index';
import { createFsGateway, createFsGatewayWithMemoryIndex } from './fs-gateway';
import { createMemorySink } from './sinks/memory';

function gateway() {
  const sink = createMemorySink();
  return { sink, gw: createFsGatewayWithMemoryIndex(sink, 'root-1') };
}

describe('FsGateway.resolveProductFolder（§9.3 / ADR-6）', () => {
  it('第一次下载：按模板名新建平台目录和商品目录', async () => {
    const { sink, gw } = gateway();
    const result = await gw.resolveProductFolder({
      platform: '拼多多',
      productId: '482319937501',
      preferredName: '夏季连衣裙_482319937501',
    });
    expect(result.folderName).toBe('夏季连衣裙_482319937501');
    expect(result.dir).toEqual(['拼多多', '夏季连衣裙_482319937501']);
    expect(result.platformDir).toEqual(['拼多多']);
    const entries = await sink.listDir(['拼多多']);
    expect(entries.map((e) => e.name)).toContain('夏季连衣裙_482319937501');
  });

  it('第二次下载：索引命中，直接复用同一个文件夹', async () => {
    const { gw } = gateway();
    const first = await gw.resolveProductFolder({
      platform: '拼多多',
      productId: '482319937501',
      preferredName: '夏季连衣裙_482319937501',
    });
    const second = await gw.resolveProductFolder({
      platform: '拼多多',
      productId: '482319937501',
      preferredName: '商家改了标题_482319937501',
    });
    expect(second.folderName).toBe(first.folderName);
  });

  it('商家改标题后（索引丢失）：靠 _ID 后缀扫回旧文件夹', async () => {
    const { sink, gw } = gateway();
    await sink.ensureDir(['拼多多', '旧标题_482319937501']);
    const result = await gw.resolveProductFolder({
      platform: '拼多多',
      productId: '482319937501',
      preferredName: '新标题_482319937501',
    });
    expect(result.folderName).toBe('旧标题_482319937501');
  });

  it('_ID 后缀匹配大小写不敏感', async () => {
    const { sink, gw } = gateway();
    await sink.ensureDir(['拼多多', '旧标题_ABC123']);
    const result = await gw.resolveProductFolder({
      platform: '拼多多',
      productId: 'abc123',
      preferredName: '新标题_abc123',
    });
    expect(result.folderName).toBe('旧标题_ABC123');
  });

  it('后缀匹配不会误伤前缀相同的商品（_123 不能匹配 _1234）', async () => {
    const { sink, gw } = gateway();
    await sink.ensureDir(['拼多多', '别的商品_4823199375010']);
    const result = await gw.resolveProductFolder({
      platform: '拼多多',
      productId: '482319937501',
      preferredName: '新商品_482319937501',
    });
    expect(result.folderName).toBe('新商品_482319937501');
  });

  it('索引里有但文件夹被删掉：忽略陈旧索引，按新名字重建', async () => {
    const sink = createMemorySink();
    const staleIndex = createFolderIndex({
      get: async () => ({ folderName: '已被删除的_482319937501', lastAt: 1 }),
      set: async () => {},
      del: async () => {},
      keys: async () => [],
    });
    const gw = createFsGateway({ sink, index: staleIndex, rootId: async () => 'root-1' });
    await sink.ensureDir(['拼多多']);
    const result = await gw.resolveProductFolder({
      platform: '拼多多',
      productId: '482319937501',
      preferredName: '新名字_482319937501',
    });
    expect(result.folderName).toBe('新名字_482319937501');
  });

  it('平台名按 §9.2 清洗', async () => {
    const { gw } = gateway();
    const dir = await gw.ensurePlatformDir('拼/多多');
    expect(dir[0]).toBe('拼／多多');
  });
});

describe('FsGateway.ensureSubdir', () => {
  it('按子文件夹长度上限清洗', async () => {
    const { gw } = gateway();
    const parent = await gw.ensurePlatformDir('拼多多');
    const sub = await gw.ensureSubdir(parent, 'SKU图');
    expect(sub).toEqual(['拼多多', 'SKU图']);
  });

  it('已有同名时复用（不会建第二个）', async () => {
    const { sink, gw } = gateway();
    const parent = await gw.ensurePlatformDir('拼多多');
    await gw.ensureSubdir(parent, '主图');
    await gw.ensureSubdir(parent, '主图');
    const entries = await sink.listDir(['拼多多']);
    expect(entries.filter((e) => e.kind === 'directory')).toHaveLength(1);
  });
});

describe('FsGateway 读写', () => {
  it('setSink 切换写入层后立即生效（§11 设置里改保存方式）', async () => {
    const first = createMemorySink();
    const second = createMemorySink();
    const gw = createFsGateway({ sink: first, rootId: async () => 'root-1' });
    expect(gw.sink).toBe(first);
    gw.setSink(second);
    expect(gw.sink).toBe(second);
    await gw.writeText(['拼多多'], 'a.txt', 'hello');
    expect(await first.readText(['拼多多'], 'a.txt')).toBeNull();
    expect(await second.readText(['拼多多'], 'a.txt')).toBe('hello');
  });

  it('writeJson / readJson 往返', async () => {
    const { gw } = gateway();
    const dir = await gw.ensurePlatformDir('拼多多');
    await gw.writeJson(dir, '.ecbox.json', { v: 1, productId: '123' });
    expect(await gw.readJson<{ v: number }>(dir, '.ecbox.json')).toEqual({
      v: 1,
      productId: '123',
    });
  });

  it('没有文件时 readJson 返回 null（第一次下载的正常情况）', async () => {
    const { gw } = gateway();
    const dir = await gw.ensurePlatformDir('拼多多');
    expect(await gw.readJson(dir, '.ecbox.json')).toBeNull();
  });

  it('写文件后 exists 返回大小', async () => {
    const { gw } = gateway();
    const dir = await gw.ensurePlatformDir('拼多多');
    await gw.writeText(dir, '商品信息.txt', '标题：连衣裙');
    expect(await gw.exists(dir, '商品信息.txt')).toBeGreaterThan(0);
    expect(await gw.exists(dir, '不存在.txt')).toBeNull();
  });
});
