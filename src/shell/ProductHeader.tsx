import { Copy } from 'lucide-react';
import { useState } from 'react';
import type { ProductSnapshot } from '../kernel/model/product';
import { IconButton, INLINE_ICON_SIZE, Thumb, Tooltip } from '../kernel/ui-kit';

/**
 * ② 商品信息区（§10.3，高 72px）。
 *
 * 这一块只回答一个问题：「认出来的是不是我正在看的这个商品」。
 * 所以给的是主图缩略图、能看两行的标题、商品 ID 和复制按钮 ——
 * 不放店铺、价格这些和「下载什么」无关的信息。
 *
 * 高 72px  = 上下 12px 留白 + 48px 主图（§10.3 ②）
 */
export interface ProductHeaderProps {
  snapshot: ProductSnapshot;
  onCopy(text: string): void;
}

/** 复制后图标变对勾 1.5 秒（§10.5 复制路径同款反馈） */
export const COPY_FEEDBACK_MS = 1500;

export function ProductHeader({ snapshot, onCopy }: ProductHeaderProps) {
  const [copied, setCopied] = useState(false);
  const preview = snapshot.assets.find((a) => a.kind === 'main')?.preview;

  const copyId = (): void => {
    void (async () => {
      await Promise.resolve(onCopy(snapshot.productId));
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    })();
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        height: 72,
        padding: '12px 16px',
      }}
    >
      <Thumb {...(preview === undefined ? {} : { src: preview })} alt="商品主图" size={48} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* 标题最多两行，超出省略；悬停显示全文（§10.3 ②） */}
        <Tooltip content={snapshot.title}>
          <div
            title={snapshot.title}
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              fontSize: 14,
              fontWeight: 600,
              lineHeight: '20px',
              maxHeight: 40,
              color: 'var(--ec-text)',
            }}
          >
            {snapshot.title}
          </div>
        </Tooltip>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
          <span style={{ fontSize: 12, color: 'var(--ec-text-2)' }} className="ec-num">
            ID {snapshot.productId}
          </span>
          <Tooltip content={copied ? '已复制' : '复制商品 ID'}>
            <IconButton label="复制商品 ID" className="ec-icon-btn--inline" onClick={copyId}>
              {copied ? (
                <span style={{ fontSize: 12 }} aria-hidden="true">
                  ✓
                </span>
              ) : (
                <Copy size={INLINE_ICON_SIZE} strokeWidth={1.75} aria-hidden="true" />
              )}
            </IconButton>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
