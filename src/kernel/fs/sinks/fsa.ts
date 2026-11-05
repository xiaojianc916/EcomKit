import { EcError } from '../../errors/ec-error';
import type { Logger } from '../../log/logger';
import { nameKey, sanitizeName } from '../../naming/sanitize';
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

export interface FsaSinkOptions {
  /** 取根句柄；默认从 IndexedDB 读（§6.5）。单测里注入假句柄 */
  loadRoot?: () => Promise<FileSystemDirectoryHandle | null>;
  log?: Logger;
}

export function createFsaSink(opts: FsaSinkOptions = {}): FsSink {
  const loadRoot = opts.loadRoot ?? (() => loadRootHandle());
  let cached: FileSystemDirectoryHandle | null = null;

  async function root(): Promise<FileSystemDirectoryHandle> {
    if (cached) return cached;
    const handle = await loadRoot();
    if (!handle) throw new EcError('DIR_UNSET');
    cached = handle;
    return handle;
  }

  /** 逐级定位目录，不创建 */
  async function getDir(path: RelPath, create: boolean): Promise<FileSystemDirectoryHandle> {
    let dir = await root();
    for (const segment of path) {
      dir = await dir.getDirectoryHandle(sanitizeName(segment), { create });
    }
    return dir;
  }

  return {
    kind: 'fsa',

    async status(): Promise<DirState> {
      return checkDirStatus(
        async () => {
          const handle = await loadRoot();
          cached = handle;
          return handle ? probeFromHandle(handle) : null;
        },
        async () => (await loadRoot())?.name ?? null,
      );
    },

    async refresh(): Promise<DirState> {
      cached = null;
      return this.status();
    },

    async rootName(): Promise<string | null> {
      const handle = await loadRoot().catch(() => null);
      return handle?.name ?? null;
    },

    async ensureDir(path: RelPath): Promise<void> {
      cached = null; // 状态可能刚被授权改变，重新读一次根句柄
      try {
        await getDir(path, true);
      } catch (e) {
        throw mapFsError(e);
      }
    },

    /**
     * §9.2、§9.11：同名（大小写不敏感）时追加 (2)、(3)…
     * 注意 FSA 的 getFileHandle 大小写不敏感，所以这里必须先把目录列出来再比较。
     */
    async resolveName(dir: RelPath, stem: string, ext: string): Promise<string> {
      try {
        const dirHandle = await getDir(dir, true);
        const names: string[] = [];
        for await (const [name] of iterateEntries(dirHandle)) names.push(name);
        return uniqueFileName(sanitizeName(stem, { maxLength: 40 }), ext, names);
      } catch (e) {
        throw mapFsError(e);
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
        const dirHandle = await getDir(dir, true);
        const fileHandle = await dirHandle.getFileHandle(name, { create: true });
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
          throw mapFsError(e);
        }
        return { size, name };
      } catch (e) {
        throw mapFsError(e);
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
        throw mapFsError(e);
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
        for await (const [name, handle] of iterateEntries(dirHandle)) {
          const entry: DirEntry = {
            name,
            kind: handle.kind === 'directory' ? 'directory' : 'file',
          };
          // 目录项拿不到 mtime（FSA 没有这个能力），只有文件可以，§9.3 的扫描容错处理
          out.push(entry);
        }
        return out;
      } catch (e) {
        throw mapFsError(e);
      }
    },

    async removeFile(dir: RelPath, name: string): Promise<void> {
      try {
        const dirHandle = await getDir(dir, false);
        await dirHandle.removeEntry(name);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'NotFoundError') return;
        throw mapFsError(e);
      }
    },

    /** §9.11：损坏的 .ecbox.json 改名保留现场。FSA 没有 rename，用「复制 + 删除」实现 */
    async rename(dir: RelPath, from: string, to: string): Promise<void> {
      try {
        const dirHandle = await getDir(dir, false);
        const source = await dirHandle.getFileHandle(from);
        const blob = await source.getFile();
        const target = await dirHandle.getFileHandle(to, { create: true });
        const writable = await target.createWritable();
        try {
          await writable.write(blob);
          await writable.close();
        } catch (e) {
          await writable.abort().catch(() => {});
          throw mapFsError(e);
        }
        await dirHandle.removeEntry(from);
      } catch (e) {
        throw mapFsError(e);
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
        throw mapFsError(e);
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

/** 清理残留临时文件（§9.6）。失败不影响主流程，只记日志 */
export async function cleanSwapFiles(sink: FsSink, dir: RelPath, log?: Logger): Promise<void> {
  const names = await listSwapFiles(sink, dir);
  for (const name of names) {
    try {
      await sink.removeFile(dir, name);
    } catch {
      log?.debug('清理临时文件失败', { name });
    }
  }
}

export { asFsaDir, asFsaHandle, requireRootHandle };
