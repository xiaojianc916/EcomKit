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

  const scheduler: Scheduler = {
    /**
     * 不再「每次 submit 全表 prune」（旧实现那样做）。
     *
     * 这张表里不会残留已结束的任务：finish() 在 done / failed / partial / canceled /
     * interrupted 五条收尾路径上都会把记录删掉（runner 里逐个核对过），
     * 而 submit 之后到 finish 之前，状态只会在 queued ↔ running 之间迁移。
     * 那次全表扫描永远扫不出东西，纯粹让「连点下载」变成 O(n)。
     * 万一真有陈旧记录（调用方自己把 status 改成终态却没调 finish），
     * 下面「已有记录但不再活跃」的分支会顺手覆盖掉它。
     */
    submit(job) {
      const existingId = byDedupeKey.get(job.dedupeKey);
      const existing = existingId === undefined ? undefined : jobs.get(existingId);
      if (existing && isActive(existing)) return { kind: 'duplicate', existing };
      // 走到这里说明 dedupeKey 上没有活跃任务：可能是一条陈旧的映射（防御性清理）
      if (existingId !== undefined) byDedupeKey.delete(job.dedupeKey);

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
      const out: JobRecord[] = [];
      for (const job of jobs.values()) if (job.status === 'queued') out.push(job);
      return out;
    },

    active() {
      const out: JobRecord[] = [];
      for (const job of jobs.values()) if (isActive(job)) out.push(job);
      return out;
    },

    nextRotation() {
      // 只建一次数组：旧实现建了两个（filter 出一个 + 拼出旋转后的另一个），
      // 而且每次都要复制两段。这里直接按轮转游标出序号，调用方拿到的是同一批记录。
      const list: JobRecord[] = [];
      for (const job of jobs.values()) if (isActive(job)) list.push(job);
      const size = list.length;
      if (size === 0) {
        cursor = 0;
        return list;
      }
      const start = cursor % size;
      cursor = (start + 1) % size;
      if (start === 0) return list;
      const ordered: JobRecord[] = new Array(size);
      for (let i = 0; i < size; i += 1) ordered[i] = list[(start + i) % size] as JobRecord;
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
