/**
 * Service Worker（方案 §4.2）。
 *
 * **刻意不执行长任务**：SW 空闲约 30 秒就会被回收，下载、转码、写文件全在 Offscreen。
 * 它只做六件事：
 *   1. 消息路由 + 来源鉴别（§6.3 约定 1）
 *   2. JobRegistry 镜像（storage.session，ADR-5）
 *   3. ensureOffscreen()：引擎不在就拉起来
 *   4. 打开 / 复用授权小窗，管理 pendingIntent 续接（§9.4）
 *   5. 快捷键、DNR 规则、工具栏角标
 *   6. popup / options 的数据来源
 */
import { defineBackground } from 'wxt/utils/define-background';
import type { DirState } from '../kernel/fs/types';
import { dumpDiagnostics } from '../kernel/log/diagnostics';
import { createLogger, logBuffer } from '../kernel/log/logger';
import { createPortServer } from '../kernel/messaging/port';
import type { JobSubmit, TabState } from '../kernel/messaging/protocol';
import { guardSender, onMessage, sendMessage } from '../kernel/messaging/runtime';
import { getSettings, readSettings, watchSettings } from '../kernel/settings/store';
import { STORAGE_KEYS } from '../kernel/storage/keys';

const log = createLogger('bg');
const ports = createPortServer();

export default defineBackground(() => {
  log.info('background booting');

  // ---------- 1. 消息路由（来源鉴别在每个 handler 入口） ----------
  onMessage('shell.getTabState', async ({ data, sender }) => {
    const check = guardSender('shell.getTabState', sender);
    if (!check.ok) throw new Error(check.reason ?? 'forbidden');
    return getTabState(data.tabId);
  });

  onMessage('fs.status', async ({ sender }) => {
    const check = guardSender('fs.status', sender);
    if (!check.ok) throw new Error(check.reason ?? 'forbidden');
    return engineCall<DirState>('engine.fsStatus', undefined);
  });

  onMessage('fs.openGrant', async ({ data, sender }) => {
    const check = guardSender('fs.openGrant', sender);
    if (!check.ok) throw new Error(check.reason ?? 'forbidden');
    await openGrantWindow(data.reason, data.tabId ?? sender.tab?.id);
  });

  onMessage('fs.changed', async ({ data }) => {
    // grant 小窗完成授权：先让 offscreen 刷新句柄状态，再广播给所有页面
    const state = await engineCall<DirState>('engine.fsChanged', undefined).catch(() => data);
    ports.broadcast({ type: 'dir-changed', dir: state });
    await maybeResumePendingIntent();
  });

  onMessage('job.submit', async ({ data, sender }) => {
    const check = guardSender('job.submit', sender);
    if (!check.ok) throw new Error(check.reason ?? 'forbidden');
    return submitJob(data, sender.tab?.id);
  });

  onMessage('job.cancel', async ({ data }) => {
    await engineCall('engine.cancel', { jobId: data.jobId });
  });

  onMessage('job.list', async ({ data }) => listJobs(data.tabId));

  /**
   * 只重跑失败项（§10.4「重试」）。旧实现根本没注册这个 handler，
   * 面板上点「重试 N 个失败项」只会得到一句 "Could not establish connection"。
   */
  onMessage('job.retry', async ({ data, sender }) => {
    const check = guardSender('job.retry', sender);
    if (!check.ok) throw new Error(check.reason ?? 'forbidden');
    return retryJob(data.jobId, data.only);
  });

  onMessage('feature.call', async ({ data, sender }) => {
    const check = guardSender('feature.call', sender);
    if (!check.ok) throw new Error(check.reason ?? 'forbidden');
    return engineCall('engine.call', {
      feature: data.feature,
      method: data.method,
      args: data.args,
    });
  });

  onMessage('shell.togglePanel', async ({ data }) => {
    ports.send(data.tabId, { type: 'panel-toggle' });
  });

  onMessage('shell.openOptions', async () => {
    await chrome.runtime.openOptionsPage();
  });

  /** 工具栏 popup 和面板共用同一份状态（§10.8）：后台只是转发目标标签页的应答 */
  onMessage('shell.pushTabState', async ({ data }) => {
    ports.broadcast({ type: 'dir-changed', dir: data.dir });
  });

  /**
   * 「以手机模式重新打开」（§7.6.5）。Phase 0 已证否：两个平台改 UA 都拿不到商品数据
   * （docs/phase0/FINDINGS.md 第 1 节），所以这里只把标签页切到前台，不再假装能用。
   */
  onMessage('shell.mobileMode', async ({ data }) => {
    await chrome.tabs.update(data.tabId, { active: true });
  });

  /** 导出诊断包（§6.7）：面板「导出诊断」按钮走这里 */
  onMessage('shell.diagnostics', async () => buildDiagnosticsPackage());

  onMessage('engine.event', async ({ data, sender }) => {
    // 只认 offscreen 的事件（内容脚本能调到 runtime.sendMessage，不能让它伪造任务进度）
    const url = sender.url ?? '';
    if (!url.endsWith('offscreen.html')) {
      log.warn('拒绝非 offscreen 的 engine.event', { url });
      throw new Error('forbidden: engine.event');
    }
    await handleEngineEvent(data);
  });

  onMessage('engine.ready', async ({ sender }) => {
    log.info('offscreen reported ready', { url: sender.url ?? '' });
  });

  /**
   * offscreen 借道下载：chrome.downloads 只存在于 SW，offscreen 里没有。
   * 收到的字节在这里变成 blob URL 交给浏览器，再把最终落盘路径回给引擎。
   */
  onMessage('engine.download', async ({ data, sender }) => {
    const url = sender.url ?? '';
    if (!url.endsWith('offscreen.html')) throw new Error('forbidden: engine.download');
    /**
     * 优先用**原始直链**：chrome.downloads 只在 http(s)/blob URL 上保留 filename，
     * 并且是流式落盘，不经过本进程内存。
     *
     * 只有内容被改写过（WebP→JPG 转码）时才退化到 data: URL ——
     * 但 SW 里**没有 URL.createObjectURL**（MV3 限制），data: URL 也不保证文件名，
     * 所以转码后的文件在 downloads 模式下只能作为兜底。
     */
    const isHttp = typeof data.url === 'string' && /^https?:/i.test(data.url);
    let downloadUrl: string;
    let fallbackSize = 0;
    if (isHttp && data.url !== undefined) {
      downloadUrl = data.url;
    } else if (data.data !== undefined) {
      const bytes = new Uint8Array(data.data);
      fallbackSize = bytes.byteLength;
      downloadUrl = bytesToDataUrl(bytes, data.mime ?? '');
    } else {
      throw new Error('engine.download 需要 url 或 data');
    }

    const id = await chrome.downloads.download({
      url: downloadUrl,
      filename: data.filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    // 大文件下载是异步的：等它落到 complete 再回报真实路径和大小
    const item = await waitForDownload(id);
    return {
      filename: item?.filename ?? data.filename,
      size: item?.fileSize ?? item?.totalBytes ?? fallbackSize,
    };
  });

  /** offscreen 转发的引擎日志，进 bg 的日志缓冲（诊断包的数据源，§6.7） */
  onMessage('engine.log', async ({ data, sender }) => {
    const url = sender.url ?? '';
    if (!url.endsWith('offscreen.html')) throw new Error('forbidden: engine.log');
    const line = createLogger(data.scope || 'engine');
    if (data.level === 'error') line.error(data.msg, data.data);
    else if (data.level === 'warn') line.warn(data.msg, data.data);
    else line.info(data.msg, data.data);
  });

  /**
   * offscreen 反向要设置：**它自己没有 chrome.storage**，只能由 bg 代读。
   * 这是整个下载链路的启动前提 —— 拿不到设置，引擎就不知道该用 FSA 还是 downloads。
   */
  onMessage('engine.settings', async ({ sender }) => {
    const url = sender.url ?? '';
    if (!url.endsWith('offscreen.html')) {
      throw new Error('forbidden: engine.settings');
    }
    return getSettings();
  });

  onMessage('grant.getInit', async () => readGrantInit());
  onMessage('grant.persisted', async ({ data }) => {
    // 句柄已经由授权小窗自己存进 IndexedDB（它和 bg/offscreen 同源共享），
    // 这里只需要让 offscreen 丢掉缓存的旧句柄并重判状态。
    log.info('root handle persisted', { name: data.name });
    const state = await engineCall<DirState>('engine.fsChanged', undefined).catch(() => ({
      status: 'ready' as const,
      name: data.name,
    }));
    ports.broadcast({ type: 'dir-changed', dir: state });
    await maybeResumePendingIntent();
  });
  onMessage('grant.close', async () => {
    await clearPendingIntent();
  });

  // ---------- 5. 快捷键 ----------
  chrome.commands.onCommand.addListener(async (command) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    if (command === 'toggle-toolbox') {
      ports.send(tab.id, { type: 'panel-toggle' });
    } else if (command === 'download-checked') {
      // 功能命令交给页面自己处理：它知道当前快照和勾选状态
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'ecbox:command', command });
      } catch {
        /* 页面没注入（不是商品页），忽略 */
      }
    }
  });

  // ---------- 授权小窗关闭 → 清 pendingIntent（§9.4） ----------
  chrome.windows.onRemoved.addListener(async (windowId) => {
    const stored = await chrome.storage.session.get(STORAGE_KEYS.grantWindowId);
    if (stored[STORAGE_KEYS.grantWindowId] === windowId) {
      await chrome.storage.session.remove([STORAGE_KEYS.grantWindowId, STORAGE_KEYS.pendingIntent]);
      ports.broadcast({ type: 'dir-changed', dir: await safeFsStatus() });
    }
  });

  // ---------- 设置变化 → 通知 offscreen 重新应用（§11、§9.13） ----------
  // offscreen 订阅不了 chrome.storage.onChanged，只能由 bg 转发。
  watchSettings((next) => {
    void ensureOffscreen()
      .then(() => sendMessage('engine.settingsChanged', next))
      .catch((e) => log.debug('推送设置到 offscreen 失败', e));
  });

  // ---------- SW 重启后的崩溃恢复（§6.4、ADR-5） ----------
  void recoverAfterRestart();

  log.info('background ready');
});

/* ============================ 实现 ============================ */

/**
 * 重试失败项：offscreen 里 runner 保留着原任务的 payload，
 * 这里只负责转发，并把新任务接到同一个标签页（进度仍然推回原页面）。
 */
async function retryJob(jobId: string, only: 'failed'): Promise<{ jobId: string }> {
  await ensureOffscreen();
  try {
    return (await sendMessage('engine.call', {
      feature: '__runtime__',
      method: 'retry',
      args: { jobId, only },
    })) as { jobId: string };
  } catch (e) {
    log.warn('重试失败', { jobId, code: String(e) });
    throw e;
  }
}

/** 诊断包：日志 + 任务 + 环境（不含 Cookie / 完整 URL，§6.7） */
async function buildDiagnosticsPackage(): Promise<{ json: string }> {
  const [settings, dir, jobs] = await Promise.all([
    readSettings().catch(() => null),
    safeFsStatus(),
    listJobs().catch(() => []),
  ]);
  // 引擎侧的真实状态（写入方式是否切了、目录是否 ready、注册了哪些任务类型）。
  // 拿不到时把原因也带上 —— 引擎起不来时最需要知道的就是这一句。
  let engine: unknown = {};
  try {
    engine = await engineCall<Record<string, unknown>>('engine.call', {
      feature: '__runtime__',
      method: 'status',
      args: undefined,
    });
  } catch (e) {
    const boot = (await chrome.storage.session.get('engine.boot').catch(() => ({}))) as Record<
      string,
      unknown
    >;
    engine = { error: String(e), boot: boot['engine.boot'] ?? null };
  }
  const json = dumpDiagnostics({
    version: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    logs: logBuffer.snapshot(),
    jobs,
    env: {
      saveMode: settings?.save.mode ?? 'unknown',
      dirStatus: dir.status,
      dirName: dir.name ?? '',
      concurrency: settings?.jobs.concurrency ?? 0,
      engine: JSON.stringify(engine),
    },
  });
  return { json };
}

async function engineCall<T>(method: string, payload: unknown): Promise<T> {
  await ensureOffscreen();
  if (payload === undefined) return (await sendMessage(method as never)) as T;
  return (await sendMessage(method as never, payload as never)) as T;
}

/**
 * Offscreen 是任务真相源，没它就什么也做不了（ADR-5）。
 * 用 chrome.runtime.getContexts 判断它在不在，而不是靠全局变量 —— SW 重启后全局变量会丢。
 */
async function ensureOffscreen(): Promise<void> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    });
    if (contexts.length > 0) return;
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['BLOBS' as chrome.offscreen.Reason],
      justification: '下载并写入商品素材文件',
    });
  } catch (e) {
    // 已经在创建中的情况会抛「Only a single offscreen document may be created」
    log.debug('ensureOffscreen', e);
  }
}

/** 等一个下载任务结束（downloads 是异步的，立刻 search 往往还在 in_progress） */
async function waitForDownload(id: number): Promise<chrome.downloads.DownloadItem | undefined> {
  for (let i = 0; i < 120; i += 1) {
    const [item] = await chrome.downloads.search({ id });
    if (item === undefined) return undefined;
    if (item.state !== 'in_progress') return item;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const [last] = await chrome.downloads.search({ id });
  return last;
}

/** 字节 → data: URL（SW 里没有 URL.createObjectURL，只能这样把内容交给下载通道） */
function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  const type = mime === '' ? 'application/octet-stream' : mime;
  // 分块转 base64：一次 apply 几百万个参数会爆栈
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

async function safeFsStatus(): Promise<DirState> {
  try {
    return await engineCall<DirState>('engine.fsStatus', undefined);
  } catch {
    return { status: 'unset' };
  }
}

async function submitJob(
  p: JobSubmit,
  senderTabId?: number,
): Promise<{ jobId: string } | { waiting: 'dir' }> {
  const dir = await safeFsStatus();
  const tabId = p.tabId ?? senderTabId;

  // 没有目录：把意图存起来，开小窗，授权完成后自动续上（§9.4 下载意图续接）
  if (dir.status !== 'ready') {
    await chrome.storage.session.set({
      [STORAGE_KEYS.pendingIntent]: {
        jobSubmit: p,
        ...(tabId === undefined ? {} : { tabId }),
        createdAt: Date.now(),
      },
    });
    await openGrantWindow(dir.status, tabId);
    return { waiting: 'dir' };
  }

  return enqueueNow(p, tabId);
}

/**
 * 真正提交任务。**tabId 必须写进 JobRecord**：offscreen 推事件时靠它决定推给哪个标签页，
 * 没有 tabId 时进度事件会被 bg 直接丢掉，页面上的进度条和「已保存 N 个文件」永远不动，
 * 用户看到的就是「点了下载，什么都没发生」。
 */
async function enqueueNow(p: JobSubmit, tabId?: number): Promise<{ jobId: string }> {
  const job = buildJobRecord(p, tabId);
  await ensureOffscreen();
  await engineCall('engine.enqueue', { job, payload: p.payload });
  return { jobId: job.id };
}

function buildJobId(p: JobSubmit): string {
  return `${p.dedupeKey}:${Date.now().toString(36)}`;
}

function buildJobRecord(p: JobSubmit, tabId?: number) {
  return {
    id: buildJobId(p),
    type: p.type,
    dedupeKey: p.dedupeKey,
    payload: p.payload,
    status: 'queued' as const,
    total: 0,
    done: 0,
    skipped: 0,
    bytes: 0,
    failed: [],
    byGroup: {},
    createdAt: Date.now(),
    ...(tabId === undefined ? {} : { tabId }),
    ...(p.label !== undefined ? { label: p.label } : {}),
  };
}

/** offscreen → bg 的事件：更新镜像，再推给对应 Tab（§4.3 第 7、8 步） */
async function handleEngineEvent(ev: unknown): Promise<void> {
  const e = ev as { type: string; job?: { id: string; tabId?: number } };
  if (!e.job) return;
  await updateMirror(e.job as never);
  if (typeof e.job.tabId === 'number') {
    if (e.type === 'progress')
      ports.send(e.job.tabId, { type: 'job-progress', job: e.job as never });
    else ports.send(e.job.tabId, { type: 'job-done', job: e.job as never });
  }
}

async function updateMirror(job: { id: string }): Promise<void> {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.jobMirror);
  const mirror = (stored[STORAGE_KEYS.jobMirror] as Record<string, unknown>) ?? {};
  mirror[job.id] = job;
  await chrome.storage.session.set({ [STORAGE_KEYS.jobMirror]: mirror });
}

async function listJobs(tabId?: number): Promise<import('../kernel/jobs/types').JobRecord[]> {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.jobMirror);
  const mirror =
    (stored[STORAGE_KEYS.jobMirror] as Record<string, import('../kernel/jobs/types').JobRecord>) ??
    {};
  const all = Object.values(mirror);
  return tabId === undefined ? all : all.filter((j) => j.tabId === tabId);
}

/* ---------- 授权小窗（§9.4） ---------- */

async function openGrantWindow(reason: string, tabId?: number): Promise<void> {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.grantWindowId);
  const existingId = stored[STORAGE_KEYS.grantWindowId] as number | undefined;

  // 已经开着就只聚焦，避免开一堆小窗
  if (typeof existingId === 'number') {
    try {
      await chrome.windows.update(existingId, { focused: true });
      return;
    } catch {
      await chrome.storage.session.remove(STORAGE_KEYS.grantWindowId);
    }
  }

  const win = tabId !== undefined ? await chrome.windows.getCurrent().catch(() => null) : null;
  const width = 440;
  const height = 320;
  const left =
    win?.left !== undefined && win.width !== undefined
      ? Math.round(win.left + (win.width - width) / 2)
      : undefined;
  const top =
    win?.top !== undefined && win.height !== undefined
      ? Math.round(win.top + (win.height - height) / 2)
      : undefined;

  const created = await chrome.windows.create({
    url: chrome.runtime.getURL('grant.html'),
    type: 'popup',
    width,
    height,
    focused: true,
    ...(left !== undefined ? { left } : {}),
    ...(top !== undefined ? { top } : {}),
  });

  if (created?.id !== undefined) {
    await chrome.storage.session.set({
      [STORAGE_KEYS.grantWindowId]: created.id,
      'grant.reason': reason,
    });
  }
}

type GrantMode = 'unset' | 'needs-grant' | 'gone' | 'change';

async function readGrantInit(): Promise<{ mode: GrantMode; currentName?: string }> {
  const [reason, dir] = await Promise.all([
    chrome.storage.session.get('grant.reason'),
    safeFsStatus(),
  ]);
  const raw = (reason['grant.reason'] as GrantMode | undefined) ?? dir.status;
  const mode: GrantMode = raw === 'ready' ? 'unset' : (raw as GrantMode);
  return dir.name ? { mode, currentName: dir.name } : { mode };
}

/** 授权完成后自动续上原来那次下载（§9.4：从点下载到开始下载只多一点「选择文件夹」） */
async function maybeResumePendingIntent(): Promise<void> {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.pendingIntent);
  const intent = stored[STORAGE_KEYS.pendingIntent] as
    | { jobSubmit: JobSubmit; tabId?: number; createdAt: number }
    | undefined;
  if (!intent) return;

  // 5 分钟过期：隔太久再授权不该突然开始下载（§9.4）
  if (Date.now() - intent.createdAt > 5 * 60 * 1000) {
    await clearPendingIntent();
    return;
  }

  const dir = await safeFsStatus();
  if (dir.status !== 'ready') return;

  await clearPendingIntent();
  await enqueueNow(intent.jobSubmit, intent.tabId ?? intent.jobSubmit.tabId);
}

async function clearPendingIntent(): Promise<void> {
  await chrome.storage.session.remove(STORAGE_KEYS.pendingIntent);
}

/* ---------- 崩溃恢复（§6.4） ---------- */

/**
 * SW 被回收后重启：从 session 读回镜像，用 getContexts 检查 Offscreen 还在不在。
 * 不在的话把 running 的任务标成 interrupted，UI 显示「下载中断 · 继续」。
 */
async function recoverAfterRestart(): Promise<void> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    });
    if (contexts.length > 0) return; // 引擎还活着，任务在它那里继续跑，不用管

    const stored = await chrome.storage.session.get(STORAGE_KEYS.jobMirror);
    const mirror = (stored[STORAGE_KEYS.jobMirror] as Record<string, { status: string }>) ?? {};
    let changed = false;
    for (const job of Object.values(mirror)) {
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'interrupted';
        changed = true;
      }
    }
    if (changed) {
      await chrome.storage.session.set({ [STORAGE_KEYS.jobMirror]: mirror });
      log.info('marked interrupted jobs after restart');
    }
  } catch (e) {
    log.debug('recoverAfterRestart', e);
  }
}

/* ---------- Tab 状态（popup 和面板共用，§10.8） ---------- */

async function getTabState(tabId: number): Promise<TabState> {
  const dir = await safeFsStatus();
  try {
    const res = (await chrome.tabs.sendMessage(tabId, {
      type: 'ecbox:getTabState',
    })) as Partial<TabState>;
    return { ...(res as TabState), tabId, dir };
  } catch {
    return {
      tabId,
      url: '',
      matched: false,
      status: 'idle',
      dir,
    };
  }
}