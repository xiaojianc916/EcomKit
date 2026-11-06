import type { ReactNode } from 'react';
import { useCallback, useMemo, useRef } from 'react';
import type { StoreApi } from 'zustand';
import { useStore } from 'zustand';
import type { RegisteredFeature } from '../features/types';
import type { ErrorCode } from '../kernel/errors/codes';
import type { JobRecord } from '../kernel/jobs/types';
import type { DirState } from '../kernel/messaging/protocol';
import type { ProductSnapshot } from '../kernel/model/product';
import type { GlobalSettings } from '../kernel/settings/schema';
import { PortalRoot, ToastViewport, TooltipProvider } from '../kernel/ui-kit';
import type { BlockerActionId } from './BlockerNotice';
import { pickActiveFeature } from './FeatureTabs';
import { Handle } from './Handle';
import { LiveRegionProvider } from './LiveRegion';
import { Panel } from './Panel';
import { createShellStore, handleBadge, handleBadgeEq, type ShellStore, themeAttr } from './store';

/**
 * 工具箱外壳（§10.2 三种形态、§10.9 组件树）。
 *
 * 职责边界：外壳**只**决定「显示哪个形态、把手在哪、显示哪个功能的 Panel」，
 * 它不认识任何具体功能，也不碰下载逻辑。功能通过 §8.5 的四个插槽接进来。
 *
 * 为什么外壳要自己订阅 store 而不是靠 props 重渲染：
 * 进度每 200ms 更新，如果把 store 放在外壳顶部用 useState 驱动整棵树，
 * 整块面板会跟着重渲染。这里每个子组件各自订阅自己需要的切片。
 */
export interface ShellProps {
  /** 由 page.content 注入：识别状态、快照、阻断、目录、任务…… */
  store: ShellStore;
  /** shadow root，弹层要挂进去（§10.10） */
  portalContainer?: HTMLElement | ShadowRoot;
  platformName: string;
  /** 平台 id：标题栏左上角用它的 logo（没有图标时退回色点 + 名称） */
  platformId?: string;
  platformColor?: string;
  platformRing?: string;
  /**
   * 支持「以手机模式重新打开」的平台才出这个按钮。
   * Phase 0 结论：抖音恒为 false（docs/phase0/FINDINGS.md 第 1 节）。
   */
  supportsMobileMode?: boolean;
  snapshot: ProductSnapshot | null;
  status: 'idle' | 'detecting' | 'resolving' | 'ready' | 'blocked';
  blocker: ErrorCode | null;
  completeness: 'full' | 'partial';
  dir: DirState;
  features: RegisteredFeature[];
  /** 手动展开/收起时同步给外部（bg 的快捷键也走这里） */
  onFormChange?(form: 'hidden' | 'handle' | 'panel'): void;
  /** 面板标题栏 ⚙ 打开的设置视图（同一块面板内切换，不跳新页面） */
  settingsView: ReactNode;
  onCopy(text: string): void;
  onBlockerAction(action: BlockerActionId): void;
  onRescan(): void;
  /**
   * 当前功能的面板内容（FeatureSlot 负责懒加载后传进来）。
   * 外壳把目录状态和任务一起传下去：§9.4 要求面板挂载时只查一次目录，
   * 功能模块不该自己再查一遍（每次查都可能触发一次权限探测）。
   */
  renderFeature(id: string, context: { dir: DirState; job: JobRecord | null }): React.ReactNode;
  /** 可下载素材总数，把手角标用 */
  totalAssets: number;
  /** 未授权 / 被阻断等需要用户处理 */
  needsAttention: boolean;
  /** 当前商品的任务、以及“完成态”计时用的 now */
  job: import('../kernel/jobs/types').JobRecord | null;
  now: number;
}

/** 订阅 store 的一小片状态；选择器必须是稳定引用，避免每次渲染都新建对象 */
function useShell<T>(store: ShellStore, selector: (state: ShellStoreState) => T): T {
  return useStore(store as unknown as StoreApi<ShellStoreState>, selector);
}

type ShellStoreState = ReturnType<ShellStore['getState']>;

const selectForm = (s: ShellStoreState) => s.form;
const selectHandleY = (s: ShellStoreState) => s.handleY;
const selectViewportHeight = (s: ShellStoreState) => s.viewportHeight;
const selectTheme = (s: ShellStoreState) => s.theme;
const selectActiveFeature = (s: ShellStoreState) => s.activeFeature;
const selectView = (s: ShellStoreState) => s.view;

export function Shell(props: ShellProps) {
  const {
    store,
    portalContainer,
    platformName,
    platformId,
    platformColor,
    platformRing,
    supportsMobileMode,
    snapshot,
    status,
    blocker,
    completeness,
    dir,
    features,
    onFormChange,
    settingsView,
    onCopy,
    onBlockerAction,
    onRescan,
    renderFeature,
    totalAssets,
    needsAttention,
    job,
    now,
  } = props;

  const form = useShell(store, selectForm);
  const handleY = useShell(store, selectHandleY);
  const viewportHeight = useShell(store, selectViewportHeight);

  const themeSetting = useShell(store, selectTheme);
  const activeFeature = useShell(store, selectActiveFeature);
  const view = useShell(store, selectView);

  // 主题：跟随系统时不写属性，靠 tokens.css 的 prefers-color-scheme（§10.6）
  const themeValue = themeAttr(themeSetting);

  const effectiveFeature = useMemo(
    () => pickActiveFeature(features, activeFeature),
    [features, activeFeature],
  );

  const setForm = store.getState().setForm;
  const changeForm = useCallback(
    (next: 'hidden' | 'handle' | 'panel') => {
      setForm(next);
      onFormChange?.(next);
    },
    [setForm, onFormChange],
  );

  // 这些回调一旦每次渲染都新建，下面 memo 过的子组件就白 memo 了
  const onDragEnd = useCallback(
    (y: number) => {
      store.getState().setHandleY(y);
    },
    [store],
  );
  const onHandleClick = useCallback(() => changeForm('panel'), [changeForm]);
  const onSelectFeature = useCallback(
    (id: string) => {
      store.getState().setActiveFeature(id);
    },
    [store],
  );
  const onClose = useCallback(() => changeForm('handle'), [changeForm]);
  // 打开设置时把手位置不动、面板不重开：只是同一块面板换了内容（§10.3）
  const onOpenSettings = useCallback(() => {
    store.getState().setView('settings');
  }, [store]);
  const onCloseSettings = useCallback(() => {
    store.getState().setView('assets');
  }, [store]);

  // Alt+Shift+E 展开/收起由 entrypoints 的快捷键负责（§10.5），
  // 这里只处理面板内的 Esc（在 Panel 里注册）。

  const rootStyle = themeValue === undefined ? undefined : ({ colorScheme: themeValue } as const);

  return (
    // PortalRoot 必须在外层：内层再包一层 value=undefined 会把 shadow root 覆盖成 null，
    // 于是 Tooltip / Toast 全部挂到 document.body，拿不到 Shadow DOM 里的样式。
    <PortalRoot {...(portalContainer === undefined ? {} : { value: portalContainer })}>
      <TooltipProvider>
        <LiveRegionProvider>
          <div
            className="ec-root"
            {...(themeValue === undefined ? {} : { 'data-ec-theme': themeValue })}
            style={rootStyle}
          >
            {form === 'handle' ? (
              /*
                角标单独成组件：now 每 250ms 变一次，而它**只**被角标用。
                留在 Shell 里算的话，那个 3 秒的完成态窗口每 250ms 都会让整个外壳
                （含 Panel 与功能面板）重渲染一次。拆出去之后，now 的变化只重渲染这一小块。
              */
              <HandleBadgeView
                status={status}
                total={totalAssets}
                job={job}
                now={now}
                needsAttention={needsAttention}
                handleY={handleY}
                viewportHeight={viewportHeight}
                {...(platformColor === undefined ? {} : { platformColor })}
                {...(platformRing === undefined ? {} : { platformRing })}
                onDragEnd={onDragEnd}
                onClick={onHandleClick}
              />
            ) : null}

            {form === 'panel' ? (
              <Panel
                platformName={platformName}
                {...(platformId === undefined ? {} : { platformId })}
                {...(platformColor === undefined ? {} : { platformColor })}
                {...(platformRing === undefined ? {} : { platformRing })}
                snapshot={snapshot}
                blocker={blocker}
                completeness={completeness}
                top={handleY}
                features={features}
                activeFeature={effectiveFeature}
                onSelectFeature={onSelectFeature}
                onClose={onClose}
                view={view}
                onOpenSettings={onOpenSettings}
                onCloseSettings={onCloseSettings}
                settingsView={settingsView}
                onCopy={onCopy}
                onBlockerAction={onBlockerAction}
                {...(supportsMobileMode === undefined ? {} : { supportsMobileMode })}
                onRescan={onRescan}
                autoFocus
              >
                {effectiveFeature === null ? null : renderFeature(effectiveFeature, { dir, job })}
              </Panel>
            ) : null}

            {/*
              Toast 的落点。旧实现只在别处 new 了一个 ToastViewport，外壳从来没渲染它，
              于是 PageApi.toast("请在弹出的小窗中选择保存位置") 这类兜底提示全部石沉大海 ——
              这也是「点了下载完全没反应」的一部分：失败原因根本没地方显示。
            */}
            <ToastViewport />
          </div>
        </LiveRegionProvider>
      </TooltipProvider>
    </PortalRoot>
  );
}

interface HandleBadgeViewProps {
  status: ShellProps['status'];
  total: number;
  job: JobRecord | null;
  now: number;
  needsAttention: boolean;
  handleY: number;
  viewportHeight: number;
  platformColor?: string;
  platformRing?: string;
  onDragEnd(y: number): void;
  onClick(): void;
}

/**
 * 把手 + 角标（只有这一小块依赖 now）。
 *
 * 角标按「内容相等」复用引用：进度每 200ms 推一次，同一次推送里算出来的
 * { kind: 'progress', percent: 42 } 和上一次往往一模一样，内容没变就不该换对象，
 * Handle 也就不用重渲染（从而不会打断正在进行的拖动 = pointermove 掉帧）。
 */
function HandleBadgeView(props: HandleBadgeViewProps) {
  const {
    status,
    total,
    job,
    now,
    needsAttention,
    handleY,
    viewportHeight,
    platformColor,
    platformRing,
    onDragEnd,
    onClick,
  } = props;

  const badge = useMemo(
    () =>
      handleBadge({
        status: status === 'blocked' ? 'blocked' : status === 'ready' ? 'ready' : 'resolving',
        total,
        job,
        now,
        needsAttention,
      }),
    [status, total, job, now, needsAttention],
  );
  const stableBadge = useStableByValue(badge, handleBadgeEq);

  return (
    <Handle
      y={handleY}
      badge={stableBadge}
      {...(platformColor === undefined ? {} : { platformColor })}
      {...(platformRing === undefined ? {} : { platformRing })}
      viewportHeight={viewportHeight}
      onDragEnd={onDragEnd}
      onClick={onClick}
    />
  );
}

/**
 * 值相等时复用上一次的引用。
 *
 * 典型用法：每次渲染都算出 { kind: 'progress', percent: 42 } 这种小对象，
 * 但内容没变时下游组件不该重渲染。useMemo 只能按依赖数组缓存，
 * 按「算出来之后再比一次」的场景需要这个（React 官方文档里 useMemo 一节的同款写法）。
 */
function useStableByValue<T>(value: T, eq: (a: T, b: T) => boolean): T {
  const ref = useRef(value);
  if (!eq(ref.current, value)) ref.current = value;
  return ref.current;
}

/**
 * 给 entrypoints 用的便捷构造函数：把「创建 store + 监听 resize」这套样板收在一起。
 * 返回 store 和清理函数，避免调用方忘记解绑 resize。
 */
export function mountShellStore(opts: {
  prefs: { get<T>(k: string): T | undefined; set<T>(k: string, v: T): void };
  siteKey: string;
  settings: {
    autoOpen: GlobalSettings['shell']['autoOpen'];
    theme: GlobalSettings['shell']['theme'];
  };
}): { store: ShellStore; dispose(): void } {
  const store = createShellStore({
    prefs: opts.prefs,
    siteKey: opts.siteKey,
    settings: opts.settings,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });

  /**
   * resize 一帧最多处理一次，而不是一事件一次。
   *
   * 真实边界：拖动浏览器窗口边缘时 resize 事件按帧（甚至更密）触发，每个事件里
   * setViewport 都会让订阅 viewportHeight 的外壳重渲染，并且继续触发
   * clampHandleY → set({ handleY }) → 再渲染一次，一次拖动就是几百次无效渲染。
   * 用 rAF 把同一帧里的多次事件压成一次；rAF 在标签页不可见时本来就不跑，
   * 顺带省掉后台开销。
   */
  let frame: number | null = null;
  const onResize = (): void => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      store.getState().setViewport(window.innerWidth, window.innerHeight);
    });
  };
  window.addEventListener('resize', onResize);
  return {
    store,
    dispose: () => {
      window.removeEventListener('resize', onResize);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}
