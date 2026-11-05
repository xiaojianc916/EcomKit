import { describe, expect, it } from 'vitest';
import { mediaDownloadJobType } from '../../../features/media-download/engine';
import { buildMediaDownloadPayload } from '../../../features/media-download/payload';
import { DEFAULT_MEDIA_DOWNLOAD_SETTINGS } from '../../../features/media-download/settings';
import { createJobRecord } from '../../jobs/progress';
import { createJobRunner } from '../../jobs/runner';
import type { ProductSnapshot } from '../../model/product';
import { sniff } from '../../net/sniff';
import { createMemoryFolderIndex } from '../folder-index';
import { createFsGateway } from '../fs-gateway';
import { createMemorySink } from './memory';

/**
 * 取消 → 继续下载（§9.11）。
 *
 * 这是「中断后继续」的核心承诺：已下完的文件不能重下、不能变成 01 (2).jpg。
 * 旧实现有两个坑叠在一起：取消时不写 .ecbox.json（没有记录）+ 继续下载走整单重提，
 * 结果每次取消再继续都会多出一套 (2) 副本。
 */

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
]);

function product(): ProductSnapshot {
  return {
    platform: 'pinduoduo',
    pageKind: 'pdd.goods',
    productId: '733110622897',
    title: '德佑洗脸巾悬挂式一次性绵柔巾',
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=733110622897',
    skus: [],
    assets: Array.from({ length: 6 }, (_, i) => ({
      key: `pdd/detail-${i}.jpeg`,
      kind: 'detail' as const,
      index: i,
      candidates: [`https://img.pddpic.com/d${i}.jpeg`],
    })),
    sources: ['ssr'],
    completeness: 'full',
    capturedAt: 0,
  };
}

function payloadOf() {
  return buildMediaDownloadPayload({
    snapshot: product(),
    selection: { kinds: ['detail'] },
    settings: DEFAULT_MEDIA_DOWNLOAD_SETTINGS,
  });
}

function paths(sink: ReturnType<typeof createMemorySink>, dir: string[] = []): Promise<string[]> {
  return (async () => {
    const out: string[] = [];
    for (const entry of await sink.listDir(dir as never)) {
      const next = [...dir, entry.name];
      if (entry.kind === 'directory') out.push(...(await paths(sink, next)));
      else out.push(next.join('/'));
    }
    return out;
  })();
}

describe('取消后继续下载（§9.11）', () => {
  it('继续下载只补没下完的，已完成的文件不产生 (2) 副本', async () => {
    const sink = createMemorySink();
    const gateway = createFsGateway({
      sink,
      index: createMemoryFolderIndex(),
      rootId: async () => 'r',
    });
    let delay = 20;
    const runner = createJobRunner({
      gateway,
      jobTypes: [mediaDownloadJobType],
      concurrency: 1,
      net: {
        async fetchWithFallback() {
          await new Promise((r) => setTimeout(r, delay));
          return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
        },
        async fetchStream() {
          return new Response(PNG, { status: 200 });
        },
      } as never,
      media: { toJpeg: async (b: Blob) => b, sniff: (h: Uint8Array) => sniff(h) } as never,
    });

    const payload = payloadOf();
    await runner.enqueue(
      createJobRecord({
        id: 'run1',
        type: 'media-download',
        dedupeKey: 'pinduoduo:733110622897',
        payload,
      }),
      payload,
    );
    // 让前 2 个下完再取消
    await new Promise((r) => setTimeout(r, 55));
    runner.cancel('run1');
    await runner.idle();

    const first = (await paths(sink)).filter((f) => f.endsWith('.png'));
    expect(runner.get('run1')?.status).toBe('canceled');
    expect(first.length, '取消前应该至少写了几个').toBeGreaterThan(0);

    // 继续下载：同 dedupeKey、同 payload（页面上的「继续下载」就是这个行为）
    delay = 0;
    await runner.enqueue(
      createJobRecord({
        id: 'run2',
        type: 'media-download',
        dedupeKey: 'pinduoduo:733110622897',
        payload,
      }),
      payload,
    );
    await runner.idle();

    const record = runner.get('run2');
    expect(record?.status, JSON.stringify(record?.failed)).toBe('done');
    // 第二次不能再写一遍已经存在的文件
    expect(record?.skipped, '已完成的文件必须跳过').toBe(first.length);

    const all = (await paths(sink)).filter((f) => f.endsWith('.png'));
    expect(all.some((f) => f.includes('(2)'))).toBe(false);
    expect(all.length).toBe(6);
  });
});
