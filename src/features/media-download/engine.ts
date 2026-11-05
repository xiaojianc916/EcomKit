/**
 * media-download 的 engine（方案 §8.6、§9.6）：注册 `media-download` 任务类型。
 *
 * 跑在 **Offscreen**（ADR-1）：只有这里能拿目录句柄写文件、能转码、不受 SW 30 秒回收影响。
 *
 * 三段式：plan 算要写什么（纯函数）→ run 逐个下载写入 → finalize 写清单和信息文件。
 */
import { z } from 'zod';
import type { JobTypeDef, ItemResult } from '../../kernel/jobs/types';
import type { ProductSnapshot } from '../../kernel/model/product';
import { EcError } from '../../kernel/errors/ec-error';
import { sniff } from '../../kernel/net/sniff';
import { planDownload, type PlannerSettings } from './planner';
import { buildInfoTxt } from './info-txt';
import {
  MANIFEST_FILE,
  buildFolderManifest,
  mergeManifestFiles,
  parseFolderManifest,
  serializeFolderManifest,
  type ManifestFileEntry,
} from './folder-manifest';
import { DEFAULT_MEDIA_DOWNLOAD_SETTINGS } from './settings';

const PayloadSchema = z.object({
  snapshot: z.unknown(),
  selection: z.object({
    kinds: z.array(z.enum(['main', 'sku', 'detail', 'video'])),
    keys: z.array(z.string()).optional(),
  }),
  settings: z.unknown(),
  platformDisplayName: z.string(),
});

export interface MediaDownloadPayload {
  snapshot: ProductSnapshot;
  selection: { kinds: ('main' | 'sku' | 'detail' | 'video')[]; keys?: string[] };
  settings: PlannerSettings;
  platformDisplayName: string;
}

/** 扩展名一律由内容嗅探决定，不信 URL 后缀（§9.1） */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/mp2t': 'ts',
};

function settingsOf(p: MediaDownloadPayload): PlannerSettings {
  return (p.settings ?? DEFAULT_MEDIA_DOWNLOAD_SETTINGS) as unknown as PlannerSettings;
}

function planOf(p: MediaDownloadPayload) {
  return planDownload({
    snapshot: p.snapshot,
    selection: p.selection as never,
    settings: settingsOf(p),
    platformDisplayName: p.platformDisplayName,
  });
}

export const mediaDownloadJobType: JobTypeDef<MediaDownloadPayload, unknown> = {
  type: 'media-download',
  payload: PayloadSchema as unknown as z.ZodType<MediaDownloadPayload>,

  /** 同一商品同一时间只允许一个任务（§6.4） */
  dedupeKey: (p) => p.snapshot.platform + ':' + p.snapshot.productId,

  requiresDir: true,

  async plan(p) {
    const plan = planOf(p);
    // WorkItem 是通用结构，没有"商品文件夹"这一层；但真正落盘时必须先落在
    // 【平台/商品名_ID/主图/01.jpg】这样的完整相对路径下。
    // 所以 plan 阶段把 plan.folder 作为前缀拼进每个 item.dir，
    // run 阶段就能直接用 dir 建目录、写文件，不需要再去拿 payload。
    return plan.items.map((item) => ({
      ...item,
      dir: [...plan.folder, ...item.dir],
    }));
  },

  async run(item, ctx) {
    // run 只拿到 item，商品文件夹在 finalize 的 record.payload 里；
    // 这里从 JobRecord 拿不到 payload，所以把 folder 写进 item.dir 的前缀（plan 阶段已拼好）
    const dir = item.dir;
    try {
      // 1. 下载：多候选切换、重试、超时都在 fetcher（§9.7）
      const res = await ctx.net.fetchWithFallback(item.candidates, {
        signal: ctx.signal,
        kind: item.expect,
      });
      const blob = await res.blob();

      // 2. 嗅探决定扩展名
      const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
      const sniffed = sniff(head);
      let finalExt = MIME_EXT[sniffed.mime] ?? sniffed.ext ?? 'bin';

      // 3. 按需转码（WebP/AVIF → JPG，§9.8）
      let payload: Blob = blob;
      if (item.expect === 'image') {
        try {
          const converted = await ctx.media.toJpeg(blob);
          if (converted && converted.size > 0) {
            payload = converted;
            finalExt = 'jpg';
          }
        } catch {
          /* 转码失败就用原图 */
        }
      }

      // 4. 原子写入（§9.10）：dir 已是完整相对路径，逐级建目录
      const targetDir = dir.slice(0, -1);
      for (let i = 0; i <= targetDir.length; i++) {
        await ctx.fs.sink.ensureDir(targetDir.slice(0, i) as never);
      }
      const name = await ctx.fs.sink.resolveName(targetDir as never, item.stem, finalExt);
      const written = await ctx.fs.writeFile(targetDir as never, name, payload, ctx.signal);

      return {
        itemKey: item.itemKey,
        status: 'ok',
        bytes: written.size,
        path: [...targetDir, written.name].join('/'),
      } satisfies ItemResult;
    } catch (e) {
      return { itemKey: item.itemKey, status: 'failed', code: EcError.from(e).code };
    }
  },

  async finalize(p, results, ctx) {
    const plan = planOf(p);
    const root = plan.folder;
    const ok = results.filter((r) => r.status === 'ok');

    // 1. .ecbox.json（增量下载依据，§9.11）
    try {
      const existing = parseFolderManifest(await ctx.fs.readText(root as never, MANIFEST_FILE));
      const files: Record<string, ManifestFileEntry> =
        existing.kind === 'ok' ? { ...existing.manifest.files } : {};
      for (const r of ok) {
        files[r.itemKey] = { path: r.path ?? '', size: r.bytes ?? 0, at: Date.now() };
      }
      const previous = existing.kind === 'ok' ? existing.manifest : null;
      const merged = mergeManifestFiles(previous, files);
      const manifest = buildFolderManifest({
        snapshot: p.snapshot,
        files: merged,
        at: Date.now(),
      });
      await ctx.fs.writeText(root as never, MANIFEST_FILE, serializeFolderManifest(manifest));
    } catch (e) {
      ctx.log.warn('写 .ecbox.json 失败', e);
    }

    // 2. 商品信息.txt（UTF-8 BOM + CRLF，§9.12）
    if (settingsOf(p).infoTxt !== false) {
      try {
        await ctx.fs.writeText(
          root as never,
          '商品信息.txt',
          buildInfoTxt({ snapshot: p.snapshot, at: Date.now() }),
        );
      } catch (e) {
        ctx.log.warn('写商品信息.txt 失败', e);
      }
    }
  },
};

export default { jobTypes: [mediaDownloadJobType] };