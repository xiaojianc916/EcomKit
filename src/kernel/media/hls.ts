import { EcError } from '../errors/ec-error';
import { sniff } from '../net/sniff';

/**
 * HLS 处理（方案 §9.9）。
 *
 * v1 的策略：解析 m3u8，选**码率最高**的变体，按顺序下载 TS 分片，追加写入同一个文件，
 * 保存成 .ts（Windows 自带播放器可以播）。转 mp4 留到 v1.1 评估 —— 那需要 ffmpeg.wasm，
 * 30MB 换一个「能改后缀」的收益不划算。
 *
 * 不支持的：DASH、加密流（#EXT-X-KEY）、blob: 地址 → UNSUPPORTED_STREAM（§6.2）。
 */

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  width?: number;
  height?: number;
}

export interface HlsPlaylist {
  /** master playlist 里的变体；没有时为空数组（说明本身就是媒体列表） */
  variants: HlsVariant[];
  /** 媒体列表里的分片地址（已按顺序） */
  segments: string[];
  /** 是否加密（#EXT-X-KEY） */
  encrypted: boolean;
  /** 是否有不支持的流类型（DASH 的 #EXT-X-MAP 之类不算，但 ENCRYPTED 算） */
  unsupported?: string;
}

/**
 * 解析 m3u8 文本。
 * baseUrl 用来把相对路径拼成绝对地址（分片地址基本都是相对的）。
 */
export function parseM3u8(text: string, baseUrl: string): HlsPlaylist {
  const lines = text.split(/\r?\n/);
  const variants: HlsVariant[] = [];
  const segments: string[] = [];
  let encrypted = false;
  let unsupported: string | undefined;
  let pendingBandwidth = 0;
  let pendingWidth: number | undefined;
  let pendingHeight: number | undefined;

  const resolve = (uri: string): string => {
    try {
      return new URL(uri, baseUrl).toString();
    } catch {
      return uri;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (line.startsWith('#EXT-X-KEY')) {
      // 加密流 v1 不支持（§9.9）
      if (line.includes('METHOD=NONE')) continue;
      encrypted = true;
      unsupported = 'encrypted';
      continue;
    }
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bandwidth = /BANDWIDTH=(\d+)/i.exec(line);
      pendingBandwidth = bandwidth ? Number(bandwidth[1]) : 0;
      const resolution = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
      if (resolution) {
        pendingWidth = Number(resolution[1]);
        pendingHeight = Number(resolution[2]);
      }
      continue;
    }
    if (line.startsWith('#')) continue;

    // 非注释行：要么是变体地址，要么是分片地址
    if (pendingBandwidth > 0 || pendingWidth !== undefined || pendingHeight !== undefined) {
      const variant: HlsVariant = { uri: resolve(line), bandwidth: pendingBandwidth };
      if (pendingWidth !== undefined) variant.width = pendingWidth;
      if (pendingHeight !== undefined) variant.height = pendingHeight;
      variants.push(variant);
      pendingBandwidth = 0;
      pendingWidth = undefined;
      pendingHeight = undefined;
      continue;
    }
    segments.push(resolve(line));
  }

  const playlist: HlsPlaylist = { variants, segments, encrypted };
  if (unsupported !== undefined) playlist.unsupported = unsupported;
  return playlist;
}

/**
 * 选码率最高的变体（§9.9）。
 * 同码率时优先分辨率更高的，避免运营商把低分辨率塞进高码率。
 */
export function pickBestVariant(variants: readonly HlsVariant[]): HlsVariant | null {
  if (variants.length === 0) return null;
  const sorted = [...variants].sort((a, b) => {
    if (b.bandwidth !== a.bandwidth) return b.bandwidth - a.bandwidth;
    const areaA = (a.width ?? 0) * (a.height ?? 0);
    const areaB = (b.width ?? 0) * (b.height ?? 0);
    return areaB - areaA;
  });
  return sorted[0] ?? null;
}

/** 判断一个地址是不是 m3u8（还有嗅探兜底，见 fetcher） */
export function looksLikeM3u8(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return url.split('?')[0]?.toLowerCase().endsWith('.m3u8') ?? false;
  }
}

/** 嗅探结果是不是 HLS 播放列表 */
export function isHlsPlaylist(head: Uint8Array): boolean {
  return sniff(head).container === 'hls';
}

export interface DownloadHlsOptions {
  /** 取文本（m3u8） */
  fetchText(url: string): Promise<string>;
  /** 取分片（返回字节流） */
  fetchSegment(url: string): Promise<ReadableStream<Uint8Array>>;
  /** 追加写入同一份文件；第一次调用时创建 */
  write(chunk: Uint8Array): Promise<void>;
  signal: AbortSignal;
  /** 每写完一个分片回调一次，用于进度 */
  onSegment?(index: number, total: number): void;
}

/**
 * 下载 HLS 整个媒体。
 *
 * 分两跳：先取 master playlist 拿最高码率变体，再取媒体 playlist 拿分片列表。
 * 有些地址直接给媒体列表，这时 variants 为空，就直接用它的 segments。
 */
export async function downloadHls(
  url: string,
  options: DownloadHlsOptions,
): Promise<{ segments: number; bytes: number }> {
  const text = await options.fetchText(url);
  const playlist = parseM3u8(text, url);

  if (playlist.unsupported === 'encrypted') {
    throw new EcError('UNSUPPORTED_STREAM', { reason: 'encrypted-hls' });
  }

  let segments = playlist.segments;
  if (playlist.variants.length > 0) {
    const best = pickBestVariant(playlist.variants);
    if (!best) throw new EcError('UNSUPPORTED_STREAM', { reason: 'no-variant' });
    const mediaText = await options.fetchText(best.uri);
    const media = parseM3u8(mediaText, best.uri);
    if (media.encrypted) throw new EcError('UNSUPPORTED_STREAM', { reason: 'encrypted-hls' });
    segments = media.segments;
  }

  if (segments.length === 0) throw new EcError('UNSUPPORTED_STREAM', { reason: 'no-segments' });

  let bytes = 0;
  for (let i = 0; i < segments.length; i += 1) {
    if (options.signal.aborted) throw new EcError('CANCELED');
    const segmentUrl = segments[i];
    if (!segmentUrl) continue;
    const stream = await options.fetchSegment(segmentUrl);
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      // 按顺序追加写入同一个文件（§9.9）
      await options.write(value);
    }
    options.onSegment?.(i + 1, segments.length);
  }

  return { segments: segments.length, bytes };
}
