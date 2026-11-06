import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

/**
 * 平台图标（标题栏左上角）：logo 来自 src/shell/assets/*.svg，构建期用 ?raw 打进 bundle。
 *
 * 这里锁住三件会让标题栏变形或失效的事：
 *  1. 两个平台都能出图标（图标缺失就会退回色点 + 名称）；
 *  2. 源文件里的 width/height 必须被洗掉 —— 固定像素会把 40px 标题栏撑爆；
 *  3. 尺寸由调用方按高度给，宽度跟随 viewBox（不能写死）。
 */
const { PlatformLogo } = await import('./PlatformLogo');

describe('PlatformLogo', () => {
  it('拼多多：内联 svg，且不带源文件的固定宽高', () => {
    const { container } = render(<PlatformLogo platformId="pinduoduo" name="拼多多" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 425.14 128');
    expect(svg?.hasAttribute('width')).toBe(false);
    expect(svg?.hasAttribute('height')).toBe(false);
  });

  it('抖音：内联 svg 保留品牌渐变', () => {
    const { container } = render(<PlatformLogo platformId="douyin" name="抖音" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 202.25 79.23');
    expect(container.innerHTML).toContain('clip-path');
  });

  it('没有图标或没有平台 id 时返回 null，由调用方退回色点 + 名称', () => {
    expect(render(<PlatformLogo platformId="taobao" name="淘宝" />).container.innerHTML).toBe('');
    expect(render(<PlatformLogo platformId={undefined} name="" />).container.innerHTML).toBe('');
  });

  it('读屏器的名字走 aria-label，源文件的 <title> 已去掉', () => {
    const { container, getByRole } = render(<PlatformLogo platformId="pinduoduo" name="拼多多" />);
    expect(getByRole('img', { name: '拼多多' })).toBeInTheDocument();
    expect(container.querySelector('svg title')).toBeNull();
  });
});
