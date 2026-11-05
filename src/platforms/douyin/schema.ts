import { z } from 'zod';
import { firstNonEmpty, readString } from '../shared/read-path';
import type { VideoCodec } from '../shared/video';

/**
 * 抖音商品数据结构（宽松 Zod + 多候选路径）。
 *
 * 主数据源是**抓包**：页面带签名，只能旁听页面自己的请求（ADR-7）。
 * Phase 0 实测（docs/phase0/FINDINGS.md §1）：无人值守环境下永远只拿到扫码页，
 * 既没有 SSR 全局变量，也拿不到 /aweme/v2/shop/promotion/pack/h5/ 的成功响应。
 * 所以下面的字段路径是**结构等价推测**，全部标了「待验证」，并按方案 §7.6 写成多候选。
 */

/** 商品容器候选路径（抓包响应有几种常见信封） */
export const DY_ROOT_PATHS = [
  'data',
  'data.pack',
  'data.product',
  'data.promotion',
  'data.product_info',
  'pack',
  'product',
  'promotion',
] as const;

export const DY_TITLE_PATHS = [
  'title',
  'product_name',
  'productName',
  'name',
  'goods_title',
] as const;
export const DY_SHOP_PATHS = [
  'shop.name',
  'shop.shop_name',
  'shop_name',
  'shopName',
  'author.nickname',
  'seller.name',
] as const;
export const DY_ID_PATHS = ['product_id', 'productId', 'id', 'promotion_id', 'goods_id'] as const;
export const DY_PRICE_PATHS = [
  'price',
  'min_price',
  'minPrice',
  'price_info.min_price',
  'price_info.price',
  'promotion_price',
] as const;

/** 主图（轮播）：图片项通常是 { url_list: [...] } */
export const DY_MAIN_IMAGE_PATHS = [
  'images',
  'image_list',
  'img_list',
  'main_images',
  'product_images',
  'detail.top_images',
] as const;

/** 详情富文本 HTML（§7.6.1） */
export const DY_DETAIL_HTML_PATHS = [
  'detail_html',
  'detailHtml',
  'description_html',
  'desc_html',
  'detail.detail_html',
  'detail.description',
  'description',
  'detail',
] as const;

/** 结构化详情图（有的接口直接给数组，不给富文本） */
export const DY_DETAIL_IMAGE_PATHS = [
  'detail_images',
  'detailImages',
  'desc_images',
  'detail.images',
  'detail.image_list',
] as const;

/** SKU */
export const DY_SKU_PATHS = ['skus', 'sku_list', 'skuList', 'sku_infos', 'specs'] as const;

/** 视频 */
export const DY_VIDEO_PATHS = [
  'video',
  'videos',
  'video_list',
  'main_video',
  'detail.video',
  'media.video',
] as const;

/** 阻断 / 异常标记（待验证） */
export const DY_GONE_PATHS = ['status', 'product_status', 'status_code', 'code'] as const;

export const DyUrlListSchema = z.object({ url_list: z.array(z.string()).optional() }).passthrough();

export type DyUrlList = z.infer<typeof DyUrlListSchema>;

/** 图片载体：{ url_list: [...] } 或 { url } 或纯字符串 */
export const DyImageSchema = z
  .object({
    url_list: z.array(z.string()).optional(),
    url: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  })
  .passthrough();

export type DyRawImage = { url: string; width?: number; height?: number };

/** 取第一个可用地址：url_list[0] 优先，其次 url */
export function pickImageUrl(value: unknown): DyRawImage | null {
  if (typeof value === 'string') {
    const url = value.trim();
    return url === '' ? null : { url };
  }
  if (value === null || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;

  const url = firstNonEmpty(rec, ['url_list[0]', 'url', 'image_url', 'uri']);
  if (typeof url !== 'string' || url.trim() === '') return null;

  const out: DyRawImage = { url: url.trim() };
  const w = rec.width;
  const h = rec.height;
  if (typeof w === 'number' && Number.isFinite(w) && w > 0) out.width = w;
  if (typeof h === 'number' && Number.isFinite(h) && h > 0) out.height = h;
  return out;
}

export function pickImageList(values: readonly unknown[]): DyRawImage[] {
  const out: DyRawImage[] = [];
  for (const value of values) {
    const img = pickImageUrl(value);
    if (img) out.push(img);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 视频
 * ------------------------------------------------------------------ */

export interface DyRawVideoVariant {
  gear_name?: string;
  bit_rate?: number;
  /** 1 = H.265（bytevc1），0 = H.264 */
  is_h265?: number;
  play_addr?: { url_list?: string[]; width?: number; height?: number };
}

export interface DyRawVideo {
  play_addr?: { url_list?: string[]; width?: number; height?: number };
  bit_rate?: DyRawVideoVariant[];
  cover?: { url_list?: string[] };
  duration?: number;
  /** 有的接口用毫秒 */
  video_length?: number;
  width?: number;
  height?: number;
  /** 'h264' | 'h265' | 'bytevc1' … */
  codec_type?: string;
  label?: string;
}

function pickStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

function pickVariant(value: unknown): DyRawVideoVariant {
  const rec = (value ?? {}) as Record<string, unknown>;
  const playAddrRaw = rec.play_addr ?? rec.playAddr;
  const playRec = (playAddrRaw ?? {}) as Record<string, unknown>;
  const variant: DyRawVideoVariant = {};
  if (typeof rec.gear_name === 'string') variant.gear_name = rec.gear_name;
  if (typeof rec.bit_rate === 'number') variant.bit_rate = rec.bit_rate;
  if (typeof rec.is_h265 === 'number') variant.is_h265 = rec.is_h265;
  const urls = pickStrings(playRec.url_list ?? playRec.urlList);
  const w = playRec.width;
  const h = playRec.height;
  const play_addr: NonNullable<DyRawVideoVariant['play_addr']> = {};
  if (urls.length > 0) play_addr.url_list = urls;
  if (typeof w === 'number') play_addr.width = w;
  if (typeof h === 'number') play_addr.height = h;
  if (Object.keys(play_addr).length > 0) variant.play_addr = play_addr;
  return variant;
}

/**
 * 视频载体规范化。抖音可能给：
 * - 单个视频对象 `{ play_addr, bit_rate[], cover, duration }`；
 * - 视频数组；
 * - 纯地址字符串。
 * 统一成 DyRawVideo，再由 media.toVideoCandidates() 摊平成候选。
 */
export function normalizeVideoLike(value: unknown, label?: string): DyRawVideo | null {
  if (typeof value === 'string') {
    const url = value.trim();
    if (url === '') return null;
    const video: DyRawVideo = { play_addr: { url_list: [url] } };
    if (label !== undefined) video.label = label;
    return video;
  }
  if (value === null || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;

  const video: DyRawVideo = {};

  const playRaw = rec.play_addr ?? rec.playAddr;
  if (playRaw !== null && typeof playRaw === 'object') {
    const playRec = playRaw as Record<string, unknown>;
    const urls = pickStrings(playRec.url_list ?? playRec.urlList);
    if (urls.length > 0) {
      const play_addr: NonNullable<DyRawVideo['play_addr']> = { url_list: urls };
      if (typeof playRec.width === 'number') play_addr.width = playRec.width;
      if (typeof playRec.height === 'number') play_addr.height = playRec.height;
      video.play_addr = play_addr;
    }
  }

  const bitRates = rec.bit_rate ?? rec.bitRate;
  if (Array.isArray(bitRates) && bitRates.length > 0) {
    video.bit_rate = bitRates.map(pickVariant);
  }

  const coverRaw = rec.cover ?? rec.origin_cover ?? rec.originCover;
  if (coverRaw !== null && typeof coverRaw === 'object') {
    const urls = pickStrings((coverRaw as Record<string, unknown>).url_list);
    if (urls.length > 0) video.cover = { url_list: urls };
  }

  if (typeof rec.duration === 'number') video.duration = rec.duration;
  if (typeof rec.video_length === 'number') video.video_length = rec.video_length;
  if (typeof rec.width === 'number') video.width = rec.width;
  if (typeof rec.height === 'number') video.height = rec.height;
  const codecType = readString(rec, ['codec_type', 'codecType', 'format']);
  if (codecType !== undefined) video.codec_type = codecType;
  if (label !== undefined) video.label = label;

  if (video.play_addr === undefined && video.bit_rate === undefined) return null;
  return video;
}

export function normalizeVideoList(values: readonly unknown[], label?: string): DyRawVideo[] {
  const out: DyRawVideo[] = [];
  for (const value of values) {
    const video = normalizeVideoLike(value, label);
    if (video) out.push(video);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * SKU
 * ------------------------------------------------------------------ */

export interface DyRawSku {
  id: string;
  specs: { name: string; value: string }[];
  imageUrl?: string;
  price?: string;
  stock?: number;
}

export function normalizeSkuLike(value: unknown, index: number): DyRawSku | null {
  if (value === null || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;

  const id = readString(rec, ['sku_id', 'skuId', 'id', 'spec_id']) ?? `sku-${index}`;

  const specs: { name: string; value: string }[] = [];
  const specsRaw = firstNonEmpty(rec, [
    'specs',
    'spec_list',
    'specList',
    'sku_specs',
    'spec_detail',
  ]);
  if (Array.isArray(specsRaw)) {
    for (const spec of specsRaw) {
      if (spec === null || typeof spec !== 'object') continue;
      const s = spec as Record<string, unknown>;
      // 待验证：抖音的规格字段名（name/value、spec_name/spec_value、key/value）
      const name = readString(s, ['name', 'spec_name', 'specName', 'key']);
      const val = readString(s, ['value', 'spec_value', 'specValue', 'v']);
      if (name !== undefined && val !== undefined) specs.push({ name, value: val });
    }
  }
  // 另一种形状：{ spec_detail: { 颜色: '红' } }
  if (specs.length === 0 && specsRaw !== null && typeof specsRaw === 'object') {
    for (const [name, v] of Object.entries(specsRaw as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim() !== '') specs.push({ name, value: v.trim() });
    }
  }

  const imageRaw = firstNonEmpty(rec, ['image', 'img', 'image_url', 'thumb_url', 'cover']);
  const sku: DyRawSku = { id, specs };
  const img = pickImageUrl(imageRaw);
  if (img) sku.imageUrl = img.url;

  const priceRaw = firstNonEmpty(rec, ['price', 'sale_price', 'sku_price']);
  const price = formatDyPrice(priceRaw);
  if (price !== undefined) sku.price = price;

  const stock = firstNonEmpty(rec, ['stock', 'stock_num', 'quantity']);
  if (typeof stock === 'number' && Number.isFinite(stock)) sku.stock = stock;
  else if (typeof stock === 'string' && Number.isFinite(Number(stock))) sku.stock = Number(stock);

  return sku;
}

/**
 * 抖音价格有两种表示（待验证）：
 * - 整数「分」：直接除以 100；
 * - 字符串「12.90」或「¥12.90」：原样保留。
 */
export function formatDyPrice(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return `¥${(value / 100).toFixed(2)}`;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return undefined;
    if (/^\d+$/.test(s)) return `¥${(Number(s) / 100).toFixed(2)}`;
    return s.startsWith('¥') ? s : `¥${s}`;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 信封
 * ------------------------------------------------------------------ */

export const DyPayloadSchema = z
  .object({
    data: z.unknown().optional(),
    status_code: z.unknown().optional(),
    code: z.unknown().optional(),
    msg: z.unknown().optional(),
    promotion: z.unknown().optional(),
    product: z.unknown().optional(),
  })
  .passthrough();

/** 在抓包响应里找商品容器；找不到返回 null */
export function findDyRoot(payload: unknown): unknown | null {
  if (payload === null || typeof payload !== 'object') return null;
  for (const path of DY_ROOT_PATHS) {
    const node = firstNonEmpty(payload, [path]);
    if (node === undefined || node === null || typeof node !== 'object') continue;
    // 容器里至少要有标题或图片，才算找到商品
    if (firstNonEmpty(node, DY_TITLE_PATHS) !== undefined) return node;
    if (firstNonEmpty(node, DY_MAIN_IMAGE_PATHS) !== undefined) return node;
  }
  if (firstNonEmpty(payload, DY_TITLE_PATHS) !== undefined) return payload;
  return null;
}

export function pickProductId(root: unknown): string | undefined {
  return readString(root, DY_ID_PATHS);
}

/** 抓包响应是不是失败 / 已下架（待验证：真实的状态码语义） */
export function isDyErrorPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  const rec = payload as Record<string, unknown>;
  const code = firstNonEmpty(rec, ['status_code', 'statusCode', 'code']);
  if (code === 0 || code === 200 || code === undefined) return false;
  return typeof code === 'number';
}

export type { VideoCodec };
