import type { SniffResult } from './types';

/**
 * 格式嗅探（方案 §9.8）。只看文件头 32 个字节，不信任 URL 后缀。
 *
 * 为什么必须嗅探：CDN 返回的 URL 后缀经常和真实内容不符（.jpg 后面其实是 WebP，
 * 拒绝访问时还可能返回 200 的 HTML 错误页），扩展名一旦写错，用户在资源管理器里就打不开。
 */

/** 读多少个字节就够判定（§9.8 要求前 32 字节） */
export const SNIFF_BYTES = 32;

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = start; i < start + length; i += 1) {
    const b = bytes[i];
    if (b === undefined) return out;
    out += String.fromCharCode(b);
  }
  return out;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

const JPEG = [0xff, 0xd8, 0xff] as const;
const PNG = [0x89, 0x50, 0x4e, 0x47] as const;
const GIF = [0x47, 0x49, 0x46, 0x38] as const; // GIF8
const TS_SYNC = 0x47; // MPEG-TS 包同步字节（HLS 分片）

const IMAGE = { isImage: true, isVideo: false } as const;
const VIDEO = { isImage: false, isVideo: true } as const;
const UNKNOWN = { isImage: false, isVideo: false } as const;

/**
 * 判定文件类型。head 至少 32 字节；不够也不会崩，只是可能判不出来（返回 octet-stream）。
 */
export function sniff(head: Uint8Array | ArrayBuffer): SniffResult {
  const bytes = head instanceof Uint8Array ? head : new Uint8Array(head);

  if (bytes.length === 0) {
    return { ext: '', mime: 'application/octet-stream', ...UNKNOWN };
  }

  if (startsWith(bytes, JPEG)) return { ext: 'jpg', mime: 'image/jpeg', ...IMAGE };
  if (startsWith(bytes, PNG)) return { ext: 'png', mime: 'image/png', ...IMAGE };
  if (startsWith(bytes, GIF)) return { ext: 'gif', mime: 'image/gif', ...IMAGE };

  // RIFF....WEBP
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp', ...IMAGE };
  }

  // ISO BMFF：第 4-8 字节是 'ftyp'，紧跟的 4 字节是品牌
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (brand === 'avif' || brand === 'avis') {
      return { ext: 'avif', mime: 'image/avif', container: 'avif', ...IMAGE };
    }
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') {
      return { ext: 'heic', mime: 'image/heic', container: 'heic', ...IMAGE };
    }
    return { ext: 'mp4', mime: 'video/mp4', container: 'mp4', ...VIDEO };
  }

  // HLS 播放列表本身是纯文本
  if (ascii(bytes, 0, 7) === '#EXTM3U') {
    return { ext: 'm3u8', mime: 'application/vnd.apple.mpegurl', container: 'hls', ...VIDEO };
  }

  // 方案 §9.8 的签名表里没有 TS，但 HLS 分片就是 TS，内核需要能认出来（media/hls.ts 用）
  if (bytes[0] === TS_SYNC && bytes.length >= 2) {
    return { ext: 'ts', mime: 'video/mp2t', container: 'ts', ...VIDEO };
  }

  return { ext: '', mime: 'application/octet-stream', ...UNKNOWN };
}

/** 嗅探结果是否满足工作项声明的期望类型（fetcher 用它做「内容不符就换候选」） */
export function matchesExpectation(result: SniffResult, expect: 'image' | 'video'): boolean {
  return expect === 'image' ? result.isImage : result.isVideo;
}

/**
 * 从响应体里读前 N 个字节，返回 { head } 以及一个「把已读部分接回去」的流。
 * 为什么要把流接回去：fetch 的 body 只能读一次，嗅探完后视频还要继续流式写入文件。
 *
 * **rest 是完整 body**（从第 0 个字节开始，含被 head 借走的那一段）：fetcher 把它直接当
 * 响应体交给落盘，少一段就是文件损坏，所以这里绝不能只回流「head 之后的部分」。
 *
 * 在这个前提下把拷贝降到 0~1 次：
 *   · 首块就够长（fetch 的典型块是 64KB，远大于 32 字节，这是绝大多数情况）：
 *     head 是首块的 subarray（零拷贝），rest 的第一项就是**原始首块本身**（零拷贝）。
 *   · 首块不足 N、累积了多块：合并一次得到 merged，head 是它的 subarray，
 *     rest 的第一项是 merged 整块 —— 只合并一次，不额外拷贝。
 */
export async function readHead(
  body: ReadableStream<Uint8Array> | null,
  size = SNIFF_BYTES,
): Promise<{ head: Uint8Array; rest: ReadableStream<Uint8Array> | null }> {
  if (!body) return { head: new Uint8Array(0), rest: null };
  if (size <= 0) return { head: new Uint8Array(0), rest: body };

  const reader = body.getReader();

  /** 先看首块：fetch 的块大小通常是 64KB，一块就够嗅探 */
  const first = await reader.read();
  if (first.done) return { head: new Uint8Array(0), rest: restOf(reader, null) };

  const head0 = first.value;
  if (head0 && head0.byteLength >= size) {
    // 常见路径：零拷贝。head 借用首块的视图，rest 的第一项就是首块本身
    return { head: head0.subarray(0, size), rest: restOf(reader, head0) };
  }

  // 罕见路径：首块不足 size（被代理切碎的小块，或极短的响应），继续累积
  const chunks: Uint8Array[] = [];
  if (head0 && head0.byteLength > 0) chunks.push(head0);
  let total = head0?.byteLength ?? 0;
  while (total < size) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    chunks.push(value);
    total += value.byteLength;
  }

  const merged = concat(chunks);
  return {
    head: merged.subarray(0, Math.min(size, merged.length)),
    rest: restOf(reader, merged.length > 0 ? merged : null),
  };
}

/**
 * 把「已经读出来的整块」放回流的头部，再接上剩下的读取。
 * 用 pull 模型 + highWaterMark: 0，只有下游要数据时才从源 reader 读（背压照常往上传）。
 */
function restOf(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pending: Uint8Array | null,
): ReadableStream<Uint8Array> {
  let buffered = pending;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (buffered) {
          const chunk = buffered;
          buffered = null;
          controller.enqueue(chunk);
          return;
        }
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (value && value.byteLength > 0) controller.enqueue(value);
        } catch (e) {
          controller.error(e);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
