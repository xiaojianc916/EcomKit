import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GLOBAL_SETTINGS } from '../../kernel/settings/schema';

/**
 * 设置草稿的防抖落盘（§10.8）。
 *
 * 这两条不变式是拆分「界面立刻更新」和「落盘防抖」的全部意义，改实现不能弄丢：
 *  1. 防抖窗口内以**最后一次**改动为准；
 *  2. 卸载前落盘，用户改完立刻切走也不丢。
 *
 * 另外锁住 updater 是纯的：React 19 严格模式下 updater 会被调两次，
 * 旧实现把写 ref + 起定时器塞在 updater 里，于是定时器会被起两遍。
 */
const getSettings = vi.fn();
const setSettings = vi.fn(async (value: unknown) => value);

vi.mock('../../kernel/settings/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../kernel/settings/store')>();
  return {
    ...actual,
    getSettings: () => getSettings(),
    setSettings: (v: unknown) => setSettings(v),
  };
});

const { useSettingsDraft } = await import('./sections');

beforeEach(() => {
  vi.useFakeTimers();
  getSettings.mockResolvedValue(DEFAULT_GLOBAL_SETTINGS);
  setSettings.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 取出第 n 次落盘写入的并发数（断言用；缺数据时直接失败，不猜） */
function savedConcurrency(call: number): number {
  const value = setSettings.mock.calls[call];
  if (value === undefined) throw new Error(`第 ${call} 次落盘不存在`);
  return (value[0] as { jobs: { concurrency: number } }).jobs.concurrency;
}

async function mountDraft() {
  const hook = renderHook(() => useSettingsDraft());
  // 等 getSettings() 的分支落地（微任务，不涉及定时器）
  await act(async () => {
    await Promise.resolve();
  });
  return hook;
}

describe('useSettingsDraft（设置防抖落盘）', () => {
  it('防抖窗口内连续改动，只落盘最后一次', async () => {
    const { result } = await mountDraft();
    expect(result.current.settings).not.toBeNull();

    act(() => result.current.update({ jobs: { concurrency: 4 } }));
    act(() => result.current.update({ jobs: { concurrency: 5 } }));
    act(() => result.current.update({ jobs: { concurrency: 6 } }));

    // 界面立刻是最新值，落盘还没发生
    expect(result.current.settings?.jobs.concurrency).toBe(6);
    expect(setSettings).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(setSettings).toHaveBeenCalledTimes(1);
    expect(savedConcurrency(0)).toBe(6);
  });

  it('卸载前把最后一次改动落盘（不丢）', async () => {
    const { result, unmount } = await mountDraft();

    act(() => result.current.update({ jobs: { concurrency: 3 } }));
    expect(setSettings).not.toHaveBeenCalled();

    // 用户改完立刻切走：定时器还没到点
    unmount();

    expect(setSettings).toHaveBeenCalledTimes(1);
    expect(savedConcurrency(0)).toBe(3);
  });

  it('设置还没读回来时 update 是空操作（不会写入半份设置）', async () => {
    getSettings.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useSettingsDraft());

    act(() => result.current.update({ jobs: { concurrency: 2 } }));

    expect(result.current.settings).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(setSettings).not.toHaveBeenCalled();
  });
});
