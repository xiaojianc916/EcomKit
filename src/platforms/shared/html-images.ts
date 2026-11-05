import type { Asset } from '../../kernel/model/asset';
import { normalizeUrl } from './url';

/**
 * 富文本 HTML 里的图片（§7.6.1）。
 *
 * 抖音的详情经常是一整段 HTML 富文本，图片顺序就是页面上的展示顺序，
 * 所以必须按**文档顺序**取，不能先分组再拼接。
 */
export interface HtmlImageOptions {
  /** 相对地址的基准 */
  base?: string;
  /** 额外要过滤的地址前缀（例如平台的懒加载占位图） */
  skipSrcPrefixes?: readonly string[];
}

/** img 上可能带真实地址的属性，按可信度排序（src 常常是 1x1 占位图） */
const SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-url', 'src'] as const;

/**
 * 解析 HTML，按文档顺序取出所有 img 的地址。
 * 同一张图（路径相同、参数不同）只保留第一次出现的地址。
 */
export function extractImageUrls(html: string, opts: HtmlImageOptions = {}): string[] {
  if (typeof html !== 'string' || html.trim() === '') return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const imgs = Array.from(doc.querySelectorAll('img'));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const img of imgs) {
    const url = pickImgUrl(img, opts);
    if (!url) continue;
    const key = assetKeyFromUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

/** 依次尝试各属性，返回第一个能规范化成 http(s) 的地址 */
function pickImgUrl(img: Element, opts: HtmlImageOptions): string | undefined {
  for (const attr of SRC_ATTRS) {
    const raw = img.getAttribute(attr);
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const value = raw.trim();
    if (opts.skipSrcPrefixes?.some((p) => value.startsWith(p))) continue;
    const url = normalizeUrl(value, opts.base === undefined ? {} : { base: opts.base });
    if (url) return url;
  }
  return undefined;
}

/** 富文本 HTML → 详情图素材（index 按文档顺序，key 用地址路径） */
export function htmlToDetailAssets(
  html: string,
  opts: HtmlImageOptions & { startIndex?: number } = {},
): Asset[] {
  const urls = extractImageUrls(html, opts);
  const start = opts.startIndex ?? 0;
  return urls.map((url, i) => ({
    key: assetKeyFromUrl(url),
    kind: 'detail' as const,
    index: start + i,
    candidates: [url],
    preview: url,
  }));
}

/**
 * 素材 key：地址路径去掉查询串（小写）。
 * 同一张图被平台加上不同的追踪参数时，仍然算同一个素材。
 */
export function assetKeyFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return rawUrl;
  }
}
