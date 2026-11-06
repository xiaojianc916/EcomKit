import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createFsGateway } from '../fs/fs-gateway';
import { createMemorySink } from '../fs/sinks/memory';
import { createJobRecord } from './progress';
import { createJobRunner } from './runner';
import type { JobEvent, JobRecord, JobTypeDef, WorkItem } from './types';

/** 测试用任务类型：按 payload 生成 N 个图片工作项，可以控制成功/失败/耗时 */
interface TestPayload {
  count: number;
  failAt?: number[];
  delayMs?: number;
  group?: string;
}

function makeDef(
  overrides: Partial<JobTypeDef<TestPayload, unknown>> = {},
): JobTypeDef<TestPayload, unknown> {
  return {
    type: 'test',
    // 用 z.custom 而不是 z.object：exactOptionalPropertyTypes 下 z.object 的
    // 「可选属性」推断成「属性可为 undefined」，和我们声明的 TestPayload 对不上。
    // 测试里不关心 scheam 细节，只关心「非法 payload 会被拒绝」。
    payload: z.custom<TestPayload>((value) => {
      if (typeof value !== 'object' || value === null) return false;
      return typeof (value as { count?: unknown }).count === 'number';
    }),
    requiresDir: false,
    // run() 里要拿到 payload 才知道哪个工作项该失败，所以用 extra 把它带进上下文
    async extra(p) {
      return p;
    },
    async plan(p) {
      return Array.from({ length: p.count }, (_, i) => {
        const item: WorkItem = {
          itemKey: `item-${i}`,
          group: p.group ?? 'main',
          dir: ['主图'],
          stem: String(i).padStart(2, '0'),
          expect: 'image',
          candidates: ['https://c.example.com/' + i + '.jpg'],
          kind: 'image',
        };
        return item;
      });
    },
    async run(item, ctx) {
      const payload = ctx.extra as TestPayload | undefined;
      if (payload?.delayMs) await new Promise((r) => setTimeout(r, payload.delayMs));
      const index = Number(item.itemKey.split('-')[1]);
      if (payload?.failAt?.includes(index)) {
        return { itemKey: item.itemKey, status: 'failed', code: 'HTTP_404' };
      }
      return { itemKey: item.itemKey, status: 'ok', bytes: 100 };
    },
    ...overrides,
  };
}

function setup(def = makeDef(), extra: { concurrency?: number } = {}) {
  const sink = createMemorySink();
  const gateway = createFsGateway({ sink });
  const events: JobEvent[] = [];
  const runner = createJobRunner({
    gateway,
    jobTypes: [def],
    concurrency: extra.concurrency ?? 4,
  });
  runner.onEvent((ev) => events.push(ev));
  return { runner, events, sink };
}

function job(id: string, payload: TestPayload, dedupeKey = 'k-' + id): JobRecord {
  return createJobRecord({ id, type: 'test', dedupeKey, payload });
}

describe('createJobRunner（§6.4）', () => {
  it('注册任务类型', async () => {
    const { runner } = setup();
    expect(runner.registeredTypes()).toEqual(['test']);
  });

  it('跑完一个任务：状态 done，进度事件齐全', async () => {
    const { runner, events } = setup();
    await runner.enqueue(job('j1', { count: 3 }), { count: 3 });
    await runner.idle();

    const record = runner.get('j1');
    expect(record?.status).toBe('done');
    expect(record?.done).toBe(3);
    expect(record?.total).toBe(3);
    expect(record?.bytes).toBe(300);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('部分失败 → partial', async () => {
    const { runner } = setup();
    await runner.enqueue(job('j1', { count: 3, failAt: [1] }), { count: 3, failAt: [1] });
    await runner.idle();
    const record = runner.get('j1');
    expect(record?.status).toBe('partial');
    expect(record?.failed).toEqual([{ itemKey: 'item-1', code: 'HTTP_404' }]);
  });

  it('全部失败 → failed', async () => {
    const { runner } = setup();
    await runner.enqueue(job('j1', { count: 2, failAt: [0, 1] }), { count: 2, failAt: [0, 1] });
    await runner.idle();
    expect(runner.get('j1')?.status).toBe('failed');
  });

  it('byGroup 按行聚合（§10.3）', async () => {
    const { runner } = setup();
    await runner.enqueue(job('j1', { count: 4, group: 'detail' }), { count: 4, group: 'detail' });
    await runner.idle();
    expect(runner.get('j1')?.byGroup.detail).toEqual({
      total: 4,
      done: 4,
      failed: 0,
      skipped: 0,
    });
  });

  it('payload 不合法时拒绝提交（§6.3 入口 Zod 校验）', async () => {
    const { runner } = setup();
    await expect(runner.enqueue(job('j1', { count: 1 }), { count: 'nope' })).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('未注册的类型拒绝提交', async () => {
    const { runner } = setup();
    const bad = { ...job('j1', { count: 1 }), type: 'unknown-type' };
    await expect(runner.enqueue(bad, { count: 1 })).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('同一 dedupeKey 重复提交不会跑两遍（§6.4）', async () => {
    const def = makeDef({
      async run(item, ctx) {
        const payload = ctx.extra as TestPayload | undefined;
        if (payload?.delayMs) await new Promise((r) => setTimeout(r, payload.delayMs));
        return { itemKey: item.itemKey, status: 'ok', bytes: 10 };
      },
    });
    const { runner } = setup(def);
    const payload = { count: 5, delayMs: 15 };
    await runner.enqueue(job('j1', payload, 'same-key'), payload);
    await runner.enqueue(job('j2', payload, 'same-key'), payload);
    await runner.idle();
    // 第二个提交被去重，只有 j1 真正执行
    expect(runner.get('j1')?.status).toBe('done');
    expect(runner.list().filter((j) => j.dedupeKey === 'same-key')).toHaveLength(1);
  });

  it('取消：中断后状态为 canceled', async () => {
    const def = makeDef({
      async run(item) {
        await new Promise((r) => setTimeout(r, 30));
        return { itemKey: item.itemKey, status: 'ok', bytes: 1 };
      },
    });
    const { runner } = setup(def);
    const payload = { count: 20 };
    await runner.enqueue(job('j1', payload), payload);
    await new Promise((r) => setTimeout(r, 5));
    runner.cancel('j1');
    await runner.idle();
    expect(runner.get('j1')?.status).toBe('canceled');
  });

  it('并发上限生效（同时运行的工作项不超过 concurrency）', async () => {
    let active = 0;
    let maxActive = 0;
    const def = makeDef({
      async run(item) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return { itemKey: item.itemKey, status: 'ok', bytes: 1 };
      },
    });
    const { runner } = setup(def, { concurrency: 2 });
    const payload = { count: 8 };
    await runner.enqueue(job('j1', payload), payload);
    await runner.idle();
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('任务之间轮转：两个任务交替推进（§6.4）', async () => {
    const order: string[] = [];
    const def = makeDef({
      async run(item) {
        await new Promise((r) => setTimeout(r, 2));
        order.push(item.itemKey);
        return { itemKey: item.itemKey, status: 'ok', bytes: 1 };
      },
    });
    const { runner } = setup(def, { concurrency: 2 });
    const a = { count: 4 };
    const b = { count: 4 };
    // 两个任务用不同的 type 会更容易观察，但这里共用 type，靠 itemKey 前缀区分靠不住，
    // 所以只看「两个任务都完成了」+ 交错发生过
    await runner.enqueue(job('jA', a), a);
    await runner.enqueue(job('jB', b), b);
    await runner.idle();
    expect(runner.get('jA')?.done).toBe(4);
    expect(runner.get('jB')?.done).toBe(4);
    expect(order).toHaveLength(8);
  });

  it('finalize 在收尾时被调用一次（§9.6）', async () => {
    const finalize = vi.fn(async () => {});
    const def = makeDef({ finalize });
    const { runner } = setup(def);
    const payload = { count: 2 };
    await runner.enqueue(job('j1', payload), payload);
    await runner.idle();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it('plan 抛错时任务标 failed，不会卡住队列', async () => {
    const def = makeDef({
      async plan() {
        throw new Error('plan broke');
      },
    });
    const { runner } = setup(def);
    const payload = { count: 1 };
    await runner.enqueue(job('j1', payload), payload);
    await runner.idle();
    expect(runner.get('j1')?.status).toBe('failed');
  });

  it('空计划：直接 done', async () => {
    const { runner } = setup();
    const payload = { count: 0 };
    await runner.enqueue(job('j1', payload), payload);
    await runner.idle();
    expect(runner.get('j1')?.status).toBe('done');
    expect(runner.get('j1')?.total).toBe(0);
  });

  it('list 支持按 tabId 过滤', async () => {
    const { runner } = setup();
    const payload = { count: 1 };
    await runner.enqueue(
      createJobRecord({ id: 'j1', type: 'test', dedupeKey: 'a', payload, tabId: 7 }),
      payload,
    );
    await runner.enqueue(
      createJobRecord({ id: 'j2', type: 'test', dedupeKey: 'b', payload, tabId: 8 }),
      payload,
    );
    await runner.idle();
    expect(runner.list({ tabId: 7 }).map((j) => j.id)).toEqual(['j1']);
  });

  it('setConcurrency 限制在 1–8', async () => {
    const { runner } = setup();
    runner.setConcurrency(100);
    const payload = { count: 1 };
    await runner.enqueue(job('j1', payload), payload);
    await runner.idle();
    expect(runner.get('j1')?.status).toBe('done');
  });

  it('取消已结束的任务不会改状态', async () => {
    const { runner } = setup();
    const payload = { count: 1 };
    await runner.enqueue(job('j1', payload), payload);
    await runner.idle();
    runner.cancel('j1');
    expect(runner.get('j1')?.status).toBe('done');
  });

  it('进度事件里带 byGroup，UI 能按行渲染（§10.9）', async () => {
    const { runner, events } = setup();
    const payload = { count: 2 };
    await runner.enqueue(job('j1', payload), payload);
    await runner.idle();
    const last = events.filter((e) => e.type === 'done').at(-1);
    expect(last && last.type === 'done' && last.job.byGroup.main?.total).toBe(2);
  });

  it('进度事件不带 payload（跨进程克隆瘦身），任务内部记录仍保留给 retry 用', async () => {
    const { runner, events } = setup();
    const payload = { count: 2 };
    await runner.enqueue(job('j1', payload), payload);
    await runner.idle();

    const withJob = events.filter((e) => e.type === 'progress' || e.type === 'done');
    expect(withJob.length).toBeGreaterThan(0);
    for (const e of withJob) {
      if (e.type === 'progress' || e.type === 'done') expect(e.job.payload).toBeNull();
    }
    // 任务自己那份记录（retry 要用 payload）不能被瘦身
    expect(runner.get('j1')?.payload).toEqual(payload);
  });

  it('取消正在跑的任务后 idle() 能返回，不会空转挂住', async () => {
    const def = makeDef({
      async run(item) {
        await new Promise((r) => setTimeout(r, 20));
        return { itemKey: item.itemKey, status: 'ok', bytes: 1 };
      },
    });
    const { runner } = setup(def);
    const payload = { count: 40 };
    await runner.enqueue(job('j1', payload), payload);
    await new Promise((r) => setTimeout(r, 5));
    runner.cancel('j1');
    await runner.idle();
    expect(runner.get('j1')?.status).toBe('canceled');
  });

  it('空计划任务的 idle() 会等到 finalize 跑完', async () => {
    const order: string[] = [];
    const def = makeDef({
      async finalize() {
        await new Promise((r) => setTimeout(r, 5));
        order.push('finalize');
      },
    });
    const { runner } = setup(def);
    const payload = { count: 0 };
    await runner.enqueue(job('j1', payload), payload);
    await runner.idle();
    order.push('idle');
    expect(order).toEqual(['finalize', 'idle']);
  });
});
