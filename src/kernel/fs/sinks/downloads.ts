import { EcError } from '../../errors/ec-error';
import type { Logger } from '../../log/logger';
// 必须是**静态** import：动态 import 在打包后的 offscreen chunk 里会退化成 undefined，
// 调用时抛 TypeError，表现为「每个文件都写失败」。
import { sendMessage } from '../../messaging/runtime';
import { NAME_LIMITS, sanitizeName } from '../../naming/sanitize';
import { uniqueFileName } from '../../naming/unique';
import { alwaysReadyProbe, checkDirStatus } from '../dir-status';
import { mapFsError } from '../fs-errors';
import { blobToText, countingStream, throwIfAborted, toStream } from '../stream-utils';
import type { DirEntry, DirState, FsSink, RelPath, WriteFileOptions, WriteResult } from '../types';

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

/**
 * 默认的下载通道。
 *
 * **chrome.downloads 不在 offscreen 文档里**（Chrome 只给 offscreen 留 chrome.runtime），
 * 所以引擎不能直接调它，只能把字节转给 bg（那边有完整 API）。
 * 旧实现直接调用 globalThis.chrome.downloads，在 offscreen 里必然抛
 * downloads-api-unavailable —— 「浏览器下载目录」这个保存方式从来就不可能成功。
 */
function defaultDownloadsApi(): DownloadsApi {
  const api = (globalThis as { chrome?: typeof chrome }).chrome?.downloads;
  if (!api) return createBridgeDownloadsApi();
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

/**
 * 通过 bg 落盘的下载通道（offscreen 里唯一可行的方式）。
 *
 * 只实现 download()：search 在 offscreen 里也拿不到，所以「最终路径」由 bg 回传，
 * sink 直接用返回值把自己内存里的路径树更新掉。
 */
function createBridgeDownloadsApi(): DownloadsApi {
  return {
    async download(options) {
      const url = options.url ?? '';
      const filename = options.filename ?? 'download';
      // http(s) 直链：原样转给 bg，由 chrome.downloads 流式落盘（文件名才保得住）
      if (/^https?:\/\//i.test(url)) {
        const res = (await sendMessage('engine.download', { filename, url })) as {
          filename: string;
          size: number;
        };
        if (!res || typeof res.filename !== 'string') {
          throw new EcError('INTERNAL', { reason: 'download-bridge-bad-response' });
        }
        bridgeResults.set(filename, res);
        return 0;
      }
      // blob:/data: URL 只在本上下文有效，先把字节读出来再发过去
      if (typeof fetch !== 'function') {
        throw new EcError('INTERNAL', { reason: 'offscreen-fetch-unavailable' });
      }
      const response = await fetch(url);
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      const bridged = (await sendMessage('engine.download', {
        filename,
        data: buffer,
        mime: blob.type,
      })) as { filename: string; size: number };
      if (!bridged || typeof bridged.filename !== 'string') {
        throw new EcError('INTERNAL', { reason: 'download-bridge-bad-response' });
      }
      bridgeResults.set(filename, bridged);
      return 0;
    },
    async search(query) {
      // 合成一条记录：bg 已经把真实路径和大小回传了
      const hit = [...bridgeResults.entries()].find(([, v]) => v !== undefined)?.[1];
      void query;
      return hit === undefined
        ? []
        : [
            {
              filename: hit.filename,
              fileSize: hit.size,
              totalBytes: hit.size,
            } as chrome.downloads.DownloadItem,
          ];
    },
  };
}

/** bg 回传的落盘结果（filename → { 真实路径, 字节数 }） */
const bridgeResults = new Map<string, { filename: string; size: number }>();

/**
 * chrome.downloads 拒绝的文件名（实测：「Invalid filename」）：
 *   · 以点开头的文件名（.ecbox.json）
 *   · 空段、以及非法路径字符
 * 所以 downloads 模式下的侧录文件要用一个普通名字（见 MANIFEST_NAME_DOWNLOADS）。
 */
export const DOWNLOADS_MANIFEST_NAME = '_ecbox.json';

/** 相对路径 → 下载文件名（正斜杠，Chrome 下载 API 的约定） */
export function downloadPathName(rootName: string, dir: RelPath, name: string): string {
  const segments = [sanitizeName(rootName, { maxLength: NAME_LIMITS.platform }), ...dir, name]
    .map((seg) => seg.replace(/^\/+|\/+$/g, '').trim())
    // chrome.downloads 不允许以点开头的文件名，这里补一个前缀而不是丢掉文件
    .map((seg) => (seg.startsWith('.') ? `_${seg.slice(1)}` : seg));
  return segments.filter((seg) => seg !== '').join('/');
}

/** downloads 模式下 .ecbox.json 的实际文件名（读取时也要用它，否则永远读不到） */
export function downloadsManifestName(name: string): string {
  return name.startsWith('.') ? `_${name.slice(1)}` : name;
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
      opts?: WriteFileOptions,
    ): Promise<WriteResult> {
      throwIfAborted(signal);

      const blob = data instanceof Blob ? data : await streamToBlobCounting(data);
      throwIfAborted(signal);

      const filename = downloadPathName(rootName, dir, downloadsManifestName(name));

      /**
       * 内容没被改写过（没有 WebP→JPG 转码）时，直接把**原始 https 地址**交给浏览器下载：
       * chrome.downloads 只有对 http(s)/blob URL 才保留 filename，用 data: URL 时
       * Chrome 会把文件存成 GUID（实测），用户拿到的是一堆无名文件。
       */
      if (opts?.sourceUrl?.startsWith('http') && blob.size > 0) {
        try {
          const sourceId = await api().download({
            url: opts.sourceUrl,
            filename,
            conflictAction: 'uniquify',
            saveAs: false,
          });
          const [sourceItem] = await api().search({ id: sourceId });
          if (sourceItem?.filename) {
            const size = sourceItem.fileSize ?? sourceItem.totalBytes ?? blob.size;
            files.set(pathKey(sourceItem.filename), size);
            files.set(pathKey(filename), size);
            schedulePersist();
            return { size, name: fileNameOf(sourceItem.filename) };
          }
        } catch {
          // 远端直连失败（需要 Referer / 已过期）就退回本地字节
        }
      }
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
        // 把真实原因带进错误对象，否则上层只能看到 WRITE_FAILED 一个码
        const mapped = mapFsError(e);
        throw new EcError(mapped.code, {
          reason: 'downloads-write-failed',
          detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
          stack:
            e instanceof Error
              ? (e.stack ?? '').split(String.fromCharCode(10)).slice(1, 4)
              : undefined,
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    },

    async readText(dir: RelPath, name: string): Promise<string | null> {
      const key = pathKey(downloadPathName(rootName, dir, downloadsManifestName(name)));
      const text = texts.get(key);
      if (text !== undefined) return text;
      // 没写过就读不到（§9.13 的已知限制），返回 null 让调用方按「没有记录」处理
      return null;
    },

    async writeText(dir: RelPath, name: string, text: string): Promise<void> {
      const key = pathKey(downloadPathName(rootName, dir, downloadsManifestName(name)));
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
      const key = pathKey(downloadPathName(rootName, dir, downloadsManifestName(name)));
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
      const filename = downloadPathName(rootName, dir, downloadsManifestName(name));
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
