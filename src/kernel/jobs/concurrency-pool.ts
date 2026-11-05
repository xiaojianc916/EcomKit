/**
 * 最小并发池（方案 §6.4 的并发控制）。
 *
 * 为什么不用 p-queue：p-queue 10 在构造时会调 Node 的 events.setMaxListeners，
 * 而它会校验传进去的对象是**同一个** EventTarget —— 在 happy-dom 等测试环境里
 * 全局 EventTarget 被替换，PQueue 继承的不是 Node 认识的那个，直接抛
 * "eventTargets argument must be an instance of EventTarget"。
 * 内核要在 offscreen 和单测里跑出完全一样的行为，所以这里自己实现一个几十行的池：
 * 只需要「限量 + 可调并发 + 能等空」三件事，用不上 p-queue 的优先级和速率限制。
 */

export type PoolTask = () => Promise<void> | void;

export interface ConcurrencyPool {
  /** 当前并发上限 */
  readonly concurrency: number;
  setConcurrency(n: number): void;
  /** 提交一个任务；返回的 promise 在任务执行完（含抛错）后 resolve */
  add(task: PoolTask): Promise<void>;
  /** 正在执行的任务数 */
  readonly active: number;
  /** 排队等待的任务数 */
  readonly pending: number;
  /** 等队列清空（正在执行的任务也算） */
  onIdle(): Promise<void>;
  /** 清空排队任务（不打断正在执行的） */
  clear(): void;
}

export function createConcurrencyPool(initialConcurrency: number): ConcurrencyPool {
  let concurrency = Math.max(1, Math.floor(initialConcurrency));
  let active = 0;
  const waiting: Array<() => void> = [];
  const idleWaiters: Array<() => void> = [];

  function settleIdle(): void {
    if (active === 0 && waiting.length === 0) {
      const list = idleWaiters.splice(0, idleWaiters.length);
      for (const resolve of list) resolve();
    }
  }

  function next(): void {
    if (active >= concurrency) return;
    const start = waiting.shift();
    if (!start) {
      settleIdle();
      return;
    }
    start();
  }

  const pool: ConcurrencyPool = {
    get concurrency() {
      return concurrency;
    },

    setConcurrency(n: number): void {
      concurrency = Math.max(1, Math.floor(n));
      // 调大并发后要把排队里的任务放出去
      while (active < concurrency && waiting.length > 0) next();
    },

    add(task: PoolTask): Promise<void> {
      return new Promise<void>((resolve) => {
        const start = () => {
          active += 1;
          void (async () => {
            try {
              await task();
            } catch {
              // 任务自身的错误由调用方在 task 内部处理；这里只保证池不卡住
            } finally {
              active -= 1;
              resolve();
              next();
            }
          })();
        };
        waiting.push(start);
        next();
      });
    },

    get active() {
      return active;
    },

    get pending() {
      return waiting.length;
    },

    onIdle(): Promise<void> {
      if (active === 0 && waiting.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },

    clear(): void {
      waiting.length = 0;
      settleIdle();
    },
  };

  return pool;
}
