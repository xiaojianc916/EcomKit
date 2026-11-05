import { EcError } from '../errors/ec-error';
import type { Logger } from '../log/logger';
import { isExpired } from './expiry';
import { type HostLimiter, hostLimiter, hostOf } from './host-limiter';
import { httpStatusToCode, parseRetryAfter, withRetry } from './retry';
import { matchesExpectation, readHead, SNIFF_BYTES, sniff } from './sniff';
import { realTimers, type TimerApi, withDeadline, withIdleTimeout } from './stream-timers';
import type { Fetcher, FetchOpts, SniffResult } from './types';

/**
 * 取数（方案 §9.7）。功能层只调 fetchWithFallback(candidates, opts)。
 *
 * 集中在这一处的规则：
 *   · credentials:'omit', cache:'no-store' —— 不带 Cookie，不用缓存（§9.7、§13）
 *   · 404/410 → 换下一个候选；全部 404 才报 HTTP_404
 *   · 403/429/5xx/超时/网络错误重试 3 次（retry.ts）；403 重试前先判链接是否过期
 *   · 图片 20 秒**总**超时；视频 30 秒**空闲**超时（stream-timers.ts）
 *   · Content-Type 不能是 text/html（CDN 拒绝访问时常返回 200 的 HTML 错误页）
 *   · 嗅探结果的类型必须符合期望，否则换下一个候选
 */

/** 图片：单个请求总超时（§9.7） */
export const IMAGE_TIMEOUT_MS = 20_000;
/** 视频：空闲超时，30 秒没收到新数据才算超时（§9.7） */
export const VIDEO_IDLE_TIMEOUT_MS = 30_000;

const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

export interface FetcherOptions {
  fetchImpl?: typeof fetch;
  limiter?: HostLimiter;
  log?: Logger;
  timers?: TimerApi;
  /** 单测里关掉真实等待 */
  maxRetries?: number;
}

/**
 * 带嗅探头的响应。
 * body 是**完整内容**（嗅探读走的头字节会被接回去），调用方直接 pipe 到磁盘即可 ——
 * 少写一处「先写头再写流」的逻辑，也就不会漏掉前 32 个字节。
 */
export interface SniffedResponse {
  response: Response;
  head: Uint8Array;
  sniffed: SniffResult;
  /** 已经读掉的字节数（= head.length） */
  headBytes: number;
}

export interface FetcherApi extends Fetcher {
  /** 流式取回视频：返回已套好空闲超时的响应 */
  fetchStream(url: string, opts: FetchOpts): Promise<Response>;
}

export function createFetcher(options: FetcherOptions = {}): FetcherApi {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const limiter = options.limiter ?? hostLimiter();
  const log = options.log;
  const timers = options.timers ?? realTimers;

  /** 单次请求（不含重试）。返回的 body 已经套好对应类型的超时。 */
  async function requestOnce(url: string, opts: FetchOpts): Promise<Response> {
    if (opts.signal.aborted) throw new EcError('CANCELED');
    const host = opts.host ?? hostOf(url);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal.addEventListener('abort', onAbort, { once: true });

    // 连接阶段也必须有上限，否则一个挂起的连接会永远占着并发额度
    const headerTimeoutMs = opts.kind === 'image' ? IMAGE_TIMEOUT_MS : VIDEO_IDLE_TIMEOUT_MS;
    let headerTimedOut = false;
    const headerTimer = timers.setTimeout(() => {
      headerTimedOut = true;
      controller.abort();
    }, headerTimeoutMs);

    try {
      const response = await limiter.run(host, () =>
        fetchImpl(url, {
          // §9.7：不带 Cookie，也不用 HTTP 缓存
          credentials: 'omit',
          cache: 'no-store',
          signal: controller.signal,
        }),
      );

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (HTML_TYPES.some((type) => contentType.includes(type))) {
        // 有些 CDN 拒绝访问时返回 200 的 HTML 错误页（§9.7 内容校验）
        throw new EcError('HTTP_403', { reason: 'html-response', status: response.status });
      }

      if (!response.ok) {
        const code = httpStatusToCode(response.status);
        if (code === 'HTTP_429') {
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
          throw new EcError(
            code,
            retryAfterMs === null
              ? { status: response.status }
              : { status: response.status, retryAfterMs },
          );
        }
        throw new EcError(code, { status: response.status });
      }

      if (!response.body) return response;

      // §9.7：图片总超时（含 body），视频空闲超时（不限总时长）
      const guarded =
        opts.kind === 'image'
          ? withDeadline(response.body, IMAGE_TIMEOUT_MS, timers)
          : withIdleTimeout(response.body, VIDEO_IDLE_TIMEOUT_MS, timers);

      return new Response(guarded, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (e) {
      if (opts.signal.aborted) throw new EcError('CANCELED');
      if (headerTimedOut) throw new EcError('TIMEOUT');
      if (e instanceof DOMException && e.name === 'AbortError') throw new EcError('TIMEOUT');
      if (e instanceof TypeError) throw new EcError('NETWORK');
      throw EcError.from(e);
    } finally {
      timers.clearTimeout(headerTimer);
      opts.signal.removeEventListener('abort', onAbort);
    }
  }

  /** 带重试的请求；403 时先看链接是不是已经过期（§9.7） */
  async function requestWithRetry(url: string, opts: FetchOpts): Promise<Response> {
    return withRetry(() => requestOnce(url, opts), {
      signal: opts.signal,
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      onRetry: ({ attempt, delayMs, error }) => {
        if (error.code === 'HTTP_403' && isExpired(url)) {
          // 过期链接重试多少次都是 403，直接给用户可执行的动作（§6.2 URL_EXPIRED）
          throw new EcError('URL_EXPIRED', { url: stripQuery(url) });
        }
        log?.debug('请求失败，准备重试', {
          attempt,
          delayMs,
          code: error.code,
          host: hostOf(url),
        });
      },
    });
  }

  /** 请求 + 读嗅探头；返回的 body 已经跳过了头字节 */
  async function fetchWithHead(url: string, opts: FetchOpts): Promise<SniffedResponse> {
    const response = await requestWithRetry(url, opts);
    const { head, rest } = await readHead(response.body, SNIFF_BYTES);
    const sniffed = sniff(head);
    const rebuilt =
      rest === null
        ? new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        : new Response(rest, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
    return { response: rebuilt, head, sniffed, headBytes: head.byteLength };
  }

  return {
    /**
     * 依次尝试候选地址（§9.7 候选切换）。
     * 404/410 或内容类型不符 → 下一个候选；其他错误已经重试过，直接抛给任务层。
     */
    async fetchWithFallback(candidates: string[], opts: FetchOpts): Promise<Response> {
      if (candidates.length === 0) throw new EcError('HTTP_404', { reason: 'no-candidates' });

      let lastError: EcError = new EcError('HTTP_404', { reason: 'no-candidates' });
      for (const url of candidates) {
        if (opts.signal.aborted) throw new EcError('CANCELED');
        try {
          const { response, sniffed } = await fetchWithHead(url, opts);
          if (!matchesExpectation(sniffed, opts.kind)) {
            // §9.7：嗅探结果必须是期望的媒体类型，否则视为失败并换下一个候选
            log?.debug('内容类型不符，换下一个候选', { url: stripQuery(url), ext: sniffed.ext });
            lastError = new EcError('HTTP_404', { reason: 'content-mismatch' });
            continue;
          }
          return response;
        } catch (e) {
          const error = EcError.from(e);
          if (error.code === 'CANCELED') throw error;
          if (error.code === 'HTTP_404') {
            lastError = error;
            continue;
          }
          throw error;
        }
      }
      throw lastError;
    },

    /** 视频直链：不走候选切换，带空闲超时 */
    async fetchStream(url: string, opts: FetchOpts): Promise<Response> {
      return requestWithRetry(url, opts);
    },
  };
}

/** 日志和诊断里只保留到 path，不带签名参数（§6.7 不泄露敏感参数） */
export function stripQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    const idx = url.indexOf('?');
    return idx >= 0 ? url.slice(0, idx) : url;
  }
}
