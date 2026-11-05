import { EcError } from '../errors/ec-error';
import { type KeyValueStore, storeAsKv } from '../storage/idb';
import { STORAGE_KEYS } from '../storage/keys';
import { asFsaHandle } from './fsa-capabilities';

/**
 * 根目录句柄存储（方案 §6.5、§9.4）。
 *
 * 句柄只能用结构化克隆存进 IndexedDB，chrome.storage 存不了，所以单独走 handles 表，
 * key 固定为 'root'。rootId 和句柄存在一起：用户换目录时 rootId 跟着换，
 * 旧的商品文件夹索引（folders 表按 ${rootId}:... 存）自然作废，不会串到别的目录里。
 */

export const ROOT_KEY = 'root';

export interface RootEntry {
  /** downloads 兜底模式（§9.13）没有句柄，这里是 null */
  handle: FileSystemDirectoryHandle | null;
  rootId: string;
  /** 记录写入时间，诊断包里用来判断用户什么时候选的目录 */
  at: number;
}

export interface HandleStore {
  load(): Promise<RootEntry | null>;
  save(handle: FileSystemDirectoryHandle | null, rootId?: string): Promise<RootEntry>;
  clear(): Promise<void>;
  rootId(): Promise<string | null>;
}

/** 生成新的 rootId。用 randomUUID 而不是时间戳，避免两个上下文同时换目录时撞车 */
export function newRootId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `root-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createHandleStore(kv: KeyValueStore<RootEntry>): HandleStore {
  return {
    async load() {
      const entry = await kv.get(ROOT_KEY);
      return entry ?? null;
    },
    async save(handle, rootId) {
      const entry: RootEntry = {
        handle,
        rootId: rootId ?? newRootId(),
        at: Date.now(),
      };
      await kv.set(ROOT_KEY, entry);
      return entry;
    },
    async clear() {
      await kv.del(ROOT_KEY);
    },
    async rootId() {
      const entry = await kv.get(ROOT_KEY);
      return entry?.rootId ?? null;
    },
  };
}

let defaultStore: HandleStore | null = null;

/** 默认实例：句柄存在 IndexedDB 的 handles 表（§6.5） */
export function handleStore(): HandleStore {
  if (!defaultStore) {
    // 只在真正用到 IndexedDB 时才构造，避免单测里 import 就炸
    defaultStore = createHandleStore(storeAsKv<RootEntry>(STORAGE_KEYS.stores.handles));
  }
  return defaultStore;
}

/** 取回根句柄；没有或者结构不对时返回 null */
export async function loadRootHandle(
  store: HandleStore = handleStore(),
): Promise<FileSystemDirectoryHandle | null> {
  const entry = await store.load();
  const handle = entry?.handle;
  if (!handle) return null;
  // 结构化克隆回来的是真实句柄；万一存坏了（旧版本数据）就当作没有。
  // queryPermission 是 Chrome 已实现但 lib.dom 还没收录的方法，见 fsa-capabilities.ts
  if (typeof asFsaHandle(handle).queryPermission !== 'function') return null;
  return handle;
}

/** 保存用户在授权小窗里选到的目录；换目录时同时换 rootId（§9.4） */
export async function saveRootHandle(
  handle: FileSystemDirectoryHandle | null,
  store: HandleStore = handleStore(),
): Promise<RootEntry> {
  const previous = await store.load();
  const previousId = previous?.rootId;
  const sameRoot = previous?.handle !== null && previous?.handle !== undefined && handle !== null;
  // 同一个句柄再保存一次（例如只是重新授权）不应该换 rootId，否则索引全废
  if (sameRoot && previousId) {
    let same = false;
    try {
      same = await (previous.handle as FileSystemDirectoryHandle).isSameEntry(handle);
    } catch {
      same = false;
    }
    if (same) return store.save(handle, previousId);
  }
  return store.save(handle);
}

/** 目录没选时统一抛 DIR_UNSET（调用方转成「选择保存位置」状态） */
export async function requireRootHandle(
  store: HandleStore = handleStore(),
): Promise<FileSystemDirectoryHandle> {
  const handle = await loadRootHandle(store);
  if (!handle) throw new EcError('DIR_UNSET');
  return handle;
}
