export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  at: number;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: unknown;
}

/** 内存环形缓冲，最多 500 条（§6.5、§6.7） */
export class LogBuffer {
  private readonly limit: number;
  private readonly items: LogEntry[] = [];

  constructor(limit = 500) {
    this.limit = limit;
  }

  push(entry: LogEntry): void {
    this.items.push(entry);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
  }

  snapshot(): LogEntry[] {
    return [...this.items];
  }

  clear(): void {
    this.items.length = 0;
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
  if (data !== undefined) entry.data = safeClone(data);
  logBuffer.push(entry);
  const line = `[${scope}] ${msg}`;
  if (level === 'error') console.error(line, data ?? '');
  else if (level === 'warn') console.warn(line, data ?? '');
  else if (level === 'debug') console.debug(line, data ?? '');
  else console.info(line, data ?? '');
}

function safeClone(v: unknown): unknown {
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