import { STORAGE_KEYS } from '../storage/keys';
import type { JobRecord } from './types';

/**
 * 任务镜像（方案 §6.4「崩溃恢复」、§6.5）。
 *
 * SW 随时会被回收，任务真相源在 offscreen。为了让 SW 重启后还能回答「现在有哪些任务」，
 * 每次进度变化都往 storage.session 写一份镜像 —— session 在浏览器关闭时自动清空，
 * 正好符合「这些任务只活在这次会话里」的语义。
 *
 * 恢复流程（§6.4）：读回镜像 → 用 chrome.runtime.getContexts 检查 offscreen 还在不在
 * → 不在的话把 running 的任务标成 interrupted，UI 显示「下载中断 · 继续」。
 */

export const MIRROR_VERSION = 1;

export interface JobMirror {
  v: number;
  at: number;
  jobs: JobRecord[];
}

/** 把 JobRecord 数组打包成镜像结构 */
export function buildMirror(jobs: readonly JobRecord[], now = Date.now()): JobMirror {
  return { v: MIRROR_VERSION, at: now, jobs: [...jobs] };
}

/** 解析镜像；结构不对时返回空数组（宁可丢镜像，也不要让 SW 启动崩掉） */
export function parseMirror(raw: unknown): JobRecord[] {
  if (!raw || typeof raw !== 'object') return [];
  const mirror = raw as Partial<JobMirror>;
  if (!Array.isArray(mirror.jobs)) return [];
  return mirror.jobs.filter(isJobRecordLike);
}

/** 宽松校验：只要关键字段类型对就认，避免版本升级时把旧镜像全丢掉 */
export function isJobRecordLike(value: unknown): value is JobRecord {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<JobRecord>;
  return (
    typeof job.id === 'string' &&
    typeof job.type === 'string' &&
    typeof job.status === 'string' &&
    typeof job.dedupeKey === 'string' &&
    typeof job.total === 'number' &&
    typeof job.done === 'number' &&
    Array.isArray(job.failed)
  );
}

/**
 * 把镜像里「状态是 running、但 offscreen 已经不在了」的任务标成 interrupted。
 * 为什么不标 failed：用户点「继续」还能接着下（.ecbox.json 会跳过已完成的文件，§9.11）。
 */
export function markInterrupted(
  jobs: readonly JobRecord[],
  offscreenAlive: boolean,
  now = Date.now(),
): JobRecord[] {
  if (offscreenAlive) return [...jobs];
  return jobs.map((job) =>
    job.status === 'running' || job.status === 'queued'
      ? { ...job, status: 'interrupted' as const, endedAt: now }
      : job,
  );
}

export interface MirrorStore {
  read(): Promise<JobRecord[]>;
  write(jobs: readonly JobRecord[]): Promise<void>;
  clear(): Promise<void>;
  /** 读镜像 + 判断 offscreen 是否还在 → 返回已修正的列表（并写回） */
  recover(offscreenAlive: boolean): Promise<JobRecord[]>;
}

/** storage.session 的最小面，单测注入内存实现 */
export interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

function defaultSessionArea(): SessionArea {
  const area = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.session;
  if (!area) throw new Error('chrome.storage.session 不可用');
  return {
    get: (key) => area.get(key),
    set: (items) => area.set(items),
    remove: (key) => area.remove(key),
  };
}

export function createMirrorStore(options: { area?: SessionArea; key?: string } = {}): MirrorStore {
  const key = options.key ?? STORAGE_KEYS.jobMirror;
  let area: SessionArea | null = options.area ?? null;

  function getArea(): SessionArea {
    if (!area) area = defaultSessionArea();
    return area;
  }

  return {
    async read() {
      try {
        const bag = await getArea().get(key);
        return parseMirror(bag[key]);
      } catch {
        return [];
      }
    },
    async write(jobs) {
      try {
        await getArea().set({ [key]: buildMirror(jobs) });
      } catch {
        // 写镜像失败不影响任务本身，下一轮还会再写
      }
    },
    async clear() {
      try {
        await getArea().remove(key);
      } catch {
        /* 忽略 */
      }
    },
    async recover(offscreenAlive) {
      const jobs = await this.read();
      const fixed = markInterrupted(jobs, offscreenAlive);
      if (!offscreenAlive) await this.write(fixed.filter((j) => j.status !== 'interrupted'));
      return fixed;
    },
  };
}

/** 内存实现，单测用 */
export function createMemorySessionArea(): SessionArea {
  const data = new Map<string, unknown>();
  return {
    async get(key) {
      const out: Record<string, unknown> = {};
      if (data.has(key)) out[key] = data.get(key);
      return out;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
  };
}
