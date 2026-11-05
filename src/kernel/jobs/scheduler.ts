import type { JobRecord } from './types';

/**
 * 任务排队与去重（方案 §6.4）。
 *
 * 核心规则：**同一个 dedupeKey 同一时间只允许一个任务**。
 * 用户连点两次下载、或者三个标签页打开同一个商品时，后来的提交要接到已有任务的进度上，
 * 而不是把同一批文件下三遍。「轮转」的具体做法在 runner 里，这里只维护顺序和去重。
 */

export type SchedulerResult =
  | { kind: 'accepted'; job: JobRecord }
  | { kind: 'duplicate'; existing: JobRecord };

export interface Scheduler {
  /** 提交任务；dedupeKey 冲突时返回已有任务 */
  submit(job: JobRecord): SchedulerResult;
  /** 任务结束后释放 dedupeKey（成功/失败/取消都要调） */
  finish(jobId: string): void;
  findByDedupeKey(dedupeKey: string): JobRecord | undefined;
  /** 排队中（还没开始执行）的任务，FIFO */
  pending(): JobRecord[];
  /** 当前活跃（排队 + 执行中）的任务 */
  active(): JobRecord[];
  /** 轮转顺序：从上次结束的位置继续，保证每个任务都有机会被取到工作项 */
  nextRotation(): JobRecord[];
  clear(): void;
}

function isActive(job: JobRecord): boolean {
  return job.status === 'queued' || job.status === 'running';
}

export function createScheduler(): Scheduler {
  const jobs = new Map<string, JobRecord>();
  const byDedupeKey = new Map<string, string>();
  let cursor = 0;

  function prune(): void {
    for (const [jobId, job] of jobs) {
      if (!isActive(job)) {
        jobs.delete(jobId);
        if (byDedupeKey.get(job.dedupeKey) === jobId) byDedupeKey.delete(job.dedupeKey);
      }
    }
  }

  const scheduler: Scheduler = {
    submit(job) {
      prune();
      const existingId = byDedupeKey.get(job.dedupeKey);
      const existing = existingId === undefined ? undefined : jobs.get(existingId);
      if (existing && isActive(existing)) return { kind: 'duplicate', existing };

      jobs.set(job.id, job);
      byDedupeKey.set(job.dedupeKey, job.id);
      return { kind: 'accepted', job };
    },

    finish(jobId) {
      const job = jobs.get(jobId);
      if (!job) return;
      jobs.delete(jobId);
      if (byDedupeKey.get(job.dedupeKey) === jobId) byDedupeKey.delete(job.dedupeKey);
      if (cursor >= jobs.size) cursor = 0;
    },

    findByDedupeKey(dedupeKey) {
      const jobId = byDedupeKey.get(dedupeKey);
      return jobId === undefined ? undefined : jobs.get(jobId);
    },

    pending() {
      return [...jobs.values()].filter((job) => job.status === 'queued');
    },

    active() {
      return [...jobs.values()].filter(isActive);
    },

    nextRotation() {
      const list = [...jobs.values()].filter(isActive);
      if (list.length === 0) return [];
      const start = cursor % list.length;
      const ordered = [...list.slice(start), ...list.slice(0, start)];
      cursor = (cursor + 1) % list.length;
      return ordered;
    },

    clear() {
      jobs.clear();
      byDedupeKey.clear();
      cursor = 0;
    },
  };

  return scheduler;
}
