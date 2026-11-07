import { useState } from 'react';

/**
 * 值相等时复用上一次的引用。
 *
 * 典型用法：每次渲染都算出 { kind: 'progress', percent: 42 } 这种小对象，
 * 但内容没变时下游组件不该重渲染。useMemo 只能按依赖数组缓存，
 * 按「算出来之后再比一次」的场景需要这个。
 *
 * 实现用 React 官方的「在渲染期间调整 state」写法（prev 标记）：
 * 缓存放 state 而不是 ref —— 渲染期写 ref 是副作用，React 可能丢弃或重放这次渲染，
 * 写进去的值会泄漏给从未提交的界面；而渲染期 setState 是官方支持的受控调整。
 *
 * 收敛性：只有「引用变了、按值也不相等」才更新缓存，更新后 cache.input === value，
 * 条件立刻不成立，最多多渲染一轮，不会无限循环（useStableByValue.test.tsx 锁住这一点）。
 */
export function useStableByValue<T>(value: T, eq: (a: T, b: T) => boolean): T {
  /** input：上一次参与比较的值；output：上一次对外给出的引用 */
  const [cache, setCache] = useState<{ input: T; output: T }>(() => ({
    input: value,
    output: value,
  }));

  if (cache.input !== value && !eq(cache.input, value)) {
    setCache({ input: value, output: value });
    return value;
  }

  return cache.output;
}
