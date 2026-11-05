import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useCallback, useRef, useState } from 'react';
import type { HandleBadge } from './store';
import { clampHandleY, HANDLE_MIN_Y, isDrag } from './store';

/**
 * 把手（§10.2「把手」形态）。
 *
 * 尺寸和外观：32×88px，贴右侧边缘，左侧两个角 8px 圆角。
 * 从上到下：平台色点（6px）→ 数字 → 「素材」两个字。
 *
 * 拖动：>4px 才算拖动，否则算点击（§10.2）。用 pointer 事件而不是 mouse 事件，
 * 这样触屏板/触屏笔记本也能拖。拖动过程不写存储，松手才写 —— 否则每移动一像素
 * 都往 chrome.storage 写一次。
 *
 * 下载中把手左边缘有一条 2px 的竖向进度条（§10.2）。
 */
export interface HandleProps {
  y: number;
  badge: HandleBadge;
  /** 平台色点颜色；未知平台时不画色点 */
  platformColor?: string;
  /** 抖音的深色点需要一圈描边才看得见（§10.6 平台色点） */
  platformRing?: string;
  viewportHeight: number;
  onDragEnd(y: number): void;
  onClick(): void;
}

const HANDLE_WIDTH = 32;
const HANDLE_HEIGHT = 88;

export function Handle({
  y,
  badge,
  platformColor,
  platformRing,
  viewportHeight,
  onDragEnd,
  onClick,
}: HandleProps) {
  const [dragY, setDragY] = useState<number | null>(null);
  const startRef = useRef<{ pointerY: number; originY: number; moved: boolean } | null>(null);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      // 只响应主键，避免右键菜单触发拖动
      if (event.button !== 0) return;
      startRef.current = { pointerY: event.clientY, originY: y, moved: false };
      // 指针捕获让快速拖动时事件仍然回到把手本身；环境不支持时忽略（测试环境里没有）
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // 某些环境（无真实指针）会抛 InvalidStateError，不影响点击
      }
    },
    [y],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const start = startRef.current;
      if (!start) return;
      const dy = event.clientY - start.pointerY;
      if (!start.moved && !isDrag(0, dy)) return;
      start.moved = true;
      setDragY(clampHandleY(start.originY + dy, viewportHeight));
    },
    [viewportHeight],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const start = startRef.current;
      startRef.current = null;
      try {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch {
        // 同上：不支持指针捕获时忽略
      }
      if (!start) return;
      if (start.moved) {
        const finalY = clampHandleY(
          start.originY + (event.clientY - start.pointerY),
          viewportHeight,
        );
        setDragY(null);
        onDragEnd(finalY);
        return;
      }
      setDragY(null);
      // 没超过 4px：算点击（§10.2）
      onClick();
    },
    [onClick, onDragEnd, viewportHeight],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onClick();
        return;
      }
      // 键盘也能移动把手：上下方向键移动 16px
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const delta = event.key === 'ArrowUp' ? -16 : 16;
        onDragEnd(clampHandleY(y + delta, viewportHeight));
      }
    },
    [onClick, onDragEnd, viewportHeight, y],
  );

  const currentY = dragY ?? y;

  return (
    <button
      type="button"
      className="ec-handle ec-root"
      aria-label={handleLabel(badge)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        startRef.current = null;
        setDragY(null);
      }}
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed',
        right: 0,
        top: currentY,
        zIndex: 2147483647,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        width: HANDLE_WIDTH,
        height: HANDLE_HEIGHT,
        padding: 0,
        border: '1px solid var(--ec-line)',
        borderRight: 'none',
        borderRadius: '8px 0 0 8px',
        background: 'var(--ec-bg)',
        boxShadow: '0 4px 12px rgba(15, 20, 30, .10)',
        color: 'var(--ec-text-2)',
        fontFamily: 'var(--ec-font)',
        cursor: dragY === null ? 'pointer' : 'grabbing',
        touchAction: 'none',
        transition: dragY === null ? 'top 160ms ease-out' : 'none',
        // 拖动时不要有文字选择
        userSelect: 'none',
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
      {renderBadge(badge)}
      <span style={{ fontSize: 12, lineHeight: '16px', letterSpacing: 1 }}>素材</span>
      {badge.kind === 'progress' ? (
        // 下载中：左边缘 2px 的竖向进度条（§10.2）
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 2,
            borderRadius: '8px 0 0 8px',
            background: `linear-gradient(to bottom, var(--ec-accent) ${badge.percent}%, transparent ${badge.percent}%)`,
          }}
        />
      ) : null}
      {badge.kind === 'attention' ? (
        // 需要处理：右上角 6px 红点（§10.2）
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--ec-danger)',
          }}
        />
      ) : null}
    </button>
  );
}

function renderBadge(badge: HandleBadge): ReactNode {
  if (badge.kind === 'resolving') {
    // 14px 旋转指示器，没有数字（§10.2）。用 CSS 动画而不是整段 SVG
    return (
      <span
        aria-hidden="true"
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: '2px solid var(--ec-line)',
          borderTopColor: 'var(--ec-text-3)',
          animation: 'ec-spin 900ms linear infinite',
        }}
      />
    );
  }
  if (badge.kind === 'progress') {
    return (
      <span
        className="ec-num"
        style={{ fontSize: 12, lineHeight: '16px', color: 'var(--ec-text)' }}
      >
        {badge.percent}%
      </span>
    );
  }
  if (badge.kind === 'done') {
    return (
      <span
        aria-hidden="true"
        style={{ fontSize: 14, lineHeight: '16px', color: 'var(--ec-text)' }}
      >
        ✓
      </span>
    );
  }
  if (badge.kind === 'attention') {
    // 有失败时仍然显示总数，红点单独标出来
    return (
      <span
        className="ec-num"
        style={{ fontSize: 14, lineHeight: '16px', fontWeight: 600, color: 'var(--ec-text)' }}
      >
        {badge.count > 0 ? badge.count : '!'}
      </span>
    );
  }
  return (
    <span
      className="ec-num"
      style={{ fontSize: 14, lineHeight: '16px', fontWeight: 600, color: 'var(--ec-text)' }}
    >
      {badge.count}
    </span>
  );
}

/** 把手对读屏器的名字：说清楚当前状态，而不只是一个数字 */
export function handleLabel(badge: HandleBadge): string {
  switch (badge.kind) {
    case 'resolving':
      return '素材面板：正在识别商品';
    case 'progress':
      return `素材面板：下载中 ${badge.percent}%`;
    case 'done':
      return '素材面板：下载完成';
    case 'attention':
      return badge.count > 0 ? `素材面板：有 ${badge.count} 个失败项` : '素材面板：需要处理';
    case 'count':
      return `素材面板：${badge.count} 个素材`;
  }
}

/** 把手位置的下界，Shell 里算初始位置时用（和管理函数同源） */
export { HANDLE_MIN_Y };
