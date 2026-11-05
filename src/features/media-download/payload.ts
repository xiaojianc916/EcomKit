import { z } from 'zod';
import type { AssetKind } from '../../kernel/model/asset';
import { ProductSnapshot } from '../../kernel/model/product';
import type { PlannerSettings, WritePlan } from './planner';
import { planDownload } from './planner';
import { DEFAULT_MEDIA_DOWNLOAD_SETTINGS, type MediaDownloadSettings } from './settings';

/**
 * media-download 的任务载荷（**页面和引擎共用的唯一一份定义**）。
 *
 * 为什么单独一个文件：旧实现里页面手工拼 payload、引擎另有自己的 Zod schema，
 * 页面少传了 `platformDisplayName`，引擎在 plan 之前就整单拒绝（payload-invalid），
 * 页面又把异常吞进一个没有挂载的 Toast 里 —— 用户看到的就是「点下载完全没反应」。
 * 现在两边都只认这一个 schema：页面提交前 parse 一次、引擎入口再 parse 一次，
 * 字段一旦漂移，提交当场就会在面板上显示原因，而不是静默失败。
 */

export const SelectionSchema = z.object({
  kinds: z.array(z.enum(['main', 'sku', 'detail', 'video'])),
  keys: z.array(z.string()).optional(),
});

export type MediaDownloadSelection = z.infer<typeof SelectionSchema>;

export const PlatformDisplayName = z.string().min(1);

export const MediaDownloadPayloadSchema = z.object({
  snapshot: ProductSnapshot,
  selection: SelectionSchema,
  /** planner 需要的设置（由功能设置换算，字段少于 MediaDownloadSettings） */
  settings: z.object({
    byPlatform: z.boolean(),
    folderTemplate: z.string().min(1),
    dirNames: z.object({
      main: z.string().min(1),
      sku: z.string().min(1),
      detail: z.string().min(1),
      video: z.string().min(1),
    }),
    infoTxt: z.boolean(),
    videoCover: z.boolean(),
    detailMinWidth: z.number().int().min(0),
    /** WebP / AVIF 转 JPG；关闭时按嗅探结果原样落盘（§9.8） */
    toJpeg: z.boolean(),
  }),
  /** 平台显示名（目录名和文案都用平台的叫法，§10.7） */
  platformDisplayName: PlatformDisplayName,
});

export type MediaDownloadPayload = z.infer<typeof MediaDownloadPayloadSchema>;

/** 平台显示名（目录和文案都用平台的叫法，§10.7 第 4 条） */
export const PLATFORM_NAMES: Record<string, string> = {
  pinduoduo: '拼多多',
  douyin: '抖音',
};

export function platformDisplayName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

/** 把功能设置换算成 planner 需要的形状（字段更少，避免把 UI 状态带进任务） */
export function toPlannerSettings(settings: MediaDownloadSettings): PlannerSettings & {
  toJpeg: boolean;
} {
  return {
    byPlatform: settings.byPlatform,
    folderTemplate: settings.folderTemplate,
    dirNames: {
      main: settings.dirNames.main,
      sku: settings.dirNames.sku,
      detail: settings.dirNames.detail,
      video: settings.dirNames.video,
    },
    infoTxt: settings.infoTxt,
    videoCover: settings.videoCover,
    detailMinWidth: settings.detailMinWidth,
    toJpeg: settings.toJpeg,
  };
}

export interface BuildPayloadInput {
  snapshot: ProductSnapshot;
  selection: MediaDownloadSelection;
  settings: MediaDownloadSettings;
}

/**
 * 页面侧唯一的 payload 构造入口。
 * 返回前用同一个 schema parse 一次：字段缺失会在这里抛错，而不是等到引擎静默拒绝。
 */
export function buildMediaDownloadPayload(input: BuildPayloadInput): MediaDownloadPayload {
  return MediaDownloadPayloadSchema.parse({
    snapshot: input.snapshot,
    selection: {
      kinds: input.selection.kinds,
      ...(input.selection.keys === undefined ? {} : { keys: input.selection.keys }),
    },
    settings: toPlannerSettings(input.settings),
    platformDisplayName: platformDisplayName(input.snapshot.platform),
  });
}

/** 引擎侧解析 payload：非法时抛 ZodError，由 runner 统一转成 INTERNAL */
export function parseMediaDownloadPayload(raw: unknown): MediaDownloadPayload {
  return MediaDownloadPayloadSchema.parse(raw);
}

/** 计划里各类别数量（UI 和 history 都用同一份计划） */
export function planOf(payload: MediaDownloadPayload, now?: number): WritePlan {
  return planDownload({
    snapshot: payload.snapshot,
    selection: payload.selection as never,
    settings: payload.settings as unknown as PlannerSettings,
    platformDisplayName: payload.platformDisplayName,
    ...(now === undefined ? {} : { now }),
  });
}

/** 默认设置下的选择：全选，给快捷操作和历史查询用 */
export const ALL_KINDS: AssetKind[] = ['main', 'sku', 'detail', 'video'];

export const FALLBACK_SETTINGS = DEFAULT_MEDIA_DOWNLOAD_SETTINGS;
