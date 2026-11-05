import { EcError } from '../errors/ec-error';

/**
 * 图片转码（方案 §9.8）。
 *
 * 为什么默认开启：电商后台上传素材普遍只接受 JPG 和 PNG，WebP/AVIF 传上去会被拒。
 * 流程：createImageBitmap → OffscreenCanvas（**先铺白底**，否则透明区域转成 JPG 会变黑）
 * → convertToBlob({ type: 'image/jpeg', quality: 0.92 })。
 *
 * 三种不转的情况（§9.8）：
 *   · GIF —— 转了会丢动画；
 *   · 带透明通道的 PNG —— 转了透明区域会变成白块；
 *   · HEIC —— Chrome 解不了，原样保存并在 UI 上提示需要安装 HEIF 扩展。
 */

/** JPEG 质量（§9.8） */
export const JPEG_QUALITY = 0.92;

/** 需要转成 JPG 的格式 */
export const CONVERTIBLE = ['webp', 'avif'] as const;
/** 不能转的格式及原因 */
export const NOT_CONVERTIBLE = ['gif', 'heic'] as const;

export interface MediaTools {
  /** 按需转码：不是 WebP/AVIF 时原样返回（省一次解码） */
  toJpeg(blob: Blob): Promise<Blob>;
  /** 判断是否需要转码 */
  shouldConvert(blob: Blob): Promise<boolean>;
}

/** 能从 MIME 直接判断的转换判定（不需要解码） */
export function isConvertibleMime(mime: string): boolean {
  const lowered = mime.toLowerCase();
  if (lowered.includes('gif')) return false;
  if (lowered.includes('heic') || lowered.includes('heif')) return false;
  return lowered.includes('webp') || lowered.includes('avif');
}

/**
 * 探测图片是否带透明通道。
 * 用 OffscreenCanvas 取像素判断：createImageBitmap 不暴露 alpha 信息，
 * 而 PNG 大多数是带 alpha 的（哪怕全是 255），用 MIME 判断会误判掉太多本来能转的图。
 */
export async function hasTransparency(bitmap: ImageBitmap): Promise<boolean> {
  const width = Math.min(bitmap.width, 32);
  const height = Math.min(bitmap.height, 32);
  if (width <= 0 || height <= 0) return false;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.drawImage(bitmap, 0, 0, width, height, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 255) < 255) return true;
  }
  return false;
}

/** 把任意图片画到白底上再转 JPEG（§9.8 的「先铺白底」） */
export async function bitmapToJpeg(bitmap: ImageBitmap, quality = JPEG_QUALITY): Promise<Blob> {
  const width = bitmap.width;
  const height = bitmap.height;
  if (width <= 0 || height <= 0) throw new EcError('INTERNAL', { reason: 'zero-size-image' });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new EcError('INTERNAL', { reason: 'canvas-unavailable' });

  // 先铺白底：透明的 WebP/AVIF 直接转 JPEG 会得到黑色背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0);

  return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

export function createMediaTools(): MediaTools {
  return {
    async shouldConvert(blob: Blob): Promise<boolean> {
      if (!isConvertibleMime(blob.type)) return false;
      // PNG 带透明也要跳过，但这里已经按 MIME 排除掉了非 webp/avif 的情况
      return true;
    },

    /**
     * 转码主入口。
     * 不可转的格式原样返回（调用方按嗅探结果决定扩展名，§9.1「扩展名由内容决定」）。
     */
    async toJpeg(blob: Blob): Promise<Blob> {
      if (!isConvertibleMime(blob.type)) return blob;

      // 没有 OffscreenCanvas 的环境（老版本 Chrome 之外，主要是单测）原样返回，不让任务失败
      if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
        return blob;
      }

      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(blob);
      } catch {
        // 解不了（损坏的文件、或环境不支持该编码）→ 原样保存，用户至少能拿到文件
        return blob;
      }

      try {
        // 带透明通道的图不转（§9.8），避免透明区域被白底覆盖
        if (await hasTransparency(bitmap)) return blob;
        return await bitmapToJpeg(bitmap);
      } catch {
        return blob;
      } finally {
        bitmap.close();
      }
    },
  };
}

/** 给 UI 用的提示：HEIC 在 Windows 上需要额外扩展才能预览（§9.8） */
export const HEIC_HINT = 'HEIC 格式，Windows 需要安装 HEIF 扩展才能预览';
