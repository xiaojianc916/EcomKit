import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PortalRoot } from './PortalRoot';
import { Select } from './Select';

/**
 * 自绘下拉（设置页的「保存方式 / 进入商品页时 / 主题」）。
 *
 * 为什么值得单独锁：换成自绘组件就是为了摆脱原生 <select> 的弹出层，
 * 但弹层一旦自己画，开关、键盘、选中回写这些行为都得自己保证 ——
 * 少一条就是「点了没反应」或「键盘操作不了」。
 */
const OPTIONS = [
  { value: 'a', label: '选项 A' },
  { value: 'b', label: '选项 B' },
  { value: 'c', label: '选项 C' },
];

describe('Select', () => {
  it('收起时只显示当前值，点开才出现列表', () => {
    render(<Select label="测试" value="b" options={OPTIONS} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: '测试' })).toHaveTextContent('选项 B');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: '测试' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('点选项回写值并收起', () => {
    const onChange = vi.fn();
    render(<Select label="测试" value="a" options={OPTIONS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: '测试' }));
    fireEvent.click(screen.getByRole('option', { name: '选项 C' }));
    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('当前值标记 aria-selected', () => {
    render(<Select label="测试" value="b" options={OPTIONS} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox', { name: '测试' }));
    expect(screen.getByRole('option', { name: '选项 B' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: '选项 A' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('键盘：↓ 展开、↓ 移动、Enter 选中（不依赖鼠标）', () => {
    const onChange = vi.fn();
    render(<Select label="测试" value="a" options={OPTIONS} onChange={onChange} />);
    const box = screen.getByRole('combobox', { name: '测试' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('Esc 收起列表，且不把事件继续冒泡（否则面板会跟着收起）', () => {
    render(<Select label="测试" value="a" options={OPTIONS} onChange={vi.fn()} />);
    const box = screen.getByRole('combobox', { name: '测试' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    // fireEvent 的返回值是 false 表示事件被 preventDefault/stopPropagation 拦下了
    const notCanceled = fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(notCanceled).toBe(false);
  });

  it('弹层挂到 body（portal），不会被面板的 overflow 裁掉', () => {
    render(<Select label="测试" value="a" options={OPTIONS} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox', { name: '测试' }));
    const list = screen.getByRole('listbox');
    // 挂在 body 下而不是组件自己的容器里：面板滚动区是 overflow:auto，留在里面会被裁
    expect(list.parentElement).toBe(document.body);
    // 坐标由组件按按钮位置算好写进 style（fixed 定位在 .ec-select__list 类里）
    expect(list).toHaveClass('ec-select__list');
    expect(list.style.left).not.toBe('');
    expect(list.style.top).not.toBe('');
  });

  it('展开时 aria-expanded 为 true（边框强调色靠这个属性切换）', () => {
    render(<Select label="测试" value="a" options={OPTIONS} onChange={vi.fn()} />);
    const box = screen.getByRole('combobox', { name: '测试' });
    expect(box).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(box);
    expect(box).toHaveAttribute('aria-expanded', 'true');
  });

  it('面板（shadow root）里点选项不收起列表、能选中 —— 只认 target 会在真实浏览器里失效', () => {
    /*
      真实浏览器里，事件穿过 shadow 边界后 document 上的 listener 拿到的
      `event.target` 会被重定向成宿主元素（<ecbox-root>），而 `composedPath()`
      仍是真实链路。旧实现用 `target` + contains 判断「点在不在列表里」，
      两个 contains 永远为 false → pointerdown 先把列表收掉 → click 到不了选项，
      表现为「点下拉选项没反应、值不变」。
      happy-dom 不做重定向，所以这里手动构造 document 视角的事件来锁这条契约。
    */
    const onChange = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    // RTL 的 within 只声明了 HTMLElement，实现上就是 querySelectorAll，ShadowRoot 同样适用
    const inShadow = within(shadow as unknown as HTMLElement);
    render(
      <PortalRoot value={shadow}>
        <Select label="测试" value="a" options={OPTIONS} onChange={onChange} />
      </PortalRoot>,
    );
    fireEvent.click(screen.getByRole('combobox', { name: '测试' }));
    const option = inShadow.getByRole('option', { name: '选项 C' });
    const list = inShadow.getByRole('listbox');

    const retargeted = new Event('pointerdown', { bubbles: true, composed: true });
    Object.defineProperty(retargeted, 'target', { value: host });
    Object.defineProperty(retargeted, 'composedPath', {
      value: () => [option, list, shadow, host, document.body, document],
    });
    act(() => {
      document.dispatchEvent(retargeted);
    });

    // 列表没被收起 → 选项还在，点击能回写
    expect(inShadow.getByRole('listbox')).toBeInTheDocument();
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('c');
  });
});
