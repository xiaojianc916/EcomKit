/**
 * media-download 的 engine（方案 §8.6、§9.6）：注册 `media-download` 任务类型。
 *
 * 跑在 **Offscreen**（ADR-1）：只有这里能拿目录句柄写文件、能转码、不受 SW 30 秒回收影响。
 *
 * 三段式：plan 算要写什么（纯函数）→ run 逐个下载写入 → finalize 写清单和信息文件。
 *
 * 载荷定义在 ./payload.ts，和页面共用同一份 Zod schema —— 页面少传字段会当场报错，
 * 不会变成「点了没反应」。
 */
import type { z } from 'zod';
import { EcError } from '../../kernel/errors/ec-error';
import type { FsGateway } from '../../kernel/fs/types';
import type { ItemResult, JobTypeDef, WorkItem } from '../../kernel/jobs/types';
import { createLogger, type Logger } from '../../kernel/log/logger';
import { isConvertibleMime } from '../../kernel/media/convert';
import { readHead, SNIFF_BYTES, sniff } from '../../kernel/net/sniff';
import {
  buildFolderManifest,
  type FolderManifest,
  MANIFEST_FILE,
  type ManifestFileEntry,
  mergeManifestFiles,
  parseFolderManifest,
  serializeFolderManifest,
  summarizeHistory,
} from './folder-manifest';
import { buildInfoTxt } from './info-txt';
import {
  type MediaDownloadPayload,
  MediaDownloadPayloadSchema,
  planOf,
  platformDisplayName,
} from './payload';
import type { PlannerSettings } from './planner';

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

/** engine 的 extra：整个任务共享的只读上下文（清单 + 计划根目录） */
export interface MediaDownloadExtra {
  payload: MediaDownloadPayload;
  /** 商品文件夹的相对路径（写 .ecbox.json / 商品信息.txt 的位置） */
  root: string[];
  /** 上一次的 .ecbox.json；读不到或损坏时为 null */
  manifest: FolderManifest | null;
}

/** extra() 里没有 logger 参数，定位失败时用它兜底记录 */
const fallbackLog = createLogger('media-download');

function settingsOf(p: MediaDownloadPayload): PlannerSettings {
  return p.settings as unknown as PlannerSettings;
}

/**
 * 落盘目录：**item.dir 已经是完整相对路径**（plan 阶段把商品文件夹前缀拼进去了）。
 * 旧实现在这里又 slice(0,-1)，把「主图」这一层砍掉，图片全写进商品根目录 ——
 * 面板上的「主图/详情图」分目录从未真正生效过。
 */
/** 把异常压成一行可读的原因（只进日志，不进 UI） */
function describeError(e: unknown): string {
  if (EcError.is(e)) {
    // EcError.message 就是错误码；真正有用的上下文在 detail 里
    const detail = e.detail === undefined ? '' : ` detail=${safeJson(e.detail)}`;
    return `${e.code}${detail}`;
  }
  if (e instanceof Error) {
    const stack = (e.stack ?? '').split(String.fromCharCode(10)).slice(1, 3).join(' | ');
    return `${e.name}: ${e.message} @${stack}`;
  }
  return safeJson(e);
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

export function itemTargetDir(item: Pick<WorkItem, 'dir'>): string[] {
  return [...item.dir];
}

/**
 * 视频的流式落盘（§9.9「几百 MB 的视频内存占用恒定」）。
 *
 * 和图片的区别：图片要先拿全量字节才能嗅探 + 转码，而视频只需要
 * 「读前 32 字节定扩展名 → 剩下的流直接 pipe 到文件」，全程不把内容收进内存。
 *
 * 两个必须处理的边界：
 *   · HLS 播放列表：m3u8 是几百字节的文本，直接落盘会得到一个 0:00 的假视频。
 *     读头嗅出来就直接报 UNSUPPORTED_STREAM（分片合并见 kernel/media/hls.ts）。
 *   · 重试 / 候选切换发生在 fetcher 里，拿到的已经是最终可用的流；
 *     写入层（FSA）失败会 abort，不留半截文件。
 */
async function streamVideo(
  item: WorkItem,
  response: Response,
  dir: string[],
  ctx: {
    fs: import('../../kernel/fs/types').FsGateway;
    signal: AbortSignal;
    log: import('../../kernel/log/logger').Logger;
  },
): Promise<ItemResult> {
  const { head, rest } = await readHead(response.body, SNIFF_BYTES);
  const sniffed = sniff(head);
  if (sniffed.container === 'hls' || sniffed.mime === 'application/vnd.apple.mpegurl') {
    throw new EcError('UNSUPPORTED_STREAM', { reason: 'hls-playlist' });
  }
  // 空响应体：CDN 偶尔回 200 + 0 字节（对象被删但缓存还没失效）。
  // 落一个 0 字节文件出来，用户会在资源管理器里看到一个打不开的「视频」，
  // 而且增量记录会把这条路径记成已完成，下次也不会重下。
  if (head.byteLength === 0 || rest === null) {
    throw new EcError('NETWORK', { reason: 'empty-video-body' });
  }
  const ext = MIME_EXT[sniffed.mime] ?? sniffed.ext ?? 'mp4';
  await ctx.fs.sink.ensureDir(dir as never);
  const name = await ctx.fs.sink.resolveName(dir as never, item.stem, ext);
  // downloads 模式：把**原始直链**交给浏览器下载通道，它自己流式落盘，
  // 比把几百 MB 字节塞进扩展内存再转交可靠得多（文件名也才保得住）。
  const sourceUrl = item.candidates[0];
  const written = await ctx.fs.writeFile(
    dir as never,
    name,
    rest,
    ctx.signal,
    sourceUrl === undefined ? {} : { sourceUrl },
  );
  ctx.log.debug('视频写入完成', { item: item.itemKey, size: written.size });
  return {
    itemKey: item.itemKey,
    status: 'ok',
    bytes: written.size,
    path: [...dir, written.name].join('/'),
  };
}

/**
 * 定位（必要时创建）这个商品的文件夹。
 *
 * 优先用 gateway 的定位逻辑；拿不到目录（downloads 模式 / 目录没就绪）时退回模板路径，
 * 保证「最差也能下下来」而不是整单失败。
 */
async function resolveFolder(
  p: MediaDownloadPayload,
  templateFolder: string[],
  ctx: {
    fs: import('../../kernel/fs/types').FsGateway;
    log: import('../../kernel/log/logger').Logger;
  },
): Promise<string[] | null> {
  try {
    const platformName = platformDisplayName(p.snapshot.platform);
    // 模板里最后一段就是商品文件夹名（前面可能还有平台层）
    const preferredName = templateFolder[templateFolder.length - 1] ?? p.snapshot.productId;
    const resolved = await ctx.fs.resolveProductFolder({
      platform: platformName,
      productId: p.snapshot.productId,
      preferredName,
    });
    // byPlatform=false 时用户明确要求不要多一层平台目录，去掉 gateway 补的那一层
    return p.settings.byPlatform ? [...resolved.dir] : resolved.dir.slice(1);
  } catch (e) {
    ctx.log.warn('商品文件夹定位失败，退回模板路径', e);
    return null;
  }
}

export const mediaDownloadJobType: JobTypeDef<MediaDownloadPayload, MediaDownloadExtra> = {
  type: 'media-download',
  payload: MediaDownloadPayloadSchema as unknown as z.ZodType<MediaDownloadPayload>,

  /** 同一商品同一时间只允许一个任务（§6.4） */
  dedupeKey: (p) => `${p.snapshot.platform}:${p.snapshot.productId}`,

  requiresDir: true,

  /**
   * 任务开始前读一次 .ecbox.json（增量下载的依据，§9.11）。
   * 读失败不致命：当作「没有记录」，全部重新下载。
   */
  async extra(p, { fs }): Promise<MediaDownloadExtra> {
    // 商品文件夹必须和 plan 用**同一套定位**，否则清单会写进模板算出来的另一个文件夹里，
    // 于是「改标题多一个空文件夹」+「增量记录永远读不到」同时发生。
    const template = planOf(p).folder;
    const root = (await resolveFolder(p, template, { fs, log: fallbackLog })) ?? template;
    let manifest: FolderManifest | null = null;
    try {
      const text = await fs.readText(root as never, MANIFEST_FILE);
      const parsed = parseFolderManifest(text);
      if (parsed.kind === 'ok') manifest = parsed.manifest;
    } catch {
      // 目录还没建好、或者 sink 不支持读（downloads 模式），按没有记录处理
    }
    return { payload: p, root: [...root], manifest };
  },

  async plan(p, ctx) {
    const plan = planOf(p);
    /**
     * 商品文件夹必须走 gateway 的定位（ADR-6）：
     * 索引 → 平台目录下扫 `_商品ID` 后缀 → 都没有才按模板新建。
     *
     * 旧实现直接用模板拼出来的 plan.folder 建目录，于是**商家一改标题就会多出一个文件夹**，
     * 增量下载的 .ecbox.json 留在旧文件夹里，永远命中不了。索引和扫描代码一直存在，
     * 但从来没有被下载链路调用过。
     */
    const folder = (await resolveFolder(p, plan.folder, ctx)) ?? plan.folder;
    return plan.items.map((item) => ({ ...item, dir: [...folder, ...item.dir] }));
  },

  async run(item, ctx) {
    const extra = ctx.extra;
    const dir = itemTargetDir(item);
    try {
      // 0. 增量跳过（§9.11）：清单里记过、且文件还在（大小一致）就跳过
      const recorded = extra?.manifest?.files[item.itemKey];
      if (recorded !== undefined && recorded.path !== '') {
        const segments = recorded.path.split('/').filter((s) => s !== '');
        const fileName = segments[segments.length - 1] ?? '';
        const fileDir = segments.slice(0, -1);
        if (fileName !== '') {
          try {
            const size = await ctx.fs.exists(fileDir as never, fileName);
            if (size !== null && (recorded.size <= 0 || size === recorded.size)) {
              return { itemKey: item.itemKey, status: 'skipped', bytes: size, path: recorded.path };
            }
          } catch {
            // 判断不了存在性就老实重下
          }
        }
      }

      // 1. 下载：多候选切换、重试、超时都在 fetcher（§9.7）
      ctx.log.debug('开始下载', { item: item.itemKey, candidates: item.candidates.length });
      const res = await ctx.net.fetchWithFallback(item.candidates, {
        signal: ctx.signal,
        kind: item.expect,
      });

      /**
       * 视频**不能**先 res.blob()。
       *
       * blob() 会把整个响应体收进内存：一个 500MB 的视频就是 500MB 常驻内存，
       * 而且 concurrent 2 个视频同时下就是 1GB —— 扩展进程直接被打爆。
       * 视频也不需要转码（只做扩展名判定），所以走「读 32 字节嗅探 + 剩下的流直接落盘」，
       * 内存占用与文件大小无关（§9.9）。
       */
      if (item.expect === 'video') {
        const streamed = await streamVideo(item, res, dir, ctx);
        return streamed;
      }

      const blob = await res.blob();
      ctx.log.debug('下载完成', { item: item.itemKey, size: blob.size, type: blob.type });

      // 2. 嗅探决定扩展名
      const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
      const sniffed = sniff(head);

      /**
       * HLS 播放列表绝不能当文件存下来（§9.9）。
       *
       * m3u8 本身就是几百字节的文本，直接落盘会得到一个「看起来成功」的 0:00 视频，
       * 用户以为下好了，实际打不开。这里明确报 UNSUPPORTED_STREAM，让失败列表说清楚原因。
       * （分片合并的 downloadHls 在 kernel/media/hls.ts 里，v1 不接：拼多多/抖音的
       * 视频直链实测都是 mp4，走不到这条路径；真遇到了要显式告诉用户，而不是静默给个坏文件。）
       */
      if (sniffed.mime === 'application/vnd.apple.mpegurl' || sniffed.container === 'hls') {
        throw new EcError('UNSUPPORTED_STREAM', { reason: 'hls-playlist' });
      }

      let finalExt = MIME_EXT[sniffed.mime] ?? sniffed.ext ?? 'bin';

      /**
       * 3. 按需转码（WebP/AVIF → JPG，§9.8）；设置里关掉就原样保存。
       *
       * **判定必须用嗅探结果，不能用 blob.type**：那个值来自响应的 content-type，
       * CDN 经常回 application/octet-stream，于是 WebP/AVIF 一张都不会被转，
       * 设置页的「转成 JPG」等于没生效。sniffed 是读真实文件头得到的，可靠。
       */
      let payload: Blob = blob;
      const wantsJpeg = extra?.payload.settings.toJpeg !== false;
      if (wantsJpeg && item.expect === 'image' && isConvertibleMime(sniffed.mime)) {
        try {
          const converted = await ctx.media.toJpeg(blob);
          if (converted && converted.size > 0 && converted !== blob) {
            payload = converted;
            finalExt = 'jpg';
          }
        } catch {
          /* 转码失败就用原图 */
        }
      }

      // 4. 原子写入（§9.10）：dir 已是完整相对路径，ensureDir 自己会逐级创建
      await ctx.fs.sink.ensureDir(dir as never);
      const name = await ctx.fs.sink.resolveName(dir as never, item.stem, finalExt);
      // 没有转码时把原始地址一并交给写入层：downloads 模式下只有它才能保住文件名
      const sourceUrl = payload === blob ? item.candidates[0] : undefined;
      const written = await ctx.fs.writeFile(
        dir as never,
        name,
        payload,
        ctx.signal,
        sourceUrl === undefined ? {} : { sourceUrl },
      );

      return {
        itemKey: item.itemKey,
        status: 'ok',
        bytes: written.size,
        path: [...dir, written.name].join('/'),
      } satisfies ItemResult;
    } catch (e) {
      // 逐项失败一定要留日志：引擎在 offscreen 里，console 不在任何 DevTools 里，
      // 不打日志就只能看到 UI 上一个「失败」，原因完全查不到。
      const err = EcError.from(e);
      // 日志的 data 会被诊断包骨架化，所以把原因直接拼进 msg 里，排查时才看得见
      ctx.log.warn(`下载失败 ${item.itemKey} [${err.code}] ${describeError(e)}`);
      return { itemKey: item.itemKey, status: 'failed', code: err.code };
    }
  },

  async finalize(p, results, ctx) {
    // 用任务开始时定位到的那个文件夹：清单必须和图片在同一个目录里（§9.11）
    const root = ctx.extra?.root ?? planOf(p).folder;
    const ok = results.filter((r) => r.status === 'ok' || r.status === 'skipped');

    // 1. .ecbox.json（增量下载依据，§9.11）
    try {
      const text = await ctx.fs.readText(root as never, MANIFEST_FILE);
      const existing = parseFolderManifest(text);
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

/**
 * engine 的私有 RPC（§8.6）。只有 history.get：读 .ecbox.json 算出「上次下载于…、还缺几个」。
 * 页面调 api.call('history.get') → bg 的 feature.call → 这里。
 */
export interface HistoryQuery {
  platform?: string;
  productId: string;
  itemKeys?: string[];
}

export async function historyGet(
  args: unknown,
  ctx: { gateway: FsGateway; log: Logger },
): Promise<{ lastAt: number; missing: string[]; total: number } | null> {
  const q = args as HistoryQuery | undefined;
  if (!q?.productId) return null;

  const expected = q.itemKeys ?? [];
  try {
    // 平台名用的是「平台的叫法」（目录名就是这么起的），不是平台 id
    const platformName = platformDisplayName(q.platform ?? 'pinduoduo');

    /**
     * 商品文件夹不能靠模板现算：模板里的 {title} 来自**当前快照**，而这里只有商品 ID。
     * 所以走 gateway 的「只查不建」定位（索引 → `_ID` 后缀扫描），和真正下载用同一套规则。
     * 旧实现的 history.get 根本没实现（bg 也从没注册 feature.call），面板上的
     * 「补全 N 个文件」「上次下载于…」永远不会出现。
     */
    const found = await ctx.gateway.findProductFolder({
      platform: platformName,
      productId: q.productId,
    });
    if (found === null) return null;

    const text = await ctx.gateway.readText(found.dir as never, MANIFEST_FILE);
    const parsed = parseFolderManifest(text);
    if (parsed.kind !== 'ok') return null;
    if (expected.length === 0) {
      return {
        lastAt: parsed.manifest.updatedAt,
        total: Object.keys(parsed.manifest.files).length,
        missing: [],
      };
    }
    const summary = summarizeHistory(
      parsed.manifest,
      new Map(expected.map((key) => [key, undefined])),
    );
    return summary === null
      ? null
      : { lastAt: summary.lastAt, missing: summary.missing, total: summary.total };
  } catch {
    return null;
  }
}

export default {
  jobTypes: [mediaDownloadJobType],
  methods: { 'history.get': historyGet },
};
