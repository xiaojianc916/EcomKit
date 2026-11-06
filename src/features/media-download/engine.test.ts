import { describe, expect, it } from 'vitest';
import { createFsGateway } from '../../kernel/fs/fs-gateway';
import { createMemorySink } from '../../kernel/fs/sinks/memory';
import { createJobRecord } from '../../kernel/jobs/progress';
import { createJobRunner } from '../../kernel/jobs/runner';
import type { ProductSnapshot } from '../../kernel/model/product';
import { sniff } from '../../kernel/net/sniff';
import { mediaDownloadJobType } from './engine';
import { buildMediaDownloadPayload, MediaDownloadPayloadSchema } from './payload';
import { DEFAULT_MEDIA_DOWNLOAD_SETTINGS } from './settings';

/**
 * engine 的端到端测试（**这一层以前一条测试都没有**）。
 *
 * 之前 876 个测试全绿，但用户点下载仍然毫无反应：页面拼的 payload 少字段、
 * 落盘目录算错、取消后不写清单、商品文件夹定位没接进链路 —— 全都在
 * 「页面 → 引擎」之间的缝里，谁也没测。
 */

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
]);

function snapshot(patch: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    platform: 'pinduoduo',
    pageKind: 'pdd.goods',
    productId: '733110622897',
    title: '【热巴推荐】德佑洗脸巾悬挂式一次性绵柔巾干湿两用柔软亲肤洁面',
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=733110622897',
    skus: [],
    assets: [
      {
        key: 'pdd/main-01.jpeg',
        kind: 'main',
        index: 0,
        candidates: ['https://img.pddpic.com/main-01.jpeg'],
      },
      {
        key: 'pdd/main-02.jpeg',
        kind: 'main',
        index: 1,
        candidates: ['https://img.pddpic.com/main-02.jpeg'],
      },
      {
        key: 'pdd/detail-01.jpeg',
        kind: 'detail',
        index: 0,
        candidates: ['https://img.pddpic.com/detail-01.jpeg'],
      },
    ],
    sources: ['ssr'],
    completeness: 'full',
    capturedAt: 0,
    ...patch,
  };
}

/** 假网络：按 URL 返回 PNG 字节 */
function fakeNet() {
  return {
    async fetchWithFallback() {
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    },
    async fetchStream() {
      return new Response(PNG, { status: 200 });
    },
  } as never;
}

function setup() {
  const sink = createMemorySink();
  const gateway = createFsGateway({ sink });
  const runner = createJobRunner({
    gateway,
    jobTypes: [mediaDownloadJobType],
    concurrency: 2,
    net: fakeNet(),
    media: {
      toJpeg: async (b: Blob) => b,
      sniff: () => ({ ext: 'png', mime: 'image/png', isImage: true, isVideo: false }),
    } as never,
  });
  return { sink, gateway, runner };
}

function payloadOf(snap = snapshot()) {
  return buildMediaDownloadPayload({
    snapshot: snap,
    selection: { kinds: ['main', 'sku', 'detail', 'video'] },
    settings: DEFAULT_MEDIA_DOWNLOAD_SETTINGS,
  });
}

/** 收集内存 sink 里的相对路径，验证目录结构 */
async function pathsOf(
  sink: ReturnType<typeof createMemorySink>,
  dir: string[] = [],
): Promise<string[]> {
  const entries = await sink.listDir(dir as never);
  const out: string[] = [];
  for (const entry of entries) {
    const next = [...dir, entry.name];
    if (entry.kind === 'directory') out.push(...(await pathsOf(sink, next)));
    else out.push(next.join('/'));
  }
  return out;
}

describe('media-download engine：页面载荷契约', () => {
  it('页面构造的 payload 必须能过引擎的 schema（少字段就是「点了没反应」的老根因）', () => {
    const payload = payloadOf();
    expect(MediaDownloadPayloadSchema.safeParse(payload).success).toBe(true);
    // 关键字段一个都不能少
    expect(payload.platformDisplayName).toBe('拼多多');
    expect(payload.settings.folderTemplate).toBe('{platform}_商品ID_{id}');
  });

  it('缺 platformDisplayName 的旧载荷会被拒绝，而不是静默失败', () => {
    const { platformDisplayName, ...rest } = payloadOf();
    void platformDisplayName;
    const parsed = MediaDownloadPayloadSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
  });
});

describe('media-download engine：落盘结构（§9.1）', () => {
  it('根目录下直接是 平台_商品ID_ID，再下面才是 主图/详情图', async () => {
    const { sink, runner } = setup();
    const payload = payloadOf();
    await runner.enqueue(
      createJobRecord({
        id: 'j1',
        type: 'media-download',
        dedupeKey: `${payload.snapshot.platform}:${payload.snapshot.productId}`,
        payload,
      }),
      payload,
    );
    await runner.idle();

    const files = await pathsOf(sink);
    const images = files.filter((f) => f.endsWith('.png'));
    expect(images.length).toBe(3);
    // memory sink 的 rootName 本身不算路径段，第一段就是商品文件夹
    for (const image of images) expect(image.split('/')[0]).toBe('拼多多_商品ID_733110622897');
    // 主图在「主图」子目录里，详情图在「详情图」里
    expect(images.filter((f) => f.includes('/主图/'))).toHaveLength(2);
    expect(images.filter((f) => f.includes('/详情图/'))).toHaveLength(1);
    // 文件名是 主图01 / 详情图01，不是光秃秃的 01
    expect(images.map((f) => f.split('/').at(-1)).sort()).toEqual([
      '主图01.png',
      '主图02.png',
      '详情图01.png',
    ]);
  });

  it('不写任何侧录文件：既没有 .ecbox.json 也没有 商品信息.txt', async () => {
    const { sink, runner } = setup();
    const payload = payloadOf();
    await runner.enqueue(
      createJobRecord({ id: 'j1', type: 'media-download', dedupeKey: 'k', payload }),
      payload,
    );
    await runner.idle();

    const files = await pathsOf(sink);
    expect(files.some((f) => f.endsWith('.json'))).toBe(false);
    expect(files.some((f) => f.endsWith('.txt'))).toBe(false);
    // 整棵树只有图片，一个多余文件都没有
    expect(files.every((f) => f.endsWith('.png'))).toBe(true);
  });

  it('同一商品重复下载：第二次全部跳过，不产生 (2) 副本（§9.11）', async () => {
    const { sink, runner } = setup();
    const payload = payloadOf();
    const first = createJobRecord({ id: 'j1', type: 'media-download', dedupeKey: 'k1', payload });
    await runner.enqueue(first, payload);
    await runner.idle();
    const before = (await pathsOf(sink)).filter((f) => f.endsWith('.png')).sort();

    const second = createJobRecord({ id: 'j2', type: 'media-download', dedupeKey: 'k2', payload });
    await runner.enqueue(second, payload);
    await runner.idle();
    const record = runner.get('j2');
    const after = (await pathsOf(sink)).filter((f) => f.endsWith('.png')).sort();

    expect(record?.skipped).toBe(3);
    expect(record?.done).toBe(0);
    expect(after).toEqual(before);
    expect(after.some((f) => f.includes('(2)'))).toBe(false);
  });

  it('商家改标题后仍写进原文件夹（ADR-6 文件夹定位生效）', async () => {
    const { sink, runner } = setup();
    const original = payloadOf();
    await runner.enqueue(
      createJobRecord({
        id: 'j1',
        type: 'media-download',
        dedupeKey: 'k1',
        payload: original,
      }),
      original,
    );
    await runner.idle();

    // 同一商品 ID、不同标题 → 模板会算出另一个文件夹名
    const renamed = payloadOf(snapshot({ title: '德佑洗脸巾（新标题）' }));
    await runner.enqueue(
      createJobRecord({
        id: 'j2',
        type: 'media-download',
        dedupeKey: 'k2',
        payload: renamed,
      }),
      renamed,
    );
    await runner.idle();

    const files = await pathsOf(sink);
    // 第一段就是商品文件夹：改标题不能再造出第二个
    const productDirs = new Set(files.map((f) => f.split('/')[0]));
    expect(productDirs.size, [...productDirs].join(' | ')).toBe(1);
    expect([...productDirs][0]).toBe('拼多多_商品ID_733110622897');
  });
});

describe('media-download engine：内容判定（§9.8、§9.9）', () => {
  function setupWith(body: Uint8Array, mime: string, _toJpeg = true) {
    const sink = createMemorySink();
    const gateway = createFsGateway({ sink });
    const convertCalls: string[] = [];
    const runner = createJobRunner({
      gateway,
      jobTypes: [mediaDownloadJobType],
      concurrency: 1,
      net: {
        async fetchWithFallback() {
          // Uint8Array<ArrayBufferLike> 不能直接当 BodyInit，转成独立 ArrayBuffer
          const buf = new ArrayBuffer(body.byteLength);
          new Uint8Array(buf).set(body);
          return new Response(buf, { status: 200, headers: { 'content-type': mime } });
        },
        async fetchStream() {
          const buf = new ArrayBuffer(body.byteLength);
          new Uint8Array(buf).set(body);
          return new Response(buf, { status: 200 });
        },
      } as never,
      media: {
        toJpeg: async (_b: Blob) => {
          convertCalls.push('toJpeg');
          return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });
        },
        sniff: (head: Uint8Array) => sniff(head),
      } as never,
    });
    return { sink, runner, convertCalls };
  }

  it('CDN 回 octet-stream 时，WebP 仍然会被转成 JPG（按内容判定，不看 content-type）', async () => {
    // RIFF....WEBP
    const webp = new Uint8Array(40);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    const { sink, runner, convertCalls } = setupWith(webp, 'application/octet-stream');
    const payload = buildMediaDownloadPayload({
      snapshot: snapshot({ assets: [snapshot().assets[0]!] }),
      selection: { kinds: ['main'] },
      settings: { ...DEFAULT_MEDIA_DOWNLOAD_SETTINGS, toJpeg: true },
    });
    await runner.enqueue(
      createJobRecord({
        id: 'j1',
        type: 'media-download',
        dedupeKey: 'k',
        payload,
      }),
      payload,
    );
    await runner.idle();

    const files = await pathsOf(sink);
    expect(convertCalls.length, '必须触发转码').toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('.jpg'))).toBe(true);
    expect(files.some((f) => f.endsWith('.webp'))).toBe(false);
  });

  it('设置关掉 toJpeg 时保持原格式', async () => {
    const webp = new Uint8Array(40);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    const { sink, runner, convertCalls } = setupWith(webp, 'image/webp', false);
    const payload = buildMediaDownloadPayload({
      snapshot: snapshot({ assets: [snapshot().assets[0]!] }),
      selection: { kinds: ['main'] },
      settings: { ...DEFAULT_MEDIA_DOWNLOAD_SETTINGS, toJpeg: false },
    });
    await runner.enqueue(
      createJobRecord({
        id: 'j1',
        type: 'media-download',
        dedupeKey: 'k',
        payload,
      }),
      payload,
    );
    await runner.idle();

    expect(convertCalls.length).toBe(0);
    expect((await pathsOf(sink)).some((f) => f.endsWith('.webp'))).toBe(true);
  });

  it('m3u8 播放列表不会被当成视频存成「假成功」（§9.9）', async () => {
    const m3u8 = new TextEncoder().encode('#EXTM3U\n#EXTINF:10,\nseg1.ts\n#EXT-X-ENDLIST\n');
    const { sink, runner } = setupWith(m3u8, 'application/octet-stream');
    const videoSnap = snapshot({
      assets: [
        {
          key: 'video-1',
          kind: 'video',
          index: 0,
          candidates: ['https://v.example.com/a.mp4'],
          video: { codec: 'h264', container: 'mp4' },
        },
      ],
    });
    const payload = buildMediaDownloadPayload({
      snapshot: videoSnap,
      selection: { kinds: ['video'] },
      settings: DEFAULT_MEDIA_DOWNLOAD_SETTINGS,
    });
    await runner.enqueue(
      createJobRecord({
        id: 'j1',
        type: 'media-download',
        dedupeKey: 'k',
        payload,
      }),
      payload,
    );
    await runner.idle();

    const record = runner.get('j1');
    expect(record?.status).toBe('failed');
    expect(record?.failed[0]?.code).toBe('UNSUPPORTED_STREAM');
    // 不能留下任何视频文件
    expect((await pathsOf(sink)).filter((f) => /.(ts|m3u8|mp4)$/.test(f))).toHaveLength(0);
  });

  it('视频走流式落盘：内容完整、扩展名按内容判定（§9.9 内存恒定）', async () => {
    // 一个 256KB 的「视频」：前 32 字节是 ftyp 头，后面是填充。
    // 用流式分支后这段内容必须逐字节完整落到文件里（旧实现走 blob()，内容也一样，
    // 但内存占用与文件大小成正比）。
    const mp4 = new Uint8Array(256 * 1024);
    mp4.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
    for (let i = 12; i < mp4.length; i += 1) mp4[i] = i % 251;

    const { sink, runner } = setupWith(mp4, 'video/mp4');
    const videoSnap = snapshot({
      assets: [
        {
          key: 'video-1',
          kind: 'video',
          index: 0,
          candidates: ['https://v.example.com/a.mp4'],
          video: { codec: 'h264', container: 'mp4' },
        },
      ],
    });
    const payload = buildMediaDownloadPayload({
      snapshot: videoSnap,
      selection: { kinds: ['video'] },
      settings: DEFAULT_MEDIA_DOWNLOAD_SETTINGS,
    });
    await runner.enqueue(
      createJobRecord({ id: 'j1', type: 'media-download', dedupeKey: 'k', payload }),
      payload,
    );
    await runner.idle();

    const record = runner.get('j1');
    expect(record?.status).toBe('done');
    expect(record?.bytes).toBe(mp4.byteLength);

    const files = await pathsOf(sink);
    const videoFile = files.find((f) => f.endsWith('.mp4'));
    expect(videoFile, '视频应落成 .mp4').toBeTruthy();
    // 内容必须逐字节完整（readHead 把嗅探读走的头字节接回去了）；
    // 落盘大小和记录里的 bytes 都等于源大小
    const segments = (videoFile as string).split('/');
    const size = await sink.exists(segments.slice(0, -1), segments.at(-1) as string);
    expect(size).toBe(mp4.byteLength);
  });

  it('视频响应体为空时判失败，不落 0 字节文件', async () => {
    const { sink, runner } = setupWith(new Uint8Array(0), 'video/mp4');
    const videoSnap = snapshot({
      assets: [
        {
          key: 'video-1',
          kind: 'video',
          index: 0,
          candidates: ['https://v.example.com/a.mp4'],
          video: { codec: 'h264', container: 'mp4' },
        },
      ],
    });
    const payload = buildMediaDownloadPayload({
      snapshot: videoSnap,
      selection: { kinds: ['video'] },
      settings: DEFAULT_MEDIA_DOWNLOAD_SETTINGS,
    });
    await runner.enqueue(
      createJobRecord({ id: 'j1', type: 'media-download', dedupeKey: 'k', payload }),
      payload,
    );
    await runner.idle();

    expect(runner.get('j1')?.status).toBe('failed');
    expect((await pathsOf(sink)).filter((f) => f.endsWith('.mp4'))).toHaveLength(0);
  });
});

describe('media-download engine：取消后续下（§9.11）', () => {
  it('取消后继续下载只补没下完的，已落盘的文件不产生 (2) 副本', async () => {
    const sink = createMemorySink();
    const gateway = createFsGateway({ sink });
    // 每个文件都慢一点，保证取消发生在中途
    let delay = 15;
    const runner = createJobRunner({
      gateway,
      jobTypes: [mediaDownloadJobType],
      concurrency: 1,
      net: {
        async fetchWithFallback() {
          await new Promise((r) => setTimeout(r, delay));
          return new Response(PNG, { status: 200 });
        },
        async fetchStream() {
          return new Response(PNG, { status: 200 });
        },
      } as never,
      media: {
        toJpeg: async (b: Blob) => b,
        sniff: () => ({ ext: 'png', mime: 'image/png', isImage: true, isVideo: false }),
      } as never,
    });
    const payload = payloadOf();
    await runner.enqueue(
      createJobRecord({ id: 'j1', type: 'media-download', dedupeKey: 'k', payload }),
      payload,
    );
    await new Promise((r) => setTimeout(r, 20));
    runner.cancel('j1');
    await runner.idle();
    expect(runner.get('j1')?.status).toBe('canceled');

    // 增量判断靠「同名文件已在盘上」，不依赖任何清单文件
    const first = (await pathsOf(sink)).filter((f) => f.endsWith('.png'));
    expect(first.length, '取消前应该至少写完一个').toBeGreaterThan(0);

    delay = 0;
    await runner.enqueue(
      createJobRecord({ id: 'j2', type: 'media-download', dedupeKey: 'k', payload }),
      payload,
    );
    await runner.idle();

    const record = runner.get('j2');
    expect(record?.status, JSON.stringify(record?.failed)).toBe('done');
    expect(record?.skipped, '已落盘的必须跳过').toBe(first.length);
    const all = (await pathsOf(sink)).filter((f) => f.endsWith('.png'));
    expect(all).toHaveLength(3);
    expect(all.some((f) => f.includes('(2)'))).toBe(false);
  });
});
