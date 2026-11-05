import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '../../../kernel/jobs/types';
import type { PrimaryActionModel } from '../primary-action-model';
import { PrimaryActionView } from './PrimaryAction';

/**
 * 主按钮的渲染（§10.4）。
 *
 * 纯函数 primaryActionModel 已经覆盖了「文案对不对」，这里只测**渲染得出来**：
 * 进度态右侧有取消、失败态有附加说明和查看、已全部下载可点、等授权禁用加取消。
 */

function model(patch: Partial<PrimaryActionModel> = {}): PrimaryActionModel {
  return {
    label: '下载 48 个文件',
    variant: 'accent',
    disabled: false,
    action: { kind: 'submit' },
    secondary: null,
    progress: null,
    meta: [],
    metaAction: null,
    ...patch,
  };
}

function makeJob(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'j1',
    type: 'media-download',
    dedupeKey: 'pdd:1',
    payload: {},
    status: 'running',
    total: 48,
    done: 23,
    skipped: 0,
    bytes: 4.3 * 1024 * 1024,
    failed: [],
    byGroup: {},
    createdAt: 0,
    ...patch,
  };
}

describe('PrimaryActionView（§10.4 主按钮渲染）', () => {
  it('就绪态：渲染文案，点击触发 submit', () => {
    const onAction = vi.fn();
    render(<PrimaryActionView model={model()} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: '下载 48 个文件' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'submit' });
  });

  it('下载中：进度条态，主体不可点，右侧“取消”可以点', () => {
    const onAction = vi.fn();
    const job = makeJob();
    render(
      <PrimaryActionView
        model={model({
          label: '下载中 23/48 · 4.1 MB',
          variant: 'progress',
          disabled: true,
          action: { kind: 'none' },
          secondary: { label: '取消', action: { kind: 'cancel' } },
          progress: { done: 23, total: 48 },
        })}
        onAction={onAction}
        bytes={job.bytes}
      />,
    );

    // 进度条存在且有精确数字
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByText(/下载中 23\/48/)).toBeInTheDocument();

    // 主体不可点：没有任何按钮叫「下载中 …」
    expect(screen.queryByRole('button', { name: /下载中/ })).toBeNull();

    // 取消可以点（§10.5 防误触：只有右侧的取消能点）
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'cancel' });
  });

  it('部分失败：显示“重试 3 个失败项”、附加说明和“查看”', () => {
    const onAction = vi.fn();
    render(
      <PrimaryActionView
        model={model({
          label: '重试 3 个失败项',
          action: { kind: 'retry-failed' },
          meta: ['网络不稳定（2）·图片已失效（1）'],
          metaAction: { label: '查看', action: { kind: 'show-failures' } },
        })}
        onAction={onAction}
      />,
    );

    expect(screen.getByText('重试 3 个失败项')).toBeInTheDocument();
    expect(screen.getByText('网络不稳定（2）·图片已失效（1）')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'show-failures' });
  });

  it('已全部下载：中性色但可以点（点击做增量检查）', () => {
    const onAction = vi.fn();
    render(
      <PrimaryActionView
        model={model({
          label: '已全部下载',
          variant: 'neutral',
          action: { kind: 'verify' },
          meta: ['上次下载于 11月3日 14:20 · 点击可重新检查'],
        })}
        onAction={onAction}
      />,
    );
    const button = screen.getByRole('button', { name: '已全部下载' });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledWith({ kind: 'verify' });
  });

  it('等待授权：禁用，右侧有“取消”链接', () => {
    const onAction = vi.fn();
    render(
      <PrimaryActionView
        model={model({
          label: '请在弹出的窗口中选择文件夹',
          variant: 'neutral',
          disabled: true,
          action: { kind: 'none' },
          secondary: { label: '取消', action: { kind: 'cancel-grant' } },
        })}
        onAction={onAction}
      />,
    );
    expect(screen.getByRole('button', { name: '请在弹出的窗口中选择文件夹' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'cancel-grant' });
  });

  it('识别中：禁用，没有附加说明', () => {
    render(
      <PrimaryActionView
        model={model({
          label: '正在识别商品…',
          variant: 'neutral',
          disabled: true,
          action: { kind: 'none' },
        })}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '正在识别商品…' })).toBeDisabled();
  });

  it('附加说明最多两行（模型已经截过，这里确认渲染不炸）', () => {
    render(
      <PrimaryActionView
        model={model({ meta: ['跳过 0 个', '用时 3.2 秒'] })}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('跳过 0 个')).toBeInTheDocument();
    expect(screen.getByText('用时 3.2 秒')).toBeInTheDocument();
  });
});
