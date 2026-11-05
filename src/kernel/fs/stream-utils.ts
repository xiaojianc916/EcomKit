import { EcError } from '../errors/ec-error';

/**
 * 读取文本文件并自动去掉 UTF-8 BOM。
 *
 * 为什么不直接用 File.text()：Windows 记事本保存的文件带 BOM，
 * JSON.parse 遇到 BOM 会直接抛错（".ecbox.json" 就是被记事本改坏的重灾区，§9.11）。
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Blob → 文本（去 BOM） */
export async function blobToText(blob: Blob): Promise<string> {
  return stripBom(await blob.text());
}

/** 文本 → UTF-8 编码的字节数，用来给诊断包和进度统计 */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** 把 ReadableStream 收集成 Blob（只在读小文件时用，大文件必须流式写） */
export async function streamToBlob(stream: ReadableStream<Uint8Array>): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new Blob(chunks as BlobPart[]);
}

/**
 * 把 Blob 或 ReadableStream 统一成可写入的流。
 * 为什么需要：FSA 的 writeFile 既能收 Blob（小图）也能收流（几百 MB 的视频），
 * 两条路径必须都走 pipe，才能保证内存占用恒定（§9.9）。
 */
export function toStream(data: Blob | ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  if (data instanceof ReadableStream) return data;
  return data.stream() as ReadableStream<Uint8Array>;
}

export interface CountingStream {
  stream: TransformStream<Uint8Array, Uint8Array>;
  /** 已转发的字节数 */
  total(): number;
}

/** 计数并原样转发的 TransformStream（视频写入用，保证进度里的 bytes 准确） */
export function countingStream(): CountingStream {
  let total = 0;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { stream, total: () => total };
}

/** 校验 AbortSignal，真被取消时抛 CANCELED（而不是 DOMException） */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new EcError('CANCELED');
}
