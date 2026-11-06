import type { ErrorCode } from '../errors/codes';
import type { ItemResult, JobRecord, JobStatus, WorkItem } from './types';

/**
 * JobRecord 的进度聚合（方案 §6.4）。
 *
 * 全部是**纯函数**：这是任务系统里最容易被并发写坏的地方 —— 每完成一个工作项要同时更新
 * done / skipped / bytes 和 byGroup 四组计数，一旦哪里算错，UI 上的「23/48」就永远对不上。
 * 隔离成纯函数之后，每一种状态迁移都能单测覆盖，runner 只管按顺序调用。
 */

/** 单个分组在 UI 上的一行（§10.3 素材清单每行） */
export interface GroupProgress {
  total: number;
  done: number;
  failed: number;
  skipped: number;
}

export type ByGroup = Record<string, GroupProgress>;

function emptyGroup(): GroupProgress {
  return { total: 0, done: 0, failed: 0, skipped: 0 };
}

/** 按工作项的 group 统计计划总数（plan 完成后调用一次） */
export function initByGroup(items: readonly WorkItem[]): ByGroup {
  const out: ByGroup = {};
  for (const item of items) {
    // 就地累加：一个 500 张详情图的任务只有 4 个分组，没必要为每张图重建一次分组对象
    const current = out[item.group];
    if (current) current.total += 1;
    else out[item.group] = { total: 1, done: 0, failed: 0, skipped: 0 };
  }
  return out;
}

/** 建一个全新的任务记录（提交时调用，状态 queued） */
export function createJobRecord(input: {
  id: string;
  type: string;
  dedupeKey: string;
  payload: unknown;
  items?: readonly WorkItem[];
  label?: string;
  tabId?: number;
  now?: number;
}): JobRecord {
  const items = input.items ?? [];
  return {
    id: input.id,
    type: input.type,
    dedupeKey: input.dedupeKey,
    payload: input.payload,
    status: 'queued',
    total: items.length,
    done: 0,
    skipped: 0,
    bytes: 0,
    failed: [],
    byGroup: initByGroup(items),
    createdAt: input.now ?? Date.now(),
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
  };
}

/** 兼容写法：已有工作项列表时建记录 */
export function createEmptyRecord(base: {
  id: string;
  type: string;
  dedupeKey: string;
  payload: unknown;
  items: readonly WorkItem[];
  tabId?: number;
  label?: string;
}): JobRecord {
  return createJobRecord(base);
}

/** plan 完成、开始执行时调用：写入 total 和 byGroup，状态转 running（§6.4） */
export function markStarted(
  record: JobRecord,
  items: readonly WorkItem[],
  now = Date.now(),
): JobRecord {
  return {
    ...record,
    status: 'running',
    total: items.length,
    startedAt: now,
    byGroup: initByGroup(items),
  };
}

/**
 * 一个工作项结束时的增量更新。返回**新对象**，不改入参（UI 靠浅比较判断是否重渲染）。
 * byGroup 里每行的 total 是该组计划总数，done/failed/skipped 是该组完成情况，
 * UI 用这两个数直接画「3/8」。
 */
export function applyItemResult(record: JobRecord, item: WorkItem, result: ItemResult): JobRecord {
  const current = record.byGroup[item.group] ?? emptyGroup();

  let done = record.done;
  let skipped = record.skipped;
  let bytes = record.bytes;
  // 只有真的多了一条失败记录时才复制数组：500 项全失败时，
  // 旧实现每条结果都复制一遍整个 failed，总复制量是 500²/2 = 12.5 万次
  let failed = record.failed;
  let groupDone = current.done;
  let groupSkipped = current.skipped;
  let groupFailed = current.failed;

  switch (result.status) {
    case 'ok':
      done += 1;
      groupDone += 1;
      bytes += result.bytes ?? result.size ?? 0;
      break;
    case 'skipped':
      skipped += 1;
      groupSkipped += 1;
      break;
    case 'failed':
      groupFailed += 1;
      if (result.code) failed = [...failed, { itemKey: item.itemKey, code: result.code }];
      break;
  }

  return {
    ...record,
    done,
    skipped,
    bytes,
    failed,
    byGroup: {
      ...record.byGroup,
      [item.group]: {
        total: current.total,
        done: groupDone,
        failed: groupFailed,
        skipped: groupSkipped,
      },
    },
  };
}

/**
 * 失败项重跑成功后，把它的失败记录和该组计数一起摘掉。
 * 不摘的话失败数会虚高：用户看到「失败 3 个」，但实际上已经补完了（§10.4 主按钮文案靠这个数）。
 */
export function clearFailure(record: JobRecord, item: WorkItem): JobRecord {
  const index = record.failed.findIndex((f) => f.itemKey === item.itemKey);
  if (index < 0) return record;
  const failed = [...record.failed];
  failed.splice(index, 1);
  const current = record.byGroup[item.group];
  if (!current) return { ...record, failed };
  return {
    ...record,
    failed,
    byGroup: {
      ...record.byGroup,
      [item.group]: { ...current, failed: Math.max(0, current.failed - 1) },
    },
  };
}

/**
 * 任务结束时的状态判定（§6.4 的 status 枚举）：
 *   没有失败 → done（有跳过也算完成）
 *   有失败但也有成功 → partial
 *   全失败 → failed
 */
export function computeFinalStatus(record: JobRecord): JobStatus {
  const failedCount = record.failed.length;
  const successCount = record.done + record.skipped;
  if (failedCount === 0) return 'done';
  if (successCount === 0) return 'failed';
  return 'partial';
}

/** 别名：语义更短，供调用方按需选 */
export const finalStatus = computeFinalStatus;

/** 收尾：写 endedAt 和最终状态 */
export function markEnded(record: JobRecord, status?: JobStatus, now = Date.now()): JobRecord {
  return { ...record, status: status ?? computeFinalStatus(record), endedAt: now };
}

/** 兼容写法：finishRecord(record, canceled) */
export function finishRecord(record: JobRecord, canceled = false, now = Date.now()): JobRecord {
  return markEnded(record, canceled ? 'canceled' : computeFinalStatus(record), now);
}

/** 取消 / 中断（SW 回收后恢复出来的 running 任务，§6.4） */
export function markStopped(
  record: JobRecord,
  status: 'canceled' | 'interrupted',
  now = Date.now(),
): JobRecord {
  return { ...record, status, endedAt: now };
}

/** 已处理的工作项数（含失败，失败也是一次处理） */
export function processedCount(record: JobRecord): number {
  return record.done + record.skipped + record.failed.length;
}

/** 完成比例 0–1，进度条用。total 为 0 时不除零 */
export function progressRatio(record: JobRecord): number {
  if (record.total <= 0) return 0;
  return Math.min(1, processedCount(record) / record.total);
}

/** 百分比整数 0–100，UI 文案用 */
export function percentOf(record: JobRecord): number {
  return Math.round(progressRatio(record) * 100);
}

/** 任务是否已经结束（不再接受进度更新） */
export function isTerminal(status: JobStatus): boolean {
  return (
    status === 'done' ||
    status === 'partial' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'interrupted'
  );
}

/** 失败列表按错误码聚合，UI 的失败区按错误分组显示（§10.4） */
export function failureSummary(record: JobRecord): Array<{ code: ErrorCode; count: number }> {
  const counts = new Map<ErrorCode, number>();
  for (const item of record.failed) counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
  return [...counts.entries()].map(([code, count]) => ({ code, count }));
}
