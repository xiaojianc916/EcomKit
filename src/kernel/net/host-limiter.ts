/**
 * 按域名限制并发（方案 §6.4「同一 CDN 域名同时最多 4 个请求」）。
 *
 * 为什么要单独限流：全局并发是 6，但同一批详情图往往来自同一个 CDN，
 * 6 个请求同时打到同一个域名更容易触发风控。按域名分桶后，
 * 全局并发依旧，压力却分散到了不同域名上。
 */

/** 同一域名最多同时几个请求（§6.4） */
export const HOST_CONCURRENCY = 4;

export interface HostLimiter {
  /** 在该域名下排队执行 fn；返回 fn 的结果 */
  run<T>(host: string, fn: () => Promise<T>): Promise<T>;
  /** 当前在跑的请求数 */
  active(host: string): number;
  /** 当前排队数 */
  waiting(host: string): number;
  /** 清空所有桶（测试和「取消全部任务」用） */
  reset(): void;
}

interface Bucket {
  active: number;
  queue: Array<() => void>;
}

/** 域名归一：去端口、小写；空值归到 unknown 桶，避免一个非法 URL 绕过限制 */
export function normalizeHost(host: string | undefined | null): string {
  if (!host) return 'unknown';
  return host.trim().toLowerCase().replace(/:\d+$/, '');
}

/** 从 URL 取域名；取不到时用 unknown 桶 */
export function hostOf(url: string): string {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return 'unknown';
  }
}

export function createHostLimiter(limit = HOST_CONCURRENCY): HostLimiter {
  const buckets = new Map<string, Bucket>();

  function bucket(host: string): Bucket {
    let b = buckets.get(host);
    if (!b) {
      b = { active: 0, queue: [] };
      buckets.set(host, b);
    }
    return b;
  }

  function next(host: string): void {
    const b = bucket(host);
    const run = b.queue.shift();
    if (run) run();
    else if (b.active === 0) buckets.delete(host);
  }

  return {
    async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
      const key = normalizeHost(host);
      const b = bucket(key);
      if (b.active >= limit) {
        await new Promise<void>((resolve) => {
          b.queue.push(resolve);
        });
      }
      b.active += 1;
      try {
        return await fn();
      } finally {
        b.active -= 1;
        next(key);
      }
    },
    active(host: string): number {
      return buckets.get(normalizeHost(host))?.active ?? 0;
    },
    waiting(host: string): number {
      return buckets.get(normalizeHost(host))?.queue.length ?? 0;
    },
    reset(): void {
      for (const [, b] of buckets) {
        for (const run of b.queue) run();
        b.queue.length = 0;
      }
      buckets.clear();
    },
  };
}

/** 全局单例：offcreen 里所有 fetch 都走它 */
let shared: HostLimiter | null = null;

export function hostLimiter(): HostLimiter {
  shared ??= createHostLimiter();
  return shared;
}
