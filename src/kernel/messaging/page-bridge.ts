/**
 * MAIN world ↔ ISOLATED world 的桥（方案 §6.3「Page Bridge」行、§7.4）。
 *
 * 三条硬规则：
 * 1. `detail` 一律是 JSON 字符串 —— structured clone 传不了复杂对象跨 world，
 *    字符串还有个好处：伪造者塞进来的东西必须先能 JSON.parse 成功。
 * 2. 事件名带每次注入随机生成的前缀 —— 页面脚本想监听都猜不到（不是安全边界，是降低干扰）。
 * 3. 前缀的交接：ISOLATED 在 document_start 把前缀写进 documentElement.dataset，
 *    MAIN 读到后**立即删除属性**，之后双方只用带前缀的事件名通信。
 */

export const BRIDGE_CHANNEL_ATTR = 'data-ecbox-c';
export const BRIDGE_PREFIX_LEN = 8;

/** ISOLATED 侧：生成前缀并交给 MAIN（MAIN 读到后会自己删掉这个属性） */
export function publishBridgePrefix(doc: Document): string {
  const prefix = randomPrefix();
  doc.documentElement.setAttribute(BRIDGE_CHANNEL_ATTR, prefix);
  return prefix;
}

/** MAIN 侧：读前缀并立即清理，避免被页面后续脚本看到 */
export function consumeBridgePrefix(doc: Document): string | null {
  const el = doc.documentElement;
  const prefix = el.getAttribute(BRIDGE_CHANNEL_ATTR);
  if (prefix) el.removeAttribute(BRIDGE_CHANNEL_ATTR);
  return prefix && prefix.length >= 4 ? prefix : null;
}

function randomPrefix(): string {
  const bytes = new Uint8Array(BRIDGE_PREFIX_LEN);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 事件名约定 */
export const bridgeEvent = {
  /** ISOLATED → MAIN：请求读取一个全局变量路径 */
  readGlobal: (prefix: string) => `ecbox:${prefix}:read-global`,
  /** MAIN → ISOLATED：读全局变量的结果 */
  readGlobalResult: (prefix: string) => `ecbox:${prefix}:read-global-result`,
  /** MAIN → ISOLATED：抓到一条命中规则的响应 */
  capture: (prefix: string) => `ecbox:${prefix}:capture`,
  /** ISOLATED → MAIN：告诉 MAIN 当前页面类型，决定装载哪些抓取规则 */
  hello: (prefix: string) => `ecbox:${prefix}:hello`,
  /** MAIN → ISOLATED：启动完成，可以开始发事件了 */
  ready: (prefix: string) => `ecbox:${prefix}:ready`,
} as const;

export interface BridgeReadGlobalRequest {
  id: string;
  path: string;
}

export interface BridgeReadGlobalResult {
  id: string;
  ok: boolean;
  /** 已经是 JSON 字符串（可能因为循环引用被截断） */
  json?: string;
  error?: string;
}

export interface BridgeHello {
  pageKind: string;
  /** 只装载这些规则 id 的抓取 */
  ruleIds: string[];
}

export interface BridgeCaptureMessage {
  ruleId: string;
  url: string;
  /** JSON 字符串；解析失败时为 null */
  json: string | null;
  at: number;
  /** 超过 maxBytes 被丢弃时置 true */
  dropped?: boolean;
}

/**
 * 安全拷贝一个全局变量成 JSON 字符串。
 *
 * 为什么不直接 JSON.stringify：页面的全局变量经常带循环引用、getter、Proxy，
 * 直接序列化可能抛异常或者把整个 window 拖进来把页面卡死。
 * 这里用 depth/width 双限制 + 循环引用检测 + 总字节上限。
 */
export function safeJsonCopy(
  value: unknown,
  opts: { maxDepth?: number; maxWidth?: number; maxBytes?: number } = {},
): string | null {
  const maxDepth = opts.maxDepth ?? 12;
  const maxWidth = opts.maxWidth ?? 2000;
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;

  const seen = new WeakSet<object>();
  let budget = maxBytes;

  function walk(v: unknown, depth: number): unknown {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'function') return '[Function]';
      if (typeof v === 'bigint') return `[BigInt:${v.toString()}]`;
      if (typeof v === 'undefined') return null;
      return v;
    }
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) return { name: v.name, message: v.message };
    if (seen.has(v as object)) return '[Circular]';
    if (depth >= maxDepth) return '[Depth]';
    seen.add(v as object);

    try {
      if (Array.isArray(v)) {
        const out: unknown[] = [];
        const len = Math.min(v.length, maxWidth);
        for (let i = 0; i < len; i++) out.push(walk(v[i], depth + 1));
        if (v.length > maxWidth) out.push(`[Truncated ${v.length - maxWidth}]`);
        return out;
      }
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const k of Object.keys(v as object)) {
        if (count++ >= maxWidth) break;
        try {
          out[k] = walk((v as Record<string, unknown>)[k], depth + 1);
        } catch {
          out[k] = '[GetterError]';
        }
      }
      return out;
    } finally {
      seen.delete(v as object);
    }
  }

  try {
    const json = JSON.stringify(walk(value, 0), (_k, v) => {
      if (typeof v === 'string') {
        budget -= v.length;
        if (budget < 0) return '[Budget]';
      }
      return v;
    });
    return json ?? null;
  } catch {
    return null;
  }
}

/** 按点分路径读取全局变量（只读，不触发副作用地取不到就返回 undefined） */
export function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    try {
      cur = (cur as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  }
  return cur;
}
