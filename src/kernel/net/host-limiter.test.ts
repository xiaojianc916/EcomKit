import { describe, expect, it } from 'vitest';
import { createHostLimiter, HOST_CONCURRENCY, hostOf, normalizeHost } from './host-limiter';

/** 可手动放行的任务：用来精确观察并发 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('normalizeHost / hostOf', () => {
  it('去端口、转小写', () => {
    expect(normalizeHost('Img.PDDpic.com:443')).toBe('img.pddpic.com');
    expect(normalizeHost(undefined)).toBe('unknown');
    expect(normalizeHost('')).toBe('unknown');
  });

  it('从 URL 取域名，非法 URL 归到 unknown', () => {
    expect(hostOf('https://pddpic.com/a.jpg')).toBe('pddpic.com');
    expect(hostOf('not a url')).toBe('unknown');
  });
});

describe('normalizeHost 缓存与端口处理', () => {
  it('带端口/大写都归一到同一个桶', () => {
    expect(normalizeHost('CDN.Example.com:8443')).toBe('cdn.example.com');
    expect(normalizeHost('cdn.example.com')).toBe('cdn.example.com');
    expect(normalizeHost('  cdn.example.com  ')).toBe('cdn.example.com');
  });

  it('IPv6 字面量和冒号结尾不被误切', () => {
    expect(normalizeHost('[::1]')).toBe('[::1]');
    expect(normalizeHost('example.com:')).toBe('example.com:');
  });

  it('反复调用结果稳定（走了缓存）', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(normalizeHost('Img.PDDpic.com:443')).toBe('img.pddpic.com');
    }
  });
});

describe('createHostLimiter（§6.4 同域名 ≤4）', () => {
  it('同域名并发不超过 4', async () => {
    const limiter = createHostLimiter();
    let running = 0;
    let maxRunning = 0;
    const gates = Array.from({ length: 10 }, () => deferred());
    const tasks = gates.map((gate) =>
      limiter.run('cdn.example.com', async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await gate.promise;
        running -= 1;
      }),
    );

    // 让已提交的任务全部跑起来
    await Promise.resolve();
    expect(limiter.active('cdn.example.com')).toBe(HOST_CONCURRENCY);
    expect(limiter.waiting('cdn.example.com')).toBe(6);

    for (const gate of gates) {
      gate.resolve();
      await Promise.resolve();
    }
    await Promise.all(tasks);
    expect(maxRunning).toBeLessThanOrEqual(HOST_CONCURRENCY);
  });

  it('不同域名互不影响', async () => {
    const limiter = createHostLimiter(1);
    const a = deferred();
    const b = deferred();
    const taskA = limiter.run('a.com', () => a.promise);
    const taskB = limiter.run('b.com', () => b.promise);
    expect(limiter.active('a.com')).toBe(1);
    expect(limiter.active('b.com')).toBe(1);
    a.resolve();
    b.resolve();
    await Promise.all([taskA, taskB]);
  });

  it('任务失败不会卡住队列', async () => {
    const limiter = createHostLimiter(1);
    await expect(
      limiter.run('a.com', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(limiter.run('a.com', async () => 'ok')).resolves.toBe('ok');
  });

  it('全部跑完后桶被回收，不泄漏', async () => {
    const limiter = createHostLimiter(1);
    await limiter.run('a.com', async () => {});
    expect(limiter.active('a.com')).toBe(0);
    expect(limiter.waiting('a.com')).toBe(0);
  });

  it('名额直接转交，新来的 run 不会插队到 limit+1', async () => {
    const limiter = createHostLimiter(1);
    const gates = [deferred(), deferred()];
    const first = limiter.run('a.com', () => gates[0]!.promise);
    let secondRunning = false;
    const second = limiter.run('a.com', async () => {
      secondRunning = true;
    });
    await Promise.resolve();
    expect(limiter.active('a.com')).toBe(1);
    expect(limiter.waiting('a.com')).toBe(1);

    // 第一个结束的同一时刻再进来一个：名额要转交给排队的那个，不能两个都跑
    gates[0]!.resolve();
    await Promise.resolve();
    const third = limiter.run('a.com', async () => {});
    await Promise.all([first, second, third]);
    expect(secondRunning).toBe(true);
    expect(limiter.active('a.com')).toBe(0);
  });

  it('大量排队（几百张图）时队列不退化', async () => {
    const limiter = createHostLimiter(2);
    let peak = 0;
    let running = 0;
    const tasks = Array.from({ length: 300 }, () =>
      limiter.run('cdn.example.com', async () => {
        running += 1;
        peak = Math.max(peak, running);
        await Promise.resolve();
        running -= 1;
      }),
    );
    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(2);
    expect(limiter.active('cdn.example.com')).toBe(0);
    expect(limiter.waiting('cdn.example.com')).toBe(0);
  });

  it('reset 后排队任务被放行', async () => {
    const limiter = createHostLimiter(1);
    const gate = deferred();
    const first = limiter.run('a.com', () => gate.promise);
    let secondRan = false;
    const second = limiter.run('a.com', async () => {
      secondRan = true;
    });
    limiter.reset();
    gate.resolve();
    await Promise.all([first, second]);
    expect(secondRan).toBe(true);
  });
});
