import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SaveBar } from './SaveBar';

/**
 * 保存位置（§10.3 ⑤）。
 *
 * 这一行要回答「东西存到哪」。用户填了根目录绝对路径时就直接显示它 ——
 * 每件商品各自的相对路径换个商品就变一次，看不出这是保存位置设置。
 */
describe('SaveBar', () => {
  const ready = { status: 'ready' as const, name: '电商素材' };

  it('显示根目录绝对路径，而不是商品文件夹的相对路径', () => {
    const { container } = render(
      <SaveBar
        dir={ready}
        relativePath="拼多多_商品ID_1004831125244"
        rootPath={'D:\\电商素材'}
        onOpenGrant={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('D:\\电商素材');
    expect(container.textContent).not.toContain('拼多多_商品ID_1004831125244');
  });

  it('没填绝对路径时退回相对路径（至少能看出归档结构）', () => {
    const { container } = render(
      <SaveBar
        dir={ready}
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
        rootPath={'D:\\电商素材'}
        onOpenGrant={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('还没有选择保存位置');
    expect(getByRole('button', { name: '还没有选择保存位置' })).toBeInTheDocument();
  });
});
