import type { z } from 'zod';
import type { FsGateway } from '../kernel/fs/types';
import type { JobRecord, JobTypeDef } from '../kernel/jobs/types';
import type { Logger } from '../kernel/log/logger';
import type { DirState } from '../kernel/messaging/protocol';
import type { Capability } from '../kernel/model/capability';
import type { PlatformId, ProductSnapshot } from '../kernel/model/product';

export interface QuickAction {
  id: string;
  title: string;
  run(api: PageApi): void;
}

export interface FeatureManifest<S = unknown> {
  id: string;
  title: string;
  /** lucide 图标名 */
  icon: string;
  order: number;
  platforms?: PlatformId[];
  requires: Capability[];
  settings?: { schema: z.ZodType<S>; defaults: S };
  commands?: { id: string; title: string; suggestedKey?: string }[];
}

export interface SubmitResultLike {
  jobId?: string;
  waiting?: 'dir';
  duplicateOf?: string;
}

export interface PageApi {
  submitJob<P>(
    type: string,
    payload: P,
    opts?: { label?: string; dedupeKey?: string },
  ): Promise<SubmitResultLike>;
  cancelJob(id: string): Promise<void>;
  retryJob(id: string, only: 'failed'): Promise<{ jobId: string }>;
  watchJobs(filter: { type: string; dedupeKey?: string }, cb: (j: JobRecord) => void): () => void;
  call(method: string, args: unknown): Promise<unknown>;
  dir: { status(): DirState; openGrant(reason: 'unset' | 'needs-grant' | 'gone' | 'change'): void };
  toast(msg: string, opts?: { action?: { label: string; run(): void } }): void;
  copy(text: string): Promise<void>;
  prefs: { get<T>(k: string): T | undefined; set<T>(k: string, v: T): void };
}

/**
 * 面板插槽的 props（§8.2）。
 *
 * `dir` 是**当前目录状态**的只读快照：外壳已经从 bg 查过，直接传下来，
 * 功能模块不要自己再去查（每次查都可能触发授权探测，§9.4 明确要求在面板挂载时只查一次）。
 */
export interface PanelProps<S = unknown> {
  snapshot: ProductSnapshot;
  status: 'resolving' | 'ready';
  settings: S;
  api: PageApi;
  dir: DirState;
  /** 本商品的当前任务（如果有），用于渲染进度态 */
  job?: JobRecord | null;
  /**
   * 设置里填的根目录绝对路径（可空）。浏览器只能拿到文件夹显示名，
   * 只有这个值能让「复制路径」给出可直接粘进资源管理器的完整路径（§10.5）。
   */
  rootPath?: string;
}

export interface PageFeature<S = unknown> {
  Panel?: React.ComponentType<PanelProps<S>>;
  badge?(snap: ProductSnapshot, state: unknown): string | number | null;
  quickActions?(snap: ProductSnapshot): QuickAction[];
  onCommand?(id: string, api: PageApi): void;
  SettingsSection?: React.ComponentType<{ value: S; onChange(v: S): void }>;
}

export interface ServiceFeature {
  methods?: Record<
    string,
    (args: unknown, sender: chrome.runtime.MessageSender) => Promise<unknown>
  >;
}

export interface EngineContext {
  /** 写入层（实现见 kernel/fs/fs-gateway.ts） */
  gateway: FsGateway;
  log: Logger;
}

export interface EngineFeature {
  jobTypes?: JobTypeDef<any, any>[];
  methods?: Record<string, (args: unknown, ctx: EngineContext) => Promise<unknown>>;
}

export interface RegisteredFeature<S = unknown> {
  manifest: FeatureManifest<S>;
  page?: { load(): Promise<{ default: PageFeature<S> }> };
  service?: ServiceFeature;
  engine?: EngineFeature;
}
