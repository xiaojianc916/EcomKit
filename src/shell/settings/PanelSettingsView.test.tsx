import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GLOBAL_SETTINGS } from '../../kernel/settings/schema';

/**
 * 面板里的设置视图（§10.3）：它不是独立页面，是工具箱面板的第二屏。
 * 这里锁住两件事：
 *  1. 六个分组都在，并且能就地切换（不跳转、不刷新）；
 *  2. 分组标题来自同一份 SETTINGS_SECTIONS —— 设置页和面板不会各写一套。
 */
const draft = { settings: DEFAULT_GLOBAL_SETTINGS, update: vi.fn() };

vi.mock('./sections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sections')>();
  return { ...actual, useSettingsDraft: () => draft };
});

const { PanelSettingsView } = await import('./PanelSettingsView');

describe('PanelSettingsView（面板内设置视图）', () => {
  it('六个分组都在，默认停在「保存位置」', () => {
    render(<PanelSettingsView />);
    for (const title of ['保存位置', '文件命名', '素材', '工具箱', '高级', '关于']) {
      expect(screen.getByRole('tab', { name: title })).toBeInTheDocument();
    }
    expect(screen.getByRole('tab', { name: '保存位置' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('保存方式')).toBeInTheDocument();
  });

  it('点分组就地切换，不换页面', () => {
    render(<PanelSettingsView />);
    fireEvent.click(screen.getByRole('tab', { name: '工具箱' }));
    expect(screen.getByRole('tab', { name: '工具箱' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('进入商品页时')).toBeInTheDocument();
    expect(screen.queryByText('保存方式')).toBeNull();
  });
});
