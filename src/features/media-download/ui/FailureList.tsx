import type { ErrorCode } from '../../../kernel/errors/codes';
import { errorMessage } from '../../../kernel/errors/messages';
import type { AssetKind } from '../../../kernel/model/asset';
import { Button } from '../../../kernel/ui-kit';
import { KIND_LABELS } from '../primary-action-model';

/**
 * 失败详情（§10.5「失败详情」：点附加说明里的“查看”，在面板内展开失败列表：
 * 文件名、原因、单项“重试”。**不使用弹窗**）。
 *
 * 原因一律从错误码查表（§6.2），永远不显示异常的 message —— 那是给开发者看的，
 * 用户看到的应该是「图片已失效」「网络不稳定」这种能理解的话。
 */
export interface FailureItem {
  itemKey: string;
  code: ErrorCode;
  /** 相对路径，例如 详情图/07.jpg；没有时退回显示 itemKey */
  path?: string;
}

export interface FailureListProps {
  items: FailureItem[];
  onRetry(itemKey: string): void;
  onRetryAll(): void;
  onClose(): void;
}

/** 从 itemKey 里取类别（itemKey 格式 kind:key，见 planner） */
export function kindOfItemKey(itemKey: string): AssetKind | null {
  const head = itemKey.split(':')[0];
  if (head === 'main' || head === 'sku' || head === 'detail' || head === 'video') return head;
  return null;
}

/** 失败项显示的名字：优先用落盘路径，否则用类别加 key */
export function failureLabel(item: FailureItem): string {
  if (item.path !== undefined && item.path !== '') return item.path;
  const kind = kindOfItemKey(item.itemKey);
  return kind === null
    ? item.itemKey
    : `${KIND_LABELS[kind]} ${item.itemKey.split(':')[1] ?? ''}`.trim();
}

export function FailureList({ items, onRetry, onRetryAll, onClose }: FailureListProps) {
  if (items.length === 0) return null;
  return (
    <section
      style={{ borderTop: '1px solid var(--ec-line)', padding: '8px 16px 12px' }}
      aria-label="失败列表"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 24,
          fontSize: 12,
          color: 'var(--ec-text-2)',
        }}
      >
        <span>{items.length} 个失败项</span>
        <span style={{ flex: 1 }} />
        <Button variant="link" onClick={onRetryAll}>
          重试全部
        </Button>
        <Button variant="link" onClick={onClose}>
          收起
        </Button>
      </div>
      {/* 失败列表也放进滚动区，几十个失败项时不会把面板撑爆 */}
      <div style={{ maxHeight: 160, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {items.map((item) => {
          const preset = errorMessage(item.code);
          return (
            <div
              key={item.itemKey}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                height: 32,
                fontSize: 12,
              }}
            >
              <span
                title={failureLabel(item)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'var(--ec-text)',
                }}
              >
                {failureLabel(item)}
              </span>
              <span style={{ color: 'var(--ec-text-2)', flex: 'none' }}>{preset.title}</span>
              <Button variant="link" onClick={() => onRetry(item.itemKey)}>
                重试
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
