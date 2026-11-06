import type { ErrorCode } from '../errors/codes';
import { EcError } from '../errors/ec-error';
import { mapFsError } from '../fs/fs-errors';
import type { FsGateway } from '../fs/types';
import { createLogger, type Logger } from '../log/logger';
import { createMediaTools, type MediaTools } from '../media/convert';
import { createFetcher } from '../net/fetcher';
import { createHostLimiter, type HostLimiter } from '../net/host-limiter';
import { sniff } from '../net/sniff';
import type { Fetcher } from '../net/types';
import { type ConcurrencyPool, createConcurrencyPool } from './concurrency-pool';
import {
  applyItemResult,
  clearFailure,
  computeFinalStatus,
  createJobRecord,
  isTerminal,
  markEnded,
  markStarted,
} from './progress';
import { createJobRegistry, type JobTypeRegistry } from './registry';
import { createScheduler, type Scheduler } from './scheduler';
import type {
  ItemResult,
  JobEvent,
  JobRecord,
  JobTypeDef,
  PlanContext,
  RunContext,
  WorkItem,
} from './types';

/**
 * 通用任务执行器（方案 §6.4、§4.2）。整条下载链路的心脏。
 *
 * 这个文件里落地的硬规则：
 *   · 全局并发 1–8（默认 6）；视频单独一个队列、同时最多 2 个（§6.4）
 *   · **任务之间轮转**：每一轮从每个正在运行的任务里各取一个工作项，
 *     避免一个 200 张详情图的任务把其他标签页的任务饿死（§6.4 调度规则）
 *   · 进度每 200ms 最多推一次，结束事件立即推（§6.3 约定 2）
 *   · 取消：每任务一个 AbortController，立刻中断请求并 abort 正在写入的文件
 *   · dedupeKey 去重：重复提交把已有任务的进度推给 UI（§6.4）
 *   · 失败项重试（§10.4「重试」按钮）
 *
 * 它不关心「下载的是什么」，只认注册进来的 JobTypeDef 的 plan / run / finalize。
 */

/** 进度推送节流间隔（§6.3 约定 2） */
export const PROGRESS_THROTTLE_MS = 200;
/** 视频同时最多几个（§6.4） */
export const VIDEO_CONCURRENCY = 2;
/** 全局并发默认值，设置项 settings.jobs.concurrency（§11） */
export const DEFAULT_CONCURRENCY = 6;

export interface JobRunnerOptions {
  gateway: FsGateway;
  jobTypes: readonly JobTypeDef<any, any>[];
  log?: Logger;
  /** 全局并发 1–8，默认 6 */
  concurrency?: number;
  /** 注入 fetcher，单测用 */
  net?: Fetcher;
  /** 注入媒体工具，单测用 */
  media?: MediaTools;
  /** 进度推送回调：offscreen 用它发 engine.event */
  onEvent?: (event: JobEvent) => void;
  /** 注入时钟，单测用 */
  now?: () => number;
}

export interface JobRunner {
  /** 注册任务类型并（可选地）替换写入层；重复调用无副作用 */
  start(gateway?: FsGateway): Promise<void>;
  /** 已注册的任务类型，供启动日志 */
  registeredTypes(): string[];
  /** 提交任务；job 由 bg 构造好（含 id / dedupeKey / payload） */
  enqueue(job: JobRecord, payload: unknown): Promise<void>;
  cancel(jobId: string): void;
  /** 只重跑失败项，返回新任务 id（§10.4） */
  retry(jobId: string, only: 'failed'): Promise<{ jobId: string } | null>;
  onEvent(cb: (event: JobEvent) => void): () => void;
  /** 当前任务快照，供 bg 镜像和 popup 列表 */
  list(filter?: { tabId?: number }): JobRecord[];
  get(jobId: string): JobRecord | undefined;
  setConcurrency(n: number): void;
  setGateway(gateway: FsGateway): void;
  /** 等所有任务跑完（测试用） */
  idle(): Promise<void>;
}

interface RunningJob {
  record: JobRecord;
  def: JobTypeDef<any, any>;
  payload: unknown;
  /** 计划出来的全部工作项（重试和 finalize 要用） */
  items: WorkItem[];
  /**
   * 还没开始的工作项。
   *
   * 用「数组 + 游标」而不是每次都 shift()：pump() 每取一个工作项就 shift 一次，
   * 500 张图的计划就是 500 次 O(n) 元素前移（12.5 万次搬运）。
   * 头部游标只在「已消费过半」时整体前移一次，摊还 O(1)。
   */
  pending: WorkItem[];
  pendingHead: number;
  /** 已经开始、还没结束的工作项数 */
  inFlight: number;
  /** 工作项结果，finalize 要用 */
  results: Map<string, ItemResult>;
  controller: AbortController;
  extra: unknown;
  lastSent: string;
  finalized: boolean;
  /** 缓存的 scope logger：每个工作项都 log.scope() 一次就是几百个临时对象 */
  scopedLog?: Logger;
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const log = options.log ?? createLogger('jobs');
  const now = options.now ?? (() => Date.now());
  const registry: JobTypeRegistry = createJobRegistry();
  const scheduler: Scheduler = createScheduler();
  const limiter: HostLimiter = createHostLimiter();

  let gateway = options.gateway;
  let concurrency = clampConcurrency(options.concurrency ?? DEFAULT_CONCURRENCY);

  // 普通素材与视频分两个池：视频体积大、耗时长，必须限死同时 2 个（§6.4）。
  // 用内核自带的并发池而不是 p-queue，原因见 concurrency-pool.ts 顶部注释。
  const queue: ConcurrencyPool = createConcurrencyPool(concurrency);
  const videoQueue: ConcurrencyPool = createConcurrencyPool(VIDEO_CONCURRENCY);

  const jobs = new Map<string, JobRecord>();
  const running = new Map<string, RunningJob>();
  const listeners = new Set<(event: JobEvent) => void>();
  const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * 还在跑（且还没收尾）的任务。pump() 每一轮都要问「谁还有活」，
   * 旧实现每次都 [...running.values()].filter(...) 重建一遍数组 —— 每完成一个工作项一次，
   * 500 张图就是 500 次全表重建。这里改成增量维护：进出都经由 addRunning/removeRunning。
   */
  const schedulable = new Set<RunningJob>();
  /** 等待「队列彻底空闲」的 idle() 调用方；由 notifyIdle 一次性唤醒 */
  const idleWaiters: Array<() => void> = [];
  /** 正在跑 finalize 的任务数（含空计划任务） */
  let finalizing = 0;

  const fetcher: Fetcher = options.net ?? createFetcher({ log: log.scope('net'), limiter });
  const media: MediaTools = options.media ?? createMediaTools();

  let started = false;
  let roundRobin = 0;
  let pumpScheduled = false;
  /** schedulable 变成后需要重新落成数组（轮转顺序复用的失效标记） */
  let rotationDirty = true;
  let rotationOrder: RunningJob[] = [];

  function refreshRotation(): void {
    rotationOrder = [...schedulable];
    rotationDirty = false;
    if (rotationOrder.length > 0) roundRobin %= rotationOrder.length;
    else roundRobin = 0;
  }

  function addRunning(job: RunningJob): void {
    running.set(job.record.id, job);
  }

  /**
   * 计划出来了、确实有工作项要跑，才进入调度集合。
   *
   * 不能一创建任务就加进去：plan 是异步的（要读目录、定位商品文件夹），
   * 这段时间里 pending 还是空的。调度器看到「在集合里但没活」会把它当成跑完的任务清出去，
   * 等 plan 回来时任务已经不在集合里 —— 工作项永远发不出去，任务卡在 running 直到超时。
   */
  function markSchedulable(job: RunningJob): void {
    schedulable.add(job);
    rotationDirty = true;
  }

  function removeRunning(job: RunningJob): void {
    running.delete(job.record.id);
    schedulable.delete(job);
    rotationDirty = true;
    notifyIdle();
  }

  /**
   * 还有没有事情在做。
   *
   * 不用 queueLoad() 判：running 里的任务只有在「inFlight 归零 + 待跑项归零」之后才会被移除，
   * 而 inFlight 恰好是「已经丢进并发池、还没 settle」的项数 —— 所以 running 空了，
   * 这个 runner 自己那两个池也一定空了（池子里剩下的只有正在收尾的那一个）。
   * finalizing 单独计：finalize 在任务从 running 移除之后才跑完，
   * 不算进去的话 idle() 会早返回，调用方以为都完事了，实际收尾还没做。
   */
  function isIdle(): boolean {
    return running.size === 0 && finalizing === 0;
  }

  /** 唤醒 idle() 的等待者（只在真的空了的时候唤醒） */
  function notifyIdle(): void {
    if (idleWaiters.length === 0 || !isIdle()) return;
    const list = idleWaiters.splice(0, idleWaiters.length);
    for (const resolve of list) resolve();
  }

  function clampConcurrency(n: number): number {
    if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
    return Math.min(8, Math.max(1, Math.round(n)));
  }

  function emit(event: JobEvent): void {
    try {
      options.onEvent?.(event);
    } catch {
      /* 监听方出错不能影响任务 */
    }
    for (const cb of listeners) {
      try {
        cb(event);
      } catch {
        /* 同上 */
      }
    }
  }

  function signature(record: JobRecord): string {
    return [record.status, record.done, record.skipped, record.failed.length, record.bytes].join(
      '|',
    );
  }

  /**
   * 发给外面的那一份记录：**去掉 payload**。
   *
   * payload 是整份商品快照（标题 + 几十上百个素材 URL + candidates + SKU 列表，
   * 一个商品实测几十 KB 到几百 KB）。进度事件每 200ms 一条，
   * offscreen → bg → Port → 页面每一跳都要对这个对象做一次结构化克隆 ——
   * 500 张图的任务光进度事件就要克隆几十 MB，页面还会因为收到新对象而重渲染。
   *
   * 任务内部（retry、finalize）用的是 jobs 里那份完整记录，不受影响；
   * UI 侧没有任何地方读 job.payload（已全仓 grep 确认）。
   */
  function forWire(record: JobRecord): JobRecord {
    return record.payload == null ? record : { ...record, payload: null };
  }

  /**
   * 进度落库 + 节流推送。
   * force=true 或已到终态时立即推送（§6.3 约定 2：结束事件立即发送）。
   */
  function publish(record: JobRecord, force = false): void {
    jobs.set(record.id, record);
    const job = running.get(record.id);
    if (job) job.record = record;

    const terminal = isTerminal(record.status);
    if (force || terminal) {
      const timer = flushTimers.get(record.id);
      if (timer !== undefined) {
        clearTimeout(timer);
        flushTimers.delete(record.id);
      }
      emit({ type: terminal ? 'done' : 'progress', job: forWire(record) });
      if (terminal) notifyIdle();
      return;
    }

    const sig = signature(record);
    if (job) {
      // 状态没变就不推（same-state settle 在缓存命中/秒传时很常见）
      if (job.lastSent === sig) return;
      job.lastSent = sig;
    }
    // 节流窗口里已经有定时器了：它到点会推最新状态，这里不用再排一个
    if (flushTimers.has(record.id)) return;
    const timer = setTimeout(() => {
      flushTimers.delete(record.id);
      const latest = jobs.get(record.id);
      if (latest && !isTerminal(latest.status)) emit({ type: 'progress', job: forWire(latest) });
      // 定时器回调里也要探一次 idle：最后一条进度可能刚好把队列清空
      notifyIdle();
    }, PROGRESS_THROTTLE_MS);
    flushTimers.set(record.id, timer);
  }

  // ---------- 调度：任务之间轮转（§6.4）----------

  /** 队列里还没跑完的工作项数量 */
  function queueLoad(): number {
    return queue.active + queue.pending + videoQueue.active + videoQueue.pending;
  }

  /** 还没开始的工作项数量（pending 用游标存，不能用 length） */
  function pendingCount(job: RunningJob): number {
    return job.pending.length - job.pendingHead;
  }

  /** 取下一个待跑的工作项；消费过半时整体前移一次，摊还 O(1) */
  function takePending(job: RunningJob): WorkItem | undefined {
    if (job.pendingHead >= job.pending.length) return undefined;
    const item = job.pending[job.pendingHead];
    job.pendingHead += 1;
    if (job.pendingHead >= 32 && job.pendingHead * 2 >= job.pending.length) {
      job.pending.splice(0, job.pendingHead);
      job.pendingHead = 0;
    }
    return item;
  }

  /** 丢掉还没开始的工作项（取消时用） */
  function dropPending(job: RunningJob): void {
    job.pending.length = 0;
    job.pendingHead = 0;
  }

  /**
   * 每一轮给「每个正在运行的任务」各分配一个工作项，然后让队列自己流动。
   * 轮转指针保证长任务不会因为提交顺序永远排在后面。
   *
   * 候选来自增量维护的 schedulable 集合，不再每轮重建 + filter 整个 running 表。
   */
  function pump(): void {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      for (;;) {
        if (schedulable.size === 0) return;
        /**
         * 队列已经满了：等工作项完成后再进来，避免一次性把几千张图塞进队列。
         * 这个判断要排在遍历候选之前 —— 它是每轮都要做的，而遍历只需要在有活时做。
         */
        if (queueLoad() >= concurrency + VIDEO_CONCURRENCY) return;

        /**
         * 从轮转位置开始挑一个「还有活」的任务。
         *
         * 只有 schedulable 集合**有变化**（有任务进来 / 有任务被移除 / 上一轮挑空了）
         * 才需要重新落成一个数组；否则复用上一次的顺序，避免每轮都复制一遍 Set。
         */
        if (rotationDirty || rotationOrder.length !== schedulable.size) refreshRotation();
        const list = rotationOrder;
        if (list.length === 0) return;

        let picked: RunningJob | undefined;
        let offset = 0;
        const stale: RunningJob[] = [];
        for (let i = 0; i < list.length; i += 1) {
          const job = list[(roundRobin + i) % list.length] as RunningJob;
          // 已取消 / 队列已空的任务不再参与轮转（扫完再清出集合，别在遍历中改集合）
          if (job.controller.signal.aborted || pendingCount(job) === 0) {
            stale.push(job);
            continue;
          }
          picked = job;
          offset = i;
          break;
        }
        if (stale.length > 0) {
          for (const job of stale) schedulable.delete(job);
          rotationDirty = true;
        }
        if (!picked) return;

        roundRobin = (roundRobin + offset + 1) % list.length;
        const item = takePending(picked);
        if (!item) continue;
        dispatch(picked, item);
      }
    });
  }

  /** 把一个工作项丢进对应队列（视频走视频队列，§6.4） */
  function dispatch(job: RunningJob, item: WorkItem): void {
    job.inFlight += 1;
    const target = item.expect === 'video' ? videoQueue : queue;
    void target
      .add(async () => {
        if (job.controller.signal.aborted) {
          settle(job, item, { itemKey: item.itemKey, status: 'failed', code: 'CANCELED' });
          return;
        }
        const result = await executeItem(job, item);
        settle(job, item, result);
      })
      .catch(() => {
        // 并发池不会让任务抛错；这里只是兜底，保证一个工作项出问题不影响整轮调度
      });
  }

  /** 执行单个工作项；任何异常都收敛成 ItemResult（§6.4 失败项可以重试） */
  async function executeItem(job: RunningJob, item: WorkItem): Promise<ItemResult> {
    try {
      return await job.def.run(item, runContextFor(job));
    } catch (e) {
      const error = EcError.is(e) ? e : mapFsError(e);
      // 逐项失败事件立即发给 UI（§10.4 失败列表展开时实时出现）
      emit({ type: 'item-failed', jobId: job.record.id, itemKey: item.itemKey, code: error.code });
      return { itemKey: item.itemKey, status: 'failed', code: error.code };
    }
  }

  function settle(job: RunningJob, item: WorkItem, result: ItemResult): void {
    job.inFlight = Math.max(0, job.inFlight - 1);
    job.results.set(item.itemKey, result);

    // 重试成功后要摘掉旧的失败记录，否则失败数会虚高
    const base =
      result.status === 'ok' || result.status === 'skipped'
        ? clearFailure(job.record, item)
        : job.record;
    publish(applyItemResult(base, item, result));

    maybeFinalize(job);
    pump();
  }

  /** 所有工作项都结束了（或被取消）就收尾 */
  function maybeFinalize(job: RunningJob): void {
    if (job.finalized) return;
    if (job.inFlight > 0) return;
    if (pendingCount(job) > 0) return;
    job.finalized = true;
    void finalizeTracked(job);
  }

  /**
   * 任务上下文：JobTypeDef 的 run/finalize 都要求带上 extra（功能自己准备的数据，§6.4）。
   *
   * 每个工作项都会调一次，所以 scope logger 缓存在任务上：
   * log.scope() 每次新建一个带 5 个闭包的对象，500 张图就是 500 个一次性对象。
   * 其它字段仍然每次现取 —— gateway 是可以在运行中被 setGateway/setSink 换掉的，
   * 缓存整个上下文会让切换写入层之后的任务还往旧 sink 里写。
   */
  function runContextFor(job: RunningJob): RunContext & { extra: unknown } {
    job.scopedLog ??= log.scope(job.def.type);
    return {
      signal: job.controller.signal,
      fs: gateway,
      net: fetcher,
      media: {
        toJpeg: (blob: Blob) => media.toJpeg(blob),
        sniff: (head: Uint8Array) => sniff(head),
      },
      log: job.scopedLog,
      extra: job.extra,
    };
  }

  // ---------- 任务生命周期 ----------

  async function startJob(job: RunningJob): Promise<void> {
    const planCtx: PlanContext = {
      signal: job.controller.signal,
      log: log.scope(job.def.type),
      settings: {},
      fs: gateway,
    };

    if (job.def.extra) {
      try {
        job.extra = await job.def.extra(job.payload, { fs: gateway, log });
      } catch (e) {
        // 读清单失败不致命：当作「没有记录」，全部重新下载（§9.11）
        log.warn('准备任务上下文失败', { jobId: job.record.id, code: EcError.from(e).code });
      }
    }

    let items: WorkItem[];
    try {
      items = await job.def.plan(job.payload, planCtx);
    } catch (e) {
      finishWithFailure(job, EcError.from(e).code);
      return;
    }

    if (job.controller.signal.aborted) {
      job.finalized = true;
      removeRunning(job);
      publish(markEnded(job.record, 'canceled', now()), true);
      scheduler.finish(job.record.id);
      return;
    }

    job.items = items;
    job.pending = [...items];
    job.pendingHead = 0;
    markSchedulable(job);
    job.record = markStarted(job.record, items, now());
    job.lastSent = signature(job.record);
    publish(job.record, true);

    if (items.length === 0) {
      job.finalized = true;
      await finalizeTracked(job);
      return;
    }
    pump();
  }

  /** 计划阶段就失败：整个任务标 failed（§6.4） */
  function finishWithFailure(job: RunningJob, code: ErrorCode): void {
    job.finalized = true;
    removeRunning(job);
    publish(
      markEnded(
        { ...job.record, status: 'running', failed: [{ itemKey: '', code }] },
        'failed',
        now(),
      ),
      true,
    );
    scheduler.finish(job.record.id);
    log.warn('任务计划阶段失败', { jobId: job.record.id, code });
  }

  /**
   * 收尾（§9.6）：判定最终状态 → 调 finalize（功能自己的收尾动作）→ 推 done。
   * finalize 失败不回滚已下载的文件，只记日志：用户看到的文件都是完整的。
   */
  async function finalizeJob(job: RunningJob): Promise<void> {
    const wasCanceled = job.controller.signal.aborted;
    let record = job.record;
    record = markEnded(record, wasCanceled ? 'canceled' : computeFinalStatus(record), now());

    /**
     * 收尾**取消也要跑**（§9.11）。
     *
     * 旧实现是 `if (!wasCanceled && job.def.finalize)`：用户取消后已经落盘的文件
     * 不会被记下来，再点「继续下载」时增量判断失效，同一张图会被当成新文件
     * 另存为「01 (2).webp」。
     * finalize 只记录 status==='ok' 的结果，所以取消时它只会补记真正写完的那些。
     */
    if (job.def.finalize) {
      const results = [...job.results.values()];
      try {
        await job.def.finalize(job.payload, results, { ...runContextFor(job), record });
      } catch (e) {
        log.warn('任务收尾失败', { jobId: record.id, code: EcError.from(e).code });
      }
    }

    publish(record, true);
    scheduler.finish(record.id);
  }

  /**
   * finalizeJob 的包装：让 idle() 能等到收尾真的跑完。
   * 先 +1 再从 running 里摘掉，摘掉时 notifyIdle() 看到的就不是「空」；
   * 否则 idle() 会在 finalize 还没跑的时候先返回，调用方读到的清单是旧的。
   */
  async function finalizeTracked(job: RunningJob): Promise<void> {
    finalizing += 1;
    removeRunning(job);
    try {
      await finalizeJob(job);
    } finally {
      finalizing -= 1;
      notifyIdle();
    }
  }

  function cancelInternal(jobId: string): void {
    const job = running.get(jobId);
    if (job) {
      job.controller.abort();
      // 已经排队但还没开跑的工作项直接丢弃，不必等它们
      dropPending(job);
      maybeFinalize(job);
      // 队列里可能还压着这个任务的工作项：唤醒调度，让别的任务接手
      pump();
      return;
    }
    const record = jobs.get(jobId);
    if (record && !isTerminal(record.status)) {
      publish(markEnded(record, 'canceled', now()), true);
      scheduler.finish(jobId);
    }
  }

  async function enqueueInternal(record: JobRecord, payload: unknown): Promise<void> {
    const def = registry.get(record.type);
    if (!def) {
      log.warn('未注册的任务类型，拒绝提交', { type: record.type });
      throw new EcError('INTERNAL', { reason: 'unknown-job-type' });
    }

    // 协议表里 payload 是 unknown，进内核前必须过 Zod（§6.3）
    let parsed: unknown;
    try {
      parsed = def.payload.parse(payload);
    } catch {
      log.warn('任务参数不合法，拒绝提交', { type: record.type });
      throw new EcError('INTERNAL', { reason: 'payload-invalid' });
    }

    // requiresDir 的兜底：目录不可用时立刻整单失败，而不是让几百个工作项各失败一次。
    // 正常情况下 bg 已经拦过一遍（它要开授权小窗），这里只防「直接调引擎」的路径。
    if (def.requiresDir) {
      const dir = await gateway.status().catch(() => null);
      if (dir === null || dir.status !== 'ready') {
        log.warn('目录不可用，拒绝提交', { type: record.type, status: dir?.status ?? 'unknown' });
        throw new EcError('DIR_UNSET', { status: dir?.status ?? 'unknown' });
      }
    }

    const submitted = scheduler.submit(record);
    if (submitted.kind === 'duplicate') {
      // 同一商品已经在下载：把已有任务的进度直接推给 UI（§6.4）
      emit({ type: 'progress', job: forWire(submitted.existing) });
      return;
    }

    const job: RunningJob = {
      record,
      def,
      payload: parsed,
      items: [],
      pending: [],
      pendingHead: 0,
      inFlight: 0,
      results: new Map(),
      controller: new AbortController(),
      extra: undefined,
      lastSent: '',
      finalized: false,
    };
    addRunning(job);
    jobs.set(record.id, record);
    emit({ type: 'progress', job: forWire(record) });

    try {
      await startJob(job);
    } catch (e) {
      log.error('任务执行异常', { jobId: record.id, code: EcError.from(e).code });
      finishWithFailure(job, EcError.from(e).code);
    }
  }

  // ---------- 对外接口 ----------

  function ensureRegistered(): void {
    if (started) return;
    registry.registerAll(options.jobTypes);
    started = true;
    log.info('任务类型已注册', { types: registry.registeredTypes() });
  }

  const runner: JobRunner = {
    async start(nextGateway?: FsGateway): Promise<void> {
      if (nextGateway) gateway = nextGateway;
      ensureRegistered();
    },

    registeredTypes(): string[] {
      try {
        ensureRegistered();
      } catch {
        /* 重复注册时忽略，下面照常返回 */
      }
      return registry.registeredTypes();
    },

    async enqueue(record: JobRecord, payload: unknown): Promise<void> {
      ensureRegistered();
      await enqueueInternal(record, payload);
    },

    cancel(jobId: string): void {
      cancelInternal(jobId);
    },

    async retry(jobId: string, only: 'failed'): Promise<{ jobId: string } | null> {
      if (only !== 'failed') return null;
      const record = jobs.get(jobId);
      if (!record) return null;
      // 整单失败（目录丢失、全部候选 404）没有逐项记录，failed 里可能只有一条空 itemKey。
      // 这种情况也要能重试，否则面板上的「重试」按钮永远是死的。
      const hasFailures = record.failed.length > 0 || record.status === 'failed';
      if (!hasFailures) return null;
      if (record.status === 'running' || record.status === 'queued') return null;

      const startedAt = now();
      /**
       * 重新提交同一份 payload：已落盘的同名文件会自动跳过（§9.11），
       * 所以「重试失败项」等价于「再提交一次」，不必单独维护子集计划。
       *
       * **dedupeKey 必须保持不变**：页面用 `平台:商品ID` 订阅进度，
       * 旧实现给重试任务拼了 `#retry-<时间戳>` 后缀，于是新任务的进度事件
       * 全部被 watchJobs 的过滤挡掉 —— 点了重试，任务确实在跑，面板却一动不动。
       */
      const next = createJobRecord({
        id: record.id + '-r' + startedAt,
        type: record.type,
        dedupeKey: record.dedupeKey,
        payload: record.payload,
        now: startedAt,
        ...(record.label === undefined ? {} : { label: record.label }),
        ...(record.tabId === undefined ? {} : { tabId: record.tabId }),
      });
      await enqueueInternal(next, record.payload);
      return { jobId: next.id };
    },

    onEvent(cb: (event: JobEvent) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    list(filter?: { tabId?: number }): JobRecord[] {
      const all = [...jobs.values()];
      if (filter?.tabId === undefined) return all;
      return all.filter((job) => job.tabId === filter.tabId);
    },

    get(jobId: string): JobRecord | undefined {
      return jobs.get(jobId);
    },

    setConcurrency(n: number): void {
      concurrency = clampConcurrency(n);
      queue.setConcurrency(concurrency);
      pump();
    },

    setGateway(next: FsGateway): void {
      gateway = next;
    },

    /**
     * 等所有任务跑完（测试用）。
     *
     * 旧实现是 setTimeout(..., 5) 死循环轮询：一个 200 项的任务要空转几百次定时器，
     * 既拖慢单测，又让「到底跑完没有」永远有一拍延迟。现在改成等待者队列：
     * 任务从 running 移除、或 finalize 结束时由 notifyIdle() 唤醒一次，零空转。
     */
    async idle(): Promise<void> {
      while (!isIdle()) {
        const { promise, resolve } = Promise.withResolvers<void>();
        idleWaiters.push(resolve);
        await promise;
      }
    },
  };

  return runner;
}
