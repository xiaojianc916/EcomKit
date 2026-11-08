import { describe, expect, it, vi } from 'vitest';
import { createDownloadsSink, type DownloadsApi, downloadPathName } from './downloads';

/** 假的 chrome.downloads：把下载记录记在内存里，search 按 id 或文件名查 */
function fakeDownloads(): DownloadsApi & { records: Map<number, string> } {
  const records = new Map<number, string>();
  let nextId = 1;
  return {
    records,
    download: vi.fn(async (options) => {
      const id = nextId++;
      records.set(id, options.filename ?? '');
      return id;
    }),
    search: vi.fn(async (query) => {
      const id = (query as { id?: number }).id;
      const path = id === undefined ? undefined : records.get(id);
      if (id === undefined || path === undefined) return [];
      return [
        {
          id,
          filename: path,
          fileSize: 1024,
          totalBytes: 1024,
        } as chrome.downloads.DownloadItem,
      ];
    }),
  };
}

describe('downloadPathName（§9.13）', () => {
  it('拼成「根目录/商品/子目录/文件名」（没有平台目录层）', () => {
    expect(downloadPathName('电商素材', ['拼多多_商品ID_482319937501', '主图'], '主图01.jpg')).toBe(
      '电商素材/拼多多_商品ID_482319937501/主图/主图01.jpg',
    );
  });

  it('根目录名按 §9.2 清洗', () => {
    expect(downloadPathName('电商/素材', [], 'a.jpg')).toBe('电商／素材/a.jpg');
  });

  it('没有子目录时不出现空段', () => {
    expect(downloadPathName('电商素材', [], 'a.jpg')).toBe('电商素材/a.jpg');
  });

  it('素材文件名原样保留（不再给点开头的名字补下划线，侧录文件已不存在）', () => {
    expect(downloadPathName('电商素材', ['商品_1'], '主图01.jpg')).toBe(
      '电商素材/商品_1/主图01.jpg',
    );
  });
});

describe('createDownloadsSink（§9.13）', () => {
  it('status 恒为 ready（只要有 downloads 权限）', async () => {
    const sink = createDownloadsSink({ downloads: fakeDownloads() });
    expect(await sink.status()).toEqual({ status: 'ready', name: '电商素材' });
  });

  it('写文件后能在内存树里查到大少', async () => {
    const downloads = fakeDownloads();
    const sink = createDownloadsSink({ downloads });
    const result = await sink.writeFile(
      ['拼多多', '商品_1', '主图'],
      '01.jpg',
      new Blob([new Uint8Array(2048)]),
      new AbortController().signal,
    );
    expect(result.size).toBe(1024); // 来自 search 返回的记录
    expect(downloads.download).toHaveBeenCalledOnce();
    expect(await sink.exists(['拼多多', '商品_1', '主图'], '01.jpg')).not.toBeNull();
  });

  it('writeFile 一定 revokeObjectURL（不泄漏 blob）', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    const sink = createDownloadsSink({ downloads: fakeDownloads() });
    await sink.writeFile(['拼多多'], 'a.jpg', new Blob(['x']), new AbortController().signal);
    expect(create).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:fake');
    revoke.mockRestore();
    create.mockRestore();
  });

  it('writeFile 失败也 revokeObjectURL', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    const downloads = fakeDownloads();
    downloads.download = vi.fn(async () => {
      throw new Error('download failed');
    });
    const sink = createDownloadsSink({ downloads });
    await expect(
      sink.writeFile(['拼多多'], 'a.jpg', new Blob(['x']), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect(revoke).toHaveBeenCalledWith('blob:fake');
    revoke.mockRestore();
    create.mockRestore();
  });

  it('取消后不发起下载', async () => {
    const downloads = fakeDownloads();
    const sink = createDownloadsSink({ downloads });
    const controller = new AbortController();
    controller.abort();
    await expect(
      sink.writeFile(['拼多多'], 'a.jpg', new Blob(['x']), controller.signal),
    ).rejects.toMatchObject({ code: 'CANCELED' });
    expect(downloads.download).not.toHaveBeenCalled();
  });

  it('同名文件追加 (2)', async () => {
    const sink = createDownloadsSink({ downloads: fakeDownloads() });
    await sink.writeFile(['拼多多'], '01.jpg', new Blob(['x']), new AbortController().signal);
    expect(await sink.resolveName(['拼多多'], '01', 'jpg')).toBe('01 (2).jpg');
  });

  it('listDir 能从内存树推断目录结构', async () => {
    const sink = createDownloadsSink({ downloads: fakeDownloads() });
    const signal = new AbortController().signal;
    await sink.writeFile(['商品_1', '主图'], '主图01.jpg', new Blob(['a']), signal);
    await sink.writeFile(['商品_1'], '主图01.jpg', new Blob(['b']), signal);
    const entries = await sink.listDir(['商品_1']);
    expect(entries).toContainEqual({ name: '主图', kind: 'directory' });
    expect(entries).toContainEqual({ name: '主图01.jpg', kind: 'file' });
  });

  it('readText 能读回本会话写过的文本（§9.13 读不回磁盘的已知限制）', async () => {
    const sink = createDownloadsSink({ downloads: fakeDownloads() });
    await sink.writeText(['商品_1'], 'note.txt', 'hello');
    expect(await sink.readText(['商品_1'], 'note.txt')).toBe('hello');
    expect(await sink.readText(['商品_1'], '没写过.txt')).toBeNull();
  });

  it('removeFile 从内存树里移除，避免下次 resolveName 又让开', async () => {
    const sink = createDownloadsSink({ downloads: fakeDownloads() });
    const signal = new AbortController().signal;
    await sink.writeFile(['商品_1'], '主图01.jpg', new Blob(['x']), signal);
    expect(await sink.resolveName(['商品_1'], '主图01', 'jpg')).toBe('主图01 (2).jpg');
    await sink.removeFile(['商品_1'], '主图01.jpg');
    expect(await sink.exists(['商品_1'], '主图01.jpg')).toBeNull();
    expect(await sink.resolveName(['商品_1'], '主图01', 'jpg')).toBe('主图01.jpg');
  });

  it('带 sourceUrl 的流直接走直链，不在本地把几百 MB 收进内存', async () => {
    const downloads = fakeDownloads();
    const sink = createDownloadsSink({ downloads });
    let pulled = 0;
    // 一个「一读就记账」的流：直链分支不该碰它
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 3) controller.close();
        else controller.enqueue(new Uint8Array(1024));
      },
    });
    const result = await sink.writeFile(
      ['拼多多'],
      'video.mp4',
      stream,
      new AbortController().signal,
      { sourceUrl: 'https://cdn.example.com/v.mp4' },
    );
    expect(result.name).toBe('video.mp4');
    expect(downloads.download).toHaveBeenCalledOnce();
    expect(
      (downloads.download as never as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
    ).toMatchObject({
      url: 'https://cdn.example.com/v.mp4',
      filename: '电商素材/拼多多/video.mp4',
    });
    // 流会预取一次填充内部队列，所以按「最多 1 次」判；关键是没把它读完（读完 > 3 次）
    expect(pulled, '直链分支不应把本地流读完').toBeLessThanOrEqual(1);
  });

  it('空 Blob + sourceUrl 不走直链（否则会落一个 0 字节文件）', async () => {
    const downloads = fakeDownloads();
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:empty');
    const sink = createDownloadsSink({ downloads });
    await sink.writeFile(['拼多多'], 'a.jpg', new Blob([]), new AbortController().signal, {
      sourceUrl: 'https://cdn.example.com/a.jpg',
    });
    const calls = (downloads.download as never as { mock: { calls: Array<[{ url: string }]> } })
      .mock.calls;
    expect(calls[0]?.[0].url).toBe('blob:empty');
    create.mockRestore();
  });

  it('exists 查下载记录时用大小写不敏感、分隔符无关的正则', async () => {
    const downloads = fakeDownloads();
    const search = vi.fn(async () => [] as chrome.downloads.DownloadItem[]);
    downloads.search = search;
    const sink = createDownloadsSink({ downloads });
    expect(await sink.exists(['拼多多'], 'Main.JPG')).toBeNull();
    // Windows 的下载记录是反斜杠绝对路径，正则必须同时接受 / 和 \
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ filenameRegex: '(?i)电商素材[\\\\/]拼多多[\\\\/]Main\\.JPG' }),
    );
  });

  it('目录里只要有一个文件触发过搜索，其余文件就直接命中内存树（不再逐个查下载记录）', async () => {
    const downloads = fakeDownloads();
    const search = vi.fn(async (query: chrome.downloads.DownloadQuery) => {
      if (query.id !== undefined) return [];
      return [
        {
          id: 1,
          filename: 'C:\\Users\\me\\Downloads\\电商素材\\拼多多\\Main.JPG',
          fileSize: 2048,
          totalBytes: 2048,
        } as chrome.downloads.DownloadItem,
      ];
    });
    downloads.search = search;
    const sink = createDownloadsSink({ downloads });

    expect(await sink.exists(['拼多多'], 'Main.JPG')).toBe(2048);
    expect(await sink.exists(['拼多多'], 'MAIN.jpg')).toBe(2048);
    // 一次目录预热就够：绝对路径被换算成相对路径，两次查询都命中内存树
    expect(search).toHaveBeenCalledOnce();
  });

  it('listDir 会合并 chrome.downloads 里没有记录的文件（老版本下载的不会重下副本）', async () => {
    const downloads = fakeDownloads();
    downloads.search = vi.fn(async (query: chrome.downloads.DownloadQuery) => {
      if (query.id !== undefined) return [];
      return [
        {
          id: 1,
          filename: 'C:\\Users\\me\\Downloads\\电商素材\\拼多多\\主图\\主图01.jpg',
          fileSize: 10,
          totalBytes: 10,
        } as chrome.downloads.DownloadItem,
      ];
    });
    const sink = createDownloadsSink({ downloads });
    const entries = await sink.listDir(['拼多多', '主图']);
    expect(entries).toContainEqual({ name: '主图01.jpg', kind: 'file' });
    // 已经并进内存树，下一次 resolveName 会让开
    expect(await sink.resolveName(['拼多多', '主图'], '主图01', 'jpg')).toBe('主图01 (2).jpg');
  });

  it('状态变化时合并写 IndexedDB（500ms 节流）', async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => {});
    const sink = createDownloadsSink({ downloads: fakeDownloads(), persist });
    const signal = new AbortController().signal;
    await sink.writeFile(['拼多多'], 'a.jpg', new Blob(['x']), signal);
    await sink.writeFile(['拼多多'], 'b.jpg', new Blob(['y']), signal);
    expect(persist).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(persist).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
