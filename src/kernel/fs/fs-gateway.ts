import { EcError } from '../errors/ec-error';
import type { Logger } from '../log/logger';
import { NAME_LIMITS, nameKey, sanitizeName } from '../naming/sanitize';
import { createFolderIndex, type FolderIndex, folderIndex } from './folder-index';
import { handleStore } from './handle-store';
import type { DirEntry, FsGateway, FsSink, RelPath, WriteResult } from './types';

/**
 * 写入网关（方案 §9.3、§9.6）。
 *
 * 职责：把「商品 → 文件夹」这件事固定下来，让功能层完全不用关心当前用的是
 * FSA 还是 downloads 兜底（§9.13）。功能层只说「给这个商品写 主图/01.jpg」。
 *
 * 商品文件夹定位的三步（ADR-6）：
 *   1. 查索引；
 *   2. 索引没有（或文件夹被删/改名）→ 扫平台目录下以 `_商品ID` 结尾的文件夹，取最近修改的一个；
 *   3. 都没有 → 按模板新建，并回写索引。
 */

export interface FsGatewayOptions {
  sink: FsSink;
  index?: FolderIndex;
  /** 取 rootId；默认从 handles 表读（换根目录后旧索引自然失效，§6.5） */
  rootId?: () => Promise<string | null>;
  log?: Logger;
}

/** 商品 ID 后缀：文件夹名以它结尾就认为是同一个商品（大小写不敏感，§9.3） */
const MAX_PATH_SEGMENTS = 6;

export function createFsGateway(opts: FsGatewayOptions): FsGateway {
  // 可变：设置里切换「自选文件夹 / 浏览器下载目录」时替换（§9.13、§11）
  let sink: FsSink = opts.sink;
  const index = opts.index ?? folderIndex();
  const loadRootId = opts.rootId ?? (() => handleStore().rootId());

  async function requireRootId(): Promise<string> {
    const id = await loadRootId();
    if (!id) throw new EcError('DIR_UNSET');
    return id;
  }

  /** 平台文件夹名按 §9.2 限制 10 字素；用去重后的名字保证两次调用一致 */
  function platformSegment(platform: string): string {
    return sanitizeName(platform, { maxLength: NAME_LIMITS.platform });
  }

  /**
   * 步骤 2：扫平台目录下以 `_商品ID` 结尾的文件夹。
   * 平台目录下可能有几千个子目录，所以只在索引没命中时才扫（§9.3 的取舍说明）。
   */
  async function scanByIdSuffix(platformDir: RelPath, productId: string): Promise<string | null> {
    const suffix = `_${productId.toLowerCase()}`;
    let entries: DirEntry[];
    try {
      entries = await sink.listDir(platformDir);
    } catch {
      // 目录还不存在（第一次下载）或者不可读 → 当作没找到
      return null;
    }
    const matches = entries
      .filter((e) => e.kind === 'directory' && nameKey(e.name).endsWith(suffix))
      .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
    return matches[0]?.name ?? null;
  }

  const gateway: FsGateway = {
    // getter 而不是固定值：切换 sink 后所有调用点立刻用新的（engine 里保留 gateway 引用即可）
    get sink() {
      return sink;
    },

    setSink(next: FsSink): void {
      sink = next;
    },

    async status() {
      return sink.status();
    },

    /** §9.3 商品文件夹定位 */
    async resolveProductFolder({ platform, productId, preferredName }) {
      const rootId = await requireRootId();
      const platformName = platformSegment(platform);
      const platformDir: RelPath = [platformName];

      const cached = await index.get(rootId, platform, productId);
      if (cached) {
        // 索引命中还要确认文件夹真的还在：用户可能手动删了它
        try {
          const entries = await sink.listDir(platformDir);
          const stillThere = entries.some(
            (e) => e.kind === 'directory' && nameKey(e.name) === nameKey(cached.folderName),
          );
          if (stillThere) {
            await index.set(rootId, platform, productId, cached.folderName);
            return {
              dir: [platformName, cached.folderName],
              folderName: cached.folderName,
              platformDir,
            };
          }
        } catch {
          // 平台目录都读不了 → 走后面的重建流程
        }
      }

      const found = await scanByIdSuffix(platformDir, productId);
      if (found) {
        await index.set(rootId, platform, productId, found);
        return { dir: [platformName, found], folderName: found, platformDir };
      }

      // 步骤 3：按模板新建。模板保证带 _ID 后缀（§9.1），所以下次能被扫回来
      const folderName = sanitizeName(preferredName, { maxLength: NAME_LIMITS.folder });
      await sink.ensureDir([platformName, folderName]);
      await index.set(rootId, platform, productId, folderName);
      return { dir: [platformName, folderName], folderName, platformDir };
    },

    async ensurePlatformDir(platform) {
      const platformName = platformSegment(platform);
      await sink.ensureDir([platformName]);
      return [platformName];
    },

    async ensureSubdir(parent, name) {
      const segment = sanitizeName(name, { maxLength: NAME_LIMITS.subdir });
      const next = [...parent, segment];
      // §9.2「相对路径合计 ≤ 120」：超了就只保留最后几段，避免 MAX_PATH 问题
      const trimmed = next.length > MAX_PATH_SEGMENTS ? next.slice(-MAX_PATH_SEGMENTS) : next;
      await sink.ensureDir(trimmed);
      return trimmed;
    },

    async writeFile(
      dir: RelPath,
      name: string,
      data: Blob | ReadableStream<Uint8Array>,
      signal: AbortSignal,
    ): Promise<WriteResult> {
      return sink.writeFile(dir, name, data, signal);
    },

    async readJson<T>(dir: RelPath, name: string): Promise<T | null> {
      const text = await sink.readText(dir, name);
      if (text === null) return null;
      try {
        return JSON.parse(text) as T;
      } catch {
        // 解析失败交给调用方处理（§9.11：改名保留现场后按「没有记录」处理）
        throw new EcError('INTERNAL', { reason: 'json-parse-failed' });
      }
    },

    async writeJson(dir, name, value): Promise<void> {
      await sink.writeText(dir, name, `${JSON.stringify(value, null, 2)}\n`);
    },

    async readText(dir, name): Promise<string | null> {
      return sink.readText(dir, name);
    },

    async writeText(dir, name, text): Promise<void> {
      await sink.writeText(dir, name, text);
    },

    async rename(dir, from, to): Promise<void> {
      await sink.rename(dir, from, to);
    },

    async exists(dir, name): Promise<number | null> {
      return sink.exists(dir, name);
    },
  };

  return gateway;
}

/** 内存索引版本，方便单测和「临时换目录」场景 */
export function createFsGatewayWithMemoryIndex(
  sink: FsSink,
  rootId: string,
  log?: Logger,
): FsGateway {
  return createFsGateway({
    sink,
    index: createFolderIndex(
      (() => {
        const map = new Map<string, { folderName: string; lastAt: number }>();
        return {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: { folderName: string; lastAt: number }) => {
            map.set(key, value);
          },
          del: async (key: string) => {
            map.delete(key);
          },
          keys: async () => [...map.keys()],
        };
      })(),
    ),
    rootId: async () => rootId,
    ...(log ? { log } : {}),
  });
}
