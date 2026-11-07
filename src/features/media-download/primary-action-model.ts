import type { ErrorCode } from '../../kernel/errors/codes';
import { errorMessage } from '../../kernel/errors/messages';
import type { JobRecord } from '../../kernel/jobs/types';
import type { DirStatus } from '../../kernel/messaging/protocol';
import type { AssetKind } from '../../kernel/model/asset';
import { formatBytes, formatCount, formatDuration } from './format';

/**
 * 主按钮的文案与样式（§10.4「主按钮和附加说明」整张表）。
 *
 * 为什么做成纯函数：面板每 200ms 收一次进度，按钮文案要跟着状态变，
 * 而 §10.4 有十几行组合，散在组件里必然写漏。这里一次性把状态映射成
 * { 文案, 配色, 点击动作, 附加说明 }，组件只负责渲染（§10.9 最后一行）。
 *
 * 判定顺序（从上到下，命中即返回）：
 * 1. 识别中 —— 还没有素材，别的状态都不成立；
 * 2. 授权小窗已打开 —— 用户已经点了下载，此刻唯一能做的就是取消；
 * 3. 其他标签页在下载这个商品 —— 比本页任何状态都更该被看到；
 * 4. 本商品自己的任务 —— 进度/失败/取消/中断，用户正盯着这一块；
 * 5. 什么都没勾选 —— 任何下载动作的前提；
 * 6. 目录 —— needs-grant / gone / unset，目录不对时下载必然失败；
 * 7. 挑选模式 → 就绪（全部勾选 / 部分勾选）。
 *
 * 为什么“没勾选”排在目录前面：主按钮如果写“选择保存位置并下载”，
 * 而实际上没有任何素材可下，用户点完选择文件夹还是下不了，等于骗了一次点击。
 */

/** 按钮点击后要执行的动作，由组件翻译成具体的 api 调用 */
export type PrimaryActionKind =
  | 'none'
  | 'submit'
  | 'resume'
  | 'retry-failed'
  | 'verify'
  | 'open-grant'
  | 'cancel'
  | 'cancel-grant'
  | 'show-failures';

export interface PrimaryAction {
  kind: PrimaryActionKind;
}

export type PrimaryVariant = 'accent' | 'neutral' | 'progress';

export interface PrimaryActionModel {
  /** 主按钮文案；进度态下是进度条上的文案 */
  label: string;
  variant: PrimaryVariant;
  /** 按钮主体不可点（进度态下主体也不响应点击，§10.5 防误触） */
  disabled: boolean;
  action: PrimaryAction;
  /** 右侧的次要链接，只有进度态和等小窗时出现（“取消”） */
  secondary: { label: string; action: PrimaryAction } | null;
  /** 是否画细进度条（§10.1：细进度条加精确数字，不用转圈大动画） */
  progress: { done: number; total: number } | null;
  /** ⑦ 附加说明，最多两行（§10.3） */
  meta: string[];
  /** 附加说明里的可点动作，例如“查看”（§10.5 失败详情） */
  metaAction: { label: string; action: PrimaryAction } | null;
}

export interface PrimaryActionState {
  /** 页面识别状态（pageStore.status） */
  status: 'resolving' | 'ready';
  /** 目录状态（DirState.status） */
  dir: DirStatus;
  /** 各类别素材数量，0 也要给 key */
  counts: Record<AssetKind, number>;
  /** 已勾选的类别（全局偏好，§10.3 素材行交互） */
  selectedKinds: AssetKind[];
  /** 挑选模式选中单张素材的 key；空数组表示没有进入挑选模式 */
  selectedKeys: string[];
  /** 当前商品最新的任务 */
  job: JobRecord | null;
  /** 同一商品在其他标签页上的任务（§10.4 最后一行） */
  otherTabJob: JobRecord | null;
  /** 队列里排在这个任务前面的任务数 */
  queuedAhead: number;
  /** 授权小窗已经打开，等用户操作 */
  grantPending: boolean;
  /** 当前时间，显式传入以便单测不依赖系统时间 */
  now: number;
}

/** 下载完成后主按钮保持“已保存 N 个文件”的时长（§10.4 显示 3 秒） */
export const DONE_LABEL_TTL_MS = 3000;

/** 类别的中文叫法，用平台的叫法（§10.7 第 4 条） */
export const KIND_LABELS: Record<AssetKind, string> = {
  main: '主图',
  sku: 'SKU 图',
  detail: '详情图',
  video: '视频',
};

/** 面板里类别的固定顺序（和 §9.1 的目录顺序一致） */
export const KIND_ORDER: readonly AssetKind[] = ['main', 'sku', 'detail', 'video'];

/**
 * 中英文混排时补一个空格：「主图和 SKU 图」而不是「主图和SKU 图」。
 * 中文和西文之间留白是排版惯例，也让「SKU 图」不被挤在汉字里。
 */
function withGap(word: string): string {
  return /^[A-Za-z0-9]/.test(word) ? ` ${word}` : word;
}

/** 中文枚举：「主图和 SKU 图」「主图、SKU 图和详情图」 */
export function joinKindLabels(kinds: readonly AssetKind[]): string {
  const names = kinds.map((k) => KIND_LABELS[k]);
  if (names.length === 0) return '';
  const first = names[0] ?? '';
  if (names.length === 1) return first;
  const head = names.slice(0, -1).join('、');
  const tail = names[names.length - 1] ?? '';
  return `${head}和${withGap(tail)}`;
}

function orderedKinds(kinds: readonly AssetKind[]): AssetKind[] {
  return KIND_ORDER.filter((k) => kinds.includes(k));
}

function sumCounts(counts: Record<AssetKind, number>, kinds: readonly AssetKind[]): number {
  let total = 0;
  for (const k of kinds) total += counts[k] ?? 0;
  return total;
}

function jobCounts(j: JobRecord): { done: number; total: number; remain: number } {
  const done = j.done + j.skipped;
  return { done, total: j.total, remain: Math.max(j.total - done - j.failed.length, 0) };
}

/** 失败项按错误码归并成「网络不稳定（2）· 图片已失效（1）」，文案只从错误码查表（§6.2） */
export function groupFailureReasons(failed: readonly { code: ErrorCode }[]): string[] {
  const order: ErrorCode[] = [];
  const counter = new Map<ErrorCode, number>();
  for (const item of failed) {
    const hit = counter.get(item.code);
    if (hit === undefined) {
      order.push(item.code);
      counter.set(item.code, 1);
    } else {
      counter.set(item.code, hit + 1);
    }
  }
  return order.map((code) => `${errorMessage(code).title}（${counter.get(code) ?? 0}）`);
}

function completedMeta(j: JobRecord): string {
  const parts = [`跳过 ${j.skipped} 个`, formatBytes(j.bytes)];
  if (j.startedAt !== undefined && j.endedAt !== undefined && j.endedAt >= j.startedAt) {
    parts.push(`用时 ${formatDuration(j.endedAt - j.startedAt)}`);
  }
  return parts.join(' · ');
}

function progressModel(
  label: string,
  done: number,
  total: number,
  secondary: PrimaryActionModel['secondary'],
): PrimaryActionModel {
  return {
    label,
    variant: 'progress',
    disabled: true,
    action: { kind: 'none' },
    secondary,
    progress: { done, total },
    meta: [],
    metaAction: null,
  };
}

function failureModel(j: JobRecord): PrimaryActionModel {
  const reasons = groupFailureReasons(j.failed);
  const failedCount = j.failed.length;
  if (failedCount === 0) {
    // 整单失败（目录丢失、全部候选 404 等），没有逐项记录可展示
    return {
      label: '重试',
      variant: 'accent',
      disabled: false,
      action: { kind: 'retry-failed' },
      secondary: null,
      progress: null,
      meta: ['上次下载没有开始'],
      metaAction: null,
    };
  }
  return {
    label: `重试 ${failedCount} 个失败项`,
    variant: 'accent',
    disabled: false,
    action: { kind: 'retry-failed' },
    secondary: null,
    progress: null,
    // 多个原因之间用「·」连接，和 §10.4 表格里的写法一致；动作链接由组件在其后补「 · 查看」
    meta: reasons.length > 0 ? [reasons.join('·')] : [],
    metaAction: { label: '查看', action: { kind: 'show-failures' } },
  };
}

export function primaryActionModel(state: PrimaryActionState): PrimaryActionModel {
  const {
    status,
    dir,
    counts,
    selectedKinds,
    selectedKeys,
    job: currentJob,
    otherTabJob,
    queuedAhead,
    grantPending,
    now,
  } = state;

  // 1) 识别中（§10.4 第 1 行）
  if (status === 'resolving') {
    return {
      label: '正在识别商品…',
      variant: 'neutral',
      disabled: true,
      action: { kind: 'none' },
      secondary: null,
      progress: null,
      meta: [],
      metaAction: null,
    };
  }

  // 2) 在授权小窗里等用户操作（§10.4 第 9 行）
  if (grantPending) {
    return {
      label: '请在弹出的窗口中选择文件夹',
      variant: 'neutral',
      disabled: true,
      action: { kind: 'none' },
      secondary: { label: '取消', action: { kind: 'cancel-grant' } },
      progress: null,
      meta: [],
      metaAction: null,
    };
  }

  // 3) 同一商品正在其他标签页下载（§10.4 最后一行）
  if (
    otherTabJob &&
    (otherTabJob.status === 'running' || otherTabJob.status === 'queued') &&
    currentJob?.status !== 'running'
  ) {
    const c = jobCounts(otherTabJob);
    return progressModel(
      `正在其他标签页下载 ${formatCount(c.done, c.total)}`,
      c.done,
      c.total,
      null,
    );
  }

  // 4) 本商品自己的任务（§10.4 第 10–15 行）
  if (currentJob) {
    const c = jobCounts(currentJob);
    switch (currentJob.status) {
      case 'running':
        return progressModel(
          `下载中 ${formatCount(c.done, c.total)} · ${formatBytes(currentJob.bytes)}`,
          c.done,
          c.total,
          { label: '取消', action: { kind: 'cancel' } },
        );
      case 'queued': {
        const ahead = Math.max(queuedAhead, 0);
        return progressModel(
          ahead > 0 ? `排队中 · 前面还有 ${ahead} 个任务` : '排队中',
          c.done,
          c.total,
          { label: '取消', action: { kind: 'cancel' } },
        );
      }
      case 'done': {
        const endedAt = currentJob.endedAt ?? now;
        // 完成后只显示 3 秒“已保存 N 个文件”，之后落回挑选模式/就绪（§10.4）
        if (now - endedAt <= DONE_LABEL_TTL_MS) {
          // 跳过的文件也是「已经在磁盘上了」：重复下载时 done=0、skipped=20，
          // 只数 done 会显示「已保存 0 个文件」，看起来像什么都没做。
          const saved = currentJob.done + currentJob.skipped;
          return {
            label: `已保存 ${saved} 个文件`,
            variant: 'neutral',
            disabled: true,
            action: { kind: 'none' },
            secondary: null,
            progress: null,
            meta: [completedMeta(currentJob)],
            metaAction: null,
          };
        }
        break;
      }
      case 'partial':
      case 'failed':
        return failureModel(currentJob);
      case 'canceled':
        return {
          label: c.remain > 0 ? `继续下载（剩余 ${c.remain} 个）` : '继续下载',
          variant: 'accent',
          disabled: false,
          action: { kind: 'resume' },
          secondary: null,
          progress: null,
          meta: [],
          metaAction: null,
        };
      case 'interrupted':
        return {
          label: '继续下载',
          variant: 'accent',
          disabled: false,
          action: { kind: 'resume' },
          secondary: null,
          progress: null,
          meta: ['上次下载中断了'],
          metaAction: null,
        };
    }
  }

  const selected = orderedKinds(selectedKinds);
  // 下面的「有素材的类别是不是都勾上了」要逐个查 selected：先建一次 Set 复用，
  // 因为 every 里每次 includes() 都要扫一遍整个数组。
  const selectedSet = new Set<AssetKind>(selected);
  const selectedTotal = sumCounts(counts, selected);
  const picking = selectedKeys.length > 0;
  const kindsWithAssets = KIND_ORDER.filter((k) => (counts[k] ?? 0) > 0);

  // 5) 没有勾选任何类别（§10.4 第 5 行）
  if (!picking && (selected.length === 0 || selectedTotal === 0)) {
    return {
      label: '请先勾选要下载的素材',
      variant: 'neutral',
      disabled: true,
      action: { kind: 'none' },
      secondary: null,
      progress: null,
      meta: [],
      metaAction: null,
    };
  }

  // 6) 目录状态（§10.4 第 6–8 行）
  if (dir === 'needs-grant') {
    return {
      label: '允许访问并下载',
      variant: 'accent',
      disabled: false,
      action: { kind: 'open-grant' },
      secondary: null,
      progress: null,
      meta: ['浏览器重启后需要确认一次'],
      metaAction: null,
    };
  }

  if (dir === 'gone') {
    return {
      label: '重新选择保存位置',
      variant: 'accent',
      disabled: false,
      action: { kind: 'open-grant' },
      secondary: null,
      progress: null,
      // 目录名由外壳提供，这里只说事实和下一步（§10.7 第 3 条）
      meta: ['找不到「电商素材」文件夹'],
      metaAction: null,
    };
  }

  if (dir === 'unset') {
    return {
      label: '选择保存位置并下载',
      variant: 'accent',
      disabled: false,
      action: { kind: 'open-grant' },
      secondary: null,
      progress: null,
      meta: [],
      metaAction: null,
    };
  }

  // 7) 挑选模式（§10.4 第 4 行）
  if (picking) {
    return {
      label: `下载所选 ${selectedKeys.length} 个`,
      variant: 'accent',
      disabled: false,
      action: { kind: 'submit' },
      secondary: null,
      progress: null,
      meta: [],
      metaAction: null,
    };
  }

  // 8) 就绪（§10.4 第 2–3 行）
  if (kindsWithAssets.length > 0 && kindsWithAssets.every((k) => selectedSet.has(k))) {
    return {
      label: `下载 ${selectedTotal} 个文件`,
      variant: 'accent',
      disabled: false,
      action: { kind: 'submit' },
      secondary: null,
      progress: null,
      meta: [],
      metaAction: null,
    };
  }

  return {
    label: `下载${joinKindLabels(selected)} · ${selectedTotal} 个`,
    variant: 'accent',
    disabled: false,
    action: { kind: 'submit' },
    secondary: null,
    progress: null,
    meta: [],
    metaAction: null,
  };
}
