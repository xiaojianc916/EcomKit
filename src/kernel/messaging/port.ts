import type { PortMessage } from './protocol';

/**
 * Job Port（方案 §6.3「Job Port」行）。
 *
 * 每个 Tab 一个长连接，bg 用它把任务进度推给发起任务的页面。
 * 为什么不用 runtime 消息：进度事件每 200ms 一条，用长连接省掉每次的握手开销；
 * 而且 Tab 关掉时 Port 会自动断开，天然的清理时机。
 *
 * 页面刷新后重新连上时，用 tabId + productId 认领正在执行的任务（§7.2 第 4 点）。
 */

export const PORT_NAME = 'ecbox:jobs';

export interface PortServer {
  /** 给某个 Tab 推一条消息；Tab 不在了就静默丢弃 */
  send(tabId: number, msg: PortMessage): void;
  /** 广播给所有连接着的 Tab */
  broadcast(msg: PortMessage): void;
  /** 当前有哪些 Tab 连着 */
  connectedTabs(): number[];
  dispose(): void;
}

/** bg 侧：接住所有来自内容脚本的 Port */
export function createPortServer(): PortServer {
  const ports = new Map<number, chrome.runtime.Port>();

  const onConnect = (port: chrome.runtime.Port) => {
    if (port.name !== PORT_NAME) return;
    const tabId = port.sender?.tab?.id;
    if (typeof tabId !== 'number') return;

    ports.set(tabId, port);
    port.onDisconnect.addListener(() => {
      // 只有当前这个 port 还登记着才删，避免新的连接被旧的断连事件误删
      if (ports.get(tabId) === port) ports.delete(tabId);
    });
  };

  chrome.runtime.onConnect.addListener(onConnect);

  return {
    send(tabId, msg) {
      const port = ports.get(tabId);
      if (!port) return;
      try {
        port.postMessage(msg);
      } catch {
        ports.delete(tabId);
      }
    },
    broadcast(msg) {
      for (const [tabId, port] of ports) {
        try {
          port.postMessage(msg);
        } catch {
          ports.delete(tabId);
        }
      }
    },
    connectedTabs() {
      return [...ports.keys()];
    },
    dispose() {
      chrome.runtime.onConnect.removeListener(onConnect);
      ports.clear();
    },
  };
}

/** page 侧：连到 bg，带自动重连 */
export function connectJobPort(handlers: {
  onMessage(msg: PortMessage): void;
  onConnect?(): void;
}): () => void {
  let port: chrome.runtime.Port | null = null;
  let disposed = false;
  let retry = 0;

  const connect = () => {
    if (disposed) return;
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      // 扩展在更新/卸载时 connect 会抛，退避重试
      scheduleReconnect();
      return;
    }
    port.onMessage.addListener((msg) => handlers.onMessage(msg as PortMessage));
    port.onDisconnect.addListener(() => {
      port = null;
      if (disposed) return;
      scheduleReconnect();
    });
    retry = 0;
    handlers.onConnect?.();
  };

  const scheduleReconnect = () => {
    if (disposed) return;
    const delay = Math.min(1000 * 2 ** retry++, 10_000);
    setTimeout(connect, delay);
  };

  connect();

  return () => {
    disposed = true;
    try {
      port?.disconnect();
    } catch {
      /* 已经断了 */
    }
  };
}
