import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import type { RegisteredFeature } from '../features/types';
import type { ErrorCode } from '../kernel/errors/codes';
import type { ProductSnapshot } from '../kernel/model/product';
import type { PanelSide } from '../kernel/settings/schema';
import { ScrollArea } from '../kernel/ui-kit';
import type { BlockerActionId } from './BlockerNotice';
import { FeatureTabs } from './FeatureTabs';
import { PanelBody } from './PanelBody';
import { PanelTitleBar } from './PanelTitleBar';

/**
 * 面板（§10.2 面板形态、§10.3 布局）。
 *
 * 布局尺寸严格按 §10.3：
 *   ① 标题栏 40px  ② 商品信息 72px  ③ 区块标题 28px（在功能块内）
 *   ④ 素材清单每行 48px（在功能块内）  ⑤ 保存位置 32px  ⑥ 主按钮 36px  ⑦ 附加说明
 *
 * 几条必须在这里落实的规则：
 * - 宽 360px，贴边（默认右侧），距离边缘 16px；顶部和把手对齐。停靠侧来自设置（§10.3）。
 * - 最大高度 100vh − 96px，超出部分**面板内部滚动**；滚动区 overscroll-behavior: contain，
 *   在面板里滚动不会带动页面（§10.5 滚动隔离）。
 * - 标题栏**不能拖动**（§10.3 ①）：避免和点击冲突。
 * - Esc 收起面板（§10.5 键盘操作）：交给原生 <dialog> 的 cancel 事件，不劫持页面的 Esc。
 * - 面板展开时从右侧滑入，160ms ease-out（§10.6 动效）。
 * - 内容区拆成 PanelTitleBar / PanelBody 两块：标题栏只认平台与两个图标按钮，
 *   内容区只认「阻断 / 识别中 / 商品信息 / 设置」四种互斥状态。
 */
export interface PanelViewProps {
  platformName: string;
  /** 平台 id：用它的 logo 做左上角图标（没有图标时退回色点 + 名称） */
  platformId?: string;
  platformColor?: string;
  platformRing?: string;
  snapshot: ProductSnapshot | null;
  blocker: ErrorCode | null;
  completeness: 'full' | 'partial';
  /** 顶部对齐的把手位置 */
  top: number;
  /**
   * 停靠侧：右侧（默认）或左侧。默认 right 让既有调用点不用改；
   * Shell 永远显式传，漏传会静默变回右侧而不是报错。
   */
  side?: PanelSide;
  features: RegisteredFeature[];
  activeFeature: string | null;
  onSelectFeature(id: string): void;
  onClose(): void;
  /**
   * 面板里正在显示哪一屏。设置**不是**另一个页面：点标题栏 ⚙ 就在这块面板里切过去，
   * 标题栏、宽高、圆角、令牌全部沿用同一套（§10.3）。
   */
  view: 'assets' | 'settings';
  onOpenSettings(): void;
  onCloseSettings(): void;
  /** 设置视图的内容（由入口装配，外壳不认识任何具体设置项） */
  settingsView: ReactNode;
  onCopy(text: string): void;
  onBlockerAction(action: BlockerActionId): void;
  supportsMobileMode?: boolean;
  onRescan(): void;
  /** 功能插槽（§8.5 panel） */
  children: ReactNode;
  /** 读屏器和键盘的落点 */
  autoFocus?: boolean;
}

export const PANEL_WIDTH = 360;
export const PANEL_GAP = 16;

/**
 * 贴边样式：贴哪边就把距离写在那一边，另一侧写 auto。
 *
 * 不能只写一侧：<dialog> 的 UA 样式带 inset-inline-start/end: 0，
 * 两端都有值时 LTR 下 left 优先，靠右的面板会跑到屏幕左边。
 */
function panelEdgeStyle(side: PanelSide): { left: number | 'auto'; right: number | 'auto' } {
  return side === 'left' ? { left: PANEL_GAP, right: 'auto' } : { left: 'auto', right: PANEL_GAP };
}

export function Panel(props: PanelViewProps) {
  const {
    platformName,
    platformId,
    platformColor,
    platformRing,
    snapshot,
    blocker,
    completeness,
    top,
    side = 'right',
    features,
    activeFeature,
    onSelectFeature,
    onClose,
    view,
    onOpenSettings,
    onCloseSettings,
    settingsView,
    onCopy,
    onBlockerAction,
    supportsMobileMode,
    onRescan,
    children,
    autoFocus = false,
  } = props;

  const rootRef = useRef<HTMLDialogElement>(null);

  /*
   * 用原生 <dialog> 而不是 role="dialog" 的 div：语义、焦点容器、读屏器播报都由元素本身负责。
   *
   * 只用 open 属性（= show() 的非模态状态），**不用** showModal()：
   * 工具箱面板是贴在商品页右侧的一层，页面本身仍然要能点能滚 ——
   * §10.5「手动展开时面板覆盖在内容上」「在面板里滚动不会带动页面」，
   * 以及验收项 A17「面板不抢页面快捷键和滚动」。showModal() 会把页面其余部分
   * 变成 inert，那是另一套交互（真模态框），用户在面板开着时就点不了页面了。
   *
   * 写 open 而不是在 effect 里调 show()：属性在首帧就在，面板不会先闪一下空白。
   */

  /*
   * Esc 收起面板（§10.5 键盘操作）。
   *
   * 非模态 <dialog> 没有浏览器自带的 cancel/Esc 行为，所以这条仍然自己处理：
   * 监听挂在面板节点上（不是 document），按键只在本面板有焦点时生效，不劫持页面的 Esc。
   * 与拆标签前完全一致 —— 包括「下拉框已吃掉 Esc 时面板行为不变」这一点。
   */
  useEffect(() => {
    const node = rootRef.current;
    if (node === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    node.addEventListener('keydown', onKeyDown);
    return () => node.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (autoFocus) rootRef.current?.focus();
  }, [autoFocus]);

  const settingsVisible = view === 'settings';
  const showContent = snapshot !== null && blocker === null;
  const showBody = showContent && !settingsVisible;

  return (
    <dialog
      ref={rootRef}
      className="ec-panel ec-root"
      aria-label={settingsVisible ? '素材下载设置' : '素材下载面板'}
      // 非模态：等价于 show()，但首帧就可见（effect 里调 show 会先渲染一帧未打开的对话框）
      open
      tabIndex={-1}
      // data-ec-side 给 CSS 用：入场动画的 translateX 方向要随停靠侧翻转（ui-kit.css）
      data-ec-side={side}
      style={{
        // 原生 <dialog> 的 UA 样式带 margin: auto / border / padding / max-width / inset，
        // 必须整体覆盖：面板是贴边固定定位的卡片，不是居中的模态框。
        // <dialog> 默认还是 display: block + color/background 走系统色，下面一并覆盖。
        position: 'fixed',
        // UA 对 dialog 写了 inset-inline-start/end: 0，左右两边都会被撑上；
        // 两个属性同时有值时 LTR 下会忽略 right —— 所以贴哪边就必须把另侧显式写回 auto，
        // 只写一侧的话面板会钉死在屏幕左边。见 panelEdgeStyle。
        ...panelEdgeStyle(side),
        margin: 0,
        padding: 0,
        border: '1px solid var(--ec-line)',
        // 顶部和把手对齐，超出视口时向上收拢（§10.2）
        top: Math.max(PANEL_GAP, Math.min(top, 24)),
        zIndex: 2147483646,
        display: 'flex',
        flexDirection: 'column',
        // 显式写 px（不用 rem，也不用数字靠 React 自动补单位）：
        // §10.6「尺寸全部用 px」，移动版页面会改 html{font-size}，用 rem 面板会跟着变形。
        // E2E 会在 html{font-size:20px} 的页面上断言这里仍是 360px。
        width: `${PANEL_WIDTH}px`,
        maxHeight: 'calc(100vh - 96px)',
        borderRadius: 10,
        background: 'var(--ec-bg)',
        boxShadow: '0 8px 24px rgba(15, 20, 30, .12), 0 0 0 1px rgba(15, 20, 30, .06)',
        overflow: 'hidden',
        outline: 'none',
      }}
    >
      <PanelTitleBar
        platformName={platformName}
        {...(platformId === undefined ? {} : { platformId })}
        {...(platformColor === undefined ? {} : { platformColor })}
        {...(platformRing === undefined ? {} : { platformRing })}
        side={side}
        settingsVisible={settingsVisible}
        onOpenSettings={onOpenSettings}
        onCloseSettings={onCloseSettings}
        onClose={onClose}
      />

      {/*
        ①之后：滚动区。用 ui-kit 的 ScrollArea —— 系统滚动条那 6px 是**占位**的，
        360px 宽的面板里等于白白吃掉一列缩略图；这里换成 3px 覆盖式滑块，
        滚动本身（滚轮/键盘/惯性）仍然是原生行为（§10.5 滚动隔离、§10.6 细滚动条）。
        外层同时把 flex 交给 ScrollArea 自己的 .ec-scroll，面板才能正确收缩。
      */}
      <ScrollArea label={settingsVisible ? '设置' : '素材清单'}>
        <PanelBody
          settingsVisible={settingsVisible}
          settingsView={settingsView}
          blocker={blocker}
          snapshot={snapshot}
          completeness={completeness}
          {...(supportsMobileMode === undefined ? {} : { supportsMobileMode })}
          onCopy={onCopy}
          onBlockerAction={onBlockerAction}
          onRescan={onRescan}
        />

        {/* 功能标签：只有一个功能时不渲染（§8.5） */}
        {showBody ? (
          <FeatureTabs
            features={features}
            activeId={activeFeature ?? ''}
            onSelect={onSelectFeature}
          />
        ) : null}

        {/* 功能插槽 */}
        {showBody ? children : null}
      </ScrollArea>
    </dialog>
  );
}
