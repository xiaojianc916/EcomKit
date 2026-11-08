import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import type { DirState } from '../../../kernel/messaging/protocol';
import { IconButton, INLINE_ICON_SIZE, Tooltip } from '../../../kernel/ui-kit';

/**
 * ⑤ 保存位置（§10.3，高 32px）。
 *
 * 显示规则：「根文件夹名 \ 商品文件夹」—— 根文件夹名是用户在授权小窗里**真正选中的**
 * 那个目录（浏览器只知道名字），商品文件夹是按模板生成的子目录。
 * 手填的根目录绝对路径和这个名字对得上时说明两者是同一处，才显示成 D:\test\…（见 saveTargetPath）。
 * 悬停和复制给出完整绝对路径：设置里填了根目录绝对路径就拼上，没填就只给相对部分。
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
 * 「保存到」后面显示什么：**用户在授权小窗里真正选中的那个文件夹**，加上商品子文件夹。
 *
 * 为什么不用设置里手填的「根目录绝对路径」：那是给「复制完整路径」用的辅助输入，
 * 用户实际用 FSA 选的是哪个文件夹，浏览器只知道它的**名字**（dir.name），
 * 手填的路径完全可能是另一回事 —— 拿它当保存位置显示就是在骗人。
 * 手填路径只有在名字对得上时才拿来显示（见 saveTargetPath），否则仍然悬停和复制才用（见 fullPathFor）。
 */
export function saveTargetLabel(rootName: string | undefined, relativePath: string): string {
  const name = rootName?.trim() ?? '';
  if (name === '') return relativePath;
  // Windows 资源管理器里看到的层级就是这个形状
  return `${name}\\${relativePath}`;
}

/** 路径最后一段：手填的 D:\test\ 和浏览器给的文件夹名 test 是同一处的判据 */
export function baseName(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}

/**
 * 「保存到」这一行最终显示什么。
 *
 * 手填路径的最后一段和浏览器给的文件夹名一致，说明设的就是用户选的那个目录，
 * 显示完整路径才能看到盘符（D:\test\…）；不一致时仍只显示名字 —— 拿另一个目录的路径冒充保存位置就是骗人。
 */
export function saveTargetPath(
  rootName: string | undefined,
  relativePath: string,
  rootPath: string | undefined,
): string {
  const root = rootPath?.trim().replace(/[\\/]+$/, '') ?? '';
  const name = rootName?.trim() ?? '';
  // 大小写不敏感：Windows 路径本来就不区分大小写
  if (root !== '' && name !== '' && baseName(root).toLowerCase() === name.toLowerCase()) {
    return fullPathFor(root, relativePath);
  }
  return saveTargetLabel(name, relativePath);
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
              {middleEllipsis(saveTargetPath(dir.name, relativePath, rootPath))}
            </span>
          </Tooltip>
          <Tooltip content={copied ? '已复制' : '复制路径'}>
            <IconButton label="复制保存路径" className="ec-icon-btn--inline" onClick={copy}>
              {copied ? (
                <Check size={INLINE_ICON_SIZE} strokeWidth={1.75} aria-hidden="true" />
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
