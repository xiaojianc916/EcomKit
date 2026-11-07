import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStableByValue } from './useStableByValue';

/**
 * useStableByValue（角标引用复用）。
 *
 * 锁两件事：
 *  1. 内容相等时复用上一次的引用 —— 下游（Handle）才能跳过重渲染；
 *  2. 渲染期调整 state 的写法必须收敛：同一个值反复渲染不会无限重渲染。
 */
interface Badge {
  kind: 'count' | 'progress';
  value: number;
}

const eq = (a: Badge, b: Badge): boolean => a.kind === b.kind && a.value === b.value;

describe('useStableByValue', () => {
  it('内容相等时复用上一次的引用', () => {
    const { result, rerender } = renderHook(({ badge }) => useStableByValue(badge, eq), {
      initialProps: { badge: { kind: 'count', value: 3 } as Badge },
    });
    const first = result.current;

    rerender({ badge: { kind: 'count', value: 3 } });
    expect(result.current).toBe(first);

    rerender({ badge: { kind: 'count', value: 4 } });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual({ kind: 'count', value: 4 });
  });

  it('收敛：反复用相等的值渲染不会一直改 state', () => {
    let renders = 0;
    const { rerender } = renderHook(
      ({ badge }: { badge: Badge }) => {
        renders += 1;
        return useStableByValue(badge, eq);
      },
      { initialProps: { badge: { kind: 'progress', value: 42 } as Badge } },
    );

    for (let i = 0; i < 5; i += 1) rerender({ badge: { kind: 'progress', value: 42 } });

    // 每次 rerender 只渲染一次：相等时不进更新分支，也不会多渲染一轮
    expect(renders).toBe(6);
  });

  it('值变化时更新，并稳定在新的引用上', () => {
    let renders = 0;
    const { result, rerender } = renderHook(
      ({ badge }: { badge: Badge }) => {
        renders += 1;
        return useStableByValue(badge, eq);
      },
      { initialProps: { badge: { kind: 'count', value: 1 } as Badge } },
    );

    rerender({ badge: { kind: 'count', value: 2 } });
    const after = result.current;
    expect(after).toEqual({ kind: 'count', value: 2 });

    rerender({ badge: { kind: 'count', value: 2 } });
    expect(result.current).toBe(after);
    // 1 次首次渲染 + 变化时的一轮额外渲染 + 后续两次重渲染
    expect(renders).toBe(4);
  });
});
