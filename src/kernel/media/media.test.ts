import { describe, expect, it, vi } from 'vitest';
import {
  CONVERTIBLE,
  createMediaTools,
  HEIC_HINT,
  isConvertibleMime,
  NOT_CONVERTIBLE,
} from './convert';
import {
  downloadHls,
  type HlsVariant,
  isHlsPlaylist,
  looksLikeM3u8,
  parseM3u8,
  pickBestVariant,
} from './hls';

describe('isConvertibleMime（§9.8 什么时候转码）', () => {
  it('webp 和 avif 转', () => {
    expect(isConvertibleMime('image/webp')).toBe(true);
    expect(isConvertibleMime('image/avif')).toBe(true);
  });

  it('gif 不转（会丢动画）', () => {
    expect(isConvertibleMime('image/gif')).toBe(false);
  });

  it('heic 不转（Chrome 解不了）', () => {
    expect(isConvertibleMime('image/heic')).toBe(false);
    expect(isConvertibleMime('image/heif')).toBe(false);
  });

  it('jpg/png 不需要转', () => {
    expect(isConvertibleMime('image/jpeg')).toBe(false);
    expect(isConvertibleMime('image/png')).toBe(false);
  });

  it('常量表和方案一致', () => {
    expect([...CONVERTIBLE]).toEqual(['webp', 'avif']);
    expect([...NOT_CONVERTIBLE]).toEqual(['gif', 'heic']);
  });
});

describe('createMediaTools（§9.8）', () => {
  it('非 WebP/AVIF 原样返回（省一次解码）', async () => {
    const tools = createMediaTools();
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    expect(await tools.toJpeg(blob)).toBe(blob);
  });

  it('WebP 在没有 OffscreenCanvas 的环境里原样返回，不让任务失败', async () => {
    const tools = createMediaTools();
    const blob = new Blob(['x'], { type: 'image/webp' });
    // happy-dom 没有 OffscreenCanvas，走降级分支
    const result = await tools.toJpeg(blob);
    expect(result).toBeInstanceOf(Blob);
  });

  it('shouldConvert 只对 webp/avif 为 true', async () => {
    const tools = createMediaTools();
    expect(await tools.shouldConvert(new Blob([''], { type: 'image/webp' }))).toBe(true);
    expect(await tools.shouldConvert(new Blob([''], { type: 'image/png' }))).toBe(false);
  });

  it('HEIC 提示文案遵守 §10.7（无感叹号、无 emoji）', () => {
    expect(HEIC_HINT).toContain('HEIC');
    expect(HEIC_HINT).not.toContain('！');
    expect(HEIC_HINT).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});

describe('parseM3u8（§9.9 HLS）', () => {
  it('解析 master playlist 的变体，按码率排序取最高', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
      'high/index.m3u8',
    ].join('\n');
    const playlist = parseM3u8(text, 'https://cdn.example.com/master.m3u8');
    expect(playlist.variants).toHaveLength(2);
    expect(playlist.variants[0]?.uri).toBe('https://cdn.example.com/low/index.m3u8');
    expect(pickBestVariant(playlist.variants)?.bandwidth).toBe(2400000);
  });

  it('解析媒体 playlist 的分片列表（保持顺序）', () => {
    const text = ['#EXTM3U', '#EXTINF:10,', 'seg0.ts', '#EXTINF:10,', 'seg1.ts'].join('\n');
    const playlist = parseM3u8(text, 'https://cdn.example.com/media.m3u8');
    expect(playlist.segments).toEqual([
      'https://cdn.example.com/seg0.ts',
      'https://cdn.example.com/seg1.ts',
    ]);
  });

  it('加密流标记为不支持（§9.9）', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:10,',
      'seg0.ts',
    ].join('\n');
    const playlist = parseM3u8(text, 'https://cdn.example.com/media.m3u8');
    expect(playlist.encrypted).toBe(true);
    expect(playlist.unsupported).toBe('encrypted');
  });

  it('METHOD=NONE 不算加密', () => {
    const text = ['#EXTM3U', '#EXT-X-KEY:METHOD=NONE', 'seg0.ts'].join('\n');
    expect(parseM3u8(text, 'https://c.com/a.m3u8').encrypted).toBe(false);
  });

  it('绝对地址原样保留', () => {
    const text = ['#EXTM3U', 'https://other.example.com/seg0.ts'].join('\n');
    expect(parseM3u8(text, 'https://c.com/a.m3u8').segments).toEqual([
      'https://other.example.com/seg0.ts',
    ]);
  });

  it('空行和注释不影响解析', () => {
    const text = ['#EXTM3U', '', '#EXT-X-VERSION:3', 'seg0.ts', ''].join('\n');
    expect(parseM3u8(text, 'https://c.com/a.m3u8').segments).toHaveLength(1);
  });

  it('STREAM-INF 缺省 BANDWIDTH 时仍按变体解析（不能当成分片）', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:FRAME-RATE=30.000',
      'high/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000',
      'mid/index.m3u8',
    ].join('\n');
    const playlist = parseM3u8(text, 'https://cdn.example.com/master.m3u8');
    expect(playlist.segments).toEqual([]);
    expect(playlist.variants.map((v) => v.uri)).toEqual([
      'https://cdn.example.com/high/index.m3u8',
      'https://cdn.example.com/mid/index.m3u8',
    ]);
    // 缺省带宽按 0 处理，最高码率仍然选得对
    expect(pickBestVariant(playlist.variants)?.bandwidth).toBe(800000);
  });

  it('#EXT-X-MAP 的初始化段排在分片最前面（fMP4 不写 init 就播不了）', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:6,',
      'seg0.m4s',
      '#EXTINF:6,',
      'seg1.m4s',
    ].join('\n');
    const playlist = parseM3u8(text, 'https://cdn.example.com/media.m3u8');
    expect(playlist.segments).toEqual([
      'https://cdn.example.com/init.mp4',
      'https://cdn.example.com/seg0.m4s',
      'https://cdn.example.com/seg1.m4s',
    ]);
    // 类型注释写明了 #EXT-X-MAP 不算 unsupported
    expect(playlist.unsupported).toBeUndefined();
  });

  it('变体和分片混排时不会串行', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000',
      'a.m3u8',
      '#EXTINF:6,',
      'seg0.ts',
    ].join('\n');
    const playlist = parseM3u8(text, 'https://c.com/x.m3u8');
    expect(playlist.variants).toHaveLength(1);
    expect(playlist.segments).toEqual(['https://c.com/seg0.ts']);
  });
});

describe('pickBestVariant', () => {
  // exactOptionalPropertyTypes 下不能给可选属性显式赋 undefined，所以按有无分辨率分开构造
  const v = (bandwidth: number, area = 0): HlsVariant =>
    area === 0
      ? { uri: 'https://c.com/' + bandwidth + '.m3u8', bandwidth }
      : {
          uri: 'https://c.com/' + bandwidth + '.m3u8',
          bandwidth,
          width: Math.sqrt(area),
          height: Math.sqrt(area),
        };

  it('选码率最高的', () => {
    expect(pickBestVariant([v(100), v(900), v(500)])?.bandwidth).toBe(900);
  });

  it('同码率时选分辨率更高的（避免运营商塞低分辨率）', () => {
    expect(pickBestVariant([v(500, 640 * 360), v(500, 1920 * 1080)])?.width).toBeCloseTo(
      Math.sqrt(1920 * 1080),
    );
  });

  it('空列表返回 null', () => {
    expect(pickBestVariant([])).toBeNull();
  });
});

describe('downloadHls（§9.9 顺序分片、追加写）', () => {
  it('下载 master + 媒体列表的分片并追加写入', async () => {
    const masterText = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=900000',
      'high.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=100000',
      'low.m3u8',
    ].join('\n');
    const mediaText = ['#EXTM3U', 'seg0.ts', 'seg1.ts'].join('\n');

    const written: number[] = [];
    const fetched: string[] = [];
    const result = await downloadHls('https://cdn.example.com/master.m3u8', {
      signal: new AbortController().signal,
      async fetchText(url) {
        fetched.push(url);
        return url.endsWith('master.m3u8') ? masterText : mediaText;
      },
      async fetchSegment(url) {
        fetched.push(url);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([url.endsWith('seg0.ts') ? 1 : 2]));
            controller.close();
          },
        });
      },
      async write(chunk) {
        written.push(chunk[0] ?? 0);
      },
    });

    // 只取最高码率的变体
    expect(fetched).toContain('https://cdn.example.com/high.m3u8');
    expect(fetched).not.toContain('https://cdn.example.com/low.m3u8');
    // 分片按顺序追加
    expect(written).toEqual([1, 2]);
    expect(result.segments).toBe(2);
    expect(result.bytes).toBe(2);
  });

  it('加密流抛 UNSUPPORTED_STREAM（§6.2）', async () => {
    await expect(
      downloadHls('https://c.com/a.m3u8', {
        signal: new AbortController().signal,
        async fetchText() {
          return ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="k.bin"', 'seg.ts'].join('\n');
        },
        async fetchSegment() {
          throw new Error('不该走到这里');
        },
        async write() {},
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_STREAM' });
  });

  it('没有分片时抛 UNSUPPORTED_STREAM', async () => {
    await expect(
      downloadHls('https://c.com/a.m3u8', {
        signal: new AbortController().signal,
        async fetchText() {
          return ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1', 'x.m3u8'].join('\n');
        },
        async fetchSegment() {
          throw new Error('不该走到这里');
        },
        async write() {},
      }),
    ).rejects.toBeDefined();
  });

  it('取消后停止下载', async () => {
    const controller = new AbortController();
    const onSegment = vi.fn();
    await expect(
      downloadHls('https://c.com/a.m3u8', {
        signal: controller.signal,
        async fetchText() {
          return ['#EXTM3U', 'seg0.ts', 'seg1.ts'].join('\n');
        },
        async fetchSegment() {
          controller.abort();
          return new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array([1]));
              c.close();
            },
          });
        },
        async write() {},
        onSegment,
      }),
    ).rejects.toMatchObject({ code: 'CANCELED' });
  });

  it('每写一个分片回调一次进度', async () => {
    const progress: Array<[number, number]> = [];
    await downloadHls('https://c.com/a.m3u8', {
      signal: new AbortController().signal,
      async fetchText() {
        return ['#EXTM3U', 'a.ts', 'b.ts', 'c.ts'].join('\n');
      },
      async fetchSegment() {
        return new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([1]));
            c.close();
          },
        });
      },
      async write() {},
      onSegment: (index, total) => progress.push([index, total]),
    });
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});

describe('looksLikeM3u8 / isHlsPlaylist', () => {
  it('按后缀判断', () => {
    expect(looksLikeM3u8('https://c.com/a.m3u8?x=1')).toBe(true);
    expect(looksLikeM3u8('https://c.com/a.mp4')).toBe(false);
    expect(looksLikeM3u8('not a url')).toBe(false);
  });

  it('按内容判断', () => {
    const head = new Uint8Array(32);
    head.set([0x23, 0x45, 0x58, 0x54, 0x4d, 0x33, 0x55], 0); // #EXTM3U
    expect(isHlsPlaylist(head)).toBe(true);
    expect(isHlsPlaylist(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(false);
  });
});
