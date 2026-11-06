import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 提示条（§10.5「下载完成的反馈：不弹 Toast，也不发系统通知」）。
 *
 * 所以这里**不是**通用通知系统，只在必须告诉用户一句话、且这句话带一个动作时才用
 * （例如「没有需要补全的文件」）。下载完成、失败都在主按钮和素材行上原位反馈。
 *
 * 生命周期：4 秒自动消失；带动作时点动作也算处理完。
 *
 * **挂在哪里**：ToastViewport 由外壳直接渲染在 \`.ec-root\` 里，本身就在 shadow root 内，
 * 样式自然生效。所以这里不需要 portal —— 旧实现的
 * \`if (container === null) return content; return <>{content}</>\` 两个分支渲染的是同一棵树，
 * 「portal 分支」从头到尾没有 portal 过。
 */

export interface ToastAction {
  label: string;
  run(): void;
}

export interface ToastItem {
  id: number;
  message: string;
  action?: ToastAction;
}

const TOAST_TTL_MS = 4000;
/** 视图还没挂载时最多先攒这么多条，避免一直没人取时无限增长 */
const MAX_PENDING = 10;

let nextId = 1;
const listeners = new Set<(item: ToastItem) => void>();
/**
 * 视图挂载前先到的提示。
 *
 * 真实时序：index.tsx 在主流程里就把 PageApi.toast 接上了，而 ToastViewport 要等
 * Shell 渲染才有。识别失败、需要重新授权这类**最该被用户看到**的提示恰好发生在
 * 外壳挂载之前，没有这块缓冲它们会被静默丢掉 —— 又是「点了完全没反应」。
 */
const pending: Array<{ item: ToastItem; queuedAt: number }> = [];

/**
 * 命令式的 show()：PageApi.toast 的签名就是 (msg, opts)，组件里也不方便层层传 context。
 * 模块级订阅者集合让外壳只挂一个 <ToastViewport/>，任何地方都能推消息。
 */
export function showToast(message: string, action?: ToastAction): void {
  const item: ToastItem = {
    id: nextId++,
    message,
    ...(action === undefined ? {} : { action }),
  };
  if (listeners.size === 0) {
    pending.push({ item, queuedAt: Date.now() });
    if (pending.length > MAX_PENDING) pending.shift();
    return;
  }
  for (const listener of listeners) listener(item);
}

/** 测试和外壳卸载用：丢掉还没被取走的提示 */
export function clearPendingToasts(): void {
  pending.length = 0;
}

interface LiveToast extends ToastItem {
  /** 到期时间戳；FIFO 且 TTL 相同 → 队头永远是最早到期的那个 */
  expiresAt: number;
}

export function ToastViewport() {
  const [items, setItems] = useState<LiveToast[]>([]);
  /** 只保留一个定时器（队头那条的），而不是每条 toast 一个 */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  useEffect(() => {
    const listener = (item: ToastItem): void => {
      setItems((prev) => [...prev, { ...item, expiresAt: Date.now() + TOAST_TTL_MS }]);
    };
    listeners.add(listener);
    // 接管挂载前攒下的提示 —— 只放行仍然是「刚发生」的那些：
    // 攒了几分钟才挂上的旧提示不该突然弹出来（用户可能早就换了页面/商品）
    if (pending.length > 0) {
      const now = Date.now();
      const drained = pending.splice(0, pending.length);
      const fresh = drained.filter((entry) => now - entry.queuedAt <= TOAST_TTL_MS);
      if (fresh.length > 0) {
        setItems((prev) => [
          ...prev,
          ...fresh.map((entry) => ({ ...entry.item, expiresAt: now + TOAST_TTL_MS })),
        ]);
      }
    }
    return () => {
      listeners.delete(listener);
    };
  }, []);

  /**
   * 队头变了就重排唯一那个定时器（新 toast 入队、队头被点掉、视图卸载都会走到这里）。
   * 旧实现每条 toast 一个 setTimeout + 一个 Map 记录，dismiss 时再去 Map 里找回并 clear；
   * 现在清理只有「effect 的 cleanup」这一处，不会漏。
   *
   * 到点时一次把所有已到期的都收掉：几条同一时刻入队的提示本就该同一时刻消失，
   * 只删队头会让剩下的拖到下一轮（假定时器里表现为「明明过了 4 秒还在」）。
   */
  useEffect(() => {
    const head = items[0];
    if (head === undefined) return;
    const remaining = Math.max(head.expiresAt - Date.now(), 0);
    timer.current = setTimeout(() => {
      timer.current = null;
      const now = Date.now();
      setItems((prev) => prev.filter((item) => item.expiresAt > now));
    }, remaining);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [items]);

  if (items.length === 0) return null;
  return (
    <div className="ec-toast-viewport" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className="ec-toast">
          <span>{item.message}</span>
          {item.action === undefined ? null : (
            <button
              type="button"
              className="ec-btn ec-btn--link"
              onClick={() => {
                item.action?.run();
                dismiss(item.id);
              }}
            >
              {item.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
