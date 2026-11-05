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
import { STORAGE_KEYS } from '../kernel/storage/keys';
import type { DirState } from '../kernel/fs/types';
import type { JobSubmit, TabState } from '../kernel/messaging/protocol';
import { guardSender, onMessage, sendMessage } from '../kernel/messaging/runtime';
import { createPortServer } from '../kernel/messaging/port';
import { createLogger } from '../kernel/log/logger';

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

  onMessage('engine.event', async ({ data }) => {
    await handleEngineEvent(data);
  });

  onMessage('engine.ready', async () => {
    log.info('offscreen reported ready');
  });

  onMessage('grant.getInit', async () => readGrantInit());
  onMessage('grant.persist', async ({ data }) => {
    await persistHandle(data.handle);
  });
  onMessage('grant.getHandle', async () => loadHandle());
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

  // ---------- SW 重启后的崩溃恢复（§6.4、ADR-5） ----------
  void recoverAfterRestart();

  log.info('background ready');
});

/* ============================ 实现 ============================ */

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

async function safeFsStatus(): Promise<DirState> {
  try {
    return await engineCall<DirState>('engine.fsStatus', undefined);
  } catch {
    return { status: 'unset' };
  }
}

async function submitJob(p: JobSubmit, senderTabId?: number): Promise<{ jobId: string } | { waiting: 'dir' }> {
  const dir = await safeFsStatus();

  // 没有目录：把意图存起来，开小窗，授权完成后自动续上（§9.4 下载意图续接）
  if (dir.status !== 'ready') {
    await chrome.storage.session.set({
      [STORAGE_KEYS.pendingIntent]: {
        jobSubmit: p,
        tabId: p.tabId ?? senderTabId,
        createdAt: Date.now(),
      },
    });
    await openGrantWindow(dir.status, p.tabId ?? senderTabId);
    return { waiting: 'dir' };
  }

  await ensureOffscreen();
  await engineCall('engine.enqueue', { job: buildJobRecord(p), payload: p.payload });
  return { jobId: buildJobId(p) };
}

function buildJobId(p: JobSubmit): string {
  return p.dedupeKey + ':' + Date.now().toString(36);
}

function buildJobRecord(p: JobSubmit) {
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
    ...(p.tabId !== undefined ? { tabId: p.tabId } : {}),
    ...(p.label !== undefined ? { label: p.label } : {}),
  };
}

/** offscreen → bg 的事件：更新镜像，再推给对应 Tab（§4.3 第 7、8 步） */
async function handleEngineEvent(ev: unknown): Promise<void> {
  const e = ev as { type: string; job?: { id: string; tabId?: number } };
  if (!e.job) return;
  await updateMirror(e.job as never);
  if (typeof e.job.tabId === 'number') {
    if (e.type === 'progress') ports.send(e.job.tabId, { type: 'job-progress', job: e.job as never });
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
  const mirror = (stored[STORAGE_KEYS.jobMirror] as Record<string, import('../kernel/jobs/types').JobRecord>) ?? {};
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
  const left = win?.left !== undefined && win.width !== undefined ? Math.round(win.left + (win.width - width) / 2) : undefined;
  const top = win?.top !== undefined && win.height !== undefined ? Math.round(win.top + (win.height - height) / 2) : undefined;

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

async function persistHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await engineCall('engine.call', {
    feature: 'core',
    method: 'persistHandle',
    args: { handle },
  });
}

async function loadHandle(): Promise<FileSystemDirectoryHandle | null> {
  return (await engineCall('engine.call', {
    feature: 'core',
    method: 'loadHandle',
    args: {},
  })) as FileSystemDirectoryHandle | null;
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
  await ensureOffscreen();
  await engineCall('engine.enqueue', {
    job: buildJobRecord(intent.jobSubmit),
    payload: intent.jobSubmit.payload,
  });
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
    const res = (await chrome.tabs.sendMessage(tabId, { type: 'ecbox:getTabState' })) as Partial<TabState>;
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