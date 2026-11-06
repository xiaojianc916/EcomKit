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

  it('recover：标成 interrupted 的记录要写回镜像，不能被写没了', async () => {
    const area = createMemorySessionArea();
    const store = createMirrorStore({ area });
    await store.write([job('a', 'running'), job('b', 'done')]);
    await store.recover(false);
    // 再读一次：镜像是全新的 store 读取的，不能依赖 recover 的返回值
    const reread = await createMirrorStore({ area }).read();
    expect(reread.map((j) => j.status)).toEqual(['interrupted', 'done']);
  });

  it('写入时剥掉 payload（storage.session 只有 10MB 配额）', async () => {
    const area = createMemorySessionArea();
    const store = createMirrorStore({ area });
    const heavy = { ...job('a'), payload: { snapshot: 'x'.repeat(1024) } };
    await store.write([heavy]);
    const raw = (await area.get('jobs.mirror'))['jobs.mirror'] as {
      jobs: Array<{ payload: unknown }>;
    };
    expect(raw.jobs[0]?.payload).toBeNull();
    // 读回来仍然是一条可用记录
    expect((await store.read())[0]?.id).toBe('a');
  });

  it('缺 byGroup / skipped / bytes 的旧镜像记录会被过滤掉（UI 会直接读这些字段）', () => {
    const good = job('a');
    const legacy = {
      id: 'b',
      type: 't',
      status: 'done',
      dedupeKey: 'k',
      total: 1,
      done: 1,
      failed: [],
    };
    expect(parseMirror({ jobs: [good, legacy] }).map((j) => j.id)).toEqual(['a']);
  });
});
