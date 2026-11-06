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
import type { JobRecord } from '../kernel/jobs/types';
import { dumpDiagnostics } from '../kernel/log/diagnostics';
import { createLogger, logBuffer } from '../kernel/log/logger';
import { createPortServer } from '../kernel/messaging/port';
import type { JobSubmit, PortMessage, SubmitResult, TabState } from '../kernel/messaging/protocol';
import {
  classifySender,
  guardedHandler,
  guardedVoidHandler,
  guardSender,
  onMessage,
  sendMessage,
  validateJobList,
} from '../kernel/messaging/runtime';
import { getSettings, readSettings, watchSettings } from '../kernel/settings/store';
import { STORAGE_KEYS } from '../kernel/storage/keys';

const log = createLogger('bg');
const ports = createPortServer();

/**
 * 只接受 offscreen 文档发来的消息。
 *
 * 用 classifySender 而不是手写 `sender.url.endsWith('offscreen.html')`：
 * 手写判断在 URL 带查询串或 hash 时会失效（扩展页面被 `?x=1` 打开过一次就会发生），
 * 那样 offscreen 的进度事件会被当成伪造事件全部拒掉，面板永远不动。
 */
function assertOffscreen(sender: chrome.runtime.MessageSender, method: string): void {
  if (classifySender(sender) === 'offscreen') return;
  log.warn('拒绝非 offscreen 的调用', { method, url: sender.url ?? '' });
  throw new Error(`forbidden: ${method}`);
}

export default defineBackground(() => {
  log.info('background booting');

  // ---------- 1. 消息路由（来源鉴别 + payload 校验统一走 guardedHandler） ----------
  onMessage(
    'shell.getTabState',
    guardedHandler<{ tabId: number }, TabState>('shell.getTabState', (data) =>
      getTabState(data.tabId),
    ),
  );

  onMessage(
    'fs.status',
    guardedVoidHandler<DirState>('fs.status', () =>
      engineCall<DirState>('engine.fsStatus', undefined),
    ),
  );

  onMessage(
    'fs.openGrant',
    guardedHandler<{ reason: GrantMode; tabId?: number }, void>(
      'fs.openGrant',
      async (data, sender) => {
        await openGrantWindow(data.reason, data.tabId ?? sender.tab?.id);
      },
    ),
  );

  onMessage(
    'fs.changed',
    guardedHandler<DirState, void>('fs.changed', async (data) => {
      // grant 小窗完成授权：先让 offscreen 刷新句柄状态，再广播给所有页面
      const state = await engineCall<DirState>('engine.fsChanged', undefined).catch(() => data);
      ports.broadcast({ type: 'dir-changed', dir: state });
      await maybeResumePendingIntent();
    }),
  );

  onMessage(
    'job.submit',
    guardedHandler<JobSubmit, SubmitResult>('job.submit', (data, sender) =>
      submitJob(data, sender.tab?.id),
    ),
  );

  onMessage(
    'job.cancel',
    guardedHandler<{ jobId: string }, void>('job.cancel', (data) =>
      engineCall('engine.cancel', { jobId: data.jobId }).then(() => undefined),
    ),
  );

  /**
   * 任务列表：payload 可选（无参 = 全部任务）。用 validateJobList 补上可选的 tabId 校验，
   * 同时保持「不带参数也合法」的语义。
   */
  onMessage('job.list', async ({ data, sender }) => {
    const check = guardSender('job.list', sender);
    if (!check.ok) throw new Error(check.reason ?? 'forbidden');
    return listJobs(validateJobList(data).tabId);
  });

  /**
   * 只重跑失败项（§10.4「重试」）。旧实现根本没注册这个 handler，
   * 面板上点「重试 N 个失败项」只会得到一句 "Could not establish connection"。
   */
  onMessage(
    'job.retry',
    guardedHandler<{ jobId: string; only: 'failed' }, { jobId: string }>('job.retry', (data) =>
      retryJob(data.jobId, data.only),
    ),
  );

  onMessage(
    'feature.call',
    guardedHandler<{ feature: string; method: string; args: unknown }, unknown>(
      'feature.call',
      (data) =>
        engineCall('engine.call', {
          feature: data.feature,
          method: data.method,
          args: data.args,
        }),
    ),
  );

  onMessage(
    'shell.togglePanel',
    guardedHandler<{ tabId: number }, void>('shell.togglePanel', (data) => {
      ports.send(data.tabId, { type: 'panel-toggle' });
    }),
  );

  onMessage('shell.openOptions', async () => {
    await chrome.runtime.openOptionsPage();
  });

  /** 工具栏 popup 和面板共用同一份状态（§10.8）：后台只是转发目标标签页的应答 */
  onMessage(
    'shell.pushTabState',
    guardedHandler<TabState, void>('shell.pushTabState', (data) => {
      ports.broadcast({ type: 'dir-changed', dir: data.dir });
    }),
  );

  /**
   * 「以手机模式重新打开」（§7.6.5）。Phase 0 已证否：两个平台改 UA 都拿不到商品数据
   * （docs/phase0/FINDINGS.md 第 1 节），所以这里只把标签页切到前台，不再假装能用。
   */
  onMessage(
    'shell.mobileMode',
    guardedHandler<{ tabId: number }, void>('shell.mobileMode', async (data) => {
      await chrome.tabs.update(data.tabId, { active: true });
    }),
  );

  /** 导出诊断包（§6.7）：面板「导出诊断」按钮走这里 */
  onMessage(
    'shell.diagnostics',
    guardedVoidHandler<{ json: string }>('shell.diagnostics', () => buildDiagnosticsPackage()),
  );

  onMessage('engine.event', async ({ data, sender }) => {
    // 只认 offscreen 的事件（内容脚本能调到 runtime.sendMessage，不能让它伪造任务进度）
    assertOffscreen(sender, 'engine.event');
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
    assertOffscreen(sender, 'engine.download');
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
    if (item?.state === 'interrupted') {
      // 不能把半截文件当成成功：引擎会按 WRITE_FAILED 计入失败项，下次重下。
      throw new Error(`download interrupted: ${item.error ?? 'unknown'}`);
    }
    return {
      filename: item?.filename ?? data.filename,
      size: item?.fileSize ?? item?.totalBytes ?? fallbackSize,
    };
  });

  /** offscreen 转发的引擎日志，进 bg 的日志缓冲（诊断包的数据源，§6.7） */
  onMessage('engine.log', async ({ data, sender }) => {
    assertOffscreen(sender, 'engine.log');
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
    assertOffscreen(sender, 'engine.settings');
    return getSettings();
  });

  onMessage('grant.getInit', async () => readGrantInit());
  onMessage(
    'grant.persisted',
    guardedHandler<{ name: string }, void>('grant.persisted', async (data) => {
      // 句柄已经由授权小窗自己存进 IndexedDB（它和 bg/offscreen 同源共享），
      // 这里只需要让 offscreen 丢掉缓存的旧句柄并重判状态。
      log.info('root handle persisted', { name: data.name });
      const state = await engineCall<DirState>('engine.fsChanged', undefined).catch(() => ({
        status: 'ready' as const,
        name: data.name,
      }));
      ports.broadcast({ type: 'dir-changed', dir: state });
      await maybeResumePendingIntent();
    }),
  );
  onMessage(
    'grant.close',
    guardedVoidHandler<void>('grant.close', () => clearPendingIntent()),
  );

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
 * 并发建 offscreen 的栅栏。
 *
 * 面板点一次下载会同时触发 fs.status + job.submit 两条消息，两个 handler 都会调
 * ensureOffscreen()。getContexts 是异步的，两个请求都能读到「还没有 offscreen」，
 * 随后第二个 createDocument 必然抛「Only a single offscreen document may be created」。
 * 之前这里只 catch 掉写日志，于是**第一条消息的引擎调用仍然发给了尚不存在的文档**，
 * 表现就是「点了下载没反应」。所以创建过程要串行化，失败时再确认一次，
 * 但**不能静默吞掉** —— 创建失败必须让调用方感知（否则又变回「没反应」）。
 */
let offscreenCreating: Promise<void> | null = null;

/**
 * Offscreen 是任务真相源，没它就什么也做不了（ADR-5）。
 * 用 chrome.runtime.getContexts 判断它在不在，而不是靠全局变量 —— SW 重启后全局变量会丢。
 */
async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  offscreenCreating ??= createOffscreen().finally(() => {
    offscreenCreating = null;
  });
  await offscreenCreating;
}

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  return contexts.length > 0;
}

async function createOffscreen(): Promise<void> {
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['BLOBS' as chrome.offscreen.Reason],
      justification: '下载并写入商品素材文件',
    });
  } catch (e) {
    // 两个上下文同时创建时后到的那个会失败；只要文档最终存在就算成功
    if (await hasOffscreen().catch(() => false)) return;
    log.warn('创建 offscreen 失败', { error: String(e) });
    throw e;
  }
}

/** 下载完成的等待上限：10 分钟（几百 MB 的视频也够） */
const DOWNLOAD_WAIT_MAX_MS = 10 * 60 * 1000;

/**
 * 等一个下载任务结束。
 *
 * 用 chrome.downloads.onChanged 事件而不是固定次数轮询：旧实现 120 × 100ms = 12 秒就放弃，
 * 一个 500MB 的视频必然还没下完就会被当成「落盘失败」，随后引擎按失败重试，
 * 用户看到的是「大视频永远失败」。事件驱动 + 兜底超时才是对的做法。
 */
function waitForDownload(id: number): Promise<chrome.downloads.DownloadItem | undefined> {
  const lookup = async (): Promise<chrome.downloads.DownloadItem | undefined> => {
    const [item] = await chrome.downloads.search({ id });
    return item;
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (item: chrome.downloads.DownloadItem | undefined): void => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve(item);
    };

    const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== id || delta.state?.current === undefined) return;
      if (delta.state.current === 'in_progress') return;
      void lookup().then(finish, () => finish(undefined));
    };

    // 'interrupted' 不是成功：文件可能只写了一半（磁盘满、用户取消、网络断）。
    // 旧实现把 interrupted 当成「下完了」，把半截文件的大小记进增量记录，
    // 下次下载会认为这个文件已存在并跳过 —— 用户永远拿到一个坏文件。

    const timer = setTimeout(() => {
      void lookup().then(finish, () => finish(undefined));
    }, DOWNLOAD_WAIT_MAX_MS);

    chrome.downloads.onChanged.addListener(onChanged);
    // 事件注册前可能已经结束（小文件），补一次查询
    void lookup().then(
      (item) => {
        if (item !== undefined && item.state !== 'in_progress') finish(item);
      },
      () => {
        /* 查询失败就等事件或超时 */
      },
    );
  });
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
  const e = ev as { type: string; job?: JobRecord };
  if (!e.job) return;
  void updateMirror(e.job);
  if (typeof e.job.tabId !== 'number') return;
  const msg: PortMessage =
    e.type === 'progress' ? { type: 'job-progress', job: e.job } : { type: 'job-done', job: e.job };
  ports.send(e.job.tabId, msg);
}

/** 同一时刻只允许一次镜像写入在跑，避免每条进度都排队打 storage.session（10 次/秒 × N 个任务） */
let mirrorWriting: Promise<void> | null = null;
let mirrorDirty = false;

/**
 * 镜像里的任务**不带 payload**。
 *
 * payload 是整份 ProductSnapshot（标题、几十个素材地址、SKU 列表），而进度事件每 200ms
 * 一条、每条都会写一次 storage.session；把快照一起写进去等于每秒往扩展存储里灌几十 KB，
 * 而且没有任何读者需要它（重试走的是 offscreen 里 runner 自己保留的 record）。
 */
function withoutPayload(job: JobRecord): JobRecord {
  return { ...job, payload: null };
}

function updateMirror(job: JobRecord): Promise<void> {
  pendingMirror.set(job.id, withoutPayload(job));
  mirrorDirty = true;
  if (mirrorWriting !== null) return mirrorWriting;
  mirrorWriting = (async () => {
    try {
      while (mirrorDirty) {
        mirrorDirty = false;
        const stored = await chrome.storage.session.get(STORAGE_KEYS.jobMirror);
        const mirror = (stored[STORAGE_KEYS.jobMirror] as Record<string, JobRecord>) ?? {};
        for (const [id, record] of pendingMirror) mirror[id] = record;
        pendingMirror.clear();
        await chrome.storage.session.set({ [STORAGE_KEYS.jobMirror]: mirror });
      }
    } catch (e) {
      log.debug('写任务镜像失败', e);
    } finally {
      mirrorWriting = null;
    }
  })();
  return mirrorWriting;
}

/** 还没落进镜像的任务（进度事件按 200ms 一条推，没必要每条都写一次 storage.session） */
const pendingMirror = new Map<string, JobRecord>();

async function listJobs(tabId?: number): Promise<JobRecord[]> {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.jobMirror);
  const mirror = (stored[STORAGE_KEYS.jobMirror] as Record<string, JobRecord>) ?? {};
  // 内存里还没落盘的那几条也要算上，否则面板刚提交就查列表会看不到自己的任务
  for (const [id, record] of pendingMirror) mirror[id] = record;
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
    if (await hasOffscreen()) return; // 引擎还活着，任务在它那里继续跑，不用管

    const stored = await chrome.storage.session.get(STORAGE_KEYS.jobMirror);
    const mirror = (stored[STORAGE_KEYS.jobMirror] as Record<string, JobRecord>) ?? {};
    // 不改原对象：镜像里的对象可能正被其它地方引用（session 存储反序列化后的副本改了也不会写回）
    const next: Record<string, JobRecord> = {};
    let changed = false;
    const now = Date.now();
    for (const [id, job] of Object.entries(mirror)) {
      if (job.status === 'running' || job.status === 'queued') {
        next[id] = { ...job, status: 'interrupted', endedAt: now };
        changed = true;
      } else {
        next[id] = job;
      }
    }
    if (changed) {
      await chrome.storage.session.set({ [STORAGE_KEYS.jobMirror]: next });
      // 中断是用户可见的状态变化：面板在 SW 重启后不重建的话会一直卡在「下载中」，
      // 所以顺便广播一次目录状态，让所有页面的 Port 有机会刷新。
      ports.broadcast({ type: 'dir-changed', dir: await safeFsStatus() });
      log.info('marked interrupted jobs after restart');
    }
  } catch (e) {
    log.debug('recoverAfterRestart', e);
  }
}

/* ---------- Tab 状态（popup 和面板共用，§10.8） ---------- */

/**
 * 目标标签页的状态。
 *
 * 页面侧返回的是 Partial<TabState>（它不填 url / tabId / dir），所以不能直接把结果
 * 当成完整对象往外传：popup 拿到的 url 会是 undefined，而 TabState.url 在协议里是必填的。
 * 这里显式补全缺省字段，并且**串行化**对同一个 tab 的探测 —— popup 打开时会 400ms 轮询一次，
 * 并发探测同一个页面时 chrome.tabs.sendMessage 会互相打断。
 */
const tabStateInflight = new Map<number, Promise<TabState>>();

function getTabState(tabId: number): Promise<TabState> {
  const running = tabStateInflight.get(tabId);
  if (running) return running;
  const task = probeTabState(tabId).finally(() => {
    tabStateInflight.delete(tabId);
  });
  tabStateInflight.set(tabId, task);
  return task;
}

async function probeTabState(tabId: number): Promise<TabState> {
  const dir = await safeFsStatus();
  const fallback: TabState = { tabId, url: '', matched: false, status: 'idle', dir };
  try {
    const res = (await chrome.tabs.sendMessage(tabId, {
      type: 'ecbox:getTabState',
    })) as Partial<TabState> | undefined;
    if (!res || typeof res !== 'object') return fallback;
    return { ...fallback, ...res, tabId, dir };
  } catch {
    return fallback;
  }
}
