import { Copy } from 'lucide-react';
import { useState } from 'react';
import type { DirState } from '../../../kernel/messaging/protocol';
import { IconButton, INLINE_ICON_SIZE, Tooltip } from '../../../kernel/ui-kit';

/**
 * ⑤ 保存位置（§10.3，高 32px）。
 *
 * 显示规则：显示**根目录绝对路径**（设置里填的那个），而不是每件商品各自的相对路径 ——
 * 用户在这一行要回答的是「东西存到哪」，同一个根目录反复显示成不同的商品文件夹
 * 反而看不出这是设置项。没填绝对路径时退回商品文件夹的相对路径。
 * 悬停显示真正落盘的完整路径。⧉ 复制路径（§10.5）复制的也是完整路径。
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

/**
 * 「保存到」后面显示什么：根目录绝对路径优先。
 * 没填绝对路径时浏览器只能拿到文件夹名字，那就退回商品文件夹的相对路径，
 * 至少还能看出按「商品」归档的结构。
 */
export function saveTargetLabel(rootPath: string | undefined, relativePath: string): string {
  const root = rootPath?.trim() ?? '';
  return root === '' ? relativePath : root;
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
              {middleEllipsis(saveTargetLabel(rootPath, relativePath))}
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
