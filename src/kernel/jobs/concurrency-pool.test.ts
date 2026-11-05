import { describe, expect, it } from 'vitest';
import { createConcurrencyPool } from './concurrency-pool';

describe('createConcurrencyPool（§6.4 并发控制）', () => {
  it('并发不超过上限', async () => {
    const pool = createConcurrencyPool(2);
    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: 8 }, () =>
      pool.add(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      }),
    );
    await Promise.all(tasks);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('任务抛错不会卡住池', async () => {
    const pool = createConcurrencyPool(1);
    await expect(
      pool.add(async () => {
        throw new Error('boom');
      }),
    ).resolves.toBeUndefined();
    await expect(pool.add(async () => undefined)).resolves.toBeUndefined();
  });

  it('setConcurrency 调大后立刻放出排队任务', async () => {
    const pool = createConcurrencyPool(1);
    let started = 0;
    let release: () => void = () => {};
    // 先建好闸门再提交任务：任务体里引用的是同一个 promise
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (let i = 0; i < 3; i += 1) {
      void pool.add(async () => {
        started += 1;
        await gate;
      });
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toBe(1);
    pool.setConcurrency(3);
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toBe(3);
    release();
    await pool.onIdle();
  });

  it('active / pending 反映真实状态', async () => {
    const pool = createConcurrencyPool(1);
    const gate: Array<() => void> = [];
    void pool.add(() => new Promise<void>((r) => gate.push(r)));
    void pool.add(() => new Promise<void>((r) => gate.push(r)));
    await new Promise((r) => setTimeout(r, 0));
    expect(pool.active).toBe(1);
    expect(pool.pending).toBe(1);
    // 逐个放行：第二个任务开始后会往 gate 里压入新的放行函数
    while (gate.length > 0) {
      const fn = gate.shift();
      fn?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    await pool.onIdle();
    expect(pool.active).toBe(0);
    expect(pool.pending).toBe(0);
  });

  it('onIdle 在空池时立刻 resolve', async () => {
    const pool = createConcurrencyPool(2);
    await expect(pool.onIdle()).resolves.toBeUndefined();
  });

  it('clear 丢弃排队任务', async () => {
    const pool = createConcurrencyPool(1);
    const gate: Array<() => void> = [];
    void pool.add(() => new Promise<void>((r) => gate.push(r)));
    void pool.add(() => new Promise<void>((r) => gate.push(r)));
    await new Promise((r) => setTimeout(r, 0));
    pool.clear();
    expect(pool.pending).toBe(0);
    gate.shift()?.();
    await pool.onIdle();
    expect(pool.active).toBe(0);
  });
});
