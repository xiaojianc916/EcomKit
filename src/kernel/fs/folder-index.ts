import { type KeyValueStore, storeAsKv } from '../storage/idb';
import { STORAGE_KEYS } from '../storage/keys';

/**
 * 商品文件夹索引（方案 §6.5、§9.3 / ADR-6）。
 *
 * 为什么要索引：商家改标题后，模板生成的文件夹名会变；只按名字找就会另建一个新文件夹，
 * 增量下载随之失效。索引的 key 里带 rootId，用户换根目录后旧索引自然作废、不会串目录。
 *
 * key 形如 `${rootId}:${platform}:${productId}`。
 */

export interface FolderIndexEntry {
  folderName: string;
  /** 最后一次使用的时间，用于诊断和清理 */
  lastAt: number;
}

export interface FolderIndex {
  get(rootId: string, platform: string, productId: string): Promise<FolderIndexEntry | null>;
  set(rootId: string, platform: string, productId: string, folderName: string): Promise<void>;
  del(rootId: string, platform: string, productId: string): Promise<void>;
  /** 清掉某个根目录下的全部索引（换目录/清除数据时用） */
  clearRoot(rootId: string): Promise<void>;
}

export function folderIndexKey(rootId: string, platform: string, productId: string): string {
  return `${rootId}:${platform}:${productId}`;
}

/** 键的前缀，clearRoot 用它过滤；注意分隔符是冒号，产品 ID 里不会有冒号 */
export function folderIndexPrefix(rootId: string): string {
  return `${rootId}:`;
}

export function createFolderIndex(kv: KeyValueStore<FolderIndexEntry>): FolderIndex {
  return {
    async get(rootId, platform, productId) {
      const entry = await kv.get(folderIndexKey(rootId, platform, productId));
      if (!entry || typeof entry.folderName !== 'string' || entry.folderName === '') return null;
      return entry;
    },
    async set(rootId, platform, productId, folderName) {
      await kv.set(folderIndexKey(rootId, platform, productId), {
        folderName,
        lastAt: Date.now(),
      });
    },
    async del(rootId, platform, productId) {
      await kv.del(folderIndexKey(rootId, platform, productId));
    },
    async clearRoot(rootId) {
      const prefix = folderIndexPrefix(rootId);
      const keys = await kv.keys();
      for (const key of keys) {
        if (key.startsWith(prefix)) await kv.del(key);
      }
    },
  };
}

/** 内存实现：单测用，也用于没有 IndexedDB 的降级场景 */
export function createMemoryFolderIndex(): FolderIndex {
  const map = new Map<string, FolderIndexEntry>();
  return createFolderIndex({
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    del: async (key) => {
      map.delete(key);
    },
    keys: async () => [...map.keys()],
  });
}

let defaultIndex: FolderIndex | null = null;

/** 默认实例：IndexedDB 的 folders 表（§6.5） */
export function folderIndex(): FolderIndex {
  if (!defaultIndex) {
    defaultIndex = createFolderIndex(storeAsKv<FolderIndexEntry>(STORAGE_KEYS.stores.folders));
  }
  return defaultIndex;
}
