import { z } from 'zod';

/** 素材类别：主图 / SKU 图 / 详情图 / 视频（§9.1） */
export const AssetKind = z.enum(['main', 'sku', 'detail', 'video']);
export type AssetKind = z.infer<typeof AssetKind>;

export const ASSET_KINDS: readonly AssetKind[] = ['main', 'sku', 'detail', 'video'];

export const VideoMeta = z.object({
  codec: z.enum(['h264', 'h265', 'unknown']),
  container: z.enum(['mp4', 'hls', 'dash', 'unknown']),
  duration: z.number().optional(),
  /** 从 URL 的过期参数解析出来（毫秒时间戳），见 kernel/net/expiry.ts */
  expiresAt: z.number().optional(),
  cover: z.string().url().optional(),
  /** 分辨率和码率只在“选哪个视频”时用得到，写进快照方便调试 */
  width: z.number().optional(),
  height: z.number().optional(),
  bitrate: z.number().optional(),
});
export type VideoMeta = z.infer<typeof VideoMeta>;

export const Asset = z.object({
  /** 平台内稳定标识：图片路径去掉参数后的哈希 / 视频 vid。用于去重和增量下载 */
  key: z.string().min(1),
  kind: AssetKind,
  /** 页面中的原始顺序（从 0 开始），决定文件序号 */
  index: z.number().int().nonnegative(),
  /** 按优先级排列的候选地址：原图 → 次优 → 页面原始 URL */
  candidates: z.array(z.string().url()).min(1),
  /** 面板缩略图（平台小图，省流量） */
  preview: z.string().url().optional(),
  /** SKU 规格文字 / 视频类型（主图视频、讲解视频） */
  label: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  video: VideoMeta.optional(),
  /** 这一类素材是不是 DOM 兜底补出来的。UI 上标“页面解析”（§7.3、§10.4） */
  fromDom: z.boolean().optional(),
});
export type Asset = z.infer<typeof Asset>;
