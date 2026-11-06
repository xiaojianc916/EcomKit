import { EcError } from '../errors/ec-error';

/**
 * 流式读取的两种超时（方案 §9.7）。
 *
 * 为什么不能只用一个 AbortSignal：
 *   · 图片要求「单个请求总共 20 秒」—— 包括下载 body 的时间；
 *   · 视频要求「30 秒空闲超时」—— 不限总时长，只要还在持续收到数据就不能打断，
 *     一个 300MB 的视频正常要下好几分钟，用总超时会必然失败。
 * 所以这里对返回的流做包装：图片用截止时间，视频用空闲计时器。
 */

/** 统一的计时器接口，单测能注入假实现 */
export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const realTimers: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * 给源流套一层超时守卫。
 *
 * 用 pull 模型，而不是旧实现的「start() 里开一个 while 循环，read 一块 enqueue 一块」：
 *
 *   · **背压**：下游（写盘）没要数据就不从源流读。旧实现 enqueue 之后完全不看 desiredSize，
 *     网络比磁盘快时整段视频都堆在内存里 —— 几百 MB 的视频就是真实的内存暴涨。
 *   · **计时语义更准**：计时器只在「正在等数据」时开着。下游写盘慢造成的停顿不该算成
 *     视频的空闲超时（30 秒没收到新数据 = 网络卡住，而不是磁盘慢）。
 *   · **取消能传下去**：cancel() 会 cancel 源 reader。旧包装流没有 cancel，
 *     用户中途取消或写盘失败时底层 fetch 会继续挂着不放。
 *
 * @param idleMs 空闲超时；null 表示只限制总时长
 * @param deadlineMs 总时长上限（从调用时刻起算）；null 表示不限制总时长
 */
function guard(
  stream: ReadableStream<Uint8Array>,
  timers: TimerApi,
  idleMs: number | null,
  deadlineMs: number | null,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const deadlineAt = deadlineMs === null ? null : timers.now() + deadlineMs;
  const timeoutError = new EcError('TIMEOUT');
  let settled = false;
  let handle: unknown = null;

  const stopTimer = (): void => {
    if (handle === null) return;
    timers.clearTimeout(handle);
    handle = null;
  };

  /** 超时：cancel 源流让底层 fetch 真正停下来，再把错误交给下游 */
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (settled) return;
    settled = true;
    stopTimer();
    void reader.cancel(timeoutError).catch(() => {});
    controller.error(timeoutError);
  };

  /** 本次等数据要开多久的计时器；返回 null 表示不用开 */
  const nextTimeout = (): number | null => {
    if (deadlineAt === null) return idleMs;
    const remaining = deadlineAt - timers.now();
    // 总时长和空闲时长取更早的那个
    return idleMs === null ? remaining : Math.min(remaining, idleMs);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (settled) return;

      const timeout = nextTimeout();
      if (timeout !== null) {
        if (timeout <= 0) {
          fail(controller);
          return;
        }
        handle = timers.setTimeout(() => fail(controller), timeout);
      }

      try {
        const { done, value } = await reader.read();
        stopTimer();
        if (settled) return;
        if (done) {
          settled = true;
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (e) {
        stopTimer();
        if (settled) return;
        settled = true;
        controller.error(e);
      }
    },
    async cancel(reason) {
      if (settled) return;
      settled = true;
      stopTimer();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * 给流套一个总时长上限：从调用时刻起 deadlineMs 内必须读完。
 * 超时后 cancel 源流（让底层 fetch 真正停下来）并抛 TIMEOUT。
 */
export function withDeadline(
  stream: ReadableStream<Uint8Array>,
  deadlineMs: number,
  timers: TimerApi = realTimers,
): ReadableStream<Uint8Array> {
  return guard(stream, timers, null, deadlineMs);
}

/**
 * 给流套一个空闲超时：idleMs 内没有新数据才失败（§9.7 的视频规则）。
 * 每收到一块数据就重置计时器。
 */
export function withIdleTimeout(
  stream: ReadableStream<Uint8Array>,
  idleMs: number,
  timers: TimerApi = realTimers,
): ReadableStream<Uint8Array> {
  return guard(stream, timers, idleMs, null);
}

export { realTimers };
