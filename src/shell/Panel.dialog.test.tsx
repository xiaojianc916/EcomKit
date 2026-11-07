import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Panel, type PanelViewProps } from './Panel';

/**
 * 面板的原生 dialog 语义（§10.3 布局、§10.5 键盘操作、§10.9 组件树）。
 *
 * 面板以前是 <div role="dialog">：读屏器能拿到 role，但焦点容器、Esc 的 cancel 语义
 * 全要手写。换成原生 <dialog> 之后这些由元素负责，这里锁住三条：
 *  1. 真的是 <dialog>，并且**非模态**打开（页面其余部分不能被变成 inert，
 *     否则用户面板开着就点不了页面，验收项 A17「面板不抢页面快捷键和滚动」也会挂）；
 *  2. 有可访问名称，读屏器能念出「素材下载面板 / 素材下载设置」；
 *  3. Esc 收起面板这条行为在换标签后不变。
 */
function renderPanel(overrides: Partial<PanelViewProps> = {}) {
  const props: Omit<PanelViewProps, 'children'> = {
    platformName: '拼多多',
    platformColor: '#E02E24',
    snapshot: null,
    blocker: null,
    completeness: 'full' as const,
    top: 120,
    features: [],
    activeFeature: null,
    onSelectFeature: vi.fn(),
    onClose: vi.fn(),
    view: 'assets',
    onOpenSettings: vi.fn(),
    onCloseSettings: vi.fn(),
    settingsView: <div>设置内容</div>,
    onCopy: vi.fn(),
    onBlockerAction: vi.fn(),
    onRescan: vi.fn(),
    ...overrides,
  };
  return render(
    <Panel {...props}>
      <div>功能内容</div>
    </Panel>,
  );
}

describe('Panel（原生 dialog）', () => {
  it('面板是 <dialog>，并且是非模态打开（不调用 showModal）', () => {
    // showModal() 会把宿主页面其余部分变成 inert：用户在面板开着时点不了页面、
    // 滚不动页面，验收项 A17「面板不抢页面快捷键和滚动」直接挂。
    // 测试环境不实现 :modal 选择器，所以这里直接盯住「有没有调过 showModal」。
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const show = vi.spyOn(HTMLDialogElement.prototype, 'show');
    try {
      renderPanel();
      const dialog = screen.getByRole('dialog');
      expect(dialog.tagName).toBe('DIALOG');
      expect(dialog).toHaveAttribute('open');
      expect(showModal).not.toHaveBeenCalled();
      // 同时也不靠 effect 里调 show()：open 属性在首帧就在，面板不会先闪一下空白
      expect(show).not.toHaveBeenCalled();
    } finally {
      showModal.mockRestore();
      show.mockRestore();
    }
  });

  it('素材视图和设置视图各有可访问名称', () => {
    const { unmount } = renderPanel();
    expect(screen.getByRole('dialog', { name: '素材下载面板' })).toBeInTheDocument();
    unmount();

    renderPanel({ view: 'settings' });
    expect(screen.getByRole('dialog', { name: '素材下载设置' })).toBeInTheDocument();
  });

  it('Esc 收起面板，且不把 Esc 冒泡给宿主页面', () => {
    const onClose = vi.fn();
    const onPageKeyDown = vi.fn();
    document.addEventListener('keydown', onPageKeyDown);
    try {
      renderPanel({ onClose });
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(onClose).toHaveBeenCalled();
      // 面板内的 Esc 由面板吃掉（stopPropagation），宿主页面的 Esc 快捷键不受影响
      expect(onPageKeyDown).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onPageKeyDown);
    }
  });

  it('打开时有明确关闭控件（标题栏的「收起到边缘」）', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: '收起到边缘' })).toBeInTheDocument();
  });
});
