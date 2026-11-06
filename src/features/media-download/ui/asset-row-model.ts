import type { ErrorCode } from '../../../kernel/errors/codes';
import type { JobRecord } from '../../../kernel/jobs/types';
import type { Asset, AssetKind } from '../../../kernel/model/asset';
import { formatCount } from '../format';

/**
 * 素材行的「右半部分」状态（§10.4「素材行」整张表）。
 *
 * 和主按钮一样做成纯函数：这一行有 8 种状态，散在组件里必然漏。
 * 组件只负责把这里给的文字和形态画出来。
 */

export type AssetRowStatus =
  | { kind: 'resolving' }
  | { kind: 'ready' }
  | { kind: 'progress'; done: number; total: number }
  | { kind: 'done'; count: number }
  | { kind: 'partial'; done: number; total: number; failed: number }
  | { kind: 'skipped'; count: number }
  | { kind: 'empty' };

export interface AssetRowModel {
  status: AssetRowStatus;
  /**
   * 数字文字，等宽显示。null 表示**不显示**。
   *
   * 就绪态返回 null：那一格原来写的是「这一类有几张」，而右边缩略图条的 +N
   * 已经把这件事说清楚了（4 张图 + 「+5」就是 9 张），再放一个数字只是重复。
   * 只有承载**进度信息**的状态（12/26、24/26 · 2 个失败、✓ 26）才需要数字。
   */
  countText: string | null;
  /** 右侧是否有行内“下载”文字按钮（§10.3 ④） */
  showDownload: boolean;
  /** 右侧是否有“重试”文字按钮（§10.4 部分失败） */
  showRetry: boolean;
}

export interface AssetRowStateInput {
  kind: AssetKind;
  /** 这一类在快照里的素材数 */
  total: number;
  /** 挑选模式下已选的数量；0 表示没在挑选 */
  selectedCount: number;
  /** 页面是否还在识别 */
  resolving: boolean;
  /** 整个任务（byGroup 里取这一类） */
  job: JobRecord | null;
  /** 已保存记录里这一类已有的文件数（§9.11 跳过） */
  skippedCount: number;
}

/** 从 JobRecord.byGroup 里取这一类的进度（§6.4 进度聚合） */
export function groupProgress(
  job: JobRecord | null,
  kind: AssetKind,
): { total: number; done: number; failed: number; skipped: number } | null {
  if (job === null) return null;
  const group = job.byGroup[kind];
  if (group === undefined) return null;
  return group;
}

function failedOf(job: JobRecord | null, kind: AssetKind): number {
  if (job === null) return 0;
  // 优先用 byGroup；早期任务可能还没聚合，退回到 failed 里按 itemKey 前缀数
  const group = job.byGroup[kind];
  if (group !== undefined) return group.failed;
  return job.failed.filter((f) => f.itemKey.startsWith(`${kind}:`)).length;
}

/**
 * 素材行的状态。
 *
 * 判定顺序（照 §10.4 素材行表从上到下）：
 * 识别中 → 本类在下载 → 完成/部分失败/跳过 → 有失败项 → 空类别 → 就绪。
 *
 * 为什么“识别中”最优先：那时连数量都不知道，显示任何数字都是错的。
 */
export function assetRowModel(input: AssetRowStateInput): AssetRowModel {
  const { total, selectedCount, resolving, job, kind, skippedCount } = input;

  if (resolving) {
    return { status: { kind: 'resolving' }, countText: '—', showDownload: false, showRetry: false };
  }

  // 数量为 0 的行置灰、显示“无”、复选框禁用（§10.3 ④、§8.4）
  if (total === 0) {
    return { status: { kind: 'empty' }, countText: '无', showDownload: false, showRetry: false };
  }

  const group = groupProgress(job, kind);

  // 排队中 / 下载中：缩略图条换成细进度条加 12/26（§10.4）
  if (job !== null && group !== null && (job.status === 'running' || job.status === 'queued')) {
    const done = group.done + group.skipped;
    if (done > 0 || job.status === 'running') {
      return {
        status: { kind: 'progress', done, total: group.total },
        countText: formatCount(done, group.total),
        showDownload: false,
        showRetry: false,
      };
    }
  }

  const failed = failedOf(job, kind);

  // 部分失败：24/26 · 2 个失败，加“重试”（§10.4）
  if (job !== null && (job.status === 'partial' || job.status === 'failed') && failed > 0) {
    const done = group === null ? Math.max(total - failed, 0) : group.done + group.skipped;
    const groupTotal = group?.total ?? total;
    return {
      status: { kind: 'partial', done, total: groupTotal, failed },
      countText: `${formatCount(done, groupTotal)} · ${failed} 个失败`,
      showDownload: false,
      showRetry: true,
    };
  }

  // 完成：✓ 26（对勾是中性深灰，不用绿色，§10.4）
  if (job !== null && job.status === 'done' && group !== null) {
    const done = group.done + group.skipped;
    if (skippedCount > 0 && done >= group.total) {
      return {
        status: { kind: 'skipped', count: done },
        countText: `✓ ${done} · 已存在`,
        showDownload: true,
        showRetry: false,
      };
    }
    return {
      status: { kind: 'done', count: done },
      countText: `✓ ${done}`,
      showDownload: true,
      showRetry: false,
    };
  }

  // 挑选模式下这一行的数量变成 3/26（§10.3 素材行交互）
  if (selectedCount > 0) {
    return {
      status: { kind: 'ready' },
      countText: formatCount(selectedCount, total),
      showDownload: true,
      showRetry: false,
    };
  }

  // 就绪：不显示数字（缩略图条上的 +N 已经表达了总数）
  return {
    status: { kind: 'ready' },
    countText: null,
    showDownload: true,
    showRetry: false,
  };
}

/**
 * 行名称后面的小字标签（§10.4 素材行最后两行）：
 * - 「页面解析」：这一类的素材里至少有一个是 DOM 兜底补出来的（§7.3）
 * - 「H.265」：视频行里只有 H.265 编码时才标（§9.9 Windows 关键点）
 */
export function rowTags(assets: readonly Asset[], kind: AssetKind): string[] {
  const tags: string[] = [];
  if (assets.some((a) => a.fromDom === true)) tags.push('页面解析');
  if (kind === 'video' && assets.length > 0 && assets.every((a) => a.video?.codec === 'h265')) {
    tags.push('H.265');
  }
  return tags;
}

/**
 * 行内缩略图条最多显示 4 张，其余用「+N」（§10.3 ④）。
 * 返回要显示的那些素材和剩余数量。
 */
export function previewAssets<T>(assets: readonly T[], max = 4): { shown: T[]; rest: number } {
  return { shown: assets.slice(0, max), rest: Math.max(assets.length - max, 0) };
}

/**
 * 这一类里被选中的素材数（挑选模式半选判断用）。
 *
 * 单独抽出来是为了能利用「选中集合比这一类素材少」这个事实：AssetList 每行都要算一次，
 * 而 200 多张详情图 × 每 200ms 一次进度推送时，assets.filter() 的常驻成本并不低。
 * 顺带注意这里**不去重**：assets 里的 key 在快照里本就唯一（planner 也依赖这一点）。
 */
export function selectedCountOf(
  assets: readonly Asset[],
  selectedKeys: ReadonlySet<string>,
): number {
  if (selectedKeys.size === 0) return 0;
  let count = 0;
  for (const asset of assets) {
    if (selectedKeys.has(asset.key)) count += 1;
  }
  return count;
}

/** 单个素材的失败原因（失败列表用，§10.5 失败详情） */
export interface FailureEntry {
  itemKey: string;
  code: ErrorCode;
}

/** 失败列表按类别归组，方便显示在对应行下面 */
export function failuresByKind(failed: readonly FailureEntry[]): Map<AssetKind, FailureEntry[]> {
  const out = new Map<AssetKind, FailureEntry[]>();
  for (const entry of failed) {
    const kind = entry.itemKey.split(':')[0];
    if (kind !== 'main' && kind !== 'sku' && kind !== 'detail' && kind !== 'video') continue;
    const list = out.get(kind);
    if (list) list.push(entry);
    else out.set(kind, [entry]);
  }
  return out;
}
