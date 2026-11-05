import type { ReactNode } from 'react';
import { useState } from 'react';

/**
 * 缩略图（§10.3 素材行 32px、缩略图网格 72px）。
 *
 * 三条规则来自方案：
 * - 用平台小图（asset.preview）懒加载，省流量（§10.3 图片懒加载）。
 * - 页面 CSP 可能拦图，加载失败时显示灰色占位块加序号，不影响下载（§10.10 最后一行）。
 * - 网格格子左下角显示序号（和最终文件名一致），选中时左上角显示对勾。
 */
export interface ThumbProps {
  src?: string;
  alt: string;
  /** 边长 px：行内 32、网格 72 */
  size: number;
  /** 格子左下角的序号，和最终文件名一致 */
  index?: string;
  /** 左上角小字，例如 H.265 */
  corner?: string;
  selected?: boolean;
  children?: ReactNode;
}

export function Thumb({ src, alt, size, index, corner, selected = false, children }: ThumbProps) {
  const [failed, setFailed] = useState(false);
  const showPlaceholder = src === undefined || failed;
  return (
    <span
      className={`ec-thumb${showPlaceholder ? ' ec-thumb--failed' : ''}`}
      style={{
        width: size,
        height: size,
        ...(selected ? { boxShadow: 'inset 0 0 0 2px var(--ec-accent)' } : {}),
      }}
      data-selected={selected ? 'true' : undefined}
    >
      {showPlaceholder ? null : (
        <img
          className="ec-thumb__img"
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
      {index === undefined ? null : <span className="ec-thumb__index">{index}</span>}
      {corner === undefined ? null : (
        <span className="ec-thumb__corner ec-thumb__corner--left">{corner}</span>
      )}
      {children}
    </span>
  );
}
