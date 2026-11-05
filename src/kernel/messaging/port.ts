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

/**
 * page 侧的 Port 连接。
 *
 * **同一个标签页只能有一条连接**：bg 的 createPortServer 按 tabId 只记一个 Port，
 * 第二条连接会把第一条覆盖掉，被覆盖的那条从此收不到任何消息。
 * 旧实现里 controller 和 page-api 各连了一条，于是 watchJobs 永远不触发 ——
 * 进度条、失败列表、「已保存 N 个文件」全部定格。
 *
 * 所以这里做成**进程内单例**：谁先调用谁建立连接，后来的只是挂一个监听器。
 */
interface SharedPort {
  listeners: Set<(msg: PortMessage) => void>;
  connectListeners: Set<() => void>;
  disconnect(): void;
}

let shared: SharedPort | null = null;

function ensureSharedPort(): SharedPort {
  if (shared !== null) return shared;

  let port: chrome.runtime.Port | null = null;
  let disposed = false;
  let retry = 0;
  const listeners = new Set<(msg: PortMessage) => void>();
  const connectListeners = new Set<() => void>();

  const scheduleReconnect = (): void => {
    if (disposed) return;
    const delay = Math.min(1000 * 2 ** retry++, 10_000);
    setTimeout(connect, delay);
  };

  const connect = (): void => {
    if (disposed) return;
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      // 扩展在更新/卸载时 connect 会抛，退避重试
      scheduleReconnect();
      return;
    }
    port.onMessage.addListener((msg) => {
      for (const cb of [...listeners]) {
        try {
          cb(msg as PortMessage);
        } catch {
          /* 单个监听器出错不影响其它监听器 */
        }
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (disposed) return;
      scheduleReconnect();
    });
    retry = 0;
    for (const cb of [...connectListeners]) {
      try {
        cb();
      } catch {
        /* 同上 */
      }
    }
  };

  const entry: SharedPort = {
    listeners,
    connectListeners,
    disconnect(): void {
      disposed = true;
      listeners.clear();
      connectListeners.clear();
      shared = null;
      try {
        port?.disconnect();
      } catch {
        /* 已经断了 */
      }
    },
  };

  shared = entry;
  connect();
  return entry;
}

/**
 * 订阅 Job Port（单例连接）。返回取消订阅函数 —— **不会**断开共享连接，
 * 因为别的模块可能还挂着监听器；整页卸载时连接自然断开。
 */
export function connectJobPort(handlers: {
  onMessage(msg: PortMessage): void;
  onConnect?(): void;
}): () => void {
  const sharedPort = ensureSharedPort();
  sharedPort.listeners.add(handlers.onMessage);
  const onConnect = handlers.onConnect;
  if (onConnect) sharedPort.connectListeners.add(onConnect);

  return () => {
    sharedPort.listeners.delete(handlers.onMessage);
    if (onConnect) sharedPort.connectListeners.delete(onConnect);
    if (sharedPort.listeners.size === 0 && sharedPort.connectListeners.size === 0) {
      sharedPort.disconnect();
    }
  };
}

/** 主动断开共享连接（整页卸载时用；测试里也用它重置状态） */
export function disconnectJobPort(): void {
  shared?.disconnect();
}
