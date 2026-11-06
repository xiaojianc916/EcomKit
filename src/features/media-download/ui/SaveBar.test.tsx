import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { baseName, SaveBar, saveTargetLabel, saveTargetPath } from './SaveBar';

/**
 * 保存位置（§10.3 ⑤）。
 *
 * 这一行显示的是**用户在授权小窗里真正选中的那个文件夹**（浏览器只给得到名字）
 * 加上按模板生成的商品子文件夹。设置里手填的「根目录绝对路径」只有在最后一段
 * 和这个文件夹名一致时才拿来显示（带盘符）—— 不一致说明手填的是别的地方，显示它就会骗人。
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

describe('baseName', () => {
  it('取路径最后一段，反斜杠和正斜杠都认，末尾的分隔符不算一段', () => {
    expect(baseName('D:\\test')).toBe('test');
    expect(baseName('D:\\test\\')).toBe('test');
    expect(baseName('D:/电商素材/')).toBe('电商素材');
    expect(baseName('test')).toBe('test');
  });
});

describe('saveTargetPath', () => {
  const relativePath = '拼多多_商品ID_1004831125244';

  it('手填路径最后一段和文件夹名一致时显示完整路径（能看见盘符）', () => {
    expect(saveTargetPath('test', relativePath, 'D:\\test')).toBe(`D:\\test\\${relativePath}`);
    // 用户手填时习惯带尾部分隔符
    expect(saveTargetPath('test', relativePath, 'D:\\test\\')).toBe(`D:\\test\\${relativePath}`);
  });

  it('大小写不一致也算同一个目录（Windows 路径不区分大小写）', () => {
    expect(saveTargetPath('Test', relativePath, 'D:\\test')).toBe(`D:\\test\\${relativePath}`);
  });

  it('名字对不上时只显示文件夹名，不带手填的路径', () => {
    const label = saveTargetPath('test', relativePath, 'D:\\电商素材');
    expect(label).toBe(`test\\${relativePath}`);
    expect(label).not.toContain('D:\\');
  });

  it('没有手填路径时保持只显示文件夹名', () => {
    expect(saveTargetPath('test', relativePath, undefined)).toBe(`test\\${relativePath}`);
    expect(saveTargetPath('test', relativePath, '   ')).toBe(`test\\${relativePath}`);
  });

  it('拿不到文件夹名时退回商品文件夹', () => {
    expect(saveTargetPath(undefined, relativePath, 'D:\\test')).toBe(relativePath);
    expect(saveTargetPath('   ', relativePath, 'D:\\test')).toBe(relativePath);
  });
});

describe('SaveBar', () => {
  const ready = { status: 'ready' as const, name: '电商素材' };

  it('手填路径和选中的文件夹对得上时，显示带盘符的完整路径', () => {
    const { container } = render(
      <SaveBar
        dir={ready}
        relativePath="拼多多_商品ID_1004831125244"
        rootPath={'D:\\电商素材'}
        onOpenGrant={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    // 对得上说明手填的就是选中的那个目录，显示盘符才让用户看得见存到哪
    expect(container.textContent).toContain('D:\\电商素材');
    expect(container.textContent).toContain('拼多多_商品ID_1004831125244');
  });

  it('手填 D:\\test、选中 test 时显示 D:\\test\\商品文件夹', () => {
    const { container } = render(
      <SaveBar
        dir={{ status: 'ready', name: 'test' }}
        relativePath="拼多多_商品ID_1004831125244"
        rootPath={'D:\\test'}
        onOpenGrant={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('D:\\test\\拼多多_商品ID_1004831125244');
  });

  it('手填路径和选中的文件夹对不上时只显示文件夹名，不骗人', () => {
    const { container } = render(
      <SaveBar
        dir={{ status: 'ready', name: 'test' }}
        relativePath="拼多多_商品ID_1004831125244"
        rootPath={'D:\\电商素材'}
        onOpenGrant={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('test\\拼多多_商品ID_1004831125244');
    expect(container.textContent).not.toContain('D:\\');
  });

  it('没有手填路径时保持只显示文件夹名', () => {
    const { container } = render(
      <SaveBar
        dir={{ status: 'ready', name: 'test' }}
        relativePath="拼多多_商品ID_1004831125244"
        onOpenGrant={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('test\\拼多多_商品ID_1004831125244');
    expect(container.textContent).not.toContain('D:\\');
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
