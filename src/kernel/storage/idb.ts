import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import { EcError } from '../errors/ec-error';
import { STORAGE_KEYS } from './keys';

/**
 * IndexedDB 访问层（方案 §6.5）。
 *
 * 为什么用 idb 而不是 localStorage：根目录句柄只能用结构化克隆存进 IndexedDB，
 * chrome.storage 存不了 FileSystemDirectoryHandle。四个 object store 的分工：
 *   handles   —— 根目录句柄 + rootId
 *   folders   —— 商品文件夹索引 ${rootId}:${platform}:${productId}
 *   logs      —— 诊断用的历史日志（FIFO 2000 条，§6.5）
 *   downloads —— downloads 兜底模式下的已写文件记录（§9.13 没有 .ecbox.json）
 */

export type StoreName = 'handles' | 'folders' | 'logs' | 'downloads';

interface EcboxDB extends DBSchema {
  handles: { key: string; value: unknown };
  folders: { key: string; value: unknown };
  logs: { key: number; value: unknown };
  downloads: { key: string; value: unknown };
}

export const DB_NAME = STORAGE_KEYS.dbName;
export const DB_VERSION = STORAGE_KEYS.dbVersion;
const STORE_NAMES: StoreName[] = ['handles', 'folders', 'logs', 'downloads'];

let dbPromise: Promise<IDBPDatabase<EcboxDB>> | null = null;

/** 打开数据库（单例）。没有 IndexedDB 的环境（例如某些单测）抛出可读的错误 */
export function getDb(): Promise<IDBPDatabase<EcboxDB>> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new EcError('INTERNAL', { reason: 'indexeddb-unavailable' }));
  }
  dbPromise ??= openDB<EcboxDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // 版本 1：四个 store 都是 out-of-line key，值由调用方自己定义结构。
      // 为什么不建索引：所有查询都是按主键精确取，只有日志需要顺序读，用游标足够。
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    },
    blocking() {
      // 另一个上下文要升级数据库：先关掉自己，避免整页卡住
      void closeDb();
    },
  });
  return dbPromise;
}

export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise.catch(() => null);
  db?.close();
  dbPromise = null;
}

/** 每个 store 的 key 类型 */
export interface StoreKeyMap {
  handles: string;
  folders: string;
  logs: number;
  downloads: string;
}

export async function kvGet<S extends StoreName, T = unknown>(
  store: S,
  key: StoreKeyMap[S],
): Promise<T | undefined> {
  const db = await getDb();
  return (await db.get(store, key)) as T | undefined;
}

export async function kvSet<S extends StoreName>(
  store: S,
  key: StoreKeyMap[S],
  value: unknown,
): Promise<void> {
  const db = await getDb();
  await db.put(store, value, key);
}

export async function kvDel<S extends StoreName>(store: S, key: StoreKeyMap[S]): Promise<void> {
  const db = await getDb();
  await db.delete(store, key);
}

/** 列出某个 store 的全部记录（诊断包和清理数据用） */
export async function kvList<S extends StoreName, T = unknown>(
  store: S,
): Promise<Array<{ key: StoreKeyMap[S]; value: T }>> {
  const db = await getDb();
  const tx = db.transaction(store, 'readonly');
  const keys = await tx.objectStore(store).getAllKeys();
  const values = await tx.objectStore(store).getAll();
  await tx.done;
  return keys.map((key, i) => ({ key: key as StoreKeyMap[S], value: values[i] as T }));
}

export async function kvClear(store: StoreName): Promise<void> {
  const db = await getDb();
  await db.clear(store);
}

/** 通用键值存储接口：fs 层依赖它，单测里可以塞内存实现（见 folder-index.test.ts） */
export interface KeyValueStore<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** 把某个 store 包装成 string 键的 KeyValueStore */
export function storeAsKv<T>(store: 'handles' | 'folders' | 'downloads'): KeyValueStore<T> {
  return {
    get: (key) => kvGet<typeof store, T>(store, key),
    set: (key, value) => kvSet(store, key, value),
    del: (key) => kvDel(store, key),
    keys: async () => {
      const rows = await kvList<typeof store, T>(store);
      return rows.map((row) => row.key);
    },
  };
}
