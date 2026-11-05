import { describe, expect, it, vi } from 'vitest';
import { EcError } from '../errors/ec-error';
import {
  BASE_DELAY_MS,
  backoffDelay,
  defaultSleep,
  httpStatusToCode,
  isRetryableCode,
  JITTER_RATIO,
  MAX_RETRIES,
  parseRetryAfter,
  withRetry,
} from './retry';

describe('backoffDelay（§9.7 指数退避 + 抖动）', () => {
  it('基数 500ms 起、每次翻倍', () => {
    // random=0.5 → 倍数正好 1.0（无抖动偏移）
    expect(backoffDelay(1, () => 0.5)).toBe(BASE_DELAY_MS);
    expect(backoffDelay(2, () => 0.5)).toBe(BASE_DELAY_MS * 2);
    expect(backoffDelay(3, () => 0.5)).toBe(BASE_DELAY_MS * 4);
  });

  it('抖动范围是 ±30%', () => {
    const low = backoffDelay(1, () => 0);
    const high = backoffDelay(1, () => 0.999999);
    expect(low).toBe(Math.round(BASE_DELAY_MS * (1 - JITTER_RATIO)));
    expect(high).toBeLessThanOrEqual(Math.round(BASE_DELAY_MS * (1 + JITTER_RATIO)));
    expect(high).toBeGreaterThan(BASE_DELAY_MS);
  });

  it('attempt 从 1 开始，0 或负数不产生负间隔', () => {
    expect(backoffDelay(0, () => 0.5)).toBe(BASE_DELAY_MS);
    expect(backoffDelay(-3, () => 0.5)).toBe(BASE_DELAY_MS);
  });
});

describe('parseRetryAfter', () => {
  const NOW = 1_793_000_000_000;

  it('秒数形式', () => {
    expect(parseRetryAfter('3', NOW)).toBe(3000);
    expect(parseRetryAfter('0', NOW)).toBe(0);
  });

  it('HTTP 日期形式', () => {
    const date = new Date(NOW + 5000).toUTCString();
    expect(parseRetryAfter(date, NOW)).toBe(5000);
  });

  it('过去的日期 → 0（立刻重试）', () => {
    const date = new Date(NOW - 5000).toUTCString();
    expect(parseRetryAfter(date, NOW)).toBe(0);
  });

  it('非法值返回 null', () => {
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter('', NOW)).toBeNull();
    expect(parseRetryAfter('abc', NOW)).toBeNull();
    expect(parseRetryAfter('-1', NOW)).toBeNull();
  });

  it('过大的值被截断到 30 秒（不让服务器把队列挂死）', () => {
    expect(parseRetryAfter('3600', NOW)).toBe(30_000);
  });
});

describe('withRetry（§9.7）', () => {
  const signal = () => new AbortController().signal;
  const noSleep = async () => {};

  it('第一次成功就不重试', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn, { signal: signal(), sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('可重试错误最多重试 3 次', async () => {
    const fn = vi.fn(async () => {
      throw new EcError('HTTP_5XX');
    });
    await expect(withRetry(fn, { signal: signal(), sleep: noSleep })).rejects.toMatchObject({
      code: 'HTTP_5XX',
    });
    expect(fn).toHaveBeenCalledTimes(MAX_RETRIES + 1);
  });

  it('第 2 次成功时返回结果', async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls < 2) throw new EcError('NETWORK');
      return 'ok';
    };
    await expect(withRetry(fn, { signal: signal(), sleep: noSleep })).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('不可重试的错误（404）立刻抛出', async () => {
    const fn = vi.fn(async () => {
      throw new EcError('HTTP_404');
    });
    await expect(withRetry(fn, { signal: signal(), sleep: noSleep })).rejects.toMatchObject({
      code: 'HTTP_404',
    });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('URL_EXPIRED 不重试（重试也没用）', async () => {
    const fn = vi.fn(async () => {
      throw new EcError('URL_EXPIRED');
    });
    await expect(withRetry(fn, { signal: signal(), sleep: noSleep })).rejects.toMatchObject({
      code: 'URL_EXPIRED',
    });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('429 遵守 Retry-After', async () => {
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      throw new EcError('HTTP_429', { retryAfterMs: 7000 });
    });
    await expect(
      withRetry(fn, {
        signal: signal(),
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toMatchObject({ code: 'HTTP_429' });
    expect(delays).toEqual([7000, 7000, 7000]);
  });

  it('没有 Retry-After 时用指数退避', async () => {
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      throw new EcError('HTTP_403');
    });
    await expect(
      withRetry(fn, {
        signal: signal(),
        random: () => 0.5,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toMatchObject({ code: 'HTTP_403' });
    expect(delays).toEqual([500, 1000, 2000]);
  });

  it('取消后立刻停止，不再重试', async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      controller.abort();
      throw new EcError('TIMEOUT');
    });
    await expect(
      withRetry(fn, { signal: controller.signal, sleep: noSleep }),
    ).rejects.toMatchObject({
      code: 'CANCELED',
    });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('已经取消时直接抛 CANCELED，不调用 fn', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => 'ok');
    await expect(
      withRetry(fn, { signal: controller.signal, sleep: noSleep }),
    ).rejects.toMatchObject({
      code: 'CANCELED',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('onRetry 拿到次数、延迟和错误', async () => {
    const seen: Array<{ attempt: number; delayMs: number; code: string }> = [];
    await expect(
      withRetry(
        async () => {
          throw new EcError('HTTP_5XX');
        },
        {
          signal: signal(),
          random: () => 0.5,
          sleep: noSleep,
          onRetry: ({ attempt, delayMs, error }) => {
            seen.push({ attempt, delayMs, code: error.code });
          },
        },
      ),
    ).rejects.toBeInstanceOf(EcError);
    expect(seen).toEqual([
      { attempt: 1, delayMs: 500, code: 'HTTP_5XX' },
      { attempt: 2, delayMs: 1000, code: 'HTTP_5XX' },
      { attempt: 3, delayMs: 2000, code: 'HTTP_5XX' },
    ]);
  });
});

describe('defaultSleep', () => {
  it('取消时立刻结束', async () => {
    const controller = new AbortController();
    const promise = defaultSleep(10_000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'CANCELED' });
  });

  it('正常等待到点', async () => {
    await expect(defaultSleep(5, new AbortController().signal)).resolves.toBeUndefined();
  });
});

describe('httpStatusToCode / isRetryableCode（§6.2）', () => {
  it('状态码映射', () => {
    expect(httpStatusToCode(403)).toBe('HTTP_403');
    expect(httpStatusToCode(404)).toBe('HTTP_404');
    expect(httpStatusToCode(410)).toBe('HTTP_404');
    expect(httpStatusToCode(429)).toBe('HTTP_429');
    expect(httpStatusToCode(500)).toBe('HTTP_5XX');
    expect(httpStatusToCode(503)).toBe('HTTP_5XX');
    expect(httpStatusToCode(408)).toBe('TIMEOUT');
    expect(httpStatusToCode(400)).toBe('NETWORK');
  });

  it('只有网络类错误可重试', () => {
    for (const code of ['HTTP_403', 'HTTP_429', 'HTTP_5XX', 'TIMEOUT', 'NETWORK'] as const) {
      expect(isRetryableCode(code)).toBe(true);
    }
    for (const code of ['HTTP_404', 'URL_EXPIRED', 'CANCELED', 'DIR_GONE'] as const) {
      expect(isRetryableCode(code)).toBe(false);
    }
  });
});
