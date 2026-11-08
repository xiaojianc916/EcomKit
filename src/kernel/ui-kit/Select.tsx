import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortalTarget } from './PortalRoot';

/**
 * 下拉选择（设置页 / 面板设置视图共用）。
 *
 * 为什么不用原生 <select>：它的弹出列表由操作系统绘制，CSS 完全够不到 ——
 * 在深浅色主题下是另一套配色，和面板的 --ec-* 令牌对不上。
 * 这里用「按钮 + 自绘 listbox」实现，弹层和面板用同一套令牌。
 *
 * **弹层必须 portal 出去**：面板的滚动区是 overflow: auto，直接在里面绝对定位
 * 会被裁掉 —— 第三个选项就看不见了。这里挂到 portalContainer（shadow root /
 * body），再按按钮的位置自己算坐标，并夹在视口内。
 *
 * a11y：combobox + listbox 语义、方向键/Home/End/Enter/Esc、点外部关闭，
 * 按 WAI-ARIA 的下拉列表模式实现。
 */
export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  options: readonly SelectOption[];
  onChange(value: string): void;
  /** 读屏器用的名字（视觉上的标签由调用方另外渲染） */
  label: string;
  id?: string;
}

/** 弹层与按钮的间距 */
const OFFSET = 4;

interface Placement {
  left: number;
  top: number;
  width: number;
  /** 向上展开（空间不够时翻转），动画和圆角要跟着变 */
  flipped: boolean;
}

export function Select({ value, options, onChange, label, id }: SelectProps) {
  const [open, setOpen] = useState(false);
  /** 当前用键盘高亮的那一项；-1 表示还没用键盘移动过 */
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const portalTarget = usePortalTarget();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : options[0];

  /** 按按钮位置算弹层坐标；下方放不下就翻到上方 */
  const measure = useCallback(() => {
    const root = rootRef.current;
    if (root === null) return;
    const rect = root.getBoundingClientRect();
    const estimated = options.length * 32 + 12;
    const below = window.innerHeight - rect.bottom;
    const flipped = below < estimated && rect.top > below;
    setPlacement({
      left: rect.left,
      top: flipped ? rect.top - estimated - OFFSET : rect.bottom + OFFSET,
      width: rect.width,
      flipped,
    });
  }, [options.length]);

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (option !== undefined) onChange(option.value);
      close();
    },
    [onChange, options, close],
  );

  // 展开时先量一次位置，再在滚动/resize 时跟着走（面板本身可滚动）
  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const onScrollOrResize = (): void => measure();
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, measure]);

  // 点面板外面关掉：pointerdown 比 click 早，能赶在页面自己的点击处理之前收起
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      // 必须走 composedPath，不能用 event.target 判断。
      // 面板在 shadow root 里，弹层也 portal 到同一个 shadow root ——
      // 事件穿透 shadow 边界后，document 上看到的 target 会被重定向成 shadow host
      // （<ecbox-root>），两个 contains() 永远为 false：手指一按下，列表先被收掉，
      // 后面的 click 到不了选项上。表现就是「点下拉选项没反应、值不变」。
      const path = event.composedPath();
      if (rootRef.current !== null && path.includes(rootRef.current)) return;
      if (listRef.current !== null && path.includes(listRef.current)) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, close]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Escape' && open) {
      // 两层都要：stopPropagation 防面板把 Esc 当成「收起面板」，
      // preventDefault 是给调用方/测试一个「这个 Esc 已经被下拉吃掉了」的信号
      event.stopPropagation();
      event.preventDefault();
      close();
      return;
    }
    if (!open) {
      // 关闭状态：下箭头 / 回车 / 空格展开
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setOpen(true);
        setActive(Math.max(selectedIndex, 0));
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.max(Math.min(i + 1, options.length - 1), 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.min(Math.max(i - 1, 0), options.length - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      commit(active >= 0 ? active : selectedIndex);
    }
  };

  const list =
    open && placement !== null
      ? createPortal(
          <div
            ref={listRef}
            className="ec-select__list"
            role="listbox"
            id={listId}
            aria-label={label}
            // fixed 定位 + 按按钮的真实视口坐标：面板滚动时跟着走，也不会被 overflow 裁掉
            style={{
              left: placement.left,
              top: placement.top,
              width: placement.width,
            }}
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className="ec-select__option"
                data-active={index === active ? 'true' : undefined}
                // 悬停/键盘高亮时把焦点留在按钮上，避免 blur 抢在 click 之前把列表收起
                onMouseEnter={() => setActive(index)}
                onClick={() => commit(index)}
              >
                {option.label}
              </button>
            ))}
          </div>,
          portalTarget ?? document.body,
        )
      : null;

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        id={id}
        onKeyDown={onKeyDown}
        className="ec-select"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-haspopup="listbox"
        onClick={() => {
          setOpen((v) => !v);
          setActive(Math.max(selectedIndex, 0));
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {selected?.label ?? ''}
        </span>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {list}
    </div>
  );
}
