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

/**
 * 落盘前瘦身：**payload 不进镜像**。
 *
 * payload 是整份商品快照（标题 + 几十上百个素材 URL + candidates + SKU 列表，
 * 一个商品几十 KB 到几百 KB），而 chrome.storage.session 的配额只有 10MB ——
 * 几个商品并行下载就能写爆，写爆之后 write() 只能静默失败，
 * 症状正是「浏览器重开后任务列表全空、正在下的任务全丢」，也就是镜像要防的那件事。
 * 恢复出来的记录只用于「显示 + 让用户点继续下载」，payload 由页面重新提交时带上。
 */
function slimForStorage(jobs: readonly JobRecord[]): JobRecord[] {
  const out: JobRecord[] = new Array(jobs.length);
  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i] as JobRecord;
    out[i] = job.payload == null ? job : { ...job, payload: null };
  }
  return out;
}

/** 解析镜像；结构不对时返回空数组（宁可丢镜像，也不要让 SW 启动崩掉） */
export function parseMirror(raw: unknown): JobRecord[] {
  if (!raw || typeof raw !== 'object') return [];
  const mirror = raw as Partial<JobMirror>;
  if (!Array.isArray(mirror.jobs)) return [];
  return mirror.jobs.filter(isJobRecordLike);
}

/**
 * 宽松校验：只要关键字段类型对就认，避免版本升级时把旧镜像全丢掉。
 *
 * 但「关键字段」要跟**真正读它们的地方**对齐：旧版只验到 total/done/failed，
 * 而面板渲染一行时会直接读 byGroup[kind]、skipped、bytes（asset-row-model.ts、page.tsx）。
 * 缺这些字段的记录漏进来，渲染那一行就是 TypeError —— 整个面板白屏，
 * 比丢一条镜像严重得多。所以补验这三项；旧镜像里确实没有的，就只有这一条被丢掉。
 */
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
    typeof job.skipped === 'number' &&
    typeof job.bytes === 'number' &&
    Array.isArray(job.failed) &&
    job.byGroup !== null &&
    typeof job.byGroup === 'object'
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
        await getArea().set({ [key]: buildMirror(slimForStorage(jobs)) });
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
      /**
       * 只有真的标出了 interrupted 才写回，而且写回的必须是**完整列表**。
       *
       * 旧实现是「offscreen 不在就写，且写回 filter 掉 interrupted 的列表」——
       * 恰好把刚标成 interrupted 的那几条从镜像里删掉。于是「浏览器重启 →
       * 面板重新挂载」时中断的任务一条都不剩，用户永远看不到「下载中断 · 继续」，
       * 已经下了一半的文件也被当成没下过。interrupted 正是这里要保留的状态。
       */
      const changed = fixed.some((job, i) => job !== jobs[i]);
      if (changed) await this.write(fixed);
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
