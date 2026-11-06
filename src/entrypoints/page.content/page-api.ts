/**
 * PageApi 的实现（方案 §8.2）。
 *
 * 功能模块只通过这个接口和外界打交道：提交任务、取消、订阅进度、调自己的 service/engine、
 * 读写功能私有偏好。它们**不**直接碰 chrome.* 或 fs —— 这样功能之间不会互相耦合，
 * 也不会把 React 之外的东西拖进 Service Worker。
 */
import type { PageApi } from '../../features/types';
import type { DirState } from '../../kernel/fs/types';
import type { JobRecord } from '../../kernel/jobs/types';
import { createLogger } from '../../kernel/log/logger';
import { connectJobPort } from '../../kernel/messaging/port';
import type { PortMessage } from '../../kernel/messaging/protocol';
import { sendMessage } from '../../kernel/messaging/runtime';
import type { UiPrefs } from '../../kernel/settings/store';
import { patchUiPrefs, readUiPrefs, watchUiPrefs } from '../../kernel/settings/store';
import type { PageController } from './controller';

const log = createLogger('page.api');

/** UI 偏好里存功能私有偏好的字段（和站点形态偏好分开，互不影响） */
const FEATURE_PREFS_KEY = 'featurePrefs';

/** 最近任务缓存上限：面板只会看当前商品的那一个，留太多只是白占内存 */
const LATEST_LIMIT = 64;

export type ToastHandler = (
  msg: string,
  opts?: { action?: { label: string; run(): void } },
) => void;

export interface PageApiHandle {
  api: PageApi;
  /**
   * 功能私有偏好从 chrome.storage 读回来之后 resolve。
   *
   * 内容脚本必须在**挂载面板之前**等它：面板的功能 store 是在首次渲染时按
   * `prefs.get()` 初始化勾选状态的，读晚了就会退回默认值 ——
   * 用户「以后都不要视频」的选择在刷新后看起来像没保存。
   * 正常情况下这是一个几毫秒的 chrome.storage 读操作。
   */
  prefsHydrated: Promise<void>;
  /** 外壳挂载后把 Toast 的落点接进来；在那之前 toast 只进日志 */
  setToastHandler(handler: ToastHandler): void;
  /** 页面卸载时断开共享 Port 并停掉偏好监听 */
  dispose(): void;
}

/** 当前正在渲染的功能 id，由 FeatureSlot 挂载时写入（替代每次调用都查 DOM） */
let activeFeatureId: string | null = null;

export function setActiveFeatureId(id: string | null): void {
  activeFeatureId = id;
}

export function createPageApi(controller: PageController): PageApiHandle {
  /** 每个功能自己订阅，key 是 webhook 集合 */
  const watchers = new Set<{
    filter: { type: string; dedupeKey?: string };
    cb: (j: JobRecord) => void;
  }>();
  /** 最近的任务，按 id 缓存；watchJobs 订阅得晚时用它补一次，避免进度条一直停在 0 */
  const latest = new Map<string, JobRecord>();
  /** 功能私有偏好（内存镜像，持久化在 chrome.storage.local 的 UI 偏好里） */
  const prefsStore = new Map<string, Map<string, unknown>>();
  let toastHandler: ToastHandler | null = null;
  let disposed = false;

  function applyPrefs(prefs: UiPrefs): void {
    const bag = prefs[FEATURE_PREFS_KEY];
    if (!bag || typeof bag !== 'object') return;
    for (const [featureId, value] of Object.entries(bag as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const map = prefsStore.get(featureId) ?? new Map<string, unknown>();
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) map.set(k, v);
      prefsStore.set(featureId, map);
    }
  }

  // 偏好以 chrome.storage 为准：页面刷新后勾选状态必须还在（§10.3「勾选状态是全局偏好」）。
  // 旧实现只写了内存 Map，刷新页面就丢，于是「再也不想下视频」这个选择每次都要重设一遍。
  const prefsHydrated = readUiPrefs()
    .then(applyPrefs)
    .catch((e) => log.debug('读取功能偏好失败', e));
  const unwatchPrefs = watchUiPrefs(applyPrefs);

  function persistPref(featureId: string, key: string, value: unknown): void {
    const bag = prefsStore.get(featureId) ?? new Map<string, unknown>();
    bag.set(key, value);
    prefsStore.set(featureId, bag);
    const patch: Record<string, unknown> = {};
    for (const [fid, values] of prefsStore) patch[fid] = Object.fromEntries(values);
    void patchUiPrefs({ [FEATURE_PREFS_KEY]: patch } as Partial<UiPrefs>).catch((e) => {
      log.debug('保存功能偏好失败', e);
    });
  }

  /** 同一个 dedupeKey 只保留一条就够，但重试会生成新 id，所以按 id 记、按时间取最新 */
  function remember(job: JobRecord): void {
    latest.delete(job.id);
    latest.set(job.id, job);
    if (latest.size <= LATEST_LIMIT) return;
    // 超上限时优先丢最早结束的，正在跑的任务无论多久都不能丢
    for (const [id, record] of latest) {
      if (id === job.id) continue;
      if (record.status === 'running' || record.status === 'queued') continue;
      latest.delete(id);
      if (latest.size <= LATEST_LIMIT) return;
    }
  }

  /** 某个过滤条件下最近（createdAt 最大）的一条任务 */
  function latestFor(filter: { type: string; dedupeKey?: string }): JobRecord | null {
    let best: JobRecord | null = null;
    for (const job of latest.values()) {
      if (job.type !== filter.type) continue;
      if (filter.dedupeKey && job.dedupeKey !== filter.dedupeKey) continue;
      if (best === null || job.createdAt >= best.createdAt) best = job;
    }
    return best;
  }

  // 一个共享 Port 连接把任务事件分发给所有订阅者
  const disconnect = connectJobPort({
    onMessage(msg: PortMessage) {
      if (disposed) return;
      if (msg.type !== 'job-progress' && msg.type !== 'job-done') return;
      remember(msg.job);
      for (const w of watchers) {
        if (msg.job.type !== w.filter.type) continue;
        if (w.filter.dedupeKey && msg.job.dedupeKey !== w.filter.dedupeKey) continue;
        try {
          w.cb(msg.job);
        } catch (e) {
          log.warn('job watcher threw', e);
        }
      }
    },
  });

  const api: PageApi = {
    async submitJob(type, payload, opts) {
      const current = controller.current();
      const dedupeKey =
        opts?.dedupeKey ?? (current ? `${current.platform}:${current.productId}` : '');
      const res = await sendMessage('job.submit', {
        type,
        payload,
        dedupeKey,
        ...(opts?.label !== undefined ? { label: opts.label } : {}),
      });
      return res as never;
    },

    async cancelJob(jobId) {
      await sendMessage('job.cancel', { jobId });
    },

    async retryJob(jobId, only) {
      return sendMessage('job.retry', { jobId, only });
    },

    watchJobs(filter, cb) {
      const entry = { filter, cb };
      watchers.add(entry);
      // 已经收到的任务立刻回放一次，避免订阅晚于事件导致进度条一直是 0。
      // 必须取**最新**那条：重试会生成新任务 id，取第一条会回放早已结束的旧任务，
      // 面板于是显示「已全部下载」，而真正的任务正在跑。
      const replay = latestFor(filter);
      if (replay !== null) {
        queueMicrotask(() => {
          if (disposed || !watchers.has(entry)) return;
          if (latestFor(filter) !== replay) return; // 期间已经有更新的任务，让那条事件去推
          try {
            cb(replay);
          } catch (e) {
            log.warn('job watcher replay threw', e);
          }
        });
      }
      return () => {
        watchers.delete(entry);
      };
    },

    async call(method, args) {
      const current = controller.current();
      if (!current) throw new Error('no active product');
      return sendMessage('feature.call', {
        feature: inferFeatureId(),
        method,
        args,
      });
    },

    dir: {
      /**
       * 目录状态由外壳查一次后下传（§9.4 只查一次），功能模块从 PanelProps.dir 取。
       * 这里保留接口是为了让 popup / 快捷操作能主动问一次。
       */
      status(): DirState {
        return controller.dirState();
      },
      openGrant(reason) {
        void sendMessage('fs.openGrant', reason === 'change' ? { reason: 'change' } : { reason });
      },
    },

    toast(msg, opts) {
      if (toastHandler) toastHandler(msg, opts);
      else log.info('toast', { msg });
    },

    async copy(text) {
      await navigator.clipboard.writeText(text);
    },

    prefs: {
      get<T>(k: string): T | undefined {
        return prefsStore.get(inferFeatureId())?.get(k) as T | undefined;
      },
      set<T>(k: string, v: T): void {
        persistPref(inferFeatureId(), k, v);
      },
    },
  };

  return {
    api,
    prefsHydrated,
    setToastHandler(handler) {
      toastHandler = handler;
    },
    dispose() {
      disposed = true;
      watchers.clear();
      latest.clear();
      unwatchPrefs();
      disconnect();
    },
  };
}

/**
 * 当前是哪个功能在调用。
 *
 * 优先用 FeatureSlot 挂载时登记的 id；只有在登记之前就被调用（面板还没渲染）才回落到 DOM 查询。
 * 旧实现每次调用都 document.querySelector，而 prefs.get 在每次渲染、每次展开类别时都会调用。
 */
function inferFeatureId(): string {
  if (activeFeatureId !== null) return activeFeatureId;
  const el = document.querySelector<HTMLElement>('[data-ecbox-feature]');
  return el?.dataset.ecboxFeature ?? 'media-download';
}
