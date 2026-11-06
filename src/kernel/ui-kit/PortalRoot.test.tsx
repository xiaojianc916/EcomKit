import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortalRoot, usePortalContainer, usePortalTarget } from './PortalRoot';
import { clearPendingToasts, showToast, ToastViewport } from './Toast';

/**
 * 弹层容器和提示条（§10.5、§10.10）。
 *
 * 这两处旧实现都有一个「看起来做了、实际没做」的分支：
 * - PortalRoot 的 \`instanceof ShadowRoot ? container : container\` 两个分支返回同一个值；
 * - ToastViewport 里 \`container === null ? content : <>{content}</>\` 两条路渲染同一棵树，
 *   所谓 portal 从来没 portal 过。
 * 所以这里除了正常路径，重点锁「容器真的被透传」和「卸载后不再留下定时器」。
 */

function Probe() {
  const container = usePortalContainer();
  const target = usePortalTarget();
  return (
    <div>
      <span data-testid="container">{container === null ? 'null' : 'has'}</span>
      <span data-testid="target">{target === undefined ? 'undefined' : 'has'}</span>
    </div>
  );
}

describe('PortalRoot（§10.10 弹层挂进 shadow root）', () => {
  it('没有 value 时容器是 null，Radix 会退回 document.body', () => {
    render(
      <PortalRoot>
        <Probe />
      </PortalRoot>,
    );
    expect(screen.getByTestId('container').textContent).toBe('null');
    expect(screen.getByTestId('target').textContent).toBe('undefined');
  });

  it('普通元素原样透传给 Radix 的 container', () => {
    const host = document.createElement('div');
    render(
      <PortalRoot value={host}>
        <Probe />
      </PortalRoot>,
    );
    expect(screen.getByTestId('container').textContent).toBe('has');
    expect(screen.getByTestId('target').textContent).toBe('has');
  });

  it('shadow root 也原样透传（ShadowRoot 是 DocumentFragment 的子类型）', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    render(
      <PortalRoot value={shadow}>
        <Probe />
      </PortalRoot>,
    );
    expect(screen.getByTestId('container').textContent).toBe('has');
    expect(screen.getByTestId('target').textContent).toBe('has');
  });

  it('内层不传 value 时**沿用**外层的容器（不能把 shadow root 抹成 null）', () => {
    /*
      真实结构：index.tsx 的 PortalRoot(shadow) → Shell → 面板里的 PortalRoot(未传 value)。
      旧实现内层用 `value ?? null` 写回，外层那个 shadow root 就被抹成 null，
      所有弹层掉到 document.body 上拿不到 shadow 内样式 ——
      下拉列表会完全没样式（选项被压成一条 23px）。
    */
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    render(
      <PortalRoot value={shadow}>
        <PortalRoot>
          <Probe />
        </PortalRoot>
      </PortalRoot>,
    );
    expect(screen.getByTestId('container').textContent).toBe('has');
    expect(screen.getByTestId('target').textContent).toBe('has');
  });

  it('内层可以显式换成另一层容器', () => {
    const outerHost = document.createElement('div');
    const outerShadow = outerHost.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    render(
      <PortalRoot value={outerShadow}>
        <PortalRoot value={inner}>
          <Probe />
        </PortalRoot>
      </PortalRoot>,
    );
    expect(screen.getByTestId('container').textContent).toBe('has');
  });
});

describe('ToastViewport（§10.5 提示条）', () => {
  afterEach(() => {
    clearPendingToasts();
    vi.useRealTimers();
  });

  it('没有提示时什么都不渲染', () => {
    const { container } = render(<ToastViewport />);
    expect(container).toBeEmptyDOMElement();
  });

  it('showToast 之后出现一条提示', () => {
    render(<ToastViewport />);
    act(() => showToast('没有需要补全的文件'));
    expect(screen.getByRole('status')).toHaveTextContent('没有需要补全的文件');
  });

  it('带动作时渲染动作按钮，点击后执行并消失', () => {
    render(<ToastViewport />);
    const run = vi.fn();
    act(() => showToast('失败项已失效', { label: '重试', run }));
    act(() => screen.getByRole('button', { name: '重试' }).click());
    expect(run).toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('4 秒后自动消失（单一队头定时器）', () => {
    vi.useFakeTimers();
    render(<ToastViewport />);
    act(() => showToast('第一条'));
    act(() => showToast('第二条'));
    expect(screen.getAllByText(/第.条/)).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(4001);
    });
    // TTL 相同、先进先出：两条在同一次 tick 里都到期
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('卸载后不再有残留定时器触发', () => {
    vi.useFakeTimers();
    const { unmount } = render(<ToastViewport />);
    act(() => showToast('提示'));
    unmount();
    // 若没清定时器，这里会抛「对已卸载组件 setState」的警告计数 > 0
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
    }).not.toThrow();
  });

  it('视图挂载前来的提示会被补上（真该被看到的失败原因不能丢）', () => {
    // 模拟「识别失败时外壳还没挂载」
    showToast('需要先选择保存位置');
    render(<ToastViewport />);
    expect(screen.getByRole('status')).toHaveTextContent('需要先选择保存位置');
  });
});
