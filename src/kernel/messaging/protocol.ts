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
  /**
   * 授权小窗：句柄已存进 IndexedDB，通知 bg 刷新状态。
   * **不携带句柄本身** —— FileSystemDirectoryHandle 过 runtime 消息会退化成没有方法的空对象
   * （已实测），所以句柄只能由小窗自己存、由各上下文各自从 IndexedDB 读。
   */
  'grant.persisted'(p: { name: string }): void;
  /** 授权小窗：自己关掉（用户取消） */
  'grant.close'(): void;

  // bg ↔ offscreen
  'engine.enqueue'(p: { job: JobRecord; payload: unknown }): void;
  /**
   * offscreen → bg：要一份设置。
   *
   * **offscreen 文档里没有 chrome.storage**（Chrome 只给它 chrome.runtime），
   * 所以引擎不能自己读设置，必须由 bg 代读。旧实现直接在 offscreen 里调
   * wxt 的 storage，一上来就抛 "You must add the 'storage' permission"，
   * 引擎永远起不来 → 目录状态永远是 unset → 点下载只会弹授权窗，看起来像没反应。
   */
  'engine.settings'(): unknown;
  /** bg → offscreen：设置变了，重新应用（保存方式 / 并发数） */
  'engine.settingsChanged'(p: unknown): void;
  /**
   * offscreen → bg：把引擎日志转进 bg 的日志缓冲。
   * offscreen 的 console 不在任何 DevTools 面板里，没有这条转发，下载失败的原因
   * 在诊断包和界面上都是空白。
   */
  'engine.log'(p: {
    level: 'info' | 'warn' | 'error';
    scope: string;
    msg: string;
    data?: unknown;
  }): void;
  /**
   * offscreen → bg：把一段字节交给浏览器下载通道落盘。
   *
   * **offscreen 文档里没有 chrome.downloads**（Chrome 只给 offscreen 留 chrome.runtime），
   * 所以「浏览器下载目录」这种保存方式在引擎里根本执行不了 —— 旧实现直接调到
   * downloads-api-unavailable，每一个文件都失败，用户看到的就是「点下载没反应/全失败」。
   */
  'engine.download'(p: {
    filename: string;
    /** 直链（http/https）：SW 直接交给下载通道，文件名和流式落盘都能保住 */
    url?: string;
    /** 改写过的字节（转码后无法再用原地址）：退化成 data: URL，文件名保不住 */
    data?: ArrayBuffer;
    mime?: string;
  }): { filename: string; size: number };
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
