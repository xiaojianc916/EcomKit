import { describe, expect, it } from 'vitest';
import {
  buildMirror,
  createMemorySessionArea,
  createMirrorStore,
  markInterrupted,
  parseMirror,
} from './mirror';
import { createJobRecord } from './progress';
import type { JobRecord } from './types';

function job(id: string, status: JobRecord['status'] = 'running'): JobRecord {
  return {
    ...createJobRecord({ id, type: 'media-download', dedupeKey: `k-${id}`, payload: null }),
    status,
  };
}

describe('buildMirror / parseMirror（§6.4 崩溃恢复）', () => {
  it('打包再解析能还原', () => {
    const jobs = [job('a'), job('b', 'done')];
    expect(parseMirror(buildMirror(jobs))).toEqual(jobs);
  });

  it('结构不对时返回空数组（不让 SW 启动崩掉）', () => {
    expect(parseMirror(null)).toEqual([]);
    expect(parseMirror('x')).toEqual([]);
    expect(parseMirror({})).toEqual([]);
    expect(parseMirror({ jobs: 'nope' })).toEqual([]);
  });

  it('过滤掉坏记录，保留好的', () => {
    const good = job('a');
    expect(parseMirror({ jobs: [good, { id: 1 }, null] })).toEqual([good]);
  });
});

describe('markInterrupted（§6.4）', () => {
  it('offscreen 还在时不动任何任务', () => {
    const jobs = [job('a', 'running')];
    expect(markInterrupted(jobs, true, 100)).toEqual(jobs);
  });

  it('offscreen 不在了：running 和 queued 都标成 interrupted', () => {
    const fixed = markInterrupted([job('a', 'running'), job('b', 'queued')], false, 100);
    expect(fixed.map((j) => j.status)).toEqual(['interrupted', 'interrupted']);
    expect(fixed[0]?.endedAt).toBe(100);
  });

  it('已结束的任务保持原状', () => {
    const fixed = markInterrupted([job('a', 'done'), job('b', 'failed')], false, 100);
    expect(fixed.map((j) => j.status)).toEqual(['done', 'failed']);
  });
});

describe('createMirrorStore（storage.session）', () => {
  it('写入后能读回', async () => {
    const store = createMirrorStore({ area: createMemorySessionArea() });
    await store.write([job('a')]);
    expect(await store.read()).toHaveLength(1);
  });

  it('clear 之后读回空', async () => {
    const store = createMirrorStore({ area: createMemorySessionArea() });
    await store.write([job('a')]);
    await store.clear();
    expect(await store.read()).toEqual([]);
  });

  it('读失败时返回空数组而不是抛错', async () => {
    const store = createMirrorStore({
      area: {
        get: async () => {
          throw new Error('session unavailable');
        },
        set: async () => {},
        remove: async () => {},
      },
    });
    expect(await store.read()).toEqual([]);
  });

  it('recover：offscreen 不在了就把 running 标成 interrupted', async () => {
    const store = createMirrorStore({ area: createMemorySessionArea() });
    await store.write([job('a', 'running'), job('b', 'done')]);
    const recovered = await store.recover(false);
    expect(recovered[0]?.status).toBe('interrupted');
    expect(recovered[1]?.status).toBe('done');
  });

  it('recover：offscreen 还在就原样返回', async () => {
    const store = createMirrorStore({ area: createMemorySessionArea() });
    await store.write([job('a', 'running')]);
    const recovered = await store.recover(true);
    expect(recovered[0]?.status).toBe('running');
  });
});
