import { describe, expect, it } from 'vitest';
import { type TimerApi, withDeadline, withIdleTimeout } from './stream-timers';

/** 手动推进的计时器：这套超时逻辑不该靠真实等待来测 */
class FakeTimers implements TimerApi {
  private time = 0;
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    this.seq += 1;
    this.pending.set(this.seq, { at: this.time + ms, fn });
    return this.seq;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  now(): number {
    return this.time;
  }

  /** 推进时钟并触发到点的计时器 */
  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of [...this.pending]) {
      if (timer.at <= this.time) {
        this.pending.delete(id);
        timer.fn();
      }
    }
  }

  get armed(): number {
    return this.pending.size;
  }
}

/** 永不产出数据的源流（模拟网络卡死） */
function stallingStream(): { stream: ReadableStream<Uint8Array>; canceled: () => boolean } {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
    cancel: () => {
      canceled = true;
    },
  });
  return { stream, canceled: () => canceled };
}

/** 一直有数据的源流，每块两字节 */
function endlessStream(): { stream: ReadableStream<Uint8Array>; reads: () => number } {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      controller.enqueue(new Uint8Array([reads, 0]));
    },
  });
  return { stream, reads: () => reads };
}

/** 让出微任务队列，等流把 pull 跑完 */
async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe('withDeadline（图片 20 秒总超时）', () => {
  it('数据原样透传，顺序和内容都不变', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const guarded = withDeadline(source, 20_000, new FakeTimers());
    const merged = new Uint8Array(await new Response(guarded).arrayBuffer());
    expect([...merged]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('到点还没读完 → TIMEOUT，并 cancel 源流（让底层 fetch 真正停下）', async () => {
    const timers = new FakeTimers();
    const { stream, canceled } = stallingStream();
    const reader = withDeadline(stream, 20_000, timers).getReader();

    const read = reader.read();
    await tick();
    timers.advance(20_000);

    await expect(read).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(canceled()).toBe(true);
  });

  it('正常读完就清掉计时器，不留悬挂的定时器', async () => {
    const timers = new FakeTimers();
    const { stream } = endlessStream();
    const reader = withDeadline(stream, 20_000, timers).getReader();
    await reader.read();
    await reader.cancel();
    expect(timers.armed).toBe(0);
  });
});

describe('withIdleTimeout（视频 30 秒空闲超时）', () => {
  it('空闲超过上限 → TIMEOUT', async () => {
    const timers = new FakeTimers();
    const { stream, canceled } = stallingStream();
    const reader = withIdleTimeout(stream, 30_000, timers).getReader();

    const read = reader.read();
    await tick();
    timers.advance(30_000);

    await expect(read).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(canceled()).toBe(true);
  });

  it('下游消费慢不算空闲超时（慢的是磁盘，不是网络）', async () => {
    const timers = new FakeTimers();
    const { stream } = endlessStream();
    const reader = withIdleTimeout(stream, 30_000, timers).getReader();

    // 每块之间都隔 20 秒（不到 30 秒空闲上限），总时长已经远超 30 秒
    for (let i = 0; i < 3; i += 1) {
      const { done } = await reader.read();
      expect(done).toBe(false);
      timers.advance(20_000);
    }
    await reader.cancel();
  });

  it('持续有数据时不超时（几百 MB 视频的总时长不受限制）', async () => {
    const timers = new FakeTimers();
    const { stream } = endlessStream();
    const reader = withIdleTimeout(stream, 30_000, timers).getReader();
    for (let i = 0; i < 50; i += 1) {
      const { value } = await reader.read();
      expect(value?.byteLength).toBe(2);
    }
    await reader.cancel();
    expect(timers.armed).toBe(0);
  });
});

describe('背压（几十上百 MB 的视频不能整段堆在内存里）', () => {
  it('下游不读时不会把源流抽干', async () => {
    const timers = new FakeTimers();
    const { stream, reads } = endlessStream();
    const guarded = withDeadline(stream, 20_000, timers);

    // 完全没人读：源流最多被预读 1 块（highWaterMark），不是无限拉
    await tick(10);
    expect(reads()).toBeLessThanOrEqual(2);

    await guarded.cancel();
    const afterCancel = reads();
    await tick(10);
    expect(reads()).toBe(afterCancel);
  });

  it('cancel 会 cancel 源 reader，底层连接能停下', async () => {
    const { stream, canceled } = stallingStream();
    const guarded = withIdleTimeout(stream, 30_000, new FakeTimers());
    await guarded.cancel();
    expect(canceled()).toBe(true);
  });
});
