/**
 * media-download 的 engine（方案 §8.6、§9.6）：注册 `media-download` 任务类型。
 *
 * 跑在 **Offscreen**（ADR-1）：只有这里能拿目录句柄写文件、能转码、不受 SW 30 秒回收影响。
 *
 * 两段式：plan 算要写什么（纯函数）→ run 逐个下载写入。
 * **不写任何侧录文件**（旧实现会写 `.ecbox.json` 和 `商品信息.txt`）：
 * 商家要的是能直接上传的素材目录，多一个文件就多一次手工删除。
 * 增量下载因此改为「同名文件已在盘上就跳过」，判断依据是真实文件，不依赖我们自己的记录。
 *
 * 载荷定义在 ./payload.ts，和页面共用同一份 Zod schema —— 页面少传字段会当场报错，
 * 不会变成「点了没反应」。
 */
import type { z } from 'zod';
import { EcError } from '../../kernel/errors/ec-error';
import type { FsGateway } from '../../kernel/fs/types';
import type { ItemResult, JobTypeDef, WorkItem } from '../../kernel/jobs/types';
import { createLogger } from '../../kernel/log/logger';
import { isConvertibleMime } from '../../kernel/media/convert';
import { readHead, SNIFF_BYTES, sniff } from '../../kernel/net/sniff';
import {
  type MediaDownloadPayload,
  MediaDownloadPayloadSchema,
  planOf,
  platformDisplayName,
} from './payload';

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

/** engine 的 extra：整个任务共享的只读上下文（计划根目录） */
export interface MediaDownloadExtra {
  payload: MediaDownloadPayload;
  /** 商品文件夹的相对路径 */
  root: string[];
}

/** extra() 里没有 logger 参数，定位失败时用它兜底记录 */
const fallbackLog = createLogger('media-download');

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
  // 而且「同名文件已存在就跳过」会把这条路径记成已完成，下次也不会重下。
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
    // 模板里最后一段就是商品文件夹名
    const preferredName = templateFolder[templateFolder.length - 1] ?? p.snapshot.productId;
    const resolved = await ctx.fs.resolveProductFolder({
      platform: platformName,
      productId: p.snapshot.productId,
      preferredName,
    });
    return [...resolved.dir];
  } catch (e) {
    ctx.log.warn('商品文件夹定位失败，退回模板路径', e);
    return null;
  }
}

/**
 * 这个文件是不是已经在盘上了（增量下载的唯一依据）。
 *
 * 只比名字、不比大小：大小要靠另外一次网络请求才知道，而这里的目标是
 * 「第二次点下载不重下一遍」。真被用户改坏了，删掉再下即可。
 */
async function alreadyThere(fs: FsGateway, dir: string[], item: WorkItem): Promise<string | null> {
  // 扩展名由内容决定，只能把可能的类型逐个试一遍；
  // 图片按「转成 JPG」的默认结果先找 .jpg，找得到就不必再发请求
  const exts =
    item.expect === 'video' ? ['mp4', 'ts'] : ['jpg', 'webp', 'png', 'gif', 'avif', 'heic'];
  for (const ext of exts) {
    const name = `${item.stem}.${ext}`;
    try {
      const size = await fs.exists(dir as never, name);
      if (size !== null) return [...dir, name].join('/');
    } catch {
      // 判断不了存在性就老实重下
    }
  }
  return null;
}

export const mediaDownloadJobType: JobTypeDef<MediaDownloadPayload, MediaDownloadExtra> = {
  type: 'media-download',
  payload: MediaDownloadPayloadSchema as unknown as z.ZodType<MediaDownloadPayload>,

  /** 同一商品同一时间只允许一个任务（§6.4） */
  dedupeKey: (p) => `${p.snapshot.platform}:${p.snapshot.productId}`,

  requiresDir: true,

  /** 商品文件夹必须和 plan 用**同一套定位**，否则图片会被写进两个文件夹 */
  async extra(p, { fs }): Promise<MediaDownloadExtra> {
    const template = planOf(p).folder;
    const root = (await resolveFolder(p, template, { fs, log: fallbackLog })) ?? template;
    return { payload: p, root: [...root] };
  },

  async plan(p, ctx) {
    const plan = planOf(p);
    /**
     * 商品文件夹必须走 gateway 的定位（ADR-6）：
     * 索引 → 同根目录下扫 `_商品ID` 后缀 → 都没有才按模板新建。
     *
     * 旧实现直接用模板拼出来的 plan.folder 建目录，于是**商家一改标题就会多出一个文件夹**。
     */
    const folder = (await resolveFolder(p, plan.folder, ctx)) ?? plan.folder;
    return plan.items.map((item) => ({ ...item, dir: [...folder, ...item.dir] }));
  },

  async run(item, ctx) {
    const dir = itemTargetDir(item);
    try {
      // 0. 增量跳过：同名文件已经在盘上就跳过（不写任何侧录文件，见文件头注释）
      const existing = await alreadyThere(ctx.fs, dir, item);
      if (existing !== null) {
        return { itemKey: item.itemKey, status: 'skipped', bytes: 0, path: existing };
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
        return await streamVideo(item, res, dir, ctx);
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
      const wantsJpeg =
        (ctx.extra as MediaDownloadExtra | undefined)?.payload.settings.toJpeg !== false;
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
};

export default {
  jobTypes: [mediaDownloadJobType],
};
