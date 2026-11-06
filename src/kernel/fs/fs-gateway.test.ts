import { describe, expect, it } from 'vitest';
import { createFolderIndex } from './folder-index';
import { createFsGateway, createFsGatewayWithMemoryIndex } from './fs-gateway';
import { createMemorySink } from './sinks/memory';

function gateway() {
  const sink = createMemorySink();
  return { sink, gw: createFsGatewayWithMemoryIndex(sink, 'root-1') };
}

describe('FsGateway.resolveProductFolder（§9.3 / ADR-6）', () => {
  it('第一次下载：按模板名在根目录下新建商品文件夹（没有平台目录层）', async () => {
    const { sink, gw } = gateway();
    const result = await gw.resolveProductFolder({
      platform: '拼多多',
      productId: '482319937501',
      preferredName: '拼多多_商品ID_482319937501',
    });
    expect(result.folderName).toBe('拼多多_商品ID_482319937501');
    // 商品文件夹名里已经带了平台名，外面再套一层「拼多多」就是重复
    expect(result.dir).toEqual(['拼多多_商品ID_482319937501']);
    const entries = await sink.listDir([]);
    expect(entries.map((e) => e.name)).toEqual(['拼多多_商品ID_482319937501']);
    expect(entries[0]?.kind).toBe('directory');
  });

  it('第二次下载：索引命中，直接复用同一个文件夹', async () => {
    const { gw } = gateway();
    const first = await gw.resolveProductFolder({
      platform: '拼多多',
      productId: '482319937501',
      preferredName: '拼多多_商品ID_482319937501',
    });
    const second = await gw.resolveProductFolder({
      platform: '拼多多',
      productId: '482319937501',
      preferredName: '拼多多_商品ID_482319937501',
    });
    expect(second.folderName).toBe(first.folderName);
    expect(second.dir).toEqual(first.dir);
  });

  it('商家改标题后（索引丢失）：靠 _ID 后缀扫回旧文件夹', async () => {
    const { sink, gw } = gateway();
    await sink.ensureDir(['旧标题_482319937501']);
    const result = await gw.resolveProductFolder({
      platform: '拼多多',
      productId: '482319937501',
      preferredName: '新标题_482319937501',
    });
    expect(result.folderName).toBe('旧标题_482319937501');
    // 扫的是根目录，所以命中结果只有一段
    expect(result.dir).toEqual(['旧标题_482319937501']);
  });

  it('_ID 后缀匹配大小写不敏感', async () => {
    const { sink, gw } = gateway();
    await sink.ensureDir(['旧标题_ABC123']);
    const result = await gw.resolveProductFolder({
      platform: '拼多多',
      productId: 'abc123',
      preferredName: '新标题_abc123',
    });
    expect(result.folderName).toBe('旧标题_ABC123');
  });

  it('后缀匹配不会误伤前缀相同的商品（_123 不能匹配 _1234）', async () => {
    const { sink, gw } = gateway();
    await sink.ensureDir(['别的商品_4823199375010']);
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
    const result = await gw.resolveProductFolder({
      platform: '拼多多',
      productId: '482319937501',
      preferredName: '新名字_482319937501',
    });
    expect(result.folderName).toBe('新名字_482319937501');
    expect((await sink.listDir([])).map((e) => e.name)).toEqual(['新名字_482319937501']);
  });

  it('文件夹名按 §9.2 清洗（清洗后仍是根目录下的一段）', async () => {
    const { gw } = gateway();
    const result = await gw.resolveProductFolder({
      platform: '拼多多',
      productId: '482319937501',
      preferredName: '拼/多多:商品_482319937501',
    });
    expect(result.folderName).toBe('拼／多多：商品_482319937501');
    expect(result.dir).toEqual(['拼／多多：商品_482319937501']);
  });

  it('downloads 模式（拿不到 rootId）也能定位，不会整单退回模板路径', async () => {
    const sink = createMemorySink();
    const gw = createFsGateway({ sink, rootId: async () => null });
    await sink.ensureDir(['老名字_482319937501']);
    const result = await gw.resolveProductFolder({
      platform: '拼多多',
      productId: '482319937501',
      preferredName: '新名字_482319937501',
    });
    // 没有 rootId 就没有索引，但仍然靠 _ID 后缀扫回旧文件夹（ADR-6 的承诺）
    expect(result.folderName).toBe('老名字_482319937501');
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
    await gw.writeText(['商品_1'], 'a.txt', 'hello');
    expect(await first.readText(['商品_1'], 'a.txt')).toBeNull();
    expect(await second.readText(['商品_1'], 'a.txt')).toBe('hello');
  });

  it('没有文件时 readText 返回 null（第一次下载的正常情况）', async () => {
    const { gw } = gateway();
    expect(await gw.readText(['商品_1'], '不存在.txt')).toBeNull();
  });

  it('写文件后 exists 返回大小', async () => {
    const { gw } = gateway();
    await gw.writeText(['商品_1'], 'a.txt', '标题：连衣裙');
    expect(await gw.exists(['商品_1'], 'a.txt')).toBeGreaterThan(0);
    expect(await gw.exists(['商品_1'], '不存在.txt')).toBeNull();
  });
});
