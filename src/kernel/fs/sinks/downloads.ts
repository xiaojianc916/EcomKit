import { EcError } from '../../errors/ec-error';
import type { Logger } from '../../log/logger';
import { NAME_LIMITS, sanitizeName } from '../../naming/sanitize';
import { uniqueFileName } from '../../naming/unique';
import { alwaysReadyProbe, checkDirStatus } from '../dir-status';
import { mapFsError } from '../fs-errors';
import { blobToText, countingStream, throwIfAborted, toStream } from '../stream-utils';
import type { DirEntry, DirState, FsSink, RelPath, WriteResult } from '../types';

/**
 * FsSink 的 chrome.downloads 兜底实现（方案 §9.13）。
 *
 * 什么时候用：FSA 授权在某些环境（企业策略、某些 Edge 版本）不稳定时，用户在设置里切到
 * 「浏览器下载目录模式」。目录结构和 FSA 模式完全相同，只是文件走下载通道落盘。
 *
 * 关键差异（也是本实现里所有「近似」的来源）：
 *   · 拿不到任何目录句柄，所有目录/文件的存在性只能靠「内存路径树 + chrome.downloads.search」推断；
 *   · 读不回已下载文件的内容，所以 readText 只对本次会话写过的文本返回内存副本，
 *     换句话说 **downloads 模式没有 .ecbox.json 的读能力**（方案 §9.13 已明确接受这一点，
 *     增量判断改为依靠 IndexedDB 记录 + chrome.downloads.search）；
 *   · 无法删除、无法改名（Chrome 不提供），所以 removeFile/rename 只在内存树里生效。
 *
 * 下载文件名 = 根目录名 + 相对路径，例如「电商素材/拼多多/夏季连衣裙_482319937501/主图/01.jpg」。
 * 用户可以在浏览器设置里把默认下载位置指到想要的根目录（§9.13 设置页会提示）。
 */

/** 下载根目录名（写进下载文件名的最前面） */
export const DOWNLOAD_ROOT_NAME = '电商素材';

const DOWNLOAD_STATE_FILENAME = 'ecbox-downloads.json';

export interface DownloadsSinkOptions {
  /** 根目录显示名，默认「电商素材」 */
  rootName?: string;
  /** 内存里记下的已存在文件（path → size），引擎启动时用 loadState() 灌进来 */
  initialFiles?: Iterable<[string, number]>;
  /** 状态变化时持久化到 IndexedDB（§9.13：没有 .ecbox.json，只能靠 IndexedDB） */
  persist?: (files: Record<string, number>) => Promise<void>;
  log?: Logger;
  /** chrome.downloads 的最小面，单测注入假实现 */
  downloads?: DownloadsApi;
}

/** chrome.downloads 里我们用到的部分 */
export interface DownloadsApi {
  download(options: chrome.downloads.DownloadOptions): Promise<number>;
  search(query: chrome.downloads.DownloadQuery): Promise<chrome.downloads.DownloadItem[]>;
}

function defaultDownloadsApi(): DownloadsApi {
  const api = (globalThis as { chrome?: typeof chrome }).chrome?.downloads;
  if (!api) throw new EcError('INTERNAL', { reason: 'downloads-api-unavailable' });
  return {
    download: (options) =>
      new Promise<number>((resolve, reject) => {
        api.download(options, (id) => {
          const error = chrome.runtime.lastError;
          if (error || id === undefined) reject(new EcError('WRITE_FAILED', error?.message));
          else resolve(id);
        });
      }),
    search: (query) =>
      new Promise<chrome.downloads.DownloadItem[]>((resolve, reject) => {
        api.search(query, (items) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new EcError('WRITE_FAILED', error.message));
          else resolve(items);
        });
      }),
  };
}

/** 相对路径 → 下载文件名（正斜杠，Chrome 下载 API 的约定） */
export function downloadPathName(rootName: string, dir: RelPath, name: string): string {
  const segments = [sanitizeName(rootName, { maxLength: NAME_LIMITS.platform }), ...dir, name].map(
    (seg) => seg.replace(/^\/+|\/+$/g, ''),
  );
  return segments.filter((seg) => seg !== '').join('/');
}

/**
 * 目录的路径前缀，**带结尾斜杠**。
 * 一定要带斜杠：不然「商品_1」会把「商品_12」也算成自己的子项。
 */
export function downloadDirPrefix(rootName: string, dir: RelPath): string {
  return `${downloadPathName(rootName, dir, '')}/`;
}

/** 路径键：统一小写，因为 Windows 下载目录同样大小写不敏感（§9.2） */
function pathKey(path: string): string {
  return path.toLowerCase();
}

export function createDownloadsSink(opts: DownloadsSinkOptions = {}): FsSink {
  const rootName = opts.rootName ?? DOWNLOAD_ROOT_NAME;
  const downloads = opts.downloads ?? null;
  const files = new Map<string, number>();
  for (const [path, size] of opts.initialFiles ?? []) files.set(pathKey(path), size);

  // 文本文件的内存副本：downloads 模式读不回内容，至少让本会话写过的清单还能读到
  const texts = new Map<string, string>();

  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  function snapshotFiles(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, size] of files) out[key] = size;
    return out;
  }

  function schedulePersist(): void {
    if (!opts.persist) return;
    // 每个文件都写一次 IndexedDB 太吵，合并到 500ms 一次
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void opts.persist?.(snapshotFiles()).catch(() => {});
    }, 500);
  }

  function api(): DownloadsApi {
    if (downloads) return downloads;
    return defaultDownloadsApi();
  }

  function isDir(path: RelPath): void {
    // downloads 模式没有真目录，ensureDir 是个空操作：目录在写入文件时随路径自动创建
    void path;
  }

  return {
    kind: 'downloads',

    async status(): Promise<DirState> {
      // §9.13：只要扩展有 downloads 权限，这个模式就恒为 ready
      const state = await checkDirStatus(
        async () => alwaysReadyProbe(),
        async () => rootName,
      );
      return state;
    },

    async refresh(): Promise<DirState> {
      return this.status();
    },

    async rootName(): Promise<string | null> {
      return rootName;
    },

    async ensureDir(path: RelPath): Promise<void> {
      isDir(path);
    },

    /** 有同名文件（内存树 + 下载记录里查）时追加 (2)、(3)…（§9.2） */
    async resolveName(dir: RelPath, stem: string, ext: string): Promise<string> {
      const prefix = downloadDirPrefix(rootName, dir).toLowerCase();
      const existing = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const tail = key.slice(prefix.length);
        if (tail.includes('/')) continue; // 子目录里的文件不算同目录
        existing.add(tail);
      }
      const resolved = uniqueFileName(
        sanitizeName(stem, { maxLength: NAME_LIMITS.file }),
        ext,
        existing,
      );
      return resolved;
    },

    /**
     * §9.13：Blob URL 交给 chrome.downloads.download。
     * conflictAction 用 'uniquify' 让浏览器兜底去重（并发下我们自己的 resolveName 可能滞后）；
     * revokeObjectURL 必须放 finally —— 否则每次下载都会泄漏一个几百 MB 的 blob。
     */
    async writeFile(
      dir: RelPath,
      name: string,
      data: Blob | ReadableStream<Uint8Array>,
      signal: AbortSignal,
    ): Promise<WriteResult> {
      throwIfAborted(signal);

      const blob = data instanceof Blob ? data : await streamToBlobCounting(data);
      throwIfAborted(signal);

      const filename = downloadPathName(rootName, dir, name);
      const url = URL.createObjectURL(blob);
      try {
        const id = await api().download({
          url,
          filename,
          conflictAction: 'uniquify',
          saveAs: false,
        });
        // 用 search 拿到最终的下载路径（uniquify 之后浏览器可能改了名字）
        const [item] = await api().search({ id });
        const finalPath = item?.filename ?? filename;
        const size = item?.fileSize ?? item?.totalBytes ?? blob.size;
        files.set(pathKey(finalPath), size);
        files.set(pathKey(filename), size);
        schedulePersist();
        return { size, name: fileNameOf(finalPath) };
      } catch (e) {
        throw mapFsError(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    },

    async readText(dir: RelPath, name: string): Promise<string | null> {
      const key = pathKey(downloadPathName(rootName, dir, name));
      const text = texts.get(key);
      if (text !== undefined) return text;
      // 没写过就读不到（§9.13 的已知限制），返回 null 让调用方按「没有记录」处理
      return null;
    },

    async writeText(dir: RelPath, name: string, text: string): Promise<void> {
      const key = pathKey(downloadPathName(rootName, dir, name));
      texts.set(key, text);
      await this.writeFile(
        dir,
        name,
        new Blob([text], { type: 'text/plain;charset=utf-8' }),
        new AbortController().signal,
      );
    },

    /** 目录列表只能从内存树推断：返回直接子项的名字 */
    async listDir(dir: RelPath): Promise<DirEntry[]> {
      const prefix = pathKey(downloadDirPrefix(rootName, dir));
      const seen = new Set<string>();
      const out: DirEntry[] = [];
      for (const [key, size] of files) {
        if (!key.startsWith(prefix)) continue;
        const tail = key.slice(prefix.length);
        if (tail === '') continue;
        const slash = tail.indexOf('/');
        if (slash < 0) {
          if (seen.has(tail)) continue;
          seen.add(tail);
          out.push({ name: tail, kind: 'file' });
          void size;
        } else {
          const child = tail.slice(0, slash);
          if (seen.has(child)) continue;
          seen.add(child);
          out.push({ name: child, kind: 'directory' });
        }
      }
      return out;
    },

    /** Chrome 不提供删除，只能在内存树里移除，避免下次 resolveName 又让开 */
    async removeFile(dir: RelPath, name: string): Promise<void> {
      const key = pathKey(downloadPathName(rootName, dir, name));
      files.delete(key);
      texts.delete(key);
      schedulePersist();
    },

    /** Chrome 不提供改名的 API：内存树里换 key，磁盘上保持原名（§9.11 的损坏清单处理会退化） */
    async rename(dir: RelPath, from: string, to: string): Promise<void> {
      const fromKey = pathKey(downloadPathName(rootName, dir, from));
      const toKey = pathKey(downloadPathName(rootName, dir, to));
      const size = files.get(fromKey);
      if (size === undefined) throw new EcError('DIR_GONE', { reason: 'file-not-found' });
      files.delete(fromKey);
      files.set(toKey, size);
      const text = texts.get(fromKey);
      if (text !== undefined) {
        texts.delete(fromKey);
        texts.set(toKey, text);
      }
      schedulePersist();
    },

    /** 返回记录里的大小；没有记录时再去 chrome.downloads 里查一次（§9.13 增量判断） */
    async exists(dir: RelPath, name: string): Promise<number | null> {
      const filename = downloadPathName(rootName, dir, name);
      const remembered = files.get(pathKey(filename));
      if (remembered !== undefined) return remembered;
      try {
        const items = await api().search({ filenameRegex: escapeForRegex(filename), limit: 1 });
        const item = items[0];
        if (!item) return null;
        return item.fileSize ?? item.totalBytes ?? 0;
      } catch {
        // 查询失败不影响主流程：当作没有记录，重新下载
        return null;
      }
    },
  };
}

function fileNameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function streamToBlobCounting(stream: ReadableStream<Uint8Array>): Promise<Blob> {
  const { stream: counter, total } = countingStream();
  const blob = await new Response(toStream(stream).pipeThrough(counter)).blob();
  void total();
  return blob;
}

/** 读取内存里的文本副本（诊断和单测用） */
export function readMemoText(sink: FsSink, dir: RelPath, name: string): Promise<string | null> {
  return sink.readText(dir, name);
}

export { blobToText };

/** 状态文件名（调用方持久化到 IndexedDB 时用；不参与业务逻辑） */
export const DOWNLOADS_STATE_FILE = DOWNLOAD_STATE_FILENAME;
