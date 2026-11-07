import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HandleBadge } from './store';
import { clampHandleY, HANDLE_MIN_Y, isDrag } from './store';

/**
 * 收起后的贴边把手（§10.2「把手」形态）。
 *
 * 它大多数时候只是被瞟一眼，所以整块要读起来是一枚**小标签**，而不是一块按钮：
 * - 面 --ec-bg，边只画朝向页面的三条（贴边那侧不画），页面上就剩一道 8px 圆角；
 * - 数字 12/600 是唯一的重音，「素材」10/400 退成注释，两行之间只留 4px；
 * - 下载中只在底部多一道 16px 的细下划线，不改变标签高度；
 * - 需要处理不加红点：把手只有 30px 宽，第二个圆点会变成第二个重点，数字转 --ec-danger 就够；
 * - 悬停只加深底色：贴着页边的控件一做位移/缩放，视线就会被拽过去。
 *
 * side 把「靠哪边、缺哪条边、哪两个角圆」一起镜像 —— 左侧停靠时这几样必须同时翻，
 * 否则会出现「圆角留在贴边侧」这种一眼假的错位。
 *
 * 拖动：>4px 才算拖动，否则算点击（§10.2）。用 pointer 事件而不是 mouse 事件，
 * 这样触屏板/触屏笔记本也能拖。拖动过程不写存储，松手才写 —— 否则每移动一像素
 * 都往 chrome.storage 写一次。
 */
export interface HandleProps {
  y: number;
  badge: HandleBadge;
  viewportHeight: number;
  onDragEnd(y: number): void;
  onClick(): void;
  /** 贴哪一侧，默认右侧（§10.2）；左侧停靠时圆角/边框/进度一起镜像 */
  side?: 'left' | 'right';
}

/** 30px 宽：刚好放得下「100%」（12px/600 收 0.4 字距），再宽就成了一块牌子 */
export const HANDLE_WIDTH = 30;

/**
 * 下载中的细条：16px 长、2px 高，压在标签底部。
 *
 * 不用「贴边 2px 从顶部按百分比长」那种画法：2px 的竖条紧贴着数字，42% 时高得快
 * 和数字平齐，看起来像一个括号，比数字还抢眼。横条读起来只是这枚标签的一道下划线。
 *
 * 绝对定位而不是排进文档流：下载开始/结束不能让标签高度变一次，
 * 把手在页面上突然长高两像素，比进度条本身更扎眼。
 */
const PROGRESS_BAR = { width: 16, height: 2, bottom: 6 } as const;

/** 数字是这枚标签唯一的重音：12/600，字距收 0.4 —— 百分比最多四个字符，宽度得算着来 */
const NUMBER_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: '16px',
  fontWeight: 600,
  // 收 0.4px 字距 + 不换行：「100%」量出来 30.08px，比 29px 的内容宽度还宽一点点
  letterSpacing: '-0.4px',
  whiteSpace: 'nowrap',
  color: 'var(--ec-text)',
};

/**
 * 贴边决定的三处不对称：靠哪边、缺哪条边、哪两个角是圆的。
 * 收在一处算，别让 side 在 JSX 里散成好几个三元表达式。
 */
function dockStyle(side: 'left' | 'right'): {
  edge: CSSProperties;
  borderWidth: string;
  borderRadius: string;
} {
  return side === 'left'
    ? {
        edge: { left: 0 },
        // 上右下三条边，左（贴边那侧）不画
        borderWidth: '1px 1px 1px 0',
        borderRadius: '0 8px 8px 0',
      }
    : {
        edge: { right: 0 },
        borderWidth: '1px 0 1px 1px',
        borderRadius: '8px 0 0 8px',
      };
}

/** 百分比夹到 0–100：进度来自任务记录，重算或补推时可能越界 */
function clampPercent(percent: number): number {
  return Math.round(Math.max(0, Math.min(100, percent)));
}

export function Handle({
  y,
  badge,
  viewportHeight,
  onDragEnd,
  onClick,
  side = 'right',
}: HandleProps) {
  const [dragY, setDragY] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focusVisible, setFocusVisible] = useState(false);
  const startRef = useRef<{ pointerY: number; originY: number; moved: boolean } | null>(null);
  /**
   * 拖动位置一帧最多更新一次。
   *
   * 真实边界：高刷屏 / 精密触控板把 pointermove 推到 120–240Hz，而屏幕只刷新 60–120Hz。
   * 每个 pointermove 都 setDragY 的话，一帧内会做几次**白做**的渲染（React 合并了 setState，
   * 但事件回调、clampHandleY、样式对象都白算）。用 rAF 把同一帧的多次移动压成一次，
   * 拖动只跟渲染帧对齐，手感不变而渲染次数减半以上。
   */
  const frameRef = useRef<number | null>(null);
  const pendingYRef = useRef<number | null>(null);

  const flushDragFrame = useCallback(() => {
    frameRef.current = null;
    const next = pendingYRef.current;
    pendingYRef.current = null;
    if (next !== null) setDragY(next);
  }, []);

  // 卸载时取消还没执行的那一帧，避免对已卸载组件 setState
  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      pendingYRef.current = null;
    };
  }, []);

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
      pendingYRef.current = clampHandleY(start.originY + dy, viewportHeight);
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(flushDragFrame);
    },
    [viewportHeight, flushDragFrame],
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
      // 拖动中可能还有一帧没画完，松手时按真实指针位置收尾并丢掉那一帧
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      pendingYRef.current = null;
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
  const dock = dockStyle(side);

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
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
        pendingYRef.current = null;
        setDragY(null);
      }}
      // 悬停/焦点用状态而不是 :hover / :focus-visible：样式全在行内，没有可加的样式表
      // 触屏的 pointerenter 在抬手后不会补一个 leave，底牌会一直停在深色上，所以只认鼠标
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      // 鼠标点出来的焦点同样会触发 focus，只有键盘进来的才该描边，所以问一下浏览器的判定
      onFocus={(event) => setFocusVisible(event.currentTarget.matches(':focus-visible'))}
      onBlur={() => setFocusVisible(false)}
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed',
        top: currentY,
        ...dock.edge,
        zIndex: 2147483647,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        // 宽度定死、高度让内容撑（两种行数都只有两行，状态切换不会让标签忽高忽低）
        boxSizing: 'border-box',
        width: HANDLE_WIDTH,
        padding: '12px 0',
        borderStyle: 'solid',
        borderColor: 'var(--ec-line)',
        borderWidth: dock.borderWidth,
        borderRadius: dock.borderRadius,
        background: hovered ? 'var(--ec-bg-subtle)' : 'var(--ec-bg)',
        /*
         * 只有一层很轻的投影：把手体量就小，再叠第二层会比面板还重。
         * 颜色写死是因为令牌里没有这个高度的阴影 —— --ec-shadow-panel 是两层带描边的面板影，
         * 在 30px 宽的小标签上直接糊成一块脏边。要收口就补一条 --ec-shadow-handle，别在别处复制。
         */
        boxShadow: '0 2px 8px rgba(15, 20, 30, .08)',
        color: 'var(--ec-text-3)',
        fontFamily: 'var(--ec-font)',
        cursor: dragY === null ? 'pointer' : 'grabbing',
        touchAction: 'none',
        // 拖动时不要有文字选择
        userSelect: 'none',
        outlineStyle: focusVisible ? 'solid' : 'none',
        outlineWidth: 2,
        outlineColor: 'var(--ec-accent)',
        // 和 .ec-btn / .ec-icon-btn 同一套焦点环（2px accent、外扩 1px）：面板里的键盘焦点长一个样
        outlineOffset: 1,
        // 过渡**不写在这里**：行内样式永远压过样式表，写在这儿的话
        // ui-kit.css 里那条 prefers-reduced-motion 就再没机会生效。
        // 「拖动中不要过渡」改由 data-dragging 交给样式表处理。
      }}
      data-dragging={dragY === null ? undefined : 'true'}
    >
      {/* 三种角标共用 16px 行高：否则「识别中」的转圈和数字会让整枚标签上下跳 */}
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 16 }}>
        {renderBadge(badge)}
      </span>
      {/* 标签压暗一档（继承按钮的 --ec-text-3），字距收 0.2px：两个字读成一块，不是一个词一个字 */}
      <span style={{ fontSize: 10, lineHeight: '14px', letterSpacing: '-0.2px' }}>素材</span>
      {badge.kind === 'progress' ? (
        // 下载中：底部一道 16px 的细条，和面板里的 .ec-progress 同款（线底 + 强调色填充）
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            bottom: PROGRESS_BAR.bottom,
            left: 0,
            right: 0,
            margin: '0 auto',
            width: PROGRESS_BAR.width,
            height: PROGRESS_BAR.height,
            borderRadius: 1,
            background: 'var(--ec-line)',
            pointerEvents: 'none',
          }}
        >
          <span
            style={{
              display: 'block',
              width: `${clampPercent(badge.percent)}%`,
              height: '100%',
              borderRadius: 1,
              background: 'var(--ec-accent)',
              transition: 'width 200ms linear',
            }}
          />
        </span>
      ) : null}
    </button>
  );
}

/** 数字 / 对勾 / 转圈：只画视觉，读屏器的名字由按钮的 aria-label 统一给 */
function renderBadge(badge: HandleBadge): ReactNode {
  if (badge.kind === 'resolving') {
    // 12px 旋转指示器，没有数字（§10.2）。用 CSS 动画而不是整段 SVG
    return (
      <span
        aria-hidden="true"
        style={{
          width: 12,
          height: 12,
          borderRadius: '50%',
          border: '1.5px solid var(--ec-line)',
          borderTopColor: 'var(--ec-text-3)',
          animation: 'ec-spin 900ms linear infinite',
        }}
      />
    );
  }
  if (badge.kind === 'progress') {
    return (
      <span className="ec-num" style={NUMBER_STYLE}>
        {badge.percent}%
      </span>
    );
  }
  if (badge.kind === 'done') {
    return (
      <span aria-hidden="true" style={{ ...NUMBER_STYLE, fontSize: 13 }}>
        ✓
      </span>
    );
  }
  if (badge.kind === 'attention') {
    // 有失败时仍然显示总数；不加红点，数字本身换成 danger 色就是这一枚标签能给的最高音量
    return (
      <span className="ec-num" style={{ ...NUMBER_STYLE, color: 'var(--ec-danger)' }}>
        {badge.count > 0 ? badge.count : '!'}
      </span>
    );
  }
  return (
    <span className="ec-num" style={NUMBER_STYLE}>
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
