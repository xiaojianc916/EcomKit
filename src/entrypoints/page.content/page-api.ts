/**
 * PageApi 的实现（方案 §8.2）。
 *
 * 功能模块只通过这个接口和外界打交道：提交任务、取消、订阅进度、调自己的 service/engine、
 * 读写功能私有偏好。它们**不**直接碰 chrome.* 或 fs —— 这样功能之间不会互相耦合，
 * 也不会把 React 之外的东西拖进 Service Worker。
 */
import type { PageApi } from '../../features/types';
import type { JobRecord } from '../../kernel/jobs/types';
import type { DirState } from '../../kernel/fs/types';
import type { PortMessage } from '../../kernel/messaging/protocol';
import { sendMessage } from '../../kernel/messaging/runtime';
import { connectJobPort } from '../../kernel/messaging/port';
import { createLogger } from '../../kernel/log/logger';
import type { PageController } from './controller';

const log = createLogger('page.api');

export function createPageApi(controller: PageController): PageApi {
  /** 每个功能自己订阅，key 是 webhook 集合 */
  const watchers = new Set<{
    filter: { type: string; dedupeKey?: string };
    cb: (j: JobRecord) => void;
  }>();
  const latest = new Map<string, JobRecord>();
  const prefsStore = new Map<string, Map<string, unknown>>();
  let toastHandler: ((msg: string, opts?: { action?: { label: string; run(): void } }) => void) | null =
    null;

  // 一个共享 Port 连接把任务事件分发给所有订阅者
  const disconnect = connectJobPort({
    onMessage(msg: PortMessage) {
      if (msg.type !== 'job-progress' && msg.type !== 'job-done') return;
      latest.set(msg.job.id, msg.job);
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
      const dedupeKey = opts?.dedupeKey ?? (current ? current.platform + ':' + current.productId : '');
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
      // 已经收到的任务立刻回放一次，避免订阅晚于事件导致进度条一直是 0
      for (const job of latest.values()) {
        if (job.type !== filter.type) continue;
        if (filter.dedupeKey && job.dedupeKey !== filter.dedupeKey) continue;
        cb(job);
        break;
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
        void sendMessage('fs.openGrant',
          reason === 'change' ? { reason: 'change' } : { reason },
        );
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
        const id = inferFeatureId();
        const m = prefsStore.get(id) ?? new Map<string, unknown>();
        m.set(k, v);
        prefsStore.set(id, m);
      },
    },
  };

  Object.defineProperty(api, '__dispose', { value: disconnect });
  Object.defineProperty(api, '__setToastHandler', {
    value: (h: typeof toastHandler) => {
      toastHandler = h;
    },
  });
  return api;
}

/**
 * 当前是哪个功能在调用。
 * 面板同时只有一个功能可见，所以从 DOM 上的标记读；读不到时用 v1 唯一的功能。
 */
function inferFeatureId(): string {
  const el = document.querySelector<HTMLElement>('[data-ecbox-feature]');
  return el?.dataset.ecboxFeature ?? 'media-download';
}