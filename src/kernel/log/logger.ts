export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  at: number;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: unknown;
}

/**
 * 内存环形缓冲，最多 500 条（§6.5、§6.7）。
 *
 * 用 head 游标而不是 push + splice(0, 1)：后者在缓冲满了之后每写一条都要把
 * 剩下 499 个元素整体前移一次，一整轮下载（几百条日志）就是几十万次指针搬运。
 * head 游标下 push 是 O(1)，只有 snapshot() 需要按顺序复制一份。
 */
export class LogBuffer {
  private readonly limit: number;
  private items: LogEntry[] = [];
  /** 环形起点：items[head] 是最旧的一条 */
  private head = 0;

  constructor(limit = 500) {
    this.limit = limit;
  }

  push(entry: LogEntry): void {
    if (this.items.length < this.limit) {
      this.items.push(entry);
      return;
    }
    // 缓冲已满：覆盖最旧的一条并后移起点
    this.items[this.head] = entry;
    this.head = (this.head + 1) % this.limit;
  }

  /** 按时间顺序返回一份拷贝（调用方可能长持有，所以必须复制） */
  snapshot(): LogEntry[] {
    if (this.items.length < this.limit || this.head === 0) return [...this.items];
    return [...this.items.slice(this.head), ...this.items.slice(0, this.head)];
  }

  clear(): void {
    this.items = [];
    this.head = 0;
  }
}

export const logBuffer = new LogBuffer();

let currentLevel: LogLevel = 'info';
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function emit(level: LogLevel, scope: string, msg: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const entry: LogEntry = { at: Date.now(), level, scope, msg };
  if (data !== undefined) entry.data = snapshotData(data);
  logBuffer.push(entry);
  const line = `[${scope}] ${msg}`;
  if (level === 'error') console.error(line, data ?? '');
  else if (level === 'warn') console.warn(line, data ?? '');
  else if (level === 'debug') console.debug(line, data ?? '');
  else console.info(line, data ?? '');
}

/**
 * 日志数据的快照拷贝：先尽量拿结构化克隆，拿不到时退回 JSON 往返拿到一份 JSON 安全的副本。
 *
 * 优先用官方的 structuredClone（结构化克隆算法，原生实现）：JSON 往返要先把整个
 * 对象序列化成字符串再解析回来，对大对象的开销是 3~5 倍，而且会丢掉 Date / Map 的语义
 * （诊断包的 toSkeleton 对 Date 本来就有专门分支）。
 *
 * **JSON 那一段是有意保留的兜底，不是漏改成 structuredClone**：走到那里说明 structuredClone
 * 已经抛过了（数据里有函数、Proxy、DOM 节点这类不可克隆的东西，日志里很常见），
 * 此时要的就是「把数据压成 JSON 能表达的样子」这份快照，而不是再拷贝一次原对象 ——
 * 名字里的 snapshot 就是在说这件事。
 */
function snapshotData(v: unknown): unknown {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(v);
    } catch {
      // 含函数 / Proxy / 不可克隆对象：退回 JSON 路径
    }
  }
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  scope(name: string): Logger;
}

export function createLogger(scope = 'app'): Logger {
  return {
    debug: (m, d) => emit('debug', scope, m, d),
    info: (m, d) => emit('info', scope, m, d),
    warn: (m, d) => emit('warn', scope, m, d),
    error: (m, d) => emit('error', scope, m, d),
    scope: (name) => createLogger(scope ? `${scope}.${name}` : name),
  };
}

export const logger = createLogger('ecbox');
