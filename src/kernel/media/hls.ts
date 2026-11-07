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

const BANDWIDTH_RE = /BANDWIDTH=(\d+)/i;
const RESOLUTION_RE = /RESOLUTION=(\d+)x(\d+)/i;
const MAP_ATTR_RE = /URI="([^"]+)"/i;

/** 标记「下一行是变体地址」。带宽可以缺省（0），但绝不能靠「有没有带宽」来判断 */
interface PendingVariant {
  bandwidth: number;
  width?: number;
  height?: number;
}

/**
 * 解析 m3u8 文本。
 * baseUrl 用来把相对路径拼成绝对地址（分片地址基本都是相对的）。
 *
 * 几个真实边界（不是理论值）：
 *   · #EXT-X-STREAM-INF 后面紧跟的是变体地址，但**带宽/RESOLUTION 都可能缺省**
 *     —— 旧实现用「pendingBandwidth > 0」判断，带宽缺省时会把变体地址当成分片下载；
 *   · #EXT-X-MAP:URI="init.mp4" 表示分片是 fMP4，必须把 init 段写在最前面，
 *     否则拼出来的 .ts/.mp4 播不了（旧实现直接丢弃，用户拿到一个打不开的文件）；
 *   · 变体行和分片行可能混排（主列表里再嵌一段变体），用 pending 状态机才不会串。
 */
export function parseM3u8(text: string, baseUrl: string): HlsPlaylist {
  const lines = text.split(/\r?\n/);
  const variants: HlsVariant[] = [];
  const segments: string[] = [];
  let encrypted = false;
  let unsupported: string | undefined;
  let pending: PendingVariant | null = null;

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
    if (line.startsWith('#EXT-X-MAP')) {
      // fMP4 的初始化段：没有它，后面的分片是裸数据，播放器打不开
      const uri = MAP_ATTR_RE.exec(line)?.[1];
      if (uri !== undefined && uri !== '') {
        // 初始化段出现在第一个分片之前，所以直接按出现顺序追加就是最前面
        // （§9.9 顺序写同一个文件；类型注释里已明确 #EXT-X-MAP 不算 unsupported）
        segments.push(resolve(uri));
      }
      continue;
    }
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bandwidth = BANDWIDTH_RE.exec(line);
      const resolution = RESOLUTION_RE.exec(line);
      pending = { bandwidth: bandwidth ? Number(bandwidth[1]) : 0 };
      if (resolution) {
        pending.width = Number(resolution[1]);
        pending.height = Number(resolution[2]);
      }
      continue;
    }
    if (line.startsWith('#')) continue;

    // 非注释行：紧跟在 #EXT-X-STREAM-INF 后面就是变体地址，否则是分片
    if (pending) {
      const variant: HlsVariant = { uri: resolve(line), bandwidth: pending.bandwidth };
      if (pending.width !== undefined) variant.width = pending.width;
      if (pending.height !== undefined) variant.height = pending.height;
      variants.push(variant);
      pending = null;
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
  /**
   * 顺序执行器：把 items 逐个接在一条 promise 链上，**上一个跑完才启动下一个**。
   *
   * 这里要表达的正是「分片必须严格串行」这件事：
   *   · 所有分片写的是**同一个文件**，先写后写决定字节顺序，并发写入会拼出坏文件（§9.9）；
   *   · onSegment(i + 1, total) 是「已经写完第几个」，本身就是累积状态；
   *   · 取消必须在**段边界**生效，并发发请求就没法只停在边界上。
   * 所以不能用 Promise.all / 有界并发，只能串行 —— 用链式 then 把「串行」写成结构本身，
   * 而不是靠一个循环里 await 来表达。
   */
  let chain: Promise<void> = Promise.resolve();
  for (const [index, segmentUrl] of segments.entries()) {
    chain = chain.then(async () => {
      // 段边界检查取消：上一段已经整段写完，这里停不会留下半个分片
      if (options.signal.aborted) throw new EcError('CANCELED');
      if (!segmentUrl) return;
      /**
       * 用官方 pipeTo + WritableStream 代替手写 reader 泵：取消信号直接传给 pipeTo，
       * 用户中途取消时分片流会被正确 abort（旧实现在 while(read) 里只检查了段边界，
       * 一个几十 MB 的分片要等整个读完才发现被取消）。
       */
      try {
        const stream = await options.fetchSegment(segmentUrl);
        await stream.pipeTo(
          new WritableStream<Uint8Array>({
            write: async (value) => {
              bytes += value.byteLength;
              // 按顺序追加写入同一个文件（§9.9）
              await options.write(value);
            },
          }),
          { signal: options.signal },
        );
      } catch (e) {
        // pipeTo 被取消时抛的是 DOMException AbortError；统一成 EcError，调用方只认错误码
        if (options.signal.aborted) throw new EcError('CANCELED');
        throw e;
      }
      options.onSegment?.(index + 1, segments.length);
    });
  }
  await chain;

  return { segments: segments.length, bytes };
}
