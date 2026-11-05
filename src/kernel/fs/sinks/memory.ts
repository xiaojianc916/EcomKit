import { EcError } from '../../errors/ec-error';
import { nameKey } from '../../naming/sanitize';
import { uniqueFileName } from '../../naming/unique';
import { blobToText } from '../stream-utils';
import type { DirEntry, DirState, FsSink, RelPath, WriteResult } from '../types';

/**
 * 内存实现的 FsSink：单测和 E2E（ECBOX_E2E 构建下的 OPFS 兜底）用。
 *
 * 为什么放在 kernel 里而不是测试目录：功能层的 engine 在 E2E 构建下要换掉真实写入层，
 * 而测试文件不进构建产物，所以必须是一个能被打包进去的模块。
 * 行为对齐 FSA 实现：大小写不敏感重名、写入完成前不落盘、失败注入用于测错误映射。
 */

interface MemFile {
  /** 落盘时用的原始大小写名字 */
  name: string;
  data: Uint8Array;
  at: number;
}

interface MemDir {
  /** key 是小写名字，value 保留原始名字（§9.2 大小写不敏感比较） */
  dirs: Map<string, MemDir>;
  files: Map<string, MemFile>;
  name: string;
}

function newDir(name: string): MemDir {
  return { dirs: new Map(), files: new Map(), name };
}

export interface MemorySinkOptions {
  rootName?: string;
  /** 注入写入失败，用来测 §9.10 的错误映射与失败分支 */
  failWith?: unknown;
}

export function createMemorySink(opts: MemorySinkOptions = {}): FsSink {
  const rootName = opts.rootName ?? '电商素材';
  const root = newDir(rootName);

  function locate(path: RelPath, create: boolean): MemDir {
    let dir = root;
    for (const segment of path) {
      const key = nameKey(segment);
      let next = dir.dirs.get(key);
      if (!next) {
        if (!create) throw new DOMException('missing', 'NotFoundError');
        next = newDir(segment);
        dir.dirs.set(key, next);
      }
      dir = next;
    }
    return dir;
  }

  async function readAll(data: Blob | ReadableStream<Uint8Array>): Promise<Uint8Array> {
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = data.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  const sink: FsSink = {
    kind: 'fsa',

    async status(): Promise<DirState> {
      return { status: 'ready', name: rootName };
    },

    async refresh(): Promise<DirState> {
      return { status: 'ready', name: rootName };
    },

    async rootName(): Promise<string | null> {
      return rootName;
    },

    async ensureDir(path: RelPath): Promise<void> {
      locate(path, true);
    },

    async resolveName(dir: RelPath, stem: string, ext: string): Promise<string> {
      const target = locate(dir, true);
      const existing = [...target.files.values()].map((file) => file.name);
      return uniqueFileName(stem, ext, existing);
    },

    async writeFile(
      dir: RelPath,
      name: string,
      data: Blob | ReadableStream<Uint8Array>,
      signal: AbortSignal,
    ): Promise<WriteResult> {
      if (signal.aborted) throw new EcError('CANCELED');
      if (opts.failWith !== undefined) throw opts.failWith;
      const target = locate(dir, true);
      const bytes = await readAll(data);
      // 读完再落盘：和 FSA 的 createWritable + close 一样，中断时不留半截文件（§9.10）
      if (signal.aborted) throw new EcError('CANCELED');
      target.files.set(nameKey(name), { name, data: bytes, at: Date.now() });
      return { size: bytes.byteLength, name };
    },

    async readText(dir: RelPath, name: string): Promise<string | null> {
      // 目录或文件不存在都是正常情况（第一次下载），返回 null 让调用方按「没有记录」处理（§9.11）
      let target: MemDir;
      try {
        target = locate(dir, false);
      } catch {
        return null;
      }
      const file = target.files.get(nameKey(name));
      if (!file) return null;
      return blobToText(new Blob([file.data as Uint8Array<ArrayBuffer>]));
    },

    async writeText(dir: RelPath, name: string, text: string): Promise<void> {
      await sink.writeFile(
        dir,
        name,
        new Blob([text], { type: 'text/plain;charset=utf-8' }),
        new AbortController().signal,
      );
    },

    async listDir(dir: RelPath): Promise<DirEntry[]> {
      let target: MemDir;
      try {
        target = locate(dir, false);
      } catch {
        return [];
      }
      const out: DirEntry[] = [];
      for (const child of target.dirs.values()) {
        out.push({ name: child.name, kind: 'directory' });
      }
      for (const file of target.files.values()) {
        out.push({ name: file.name, kind: 'file', lastModified: file.at });
      }
      return out;
    },

    async removeFile(dir: RelPath, name: string): Promise<void> {
      let target: MemDir;
      try {
        target = locate(dir, false);
      } catch {
        return;
      }
      target.files.delete(nameKey(name));
    },

    async rename(dir: RelPath, from: string, to: string): Promise<void> {
      const target = locate(dir, false);
      const key = nameKey(from);
      const file = target.files.get(key);
      if (!file) throw new EcError('DIR_GONE', { reason: 'file-not-found' });
      target.files.delete(key);
      target.files.set(nameKey(to), { ...file, name: to, at: Date.now() });
    },

    async exists(dir: RelPath, name: string): Promise<number | null> {
      let target: MemDir;
      try {
        target = locate(dir, false);
      } catch {
        return null;
      }
      const file = target.files.get(nameKey(name));
      return file ? file.data.byteLength : null;
    },
  };

  return sink;
}
