import { describe, expect, it } from 'vitest';
import { matchesExpectation, readHead, sniff } from './sniff';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function text(value: string, padTo = 32): Uint8Array {
  const arr = new Uint8Array(padTo);
  for (let i = 0; i < Math.min(value.length, padTo); i += 1) arr[i] = value.charCodeAt(i);
  return arr;
}

describe('sniff（§9.8）', () => {
  it('识别 jpg', () => {
    expect(sniff(bytes(0xff, 0xd8, 0xff, 0xe0))).toMatchObject({ ext: 'jpg', mime: 'image/jpeg' });
  });

  it('识别 png', () => {
    expect(sniff(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d))).toMatchObject({ ext: 'png', isImage: true });
  });

  it('识别 webp', () => {
    const head = new Uint8Array(16);
    head.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    head.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    expect(sniff(head)).toMatchObject({ ext: 'webp', mime: 'image/webp' });
  });

  it('识别 gif', () => {
    expect(sniff(text('GIF89a'))).toMatchObject({ ext: 'gif', mime: 'image/gif' });
  });

  it('识别 avif', () => {
    const head = new Uint8Array(32);
    head.set([0x66, 0x74, 0x79, 0x70], 4); // ftyp
    head.set([0x61, 0x76, 0x69, 0x66], 8); // avif
    expect(sniff(head)).toMatchObject({ ext: 'avif', mime: 'image/avif', isImage: true });
  });

  it('识别 heic 的三种品牌', () => {
    for (const brand of ['heic', 'heix', 'mif1']) {
      const head = new Uint8Array(32);
      head.set([0x66, 0x74, 0x79, 0x70], 4);
      for (let i = 0; i < 4; i += 1) head[8 + i] = brand.charCodeAt(i);
      expect(sniff(head)).toMatchObject({ ext: 'heic', mime: 'image/heic' });
    }
  });

  it('识别 mp4（其他 ftyp 品牌）', () => {
    const head = new Uint8Array(32);
    head.set([0x66, 0x74, 0x79, 0x70], 4);
    head.set([0x69, 0x73, 0x6f, 0x6d], 8); // isom
    expect(sniff(head)).toMatchObject({
      ext: 'mp4',
      mime: 'video/mp4',
      container: 'mp4',
      isVideo: true,
    });
  });

  it('识别 HLS 播放列表', () => {
    expect(sniff(text('#EXTM3U'))).toMatchObject({ ext: 'm3u8', container: 'hls', isVideo: true });
  });

  it('识别 MPEG-TS 分片', () => {
    expect(sniff(bytes(0x47, 0x40, 0x00, 0x10))).toMatchObject({ ext: 'ts', container: 'ts' });
  });

  it('HTML 错误页判成未知类型（§9.7 内容校验）', () => {
    expect(sniff(text('<!DOCTYPE html><html>'))).toMatchObject({
      ext: '',
      isImage: false,
      isVideo: false,
    });
  });

  it('空数据不崩', () => {
    expect(sniff(new Uint8Array(0))).toMatchObject({ ext: '', isImage: false, isVideo: false });
  });

  it('只有 3 个字节也能判出 jpg', () => {
    expect(sniff(bytes(0xff, 0xd8, 0xff))).toMatchObject({ ext: 'jpg' });
  });

  it('接受 ArrayBuffer', () => {
    // 用 new Uint8Array(...) 复制一份，避免把 ArrayBufferLike（含 SharedArrayBuffer）直接传进去
    const source = bytes(0xff, 0xd8, 0xff, 0xe0);
    const buf = new ArrayBuffer(source.byteLength);
    new Uint8Array(buf).set(source);
    expect(sniff(buf)).toMatchObject({ ext: 'jpg' });
  });
});

describe('matchesExpectation', () => {
  it('图片和视频分开判定', () => {
    expect(matchesExpectation(sniff(bytes(0xff, 0xd8, 0xff)), 'image')).toBe(true);
    expect(matchesExpectation(sniff(bytes(0xff, 0xd8, 0xff)), 'video')).toBe(false);
    const mp4 = new Uint8Array(32);
    mp4.set([0x66, 0x74, 0x79, 0x70], 4);
    expect(matchesExpectation(sniff(mp4), 'video')).toBe(true);
  });
});

describe('readHead', () => {
  it('读出前 N 字节，并把已读部分接回流里', async () => {
    const data = text('FFD8FF-padding........................');
    for (let i = 0; i < 3; i += 1) data[i] = [0xff, 0xd8, 0xff][i] as number;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data.slice(0, 8));
        controller.enqueue(data.slice(8));
        controller.close();
      },
    });
    const { head, rest } = await readHead(stream, 32);
    expect(head.length).toBe(32);
    expect(sniff(head).ext).toBe('jpg');

    const merged = await new Response(rest).arrayBuffer();
    expect(merged.byteLength).toBe(data.byteLength);
    expect(new Uint8Array(merged)).toEqual(data);
  });

  it('首块远大于 32 字节时，rest 是完整 body 且不拷贝首块', async () => {
    const big = new Uint8Array(64 * 1024);
    big.set([0xff, 0xd8, 0xff, 0xe0]);
    for (let i = 4; i < big.length; i += 1) big[i] = i & 0xff;
    const first = big.slice();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        controller.close();
      },
    });

    const { head, rest } = await readHead(stream, 32);
    expect(head.length).toBe(32);
    expect(sniff(head).ext).toBe('jpg');

    const merged = new Uint8Array(await new Response(rest).arrayBuffer());
    // 契约：rest 是**完整内容**，一个字节都不能少（少 32 字节 = 落盘文件损坏）
    expect(merged.byteLength).toBe(big.byteLength);
    expect(merged).toEqual(big);
  });

  it('首块不足 32 字节时跨块拼出 head，rest 仍从第 0 个字节开始', async () => {
    const data = new Uint8Array(100);
    data.set([0xff, 0xd8, 0xff, 0xe0]);
    for (let i = 4; i < data.length; i += 1) data[i] = i & 0xff;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < data.length; i += 7) {
          controller.enqueue(data.slice(i, Math.min(i + 7, data.length)));
        }
        controller.close();
      },
    });

    const { head, rest } = await readHead(stream, 32);
    expect(head.length).toBe(32);
    expect(sniff(head).ext).toBe('jpg');

    const merged = new Uint8Array(await new Response(rest).arrayBuffer());
    expect(merged).toEqual(data);
  });

  it('短于 32 字节的响应：head 取全部，rest 仍然把它接回去', async () => {
    const data = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data.slice());
        controller.close();
      },
    });
    const { head, rest } = await readHead(stream, 32);
    expect(head.length).toBe(5);
    const merged = new Uint8Array(await new Response(rest).arrayBuffer());
    expect(merged).toEqual(data);
  });

  it('body 为 null 时返回空头', async () => {
    const { head, rest } = await readHead(null);
    expect(head.length).toBe(0);
    expect(rest).toBeNull();
  });
});
