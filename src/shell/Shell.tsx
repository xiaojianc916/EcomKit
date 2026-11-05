import { useCallback, useMemo } from 'react';
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
import {
  createShellStore,
  type HandleBadge,
  handleBadge,
  type ShellStore,
  themeAttr,
} from './store';

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
  onOpenOptions(): void;
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

export function Shell(props: ShellProps) {
  const {
    store,
    portalContainer,
    platformName,
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
    onOpenOptions,
    onCopy,
    onBlockerAction,
    onRescan,
    renderFeature,
    totalAssets,
    needsAttention,
    job,
    now,
  } = props;

  const form = useShell(store, (s) => s.form);
  const handleY = useShell(store, (s) => s.handleY);
  const viewportHeight = useShell(store, (s) => s.viewportHeight);

  const themeSetting = useShell(store, (s) => s.theme);
  const activeFeature = useShell(store, (s) => s.activeFeature);

  // 主题：跟随系统时不写属性，靠 tokens.css 的 prefers-color-scheme（§10.6）
  const themeValue = themeAttr(themeSetting);

  const effectiveFeature = useMemo(
    () => pickActiveFeature(features, activeFeature),
    [features, activeFeature],
  );

  const badge: HandleBadge = useMemo(
    () =>
      handleBadge({
        status: status === 'blocked' ? 'blocked' : status === 'ready' ? 'ready' : 'resolving',
        total: totalAssets,
        job,
        now,
        needsAttention,
      }),
    [status, totalAssets, job, now, needsAttention],
  );

  const setForm = store.getState().setForm;
  const changeForm = useCallback(
    (next: 'hidden' | 'handle' | 'panel') => {
      setForm(next);
      onFormChange?.(next);
    },
    [setForm, onFormChange],
  );

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
              <Handle
                y={handleY}
                badge={badge}
                {...(platformColor === undefined ? {} : { platformColor })}
                {...(platformRing === undefined ? {} : { platformRing })}
                viewportHeight={viewportHeight}
                onDragEnd={(y) => store.getState().setHandleY(y)}
                onClick={() => changeForm('panel')}
              />
            ) : null}

            {form === 'panel' ? (
              <Panel
                platformName={platformName}
                {...(platformColor === undefined ? {} : { platformColor })}
                {...(platformRing === undefined ? {} : { platformRing })}
                snapshot={snapshot}
                blocker={blocker}
                completeness={completeness}
                top={handleY}
                features={features}
                activeFeature={effectiveFeature}
                onSelectFeature={(id) => store.getState().setActiveFeature(id)}
                onClose={() => changeForm('handle')}
                onOpenOptions={onOpenOptions}
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
  const onResize = (): void => store.getState().setViewport(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', onResize);
  return {
    store,
    dispose: () => window.removeEventListener('resize', onResize),
  };
}
