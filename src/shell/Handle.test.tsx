import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HANDLE_WIDTH, Handle, handleLabel } from './Handle';
import type { HandleBadge } from './store';

/**
 * 把手的视觉契约（§10.2）。
 *
 * shell.test.tsx 里那几条管的是「文案和行为不能变」（点/拖/键盘/读屏器名字），
 * 这份补的是这次重做**新立下**的规矩：少一个元素、贴边镜像、进度不许改变标签高度。
 * 两份分开，改视觉时不会不小心把行为断言一起改掉。
 *
 * 颜色一律读内联 style 而不是 toHaveStyle：令牌是 var(--ec-*)，happy-dom 的
 * getComputedStyle 不解析 var()，走计算样式会永远拿到空值。
 */

const base = {
  y: 200,
  viewportHeight: 900,
  onDragEnd: vi.fn(),
  onClick: vi.fn(),
};

function renderHandle(badge: HandleBadge, side?: 'left' | 'right') {
  return render(<Handle {...base} badge={badge} {...(side === undefined ? {} : { side })} />);
}

/** 把手本体：整块样式的落点 */
function handleButton(): HTMLElement {
  return screen.getByRole('button');
}

/** 下载中那条 16×2 的细条（装饰层，aria-hidden） */
function progressTrack(container: HTMLElement): HTMLElement | null {
  return (
    container.querySelector<HTMLElement>('button > span[aria-hidden="true"] > span')
      ?.parentElement ?? null
  );
}

/** 细条里按百分比填充的那一段 */
function progressFill(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('button > span[aria-hidden="true"] > span');
}

describe('Handle 视觉（§10.2）', () => {
  it('就绪时只有数字和「素材」两行，没有第三个元素', () => {
    renderHandle({ kind: 'count', count: 48 });
    expect(screen.getByText('48')).toBeInTheDocument();
    expect(screen.getByText('素材')).toBeInTheDocument();
    // 角标行 + 标签行；平台色点、右上角红点、整条渐变进度都是这次拿掉的东西
    expect(handleButton().children.length).toBe(2);
  });

  it('不再有平台色点：贴边标签里没有任何彩色圆点', () => {
    const { container } = renderHandle({ kind: 'count', count: 12 });
    // 色点是绝对定位的 6px 圆点；现在整枚标签只剩两行文字
    expect(container.querySelectorAll('span[style*="border-radius: 50%"]').length).toBe(0);
  });

  it('需要处理时数字转 danger 色，而不是再加一个红点', () => {
    const { container } = renderHandle({ kind: 'attention', count: 3 });
    expect(screen.getByText('3').style.color).toBe('var(--ec-danger)');
    // 只有数字这一处 danger；红点会是第二处
    expect(container.querySelectorAll('[style*="ec-danger"]').length).toBe(1);
    expect(handleButton().children.length).toBe(2);
  });

  it('没有失败项时显示「!」而不是 0', () => {
    renderHandle({ kind: 'attention', count: 0 });
    expect(screen.getByText('!')).toBeInTheDocument();
  });

  it('宽度定死 30px、高度让内容撑，且不用 rem（§10.6 尺寸全部用 px）', () => {
    renderHandle({ kind: 'count', count: 48 });
    const button = handleButton();
    expect(button.style.width).toBe(`${HANDLE_WIDTH}px`);
    expect(button.style.width).not.toContain('rem');
    // 高度自适应：写死高度会让「识别中 → 数字」这种切换底部对齐方式变来变去
    expect(button.style.height).toBe('');
  });

  it('数字 12/600 主文字色，标签 10/400 降一档（读出主次，而不是两个重点）', () => {
    renderHandle({ kind: 'count', count: 48 });
    const number = screen.getByText('48');
    expect(number).toHaveStyle({ fontSize: '12px', fontWeight: '600' });
    expect(number.style.color).toBe('var(--ec-text)');
    // 标签 10px，字重不另写 —— 继承 .ec-root 的 400，和数字的 600 自然拉开
    const label = screen.getByText('素材');
    expect(label).toHaveStyle({ fontSize: '10px' });
    expect(label.style.fontWeight).toBe('');
    // 标签比数字暗一档：靠继承拿 --ec-text-3，不另写颜色
    expect(handleButton().style.color).toBe('var(--ec-text-3)');
  });

  it('面是 --ec-bg，贴边那侧不画边，只留一层浅阴影', () => {
    renderHandle({ kind: 'count', count: 48 });
    const button = handleButton();
    expect(button.style.background).toBe('var(--ec-bg)');
    expect(button.style.borderWidth).toBe('1px 0px 1px 1px');
    expect(button.style.borderStyle).toBe('solid');
    expect(button.style.borderColor).toBe('var(--ec-line)');
    expect(button.style.borderRadius).toBe('8px 0px 0px 8px');
    // 只有一层：第二层影子会让这一小块比面板还重
    expect(button.style.boxShadow).toBe('0 2px 8px rgba(15, 20, 30, .08)');
  });

  it('悬停只加深底色，不做位移/缩放', () => {
    renderHandle({ kind: 'count', count: 48 });
    const button = handleButton();
    fireEvent.pointerEnter(button);
    expect(button.style.background).toBe('var(--ec-bg-subtle)');
    expect(button.style.transform).toBe('');
    fireEvent.pointerLeave(button);
    expect(button.style.background).toBe('var(--ec-bg)');
  });

  it('键盘焦点给 2px accent 外描边（和面板里的按钮同一套）', () => {
    renderHandle({ kind: 'count', count: 48 });
    const button = handleButton();
    // 鼠标点出来的焦点不该描边：拿浏览器自己的 :focus-visible 判定
    expect(button.style.outlineStyle).toBe('none');
    act(() => button.focus());
    expect(button.style.outlineStyle).toBe('solid');
    expect(button.style.outlineWidth).toBe('2px');
    expect(button.style.outlineColor).toBe('var(--ec-accent)');
    act(() => button.blur());
    expect(button.style.outlineStyle).toBe('none');
  });
});

describe('Handle 贴边方向（side）', () => {
  it('默认靠右：right 0、left 不写，圆角在左侧', () => {
    renderHandle({ kind: 'count', count: 48 });
    const button = handleButton();
    expect(button.style.right).toBe('0px');
    expect(button.style.left).toBe('');
    expect(button.style.borderRadius).toBe('8px 0px 0px 8px');
    expect(button.style.borderWidth).toBe('1px 0px 1px 1px');
  });

  it('左侧停靠：left 0、right 不写，圆角/缺边一起翻过来', () => {
    renderHandle({ kind: 'count', count: 48 }, 'left');
    const button = handleButton();
    expect(button.style.left).toBe('0px');
    expect(button.style.right).toBe('');
    expect(button.style.borderRadius).toBe('0px 8px 8px 0px');
    // 贴边（左）那条不画，剩下三条
    expect(button.style.borderWidth).toBe('1px 1px 1px 0px');
  });

  it('两种贴边下文字和 aria-label 一致', () => {
    for (const side of ['left', 'right'] as const) {
      const { unmount } = renderHandle({ kind: 'count', count: 7 }, side);
      expect(screen.getByText('7')).toBeInTheDocument();
      expect(screen.getByText('素材')).toBeInTheDocument();
      expect(handleButton()).toHaveAttribute('aria-label', '素材面板：7 个素材');
      unmount();
    }
  });
});

describe('Handle 下载进度（§10.2）', () => {
  it('百分比照常显示，进度是一条 16×2 的下划线，不是整条竖条', () => {
    const { container } = renderHandle({ kind: 'progress', percent: 42 });
    expect(screen.getByText('42%')).toBeInTheDocument();
    // 不要再出现「整条铺满」的渐变
    expect(container.innerHTML).not.toContain('linear-gradient');
    const track = progressTrack(container);
    expect(track).not.toBeNull();
    expect(track?.style.width).toBe('16px');
    expect(track?.style.height).toBe('2px');
  });

  it('进度条绝对定位：下载开始/结束不能让标签高度跟着变一次', () => {
    const ready = renderHandle({ kind: 'count', count: 3 });
    const padding = handleButton().style.padding;
    ready.unmount();

    const { container } = renderHandle({ kind: 'progress', percent: 10 });
    expect(progressTrack(container)?.style.position).toBe('absolute');
    expect(handleButton().style.height).toBe('');
    // 底板不能靠加内边距给它腾位置，否则整枚标签会高两像素
    expect(handleButton().style.padding).toBe(padding);
  });

  it('百分比越界时进度条收在 0–100 之间', () => {
    const low = renderHandle({ kind: 'progress', percent: -20 });
    expect(progressFill(low.container)?.style.width).toBe('0%');
    low.unmount();
    const high = renderHandle({ kind: 'progress', percent: 140 });
    expect(progressFill(high.container)?.style.width).toBe('100%');
  });
});

describe('Handle 读屏器名字（handleLabel）', () => {
  const badges: HandleBadge[] = [
    { kind: 'resolving' },
    { kind: 'count', count: 48 },
    { kind: 'progress', percent: 52 },
    { kind: 'done' },
    { kind: 'attention', count: 2 },
    { kind: 'attention', count: 0 },
  ];

  for (const badge of badges) {
    it(`${badge.kind} 的 aria-label 以「素材面板：」开头`, () => {
      renderHandle(badge);
      expect(handleButton()).toHaveAttribute('aria-label', handleLabel(badge));
      expect(handleButton().getAttribute('aria-label')).toMatch(/^素材面板：/);
    });
  }
});

describe('Handle 交互回归（§10.2）', () => {
  it('空格键等同点击（Enter 之外的第二条键盘路径）', () => {
    const onClick = vi.fn();
    render(<Handle {...base} badge={{ kind: 'count', count: 5 }} onClick={onClick} />);
    fireEvent.keyDown(handleButton(), { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('方向键向下同样移动 16px', () => {
    const onDragEnd = vi.fn();
    render(<Handle {...base} badge={{ kind: 'count', count: 5 }} onDragEnd={onDragEnd} />);
    fireEvent.keyDown(handleButton(), { key: 'ArrowDown' });
    expect(onDragEnd).toHaveBeenCalledWith(216);
  });

  it('拖动中关掉过渡（不追指针），松手才写回位置', async () => {
    const onDragEnd = vi.fn();
    const onClick = vi.fn();
    render(
      <Handle
        {...base}
        badge={{ kind: 'count', count: 5 }}
        onDragEnd={onDragEnd}
        onClick={onClick}
      />,
    );
    const button = handleButton();
    // 过渡本身写在 ui-kit.css 的 .ec-handle 里（行内样式会压掉 prefers-reduced-motion），
    // 组件只负责在拖动期间挂上 data-dragging，由那条属性选择器把 transition 关掉。
    expect(button.style.transition).toBe('');
    expect(button.hasAttribute('data-dragging')).toBe(false);
    fireEvent.pointerDown(button, { button: 0, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(button, { clientY: 240, pointerId: 1 });
    // 拖动位置一帧刷一次，等这一帧落地
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
    expect(button.getAttribute('data-dragging')).toBe('true');
    fireEvent.pointerUp(button, { clientY: 240, pointerId: 1 });
    expect(button.hasAttribute('data-dragging')).toBe(false);
    expect(onDragEnd).toHaveBeenCalledWith(240);
    expect(onClick).not.toHaveBeenCalled();
  });
});
