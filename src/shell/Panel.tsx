import { ChevronRight, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import type { RegisteredFeature } from '../features/types';
import type { ErrorCode } from '../kernel/errors/codes';
import type { ProductSnapshot } from '../kernel/model/product';
import { Tooltip } from '../kernel/ui-kit';
import { type BlockerActionId, BlockerNotice } from './BlockerNotice';
import { FeatureTabs } from './FeatureTabs';
import { ProductHeader } from './ProductHeader';

/**
 * 面板（§10.2 面板形态、§10.3 布局）。
 *
 * 布局尺寸严格按 §10.3：
 *   ① 标题栏 40px  ② 商品信息 72px  ③ 区块标题 28px（在功能块内）
 *   ④ 素材清单每行 48px（在功能块内）  ⑤ 保存位置 32px  ⑥ 主按钮 36px  ⑦ 附加说明
 *
 * 几条必须在这里落实的规则：
 * - 宽 360px，贴在右侧，距离右边缘 16px；顶部和把手对齐。
 * - 最大高度 100vh − 96px，超出部分**面板内部滚动**；滚动区 overscroll-behavior: contain，
 *   在面板里滚动不会带动页面（§10.5 滚动隔离）。
 * - 标题栏**不能拖动**（§10.3 ①）：避免和点击冲突。
 * - Esc 收起面板（§10.5 键盘操作）。按键只在本面板内处理，不劫持页面。
 * - 面板展开时从右侧滑入，160ms ease-out（§10.6 动效）。
 */
export interface PanelViewProps {
  platformName: string;
  platformColor?: string;
  platformRing?: string;
  snapshot: ProductSnapshot | null;
  blocker: ErrorCode | null;
  completeness: 'full' | 'partial';
  /** 顶部对齐的把手位置 */
  top: number;
  features: RegisteredFeature[];
  activeFeature: string | null;
  onSelectFeature(id: string): void;
  onClose(): void;
  onOpenOptions(): void;
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

export function Panel({
  platformName,
  platformColor,
  platformRing,
  snapshot,
  blocker,
  completeness,
  top,
  features,
  activeFeature,
  onSelectFeature,
  onClose,
  onOpenOptions,
  onCopy,
  onBlockerAction,
  supportsMobileMode,
  onRescan,
  children,
  autoFocus = false,
}: PanelViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Esc 收起面板（§10.5）。只在本面板有焦点时生效，不抢页面的 Esc。
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

  const showContent = snapshot !== null && blocker === null;
  // 阻断时 ② 之外的部分全部隐藏（§10.4「阻断和异常」）
  const showBody = showContent;

  return (
    <div
      ref={rootRef}
      className="ec-panel ec-root"
      role="dialog"
      aria-label="素材下载面板"
      tabIndex={-1}
      style={{
        position: 'fixed',
        right: PANEL_GAP,
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
        border: '1px solid var(--ec-line)',
        borderRadius: 10,
        background: 'var(--ec-bg)',
        boxShadow: '0 8px 24px rgba(15, 20, 30, .12), 0 0 0 1px rgba(15, 20, 30, .06)',
        overflow: 'hidden',
        outline: 'none',
      }}
    >
      {/* ① 标题栏 40px，不能拖动（§10.3 ①） */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 40,
          padding: '0 8px 0 16px',
          borderBottom: '1px solid var(--ec-line)',
          flex: 'none',
        }}
      >
        {platformColor === undefined ? null : (
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: platformColor,
              ...(platformRing === undefined ? {} : { boxShadow: `0 0 0 1px ${platformRing}` }),
            }}
          />
        )}
        {/* 不写产品名：用户知道自己装的是什么（§10.3 ①） */}
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ec-text)' }}>
          {platformName}
        </span>
        <span style={{ flex: 1 }} />
        <Tooltip content="打开设置">
          <button
            type="button"
            className="ec-icon-btn"
            aria-label="打开设置"
            onClick={onOpenOptions}
          >
            <Settings size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip content="收起到边缘 · Alt+Shift+E">
          <button type="button" className="ec-icon-btn" aria-label="收起到边缘" onClick={onClose}>
            <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>

      {/* ①之后：滚动区，overscroll-behavior: contain（§10.5 滚动隔离） */}
      <div
        style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
        {blocker !== null ? (
          <BlockerNotice
            code={blocker}
            onAction={(action) => {
              // 「重新识别」是外壳的动作，其余交给上层按错误码处理（§10.4）
              if (action === 'rescan') onRescan();
              else onBlockerAction(action);
            }}
            {...(supportsMobileMode === undefined ? {} : { supportsMobileMode })}
            extraAction={{ id: 'rescan', label: '重新识别' }}
          />
        ) : snapshot === null ? (
          <div style={{ padding: '12px 16px 16px', fontSize: 13, color: 'var(--ec-text-2)' }}>
            正在识别商品…
          </div>
        ) : (
          <>
            {/* ② 商品信息 72px */}
            <ProductHeader snapshot={snapshot} onCopy={onCopy} />
            {/* 部分超时：不阻断，只在附加说明里说一句（§10.4 最后一行） */}
            {completeness === 'partial' ? (
              <div
                style={{
                  padding: '0 16px 8px',
                  fontSize: 12,
                  color: 'var(--ec-text-2)',
                }}
              >
                部分数据加载超时，素材可能不完整
              </div>
            ) : null}
          </>
        )}

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
      </div>
    </div>
  );
}
