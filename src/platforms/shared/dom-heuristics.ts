import type { Asset } from '../../kernel/model/asset';
import { assetKeyFromUrl } from './html-images';
import { normalizeUrl } from './url';

/**
 * DOM 兜底解析（§7.3「DOM 只用来补空」）。
 *
 * 启发式的误判风险主要来自**推荐位 / 店铺推荐 / 底部瀑布流**：那些图片不是本商品的素材。
 * 所以只认明确标注了「主图 / 详情 / SKU」的容器，宁可少拿也不混入推荐商品。
 * 容器选择器写成多候选数组：平台改版时改这里就行，不用动流程。
 */
export interface DomCategoryDef {
  /** 容器候选选择器：第一个能选到 img 的生效 */
  containers: readonly string[];
  /** 命中后是否只取容器内的「当前可见」图片（轮播里通常只有一张可见） */
  visibleOnly?: boolean;
  /** 最多取多少张，防止把整个瀑布流吸进来 */
  limit?: number;
  /** 排序：'document'（文档顺序，默认）| 'attr-index'（按 data-index 等属性排序） */
  order?: 'document' | 'attr-index';
}

export interface DomImageRules {
  main: DomCategoryDef;
  detail: DomCategoryDef;
  sku: DomCategoryDef;
  /** 需要排除的选择器（推荐位等） */
  exclude?: readonly string[];
}

export interface DomImageResult {
  main: Asset[];
  detail: Asset[];
  sku: Asset[];
}

/** 从 Document 按规则抓图片；任何异常都返回空数组，绝不影响主流程 */
export function collectDomImages(doc: Document, rules: DomImageRules): DomImageResult {
  return {
    main: collectCategory(doc, 'main', rules.main, rules.exclude),
    detail: collectCategory(doc, 'detail', rules.detail, rules.exclude),
    sku: collectCategory(doc, 'sku', rules.sku, rules.exclude),
  };
}

export function collectCategory(
  doc: Document,
  kind: 'main' | 'detail' | 'sku',
  def: DomCategoryDef,
  exclude?: readonly string[],
): Asset[] {
  const base = doc.location?.href ?? undefined;
  for (const selector of def.containers) {
    const containers = safeQueryAll(doc, selector);
    if (containers.length === 0) continue;

    const urls: { url: string; order: number }[] = [];
    for (const container of containers) {
      const imgs = safeQueryAll(container, 'img');
      for (const [i, img] of imgs.entries()) {
        if (exclude && exclude.length > 0 && isExcluded(img, exclude)) continue;
        if (def.visibleOnly && !isLikelyVisible(img)) continue;
        const raw = pickImgSrc(img);
        if (!raw) continue;
        const url = normalizeUrl(raw, base === undefined ? {} : { base });
        if (!url) continue;
        urls.push({ url, order: def.order === 'attr-index' ? attrIndex(img, i) : urls.length });
      }
    }

    const deduped = dedupeByKey(urls);
    if (deduped.length === 0) continue;
    const limited = def.limit === undefined ? deduped : deduped.slice(0, def.limit);
    return limited.map((url, i) => ({
      key: assetKeyFromUrl(url),
      kind,
      index: i,
      candidates: [url],
      preview: url,
      fromDom: true,
    }));
  }
  return [];
}

function safeQueryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function isExcluded(el: Element, exclude: readonly string[]): boolean {
  for (const sel of exclude) {
    try {
      if (el.closest(sel)) return true;
    } catch {
      // 选择器写错时忽略这一条，不影响其他规则
    }
  }
  return false;
}

/**
 * 「是否可见」的廉价近似：不读 getComputedStyle（同步触发布局，轮播页上很贵），
 * 只看 display:none / hidden 属性和宽度为 0 的懒加载占位。
 */
function isLikelyVisible(img: Element): boolean {
  if (img.getAttribute('aria-hidden') === 'true') return false;
  const style = img.getAttribute('style') ?? '';
  if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) return false;
  const w = img.getAttribute('width');
  if (w !== null && Number(w) === 0) return false;
  return true;
}

function pickImgSrc(img: Element): string | undefined {
  for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'src']) {
    const v = img.getAttribute(attr);
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

function attrIndex(img: Element, fallback: number): number {
  for (const attr of ['data-index', 'data-i', 'data-idx']) {
    const v = img.getAttribute(attr);
    if (v !== null) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

function dedupeByKey(items: { url: string; order: number }[]): string[] {
  const sorted = [...items].sort((a, b) => a.order - b.order);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of sorted) {
    const key = assetKeyFromUrl(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item.url);
  }
  return out;
}
