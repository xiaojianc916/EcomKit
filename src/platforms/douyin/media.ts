import type { Asset } from '../../kernel/model/asset';
import { assetKeyFromUrl } from '../shared/html-images';
import { normalizeUrl } from '../shared/url';
import { guessCodec, guessContainer, type VideoCandidate } from '../shared/video';
import type { DyRawVideo, DyRawVideoVariant } from './schema';

/**
 * 抖音的原图 / 视频规则（纯函数，§7.6）。
 *
 * 原图规则**不是**方案 §7.6.2 写的「去掉 ~ 及其后面的部分」——实测那样会返回 400
 * （docs/phase0/FINDINGS.md §1.5）：
 *
 *   …x~c5_720x720.webp?from=…      200   49740 字节  720×720        （页面原始，缩略图）
 *   …x~c5_2000x2000.webp           200   77022 字节  1093×1093      （后缀尺寸不生效）
 *   …x~tplv-obj:720:720.webp       200   74552 字节  1093×1093      （后缀尺寸不生效）
 *   …x~tplv-obj.image              200  680030 字节  1093×1093      （PNG 原图 ← 正确规则）
 *   …x                             400   46 字节     —              （不可行）
 *
 * 所以：候选① = 把 `~` 之后的全部替换成 `~tplv-obj.image`；候选② = 页面原始 URL。
 * 另：`~tplv-…` 后缀里的尺寸参数不生效，服务端始终返回源图尺寸，
 * **缩略图必须直接用页面原始 URL**，不能靠改后缀生成小图。
 */

/** 抖音 CDN 原图后缀（实测可用） */
export const ORIGINAL_SUFFIX = '~tplv-obj.image';

/**
 * 把地址里的处理后缀换成原图后缀。
 * 没有 `~` 后缀时返回 undefined：实测这类地址已经不带处理参数，改不出来更大的图。
 */
export function toOriginalImageUrl(raw: string, base?: string): string | undefined {
  const norm = normalizeUrl(raw, base === undefined ? {} : { base });
  if (!norm) return undefined;

  let url: URL;
  try {
    url = new URL(norm);
  } catch {
    return undefined;
  }
  const tilde = url.pathname.indexOf('~');
  if (tilde < 0) return undefined;

  url.pathname = `${url.pathname.slice(0, tilde)}${ORIGINAL_SUFFIX}`;
  return url.toString();
}

/**
 * 图片素材的候选地址：`[原图(~tplv-obj.image), 页面原始 URL]`。
 * 没有 `~` 后缀时只有一个候选（页面原始 URL），不做无意义的改写。
 */
export function originalImageCandidates(raw: string, base?: string): string[] {
  const plain = normalizeUrl(raw, base === undefined ? {} : { base });
  const original = toOriginalImageUrl(raw, base);
  const out: string[] = [];
  for (const url of [original, plain]) {
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * 面板缩略图：**直接用页面原始 URL**。
 * 实测 `~tplv-obj:200:200.webp` 的后缀尺寸参数不生效，服务端仍返回 1093×1093，
 * 所以拼小图后缀没有任何收益，还会多一次 CDN 改写风险。
 */
export function thumbnailUrl(raw: string, base?: string): string | undefined {
  return normalizeUrl(raw, base === undefined ? {} : { base });
}

export interface DyImageAssetOptions {
  kind: Extract<Asset['kind'], 'main' | 'detail' | 'sku'>;
  index: number;
  label?: string;
  width?: number;
  height?: number;
  base?: string;
}

/** 一张图片 → 素材；地址不可用时返回 null */
export function toDyImageAsset(
  raw: { url: string; width?: number; height?: number },
  opts: DyImageAssetOptions,
): Asset | null {
  const candidates = originalImageCandidates(raw.url, opts.base);
  const first = candidates[0];
  if (first === undefined) return null;

  const preview = thumbnailUrl(raw.url, opts.base);
  const asset: Asset = {
    key: assetKeyFromUrl(first),
    kind: opts.kind,
    index: opts.index,
    candidates,
    ...(preview !== undefined ? { preview } : {}),
    ...(opts.label !== undefined && opts.label !== '' ? { label: opts.label } : {}),
  };
  const width = raw.width ?? opts.width;
  const height = raw.height ?? opts.height;
  if (width !== undefined) asset.width = width;
  if (height !== undefined) asset.height = height;
  return asset;
}

/* ------------------------------------------------------------------ *
 * 视频
 * ------------------------------------------------------------------ */

/**
 * 抖音的 bit_rate[] 每一项是一种编码 / 档位：
 * `{ gear_name, bit_rate, is_h265, play_addr: { url_list, width, height } }`。
 * 这里把它摊平成候选列表，再交给 shared/video.ts 的 selectVideo() 选。
 */
export function toVideoCandidates(raw: DyRawVideo, base?: string): VideoCandidate[] {
  const out: VideoCandidate[] = [];
  const cover = pickFirstUrl(raw.cover?.url_list, base);
  const duration = raw.duration ?? raw.video_length;

  for (const variant of raw.bit_rate ?? []) {
    const candidate = fromVariant(raw, variant, base);
    if (candidate) out.push(candidate);
  }

  // bit_rate 为空时退回顶层 play_addr
  if (out.length === 0) {
    const fallback = fromPlayAddr(raw, raw.play_addr, base);
    if (fallback) out.push(fallback);
  }

  return out.map((c) => {
    const withCover = { ...c };
    if (cover !== undefined) withCover.cover = cover;
    if (duration !== undefined && c.duration === undefined) withCover.duration = duration;
    if (raw.label !== undefined) withCover.label = raw.label;
    return withCover;
  });
}

function fromVariant(
  raw: DyRawVideo,
  variant: DyRawVideoVariant,
  base?: string,
): VideoCandidate | null {
  const url = pickFirstUrl(variant.play_addr?.url_list, base, variant.play_addr?.url_list?.[0]);
  if (url === undefined) return null;

  // is_h265 是抖音最可靠的编码标记；缺失时按编码名 / 地址猜
  const codec =
    variant.is_h265 === 1
      ? 'h265'
      : variant.is_h265 === 0
        ? 'h264'
        : guessCodec(variant.gear_name, url);
  const container = guessContainer(url);
  const candidate: VideoCandidate = {
    url,
    codec,
    // 待验证：抖音给的都是 mp4 直链，地址上通常不带 .mp4 后缀
    container: container === 'unknown' ? 'mp4' : container,
  };
  const width = variant.play_addr?.width ?? raw.width;
  const height = variant.play_addr?.height ?? raw.height;
  if (width !== undefined) candidate.width = width;
  if (height !== undefined) candidate.height = height;
  if (variant.bit_rate !== undefined) candidate.bitrate = variant.bit_rate;
  if (raw.duration !== undefined) candidate.duration = raw.duration;
  return candidate;
}

function fromPlayAddr(
  raw: DyRawVideo,
  playAddr: DyRawVideo['play_addr'],
  base?: string,
): VideoCandidate | null {
  const url = pickFirstUrl(playAddr?.url_list, base);
  if (url === undefined) return null;
  const container = guessContainer(url);
  const candidate: VideoCandidate = {
    url,
    codec: guessCodec(raw.codec_type, url),
    container: container === 'unknown' ? 'mp4' : container,
  };
  const width = playAddr?.width ?? raw.width;
  const height = playAddr?.height ?? raw.height;
  if (width !== undefined) candidate.width = width;
  if (height !== undefined) candidate.height = height;
  if (raw.duration !== undefined) candidate.duration = raw.duration;
  return candidate;
}

function pickFirstUrl(
  list: readonly string[] | undefined,
  base?: string,
  fallback?: string,
): string | undefined {
  for (const raw of list ?? []) {
    const url = normalizeUrl(raw, base === undefined ? {} : { base });
    if (url) return url;
  }
  if (fallback === undefined) return undefined;
  return normalizeUrl(fallback, base === undefined ? {} : { base });
}
