import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fullPathFor, middleEllipsis } from '../features/media-download/ui/SaveBar';
import type { RegisteredFeature } from '../features/types';
import type { ProductSnapshot } from '../kernel/model/product';
import { BlockerNotice } from './BlockerNotice';
import { FeatureTabs, pickActiveFeature, shouldRenderTabs } from './FeatureTabs';
import { Handle, handleLabel } from './Handle';
import { Panel } from './Panel';
import { ProductHeader } from './ProductHeader';
import type { HandleBadge } from './store';

/**
 * 外壳组件测试：把手（§10.2）、面板（§10.3）、标签栏（§8.5）、
 * 商品信息（§10.3 ②）、阻断块（§10.4）。
 */

function snapshot(patch: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    platform: 'pinduoduo',
    pageKind: 'pdd.goods',
    productId: '482319937501',
    title: '夏季新款显瘦连衣裙女小个子法式复古方领泡泡袖碎花裙',
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=482319937501',
    skus: [],
    assets: [],
    sources: ['ssr'],
    completeness: 'full',
    capturedAt: 0,
    ...patch,
  };
}

describe('Handle（§10.2 把手）', () => {
  const base = {
    y: 200,
    viewportHeight: 900,
    onDragEnd: vi.fn(),
    onClick: vi.fn(),
  };

  it('就绪时显示素材总数', () => {
    render(<Handle {...base} badge={{ kind: 'count', count: 48 }} />);
    expect(screen.getByText('48')).toBeInTheDocument();
    expect(screen.getByText('素材')).toBeInTheDocument();
  });

  it('点击把手展开面板（按下和松开都在 4px 内算点击）', () => {
    const onClick = vi.fn();
    render(<Handle {...base} badge={{ kind: 'count', count: 48 }} onClick={onClick} />);
    const button = screen.getByRole('button', { name: handleLabel({ kind: 'count', count: 48 }) });
    fireEvent.pointerDown(button, { button: 0, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(button, { clientY: 202, pointerId: 1 });
    expect(onClick).toHaveBeenCalled();
  });

  it('拖动超过 4px 算拖动，不触发点击（§10.2）', () => {
    const onClick = vi.fn();
    const onDragEnd = vi.fn();
    render(
      <Handle
        {...base}
        badge={{ kind: 'count', count: 48 }}
        onClick={onClick}
        onDragEnd={onDragEnd}
      />,
    );
    const button = screen.getByRole('button');
    fireEvent.pointerDown(button, { button: 0, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(button, { clientY: 260, pointerId: 1 });
    fireEvent.pointerUp(button, { clientY: 260, pointerId: 1 });
    expect(onClick).not.toHaveBeenCalled();
    expect(onDragEnd).toHaveBeenCalledWith(260);
  });

  it('识别中显示旋转指示器，没有数字', () => {
    render(<Handle {...base} badge={{ kind: 'resolving' }} />);
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.getByRole('button', { name: /正在识别商品/ })).toBeInTheDocument();
  });

  it('下载中显示百分比', () => {
    render(<Handle {...base} badge={{ kind: 'progress', percent: 52 }} />);
    expect(screen.getByText('52%')).toBeInTheDocument();
  });

  it('完成显示对勾', () => {
    render(<Handle {...base} badge={{ kind: 'done' }} />);
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('需要处理时显示红点（元素存在）', () => {
    const { container } = render(<Handle {...base} badge={{ kind: 'attention', count: 3 }} />);
    expect(container.querySelectorAll('span').length).toBeGreaterThan(0);
  });

  it('键盘 Enter 展开（键盘可达）', () => {
    const onClick = vi.fn();
    render(<Handle {...base} badge={{ kind: 'count', count: 5 }} onClick={onClick} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    expect(onClick).toHaveBeenCalled();
  });

  it('键盘上下方向键移动把手，位置被夹在允许范围内（§10.2）', () => {
    const onDragEnd = vi.fn();
    render(<Handle {...base} badge={{ kind: 'count', count: 5 }} onDragEnd={onDragEnd} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'ArrowUp' });
    expect(onDragEnd).toHaveBeenCalledWith(184);
  });
});

describe('handleLabel', () => {
  const cases: [HandleBadge, string][] = [
    [{ kind: 'resolving' }, '素材面板：正在识别商品'],
    [{ kind: 'progress', percent: 52 }, '素材面板：下载中 52%'],
    [{ kind: 'done' }, '素材面板：下载完成'],
    [{ kind: 'attention', count: 2 }, '素材面板：有 2 个失败项'],
    [{ kind: 'count', count: 48 }, '素材面板：48 个素材'],
  ];
  for (const [badge, expected] of cases) {
    it(`${badge.kind} → ${expected}`, () => {
      expect(handleLabel(badge)).toBe(expected);
    });
  }
});

describe('Panel（§10.3 布局）', () => {
  function renderPanel(overrides: Record<string, unknown> = {}) {
    return render(
      <Panel
        platformName="拼多多"
        platformColor="#E02E24"
        snapshot={snapshot()}
        blocker={null}
        completeness="full"
        top={120}
        features={[]}
        activeFeature={null}
        onSelectFeature={vi.fn()}
        onClose={vi.fn()}
        view="assets"
        onOpenSettings={vi.fn()}
        onCloseSettings={vi.fn()}
        settingsView={<div>设置内容</div>}
        onCopy={vi.fn()}
        onBlockerAction={vi.fn()}
        onRescan={vi.fn()}
        {...overrides}
      >
        <div>功能内容</div>
      </Panel>,
    );
  }

  it('标题栏有平台名、设置和收起按钮，不写产品名（§10.3 ①）', () => {
    renderPanel();
    expect(screen.getByText('拼多多')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起到边缘' })).toBeInTheDocument();
    expect(screen.queryByText('电商素材工具箱')).toBeNull();
  });

  it('点 ⚙ 在面板里换成设置视图，不开新页面（§10.3）', () => {
    const onOpenSettings = vi.fn();
    renderPanel({ onOpenSettings });
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('设置视图沿用同一块面板：标题栏还在，内容换成设置，并能返回素材', () => {
    const onCloseSettings = vi.fn();
    const { container } = renderPanel({ view: 'settings', onCloseSettings });
    expect(container.querySelector('.ec-panel')).not.toBeNull();
    expect(screen.getByText('设置内容')).toBeInTheDocument();
    // 商品信息和素材插槽让位给设置
    expect(screen.queryByText('功能内容')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回素材' }));
    expect(onCloseSettings).toHaveBeenCalled();
  });

  it('收起到边缘按钮触发 onClose', () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.click(screen.getByRole('button', { name: '收起到边缘' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('Esc 收起面板（§10.5 键盘操作）', () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('商品信息区显示标题和商品 ID', () => {
    renderPanel();
    expect(
      screen.getByTitle('夏季新款显瘦连衣裙女小个子法式复古方领泡泡袖碎花裙'),
    ).toBeInTheDocument();
    expect(screen.getByText('ID 482319937501')).toBeInTheDocument();
  });

  it('复制商品 ID 触发 onCopy', () => {
    const onCopy = vi.fn();
    renderPanel({ onCopy });
    fireEvent.click(screen.getByRole('button', { name: '复制商品 ID' }));
    expect(onCopy).toHaveBeenCalledWith('482319937501');
  });

  it('功能内容渲染在面板里', () => {
    renderPanel();
    expect(screen.getByText('功能内容')).toBeInTheDocument();
  });

  it('阻断时替换商品信息区，并隐藏功能内容（§10.4）', () => {
    renderPanel({ blocker: 'LOGIN_REQUIRED', snapshot: null });
    expect(screen.getByText('需要先登录拼多多')).toBeInTheDocument();
    expect(screen.getByText('登录后刷新页面，就能识别商品')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新页面' })).toBeInTheDocument();
    expect(screen.queryByText('功能内容')).toBeNull();
  });

  it('面板宽度 360px，用 px 而不是 rem（§10.6、§10.10 第一个坑）', () => {
    const { container } = renderPanel();
    const panel = container.querySelector('.ec-panel') as HTMLElement;
    // 页面把 html 的 font-size 改成 20px 也不该影响面板尺寸
    document.documentElement.style.fontSize = '20px';
    expect(panel.style.width).toBe('360px');
    expect(panel.style.width).not.toContain('rem');
    document.documentElement.style.fontSize = '';
  });

  it('面板最大高度按 100vh − 96px 收（§10.2）', () => {
    const { container } = renderPanel();
    const panel = container.querySelector('.ec-panel') as HTMLElement;
    expect(panel.style.maxHeight).toBe('calc(100vh - 96px)');
  });

  it('面板滚动区设置 overscroll-behavior: contain（§10.5 滚动隔离）', () => {
    const { container } = renderPanel();
    const scroller = Array.from(container.querySelectorAll('div')).find(
      (el) => el.style.overflowY === 'auto',
    );
    expect(scroller?.style.overscrollBehavior).toBe('contain');
  });

  it('部分超时在附加说明里说一句，不阻断（§10.4）', () => {
    renderPanel({ completeness: 'partial' });
    expect(screen.getByText('部分数据加载超时，素材可能不完整')).toBeInTheDocument();
    expect(screen.getByText('功能内容')).toBeInTheDocument();
  });
});

describe('BlockerNotice（§10.4 阻断和异常表）', () => {
  it('需要登录：标题、说明、刷新按钮', () => {
    const onAction = vi.fn();
    render(<BlockerNotice code="LOGIN_REQUIRED" onAction={onAction} />);
    expect(screen.getByText('需要先登录拼多多')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新页面' }));
    expect(onAction).toHaveBeenCalledWith('refresh');
  });

  it('App 限制且平台不支持手机模式时不出“以手机模式重新打开”（Phase 0 结论）', () => {
    render(<BlockerNotice code="APP_ONLY" onAction={vi.fn()} supportsMobileMode={false} />);
    expect(screen.getByText('抖音限制了电脑端查看')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '以手机模式重新打开' })).toBeNull();
    expect(screen.getByText('请在手机上打开')).toBeInTheDocument();
  });

  it('App 限制且平台支持手机模式时出这个按钮', () => {
    render(<BlockerNotice code="APP_ONLY" onAction={vi.fn()} supportsMobileMode />);
    expect(screen.getByRole('button', { name: '以手机模式重新打开' })).toBeInTheDocument();
  });

  it('没有找到素材：给重新识别和导出诊断', () => {
    const onAction = vi.fn();
    render(
      <BlockerNotice
        code="PARSE_EMPTY"
        onAction={onAction}
        extraAction={{ id: 'rescan', label: '重新识别' }}
      />,
    );
    expect(screen.getByText('没有在这个页面找到素材')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '导出诊断' }));
    expect(onAction).toHaveBeenCalledWith('diagnostics');
    fireEvent.click(screen.getByRole('button', { name: '重新识别' }));
    expect(onAction).toHaveBeenCalledWith('rescan');
  });

  it('已下架没有动作', () => {
    render(<BlockerNotice code="PRODUCT_GONE" onAction={vi.fn()} />);
    expect(screen.getByText('商品已下架')).toBeInTheDocument();
  });
});

describe('FeatureTabs（§8.5 只有一个功能时不渲染标签栏）', () => {
  function feature(id: string, title: string): RegisteredFeature {
    return {
      manifest: { id, title, icon: 'download', order: 10, requires: ['product.basic'] },
      page: { load: async () => ({ default: {} }) },
    };
  }

  it('只有一个功能时不渲染标签栏', () => {
    const { container } = render(
      <FeatureTabs
        features={[feature('media-download', '素材下载')]}
        activeId="media-download"
        onSelect={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(shouldRenderTabs([feature('a', 'A')])).toBe(false);
  });

  it('两个以上功能时出现文字标签，并记住当前标签', () => {
    const features = [feature('a', '素材'), feature('b', '信息')];
    expect(shouldRenderTabs(features)).toBe(true);
    const onSelect = vi.fn();
    render(<FeatureTabs features={features} activeId="a" onSelect={onSelect} />);
    expect(screen.getByRole('tab', { name: '素材' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: '信息' }));
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('pickActiveFeature：记住的优先，否则取第一个', () => {
    const features = [feature('a', '素材'), feature('b', '信息')];
    expect(pickActiveFeature(features, 'b')).toBe('b');
    expect(pickActiveFeature(features, 'gone')).toBe('a');
    expect(pickActiveFeature([], 'a')).toBeNull();
  });
});

describe('SaveBar 路径处理（§10.5 复制路径）', () => {
  it('中间省略保留头部和尾部', () => {
    const long =
      '电商素材\\拼多多\\夏季新款显瘦连衣裙女小个子法式复古方领泡泡袖碎花裙_482319937501';
    const shortened = middleEllipsis(long);
    expect(shortened).toContain('…');
    // 头部保留根目录名，尾部保留商品 ID（§10.3 ⑤）
    expect(shortened.startsWith('电商素材')).toBe(true);
    expect(shortened.endsWith('482319937501')).toBe(true);
    expect(shortened.length).toBeLessThan(long.length);
  });

  it('本来就不长时原样返回', () => {
    expect(middleEllipsis('短路径')).toBe('短路径');
  });

  it('有根目录绝对路径时拼成完整路径', () => {
    expect(fullPathFor('D:\\电商素材', '拼多多\\商品_1')).toBe('D:\\电商素材\\拼多多\\商品_1');
  });

  it('根目录末尾带反斜杠时不重复拼', () => {
    expect(fullPathFor('D:\\电商素材\\', '拼多多\\商品_1')).toBe('D:\\电商素材\\拼多多\\商品_1');
  });

  it('没有根目录路径时只给相对路径', () => {
    expect(fullPathFor(undefined, '拼多多\\商品_1')).toBe('拼多多\\商品_1');
    expect(fullPathFor('  ', '拼多多\\商品_1')).toBe('拼多多\\商品_1');
  });
});

describe('ProductHeader（§10.3 ②）', () => {
  it('标题用 title 属性给全文（悬停显示）', () => {
    render(<ProductHeader snapshot={snapshot()} onCopy={vi.fn()} />);
    expect(screen.getByTitle(snapshot().title)).toBeInTheDocument();
  });
});
