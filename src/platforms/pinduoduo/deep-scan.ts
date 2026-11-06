import { isAllowedCdnUrl } from '../shared/cdn';
import { normalizeUrl } from '../shared/url';
import {
  normalizeImageLike,
  normalizeVideoLike,
  type PddRawImage,
  type PddRawVideo,
} from './schema';

/**
 * 拼多多数据的「深度兜底扫描」。
 *
 * 字段路径表（schema.ts）是按经验写的候选，登录态真实结构一直没能完整验证；
 * 平台改个字段名，候选路径就全部落空，结果就是「各类素材都是 0」。
 * 这里换一种思路：在 goods 容器里递归找「元素是 CDN 图片 / 视频」的数组，
 * 再按它所在的**路径名**归类（banner/gallery → 主图，detail/desc/decoration → 详情）。
 *
 * 只在候选路径没拿到对应类别时才用（resolver.draftFromPayload 决定），
 * 并且排除推荐位、评价、头像、图标这类路径，宁可少拿也不混入别的商品的图。
 */

export interface PddDeepScanOptions {
  cdnHosts: readonly string[];
  base?: string;
}

export interface PddDeepScanResult {
  main: PddRawImage[];
  detail: PddRawImage[];
  videos: PddRawVideo[];
  title?: string;
  /** 命中的路径，写进诊断日志，方便下次把它补进 schema 候选表 */
  paths: { main?: string; detail: string[]; video?: string };
}

const MAX_DEPTH = 10;
const MAX_NODES = 60_000;

/** 路径里出现这些词就跳过：推荐位、评价、店铺、图标等都不是本商品素材 */
const EXCLUDE_RE =
  /recommend|(^|[._])rec([._]|$)|similar|guess|comment|review|evaluat|avatar|icon|logo|coupon|service|promotion|activity|medal|brand|live|mall|share|tag|label|badge|bubble|popup|rank|lego|footer|header|nav/i;
const SKU_RE = /sku/i;
const DETAIL_RE = /detail|desc|decoration|intro/i;
const MAIN_RE = /top|banner|gallery|carousel|slide|main|hd_?thumb|image|img|pic/i;
const VIDEO_RE = /video/i;
const VIDEO_URL_RE = /\.(mp4|m3u8|mov|flv)(\?|$)/i;
const GOODS_NAME_KEYS = /^(goods_?name|goods_?title)$/i;

interface Found {
  path: string;
  images: PddRawImage[];
}

export function deepScanPdd(root: unknown, opts: PddDeepScanOptions): PddDeepScanResult {
  const result: PddDeepScanResult = { main: [], detail: [], videos: [], paths: { detail: [] } };
  if (root === null || typeof root !== 'object') return result;

  const mainHits: Found[] = [];
  const otherHits: Found[] = [];
  const detailHits: Found[] = [];
  let videoHit: { path: string; videos: PddRawVideo[] } | undefined;

  let nodes = 0;
  const stack: { value: unknown; path: string; depth: number }[] = [
    { value: root, path: '', depth: 0 },
  ];

  while (stack.length > 0 && nodes < MAX_NODES) {
    const cur = stack.pop();
    if (cur === undefined) break;
    nodes += 1;
    const { value, path, depth } = cur;
    if (value === null || typeof value !== 'object') continue;
    if (path !== '' && EXCLUDE_RE.test(path)) continue;
    if (SKU_RE.test(path)) continue; // SKU 图由 buildSkus 处理

    if (Array.isArray(value)) {
      const lower = path.toLowerCase();
      if (VIDEO_RE.test(lower) || value.some(isVideoLikeItem)) {
        const videos = collectVideos(value, opts);
        if (videos.length > 0 && videoHit === undefined) videoHit = { path, videos };
      }
      const images = collectImages(value, opts);
      if (images.length > 0) {
        const hit = { path, images };
        if (DETAIL_RE.test(lower)) detailHits.push(hit);
        else if (MAIN_RE.test(lower)) mainHits.push(hit);
        else otherHits.push(hit);
      }
    } else {
      const rec = value as Record<string, unknown>;
      if (result.title === undefined) {
        for (const [k, v] of Object.entries(rec)) {
          if (GOODS_NAME_KEYS.test(k) && typeof v === 'string' && v.trim() !== '') {
            result.title = v.trim();
            break;
          }
        }
      }
      // 单个视频对象：{ video: { url } }
      if (videoHit === undefined && VIDEO_RE.test(path)) {
        const v = normalizeVideoLike(rec);
        if (v && isAllowed(v.url, opts) && VIDEO_URL_RE.test(v.url)) {
          videoHit = { path, videos: [v] };
        }
      }
    }

    if (depth >= MAX_DEPTH) continue;

    /**
     * 逆序压栈 → 出栈时按原顺序遍历，详情图拼接顺序与页面一致。
     *
     * 直接倒着遍历源对象，不先 map 出中间的 [path, value] 元组数组：
     * 原来每个子节点（包括成千上万个字符串/数字叶子）都要构造一个元组 + 拼一次路径字符串；
     * 一次扫描最多 6 万节点，其中绝大多数是叶子，很快就被 typeof 拦掉。
     * 只有真正的对象子节点才需要拼路径。
     */
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        const child = value[i];
        if (child !== null && typeof child === 'object') {
          stack.push({ value: child, path: `${path}[${i}]`, depth: depth + 1 });
        }
      }
    } else {
      const rec = value as Record<string, unknown>;
      const keys = Object.keys(rec);
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i] as string;
        const child = rec[key];
        if (child !== null && typeof child === 'object') {
          stack.push({
            value: child,
            path: path === '' ? key : `${path}.${key}`,
            depth: depth + 1,
          });
        }
      }
    }
  }

  /**
   * 主图：主图类路径里图片最多的那一组；没有就退到「未分类」里最多的一组。
   *
   * **但绝不能退到详情图里**：真实抓包里没有 topGallery 时，19 张详情图会落进
   * 「未分类」桶，退回 picks 之后主图=详情图 —— 用户看到「主图 19 张、详情图 0 张」，
   * 下载出来的目录结构全错。所以只要 unclassified 的路径明明写着 detail/desc，
   * 就不许它当主图。
   */
  const usableOthers = otherHits.filter((hit) => !DETAIL_RE.test(hit.path.toLowerCase()));
  const bestMain =
    pickLargest(mainHits) ?? (detailHits.length === 0 ? pickLargest(usableOthers) : undefined);
  if (bestMain) {
    result.main = bestMain.images;
    result.paths.main = bestMain.path;
  }

  // 详情图：所有详情类路径按出现顺序拼起来（decoration 是多层楼层结构）
  const seen = new Set(result.main.map((img) => img.url));
  for (const hit of detailHits) {
    let used = false;
    for (const img of hit.images) {
      if (seen.has(img.url)) continue;
      seen.add(img.url);
      result.detail.push(img);
      used = true;
    }
    if (used) result.paths.detail.push(hit.path);
  }

  if (videoHit) {
    result.videos = videoHit.videos;
    result.paths.video = videoHit.path;
  }
  return result;
}

function pickLargest(hits: Found[]): Found | undefined {
  let best: Found | undefined;
  for (const hit of hits) {
    if (best === undefined || hit.images.length > best.images.length) best = hit;
  }
  return best;
}

function isAllowed(raw: string, opts: PddDeepScanOptions): boolean {
  const url = normalizeUrl(raw, opts.base === undefined ? {} : { base: opts.base });
  return url !== undefined && isAllowedCdnUrl(url, opts.cdnHosts);
}

function isVideoLikeItem(item: unknown): boolean {
  if (typeof item === 'string') return VIDEO_URL_RE.test(item);
  if (item === null || typeof item !== 'object') return false;
  const v = normalizeVideoLike(item);
  return v !== null && VIDEO_URL_RE.test(v.url);
}

/** 数组元素里的 CDN 图片（至少一半元素是图片才算「图片数组」，避免把杂项对象数组当图集） */
function collectImages(arr: readonly unknown[], opts: PddDeepScanOptions): PddRawImage[] {
  const out: PddRawImage[] = [];
  const seen = new Set<string>();
  let considered = 0;
  for (const item of arr) {
    if (item === null || item === undefined) continue;
    considered += 1;
    const img = normalizeImageLike(item);
    if (!img || VIDEO_URL_RE.test(img.url) || !isAllowed(img.url, opts)) continue;
    if (seen.has(img.url)) continue;
    seen.add(img.url);
    out.push(img);
  }
  if (considered === 0 || out.length * 2 < considered) return [];
  return out;
}

function collectVideos(arr: readonly unknown[], opts: PddDeepScanOptions): PddRawVideo[] {
  const out: PddRawVideo[] = [];
  for (const item of arr) {
    const v = normalizeVideoLike(item);
    if (v && VIDEO_URL_RE.test(v.url) && isAllowed(v.url, opts)) out.push(v);
  }
  return out;
}
