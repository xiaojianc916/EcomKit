import type { z } from 'zod';
import type { ErrorCode } from '../errors/codes';
import type { FsGateway } from '../fs/types';
import type { Logger } from '../log/logger';
import type { ProductSnapshot } from '../model/product';
import type { Fetcher } from '../net/types';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'partial'
  | 'failed'
  | 'canceled'
  | 'interrupted';

export interface WorkItem {
  /** 计划内唯一，也是 .ecbox.json 里的 key */
  itemKey: string;
  /** UI 上按行分组的键：main / sku / detail / video */
  group: string;
  /** 相对商品文件夹的子路径，例如 ['主图', '01'] */
  dir: string[];
  /** 不含扩展名的文件名主体 */
  stem: string;
  /** 期望的媒体类别，用于嗅探校验 */
  expect: 'image' | 'video';
  candidates: string[];
  kind: string;
}

export interface ItemResult {
  itemKey: string;
  status: 'ok' | 'failed' | 'skipped';
  bytes?: number;
  /** 实际落盘的相对路径，例如 主图/01.jpg */
  path?: string;
  code?: ErrorCode;
  size?: number;
}

export interface JobRecord {
  id: string;
  type: string;
  tabId?: number;
  /** media-download 用它按商品去重 */
  dedupeKey: string;
  payload: unknown;
  status: JobStatus;
  total: number;
  done: number;
  skipped: number;
  bytes: number;
  failed: { itemKey: string; code: ErrorCode }[];
  /** UI 每一行的进度 */
  byGroup: Record<string, { total: number; done: number; failed: number; skipped: number }>;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** 供 UI 显示“已保存 N 个文件 / 用时 x 秒” */
  label?: string;
}

export interface PlanContext {
  signal: AbortSignal;
  log: Logger;
  settings: unknown;
  /**
   * 写入网关。plan 阶段就要用它来**定位已有商品文件夹**（ADR-6：
   * 索引 → `_ID` 后缀扫描 → 新建），否则商家一改标题就会多出一个文件夹。
   */
  fs: FsGateway;
}

export interface RunContext {
  signal: AbortSignal;
  fs: FsGateway;
  net: Fetcher;
  media: {
    toJpeg(blob: Blob): Promise<Blob>;
    sniff(head: Uint8Array): { ext: string; mime: string; container?: string };
  };
  log: Logger;
}

/** 功能模块注册的任务类型（§6.4） */
export interface JobTypeDef<P = unknown, Ctx = unknown> {
  type: string;
  payload: z.ZodType<P>;
  dedupeKey?(p: P): string;
  requiresDir: boolean;
  plan(p: P, ctx: PlanContext & { snapshot?: ProductSnapshot }): Promise<WorkItem[]>;
  run(item: WorkItem, ctx: RunContext & { extra: Ctx }): Promise<ItemResult>;
  finalize?(
    p: P,
    results: ItemResult[],
    ctx: RunContext & { extra: Ctx; record: JobRecord },
  ): Promise<void>;
  /** 可选：跳过已完成文件时用记录里的 itemKey */
  extra?: (p: P, ctx: { fs: FsGateway; log: Logger }) => Promise<Ctx>;
}

/** bg → page 的进度事件（§4.3 第 8 步） */
export type JobEvent =
  | { type: 'progress'; job: JobRecord }
  | { type: 'done'; job: JobRecord }
  | { type: 'item-failed'; jobId: string; itemKey: string; code: ErrorCode };