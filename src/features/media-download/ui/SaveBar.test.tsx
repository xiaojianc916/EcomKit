import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SaveBar, saveTargetLabel } from './SaveBar';

/**
 * 保存位置（§10.3 ⑤）。
 *
 * 这一行显示的是**用户在授权小窗里真正选中的那个文件夹**（浏览器只给得到名字）
 * 加上按模板生成的商品子文件夹。设置里手填的「根目录绝对路径」只用于拼完整路径 ——
 * 拿它当保存位置显示会骗人：用户选的和手填的完全可能是两个地方。
 */
describe('saveTargetLabel', () => {
  it('根文件夹名 \\ 商品文件夹', () => {
    expect(saveTargetLabel('电商素材', '拼多多_商品ID_1004831125244')).toBe(
      '电商素材\\拼多多_商品ID_1004831125244',
    );
  });

  it('拿不到根文件夹名时只显示商品文件夹', () => {
    expect(saveTargetLabel(undefined, '拼多多_商品ID_1')).toBe('拼多多_商品ID_1');
    expect(saveTargetLabel('   ', '拼多多_商品ID_1')).toBe('拼多多_商品ID_1');
  });
});

describe('SaveBar', () => {
  const ready = { status: 'ready' as const, name: '电商素材' };

  it('显示「选中的文件夹 \\ 商品文件夹」，而不是手填的绝对路径', () => {
    const { container } = render(
      <SaveBar
        dir={ready}
        relativePath="拼多多_商品ID_1004831125244"
        rootPath={'D:\\电商素材'}
        onOpenGrant={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('电商素材');
    expect(container.textContent).toContain('拼多多_商品ID_1004831125244');
    // 手填路径不该出现在「保存到」这一行里
    expect(container.textContent).not.toContain('D:\\电商素材');
  });

  it('没有根文件夹名时退回商品文件夹', () => {
    const { container } = render(
      <SaveBar
        dir={{ status: 'ready' }}
        relativePath="拼多多_商品ID_1004831125244"
        onOpenGrant={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('拼多多_商品ID_1004831125244');
  });

  it('还没选目录时不显示路径，而是一个打开授权小窗的动作', () => {
    const { container, getByRole } = render(
      <SaveBar
        dir={{ status: 'unset' }}
        relativePath="拼多多_商品ID_1"
        onOpenGrant={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('还没有选择保存位置');
    expect(getByRole('button', { name: '还没有选择保存位置' })).toBeInTheDocument();
  });
});
