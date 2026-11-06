import { createStore, type StoreApi } from 'zustand/vanilla';
import type { JobRecord } from '../kernel/jobs/types';
import type { AutoOpenMode, ThemeMode } from '../kernel/settings/schema';
import type { ShellForm, ShellPrefs } from './types';

/**
 * 外壳状态（§10.9 的 shellStore）。
 *
 * 为什么状态放在一个 store 里而不是逐层 props：
 * 进度每 200ms 推一次，面板里有把手、标题、素材行、主按钮都可能跟着变。
 * 细粒度订阅（每个组件只订自己关心的切片）才能做到「只有对应的行和主按钮重渲染」，
 * props 层层透传会让整个面板一起重渲染。
 *
 * 持久化只走注入进来的 prefs 端口，不直接碰 chrome.storage：
 * 这样单测和组件测试里塞一个内存实现就行，也避免 shell 依赖 kernel 的读写实现。
 */

/** 可持久化的 UI 偏好端口（和 PageApi.prefs 同形） */
export interface PrefsPort {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

/** §10.5 自动展开策略 + §10.6 主题，来自全局设置 */
export interface ShellUiSettings {
  autoOpen: AutoOpenMode;
  theme: ThemeMode;
}

/** 把手位置允许的纵向范围（§10.2：位置限制在 [80, 100vh − 160]） */
export const HANDLE_MIN_Y = 80;
export const HANDLE_BOTTOM_RESERVE = 160;

/** 拖动判定阈值：超过 4px 才算拖动，否则算点击（§10.2） */
export const DRAG_THRESHOLD_PX = 4;

/**
 * 面板宽度 + 页面内容最小宽度。视口比这个窄时不自动展开（§10.5 最后一行），
 * 因为展开就会压住商品内容；手动展开仍然允许，那时面板覆盖在内容上并带阴影。
 */
export const PANEL_W = 360;
export const PANEL_GAP = 16;
export const MIN_CONTENT_W = 640;

/** 把手纵向位置夹到 [80, 视口高 − 160]；视口太矮时取下界，保证把手可见 */
export function clampHandleY(y: number, viewportHeight: number): number {
  const max = viewportHeight - HANDLE_BOTTOM_RESERVE;
  if (max <= HANDLE_MIN_Y) return HANDLE_MIN_Y;
  return Math.min(Math.max(y, HANDLE_MIN_Y), max);
}

/** 拖动超过阈值才算拖动（§10.2），否则当作点击把手 */
export function isDrag(dx: number, dy: number): boolean {
  return Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX;
}

/** 视口太窄（面板会压到商品内容） */
export function isViewportNarrow(viewportWidth: number): boolean {
  return viewportWidth < MIN_CONTENT_W + PANEL_W + PANEL_GAP * 2;
}

export interface ResolveFormInput {
  /** 全局设置：进入商品页时的策略 */
  autoOpen: AutoOpenMode;
  /** 用户在这个站点上一次手动选择的形态；没选过就是 undefined */
  saved: ShellForm | undefined;
  /** 识别被阻断（登录墙 / APP_ONLY / 下架）—— 这种情况必须展开面板说明原因 */
  blocked: boolean;
  /** 视口太窄，不自动展开 */
  narrow: boolean;
}

/**
 * 进入商品页时该显示哪种形态（§10.5 自动展开策略）。
 *
 * 优先级：
 * 1. 被阻断 → 必须展开，否则用户看不到「需要先登录」这类说明；
 * 2. 设置成“不显示” → 不显示（这时只能从 popup / 快捷键用）；
 * 3. 用户在这个站点手动收起过 → 只显示把手（跟随用户在这个站点的上一次选择）；
 * 4. 视口太窄 → 只显示把手；
 * 5. 设置成“只显示把手” → 把手；
 * 6. 其余 → 展开面板。
 */
export function resolveForm(input: ResolveFormInput): ShellForm {
  const { autoOpen, saved, blocked, narrow } = input;
  if (blocked) return 'panel';
  if (autoOpen === 'hidden' && saved === undefined) return 'hidden';
  if (saved !== undefined) return saved;
  if (autoOpen === 'hidden') return 'hidden';
  if (narrow) return 'handle';
  if (autoOpen === 'handle') return 'handle';
  return 'panel';
}

/** 把手的角标状态（§10.2「把手上的数字和状态」表） */
export type HandleBadge =
  | { kind: 'resolving' }
  | { kind: 'count'; count: number }
  | { kind: 'progress'; percent: number }
  | { kind: 'done' }
  | { kind: 'attention'; count: number };

/** 完成态在把手上保持 3 秒（§10.2「完成：对勾图标，3 秒后恢复显示总数」） */
export const HANDLE_DONE_TTL_MS = 3000;

export interface HandleBadgeInput {
  status: 'resolving' | 'ready' | 'blocked';
  /** 可下载的素材总数 */
  total: number;
  job: JobRecord | null;
  /** 任务结束的时间，用来算完成态还剩多久 */
  now: number;
  /** 未授权 / 被阻断等需要用户处理的情况 */
  needsAttention: boolean;
}

/**
 * 把手该显示什么（§10.2）。
 * 判定顺序：完成态（3 秒内）→ 下载中 → 需要处理 → 识别中 → 数量。
 * 完成态放最前面，因为它是刚发生的事，用户正在等这个反馈。
 */
export function handleBadge(input: HandleBadgeInput): HandleBadge {
  const { status, total, job, now, needsAttention } = input;

  if (job && job.status === 'done' && job.endedAt !== undefined) {
    if (now - job.endedAt <= HANDLE_DONE_TTL_MS) return { kind: 'done' };
  }

  if (job && (job.status === 'running' || job.status === 'queued')) {
    const finished = job.done + job.skipped;
    const percent = job.total > 0 ? Math.round((finished / job.total) * 100) : 0;
    return { kind: 'progress', percent };
  }

  if (needsAttention) return { kind: 'attention', count: job?.failed.length ?? 0 };

  if (status === 'resolving') return { kind: 'resolving' };

  return { kind: 'count', count: total };
}

/**
 * 两个角标是否「看起来一样」。
 *
 * 外壳每 200ms 重算一次角标，绝大多数时候百分比根本没动。按内容比较，
 * 内容没变就沿用上一次的对象引用，Handle 就不会跟着重渲染（见 Shell.tsx 的注释）。
 */
export function handleBadgeEq(a: HandleBadge, b: HandleBadge): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'count':
      return a.count === (b as typeof a).count;
    case 'progress':
      return a.percent === (b as typeof a).percent;
    case 'attention':
      return a.count === (b as typeof a).count;
    case 'resolving':
    case 'done':
      return true;
  }
}

/** 站点 key：按站点记住把手位置和形态（§10.2「按站点记住」） */
export function siteKeyOf(host: string): string {
  return `shell:${host.toLowerCase()}`;
}

export interface ShellStoreState {
  form: ShellForm;
  handleY: number;
  activeFeature: string | null;
  /** 面板里是否正在显示设置视图（点标题栏 ⚙ 原地切换，不跳新页面） */
  view: 'assets' | 'settings';
  /** 主题设置（§10.6）：跟随系统 / 强制浅色 / 强制深色 */
  theme: ThemeMode;
  /** 视口宽度，窄视口下不自动展开；窗口 resize 时更新 */
  viewportWidth: number;
  viewportHeight: number;
  /** 用户手动收起/展开后写回的站点偏好 */
  saved: ShellPrefs;
}

export interface ShellStoreActions {
  setForm(form: ShellForm, opts?: { persist?: boolean }): void;
  /**
   * 切换面板内容：素材清单 ⇄ 设置。
   *
   * 显式传回 'assets' 时收起面板也要带上 —— 设置视图不该被记进站点偏好，
   * 否则用户下次进商品页点开面板，看到的第一屏是设置而不是素材。
   */
  setView(view: 'assets' | 'settings'): void;
  togglePanel(): void;
  setHandleY(y: number): void;
  setActiveFeature(id: string): void;
  setViewport(width: number, height: number): void;
  /**
   * 识别结果出来后按 §10.5 决定形态。
   * autoOpen 不传就用创建 store 时的设置；narrow 不传就按 store 里的视口宽度算。
   */
  syncForm(
    input: Omit<ResolveFormInput, 'saved' | 'autoOpen' | 'narrow'> & {
      autoOpen?: AutoOpenMode;
      narrow?: boolean;
    },
  ): void;
}

export type ShellStore = StoreApi<ShellStoreState & ShellStoreActions>;

export interface CreateShellStoreOptions {
  prefs: PrefsPort;
  /** siteKeyOf(window.location.host) 的结果 */
  siteKey: string;
  settings: ShellUiSettings;
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * 创建外壳 store。
 * 每次挂载面板建一个，卸载时丢掉 —— 形态本来就是要按站点重新算的。
 */
export function createShellStore(opts: CreateShellStoreOptions): ShellStore {
  const { prefs, siteKey, viewportWidth, viewportHeight } = opts;
  const raw = prefs.get<ShellPrefs>(siteKey);
  const saved: ShellPrefs = raw ?? {};

  return createStore<ShellStoreState & ShellStoreActions>()((set, get) => ({
    form: saved.form ?? 'handle',
    handleY: clampHandleY(saved.handleY ?? HANDLE_MIN_Y, viewportHeight),
    activeFeature: saved.activeFeature ?? null,
    view: 'assets',
    theme: opts.settings.theme,
    viewportWidth,
    viewportHeight,
    saved,

    setForm(form, options) {
      // 收起面板时回到素材视图：设置是「点进去看一眼就出来」的地方，
      // 下次打开面板不该还停在设置上（也不该把这一屏记进站点偏好）
      set(form === 'panel' ? { form } : { form, view: 'assets' });
      if (options?.persist !== false) {
        // 只有用户主动的选择才写回站点偏好（§10.5：跟随用户在这个站点的上一次选择）
        const { activeFeature } = get();
        const next: ShellPrefs = {
          ...get().saved,
          form,
          handleY: get().handleY,
          ...(activeFeature === null ? {} : { activeFeature }),
        };
        set({ saved: next });
        prefs.set(siteKey, next);
      }
    },

    togglePanel() {
      const current = get().form;
      get().setForm(current === 'panel' ? 'handle' : 'panel');
    },

    setView(view) {
      set({ view });
    },

    setHandleY(y) {
      const clamped = clampHandleY(y, get().viewportHeight);
      set({ handleY: clamped });
      const next: ShellPrefs = { ...get().saved, handleY: clamped };
      set({ saved: next });
      prefs.set(siteKey, next);
    },

    setActiveFeature(id) {
      set({ activeFeature: id });
      const next: ShellPrefs = { ...get().saved, activeFeature: id };
      set({ saved: next });
      prefs.set(siteKey, next);
    },

    setViewport(width, height) {
      set({ viewportWidth: width, viewportHeight: height });
      const current = get();
      const clamped = clampHandleY(current.handleY, height);
      if (clamped !== current.handleY) set({ handleY: clamped });
    },

    syncForm(input) {
      const form = resolveForm({
        autoOpen: input.autoOpen ?? opts.settings.autoOpen,
        saved: get().saved.form,
        blocked: input.blocked,
        narrow: input.narrow ?? isViewportNarrow(get().viewportWidth),
      });
      set({ form });
    },
  }));
}

/** 主题：跟随系统时不写属性，靠 tokens.css 的 prefers-color-scheme（§10.6 主题） */
export function themeAttr(theme: ThemeMode): 'light' | 'dark' | undefined {
  return theme === 'system' ? undefined : theme;
}
