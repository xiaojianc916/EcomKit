import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScrollArea } from './ScrollArea';

/**
 * 自绘细滚动条（§10.6）。
 *
 * 为什么值得单独锁：滑块的高度和位置全靠 clientHeight / scrollHeight 算，
 * 而 happy-dom 没有布局引擎、这两个值恒为 0 —— 不 mock 的话组件永远认为「没溢出」，
 * 整条绘制路径根本不会被走到。所以每个用例都用 setBox 明确摆出滚动区高度与内容高度。
 */

/** happy-dom 没有布局，这两个只读属性只能自己定义 */
function setBox(el: Element, clientH: number, scrollH: number): void {
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientH });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollH });
}

/** 内层滚动元素：按 Panel 的既有契约（内联 overflowY === 'auto'）找，也是 mock 尺寸的对象 */
function getViewport(container: HTMLElement): HTMLElement {
  const viewport = Array.from(container.querySelectorAll('div')).find(
    (el) => el.style.overflowY === 'auto',
  );
  if (viewport === undefined) throw new Error('找不到滚动区');
  return viewport;
}

function getThumb(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.ec-scroll__thumb');
}

/**
 * 让组件那一帧的 measure 跑完。
 * 滚动只负责记下「要量」，真正的量在 rAF 里；happy-dom 的 rAF 是真定时器，
 * 所以这里等两拍（32ms 覆盖 60Hz 的一帧）。
 */
async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 32));
  });
}

/** 改滚动位置 → 触发 scroll → 等一帧量完 */
async function scrollTo(viewport: HTMLElement, scrollTop?: number): Promise<void> {
  if (scrollTop !== undefined) viewport.scrollTop = scrollTop;
  act(() => {
    fireEvent.scroll(viewport);
  });
  await flushFrame();
}

describe('ScrollArea', () => {
  // 注意：不要在这里统一 spy rAF —— 假定时器用例里「先 spy 再 useFakeTimers」会把 fake rAF 弄坏，
  // 需要断言的用例各自在本地 spy。
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('内层滚动区带 role、label，并内联 overflowY/overscrollBehavior（Panel 契约）', () => {
    const { container } = render(
      <ScrollArea label="素材清单">
        <p>一行</p>
      </ScrollArea>,
    );
    const viewport = getViewport(container);
    expect(viewport).toHaveAttribute('role', 'region');
    expect(viewport).toHaveAccessibleName('素材清单');
    // 这两条是 Panel 既有测试的查找依据，写进样式表就找不到了
    expect(viewport.style.overflowY).toBe('auto');
    expect(viewport.style.overscrollBehavior).toBe('contain');
    // 外层是滑块的定位容器
    expect(container.firstElementChild).toHaveClass('ec-scroll');
  });

  it('没有 label 时不渲染 aria-label（不留一个空名字）', () => {
    const { container } = render(
      <ScrollArea>
        <p>一行</p>
      </ScrollArea>,
    );
    expect(getViewport(container)).not.toHaveAttribute('aria-label');
  });

  it('内容不溢出时不画滑块（差 1px 也算不溢出）', async () => {
    const { container } = render(
      <ScrollArea label="素材清单">
        <p>一行</p>
      </ScrollArea>,
    );
    const viewport = getViewport(container);
    setBox(viewport, 400, 401);
    await scrollTo(viewport);
    expect(getThumb(container)).toBeNull();
  });

  it('溢出时滑块高度按比例算：max(24, clientH² / scrollH)', async () => {
    const { container } = render(
      <ScrollArea label="素材清单">
        <p>很多行</p>
      </ScrollArea>,
    );
    const viewport = getViewport(container);
    // 200² / 800 = 50px（可见部分占一半）
    setBox(viewport, 200, 800);
    await scrollTo(viewport);
    expect(getThumb(container)?.style.height).toBe('50px');
  });

  it('内容极长时滑块不低于 24px，否则既点不中也看不出比例', async () => {
    const { container } = render(
      <ScrollArea label="素材清单">
        <p>几千行</p>
      </ScrollArea>,
    );
    const viewport = getViewport(container);
    // 200² / 100000 = 0.4px
    setBox(viewport, 200, 100000);
    await scrollTo(viewport);
    expect(getThumb(container)?.style.height).toBe('24px');
  });

  it('滑块位置跟随 scrollTop，滚到底时正好贴住底部', async () => {
    const { container } = render(
      <ScrollArea label="素材清单">
        <p>很多行</p>
      </ScrollArea>,
    );
    const viewport = getViewport(container);
    setBox(viewport, 200, 800);
    await scrollTo(viewport);

    // 滑块 50px、行程 150px、可滚 600px；滚到 300（一半）→ top 75px
    await scrollTo(viewport, 300);
    expect(getThumb(container)?.style.top).toBe('75px');

    // 滚到底：滑块底边正好贴住容器底边（150 + 50 = 200），不能差一截
    await scrollTo(viewport, 600);
    expect(getThumb(container)?.style.top).toBe('150px');
  });

  it('pointer 拖拽滑块改变 scrollTop（按滑块行程换算，不是按内容比例）', async () => {
    const { container } = render(
      <ScrollArea label="素材清单">
        <p>很多行</p>
      </ScrollArea>,
    );
    const viewport = getViewport(container);
    setBox(viewport, 200, 800);
    await scrollTo(viewport);
    const thumb = getThumb(container);
    if (thumb === null) throw new Error('应该有滑块');

    // 指针下移 75px = 行程(150px)的一半 = 内容滚一半(300px)
    fireEvent.pointerDown(thumb, { pointerId: 1, button: 0, clientY: 100 });
    await act(async () => {
      fireEvent.pointerMove(document, { pointerId: 1, clientY: 175 });
    });
    expect(viewport.scrollTop).toBe(300);

    // 拖出下边界：夹到底，不会滚过头
    await act(async () => {
      fireEvent.pointerMove(document, { pointerId: 1, clientY: 9999 });
    });
    expect(viewport.scrollTop).toBe(600);

    // 松手后不再跟随指针
    fireEvent.pointerUp(document, { pointerId: 1, clientY: 9999 });
    await act(async () => {
      fireEvent.pointerMove(document, { pointerId: 1, clientY: 0 });
    });
    expect(viewport.scrollTop).toBe(600);
  });

  it('多滚几下只合并成一帧（滚动一次不重算一次）', async () => {
    const { container } = render(
      <ScrollArea label="素材清单">
        <p>很多行</p>
      </ScrollArea>,
    );
    const viewport = getViewport(container);
    setBox(viewport, 200, 800);
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
    act(() => {
      for (let i = 0; i < 5; i += 1) fireEvent.scroll(viewport);
    });
    // 5 个 scroll 事件压成 1 帧：否则高刷屏/精密触控板每帧会重算好几次
    expect(rafSpy).toHaveBeenCalledTimes(1);
    await flushFrame();
  });

  it('卸载时取消还没执行的那一帧，不在已卸载组件上 setState', () => {
    const { container, unmount } = render(
      <ScrollArea label="素材清单">
        <p>很多行</p>
      </ScrollArea>,
    );
    const viewport = getViewport(container);
    setBox(viewport, 200, 800);
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
    const cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');
    act(() => {
      fireEvent.scroll(viewport);
    });
    expect(rafSpy).toHaveBeenCalledTimes(1);
    const frame = rafSpy.mock.results[0]?.value as number;
    unmount();
    expect(cafSpy).toHaveBeenCalledWith(frame);
  });

  it('滚动时亮起、静止 800ms 后淡出；悬停期间不淡出', () => {
    // 显式列出要 fake 的定时器：rAF 也要受控，才能按毫秒精确推进
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
    });
    const { container } = render(
      <ScrollArea label="素材清单">
        <p>很多行</p>
      </ScrollArea>,
    );
    const viewport = getViewport(container);
    setBox(viewport, 200, 800);
    act(() => {
      fireEvent.scroll(viewport);
    });
    // 16ms 是 fake rAF 的一帧
    act(() => {
      vi.advanceTimersByTime(16);
    });
    const thumb = getThumb(container);
    expect(thumb).toHaveAttribute('data-visible', 'true');

    // 倒计时从滚动那一刻算起 800ms：16 + 783 = 799，还差 1ms
    act(() => {
      vi.advanceTimersByTime(783);
    });
    expect(thumb).toHaveAttribute('data-visible', 'true');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(thumb).toHaveAttribute('data-visible', 'false');

    // 鼠标停在滚动区上：滑块必须重新亮起
    fireEvent.pointerEnter(container.firstElementChild as HTMLElement);
    expect(thumb).toHaveAttribute('data-visible', 'true');
  });

  it('拖拽期间滑块不会淡出', () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
    });
    const { container } = render(
      <ScrollArea label="素材清单">
        <p>很多行</p>
      </ScrollArea>,
    );
    const viewport = getViewport(container);
    setBox(viewport, 200, 800);
    act(() => {
      fireEvent.scroll(viewport);
    });
    act(() => {
      vi.advanceTimersByTime(16);
    });
    const thumb = getThumb(container);
    if (thumb === null) throw new Error('应该有滑块');
    fireEvent.pointerDown(thumb, { pointerId: 1, button: 0, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // 正在拖的时候滑块消失是最难受的一种「手滑」
    expect(thumb).toHaveAttribute('data-visible', 'true');
    expect(thumb).toHaveAttribute('data-dragging', 'true');
    fireEvent.pointerUp(document, { pointerId: 1, clientY: 10 });
  });

  it('滑块是装饰：aria-hidden，且不抢键盘焦点', async () => {
    const { container } = render(
      <ScrollArea label="素材清单">
        <p>很多行</p>
      </ScrollArea>,
    );
    const viewport = getViewport(container);
    setBox(viewport, 200, 800);
    await scrollTo(viewport);
    const thumb = getThumb(container);
    expect(thumb).toHaveAttribute('aria-hidden', 'true');
    // 键盘滚动靠内层元素本身，滑块不该进 Tab 序列
    expect(thumb?.hasAttribute('tabindex')).toBe(false);
  });

  it('className / style 透传到外层容器（接线方要能控制外边距）', () => {
    const { container } = render(
      <ScrollArea label="素材清单" className="extra" style={{ paddingTop: 4 }}>
        <p>一行</p>
      </ScrollArea>,
    );
    const outer = container.firstElementChild as HTMLElement;
    expect(outer).toHaveClass('ec-scroll');
    expect(outer).toHaveClass('extra');
    expect(outer.style.paddingTop).toBe('4px');
  });
});
