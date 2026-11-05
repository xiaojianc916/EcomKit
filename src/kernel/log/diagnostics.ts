import type { JobRecord } from '../jobs/types';
import { STORAGE_KEYS } from '../storage/keys';
import type { LogEntry, LogLevel } from './logger';

/**
 * 诊断包（方案 §6.7）。
 *
 * 它是**纯数据结构**：只负责组装一个可以 JSON.stringify 的对象，zip 打包和下载留给调用方
 * （设置页拿到 json 字符串后自己用 JSZip 打包，内核不引依赖）。
 *
 * 两条硬规则：
 *   1. **值全部截断成类型名**：抓包数据只保留结构骨架，避免把整页商品数据带出去；
 *   2. **去掉 Cookie、账号、完整 URL 的查询参数**：只保留到 path（§6.7「不包含」一段）。
 */

/** 诊断包的格式版本，改了结构就 +1 */
export const DIAGNOSTICS_VERSION = 1;

/** 数组最多保留几项（结构骨架足够看清形状） */
export const MAX_ARRAY_ITEMS = 3;
/** 嵌套最大深度，超过直接标成 '…' */
export const MAX_DEPTH = 6;
/** 字符串最多保留多少字符（类型名之外的内容一律砍掉） */
export const MAX_STRING_PREVIEW = 60;

/** 值的骨架表示：要么是类型名，要么是递归的结构 */
export type Skeleton = string | { [key: string]: Skeleton } | Skeleton[];

/**
 * 把一个任意值转成「结构骨架」。
 * 例：{ goods: { title: '夏季连衣裙', images: [{ url: 'https://…' }] } }
 *   → { goods: { title: 'string(6)', images: ['⟨object⟩'] } }
 */
export function toSkeleton(value: unknown, depth = 0): Skeleton {
  if (depth > MAX_DEPTH) return '…';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  switch (typeof value) {
    case 'string': {
      // 字符串只给长度，不给内容：标题、链接都可能含用户信息
      return `string(${value.length})`;
    }
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'bigint':
      return 'bigint';
    case 'function':
      return 'function';
    case 'symbol':
      return 'symbol';
    default:
      break;
  }

  if (Array.isArray(value)) {
    // 只取前几项作为「元素形状」的样本
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => toSkeleton(item, depth + 1));
  }

  if (value instanceof Date) return 'date';
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return 'binary';

  const out: Record<string, Skeleton> = {};
  let count = 0;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    // 敏感字段直接不出现，避免结构骨架里连字段名都带出去
    if (isSensitiveKey(key)) {
      out[key] = '⟨redacted⟩';
      continue;
    }
    if (count >= 50) {
      out['…'] = `还有更多字段`;
      break;
    }
    out[key] = toSkeleton((value as Record<string, unknown>)[key], depth + 1);
    count += 1;
  }
  return out;
}

/** 需要在骨架里抹掉的字段名（大小写不敏感） */
const SENSITIVE_KEYS = [
  'cookie',
  'cookies',
  'set-cookie',
  'authorization',
  'auth',
  'token',
  'access_token',
  'refresh_token',
  'sessionid',
  'session_id',
  'sid',
  'password',
  'passwd',
  'secret',
  'phone',
  'mobile',
  'user_id',
  'uid',
  'account',
  'nickname',
  'avatar',
];

export function isSensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_KEYS.some((sensitive) => lowered === sensitive.replace(/[-_]/g, ''));
}

/**
 * URL 脱敏：只保留 origin + pathname + 白名单查询参数（商品 ID）。
 * 为什么保留商品 ID：排查「这个商品为什么解析不出来」时必须知道是哪个商品（§6.7）。
 */
export function scrubUrl(url: string, keepParams: readonly string[] = ['goods_id', 'id']): string {
  try {
    const parsed = new URL(url);
    const out = new URL(parsed.origin + parsed.pathname);
    for (const name of keepParams) {
      const value = parsed.searchParams.get(name);
      if (value !== null) out.searchParams.set(name, value);
    }
    return out.toString();
  } catch {
    // 不是合法 URL：至少把查询串去掉
    const idx = url.indexOf('?');
    return idx >= 0 ? url.slice(0, idx) : url;
  }
}

/** 单个数据源的产出统计（§6.7「各数据源产出的数量和耗时」） */
export interface SourceStat {
  id: string;
  /** 产出条目数 */
  count: number;
  /** 耗时毫秒 */
  ms: number;
  /** 是否失败 */
  failed?: boolean;
}

/** 页面识别信息（§6.7） */
export interface PageInfo {
  url: string;
  matched: boolean;
  pageKind?: string;
  platform?: string;
  productId?: string;
  status?: string;
  blocker?: string;
}

/** 抓包数据的结构骨架（§6.7） */
export interface CaptureSkeleton {
  ruleId: string;
  count: number;
  skeleton: Skeleton;
}

export interface DiagnosticsInput {
  version: string;
  userAgent?: string;
  page?: PageInfo;
  sources?: SourceStat[];
  captures?: CaptureSkeleton[];
  logs?: LogEntry[];
  jobs?: JobRecord[];
  /** 目录状态等其它环境信息 */
  env?: Record<string, string | number | boolean>;
}

export interface DiagnosticsPackage {
  v: number;
  generatedAt: number;
  version: string;
  userAgent?: string;
  page?: PageInfo;
  sources: SourceStat[];
  captures: CaptureSkeleton[];
  logs: Array<{ at: number; level: LogLevel; scope: string; msg: string; data?: unknown }>;
  jobs: Array<{
    id: string;
    type: string;
    status: string;
    total: number;
    done: number;
    skipped: number;
    bytes: number;
    failedCount: number;
    createdAt: number;
    startedAt?: number;
    endedAt?: number;
  }>;
  env: Record<string, string | number | boolean>;
}

/** 日志里最多带多少条（§6.7：最近 500 条） */
export const MAX_LOGS = 500;
/** 任务记录最多带多少个（§6.7：最近 20 个） */
export const MAX_JOBS = 20;

/**
 * 组装诊断包。返回**纯 JSON 可序列化**的对象，调用方直接 JSON.stringify 塞进 zip。
 */
export function buildDiagnostics(input: DiagnosticsInput, now = Date.now()): DiagnosticsPackage {
  const page = input.page ? { ...input.page, url: scrubUrl(input.page.url) } : undefined;

  const pkg: DiagnosticsPackage = {
    v: DIAGNOSTICS_VERSION,
    generatedAt: now,
    version: input.version,
    sources: input.sources ?? [],
    captures: input.captures ?? [],
    logs: (input.logs ?? []).slice(-MAX_LOGS).map((entry) => {
      const out: DiagnosticsPackage['logs'][number] = {
        at: entry.at,
        level: entry.level,
        scope: entry.scope,
        msg: entry.msg,
      };
      if (entry.data !== undefined) out.data = toSkeleton(entry.data);
      return out;
    }),
    jobs: (input.jobs ?? []).slice(0, MAX_JOBS).map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      total: job.total,
      done: job.done,
      skipped: job.skipped,
      bytes: job.bytes,
      failedCount: job.failed.length,
      createdAt: job.createdAt,
      ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
      ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
    })),
    env: input.env ?? {},
  };

  if (input.userAgent !== undefined) pkg.userAgent = input.userAgent;
  if (page !== undefined) pkg.page = page;
  return pkg;
}

/** 组装成字符串，直接交给下载逻辑（§6.7：zip 打包留给调用方） */
export function dumpDiagnostics(input: DiagnosticsInput, now = Date.now()): string {
  return JSON.stringify(buildDiagnostics(input, now), null, 2);
}

/** 诊断包的文件名：带时间戳，方便用户回传时区分 */
export function diagnosticsFileName(now = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `ecbox-diagnostics-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

/** 诊断包的存储分区说明（调用方决定把 zip 放哪；这里只是常量，避免各处写死） */
export const DIAGNOSTICS_STORE = STORAGE_KEYS.stores.logs;
