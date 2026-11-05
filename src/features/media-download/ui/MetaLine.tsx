import type { PrimaryActionModel } from '../primary-action-model';

/**
 * ⑦ 附加说明（§10.3）。
 *
 * 只在需要时出现：历史记录、部分数据加载超时、H.265 提示、失败原因。最多两行。
 * 单独成组件是因为主按钮、素材行、面板底部三处都可能要显示同一句说明，
 * 而它们的样式必须一致 —— 用户不应该在两处看到两种写法的「上次下载于…」。
 */
export interface MetaLineProps {
  model?: PrimaryActionModel;
  /** 额外的说明行（例如「部分数据加载超时，素材可能不完整」） */
  lines?: string[];
}

export function MetaLine({ model, lines }: MetaLineProps) {
  const merged = [...(model?.meta ?? []), ...(lines ?? [])].slice(0, 2);
  if (merged.length === 0) return null;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
        padding: '0 16px 8px',
        fontSize: 12,
        lineHeight: '16px',
        color: 'var(--ec-text-2)',
      }}
    >
      {merged.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  );
}
