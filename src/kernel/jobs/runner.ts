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
  /** 还没开始的工作项 */
  pending: WorkItem[];
  /** 已经开始、还没结束的工作项数 */
  inFlight: number;
  /** 工作项结果，finalize 要用 */
  results: Map<string, ItemResult>;
  controller: AbortController;
  extra: unknown;
  lastSent: string;
  finalized: boolean;
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

  const fetcher: Fetcher = options.net ?? createFetcher({ log: log.scope('net'), limiter });
  const media: MediaTools = options.media ?? createMediaTools();

  let started = false;
  let roundRobin = 0;
  let pumpScheduled = false;

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
   * 进度落库 + 节流推送。
   * force=true 或已到终态时立即推送（§6.3 约定 2：结束事件立即发送）。
   */
  function publish(record: JobRecord, force = false): void {
    jobs.set(record.id, record);
    const job = running.get(record.id);
    if (job) job.record = record;

    if (force || isTerminal(record.status)) {
      const timer = flushTimers.get(record.id);
      if (timer !== undefined) {
        clearTimeout(timer);
        flushTimers.delete(record.id);
      }
      emit({ type: isTerminal(record.status) ? 'done' : 'progress', job: record });
      return;
    }

    const sig = signature(record);
    if (job) {
      if (job.lastSent === sig) return;
      job.lastSent = sig;
    }
    if (flushTimers.has(record.id)) return;
    const timer = setTimeout(() => {
      flushTimers.delete(record.id);
      const latest = jobs.get(record.id);
      if (latest && !isTerminal(latest.status)) emit({ type: 'progress', job: latest });
    }, PROGRESS_THROTTLE_MS);
    flushTimers.set(record.id, timer);
  }

  // ---------- 调度：任务之间轮转（§6.4）----------

  /** 队列里还没跑完的工作项数量 */
  function queueLoad(): number {
    return queue.active + queue.pending + videoQueue.active + videoQueue.pending;
  }

  /**
   * 每一轮给「每个正在运行的任务」各分配一个工作项，然后让队列自己流动。
   * 轮转指针保证长任务不会因为提交顺序永远排在后面。
   */
  function pump(): void {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      for (;;) {
        const active = [...running.values()].filter(
          (job) => !job.finalized && job.pending.length > 0 && !job.controller.signal.aborted,
        );
        if (active.length === 0) return;
        // 队列已经满了：等工作项完成后再进来，避免一次性把几千张图塞进队列
        if (queueLoad() >= concurrency + VIDEO_CONCURRENCY) return;

        const index = roundRobin % active.length;
        roundRobin += 1;
        const job = active[index];
        if (!job) return;
        const item = job.pending.shift();
        if (!item) continue;
        dispatch(job, item);
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
    if (job.pending.length > 0) return;
    job.finalized = true;
    running.delete(job.record.id);
    void finalizeJob(job);
  }

  /** 任务上下文：JobTypeDef 的 run/finalize 都要求带上 extra（功能自己准备的数据，§6.4） */
  function runContextFor(job: RunningJob): RunContext & { extra: unknown } {
    return {
      signal: job.controller.signal,
      fs: gateway,
      net: fetcher,
      media: {
        toJpeg: (blob: Blob) => media.toJpeg(blob),
        sniff: (head: Uint8Array) => sniff(head),
      },
      log: log.scope(job.def.type),
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
      running.delete(job.record.id);
      publish(markEnded(job.record, 'canceled', now()), true);
      scheduler.finish(job.record.id);
      return;
    }

    job.items = items;
    job.pending = [...items];
    job.record = markStarted(job.record, items, now());
    job.lastSent = signature(job.record);
    publish(job.record, true);

    if (items.length === 0) {
      job.finalized = true;
      running.delete(job.record.id);
      await finalizeJob(job);
      return;
    }
    pump();
  }

  /** 计划阶段就失败：整个任务标 failed（§6.4） */
  function finishWithFailure(job: RunningJob, code: ErrorCode): void {
    job.finalized = true;
    running.delete(job.record.id);
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
   * 收尾（§9.6）：判定最终状态 → 调 finalize（写 .ecbox.json、商品信息.txt）→ 推 done。
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
     * 不会写进 .ecbox.json，再点「继续下载」时增量判断失效，同一张图会被当成新文件
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

  function cancelInternal(jobId: string): void {
    const job = running.get(jobId);
    if (job) {
      job.controller.abort();
      // 已经排队但还没开跑的工作项直接丢弃，不必等它们
      job.pending.length = 0;
      maybeFinalize(job);
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
      emit({ type: 'progress', job: submitted.existing });
      return;
    }

    const job: RunningJob = {
      record,
      def,
      payload: parsed,
      items: [],
      pending: [],
      inFlight: 0,
      results: new Map(),
      controller: new AbortController(),
      extra: undefined,
      lastSent: '',
      finalized: false,
    };
    running.set(record.id, job);
    jobs.set(record.id, record);
    emit({ type: 'progress', job: record });

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
       * 重新提交同一份 payload：.ecbox.json 会自动跳过已完成的文件（§9.11），
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

    async idle(): Promise<void> {
      for (;;) {
        if (running.size === 0 && queueLoad() === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };

  return runner;
}