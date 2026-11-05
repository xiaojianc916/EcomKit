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
 * 给流套一个总时长上限：从调用时刻起 deadlineMs 内必须读完。
 * 超时后 cancel 源流（让底层 fetch 真正停下来）并抛 TIMEOUT。
 */
export function withDeadline(
  stream: ReadableStream<Uint8Array>,
  deadlineMs: number,
  timers: TimerApi = realTimers,
): ReadableStream<Uint8Array> {
  const deadlineAt = timers.now() + deadlineMs;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = stream.getReader();
      let settled = false;

      const fail = () => {
        if (settled) return;
        settled = true;
        void reader.cancel().catch(() => {});
        controller.error(new EcError('TIMEOUT'));
      };

      const handle = timers.setTimeout(fail, deadlineMs);

      void (async () => {
        try {
          for (;;) {
            if (timers.now() > deadlineAt) {
              fail();
              return;
            }
            const { done, value } = await reader.read();
            if (settled) return;
            if (done) {
              settled = true;
              timers.clearTimeout(handle);
              controller.close();
              return;
            }
            if (value) controller.enqueue(value);
          }
        } catch (e) {
          if (settled) return;
          settled = true;
          timers.clearTimeout(handle);
          controller.error(e);
        }
      })();
    },
  });
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
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = stream.getReader();
      let settled = false;
      let handle: unknown = null;

      const arm = () => {
        timers.clearTimeout(handle);
        handle = timers.setTimeout(() => {
          if (settled) return;
          settled = true;
          void reader.cancel().catch(() => {});
          controller.error(new EcError('TIMEOUT'));
        }, idleMs);
      };

      arm();

      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (settled) return;
            if (done) {
              settled = true;
              timers.clearTimeout(handle);
              controller.close();
              return;
            }
            arm();
            if (value) controller.enqueue(value);
          }
        } catch (e) {
          if (settled) return;
          settled = true;
          timers.clearTimeout(handle);
          controller.error(e);
        }
      })();
    },
  });
}

export { realTimers };
