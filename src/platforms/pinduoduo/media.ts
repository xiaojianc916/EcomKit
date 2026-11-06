import type { Asset } from '../../kernel/model/asset';
import { assetKeyFromUrl } from '../shared/html-images';
import { normalizeUrl } from '../shared/url';
import { guessContainer, type VideoCandidate } from '../shared/video';
import type { PddRawImage, PddRawVideo } from './schema';

/**
 * 拼多多的原图 / 缩略图 / 视频规则（纯函数，§7.5）。
 *
 * 原图规则实测（docs/phase0/FINDINGS.md §1.5）：
 *   …/logo.jpg                  → 20202 字节（原图）
 *   …/logo.jpg?imageView2/2/w/200/q/80 → 8945 字节（缩略图）
 * → 去掉 ?imageMogr2/… ?imageView2/… 这类 CDN 处理参数，得到的就是原图。
 */

/** CDN 处理参数的参数名前缀（大小写不敏感）：imagemogr2/thumbnail/400x400 这种没有 '=' 形式 */
const PROCESSING_PREFIXES = ['imagemogr2', 'imagemogr1', 'imagemogr', 'imageview2', 'imageview'];

/** 去掉 CDN 处理参数，保留其他参数（例如签名、追踪） */
export function stripProcessingParams(url: URL): URL {
  const raw = url.search.replace(/^\?/, '');
  const keep = raw.split('&').filter((seg) => {
    if (seg === '') return false;
    const name = decodeURIComponent(seg.split('=')[0] ?? '').toLowerCase();
    return !PROCESSING_PREFIXES.some((p) => name.startsWith(p));
  });
  const out = new URL(url.toString());
  out.search = keep.length > 0 ? `?${keep.join('&')}` : '';
  return out;
}

function normalizeOpts(base?: string): { base?: string } {
  return base === undefined ? {} : { base };
}

/** 已规范化的地址 → 去掉 CDN 处理参数后的原图地址 */
function originalOfNormalized(norm: string): string | undefined {
  try {
    return stripProcessingParams(new URL(norm)).toString();
  } catch {
    return undefined;
  }
}

/**
 * 一张图要同时算出「原图 / 候选列表 / 缩略图」三样。
 *
 * 原来这三个入口各自把同一个地址完整解析一遍（normalizeUrl + new URL + stripProcessingParams），
 * 一张详情图就是 3 次多余的 URL 解析；200 张详情图各带 2 个候选时是上千次。
 * 这里一次解析、三样都从它派生。
 */
interface ResolvedImage {
  /** [原图, 页面原始 URL]，相同则只留一个 */
  candidates: string[];
  /** 原图地址（没有处理参数时等于原始地址） */
  original: string;
}

function resolveImage(raw: string, base?: string): ResolvedImage | null {
  const norm = normalizeUrl(raw, normalizeOpts(base));
  if (!norm) return null;
  const original = originalOfNormalized(norm) ?? norm;
  return {
    candidates: original === norm ? [norm] : [original, norm],
    original,
  };
}

/** 原图地址：规范化（https、去转义斜杠）后去掉处理参数 */
export function originalImageUrl(raw: string, base?: string): string | undefined {
  return resolveImage(raw, base)?.original;
}

/**
 * 图片素材的候选地址（§7.5）：[原图, 页面原始 URL]。
 * 原图和原始 URL 相同时只留一个（ProductSnapshot 要求 candidates 非空即可，不要求多个）。
 */
export function originalImageCandidates(raw: string, base?: string): string[] {
  return resolveImage(raw, base)?.candidates ?? [];
}

function thumbnailFromOriginal(original: string, width: number): string | undefined {
  try {
    const url = new URL(original);
    url.search = `?imageView2/2/w/${width}/q/80`;
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * 面板缩略图：原图地址加 `?imageView2/2/w/<width>/q/80`（实测能显著减小体积）。
 * 只用于面板缩略图条，下载永远走 candidates（原图优先）。
 */
export function thumbnailUrl(raw: string, width = 200, base?: string): string | undefined {
  const original = originalImageUrl(raw, base);
  if (!original) return undefined;
  return thumbnailFromOriginal(original, width);
}

export interface PddImageAssetOptions {
  kind: Extract<Asset['kind'], 'main' | 'detail' | 'sku'>;
  index: number;
  label?: string;
  width?: number;
  height?: number;
  base?: string;
}

/** 一张图片 → 素材；地址不可用时返回 null（调用方过滤掉） */
export function toPddImageAsset(raw: PddRawImage, options: PddImageAssetOptions): Asset | null {
  // 同一个地址只解析一次：候选地址、key、缩略图都从它派生
  const resolved = resolveImage(raw.url, options.base);
  const first = resolved?.candidates[0];
  if (!resolved || first === undefined) return null;

  const asset: Asset = {
    key: assetKeyFromUrl(first),
    kind: options.kind,
    index: options.index,
    candidates: resolved.candidates,
  };
  const preview = thumbnailFromOriginal(resolved.original, 200);
  if (preview !== undefined) asset.preview = preview;
  if (options.label !== undefined && options.label !== '') asset.label = options.label;
  const width = raw.width ?? options.width;
  const height = raw.height ?? options.height;
  if (width !== undefined) asset.width = width;
  if (height !== undefined) asset.height = height;
  return asset;
}

/** 拼多多的主图视频都是 mp4 直链（待验证：暂未见到 m3u8 / DASH） */
export function toPddVideoCandidate(raw: PddRawVideo, base?: string): VideoCandidate | undefined {
  const url = normalizeUrl(raw.url, normalizeOpts(base));
  if (!url) return undefined;

  const guessed = guessContainer(url);
  const candidate: VideoCandidate = {
    url,
    codec: raw.codec,
    // 待验证：拼多多 videoGallery 里给的是 mp4 直链，地址上不一定带 .mp4 后缀
    container: guessed === 'unknown' ? 'mp4' : guessed,
  };
  if (raw.width !== undefined) candidate.width = raw.width;
  if (raw.height !== undefined) candidate.height = raw.height;
  if (raw.duration !== undefined) candidate.duration = raw.duration;
  if (raw.cover !== undefined) candidate.cover = raw.cover;
  if (raw.label !== undefined) candidate.label = raw.label;
  return candidate;
}
