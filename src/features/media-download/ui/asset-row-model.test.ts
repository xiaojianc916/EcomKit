import { describe, expect, it } from 'vitest';
import type { JobRecord } from '../../../kernel/jobs/types';
import {
  assetRowModel,
  failuresByKind,
  groupProgress,
  previewAssets,
  rowTags,
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
  skippedCount: 0,
};

describe('assetRowModel（§10.4 素材行表）', () => {
  it('识别中：数量显示“—”，不显示下载', () => {
    const m = assetRowModel({ ...base, resolving: true });
    expect(m.status.kind).toBe('resolving');
    expect(m.countText).toBe('—');
    expect(m.showDownload).toBe(false);
  });

  it('就绪：显示数量加下载', () => {
    const m = assetRowModel(base);
    expect(m.countText).toBe('26');
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

  it('跳过（已存在）：✓ 26 · 已存在', () => {
    const job = makeJob({
      status: 'done',
      byGroup: { detail: { total: 26, done: 0, failed: 0, skipped: 26 } },
    });
    expect(assetRowModel({ ...base, job, skippedCount: 26 }).countText).toBe('✓ 26 · 已存在');
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
