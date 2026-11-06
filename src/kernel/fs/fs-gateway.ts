import type { Logger } from '../log/logger';
import { NAME_LIMITS, nameKey, sanitizeName } from '../naming/sanitize';
import { createFolderIndex, type FolderIndex, folderIndex } from './folder-index';
import { handleStore } from './handle-store';
import type { DirEntry, FsGateway, FsSink, RelPath, WriteFileOptions, WriteResult } from './types';

/**
 * 写入网关（方案 §9.3、§9.6）。
 *
 * 职责：把「商品 → 文件夹」这件事固定下来，让功能层完全不用关心当前用的是
 * FSA 还是 downloads 兜底（§9.13）。功能层只说「给这个商品写 主图/主图01.jpg」。
 *
 * 商品文件夹定位的三步（ADR-6）：
 *   1. 查索引；
 *   2. 索引没有（或文件夹被删/改名）→ 扫**根目录**下以 `_商品ID` 结尾的文件夹，取最近修改的一个；
 *   3. 都没有 → 按模板新建，并回写索引。
 *
 * 为什么扫根目录、不再有平台目录层：默认模板是 `{platform}_商品ID_{id}`，
 * 商品文件夹名本身就带了平台（拼多多_商品ID_1019084314929）。外面再套一层「拼多多」
 * 只会得到 根目录/拼多多/拼多多_商品ID_… 这种半截重复，用户还要多点开一层。
 */

export interface FsGatewayOptions {
  sink: FsSink;
  index?: FolderIndex;
  /** 取 rootId；默认从 handles 表读（换根目录后旧索引自然失效，§6.5） */
  rootId?: () => Promise<string | null>;
  log?: Logger;
}

/** 商品 ID 后缀：文件夹名以它结尾就认为是同一个商品（大小写不敏感，§9.3） */
const ROOT: RelPath = [];

export function createFsGateway(opts: FsGatewayOptions): FsGateway {
  // 可变：设置里切换「自选文件夹 / 浏览器下载目录」时替换（§9.13、§11）
  let sink: FsSink = opts.sink;
  const index = opts.index ?? folderIndex();
  const loadRootId = opts.rootId ?? (() => handleStore().rootId());

  /**
   * 步骤 2：扫根目录下以 `_商品ID` 结尾的文件夹。
   *
   * 根目录下可能有几百个商品文件夹，所以只在索引没命中时才扫（§9.3 的取舍说明）。
   * 用 endsWith 而不是 includes：_123 不能匹配到 _1234 那个商品。
   */
  async function scanByIdSuffix(productId: string): Promise<string | null> {
    const suffix = `_${productId.toLowerCase()}`;
    let entries: DirEntry[];
    try {
      entries = await sink.listDir(ROOT);
    } catch {
      // 根目录还没就绪（第一次下载 / 没授权）→ 当作没找到
      return null;
    }
    const matches = entries
      .filter((e) => e.kind === 'directory' && nameKey(e.name).endsWith(suffix))
      .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
    return matches[0]?.name ?? null;
  }

  /** 索引里记着的名字是否还真的在盘上（用户可能手动删了它） */
  async function stillOnDisk(folderName: string): Promise<boolean> {
    try {
      const entries = await sink.listDir(ROOT);
      return entries.some((e) => e.kind === 'directory' && nameKey(e.name) === nameKey(folderName));
    } catch {
      // 根目录读不了 → 当作不在，走后面的重建流程
      return false;
    }
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

    /**
     * §9.3 商品文件夹定位。
     *
     * **rootId 只用于索引的命名空间，不是下载的前提**：
     * downloads 兜底模式（§9.13）根本没有目录句柄，旧实现却一上来就 requireRootId()，
     * 于是「改标题不新建文件夹」这条 ADR-6 的承诺在 downloads 模式下完全不成立 ——
     * 定位抛 DIR_UNSET、调用方退回模板路径、标题一变就多一个文件夹。
     */
    async resolveProductFolder({ platform, productId, preferredName }) {
      const rootId = await loadRootId().catch(() => null);

      if (rootId !== null) {
        const cached = await index.get(rootId, platform, productId);
        if (cached && (await stillOnDisk(cached.folderName))) {
          // 刷新 lastAt：索引里这个字段就是「最后一次使用」，诊断和清理都靠它
          await index.set(rootId, platform, productId, cached.folderName);
          return { dir: [cached.folderName], folderName: cached.folderName };
        }
      }

      const found = await scanByIdSuffix(productId);
      if (found) {
        if (rootId !== null) await index.set(rootId, platform, productId, found);
        return { dir: [found], folderName: found };
      }

      // 步骤 3：按模板新建。模板保证带 _ID 后缀（§9.1），所以下次能被扫回来
      const folderName = sanitizeName(preferredName, { maxLength: NAME_LIMITS.folder });
      await sink.ensureDir([folderName]);
      if (rootId !== null) await index.set(rootId, platform, productId, folderName);
      return { dir: [folderName], folderName };
    },

    async writeFile(
      dir: RelPath,
      name: string,
      data: Blob | ReadableStream<Uint8Array>,
      signal: AbortSignal,
      opts?: WriteFileOptions,
    ): Promise<WriteResult> {
      return sink.writeFile(dir, name, data, signal, opts);
    },

    async readText(dir, name): Promise<string | null> {
      return sink.readText(dir, name);
    },

    async writeText(dir, name, text): Promise<void> {
      await sink.writeText(dir, name, text);
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
