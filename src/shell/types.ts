import type { ErrorCode } from '../kernel/errors/codes';
import type { JobRecord } from '../kernel/jobs/types';
import type { DirState } from '../kernel/messaging/protocol';
import type { ProductSnapshot } from '../kernel/model/product';

/** 工具箱三种形态（§10.2） */
export type ShellForm = 'hidden' | 'handle' | 'panel';

export interface ShellPrefs {
  /** 按站点记住的形态：用户在某个站点手动收起后，该站点改为只显示把手 */
  form?: ShellForm;
  /** 把手纵向位置 px，按站点记 */
  handleY?: number;
  /** 记住的功能标签 id */
  activeFeature?: string;
}

/** 页面侧识别状态机（§7.2） */
export type DetectStatus = 'idle' | 'detecting' | 'resolving' | 'ready' | 'blocked';

export interface DetectionState {
  status: DetectStatus;
  snapshot: ProductSnapshot | null;
  blocker: ErrorCode | null;
  /** 分辨率不够时标记 partial，UI 只显示「部分数据加载超时」 */
  completeness: 'full' | 'partial';
  platform?: string;
  pageKind?: string;
  productId?: string;
}

export interface ShellState {
  form: ShellForm;
  handleY: number;
  activeFeature: string | null;
  dir: DirState;
  job: JobRecord | null;
}
