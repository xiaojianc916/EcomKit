import type { ReactNode } from 'react';
import type { ErrorCode } from '../kernel/errors/codes';
import type { ProductSnapshot } from '../kernel/model/product';
import { type BlockerActionId, BlockerNotice } from './BlockerNotice';
import { ProductHeader } from './ProductHeader';

/**
 * 面板滚动区里「② 商品信息 / 阻断 / 识别中 / 设置视图」这一段（§10.3、§10.4）。
 *
 * 从 Panel 里拆出来：四种状态是互斥的早返回，放在一起比嵌套三元好读；
 * 功能标签和功能插槽不在这里 —— 它们由 Panel 决定要不要渲染（blocked 时整块隐藏）。
 *
 * 设置视图不依赖商品数据：识别失败 / 阻断时也要能进去改设置（保存方式选错了正是原因之一）。
 */
export interface PanelBodyProps {
  settingsVisible: boolean;
  settingsView: ReactNode;
  blocker: ErrorCode | null;
  snapshot: ProductSnapshot | null;
  completeness: 'full' | 'partial';
  supportsMobileMode?: boolean;
  onCopy(text: string): void;
  onBlockerAction(action: BlockerActionId): void;
  onRescan(): void;
}

export function PanelBody({
  settingsVisible,
  settingsView,
  blocker,
  snapshot,
  completeness,
  supportsMobileMode,
  onCopy,
  onBlockerAction,
  onRescan,
}: PanelBodyProps) {
  if (settingsVisible) return <>{settingsView}</>;

  if (blocker !== null) {
    return (
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
    );
  }

  if (snapshot === null) {
    return (
      <div style={{ padding: '12px 16px 16px', fontSize: 13, color: 'var(--ec-text-2)' }}>
        正在识别商品…
      </div>
    );
  }

  return (
    <>
      {/* ② 商品信息 72px */}
      <ProductHeader snapshot={snapshot} onCopy={onCopy} />
      {/* 部分超时：不阻断，只在附加说明里说一句（§10.4 最后一行） */}
      {completeness === 'partial' ? (
        <div style={{ padding: '0 16px 8px', fontSize: 12, color: 'var(--ec-text-2)' }}>
          部分数据加载超时，素材可能不完整
        </div>
      ) : null}
    </>
  );
}
