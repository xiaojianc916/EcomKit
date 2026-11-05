import { useCallback, useEffect, useRef, useState } from 'react';
import { usePortalTarget } from './PortalRoot';

/**
 * 提示条（§10.5「下载完成的反馈：不弹 Toast，也不发系统通知」）。
 *
 * 所以这里**不是**通用通知系统，只在必须告诉用户一句话、且这句话带一个动作时才用
 * （例如「没有需要补全的文件」）。下载完成、失败都在主按钮和素材行上原位反馈。
 *
 * 生命周期：4 秒自动消失；带动作时点动作也算处理完。
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

const listeners = new Set<(item: ToastItem) => void>();
let nextId = 1;

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
  for (const listener of listeners) listener(item);
}

const TOAST_TTL_MS = 4000;

export function ToastViewport() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const container = usePortalTarget();
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  useEffect(() => {
    const listener = (item: ToastItem): void => {
      setItems((prev) => [...prev, item]);
      const timer = setTimeout(() => dismiss(item.id), TOAST_TTL_MS);
      timers.current.set(item.id, timer);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    };
  }, [dismiss]);

  if (items.length === 0) return null;
  // 弹层容器：内容脚本里要挂进 shadow root，否则拿不到样式（§10.10）
  const content = (
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
  if (container === null) return content;
  return <>{content}</>;
}
