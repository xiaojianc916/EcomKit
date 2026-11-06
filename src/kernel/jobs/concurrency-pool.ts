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
  /** 清空排队任务（不打断正在执行的）；被丢弃的 add() promise 会照常 resolve */
  clear(): void;
}

interface Waiting {
  start: () => void;
  /** clear() 丢弃排队任务时也要调用：否则 await add() 的调用方永远挂住 */
  resolve: () => void;
}

export function createConcurrencyPool(initialConcurrency: number): ConcurrencyPool {
  let concurrency = Math.max(1, Math.floor(initialConcurrency));
  let active = 0;
  /**
   * 排队队列 + 头指针。
   *
   * 为什么不用 Array.shift()：shift 每次都要把后面所有元素前移一格，
   * 一个商品几百张图时就是 O(n²) 的搬运。用游标只在「已消费过半」时整体前移一次，
   * 摊还 O(1)。
   */
  const waiting: Waiting[] = [];
  let head = 0;
  const idleWaiters: Array<() => void> = [];

  function pendingCount(): number {
    return waiting.length - head;
  }

  function take(): Waiting | undefined {
    if (head >= waiting.length) return undefined;
    const entry = waiting[head];
    head += 1;
    if (head >= 32 && head * 2 >= waiting.length) {
      waiting.splice(0, head);
      head = 0;
    }
    return entry;
  }

  function settleIdle(): void {
    if (active === 0 && pendingCount() === 0) {
      const list = idleWaiters.splice(0, idleWaiters.length);
      for (const resolve of list) resolve();
    }
  }

  function next(): void {
    if (active >= concurrency) return;
    const entry = take();
    if (!entry) {
      settleIdle();
      return;
    }
    entry.start();
  }

  const pool: ConcurrencyPool = {
    get concurrency() {
      return concurrency;
    },

    setConcurrency(n: number): void {
      concurrency = Math.max(1, Math.floor(n));
      // 调大并发后要把排队里的任务放出去
      while (active < concurrency && pendingCount() > 0) next();
    },

    add(task: PoolTask): Promise<void> {
      // Promise.withResolvers：Chrome 119+ / Node 22 起原生支持，不必再手写 executor
      const { promise, resolve } = Promise.withResolvers<void>();
      const entry: Waiting = {
        resolve,
        start: () => {
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
        },
      };
      waiting.push(entry);
      next();
      return promise;
    },

    get active() {
      return active;
    },

    get pending() {
      return pendingCount();
    },

    onIdle(): Promise<void> {
      if (active === 0 && pendingCount() === 0) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      idleWaiters.push(resolve);
      return promise;
    },

    clear(): void {
      // 排队中但还没开始的任务直接丢弃。它们的 add() promise 必须 resolve，
      // 否则调用方（等待「这一项做完了」的逻辑）会永远挂住。
      const dropped = waiting.slice(head);
      waiting.length = 0;
      head = 0;
      for (const entry of dropped) entry.resolve();
      settleIdle();
    },
  };

  return pool;
}
