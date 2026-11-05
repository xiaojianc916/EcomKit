/**
 * Offscreen 文档（方案 §4.2、ADR-1、ADR-5）。
 *
 * 它是**任务的真相源**：队列、进度、取消、续传全在这里。
 * Service Worker 随时会被回收，所以 SW 只存一份镜像。
 *
 * 同时它是唯一能做这些事的地方：用 IndexedDB 里的目录句柄写文件（FSA 在 SW 里不可用）、
 * OffscreenCanvas 转码、以及跑几百 MB 的流式下载（不受 SW 30 秒空闲回收影响）。
 *
 * 绝不渲染 UI。
 *
 * **启动顺序是有讲究的**：消息处理器必须在模块求值时**立刻**注册，初始化（读设置、
 * 建 sink、读句柄）放在一个 memo 化的 Promise 里由处理器 await。
 * 旧实现先 await 完初始化才注册处理器，bg 只要在这一小段时间里发 engine.enqueue，
 * 就会拿到 "Could not establish connection"，面板上就是「点了下载没反应」。
 */

import { engineFeatures } from '../../features/registry.engine';
import { createFsGateway } from '../../kernel/fs/fs-gateway';
import { createDownloadsSink } from '../../kernel/fs/sinks/downloads';
import { createFsaSink } from '../../kernel/fs/sinks/fsa';
import { createMemorySink } from '../../kernel/fs/sinks/memory';
import type { DirState, FsGateway } from '../../kernel/fs/types';
import { createJobRunner, type JobRunner } from '../../kernel/jobs/runner';
import { createLogger, type Logger } from '../../kernel/log/logger';
import { createMediaTools } from '../../kernel/media/convert';
import { onMessage, sendMessage } from '../../kernel/messaging/runtime';
import { createFetcher } from '../../kernel/net/fetcher';
import type { GlobalSettings } from '../../kernel/settings/schema';
import {
  DEFAULT_GLOBAL_SETTINGS,
  GlobalSettings as GlobalSettingsSchema,
} from '../../kernel/settings/schema';
import { kvList, kvSet } from '../../kernel/storage/idb';
import { STORAGE_KEYS } from '../../kernel/storage/keys';

const log = createLogger('offscreen');

/**
 * 把引擎日志转发给 bg。
 *
 * offscreen 文档的 console 不在任何 DevTools 里，出了问题只能靠诊断包。
 * bg 的 logBuffer 是诊断包的数据源（§6.7），所以这里把引擎侧的关键日志也推过去。
 */
function forwardToBackground(
  level: 'info' | 'warn' | 'error',
  scope: string,
  msg: string,
  data?: unknown,
): void {
  void sendMessage('engine.log', { level, scope, msg, data }).catch(() => {});
}

/** 初始化结果（memo 化，只跑一次） */
interface Booted {
  gateway: FsGateway;
  runner: JobRunner;
}

let bootPromise: Promise<Booted> | null = null;

async function boot(): Promise<Booted> {
  const settings = await fetchSettings();

  // 保存方式决定用哪个 sink（§11、§9.13）；E2E 用内存 sink 让 Playwright 能校验目录树
  const isE2E = Boolean((globalThis as { __ECBOX_E2E__?: boolean }).__ECBOX_E2E__);
  /**
   * downloads 模式没有 .ecbox.json 的读能力，文件记录只能落在 IndexedDB 的 downloads 表里，
   * 而且**必须跨重启保留** —— 否则每次重开浏览器，增量下载都退化成全量重下。
   * 旧实现既没传 initialFiles 也没接 persist，这张表从来就没被用过。
   */
  const sink = isE2E
    ? createMemorySink()
    : settings.save.mode === 'downloads'
      ? createDownloadsSink({
          initialFiles: await loadDownloadRecords(),
          persist: saveDownloadRecords,
        })
      : createFsaSink();

  const gateway = createFsGateway({ sink });
  // 引擎日志同时进本地 console 和 bg 的日志缓冲（诊断包里才看得到）
  const engineLog: Logger = {
    debug: (m, d) => log.debug(m, d),
    info: (m, d) => {
      log.info(m, d);
      forwardToBackground('info', 'engine', m, d);
    },
    warn: (m, d) => {
      log.warn(m, d);
      forwardToBackground('warn', 'engine', m, d);
    },
    error: (m, d) => {
      log.error(m, d);
      forwardToBackground('error', 'engine', m, d);
    },
    scope: (name) => {
      const inner = engineLog.scope;
      void inner;
      return scopedEngineLog(name);
    },
  };
  const scopedEngineLog = (name: string): Logger => ({
    debug: (m, d) => log.debug(m, d),
    info: (m, d) => {
      log.info(m, d);
      forwardToBackground('info', `engine.${name}`, m, d);
    },
    warn: (m, d) => {
      log.warn(m, d);
      forwardToBackground('warn', `engine.${name}`, m, d);
    },
    error: (m, d) => {
      log.error(m, d);
      forwardToBackground('error', `engine.${name}`, m, d);
    },
    scope: (sub) => scopedEngineLog(`${name}.${sub}`),
  });

  const runner = createJobRunner({
    gateway,
    jobTypes: engineFeatures.flatMap((f) => f.engine?.jobTypes ?? []),
    log: engineLog,
    concurrency: settings.jobs.concurrency,
    net: createFetcher({ log: engineLog.scope('net') }),
    media: createMediaTools(),
  });

  await runner.start(gateway);

  /**
   * 设置变了要**真的换写入层**（§11、§9.13）。
   *
   * 旧实现只在启动时读一次 settings.save.mode：用户在设置页把「自选文件夹」改成
   * 「浏览器下载目录」之后，引擎仍然按 FSA 走 —— 没有目录句柄，于是目录状态永远是
   * unset，点下载只会弹授权小窗，看起来就像「点了没反应」。
   */
  // 设置变化由 bg 推过来（offscreen 订阅不了 chrome.storage.onChanged）
  onMessage('engine.settingsChanged', async ({ data, sender }) => {
    assertTrusted(sender, 'engine.settingsChanged');
    const parsed = GlobalSettingsSchema.safeParse(data);
    if (parsed.success) applySettings(parsed.data, gateway, runner, isE2E);
  });

  log.info('offscreen booting', {
    features: engineFeatures.length,
    types: runner.registeredTypes(),
    sink: sink.kind,
  });

  // 进度只往 bg 推，bg 再分发到各 Tab 的 Port（§4.3 第 7、8 步）
  runner.onEvent((ev) => {
    void sendMessage('engine.event', ev).catch(() => {
      // bg 正在重启时发不出去，下一条 progress 会补上最新状态
    });
  });

  void sendMessage('engine.ready').catch(() => {});
  log.info('offscreen ready');
  return { gateway, runner };
}

/**
 * 向 bg 要设置。
 *
 * **offscreen 文档里没有 chrome.storage**（只有 chrome.runtime），
 * 所以设置只能由 bg 代读。旧实现在这里直接调用 wxt 的 storage：启动即抛
 * "You must add the 'storage' permission to your manifest"，整个引擎起不来。
 */
async function fetchSettings(): Promise<GlobalSettings> {
  try {
    const raw = (await sendMessage('engine.settings')) as unknown;
    const parsed = GlobalSettingsSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  } catch (e) {
    log.warn('读取设置失败，使用默认值', { error: describeError(e) });
  }
  return DEFAULT_GLOBAL_SETTINGS;
}

/** 把异常压成一行可读文本（只进日志） */
function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** 把全局设置应用到正在运行的引擎上（保存方式 / 并发数） */
function applySettings(
  next: GlobalSettings,
  gateway: FsGateway,
  runner: JobRunner,
  isE2E: boolean,
): void {
  runner.setConcurrency(next.jobs.concurrency);
  if (isE2E) return;
  const wantDownloads = next.save.mode === 'downloads';
  const current = gateway.sink.kind;
  if (wantDownloads && current !== 'downloads') {
    gateway.setSink(createDownloadsSink());
    log.info('写入层切换为 downloads');
  } else if (!wantDownloads && current !== 'fsa') {
    gateway.setSink(createFsaSink());
    log.info('写入层切换为 fsa');
  }
}

/** downloads 模式的文件记录（IndexedDB downloads 表 → path → size） */
async function loadDownloadRecords(): Promise<Array<[string, number]>> {
  try {
    const rows = await kvList<'downloads', unknown>(STORAGE_KEYS.stores.downloads);
    const out: Array<[string, number]> = [];
    for (const row of rows) {
      const value = row.value as { files?: Record<string, number> } | undefined;
      if (value && typeof value.files === 'object' && value.files !== null) {
        for (const [path, size] of Object.entries(value.files)) {
          if (typeof size === 'number') out.push([path, size]);
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function saveDownloadRecords(files: Record<string, number>): Promise<void> {
  try {
    await kvSet(STORAGE_KEYS.stores.downloads, 'index', { at: Date.now(), files });
  } catch {
    // 写不进去只影响增量判断，不影响下载本身
  }
}

function ensureBooted(): Promise<Booted> {
  bootPromise ??= boot()
    .then((b) => {
      void recordBoot({ ok: true, sink: b.gateway.sink.kind });
      return b;
    })
    .catch((e) => {
      // 初始化失败不能把 handler 变成永挂的 Promise：清掉 memo，下次调用重试
      bootPromise = null;
      log.error('offscreen boot failed', e);
      void recordBoot({ ok: false, error: describeError(e) });
      throw e;
    });
  return bootPromise;
}

/**
 * 把启动结果写进 storage.session。
 *
 * 引擎跑在 offscreen 文档里，它的 console 不在任何一个标签页和 SW 的 DevTools 里，
 * 出问题时**没有任何地方能看到**。诊断包读这一条就能判断「引擎到底起没起来、
 * 用的是哪种写入方式」，而不是靠猜。
 */
async function recordBoot(info: { ok: boolean; sink?: string; error?: string }): Promise<void> {
  try {
    await chrome.storage.session.set({ 'engine.boot': { ...info, at: Date.now() } });
  } catch {
    // storage.session 不可用（极端情况）就放弃记录
  }
}

function _describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/**
 * 入口鉴权（§6.3 约定 1）。
 *
 * 内容脚本跑在网页源里，页面脚本可以影响它；offscreen 的 handler 如果谁都能调，
 * 就等于把「建任务 / 写文件 / 取消任务」暴露给任意网页。
 * 这里只拒绝**带 tab 的发送方**（内容脚本）和网页源，扩展自己的上下文（bg SW、offscreen）放行。
 */
function assertTrusted(sender: chrome.runtime.MessageSender, method: string): void {
  const url = sender.url ?? sender.origin ?? '';
  const fromTab = typeof sender.tab?.id === 'number';
  const isWebOrigin = /^https?:/i.test(url);
  if (fromTab || isWebOrigin) {
    log.warn('offscreen 拒绝外部调用', { method, url, fromTab });
    throw new Error(`forbidden: ${method}`);
  }
}

// ---------- 处理器：模块求值时就注册，初始化在 handler 内部 await ----------

onMessage('engine.enqueue', async ({ data, sender }) => {
  assertTrusted(sender, 'engine.enqueue');
  const { runner } = await ensureBooted();
  await runner.enqueue(data.job, data.payload);
});

onMessage('engine.cancel', async ({ data, sender }) => {
  assertTrusted(sender, 'engine.cancel');
  const { runner } = await ensureBooted();
  runner.cancel(data.jobId);
});

onMessage('engine.call', async ({ data, sender }) => {
  assertTrusted(sender, 'engine.call');
  const { gateway, runner } = await ensureBooted();

  // 运行时保留方法：bg 用它做「重试失败项」和诊断（不走功能注册表）
  if (data.feature === '__runtime__') {
    if (data.method === 'status') {
      // 诊断用：引擎实际生效的写入方式、目录状态、已完成任务数
      const dir = await gateway.status().catch(() => ({ status: 'unknown' as const }));
      const settings = await fetchSettings();
      return {
        sinkKind: gateway.sink.kind,
        saveMode: settings.save.mode,
        dirStatus: dir.status,
        dirName: 'name' in dir ? (dir.name ?? '') : '',
        jobs: runner.list().length,
        registeredTypes: runner.registeredTypes(),
      };
    }
    if (data.method === 'retry') {
      const args = data.args as { jobId?: string; only?: 'failed' };
      if (typeof args?.jobId !== 'string' || args.only !== 'failed') {
        throw new Error('bad retry args');
      }
      const res = await runner.retry(args.jobId, 'failed');
      if (res === null) throw new Error('retry unavailable');
      return res;
    }
    throw new Error(`no runtime method ${data.method}`);
  }

  const feature = engineFeatures.find((f) => f.manifest.id === data.feature);
  const method = feature?.engine?.methods?.[data.method];
  if (!method) throw new Error(`no engine method ${data.feature}.${data.method}`);
  return method(data.args, { gateway, log });
});

onMessage('engine.fsStatus', async ({ sender }): Promise<DirState> => {
  assertTrusted(sender, 'engine.fsStatus');
  const { gateway } = await ensureBooted();
  return gateway.status();
});

onMessage('engine.fsChanged', async ({ sender }): Promise<DirState> => {
  assertTrusted(sender, 'engine.fsChanged');
  const { gateway, runner } = await ensureBooted();
  // 授权小窗刚写完句柄，或用户在设置里切了保存方式：重新读设置再判状态
  const settings = await fetchSettings();
  applySettings(
    settings,
    gateway,
    runner,
    Boolean((globalThis as { __ECBOX_E2E__?: boolean }).__ECBOX_E2E__),
  );
  return gateway.sink.refresh();
});

// 启动即初始化（不等任何消息），失败只记日志，下一次调用会重试
void ensureBooted().catch(() => {});
