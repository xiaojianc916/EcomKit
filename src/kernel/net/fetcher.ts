import type { ErrorCode } from '../errors/codes';
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
 *   · 地址级失败（404/410/403/429/5xx）→ 换下一个候选；全部失败才抛最后一个错误
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

/**
 * 这些错误码说明「**这个地址**不行」，换下一个候选还有救（§9.7 候选切换）。
 *
 * 404/410 本来就是这么处理的；403/429/5xx 同样属于地址级失败 ——
 * 同一张图的候选通常落在不同 CDN 域名上（原图 / 缩略图变体 / 备用域），
 * 一个域名对某个对象回 403（已删除、签名校验）或 5xx（灰度节点异常/限流）时，
 * 下一个候选往往能直接成功。旧实现只对 404 换候选，于是本可成功的图被记成失败。
 *
 * 刻意**不**包含 NETWORK / TIMEOUT / CANCELED：
 * 网络断了或用户取消是所有候选共享的失败，逐个候选再各重试 3 次会把
 * 「断网」变成每张图多等十几秒（几百张图就是几十分钟的空转）。
 */
const CANDIDATE_SWITCH_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'HTTP_403',
  'HTTP_404',
  'HTTP_429',
  'HTTP_5XX',
]);

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

/**
 * 用新的 body 重建响应，并把 `Response` 的原生属性补回去。
 *
 * `new Response(stream, { status, statusText, headers })` 只能带上这四个，
 * `url` / `redirected` / `type` 一律退回默认值（空串 / false / 'default'）：
 * 于是跟着 302 跳转拿到的最终地址在日志里变成空串，排查「这个 CDN 到底把我指到哪了」时完全没用。
 * 这三个是只读 getter，实例本身可扩展，用 defineProperty 覆盖成实际值即可。
 */
function rebuildResponse(body: ReadableStream<Uint8Array> | null, source: Response): Response {
  const rebuilt = new Response(body, {
    status: source.status,
    statusText: source.statusText,
    headers: source.headers,
  });
  try {
    Object.defineProperty(rebuilt, 'url', { value: source.url });
    Object.defineProperty(rebuilt, 'redirected', { value: source.redirected });
    Object.defineProperty(rebuilt, 'type', { value: source.type });
  } catch {
    /* 极端情况下被冻结的对象：宁可不带元信息，也不能让下载失败 */
  }
  return rebuilt;
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
    const startedAt = timers.now();

    /**
     * 连接阶段也必须被取消：外部 abort 要能立刻打断挂起的连接。
     *
     * 这里不能直接用 AbortSignal.timeout：它一旦开弓就没有回头路，不能在中途 clear，
     * 会在 body 已经读到一半时把流掐断（`withDeadline` 那边再报出来就变成 CANCELED 了）。
     * 连接阶段要的是「拿到响应头就取消计时」，所以还是手写一个可清除的计时器。
     */
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal.addEventListener('abort', onAbort, { once: true });

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
      if (opts.kind === 'image') {
        // 「总共 20 秒」是从发出请求开始算的，因此要扣掉已经花在等响应头上的时间；
        // 直接再给 20 秒会变成「连接 20s + body 20s = 40s」，慢 CDN 上翻倍。
        const remaining = IMAGE_TIMEOUT_MS - (timers.now() - startedAt);
        if (remaining <= 0) throw new EcError('TIMEOUT');
        return rebuildResponse(withDeadline(response.body, remaining, timers), response);
      }
      return rebuildResponse(
        withIdleTimeout(response.body, VIDEO_IDLE_TIMEOUT_MS, timers),
        response,
      );
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
    return {
      response: rebuildResponse(rest, response),
      head,
      sniffed,
      headBytes: head.byteLength,
    };
  }

  return {
    /**
     * 依次尝试候选地址（§9.7 候选切换）。
     * 地址级失败（404/410/403/429/5xx）或内容类型不符 → 下一个候选；
     * 网络类失败（断网、超时、取消）已经重试过，直接抛给任务层。
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
          if (CANDIDATE_SWITCH_CODES.has(error.code)) {
            // 404 是「这个地址没有」的常态分支，不值得刷日志；
            // 403/429/5xx 换候选是本次新增的行为，失败了要能在诊断里看到
            if (error.code !== 'HTTP_404') {
              log?.debug('候选失败，换下一个候选', { url: stripQuery(url), code: error.code });
            }
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
