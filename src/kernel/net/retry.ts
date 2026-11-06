import type { ErrorCode } from '../errors/codes';
import { EcError } from '../errors/ec-error';

/**
 * 重试策略（方案 §9.7）。
 *
 * 规则：403 / 429 / 5xx / 超时 / 网络错误重试 3 次，间隔 500ms × 2ⁿ 加 ±30% 随机抖动；
 * 429 优先遵守响应头里的 Retry-After。抖动是必须的 —— 同一批几十张图同时失败时，
 * 固定间隔会让它们在同一毫秒一起重试，等于自己制造一次小流量尖峰。
 */

/** 最多重试几次（不含第一次请求） */
export const MAX_RETRIES = 3;
/** 首次退避基数：500ms × 2ⁿ */
export const BASE_DELAY_MS = 500;
/** 抖动比例 ±30% */
export const JITTER_RATIO = 0.3;
/** Retry-After 的兜底上限，避免服务器给一个离谱的值把队列挂死 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** 可以重试的错误码（和 errors/codes.ts 的 isRetryable 保持一致，这里只做 HTTP 相关收敛） */
const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'HTTP_403',
  'HTTP_429',
  'HTTP_5XX',
  'TIMEOUT',
  'NETWORK',
]);

export function isRetryableCode(code: ErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

/** HTTP 状态码 → 错误码（§9.7 候选切换和重试都靠它分流） */
export function httpStatusToCode(status: number): ErrorCode {
  if (status === 403) return 'HTTP_403';
  if (status === 404 || status === 410) return 'HTTP_404';
  if (status === 429) return 'HTTP_429';
  if (status >= 500) return 'HTTP_5XX';
  if (status === 408 || status === 504) return 'TIMEOUT';
  return 'NETWORK';
}

/**
 * 第 n 次重试（从 1 开始）的等待时间：500 × 2^(n-1)，再乘 ±30% 随机抖动。
 * 传入 random 便于单测固定序列。
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, attempt - 1);
  const base = BASE_DELAY_MS * 2 ** exponent;
  // random() ∈ [0,1) → 倍数 ∈ [0.7, 1.3)
  const factor = 1 - JITTER_RATIO + random() * JITTER_RATIO * 2;
  return Math.round(base * factor);
}

/** 秒数形态：整数或小数。写在模块级只编译一次，不在每次解析时重建 */
const SECONDS_RE = /^\d+(\.\d+)?$/;

/** 解析 Retry-After：既可以是秒数，也可以是 HTTP 日期（§9.7 没有明说，两种都要支持） */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  // 负数不是合法的 Retry-After；先挡掉，否则会被 Date.parse 当成「公元前 1 年」这种怪值
  if (trimmed.startsWith('-')) return null;

  // 只可能是秒数或 HTTP 日期两种形态；先按「第一个字符是数字」粗筛，
  // 绝大多数 429 响应都带 "Retry-After: 5" 这种秒数，正则本身是预编译的，不必每次重建
  if (SECONDS_RE.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS);
  }

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const delta = at - now;
  if (delta <= 0) return 0;
  return Math.min(delta, MAX_RETRY_AFTER_MS);
}

export interface RetryOptions {
  signal: AbortSignal;
  /** 最多重试次数，默认 3 */
  maxRetries?: number;
  /** 每次失败后回调，用来打日志和检查链接是否过期（403 时先判 URL_EXPIRED） */
  onRetry?: (info: { attempt: number; delayMs: number; error: EcError }) => void;
  /** 注入随机数，单测用 */
  random?: () => number;
  /** 注入 sleep，单测用 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * 可中断的等待：取消时立刻结束，不拖到超时。
 *
 * 用官方能力代替手搓的 `new Promise + setTimeout + addEventListener + 手动清理`：
 *  `AbortSignal.timeout` 负责「到点」、`AbortSignal.any` 把外部取消合成进来，
 *  `Promise.withResolvers` 拿到不受 executor 约束的 resolve/reject。
 * 好处不只是少几行：监听器挂在**临时派生信号**上，而不是任务级那个长生命周期的
 * `opts.signal` —— 一次下载最多退避 3 次，几百张图就是几百次往同一个 signal 上挂监听。
 *
 * 版本：`AbortSignal.any` 要 Chrome 116+，`AbortSignal.timeout` 要 103+，
 * 本项目下限 Chrome 122，两者都可用（122 的 timeout 会以 TimeoutError 中止，
 * 但这里只用「它中止了」这个事实，不依赖错误类型）。
 */
export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new EcError('CANCELED'));

  const deadline = AbortSignal.timeout(ms);
  const wake = AbortSignal.any([signal, deadline]);
  const { promise, resolve, reject } = Promise.withResolvers<void>();

  wake.addEventListener(
    'abort',
    () => {
      // 外部取消 → CANCELED；只是到点了 → 正常结束
      if (signal.aborted) reject(new EcError('CANCELED'));
      else resolve();
    },
    { once: true },
  );
  return promise;
}

/**
 * 执行 fn，失败时按策略重试。
 * 不可重试的错误（404、URL_EXPIRED 等）以及取消会立刻抛出，不浪费等待时间。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: EcError | null = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    if (opts.signal.aborted) throw new EcError('CANCELED');
    try {
      return await fn(attempt);
    } catch (e) {
      const error = EcError.from(e);
      lastError = error;
      if (error.code === 'CANCELED' || opts.signal.aborted) throw new EcError('CANCELED');
      if (!isRetryableCode(error.code)) throw error;
      if (attempt > maxRetries) break;

      const explicit = readRetryAfterMs(error);
      const delayMs = explicit ?? backoffDelay(attempt, random);
      opts.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, opts.signal);
    }
  }
  throw lastError ?? new EcError('INTERNAL', { reason: 'retry-exhausted' });
}

/** 429 的 Retry-After 藏在 EcError.detail 里（fetch 层解析后放进去） */
function readRetryAfterMs(error: EcError): number | null {
  const detail = error.detail;
  if (typeof detail !== 'object' || detail === null) return null;
  const value = (detail as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.min(value, MAX_RETRY_AFTER_MS);
  }
  return null;
}
