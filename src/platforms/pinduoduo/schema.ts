import { z } from 'zod';
import { firstNonEmpty, readPath, readString } from '../shared/read-path';
import { guessCodec, type VideoCodec } from '../shared/video';

/**
 * 拼多多原始数据结构（宽松 Zod + 多候选路径）。
 *
 * 数据来源有两条：
 * 1. SSR：`window.rawData`，实测未登录时只有 `{ store: { initDataObj: { needLogin: true } } }`
 *    （docs/phase0/FINDINGS.md §1），登录后 `initDataObj` 里才带 goods / mall；
 * 2. 抓包：`/proxy/api/…` 下的商品详情接口（路径待验证，见 manifest.capture）。
 *
 * 所有字段都写成候选路径数组：平台改版时最常见的改动就是驼峰/下划线互换、
 * 字段换一层，多候选能在不发版的前提下多撑一段时间。
 * // 待验证：登录态下的真实字段路径（FINDINGS §3 待补）
 */

/**
 * 可能的 goods / mall 容器根路径，按可能性排序。
 * 空串表示「信封本身就是容器」，放在最后：抓包接口有的直接回 { goods: {...} }。
 */
export const PDD_ROOT_PATHS = [
  'store.initDataObj',
  'initDataObj',
  'data.store.initDataObj',
  'data',
  'result',
  'result.data',
  '',
] as const;

export const PDD_GOODS_PATHS = [
  'goods',
  'goodsDetail',
  'goods_detail',
  'detail',
  'data.goods',
] as const;
export const PDD_MALL_PATHS = ['mall', 'mallInfo', 'mall_info', 'shop', 'data.mall'] as const;

/** 标题 */
export const PDD_TITLE_PATHS = ['goodsName', 'goods_name', 'goods.name', 'name', 'title'] as const;

/** 店铺名 */
export const PDD_SHOP_PATHS = [
  'mallName',
  'mall_name',
  'mall.mallName',
  'mall.mall_name',
  'name',
] as const;

/** 商品 ID（用于核对抓包数据是不是当前商品） */
export const PDD_GOODS_ID_PATHS = [
  'goodsId',
  'goods_id',
  'goods.goodsId',
  'goods.goods_id',
  'id',
] as const;

/** 主图：可能是字符串，也可能是 { url } / { thumbUrl } */
export const PDD_MAIN_IMAGE_PATHS = [
  'topGallery',
  'top_gallery',
  'detailGallery',
  'gallery',
  'images',
  'goods.topGallery',
  'goods.top_gallery',
] as const;

/** 详情图（带 width / height） */
export const PDD_DETAIL_IMAGE_PATHS = [
  'detailGallery',
  'detail_gallery',
  'detailImages',
  'descImages',
  'goods.detailGallery',
  'goods.detail_gallery',
] as const;

/** SKU 列表 */
export const PDD_SKU_PATHS = ['skus', 'skuList', 'sku_list', 'specs', 'goods.skus'] as const;

/** 视频 */
export const PDD_VIDEO_PATHS = [
  'videoGallery',
  'video_gallery',
  'videos',
  'video',
  'goods.videoGallery',
  'goods.video_gallery',
] as const;

/** 价格（分） */
export const PDD_PRICE_PATHS = [
  'minGroupPrice',
  'min_group_price',
  'groupPrice',
  'group_price',
  'price',
  'minOnSaleGroupPrice',
  'goods.min_group_price',
] as const;

/** 登录墙标记（Phase 0 实测的唯一必现信号） */
export const PDD_NEED_LOGIN_PATHS = [
  'needLogin',
  'need_login',
  'store.initDataObj.needLogin',
] as const;

/** 下架标记（待验证：文案 / 错误码） */
export const PDD_GONE_PATHS = [
  'goods.goodsStatus',
  'goodsStatus',
  'goods_status',
  'errorCode',
  'error_code',
] as const;

/**
 * 宽松的图片对象：真实数据里图片既可能是字符串，也可能是对象。
 * passthrough 保证多出来的字段（例如 watermark、quality）不会让整条数据校验失败。
 */
export const PddImageSchema = z
  .object({
    url: z.string().optional(),
    thumbUrl: z.string().optional(),
    thumb_url: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  })
  .passthrough();

export type PddRawImage = {
  url: string;
  width?: number;
  height?: number;
};

/** 把任意的「图片载体」规范成 { url, width?, height? }；拿不到 URL 返回 null */
export function normalizeImageLike(value: unknown): PddRawImage | null {
  if (typeof value === 'string') {
    const url = value.trim();
    return url === '' ? null : { url };
  }
  if (value === null || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;

  // 多候选：不同接口分别用 url / thumbUrl / imgUrl / imageUrl
  const url = firstNonEmpty(rec, ['url', 'thumbUrl', 'thumb_url', 'imgUrl', 'img_url', 'imageUrl']);
  if (typeof url !== 'string' || url.trim() === '') return null;

  const out: PddRawImage = { url: url.trim() };
  const width = firstNumber(rec, ['width', 'w', 'imgWidth']);
  const height = firstNumber(rec, ['height', 'h', 'imgHeight']);
  if (width !== undefined) out.width = width;
  if (height !== undefined) out.height = height;
  return out;
}

function firstNumber(rec: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

/** 批量规范化图片数组；单个坏元素直接跳过，不影响其他图片 */
export function normalizeImageList(values: readonly unknown[]): PddRawImage[] {
  const out: PddRawImage[] = [];
  for (const value of values) {
    const img = normalizeImageLike(value);
    if (img) out.push(img);
  }
  return out;
}

export type PddRawVideo = {
  url: string;
  cover?: string;
  width?: number;
  height?: number;
  duration?: number;
  codec: VideoCodec;
  label?: string;
};

/**
 * 视频载体规范化。拼多多的视频字段在不同接口里有三种写法：
 * `"https://…mp4"`、`{ videoUrl }`、`{ mainUrl, coverUrl }`。
 */
export function normalizeVideoLike(value: unknown): PddRawVideo | null {
  if (typeof value === 'string') {
    const url = value.trim();
    return url === '' ? null : { url, codec: guessCodec(url) };
  }
  if (value === null || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;

  const url = firstNonEmpty(rec, [
    'url',
    'videoUrl',
    'video_url',
    'mainUrl',
    'main_url',
    'playUrl',
    'play_url',
  ]);
  if (typeof url !== 'string' || url.trim() === '') return null;

  const coverRaw = firstNonEmpty(rec, ['cover', 'coverUrl', 'cover_url', 'poster', 'thumbUrl']);
  const codecHint = firstNonEmpty(rec, ['codec', 'videoCodec', 'codecType', 'format']);

  const video: PddRawVideo = {
    url: url.trim(),
    codec: guessCodec(typeof codecHint === 'string' ? codecHint : undefined, url.trim()),
  };
  if (typeof coverRaw === 'string' && coverRaw.trim() !== '') video.cover = coverRaw.trim();
  const width = firstNumber(rec, ['width', 'w']);
  const height = firstNumber(rec, ['height', 'h']);
  const duration = firstNumber(rec, ['duration', 'durationMs', 'videoDuration']);
  if (width !== undefined) video.width = width;
  if (height !== undefined) video.height = height;
  if (duration !== undefined) video.duration = duration;
  const label = readString(rec, ['label', 'title', 'videoType']);
  if (label !== undefined) video.label = label;
  return video;
}

export function normalizeVideoList(values: readonly unknown[]): PddRawVideo[] {
  const out: PddRawVideo[] = [];
  for (const value of values) {
    const video = normalizeVideoLike(value);
    if (video) out.push(video);
  }
  return out;
}

export type PddRawSku = {
  id: string;
  specs: { name: string; value: string }[];
  imageUrl?: string;
  price?: string;
  stock?: number;
};

/** SKU 规范化：规格字段有 spec_key/spec_value 和 specKey/specValue 两种写法 */
export function normalizeSkuLike(value: unknown, index: number): PddRawSku | null {
  if (value === null || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;

  const id = readString(rec, ['skuId', 'sku_id', 'id', 'specId']) ?? `sku-${index}`;
  const specsRaw = firstNonEmpty(rec, ['specs', 'specList', 'spec_list', 'specsList']);
  const specs: { name: string; value: string }[] = [];
  if (Array.isArray(specsRaw)) {
    for (const spec of specsRaw) {
      if (spec === null || typeof spec !== 'object') continue;
      const s = spec as Record<string, unknown>;
      const name = readString(s, ['spec_key', 'specKey', 'key', 'name']);
      const val = readString(s, ['spec_value', 'specValue', 'value', 'v']);
      if (name !== undefined && val !== undefined) specs.push({ name, value: val });
    }
  }

  const imageRaw = firstNonEmpty(rec, ['thumbUrl', 'thumb_url', 'imageUrl', 'image_url', 'img']);
  const sku: PddRawSku = { id, specs };
  if (typeof imageRaw === 'string' && imageRaw.trim() !== '') sku.imageUrl = imageRaw.trim();
  else {
    const img = normalizeImageLike(imageRaw);
    if (img) sku.imageUrl = img.url;
  }

  const priceFen = firstNumber(rec, ['groupPrice', 'group_price', 'price', 'skuPrice']);
  if (priceFen !== undefined) sku.price = fenToYuan(priceFen);
  const stock = firstNumber(rec, ['quantity', 'stock', 'skuQuantity']);
  if (stock !== undefined) sku.stock = stock;
  return sku;
}

/** 拼多多的价格字段单位是「分」，快照里统一用「¥12.90」这种字符串 */
export function fenToYuan(fen: number): string {
  if (!Number.isFinite(fen)) return '';
  return `¥${(fen / 100).toFixed(2)}`;
}

/** 抓包数据的外部信封：只要能找到 goods 容器就算有效，其余字段 passthrough */
export const PddPayloadSchema = z
  .object({
    store: z.unknown().optional(),
    goods: z.unknown().optional(),
    mall: z.unknown().optional(),
    data: z.unknown().optional(),
    result: z.unknown().optional(),
    error_code: z.unknown().optional(),
    success: z.unknown().optional(),
  })
  .passthrough();

export type PddPayload = z.infer<typeof PddPayloadSchema>;

export interface PddRoots {
  goods: unknown;
  mall: unknown;
}

/**
 * 在任意信封里找 goods / mall 容器。
 * 找不到 goods 时返回 mall 也保留（部分接口只回店铺信息）。
 */
export function findPddRoots(payload: unknown): PddRoots | null {
  if (payload === null || typeof payload !== 'object') return null;
  for (const rootPath of PDD_ROOT_PATHS) {
    const root = rootPath === '' ? payload : firstNonEmpty(payload, [rootPath]);
    if (root === undefined || root === null || typeof root !== 'object') continue;
    const goods = firstNonEmpty(root, PDD_GOODS_PATHS);
    const mall = firstNonEmpty(root, PDD_MALL_PATHS);
    if (goods !== undefined || mall !== undefined) {
      return { goods: goods ?? null, mall: mall ?? null };
    }
  }
  // 信封本身就是 goods：某些接口直接返回 { goodsName, topGallery… }
  if (firstNonEmpty(payload, PDD_TITLE_PATHS) !== undefined) {
    return { goods: payload, mall: firstNonEmpty(payload, PDD_MALL_PATHS) ?? null };
  }
  return null;
}

/**
 * SSR rawData 是否明确要求登录。
 * Phase 0 实测：未登录时 `rawData.store.initDataObj = { needLogin: true }`，
 * 所以标记可能在 payload / store / store.initDataObj / initDataObj 任何一层，都要找。
 */
export function isNeedLogin(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  for (const path of PDD_NEED_LOGIN_ROOTS) {
    const root = path === '' ? payload : readPath(payload, path);
    if (root === null || typeof root !== 'object') continue;
    const flag = firstNonEmpty(root, ['needLogin', 'need_login']);
    if (flag === true || flag === 'true') return true;
  }
  return false;
}

/** needLogin 可能出现的容器层级 */
const PDD_NEED_LOGIN_ROOTS = ['', 'store', 'store.initDataObj', 'initDataObj', 'data'] as const;

/** 商品 ID 核对：抓包数据必须和当前页面是同一个商品（§7.2 第 1 点） */
export function pickGoodsId(goods: unknown): string | undefined {
  return readString(goods, PDD_GOODS_ID_PATHS);
}
