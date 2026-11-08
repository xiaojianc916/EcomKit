import { EcError } from '../../errors/ec-error';
import { createConcurrencyPool } from '../../jobs/concurrency-pool';
import type { Logger } from '../../log/logger';
import { NAME_LIMITS, nameKey, sanitizeName } from '../../naming/sanitize';
import { uniqueFileName } from '../../naming/unique';
import { checkDirStatus, probeFromHandle } from '../dir-status';
import { mapFsError } from '../fs-errors';
import { asFsaDir, asFsaHandle, iterateEntries } from '../fsa-capabilities';
import { loadRootHandle, requireRootHandle } from '../handle-store';
import { blobToText, toStream } from '../stream-utils';
import type { DirEntry, DirState, FsSink, RelPath, WriteResult } from '../types';

/**
 * FsSink 的 File System Access 实现（方案 §9.10）。
 *
 * 主路径：用户在授权小窗里选一次根目录，之后所有写入都通过句柄完成 ——
 * 可以建子目录、能读回已有文件（增量下载靠它）、写入是原子的（Chrome 先写 .crswap 再替换）。
 *
 * 所有路径参数都是相对根目录的字符串数组（见 fs/types.ts 顶部的契约调整说明）。
 */

const SWAP_EXT = '.crswap';
/** 清理残留临时文件时的并发上限（每个文件一次独立的 removeEntry） */
const SWAP_CLEAN_CONCURRENCY = 4;

/**
 * 目录名字列表的缓存时长。
 *
 * 为什么缓存：resolveName 原来每写一个文件就把整个目录列一遍（一个商品几十张详情图就是 O(n²)），
 * 而列举目录要把每个目录项都变成 FileSystemHandle，比字符串比较贵得多。
 * 缓存期间由我们自己分配的名字会**即时写回**集合，所以同一批次内的判定结果和每次重列一致；
 * TTL 只兜一种情况：用户在外面往这个目录里手工放了同名文件。
 */
const NAME_CACHE_TTL_MS = 3000;
/** 缓存的目录数上限：几百个商品目录过去后把最早的挤掉，避免长会话里无限增长 */
const MAX_CACHED_DIRS = 256;

export interface FsaSinkOptions {
  /** 取根句柄；默认从 IndexedDB 读（§6.5）。单测里注入假句柄 */
  loadRoot?: () => Promise<FileSystemDirectoryHandle | null>;
  log?: Logger;
}

/** 目录缓存的键：按清洗后真正落盘的名字拼，'主/图' 和 '主／图' 是同一个目录 */
function dirKey(path: RelPath): string {
  return path.map((segment) => nameKey(sanitizeName(segment))).join('/');
}

export function createFsaSink(opts: FsaSinkOptions = {}): FsSink {
  const loadRoot = opts.loadRoot ?? (() => loadRootHandle());
  let cached: FileSystemDirectoryHandle | null = null;
  /** 路径 → 目录句柄。存 Promise 而不是结果：并发调用共用同一次逐级解析 */
  const dirs = new Map<string, Promise<FileSystemDirectoryHandle>>();
  /** 路径 → 该目录下的文件名（已经是 nameKey 形式，比较一律大小写不敏感，§9.2） */
  const nameLists = new Map<string, { names: Set<string>; at: number }>();

  function clearCache(): void {
    dirs.clear();
    nameLists.clear();
  }

  /** 统一异常映射：目录没了/没授权就顺手清缓存，避免继续拿着死句柄 */
  function fsError(e: unknown): EcError {
    const mapped = mapFsError(e);
    if (mapped.code === 'DIR_GONE' || mapped.code === 'DIR_UNSET') clearCache();
    return mapped;
  }

  async function root(): Promise<FileSystemDirectoryHandle> {
    if (cached) return cached;
    const handle = await loadRoot();
    if (!handle) throw new EcError('DIR_UNSET');
    cached = handle;
    return handle;
  }

  /** 逐级定位目录；create=false 时吃缓存（写路径永远走一次真实解析） */
  async function getDir(path: RelPath, create: boolean): Promise<FileSystemDirectoryHandle> {
    const key = dirKey(path);
    if (!create) {
      const hit = dirs.get(key);
      if (hit) return hit;
    }
    const pending = (async () => {
      let dir = await root();
      for (const segment of path) {
        dir = await dir.getDirectoryHandle(sanitizeName(segment), { create });
      }
      return dir;
    })();
    // 长会话里商品目录会越来越多，超出上限就挤掉最早的那个（只是缓存，丢了大不了重新解析）
    if (!dirs.has(key) && dirs.size >= MAX_CACHED_DIRS) {
      const oldest = dirs.keys().next();
      if (!oldest.done) dirs.delete(oldest.value);
    }
    dirs.delete(key);
    dirs.set(key, pending);
    // 解析失败要把缓存摘掉：否则后面所有读操作都会拿到同一个已失败的 Promise
    pending.catch(() => {
      if (dirs.get(key) === pending) dirs.delete(key);
    });
    return pending;
  }

  /**
   * 写路径的目录句柄：先吃缓存（一个商品几十个文件，每次都从根逐级 getDirectoryHandle 是白花），
   * 缓存里没有时再逐级创建。
   */
  async function dirForWrite(path: RelPath): Promise<FileSystemDirectoryHandle> {
    const hit = dirs.get(dirKey(path));
    if (hit) {
      const handle = await hit.catch(() => null);
      if (handle) return handle;
    }
    return getDir(path, true);
  }

  /**
   * 目录级操作：先吃缓存句柄；句柄已指向被删除/改名的目录（NotFoundError）时清缓存、
   * 逐级重建后重试一次。用户在资源管理器里删/改商品文件夹是真实场景（§9.4）。
   */
  async function withDir<T>(
    path: RelPath,
    run: (dirHandle: FileSystemDirectoryHandle) => Promise<T>,
  ): Promise<T> {
    try {
      return await run(await dirForWrite(path));
    } catch (e) {
      if (mapFsError(e).code !== 'DIR_GONE') throw e;
      clearCache();
      return run(await getDir(path, true));
    }
  }

  /** 目录里的文件名集合（nameKey 形式），按 TTL 缓存 */
  async function dirNames(dirHandle: FileSystemDirectoryHandle, key: string): Promise<Set<string>> {
    const hit = nameLists.get(key);
    if (hit && Date.now() - hit.at < NAME_CACHE_TTL_MS) return hit.names;
    const names = new Set<string>();
    for await (const [name] of iterateEntries(dirHandle)) names.add(nameKey(name));
    if (!nameLists.has(key) && nameLists.size >= MAX_CACHED_DIRS) {
      const oldest = nameLists.keys().next();
      if (!oldest.done) nameLists.delete(oldest.value);
    }
    nameLists.delete(key);
    nameLists.set(key, { names, at: Date.now() });
    return names;
  }

  return {
    kind: 'fsa',

    async status(): Promise<DirState> {
      const state = await checkDirStatus(
        async () => {
          const handle = await loadRoot();
          cached = handle;
          return handle ? probeFromHandle(handle) : null;
        },
        async () => (await loadRoot())?.name ?? null,
      );
      // 目录被删/换掉之后，缓存里的句柄和名字列表都不能再用（§9.4）
      if (state.status !== 'ready') clearCache();
      return state;
    },

    async refresh(): Promise<DirState> {
      // 授权小窗刚写完句柄，或用户在设置里切了保存方式：根句柄和路径缓存全部作废
      cached = null;
      clearCache();
      return this.status();
    },

    async rootName(): Promise<string | null> {
      const handle = await loadRoot().catch(() => null);
      return handle?.name ?? null;
    },

    /**
     * 建目录（已存在视作成功）。
     *
     * 两点和旧实现不同：
     *   · 不再每次都把根句柄缓存清掉：引擎每写一个文件都会先 ensureDir（engine.ts 写盘前调用），
     *     原来那句 cached = null 等于每张图都重新读一次 IndexedDB；
     *   · 路径命中缓存就直接返回：一个商品几十个文件写的是同一个子目录，
     *     每次都从根逐级 getDirectoryHandle 是纯粹的重复 IPC。
     * 缓存指着已删/已改名的目录时，随后那次真实写入会拿到 NotFoundError，
     * withDir 会清缓存并逐级重建（见 withDir 的重试分支），所以这里放心走缓存。
     */
    async ensureDir(path: RelPath): Promise<void> {
      try {
        await dirForWrite(path);
      } catch (e) {
        throw fsError(e);
      }
    },

    /**
     * §9.2、§9.11：同名（大小写不敏感）时追加 (2)、(3)…
     * 注意 FSA 的 getFileHandle 大小写不敏感，所以这里必须先把目录列出来再比较。
     */
    async resolveName(dir: RelPath, stem: string, ext: string): Promise<string> {
      try {
        const key = dirKey(dir);
        const wanted = sanitizeName(stem, { maxLength: NAME_LIMITS.file });
        const names = await withDir(dir, (dirHandle) => dirNames(dirHandle, key));
        const resolved = uniqueFileName(wanted, ext, names);
        // 记下刚分配的名字：同一批次的下一个文件不必再列一次目录
        names.add(nameKey(resolved));
        return resolved;
      } catch (e) {
        throw fsError(e);
      }
    },

    /**
     * §9.10 的写入与原子性：
     *   createWritable() 之后 Chrome 先写 .crswap，close() 时原子替换；
     *   任何失败都 abort()，不留半截文件；异常统一走 mapFsError。
     */
    async writeFile(
      dir: RelPath,
      name: string,
      data: Blob | ReadableStream<Uint8Array>,
      signal: AbortSignal,
    ): Promise<WriteResult> {
      if (signal.aborted) throw new EcError('CANCELED');
      let size = 0;
      try {
        const fileHandle = await withDir(dir, (dirHandle) =>
          dirHandle.getFileHandle(name, { create: true }),
        );
        const writable = await fileHandle.createWritable();
        try {
          const stream = toStream(data);
          // 用 pipeTo 而不是 write(blob)：视频几百 MB 时内存占用恒定（§9.9）
          await stream.pipeTo(
            new WritableStream<Uint8Array>({
              write(chunk) {
                size += chunk.byteLength;
                // lib.dom 的 BufferSource 只收 Uint8Array<ArrayBuffer>，而流里的分片类型是
                // Uint8Array<ArrayBufferLike>。这里只是类型标注问题（运行期就是普通字节数组），
                // 不复制数据 —— 视频分片每 64KB 复制一次会明显拖慢写入
                return writable.write(chunk as Uint8Array<ArrayBuffer>);
              },
            }),
            { signal },
          );
          await writable.close();
        } catch (e) {
          await writable.abort().catch(() => {});
          // pipeTo 被 signal 中断时抛的是 DOMException AbortError，映射成 CANCELED
          throw fsError(e);
        }
        return { size, name };
      } catch (e) {
        throw fsError(e);
      }
    },

    async readText(dir: RelPath, name: string): Promise<string | null> {
      try {
        const dirHandle = await getDir(dir, false);
        const fileHandle = await dirHandle.getFileHandle(name);
        const file = await fileHandle.getFile();
        return await blobToText(file);
      } catch (e) {
        // 文件不存在是正常情况（第一次下载），返回 null 而不是抛错
        if (e instanceof DOMException && e.name === 'NotFoundError') return null;
        throw fsError(e);
      }
    },

    async writeText(dir: RelPath, name: string, text: string): Promise<void> {
      await this.writeFile(
        dir,
        name,
        new Blob([text], { type: 'text/plain' }),
        new AbortController().signal,
      );
    },

    async listDir(dir: RelPath): Promise<DirEntry[]> {
      try {
        const dirHandle = await getDir(dir, false);
        const out: DirEntry[] = [];
        const names = new Set<string>();
        for await (const [name, handle] of iterateEntries(dirHandle)) {
          const entry: DirEntry = {
            name,
            kind: handle.kind === 'directory' ? 'directory' : 'file',
          };
          // 目录项拿不到 mtime（FSA 没有这个能力），只有文件可以，§9.3 的扫描容错处理
          out.push(entry);
          names.add(nameKey(name));
        }
        // 同一次遍历的结果也填进 resolveName 用的名字缓存：引擎先列目录做增量判断，
        // 紧接着就要 resolveName，不共享的话同一个目录会被完整枚举两遍。
        const key = dirKey(dir);
        nameLists.delete(key);
        if (nameLists.size >= MAX_CACHED_DIRS) {
          const oldest = nameLists.keys().next();
          if (!oldest.done) nameLists.delete(oldest.value);
        }
        nameLists.set(key, { names, at: Date.now() });
        return out;
      } catch (e) {
        throw fsError(e);
      }
    },

    async removeFile(dir: RelPath, name: string): Promise<void> {
      try {
        const dirHandle = await getDir(dir, false);
        await dirHandle.removeEntry(name);
        // 名字列表缓存同步删掉，否则下一次 resolveName 还会给刚删掉的文件让位
        nameLists.get(dirKey(dir))?.names.delete(nameKey(name));
      } catch (e) {
        if (e instanceof DOMException && e.name === 'NotFoundError') return;
        throw fsError(e);
      }
    },

    async exists(dir: RelPath, name: string): Promise<number | null> {
      try {
        const dirHandle = await getDir(dir, false);
        // 大小写不敏感：直接 getFileHandle 既能判存在也能拿到大小
        const fileHandle = await dirHandle.getFileHandle(name);
        const file = await fileHandle.getFile();
        return file.size;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'NotFoundError') return null;
        throw fsError(e);
      }
    },
  };
}

/** 商品文件夹里残留的 .crswap（上次写入中断留下的临时文件，§9.6 要清理掉） */
export async function listSwapFiles(sink: FsSink, dir: RelPath): Promise<string[]> {
  const entries = await sink.listDir(dir).catch(() => []);
  return entries
    .filter((e) => e.kind === 'file' && nameKey(e.name).endsWith(SWAP_EXT))
    .map((e) => e.name);
}

/**
 * 清理残留临时文件（§9.6）。失败不影响主流程，只记日志。
 *
 * 每个 removeFile 互不依赖（不同的文件名、失败只记日志），用有界并发删：
 * 一次写入中断可能留下几十个 .crswap，逐个等会让「开始下载」多等好几轮往返。
 * 并发上限压得很小 —— 这只是收尾清理，不值得去抢下载任务的文件句柄。
 */
export async function cleanSwapFiles(sink: FsSink, dir: RelPath, log?: Logger): Promise<void> {
  const names = await listSwapFiles(sink, dir);
  if (names.length === 0) return;
  const pool = createConcurrencyPool(SWAP_CLEAN_CONCURRENCY);
  for (const name of names) {
    void pool.add(async () => {
      try {
        await sink.removeFile(dir, name);
      } catch {
        log?.debug('清理临时文件失败', { name });
      }
    });
  }
  await pool.onIdle();
}

export { asFsaDir, asFsaHandle, requireRootHandle };
