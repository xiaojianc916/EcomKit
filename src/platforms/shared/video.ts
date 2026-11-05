import type { VideoMeta } from '../../kernel/model/asset';

/**
 * 视频候选与选择规则（方案 §7.6.3，Windows 关键点）。
 *
 * Windows 10/11 默认不带 HEVC 解码器，H.265 的 mp4 在系统自带播放器里很可能打不开，
 * 所以选择顺序是：
 *   只考虑 mp4 直链 → 优先 H.264 → 同编码选分辨率最高 → 再选码率最高。
 * 只有 H.265 时照常下载（用户可能装了 HEVC 扩展），由调用方在素材上加 h265Only 标记，
 * UI 按 §10.4 在视频行显示「H.265」。
 */
export type VideoCodec = VideoMeta['codec'];
export type VideoContainer = VideoMeta['container'];

export interface VideoCandidate {
  /** 已规范化、且已通过 CDN 白名单的地址 */
  url: string;
  codec: VideoCodec;
  container: VideoContainer;
  width?: number;
  height?: number;
  bitrate?: number;
  duration?: number;
  cover?: string;
  /** 主图视频 / 讲解视频 */
  label?: string;
}

const CODEC_RANK: Record<VideoCodec, number> = { h264: 3, unknown: 2, h265: 1 };

/** 码率、分辨率缺失时按 0 参与比较，不影响稳定性 */
function area(c: VideoCandidate): number {
  return (c.width ?? 0) * (c.height ?? 0);
}

/** 从候选里挑一个要下载的视频；没有 mp4 直链时返回 null（调用方报 UNSUPPORTED_STREAM） */
export function selectVideo(candidates: readonly VideoCandidate[]): VideoCandidate | null {
  const mp4 = candidates.filter((c) => c.container === 'mp4');
  if (mp4.length === 0) return null;

  let best: VideoCandidate | undefined;
  for (const c of mp4) {
    if (!best) {
      best = c;
      continue;
    }
    if (compareVideo(c, best) < 0) best = c;
  }
  return best ?? null;
}

/** 排序比较：返回负数表示 a 更优。相同条件保持原始顺序（稳定） */
export function compareVideo(a: VideoCandidate, b: VideoCandidate): number {
  const codec = CODEC_RANK[b.codec] - CODEC_RANK[a.codec];
  if (codec !== 0) return codec;

  const byArea = area(b) - area(a);
  if (byArea !== 0) return byArea;

  return (b.bitrate ?? 0) - (a.bitrate ?? 0);
}

/** 是否只拿到了 H.265：用于 UI 的「H.265，部分播放器无法播放」提示 */
export function isH265Only(candidates: readonly VideoCandidate[]): boolean {
  const mp4 = candidates.filter((c) => c.container === 'mp4');
  return mp4.length > 0 && mp4.every((c) => c.codec === 'h265');
}

/**
 * 生成 Asset.video 需要的元信息（不负责 URL）。
 *
 * expiresAt 直接接受 kernel/net/expiry.ts 的返回值（**没有过期参数时是 null**）：
 * 契约里 Asset.video.expiresAt 是 z.number().optional()，不接受 null，
 * 而 exactOptionalPropertyTypes 下也不能写 `expiresAt: undefined`，所以在这里统一过滤。
 */
export function toVideoMeta(
  c: VideoCandidate,
  opts: { expiresAt?: number | null } = {},
): VideoMeta {
  const meta: VideoMeta = { codec: c.codec, container: c.container };
  if (c.width !== undefined) meta.width = c.width;
  if (c.height !== undefined) meta.height = c.height;
  if (c.bitrate !== undefined) meta.bitrate = c.bitrate;
  if (c.duration !== undefined) meta.duration = c.duration;
  if (c.cover !== undefined) meta.cover = c.cover;
  if (opts.expiresAt !== undefined && opts.expiresAt !== null) meta.expiresAt = opts.expiresAt;
  return meta;
}

/**
 * 从地址或 MIME 猜测编码 / 容器（启发式，字段缺失时兜底）：
 * - bytevc1 / h265 / hevc → h265
 * - h264 / avc → h264
 * - .m3u8 / m3u8 → hls，.mpd → dash，.mp4 → mp4
 */
export function guessCodec(...hints: (string | undefined)[]): VideoCodec {
  for (const hint of hints) {
    if (!hint) continue;
    const s = hint.toLowerCase();
    if (s.includes('h265') || s.includes('hevc') || s.includes('bytevc1') || s.includes('bytevc')) {
      return 'h265';
    }
    if (s.includes('h264') || s.includes('avc') || s.includes('avc1')) return 'h264';
  }
  return 'unknown';
}

/** 从地址猜测容器 */
export function guessContainer(...hints: (string | undefined)[]): VideoContainer {
  for (const hint of hints) {
    if (!hint) continue;
    const s = hint.toLowerCase();
    if (s.includes('.m3u8') || s.includes('m3u8')) return 'hls';
    if (s.includes('.mpd') || s.includes('dash')) return 'dash';
    if (s.includes('.mp4')) return 'mp4';
  }
  return 'unknown';
}
