import { Copy } from 'lucide-react';
import { useState } from 'react';
import type { DirState } from '../../../kernel/messaging/protocol';
import { IconButton, INLINE_ICON_SIZE, Tooltip } from '../../../kernel/ui-kit';

/**
 * ⑤ 保存位置（§10.3，高 32px）。
 *
 * 显示规则：路径从**中间省略**，保留开头的根目录名和结尾的商品 ID —— 这两段
 * 恰好是用户确认「存到哪」和「是不是这个商品」所需要的，中间的平台/模板部分省略掉。
 * 悬停显示完整路径。⧉ 复制路径（§10.5）：默认复制相对路径；
 * 设置里填了根目录绝对路径时复制完整路径，可以直接粘到资源管理器地址栏。
 *
 * 还没有选择目录时显示「还没有选择保存位置」，点击直接打开授权小窗。
 */
export interface SaveBarProps {
  dir: DirState;
  /** 商品文件夹的相对路径，例如 '电商素材\\拼多多\\夏季新款…_4823…' */
  relativePath: string;
  /** 设置里填的根目录绝对路径（可选，只用于复制完整路径） */
  rootPath?: string;
  onOpenGrant(): void;
  onCopy(text: string): void;
}

const COPY_FEEDBACK_MS = 1500;

/** 中间省略：保留头部 head 个字符和尾部 tail 个字符 */
export function middleEllipsis(text: string, head = 14, tail = 16): string {
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** 复制用的完整路径：有根目录绝对路径时拼上去（§10.5 复制路径） */
export function fullPathFor(rootPath: string | undefined, relativePath: string): string {
  if (rootPath === undefined || rootPath.trim() === '') return relativePath;
  const root = rootPath.trim().replace(/[\\/]+$/, '');
  return `${root}\\${relativePath}`;
}

export function SaveBar({ dir, relativePath, rootPath, onOpenGrant, onCopy }: SaveBarProps) {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void (async () => {
      await Promise.resolve(onCopy(fullPathFor(rootPath, relativePath)));
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    })();
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        height: 32,
        padding: '0 16px',
        borderTop: '1px solid var(--ec-line)',
      }}
    >
      <span style={{ fontSize: 12, color: 'var(--ec-text-3)', flex: 'none' }}>保存到</span>
      {dir.status === 'ready' ? (
        <>
          <Tooltip content={fullPathFor(rootPath, relativePath)}>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12,
                color: 'var(--ec-text-2)',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
                direction: 'ltr',
              }}
            >
              {middleEllipsis(relativePath)}
            </span>
          </Tooltip>
          <Tooltip content={copied ? '已复制' : '复制路径'}>
            <IconButton label="复制保存路径" className="ec-icon-btn--inline" onClick={copy}>
              {copied ? (
                <span style={{ fontSize: 12 }} aria-hidden="true">
                  ✓
                </span>
              ) : (
                <Copy size={INLINE_ICON_SIZE} strokeWidth={1.75} aria-hidden="true" />
              )}
            </IconButton>
          </Tooltip>
        </>
      ) : (
        // 还没有选择目录：整段可点，直接打开授权小窗（§10.3 ⑤）
        <button
          type="button"
          className="ec-btn ec-btn--link"
          onClick={onOpenGrant}
          style={{ flex: 1, textAlign: 'left' }}
        >
          {dir.status === 'unset'
            ? '还没有选择保存位置'
            : dir.status === 'needs-grant'
              ? `需要确认「${dir.name ?? '电商素材'}」的访问权限`
              : `找不到「${dir.name ?? '电商素材'}」文件夹`}
        </button>
      )}
    </div>
  );
}
