import { describe, expect, it } from 'vitest';
import type { JobRecord } from '../../../kernel/jobs/types';
import {
  assetRowModel,
  failuresByKind,
  groupProgress,
  previewAssets,
  rowTags,
  selectedCountOf,
  thumbSourcesOf,
  thumbSrcOf,
} from './asset-row-model';

function makeJob(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'j1',
    type: 'media-download',
    dedupeKey: 'pdd:1',
    payload: {},
    status: 'running',
    total: 48,
    done: 0,
    skipped: 0,
    bytes: 0,
    failed: [],
    byGroup: {},
    createdAt: 0,
    ...patch,
  };
}

const base = {
  kind: 'detail' as const,
  total: 26,
  selectedCount: 0,
  resolving: false,
  job: null,
};

describe('assetRowModel（§10.4 素材行表）', () => {
  it('识别中：数量显示“—”，不显示下载', () => {
    const m = assetRowModel({ ...base, resolving: true });
    expect(m.status.kind).toBe('resolving');
    expect(m.countText).toBe('—');
    expect(m.showDownload).toBe(false);
  });

  it('就绪：不显示数字（总数由缩略图条的 +N 表达），只给下载', () => {
    const m = assetRowModel(base);
    expect(m.countText).toBeNull();
    expect(m.showDownload).toBe(true);
  });

  it('数量为 0：置灰显示“无”，复选框禁用（不显示下载）', () => {
    const m = assetRowModel({ ...base, kind: 'video', total: 0 });
    expect(m.status.kind).toBe('empty');
    expect(m.countText).toBe('无');
    expect(m.showDownload).toBe(false);
  });

  it('下载中：细进度条加 12/26', () => {
    const job = makeJob({
      status: 'running',
      byGroup: { detail: { total: 26, done: 12, failed: 0, skipped: 0 } },
    });
    const m = assetRowModel({ ...base, job });
    expect(m.status).toEqual({ kind: 'progress', done: 12, total: 26 });
    expect(m.countText).toBe('12/26');
  });

  it('完成的跳过计入进度', () => {
    const job = makeJob({
      status: 'running',
      byGroup: { detail: { total: 26, done: 10, failed: 0, skipped: 2 } },
    });
    expect(assetRowModel({ ...base, job }).countText).toBe('12/26');
  });

  it('完成：✓ 26', () => {
    const job = makeJob({
      status: 'done',
      byGroup: { detail: { total: 26, done: 26, failed: 0, skipped: 0 } },
    });
    const m = assetRowModel({ ...base, job });
    expect(m.status.kind).toBe('done');
    expect(m.countText).toBe('✓ 26');
  });

  it('全部已存在：仍然只显示 ✓ 26，不加「已存在」文案', () => {
    const job = makeJob({
      status: 'done',
      byGroup: { detail: { total: 26, done: 0, failed: 0, skipped: 26 } },
    });
    const m = assetRowModel({ ...base, job });
    expect(m.status.kind).toBe('done');
    expect(m.countText).toBe('✓ 26');
  });

  it('部分失败：24/26 · 2 个失败，加“重试”', () => {
    const job = makeJob({
      status: 'partial',
      byGroup: { detail: { total: 26, done: 24, failed: 2, skipped: 0 } },
      failed: [
        { itemKey: 'detail:a', code: 'NETWORK' },
        { itemKey: 'detail:b', code: 'HTTP_404' },
      ],
    });
    const m = assetRowModel({ ...base, job });
    expect(m.status.kind).toBe('partial');
    expect(m.countText).toBe('24/26 · 2 个失败');
    expect(m.showRetry).toBe(true);
  });

  it('挑选模式：数量变成 3/26', () => {
    const m = assetRowModel({ ...base, selectedCount: 3 });
    expect(m.countText).toBe('3/26');
    expect(m.showDownload).toBe(true);
  });

  it('空类别在任务进行中仍然显示“无”', () => {
    const job = makeJob({ status: 'running', byGroup: {} });
    const m = assetRowModel({ ...base, kind: 'video', total: 0, job });
    expect(m.status.kind).toBe('empty');
  });
});

describe('groupProgress', () => {
  it('没有任务或没有该组时返回 null', () => {
    expect(groupProgress(null, 'main')).toBeNull();
    expect(groupProgress(makeJob(), 'main')).toBeNull();
  });

  it('有该组时返回组进度', () => {
    const job = makeJob({ byGroup: { main: { total: 8, done: 3, failed: 0, skipped: 0 } } });
    expect(groupProgress(job, 'main')).toEqual({ total: 8, done: 3, failed: 0, skipped: 0 });
  });
});

describe('rowTags（§10.4 素材行最后两行）', () => {
  const asset = (patch: Record<string, unknown> = {}) =>
    ({
      key: 'k',
      kind: 'main',
      index: 0,
      candidates: ['https://img.pddpic.com/a.jpg'],
      ...patch,
    }) as never;

  it('有 DOM 兜底补的素材时标“页面解析”', () => {
    expect(rowTags([asset({ fromDom: true })], 'main')).toEqual(['页面解析']);
  });

  it('没有则不标', () => {
    expect(rowTags([asset()], 'main')).toEqual([]);
  });

  it('视频全部是 H.265 时标 H.265', () => {
    const videos = [
      asset({ kind: 'video', video: { codec: 'h265', container: 'mp4' } }),
      asset({ kind: 'video', video: { codec: 'h265', container: 'mp4' } }),
    ];
    expect(rowTags(videos, 'video')).toContain('H.265');
  });

  it('只要有一个 H.264 就不标 H.265', () => {
    const videos = [
      asset({ kind: 'video', video: { codec: 'h265', container: 'mp4' } }),
      asset({ kind: 'video', video: { codec: 'h264', container: 'mp4' } }),
    ];
    expect(rowTags(videos, 'video')).not.toContain('H.265');
  });

  it('非视频类别不标 H.265', () => {
    expect(rowTags([asset({ video: { codec: 'h265', container: 'mp4' } })], 'main')).toEqual([]);
  });
});

describe('previewAssets（§10.3 ④ 前 4 张缩略图加 +N）', () => {
  it('超过 4 张时给剩余数量', () => {
    expect(previewAssets([1, 2, 3, 4, 5, 6])).toEqual({ shown: [1, 2, 3, 4], rest: 2 });
  });

  it('不超过 4 张时没有剩余', () => {
    expect(previewAssets([1, 2])).toEqual({ shown: [1, 2], rest: 0 });
  });
});

describe('thumbSrcOf（§10.3 视频格子显示封面）', () => {
  const cover = 'https://img.pddpic.com/cover.jpg';
  const mp4 = 'https://v.pddpic.com/a.mp4';

  it('图片素材用 preview', () => {
    expect(thumbSrcOf({ kind: 'main', preview: 'https://img.pddpic.com/a.jpg' })).toBe(
      'https://img.pddpic.com/a.jpg',
    );
  });

  it('视频用封面，而不是 preview（旧实现把 mp4 直链当缩略图，永远加载失败）', () => {
    expect(
      thumbSrcOf({
        kind: 'video',
        preview: mp4,
        video: { codec: 'h264', container: 'mp4', cover },
      }),
    ).toBe(cover);
  });

  it('视频没有封面时退回 preview（可能是平台给的小图）', () => {
    expect(
      thumbSrcOf({
        kind: 'video',
        preview: cover,
        video: { codec: 'h264', container: 'mp4' },
      }),
    ).toBe(cover);
  });

  it('视频既没有封面也没有 preview 时返回 undefined（显示灰色占位）', () => {
    expect(
      thumbSrcOf({ kind: 'video', video: { codec: 'h264', container: 'mp4' } }),
    ).toBeUndefined();
  });
});

describe('thumbSourcesOf（视频没有封面时的首帧兜底）', () => {
  const mp4 = 'https://video.pddpic.com/a.mp4';

  it('有封面时只给 src', () => {
    expect(
      thumbSourcesOf({
        key: 'video-1',
        kind: 'video',
        index: 0,
        candidates: [mp4],
        video: { codec: 'h264', container: 'mp4', cover: 'https://img.pddpic.com/cover.jpg' },
      }),
    ).toEqual({ src: 'https://img.pddpic.com/cover.jpg' });
  });

  it('没有封面时给 videoSrc（第一个候选地址）', () => {
    expect(
      thumbSourcesOf({
        key: 'video-1',
        kind: 'video',
        index: 0,
        candidates: [mp4],
        video: { codec: 'h264', container: 'mp4' },
      }),
    ).toEqual({ videoSrc: mp4 });
  });

  it('图片素材没有 preview 时不给兜底（图片没有可画的「首帧」）', () => {
    expect(
      thumbSourcesOf({
        key: 'main-1',
        kind: 'main',
        index: 0,
        candidates: ['https://img.pddpic.com/a.jpg'],
      }),
    ).toEqual({});
  });
});

describe('selectedCountOf（挑选模式的半选判断）', () => {
  const assets = [{ key: 'a' }, { key: 'b' }, { key: 'c' }] as never[];

  it('没有选中时是 0', () => {
    expect(selectedCountOf(assets, new Set())).toBe(0);
  });

  it('只数在集合里的那些', () => {
    expect(selectedCountOf(assets, new Set(['a', 'c']))).toBe(2);
  });

  it('集合里不属于这一类的 key 不算', () => {
    expect(selectedCountOf(assets, new Set(['z']))).toBe(0);
  });
});

describe('failuresByKind', () => {
  it('按 itemKey 前缀归组', () => {
    const map = failuresByKind([
      { itemKey: 'main:a', code: 'NETWORK' },
      { itemKey: 'detail:b', code: 'HTTP_404' },
      { itemKey: 'main:c', code: 'TIMEOUT' },
    ]);
    expect(map.get('main')).toHaveLength(2);
    expect(map.get('detail')).toHaveLength(1);
  });

  it('认不出的前缀忽略', () => {
    const map = failuresByKind([{ itemKey: 'weird:x', code: 'NETWORK' }]);
    expect(map.size).toBe(0);
  });
});
