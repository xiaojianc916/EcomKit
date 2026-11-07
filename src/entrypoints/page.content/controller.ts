/**
 * PageController（方案 §7.2 的状态机）——内容脚本侧的总装。
 *
 * 职责：
 *   1. URL 变化 → findPageKind → detecting；没命中 → idle 并卸载 UI
 *   2. 阻断检测（登录墙 / App 限制 / 已下架）
 *   3. 并行跑各数据源，渐进合并成 ProductSnapshot
 *   4. Port 连接、任务认领、目录状态
 *   5. 给 Shell 提供 props，并作为 React 的外部 store（subscribe / getVersion）
 *
 * 状态 → UI 的约定：所有页面状态都是这里的闭包变量，**改完必须 notify()**；
 * index.tsx 用 useSyncExternalStore 订阅 version，每次 notify 都会用最新状态
 * 重新算一遍 shellProps。旧实现只在挂载时 render 一次，props 永远停在 detecting。
 *
 * **按商品 ID 隔离**是这里最容易出错的地方：SPA 切换商品时旧会话的 draft 一律丢弃。
 */
import { createElement } from 'react';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { featuresForPlatform, pageFeatures } from '../../features/registry.page';
import type { PageApi, QuickAction, RegisteredFeature } from '../../features/types';
import type { ErrorCode } from '../../kernel/errors/codes';
import { EcError } from '../../kernel/errors/ec-error';
import type { DirState } from '../../kernel/fs/types';
import type { JobRecord } from '../../kernel/jobs/types';
import { createLogger } from '../../kernel/log/logger';
import { connectJobPort } from '../../kernel/messaging/port';
import type { PortMessage, TabState } from '../../kernel/messaging/protocol';
import { sendMessage } from '../../kernel/messaging/runtime';
import type { ProductDraft, ProductSnapshot } from '../../kernel/model/product';
import {
  patchUiPrefs,
  readSettings,
  readUiPrefs,
  watchSettings,
} from '../../kernel/settings/store';
import { findPageKind, PLATFORM_MANIFESTS } from '../../platforms/registry';
import { getPlatformResolver } from '../../platforms/registry.resolver';
import type { DraftAccumulator } from '../../platforms/shared/merge';
import type { CapturedPayload, PlatformManifest } from '../../platforms/types';
import type { ShellProps } from '../../shell/Shell';
import { PanelSettingsView } from '../../shell/settings/PanelSettingsView';
import type { PrefsPort, ShellUiSettings } from '../../shell/store';
import {
  createShellStore,
  HANDLE_DONE_TTL_MS,
  type ShellStore,
  siteKeyOf,
} from '../../shell/store';
import { createPageBridge, type PageBridge } from './bridge-client';
import { FeatureSlot } from './FeatureSlot';
import { resolveSnapshot } from './resolver-runner';

const log = createLogger('page.controller');

/** SPA 路由防抖（§7.2：切换商品时会有多次 pushState） */
const ROUTE_DEBOUNCE_MS = 300;
/** 识别总超时：8 秒还没拿全就按 partial（§7.2 状态机） */
const PARTIAL_TIMEOUT_MS = 8000;
/**
 * 渐进快照的最小间隔。
 *
 * 每产出一份 draft 都要把整个累积结果跑一遍 ProductSnapshot.safeParse（Zod），
 * 而详情图动辄上百张、抓包源会连续产出几十份 draft —— 不节流的话识别期间主线程
 * 会被 Zod 解析占满，页面滚动都卡。UI 上 120ms 一次的渐进更新肉眼完全够用。
 */
const PARTIAL_MIN_INTERVAL_MS = 120;

export interface PageController {
  start(): void;
  dispose(): void;
  onMatched(cb: () => void): void;
  onUnmatched(cb: () => void): void;
  shellProps(api: PageApi): ShellProps;
  current(): { platform: string; pageKind: string; productId: string } | null;
  snapshot(): ProductSnapshot | null;
  refreshDir(): Promise<DirState>;
  /** 当前目录状态（外壳查过一次后缓存的） */
  dirState(): DirState;
  /** 页面侧已就绪的抓包数据源，给 resolver 用 */
  captures(ruleId: string): AsyncIterable<CapturedPayload>;
  /** React 外部 store 协议：状态变化时回调 */
  subscribe(listener: () => void): () => void;
  /** 每次 notify 自增，useSyncExternalStore 的 getSnapshot */
  getVersion(): number;
  /**
   * 处理来自 bg / popup / 快捷键的命令（§10.5）。
   *
   * 旧实现里 bg 会发 `ecbox:command`，但内容脚本从来没监听 —— 于是 Alt+Shift+D
   * 和 popup 里的「下载」按钮全都是死键：按下去什么都不发生，也没有任何提示。
   */
  handleCommand(command: string, api: PageApi): Promise<void>;
}

export function createPageController(ctx: ContentScriptContext): PageController {
  let matchedCb: (() => void) | null = null;
  let unmatchedCb: (() => void) | null = null;

  let match: { platform: string; pageKind: string; productId: string } | null = null;
  let manifest: PlatformManifest | null = null;
  let snapshot: ProductSnapshot | null = null;
  let blocker: ErrorCode | null = null;
  let status: ShellProps['status'] = 'idle';
  let completeness: 'full' | 'partial' = 'full';
  let dir: DirState = { status: 'unset' };
  let job: JobRecord | null = null;
  let abort: AbortController | null = null;
  let routeTimer: ReturnType<typeof setTimeout> | null = null;
  let bridge: PageBridge | null = null;
  let disconnectPort: (() => void) | null = null;
  let store: ShellStore | null = null;
  /** 影响外壳渲染的设置项；side 变更时同步进 store，面板当场换边 */
  let uiSettings: ShellUiSettings = {
    autoOpen: 'panel',
    theme: 'system',
    side: 'right',
  };
  /** 本商品是否已经按 §10.5 决定过形态：只决定一次，之后尊重用户手动收起/展开 */
  let formDecided = false;
  let version = 0;
  const listeners = new Set<() => void>();
  /** 上次算渐进快照的时间（节流用） */
  let lastPartialAt = 0;
  /**
   * 下发给外壳的 `now` 缓存。
   *
   * ShellProps.now 只有一个消费者：把手角标判断「完成态对勾还剩多久」（3 秒窗口）。
   * 其余时间它是一个恒定的值就行 —— 每次 notify 都塞一个新的 Date.now() 会让
   * 所有依赖 now 的 memo 全部失效（进度 200ms 一条）。
   */
  let shellNow = Date.now();
  /** 按平台缓存的「功能列表 / 清单」，避免每次 notify 都重建数组（§10.9 高频路径） */
  let cachedFeaturesFor: string | null = null;
  let cachedFeatures: RegisteredFeature[] = pageFeatures;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;
  let uiPrefs: Record<string, 'hidden' | 'handle' | 'panel'> = {};
  let handleYPrefs: Record<string, number> = {};

  /**
   * 站点偏好的读写端口（§10.2「按站点记住」）。
   *
   * **必须落盘**：旧实现只写了内存对象，页面一刷新「把手位置、要不要展开、上次勾了哪几类」
   * 全部回到默认值 —— 用户感觉工具箱「记不住东西」。
   * 写入做 300ms 防抖，拖动把手时不会每移动一像素就写一次 storage。
   */
  const prefs: PrefsPort = {
    get<T>(key: string): T | undefined {
      const form = uiPrefs[key];
      const handleY = handleYPrefs[key];
      if (form === undefined && handleY === undefined) return undefined;
      return { form, handleY } as T;
    },
    set<T>(key: string, value: T): void {
      const v = value as { form?: 'hidden' | 'handle' | 'panel'; handleY?: number };
      if (v.form) uiPrefs = { ...uiPrefs, [key]: v.form };
      if (typeof v.handleY === 'number') handleYPrefs = { ...handleYPrefs, [key]: v.handleY };
      schedulePrefsFlush();
    },
  };

  let prefsFlushTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePrefsFlush(): void {
    if (prefsFlushTimer !== null) return;
    prefsFlushTimer = setTimeout(() => {
      prefsFlushTimer = null;
      void patchUiPrefs({
        formByPlatform: { ...uiPrefs },
        handleYByPlatform: { ...handleYPrefs },
      }).catch(() => {});
    }, 300);
  }

  /** 启动时读回站点偏好；读失败就用默认值，不影响识别 */
  async function loadPrefs(): Promise<void> {
    try {
      const saved = await readUiPrefs();
      uiPrefs = { ...(saved.formByPlatform as typeof uiPrefs | undefined) };
      handleYPrefs = {
        ...(saved.handleYByPlatform as typeof handleYPrefs | undefined),
      };
    } catch {
      // 读不到就用默认
    }
  }

  /**
   * 整页只有**一个** shell store。旧实现在 start() 读完设置后又 new 了一个替换掉，
   * 而 Shell 早已拿着第一个 —— 之后的设置、形态变化都作用在 UI 看不到的那个上。
   * 设置改为写进同一个 store（theme）或在 syncForm 时显式传入（autoOpen）。
   */
  function ensureStore(): ShellStore {
    if (store) return store;
    store = createShellStore({
      prefs,
      siteKey: siteKeyOf(location.hostname),
      settings: uiSettings,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    // 识别出结果之前不显示任何东西（用户要求：识别成功才出现）
    store.getState().setForm('hidden', { persist: false });
    return store;
  }

  /**
   * 设置变了就同步进 store。
   *
   * theme 和 side 都是「改了立刻能看见」的项：设置视图本身就在面板里，
   * 用户选「靠左」时如果等下一次 syncForm 才换边，会变成「选完没反应」。
   * autoOpen 不用写进 store —— 它只在 syncForm 时参与形态决策。
   */
  function applySettings(next: ShellUiSettings): void {
    uiSettings = next;
    ensureStore().setState({ theme: next.theme, side: next.side });
  }

  /** 状态变了就通知 React（index.tsx 的 useSyncExternalStore） */
  function notify(): void {
    version += 1;
    for (const l of [...listeners]) {
      try {
        l();
      } catch (e) {
        log.warn('listener threw', e);
      }
    }
  }

  /**
   * 识别有结论时按 §10.5 决定形态（每个商品只决定一次）：
   *   - 识别成功 → 按设置 autoOpen（默认展开面板；窄视口 / 站点偏好 → 把手）
   *   - 登录墙 / 下架 / APP 限制 → 展开面板说明原因
   *   - 什么都没识别到（PARSE_EMPTY）→ 保持隐藏，只在 popup 里能看到原因
   */
  function decideForm(): void {
    if (formDecided) return;
    const s = ensureStore().getState();
    if (status === 'ready') {
      formDecided = true;
      s.syncForm({ blocked: false, autoOpen: uiSettings.autoOpen });
    } else if (status === 'blocked' && blocker !== null && blocker !== 'PARSE_EMPTY') {
      formDecided = true;
      s.syncForm({ blocked: true, autoOpen: uiSettings.autoOpen });
    }
  }

  async function evaluate(): Promise<void> {
    const url = new URL(location.href);
    const hit = findPageKind(url);

    if (!hit) {
      if (match) {
        match = null;
        manifest = null;
        snapshot = null;
        blocker = null;
        status = 'idle';
        abort?.abort();
        abort = null;
        bridge?.dispose();
        bridge = null;
        formDecided = false;
        ensureStore().getState().setForm('hidden', { persist: false });
        notify();
        unmatchedCb?.();
      }
      return;
    }

    const sameProduct =
      match !== null && match.productId === hit.productId && match.pageKind === hit.kind;
    if (sameProduct) return;

    // 换商品：上一条任务的进度/失败属于上一个商品，必须先清掉，
    // 否则面板会带着旧商品的「下载中 10/24」进入新页面（§7.2 第 1 点）。
    job = null;

    // 新商品：丢弃上一轮会话（§7.2 第 1 点）
    abort?.abort();
    bridge?.dispose();
    abort = new AbortController();
    match = { platform: hit.platform.id, pageKind: hit.kind, productId: hit.productId };
    manifest = hit.platform;
    snapshot = null;
    blocker = null;
    completeness = 'full';
    status = 'detecting';
    formDecided = false;
    ensureStore().getState().setForm('hidden', { persist: false });
    notify();
    matchedCb?.();

    const resolver = getPlatformResolver(hit.platform.id);
    if (!resolver) {
      blocker = 'PARSE_EMPTY';
      status = 'blocked';
      decideForm();
      notify();
      return;
    }

    // 阻断优先：登录墙 / App 限制 / 已下架
    const blockerCode = resolver.detectBlocker(document, url);
    if (blockerCode) {
      blocker = blockerCode;
      status = 'blocked';
      decideForm();
      notify();
      log.info('blocked', { code: blockerCode });
      return;
    }

    status = 'resolving';
    notify();

    // 桥：读 MAIN 交来的前缀、下发 hello（MAIN 回放 document_start 以来的抓包）
    bridge = null;
    try {
      bridge = createPageBridge(hit.platform, hit.kind);
    } catch (e) {
      log.debug('bridge unavailable', e);
    }
    const sessionBridge = bridge;

    const localAbort = abort;
    try {
      const result = await resolveSnapshot({
        url,
        productId: hit.productId,
        pageKind: hit.kind,
        platformId: hit.platform.id,
        platformName: hit.platform.displayName,
        resolver,
        document,
        signal: localAbort.signal,
        partialTimeoutMs: PARTIAL_TIMEOUT_MS,
        onProgress: (_draft: ProductDraft, acc: DraftAccumulator) => {
          if (localAbort.signal.aborted) return;
          // 节流：抓包源会连着吐几十份 draft，每份都跑一次整包 Zod 解析会占满主线程。
          // 首次（还没快照）不节流，保证「识别成功」这一刻尽快出现。
          const nowAt = Date.now();
          if (snapshot !== null && nowAt - lastPartialAt < PARTIAL_MIN_INTERVAL_MS) return;
          lastPartialAt = nowAt;
          const partial = acc.toSnapshot({
            platform: hit.platform.id,
            pageKind: hit.kind,
            productId: hit.productId,
            capturedAt: nowAt,
            fallbackTitle: document.title,
            fallbackUrl: url.toString(),
          });
          if (partial) {
            snapshot = partial;
            status = 'ready';
            decideForm();
            notify();
          }
        },
        ...(sessionBridge ? { readGlobal: (p: string) => sessionBridge.readGlobal(p) } : {}),
        captures: (ruleId: string, signal: AbortSignal) =>
          sessionBridge ? sessionBridge.captures(ruleId, signal) : emptyCaptures(),
      });

      if (localAbort.signal.aborted) return;
      snapshot = result.snapshot;
      completeness = result.completeness;
      if (result.snapshot) {
        status = 'ready';
      } else {
        status = 'blocked';
        blocker = 'PARSE_EMPTY';
      }
      decideForm();
      notify();
      const summary = {
        productId: hit.productId,
        assets: result.snapshot?.assets.length ?? 0,
        completeness,
        sources: result.sources,
      };
      if (result.snapshot) log.info('resolve done', summary);
      else
        log.warn(
          'resolve done：没有拿到任何素材（PARSE_EMPTY），上面的 SSR / DOM 日志是各数据源的结果',
          summary,
        );
    } catch (e) {
      if (localAbort.signal.aborted) return;
      const code = EcError.from(e).code;
      blocker = code;
      status = 'blocked';
      decideForm();
      notify();
      log.warn('resolve failed', { code });
    }
  }

  async function refreshDir(): Promise<DirState> {
    try {
      dir = await sendMessage('fs.status');
    } catch {
      dir = { status: 'unset' };
    }
    notify();
    return dir;
  }

  /**
   * 命令分发。页面知道当前快照，所以下载类命令只能在这里落地：
   * `download-checked` = 下载全部勾选的类别，`download-main` / `-sku` / `-detail` / `-video` = 只下这一类。
   *
   * 命令没有对应动作时必须给出**可见反馈**（Toast），否则用户按了快捷键毫无反应，
   * 会以为扩展坏了。
   */
  async function handleCommand(command: string, api: PageApi): Promise<void> {
    if (!match || !snapshot) {
      api.toast('这个页面还没有识别出商品，先等识别完成');
      return;
    }
    const actions = await loadQuickActions(snapshot);
    const kind = command.startsWith('download-') ? command.slice('download-'.length) : command;
    // download-kinds:main,detail —— popup 上用户勾了哪几类就只下哪几类
    if (kind.startsWith('kinds:')) {
      const kinds = kind
        .slice('kinds:'.length)
        .split(',')
        .filter((k) => k !== '');
      if (kinds.length === 0) {
        api.toast('没有勾选任何素材');
        return;
      }
      const hits = kinds
        .map((k) => actions.find((a) => a.id === `media-download.${k}`))
        .filter((a): a is QuickAction => a !== undefined);
      if (hits.length === 0) {
        api.toast('没有可下载的素材');
        return;
      }
      for (const action of hits) action.run(api);
      return;
    }
    const byKind = actions.find((a) => a.id === `media-download.${kind}`);
    const all = actions.find((a) => a.id === 'media-download.all');
    const hit = kind === 'checked' || kind === 'all' ? all : byKind;
    if (!hit) {
      log.info('command ignored: no action', { command });
      api.toast('没有可下载的素材');
      return;
    }
    hit.run(api);
  }

  /**
   * 导出诊断包（§6.7）。面板上所有「导出诊断」按钮都走这里。
   *
   * 旧实现里按钮点了什么都不发生 —— onBlockerAction 根本没有 diagnostics 分支。
   * 现在把 bg 组装的 JSON 存成本地文件，用户可以直接回传。
   */
  async function exportDiagnostics(): Promise<void> {
    try {
      const res = (await sendMessage('shell.diagnostics')) as { json: string } | undefined;
      if (!res?.json) return;
      const blob = new Blob([res.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `ecbox-diagnostics-${stamp}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      log.warn('导出诊断失败', e);
    }
  }

  /** 懒加载功能页模块，取它的 quickActions */
  async function loadQuickActions(snap: ProductSnapshot): Promise<QuickAction[]> {
    const feature = pageFeatures.find((f) => f.manifest.id === 'media-download');
    if (!feature?.page) return [];
    try {
      const mod = await feature.page.load();
      return mod.default.quickActions?.(snap) ?? [];
    } catch (e) {
      log.warn('quickActions load failed', e);
      return [];
    }
  }

  function scheduleEvaluate(): void {
    if (routeTimer) clearTimeout(routeTimer);
    routeTimer = setTimeout(() => {
      routeTimer = null;
      void evaluate();
    }, ROUTE_DEBOUNCE_MS);
  }

  return {
    start() {
      // 先把 store 建出来（Shell 立刻要用），再异步读回站点偏好。
      // 旧顺序是先读再建，读回来时 Shell 可能已经挂载并用了默认值 —— 于是"记不住把手位置"。
      ensureStore();
      void loadPrefs().then(() => {
        const saved = prefs.get<{ form?: 'hidden' | 'handle' | 'panel'; handleY?: number }>(
          siteKeyOf(location.hostname),
        );
        if (saved?.handleY !== undefined) {
          ensureStore().getState().setHandleY(saved.handleY);
        }
      });
      void (async () => {
        try {
          const settings = await readSettings();
          applySettings({
            autoOpen: settings.shell.autoOpen,
            theme: settings.shell.theme,
            side: settings.shell.side,
          });
          notify();
        } catch (e) {
          log.debug('readSettings failed, keep defaults', e);
        }
      })();

      ctx.addEventListener(window, 'wxt:locationchange', () => scheduleEvaluate());
      // resize 用 rAF 合并：拖动窗口时浏览器每帧都会派发 resize，
      // 每次都 setViewport 会让 Shell 每次事件都重渲染一遍（§10.9 高频路径）。
      let resizeFrame = 0;
      ctx.addEventListener(window, 'resize', () => {
        if (resizeFrame !== 0) return;
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = 0;
          ensureStore().getState().setViewport(window.innerWidth, window.innerHeight);
        });
      });
      ctx.addEventListener(window, 'pagehide', () => {
        if (resizeFrame !== 0) cancelAnimationFrame(resizeFrame);
        resizeFrame = 0;
      });

      disconnectPort = connectJobPort({
        onMessage: (msg: PortMessage) => {
          if (msg.type === 'job-progress' || msg.type === 'job-done') {
            job = msg.job;
            notify();
            // 把手的「完成」对勾只保留 3 秒：到点再刷新一次 now
            if (msg.type === 'job-done') {
              // 完成态窗口内 now 必须真的走动，否则把手上的对勾永远不会在 3 秒后回落
              shellNow = Date.now();
              if (doneTimer) clearTimeout(doneTimer);
              doneTimer = setTimeout(() => {
                shellNow = Date.now();
                notify();
              }, HANDLE_DONE_TTL_MS + 50);
            }
          } else if (msg.type === 'dir-changed') {
            dir = msg.dir;
            notify();
          } else if (msg.type === 'panel-toggle') {
            // 工具栏快捷键 Alt+Shift+E / popup「在页面中打开」
            if (match) ensureStore().getState().togglePanel();
          }
        },
        onConnect() {
          void refreshDir();
        },
      });

      // bg 的 popup 会来问当前页状态（§10.8 面板和 popup 共用同一份）
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg?.type === 'ecbox:getTabState') {
          sendResponse({
            url: location.href,
            matched: match !== null,
            ...(match
              ? { pageKind: match.pageKind, platform: match.platform, productId: match.productId }
              : {}),
            ...(snapshot ? { snapshot } : {}),
            status,
            ...(blocker ? { blocker } : {}),
          } satisfies Partial<TabState>);
          return true;
        }
        return false;
      });

      watchSettings((s) => {
        applySettings({
          autoOpen: s.shell.autoOpen,
          theme: s.shell.theme,
          side: s.shell.side,
        });
        notify();
      });

      void refreshDir();
      void evaluate();
    },

    dispose() {
      abort?.abort();
      if (routeTimer) clearTimeout(routeTimer);
      if (doneTimer) clearTimeout(doneTimer);
      disconnectPort?.();
      bridge?.dispose();
      listeners.clear();
    },

    onMatched(cb) {
      matchedCb = cb;
    },
    onUnmatched(cb) {
      unmatchedCb = cb;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => version,
    current: () => match,
    snapshot: () => snapshot,
    handleCommand,
    refreshDir,
    dirState: () => dir,
    captures: (ruleId: string) => (bridge ? bridge.captures(ruleId) : emptyCaptures()),

    shellProps(api: PageApi): ShellProps {
      const platformId = match?.platform ?? '';
      // 缓存：notify 每次都会调用 shellProps（进度 200ms 一条），
      // 每次都 featuresForPlatform() 都会新建数组，让 Shell 的 useMemo 全部失效。
      if (cachedFeaturesFor !== platformId) {
        cachedFeaturesFor = platformId;
        cachedFeatures = platformId ? featuresForPlatform(platformId) : pageFeatures;
      }
      const features = cachedFeatures;
      const m = manifest ?? PLATFORM_MANIFESTS.find((p) => p.id === platformId);

      return {
        store: ensureStore(),
        platformName: m?.displayName ?? '',
        // 标题栏左上角的图标用平台 id 选（没有图标时 Panel 自己退回色点 + 名称）
        ...(platformId === '' ? {} : { platformId }),
        ...(m?.brandColor ? { platformColor: m.brandColor } : {}),
        ...(m?.brandRing ? { platformRing: m.brandRing } : {}),
        supportsMobileMode: m?.supportsMobileMode ?? false,
        snapshot,
        status,
        blocker,
        completeness,
        dir,
        features,
        job,
        now: shellNow,
        totalAssets: snapshot?.assets.length ?? 0,
        needsAttention: dir.status !== 'ready' || blocker !== null,
        onFormChange(form) {
          // store.setForm 已经按站点写进偏好（含 handleY），这里只同步控制器自己的镜像，
          // 否则下一次 schedulePrefsFlush 会用旧的 handleYPrefs 把它覆盖回去。
          const key = siteKeyOf(location.hostname);
          uiPrefs = { ...uiPrefs, [key]: form };
        },
        // 面板标题栏的 ⚙ 不再开新页面：设置是面板里的第二屏（view='settings'），
        // 入口只负责把这一屏的内容装配进来，外壳不认识任何具体设置项。
        settingsView: createElement(PanelSettingsView),
        onCopy(text) {
          void navigator.clipboard.writeText(text).catch(() => {});
        },
        onBlockerAction(action) {
          if (action === 'refresh') location.reload();
          else if (action === 'grant') void sendMessage('fs.openGrant', { reason: 'unset' });
          else if (action === 'reset-grant') void sendMessage('fs.openGrant', { reason: 'gone' });
          else if (action === 'retry') void evaluate();
          // 阻断提示里的「设置」同样落到面板内的设置视图，不再开新页面
          else if (action === 'settings') ensureStore().getState().setView('settings');
          else if (action === 'mobile-mode') {
            // Phase 0 已证否：两个平台改 UA 都拿不到数据（docs/phase0/FINDINGS.md §1），
            // 所以这里不假装能切，只给一句话说明。
            log.info('mobile-mode requested but unsupported');
          } else if (action === 'diagnostics') void exportDiagnostics();
        },
        onRescan() {
          match = null;
          void evaluate();
        },
        renderFeature(id, context) {
          const feature = features.find((f) => f.manifest.id === id);
          if (!feature) return null;
          return createElement(FeatureSlot, {
            feature,
            snapshot,
            status: status === 'ready' ? 'ready' : 'resolving',
            dir: context.dir,
            job: context.job,
            api,
          });
        },
      };
    },
  };
}

async function* emptyCaptures(): AsyncIterable<CapturedPayload> {
  // 没有 bridge 时给一个空流，避免调用方到处判 undefined
}
