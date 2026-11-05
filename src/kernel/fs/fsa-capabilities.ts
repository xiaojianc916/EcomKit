/**
 * File System Access 里 Chrome 已经实现、但 TypeScript 的 lib.dom 还没收录的能力
 * （queryPermission / requestPermission / 异步迭代 entries）。
 *
 * 为什么不装 @types/wicg-file-system-access：项目根配置不归内核层改，
 * 而且我们只需要这几个方法，局部扩展比引入一个全局类型包更可控。
 */

export type FsaPermissionMode = 'read' | 'readwrite';

export interface FsaPermissionDescriptor {
  mode?: FsaPermissionMode;
}

export interface FsaHandleExtras {
  queryPermission(desc?: FsaPermissionDescriptor): Promise<PermissionState>;
  requestPermission(desc?: FsaPermissionDescriptor): Promise<PermissionState>;
}

export interface FsaDirectoryExtras extends FsaHandleExtras {
  /** 异步遍历目录项（§9.3 扫描、§9.4 探测目录是否还在都用它） */
  entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
  keys?: () => AsyncIterableIterator<string>;
  values?: () => AsyncIterableIterator<FileSystemHandle>;
}

/** 把 lib.dom 的句柄类型补上 Chrome 扩展后的方法 */
export function asFsaDir(
  handle: FileSystemDirectoryHandle,
): FileSystemDirectoryHandle & FsaDirectoryExtras {
  return handle as unknown as FileSystemDirectoryHandle & FsaDirectoryExtras;
}

export function asFsaHandle(handle: FileSystemHandle): FileSystemHandle & FsaHandleExtras {
  return handle as unknown as FileSystemHandle & FsaHandleExtras;
}

/**
 * 遍历目录项。优先用 entries()；环境没有时退化成 values()。
 * 两者都没有时抛错，调用方会把它当作「目录已不可用」。
 */
export async function* iterateEntries(
  dir: FileSystemDirectoryHandle,
): AsyncIterableIterator<[string, FileSystemHandle]> {
  const d = asFsaDir(dir);
  if (typeof d.entries === 'function') {
    yield* d.entries();
    return;
  }
  if (typeof d.values === 'function') {
    for await (const handle of d.values()) yield [handle.name, handle];
    return;
  }
  throw new TypeError('文件系统不支持遍历目录');
}
