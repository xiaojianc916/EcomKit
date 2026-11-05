import type { ErrorCode } from '../errors/codes';
import type { JobRecord } from '../jobs/types';
import type { ProductSnapshot } from '../model/product';

export type DirStatus = 'unset' | 'needs-grant' | 'gone' | 'ready';

export interface DirState {
  status: DirStatus;
  name?: string;
}

export interface JobSubmit {
  type: string;
  tabId?: number;
  /** 已校验过的 payload */
  payload: unknown;
  dedupeKey: string;
  /** UI 上用来显示“下载 48 个文件” */
  label?: string;
}

export type SubmitResult = { jobId: string } | { waiting: 'dir' } | { duplicateOf: string };

export interface TabState {
  tabId: number;
  url: string;
  matched: boolean;
  pageKind?: string;
  platform?: string;
  /** URL 里解析出的商品 ID：识别完成前 snapshot 还没有，popup 先显示它 */
  productId?: string;
  snapshot?: ProductSnapshot;
  status: 'idle' | 'detecting' | 'resolving' | 'ready' | 'blocked';
  blocker?: ErrorCode;
  dir: DirState;
  job?: JobRecord;
}

export interface HistoryState {
  lastAt: number;
  /** 和当前快照比较后缺哪些 itemKey */
  missing: string[];
  total: number;
}

/** @webext-core/messaging 的协议表（§6.3） */
export interface ProtocolMap {
  // page / popup / options / grant → bg
  'shell.getTabState'(p: { tabId: number }): TabState;
  'shell.pushTabState'(p: TabState): void;
  'fs.status'(): DirState;
  'fs.openGrant'(p: { reason: 'unset' | 'needs-grant' | 'gone' | 'change'; tabId?: number }): void;
  'fs.changed'(p: DirState): void;
  'job.submit'(p: JobSubmit): SubmitResult;
  'job.cancel'(p: { jobId: string }): void;
  'job.retry'(p: { jobId: string; only: 'failed' }): { jobId: string };
  'job.list'(p: { tabId?: number }): JobRecord[];
  'feature.call'(p: { feature: string; method: string; args: unknown }): unknown;
  'shell.togglePanel'(p: { tabId: number }): void;
  'shell.openOptions'(): void;
  'shell.mobileMode'(p: { tabId: number }): void;
  'shell.diagnostics'(): { json: string };

  /** 授权小窗：读取本次打开的模式（§9.4） */
  'grant.getInit'(): { mode: 'unset' | 'needs-grant' | 'gone' | 'change'; currentName?: string };
  /** 授权小窗：把用户选中的句柄交给 bg 落库 */
  'grant.persist'(p: { handle: FileSystemDirectoryHandle }): void;
  /** 授权小窗：取回上次存的句柄，用于 requestPermission */
  'grant.getHandle'(): FileSystemDirectoryHandle | null;
  /** 授权小窗：自己关掉（用户取消） */
  'grant.close'(): void;

  // bg ↔ offscreen
  'engine.enqueue'(p: { job: JobRecord; payload: unknown }): void;
  'engine.cancel'(p: { jobId: string }): void;
  'engine.fsStatus'(): DirState;
  'engine.fsChanged'(): DirState;
  'engine.call'(p: { feature: string; method: string; args: unknown }): unknown;
  'engine.event'(p: JobEventPayload): void;
  'engine.ready'(): void;
}

export type JobEventPayload =
  | { type: 'progress'; job: JobRecord }
  | { type: 'done'; job: JobRecord }
  | { type: 'item-failed'; jobId: string; itemKey: string; code: ErrorCode };

/** Job Port 消息（每个 Tab 一个长连接，§6.3） */
export type PortMessage =
  | { type: 'job-progress'; job: JobRecord }
  | { type: 'job-done'; job: JobRecord }
  | { type: 'dir-changed'; dir: DirState }
  | { type: 'panel-toggle' };
