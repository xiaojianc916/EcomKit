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

/**
 * 先进先出队列。用「读指针」而不是 Array.shift()：
 * shift() 每次都要把后面所有元素前移一位，一个商品几百张图排同一个域名时就是 O(n²)。
 * 读指针只在浪费的空间超过一半时压缩一次，摊还 O(1)。
 */
interface Bucket {
  active: number;
  queue: Array<(() => void) | undefined>;
  /** queue 里第一个还有效的位置 */
  head: number;
}

function newBucket(): Bucket {
  return { active: 0, queue: [], head: 0 };
}

function push(b: Bucket, run: () => void): void {
  b.queue.push(run);
}

function take(b: Bucket): (() => void) | undefined {
  if (b.head >= b.queue.length) {
    b.queue.length = 0;
    b.head = 0;
    return undefined;
  }
  const run = b.queue[b.head];
  b.queue[b.head] = undefined;
  b.head += 1;
  // 一半以上是空洞时压缩，避免长跑之后数组一直占着内存
  if (b.head > 32 && b.head * 2 >= b.queue.length) {
    b.queue = b.queue.slice(b.head);
    b.head = 0;
  }
  return run;
}

function queuedLength(b: Bucket): number {
  return b.queue.length - b.head;
}

const HOST_CACHE_LIMIT = 256;
const hostCache = new Map<string, string>();

/**
 * 域名归一：去端口、小写；空值归到 unknown 桶，避免一个非法 URL 绕过限制。
 *
 * 为什么不用正则：每次 fetch 都会走这里 2~4 次（取 host、限流、日志），
 * 几百张图就是上千次 /d+$/ 的编译态匹配。这里改成一次 lastIndexOf + 数字判断，
 * 并对归一结果做一个小容量缓存（同一商品的图几乎都来自同几个 CDN 域名）。
 */
export function normalizeHost(host: string | undefined | null): string {
  if (!host) return 'unknown';

  const cached = hostCache.get(host);
  if (cached !== undefined) return cached;

  const lowered = host.trim().toLowerCase();
  const colon = lowered.lastIndexOf(':');
  let normalized = lowered;
  if (colon >= 0 && colon < lowered.length - 1) {
    // 只有 "host:端口" 这一种现实形态（URL.hostname 已经去掉端口，
    // 这里兜住调用方直接传 "cdn.com:443" 的情况）；端口必须全是数字
    let allDigits = true;
    for (let i = colon + 1; i < lowered.length; i += 1) {
      const c = lowered.charCodeAt(i);
      if (c < 48 || c > 57) {
        allDigits = false;
        break;
      }
    }
    if (allDigits) normalized = lowered.slice(0, colon);
  }

  if (hostCache.size >= HOST_CACHE_LIMIT) hostCache.clear();
  hostCache.set(host, normalized);
  return normalized;
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
      b = newBucket();
      buckets.set(host, b);
    }
    return b;
  }

  /** 拿到（或等到）一个并发名额 */
  function acquire(key: string): Promise<void> | null {
    const b = bucket(key);
    if (b.active < limit) {
      b.active += 1;
      return null;
    }
    return new Promise<void>((resolve) => {
      push(b, resolve);
    });
  }

  /**
   * 释放名额。
   *
   * 有排队者时**直接把名额转交**（active 不变），而不是「先减一，再让排队者加回来」：
   * 后者中间有一小段 active 偏小的窗口，期间新来的 run() 会认为还有空位，
   * 于是同一个域名真的跑起 limit+1 个请求 —— 风控就是在这时候被触发的。
   */
  function release(key: string): void {
    const b = buckets.get(key);
    if (!b) return;
    const next = take(b);
    if (next) {
      next();
      return;
    }
    b.active -= 1;
    if (b.active <= 0 && queuedLength(b) === 0) buckets.delete(key);
  }

  return {
    async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
      const key = normalizeHost(host);
      const pending = acquire(key);
      if (pending) await pending;
      try {
        return await fn();
      } finally {
        release(key);
      }
    },
    active(host: string): number {
      return buckets.get(normalizeHost(host))?.active ?? 0;
    },
    waiting(host: string): number {
      const b = buckets.get(normalizeHost(host));
      return b ? queuedLength(b) : 0;
    },
    reset(): void {
      for (const [, b] of buckets) {
        for (let i = b.head; i < b.queue.length; i += 1) {
          const run = b.queue[i];
          if (run) run();
        }
        b.queue.length = 0;
        b.head = 0;
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
