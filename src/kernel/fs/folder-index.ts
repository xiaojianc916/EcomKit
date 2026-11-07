import { createConcurrencyPool } from '../jobs/concurrency-pool';
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

/**
 * clearRoot 删除索引时的并发上限。
 * 这些都是彼此独立的删除（谁先谁后都不影响结果），但用户换目录时索引可能有几千条，
 * 一次性 Promise.all 会把几千个 IndexedDB 事务同时压进浏览器，比串行还慢。
 */
const CLEAR_CONCURRENCY = 32;

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
      // 删除彼此独立、无顺序要求，用有界并发而不是一个个串行等
      const pool = createConcurrencyPool(CLEAR_CONCURRENCY);
      // 并发池会吞掉任务异常，所以自己记第一个失败，等全部收尾后再抛：
      // 否则已经提交的删除会变成没人处理的 rejection。串行版本是「第一个失败即中止」，
      // 这里改成「先做完在跑的那批，再把第一个错误抛出去」，对外仍然是 reject。
      // 用 failed 布尔而不是「failure !== undefined」判断：抛出的值可能是 undefined
      let failed = false;
      let failure: unknown;
      for (const key of keys) {
        if (!key.startsWith(prefix)) continue;
        void pool.add(async () => {
          try {
            await kv.del(key);
          } catch (e) {
            if (!failed) {
              failed = true;
              failure = e;
            }
          }
        });
      }
      await pool.onIdle();
      if (failed) throw failure;
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
