import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 * 下拉选择（设置页 / 面板设置视图共用）。
 *
 * 为什么不用原生 <select>：它的弹出列表由操作系统绘制，CSS 完全够不到 ——
 * 在深浅色主题下是另一套配色，和面板的 --ec-* 令牌对不上（截图里那个蓝底白字的菜单）。
 * 这里用「按钮 + 自绘 listbox」实现，弹层和面板用同一套令牌，展开时的边框色也由我们定。
 *
 * a11y：combobox + listbox 的语义、方向键/Home/End/Enter/Esc、点外部关闭都按 WAI-ARIA
 * 的下拉列表模式实现；弹层**不做 portal**，就地绝对定位 —— 设置项只有 2~3 个选项，
 * 不存在被裁掉的问题，而 portal 进 shadow root 反而要额外处理定位和层级。
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

export function Select({ value, options, onChange, label, id }: SelectProps) {
  const [open, setOpen] = useState(false);
  /** 当前用键盘高亮的那一项；-1 表示还没用键盘移动过 */
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : options[0];

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (option !== undefined) onChange(option.value);
      setOpen(false);
      setActive(-1);
    },
    [onChange, options],
  );

  // 点面板外面关掉：pointerdown 比 click 早，能赶在页面自己的点击处理之前收起
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return;
      setOpen(false);
      setActive(-1);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Escape' && open) {
      // 两层都要：stopPropagation 防面板把 Esc 当成「收起面板」，
      // preventDefault 是给调用方/测试一个「这个 Esc 已经被下拉吃掉了」的信号
      event.stopPropagation();
      event.preventDefault();
      setOpen(false);
      setActive(-1);
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

      {open ? (
        <div className="ec-select__list" role="listbox" id={listId} aria-label={label}>
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
        </div>
      ) : null}
    </div>
  );
}
