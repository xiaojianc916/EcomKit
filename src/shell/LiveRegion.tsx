import type { ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * 读屏器播报（§10.9 组件树最后一项：LiveRegion，aria-live=polite）。
 *
 * 为什么需要它：§10.5 明确「下载完成不弹 Toast，也不发系统通知」，
 * 视觉用户能从主按钮的「已保存 48 个文件」看到结果，读屏器用户却什么都收不到。
 * 这个区域把关键状态变化念出来，视觉上不可见（.ec-visually-hidden）。
 *
 * 只在状态真的变化时播报：同一句话不重复念，否则每 200ms 一次进度会变成噪音。
 */

interface LiveRegionValue {
  announce(message: string): void;
}

const LiveRegionContext = createContext<LiveRegionValue | null>(null);

export function LiveRegionProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const lastRef = useRef('');
  // 同一个字符串连续播报时，screen reader 不会重新读；加一个不可见的零宽差异才能再读一次
  const [nonce, setNonce] = useState(0);

  const announce = useCallback((next: string) => {
    if (next === lastRef.current) return;
    lastRef.current = next;
    setMessage(next);
    setNonce((n) => n + 1);
  }, []);

  // 每次渲染都新建 { announce } 会让所有消费者跟着重渲染；依赖只有 announce，它本身是稳定的
  const contextValue = useMemo(() => ({ announce }), [announce]);

  return (
    <LiveRegionContext.Provider value={contextValue}>
      {children}
      {/* polite：不打断用户正在听的内容（§10.9） */}
      <div className="ec-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {message}
        {nonce > 0 ? <span aria-hidden="true">{' '.repeat(nonce % 2)}</span> : null}
      </div>
    </LiveRegionContext.Provider>
  );
}

/** 播报一句话；没有 Provider 时静默（组件测试里不必包一层） */
export function useAnnounce(): (message: string) => void {
  const ctx = useContext(LiveRegionContext);
  return ctx?.announce ?? (() => {});
}

/** 状态变化时自动播报。text 为 null 表示这次不播 */
export function useLiveMessage(text: string | null): void {
  const announce = useAnnounce();
  useEffect(() => {
    if (text !== null && text !== '') announce(text);
  }, [text, announce]);
}

/** 单独使用（不包 Provider）时的渲染出口，主要给 popup 这类独立页面 */
export function LiveRegion({ message }: { message: string }) {
  return (
    <div className="ec-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
