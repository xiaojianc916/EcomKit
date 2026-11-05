import { z } from 'zod';
import type { ProductSnapshot } from '../../kernel/model/product';

/**
 * `.ecbox.json` 增量记录（§9.11）。
 *
 * 它决定「这次要下哪些、哪些能跳过」，所以两件事都不能含糊：
 * 1. **写入**：结构固定，v 是版本号，以后加字段靠 v 迁移（§8.6「旧版本自动迁移」）。
 * 2. **读取**：用宽松 Zod 校验。文件是上一版插件写的、或者被用户手改过，
 *    都可能出现缺字段；解析失败不能直接崩，也不能默默当成「没有记录」，
 *    否则用户会以为增量失效。方案要求**改名保留现场**：`.ecbox.broken-<时间>.json`。
 */

export const MANIFEST_FILE = '.ecbox.json';
export const MANIFEST_VERSION = 1;

/** 单个文件的记录：相对路径 + 字节数 + 完成时间 */
export const ManifestFileEntry = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  at: z.number(),
});
export type ManifestFileEntry = z.infer<typeof ManifestFileEntry>;

export const FolderManifest = z.object({
  v: z.number().int().positive(),
  platform: z.string().min(1),
  productId: z.string().min(1),
  url: z.string(),
  title: z.string(),
  updatedAt: z.number(),
  /** itemKey → 文件记录（§9.11 的 files 字段） */
  files: z.record(z.string(), ManifestFileEntry),
});
export type FolderManifest = z.infer<typeof FolderManifest>;

/** 只有版本号对得上、结构也完整的才认为是本版本的记录；其余一律当“要迁移”或“损坏” */
export type ParseManifestResult =
  | { kind: 'ok'; manifest: FolderManifest }
  | { kind: 'broken'; reason: string };

/**
 * 解析 .ecbox.json 的文本。
 * 纯函数：不做 IO，也不做改名，改名由调用方按 kind==='broken' 处理。
 */
export function parseFolderManifest(text: string | null | undefined): ParseManifestResult {
  if (text === null || text === undefined || text.trim() === '') {
    return { kind: 'broken', reason: 'empty' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'broken', reason: 'invalid-json' };
  }
  const parsed = FolderManifest.safeParse(json);
  if (!parsed.success) return { kind: 'broken', reason: 'schema' };
  if (parsed.data.v !== MANIFEST_VERSION) {
    // 现在的 v1 还没有旧版本可迁移；将来在这里接 migrations
    return { kind: 'broken', reason: `unsupported-version:${parsed.data.v}` };
  }
  return { kind: 'ok', manifest: parsed.data };
}

/** 损坏文件的保留名（§9.11：`.ecbox.broken-<时间>.json`） */
export function brokenManifestName(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `.ecbox.broken-${stamp}.json`;
}

export interface BuildManifestInput {
  snapshot: ProductSnapshot;
  files: Record<string, ManifestFileEntry>;
  /** 写入时间 */
  at: number;
}

/** 生成要写盘的清单对象（纯函数）。字段顺序固定，方便做快照测试 */
export function buildFolderManifest(input: BuildManifestInput): FolderManifest {
  const { snapshot, files, at } = input;
  return {
    v: MANIFEST_VERSION,
    platform: snapshot.platform,
    productId: snapshot.productId,
    url: snapshot.url,
    title: snapshot.title,
    updatedAt: at,
    files,
  };
}

/** 序列化成写盘用的文本：2 空格缩进 + 结尾换行（和仓库里其它 json 一致） */
export function serializeFolderManifest(manifest: FolderManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export interface HistorySummary {
  /** 最近一次写入时间 */
  lastAt: number;
  /** 当前快照里有、但记录里没有（或大小不一致）的 itemKey */
  missing: string[];
  /** 记录里已有的文件数 */
  total: number;
}

/**
 * 历史对比（§9.11「历史提示」、§8.6 service.history.get）。
 *
 * 入参 expected 是「当前快照会产生的 itemKey → 期望字节数」。期望字节数为 undefined 时
 * 只比存在性（还没下过，自然也不知道大小）。记录里有、但当前快照没有的条目不算缺失 ——
 * 平台下架了某张图，不应该让用户一直看到「还缺 3 个」。
 */
export function summarizeHistory(
  manifest: FolderManifest | null,
  expected: ReadonlyMap<string, number | undefined>,
): HistorySummary | null {
  if (manifest === null) return null;
  const missing: string[] = [];
  for (const [itemKey, expectedSize] of expected) {
    const hit = manifest.files[itemKey];
    if (hit === undefined) {
      missing.push(itemKey);
      continue;
    }
    if (expectedSize !== undefined && hit.size !== expectedSize) missing.push(itemKey);
  }
  return {
    lastAt: manifest.updatedAt,
    missing,
    total: Object.keys(manifest.files).length,
  };
}

/** 合并新的文件记录到已有清单上（增量写入，§9.6 每 10 个文件写一次） */
export function mergeManifestFiles(
  previous: FolderManifest | null,
  next: Record<string, ManifestFileEntry>,
): Record<string, ManifestFileEntry> {
  return { ...(previous?.files ?? {}), ...next };
}
