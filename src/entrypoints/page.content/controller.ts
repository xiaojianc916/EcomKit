/**
 * PageController（方案 §7.2 的状态机）——内容脚本侧的总装。
 *
 * 职责：
 *   1. URL 变化 → findPageKind → detecting；没命中 → idle 并卸载 UI
 *   2. 阻断检测（登录墙 / App 限制 / 已下架）
 *   3. 并行跑各数据源，渐进合并成 ProductSnapshot
 *   4. Port 连接、任务认领、目录状态
 *   5. 给 Shell 提供 props
 *
 * **按商品 ID 隔离**是这里最容易出错的地方：SPA 切换商品时旧会话的 draft 一律丢弃。
 */
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { ErrorCode } from '../../kernel/errors/codes';
import type { DirState } from '../../kernel/fs/types';
import type { JobRecord } from '../../kernel/jobs/types';
import type { ProductDraft, ProductSnapshot } from '../../kernel/model/product';
import type { PortMessage, TabState } from '../../kernel/messaging/protocol';
import type { PageApi, RegisteredFeature } from '../../features/types';
import type { ShellProps } from '../../shell/Shell';
import { EcError } from '../../kernel/errors/ec-error';
import { createLogger } from '../../kernel/log/logger';
import { findPageKind } from '../../platforms/registry';
import { getPlatformResolver } from '../../platforms/registry.resolver';
import type { CapturedPayload, PlatformManifest } from '../../platforms/types';
import { DraftAccumulator } from '../../platforms/shared/merge';
import { PLATFORM_MANIFESTS } from '../../platforms/registry';
import { connectJobPort } from '../../kernel/messaging/port';
import { sendMessage } from '../../kernel/messaging/runtime';
import { readSettings, watchSettings } from '../../kernel/settings/store';
import { pageFeatures, featuresForPlatform } from '../../features/registry.page';
import { createShellStore, siteKeyOf, type ShellStore } from '../../shell/store';
import type { PrefsPort } from '../../shell/store';
import { createPageBridge, type PageBridge } from './bridge-client';
import { resolveSnapshot } from './resolver-runner';

const log = createLogger('page.controller');

/** SPA 路由防抖（§7.2：切换商品时会有多次 pushState） */
const ROUTE_DEBOUNCE_MS = 300;
/** 识别总超时：8 秒还没拿全就按 partial（§7.2 状态机） */
const PARTIAL_TIMEOUT_MS = 8000;

export interface PageController {
  start(): void;
  dispose(): void;
  onMatched(cb: () => void): void;
  onUnmatched(cb: () => void): void;
  shellProps(api: PageApi): ShellProps;
  current(): { platform: string; pageKind: string; productId: string } | null;
  snapshot(): ProductSnapshot | null;
  refreshDir(): Promise<DirState>;
  /** 页面侧已就绪的抓包数据源，给 resolver 用 */
  captures(ruleId: string): AsyncIterable<CapturedPayload>;
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
  let uiPrefs: Record<string, 'hidden' | 'handle' | 'panel'> = {};
  let handleYPrefs: Record<string, number> = {};

  const prefs: PrefsPort = {
    get<T>(key: string): T | undefined {
      const saved = uiPrefs[key];
      if (saved === undefined) return undefined;
      return { form: saved, handleY: handleYPrefs[key] } as T;
    },
    set<T>(key: string, value: T): void {
      const v = value as { form?: 'hidden' | 'handle' | 'panel'; handleY?: number };
      if (v.form) uiPrefs = { ...uiPrefs, [key]: v.form };
      if (typeof v.handleY === 'number') handleYPrefs = { ...handleYPrefs, [key]: v.handleY };
      // 站点偏好落盘由 shell 的 onFormChange 触发，这里只保内存，避免每次拖动都写 storage
    },
  };

  function ensureStore(): ShellStore {
    if (store) return store;
    store = createShellStore({
      prefs,
      siteKey: siteKeyOf(location.hostname),
      settings: { autoOpen: 'panel', theme: 'system' },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    return store;
  }

  /** 状态变了就让 React 重渲染：通过 store 的 setViewport 触发订阅（幂等） */
  function notify(): void {
    const s = ensureStore();
    s.getState().setViewport(window.innerWidth, window.innerHeight);
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
        unmatchedCb?.();
      }
      return;
    }

    const sameProduct =
      match !== null && match.productId === hit.productId && match.pageKind === hit.kind;
    if (sameProduct) return;

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
    notify();
    matchedCb?.();

    const resolver = getPlatformResolver(hit.platform.id);
    if (!resolver) {
      blocker = 'PARSE_EMPTY';
      status = 'blocked';
      notify();
      return;
    }

    // 阻断优先：登录墙 / App 限制 / 已下架
    const blockerCode = resolver.detectBlocker(document, url);
    if (blockerCode) {
      blocker = blockerCode;
      status = 'blocked';
      notify();
      log.info('blocked', { code: blockerCode });
      return;
    }

    status = 'resolving';
    notify();

    // 桥：生成前缀、下发抓取规则、准备 readGlobal / captures
    try {
      bridge = createPageBridge(hit.platform, hit.kind);
    } catch (e) {
      log.debug('bridge unavailable', e);
    }

    const localAbort = abort;
    try {
      const result = await resolveSnapshot({
        url,
        productId: hit.productId,
        pageKind: hit.kind,
        platformName: hit.platform.displayName,
        resolver,
        document,
        signal: localAbort.signal,
        partialTimeoutMs: PARTIAL_TIMEOUT_MS,
        onProgress: (_draft: ProductDraft, acc: DraftAccumulator) => {
          if (localAbort.signal.aborted) return;
          const partial = acc.toSnapshot({
            platform: hit.platform.id,
            pageKind: hit.kind,
            productId: hit.productId,
            capturedAt: Date.now(),
            fallbackTitle: document.title,
            fallbackUrl: url.toString(),
          });
          if (partial) {
            snapshot = partial;
            status = 'ready';
            notify();
          }
        },
        ...(bridge ? { readGlobal: (p: string) => bridge!.readGlobal(p) } : {}),
        captures: (ruleId: string) =>
          bridge ? bridge.captures(ruleId) : emptyCaptures(),
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
      notify();
      log.info('resolve done', {
        productId: hit.productId,
        assets: result.snapshot?.assets.length ?? 0,
        completeness,
      });
    } catch (e) {
      if (localAbort.signal.aborted) return;
      const code = EcError.from(e).code;
      blocker = code;
      status = 'blocked';
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

  function scheduleEvaluate(): void {
    if (routeTimer) clearTimeout(routeTimer);
    routeTimer = setTimeout(() => {
      routeTimer = null;
      void evaluate();
    }, ROUTE_DEBOUNCE_MS);
  }

  return {
    start() {
      void (async () => {
        const settings = await readSettings();
        store = createShellStore({
          prefs,
          siteKey: siteKeyOf(location.hostname),
          settings: { autoOpen: settings.shell.autoOpen, theme: settings.shell.theme },
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        });
        notify();
      })();

      ctx.addEventListener(window, 'wxt:locationchange', () => scheduleEvaluate());
      ctx.addEventListener(window, 'resize', () => notify());

      disconnectPort = connectJobPort({
        onMessage: (msg: PortMessage) => {
          if (msg.type === 'job-progress' || msg.type === 'job-done') {
            job = msg.job;
            notify();
          } else if (msg.type === 'dir-changed') {
            dir = msg.dir;
            notify();
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
            ...(match ? { pageKind: match.pageKind, platform: match.platform } : {}),
            ...(snapshot ? { snapshot } : {}),
            status,
            ...(blocker ? { blocker } : {}),
          } satisfies Partial<TabState>);
          return true;
        }
        return false;
      });

      watchSettings((s) => {
        ensureStore().getState().setViewport(window.innerWidth, window.innerHeight);
        void s;
      });

      void refreshDir();
      void evaluate();
    },

    dispose() {
      abort?.abort();
      if (routeTimer) clearTimeout(routeTimer);
      disconnectPort?.();
      bridge?.dispose();
    },

    onMatched(cb) {
      matchedCb = cb;
    },
    onUnmatched(cb) {
      unmatchedCb = cb;
    },
    current: () => match,
    snapshot: () => snapshot,
    refreshDir,
    captures: (ruleId: string) =>
      bridge ? bridge.captures(ruleId) : emptyCaptures(),

    shellProps(api: PageApi): ShellProps {
      const platformId = match?.platform ?? '';
      const features: RegisteredFeature[] = platformId
        ? featuresForPlatform(platformId)
        : pageFeatures;
      const m = manifest ?? PLATFORM_MANIFESTS.find((p) => p.id === platformId);

      return {
        store: ensureStore(),
        platformName: m?.displayName ?? '',
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
        now: Date.now(),
        totalAssets: snapshot?.assets.length ?? 0,
        needsAttention: dir.status !== 'ready' || blocker !== null,
        onFormChange(form) {
          const key = siteKeyOf(location.hostname);
          uiPrefs = { ...uiPrefs, [key]: form };
        },
        onOpenOptions() {
          void sendMessage('shell.openOptions');
        },
        onCopy(text) {
          void navigator.clipboard.writeText(text).catch(() => {});
        },
        onBlockerAction(action) {
          if (action === 'refresh') location.reload();
          else if (action === 'grant') void sendMessage('fs.openGrant', { reason: 'unset' });
          else if (action === 'reset-grant') void sendMessage('fs.openGrant', { reason: 'gone' });
          else if (action === 'retry') void evaluate();
        },
        onRescan() {
          match = null;
          void evaluate();
        },
        renderFeature() {
          return null;
        },
      };
    },
  };
}

async function* emptyCaptures(): AsyncIterable<CapturedPayload> {
  // 没有 bridge 时给一个空流，避免调用方到处判 undefined
}