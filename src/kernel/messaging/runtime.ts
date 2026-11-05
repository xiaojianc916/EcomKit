import { defineExtensionMessaging } from '@webext-core/messaging';
import { z } from 'zod';
import { EcError } from '../errors/ec-error';
import { createLogger } from '../log/logger';
import type { ProtocolMap } from './protocol';

/**
 * 类型化消息通道（方案 §6.3「Runtime 请求」行）。
 *
 * 用 @webext-core/messaging 而不是自己包 chrome.runtime.sendMessage：
 *   · 协议表 ProtocolMap 把每一对请求/响应约束成类型，发错方法名直接编译不过；
 *   · payload 和返回值类型也一起被约束。
 *
 * 安全约束（§6.3 约定 1）分两层：
 *   1. guardSender：内容脚本只能调白名单方法；engine.* 只接受 offscreen 文档；
 *   2. validatePayload：进入 handler 之前再过一遍 Zod。
 *      协议表的类型只在编译期有效，运行期任何页面脚本都能往扩展发消息（内容脚本跑在网页源里，
 *      可以被页面脚本影响），所以入口处必须真的校验结构。
 */

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();

const log = createLogger('messaging');

/** 内容脚本（网页里的 ISOLATED world）允许调用的方法白名单 */
const CONTENT_SCRIPT_ALLOWED = new Set<string>([
  'shell.getTabState',
  'shell.pushTabState',
  'shell.togglePanel',
  'shell.openOptions',
  'shell.mobileMode',
  'shell.diagnostics',
  'fs.status',
  'fs.openGrant',
  'job.submit',
  'job.cancel',
  'job.retry',
  'job.list',
  'feature.call',
]);

/** 扩展自己的页面（popup / options / grant）额外允许的 */
const EXTENSION_PAGE_ALLOWED = new Set<string>([
  ...CONTENT_SCRIPT_ALLOWED,
  'grant.getInit',
  'grant.persisted',
  'grant.close',
  'fs.changed',
]);

/** 只允许 offscreen 调用的（§6.3：bg ↔ offscreen） */
const OFFSCREEN_ONLY = new Set<string>([
  'engine.enqueue',
  'engine.cancel',
  'engine.fsStatus',
  'engine.fsChanged',
  'engine.call',
  'engine.event',
  'engine.ready',
  // offscreen 反向问 bg 要设置（它自己读不了 chrome.storage）
  'engine.settings',
  // offscreen 把引擎日志转发给 bg（诊断包的数据源）
  'engine.log',
  // offscreen 借用 bg 的 chrome.downloads（offscreen 自己没有这个 API）
  'engine.download',
]);

/** 只允许 bg 自己发的（bg → offscreen 的单向通知） */
const BACKGROUND_ONLY = new Set<string>(['engine.settingsChanged']);

export type SenderKind = 'content' | 'extension-page' | 'offscreen' | 'background' | 'unknown';

export function classifySender(sender: chrome.runtime.MessageSender): SenderKind {
  const url = sender.url ?? '';
  if (url.endsWith('offscreen.html')) return 'offscreen';
  if (url.startsWith('chrome-extension://')) return 'extension-page';
  if (typeof sender.tab?.id === 'number') return 'content';
  // SW 自己给自己发的消息：没有 tab、也没有 url
  if (!url) return 'background';
  return 'unknown';
}

export interface SenderCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * §6.3 约定 1 的 sender 鉴权，在 bg 的每个 handler 入口调用。
 *
 * 注意：这里拦的是「误用和越权」，不是对抗性安全边界 —— 同源的扩展页面之间本来就互相信任。
 * 真正的价值是：内容脚本（跑在网页源里，可以被页面脚本影响）**不能**直接指挥 offscreen。
 */
export function guardSender(
  method: string,
  sender: chrome.runtime.MessageSender,
): SenderCheckResult {
  const kind = classifySender(sender);

  if (BACKGROUND_ONLY.has(method)) {
    return kind === 'background'
      ? { ok: true }
      : { ok: false, reason: `${method} only accepts background sender` };
  }

  if (OFFSCREEN_ONLY.has(method)) {
    // bg → offscreen 的消息没有 sender.tab，且 sender.url 是 offscreen.html
    if (kind !== 'offscreen') {
      return { ok: false, reason: `${method} only accepts offscreen sender` };
    }
    return { ok: true };
  }

  if (kind === 'content') {
    if (!CONTENT_SCRIPT_ALLOWED.has(method)) {
      return { ok: false, reason: `${method} not allowed from content script` };
    }
    return { ok: true };
  }

  if (kind === 'extension-page') {
    if (!EXTENSION_PAGE_ALLOWED.has(method)) {
      return { ok: false, reason: `${method} not allowed from extension page` };
    }
    return { ok: true };
  }

  return { ok: true };
}

// ---------- 入口处 Zod 校验（§6.3「入口处用 Zod 校验」）----------

const TabStateSchema = z.object({ tabId: z.number().int() });
const JobSubmitSchema = z.object({
  type: z.string().min(1),
  tabId: z.number().int().optional(),
  payload: z.unknown(),
  dedupeKey: z.string().min(1),
  label: z.string().optional(),
});
const DirStateSchema = z.object({
  status: z.enum(['unset', 'needs-grant', 'gone', 'ready']),
  name: z.string().optional(),
});
const OpenGrantSchema = z.object({
  reason: z.enum(['unset', 'needs-grant', 'gone', 'change']),
  tabId: z.number().int().optional(),
});
const JobIdSchema = z.object({ jobId: z.string().min(1) });
const RetrySchema = z.object({ jobId: z.string().min(1), only: z.literal('failed') });
const JobListSchema = z.object({ tabId: z.number().int().optional() }).optional();
const FeatureCallSchema = z.object({
  feature: z.string().min(1),
  method: z.string().min(1),
  args: z.unknown(),
});
const EngineEnqueueSchema = z.object({ job: z.unknown(), payload: z.unknown() });
const _PersistHandleSchema = z.object({ handle: z.unknown() });

/**
 * 每个方法的 payload 校验器。表里没有的方法不校验（都是无参的）。
 * 校验失败一律抛 EcError(INTERNAL)，绝不把 Zod 的报错直接抛给调用方（§6.2 不显示异常 message）。
 */
const PAYLOAD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'shell.getTabState': TabStateSchema,
  'shell.togglePanel': TabStateSchema,
  'shell.mobileMode': TabStateSchema,
  'job.submit': JobSubmitSchema,
  'fs.changed': DirStateSchema,
  'fs.openGrant': OpenGrantSchema,
  'job.cancel': JobIdSchema,
  'job.retry': RetrySchema,
  'feature.call': FeatureCallSchema,
  'engine.call': FeatureCallSchema,
  'engine.enqueue': EngineEnqueueSchema,
  'engine.cancel': JobIdSchema,
};

export function validatePayload(method: string, data: unknown): unknown {
  const schema = PAYLOAD_SCHEMAS[method];
  if (!schema) return data;
  const result = schema.safeParse(data);
  if (!result.success) {
    log.warn('消息 payload 校验失败', { method, issues: result.error.issues.length });
    throw new EcError('INTERNAL', { reason: 'payload-invalid', method });
  }
  return result.data;
}

/** 校验 job.list 的可选 payload（没有参数是合法的） */
export function validateJobList(data: unknown): { tabId?: number } {
  const result = JobListSchema.safeParse(data);
  if (!result.success || result.data === undefined) return {};
  return result.data.tabId === undefined ? {} : { tabId: result.data.tabId };
}

// ---------- bg 侧的包装器 ----------

/**
 * 包装一个 bg handler：先过 sender 鉴权，再过 payload 校验。
 * bg 里每个 onMessage 都应该用它，不要裸写回调。
 */
export function guardedHandler<P, R>(
  method: string,
  handler: (payload: P, sender: chrome.runtime.MessageSender) => Promise<R> | R,
): (message: { data: P; sender: chrome.runtime.MessageSender }) => Promise<R> {
  return async ({ data, sender }) => {
    const check = guardSender(method, sender);
    if (!check.ok) {
      log.warn('消息来源被拒绝', { method, reason: check.reason });
      throw new EcError('INTERNAL', { reason: 'forbidden', method });
    }
    const payload = validatePayload(method, data) as P;
    return handler(payload, sender);
  };
}

/**
 * 无参方法的包装器（shell.diagnostics / fs.status / engine.ready 之类）。
 * 单独一个函数是为了让调用点读起来更清楚，内部走同一套鉴权。
 */
export function guardedVoidHandler<R>(
  method: string,
  handler: (sender: chrome.runtime.MessageSender) => Promise<R> | R,
): (message: { data: unknown; sender: chrome.runtime.MessageSender }) => Promise<R> {
  return async ({ sender }) => {
    const check = guardSender(method, sender);
    if (!check.ok) {
      log.warn('消息来源被拒绝', { method, reason: check.reason });
      throw new EcError('INTERNAL', { reason: 'forbidden', method });
    }
    return handler(sender);
  };
}
