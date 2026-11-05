import type { ErrorCode } from '../../kernel/errors/codes';
import type { Asset } from '../../kernel/model/asset';
import type { ProductDraft, Sku } from '../../kernel/model/product';
import { parseExpiry } from '../../kernel/net/expiry';
import { allowedUrls, isAllowedCdnUrl } from '../shared/cdn';
import { collectDomImages, type DomImageRules } from '../shared/dom-heuristics';
import { assetKeyFromUrl } from '../shared/html-images';
import { readInlineGlobal } from '../shared/inline-ssr';
import { firstNonEmpty, readArray, readNumber, readString } from '../shared/read-path';
import { normalizeUrl } from '../shared/url';
import { selectVideo, toVideoMeta } from '../shared/video';
import type { DataSource, PlatformResolver, ResolveContext } from '../types';
import { deepScanPdd } from './deep-scan';
import pddManifest from './manifest';
import {
  originalImageCandidates,
  thumbnailUrl,
  toPddImageAsset,
  toPddVideoCandidate,
} from './media';
import {
  findPddRoots,
  isNeedLogin,
  normalizeImageLike,
  normalizeImageList,
  normalizeSkuLike,
  normalizeVideoList,
  PDD_DETAIL_IMAGE_PATHS,
  PDD_MAIN_IMAGE_PATHS,
  PDD_PRICE_PATHS,
  PDD_SHOP_PATHS,
  PDD_SINGLE_MAIN_PATHS,
  PDD_SKU_PATHS,
  PDD_TITLE_PATHS,
  PDD_VIDEO_PATHS,
  type PddRawImage,
  type PddRawVideo,
  pickGoodsId,
} from './schema';

/**
 * 拼多多页面识别与数据解析（只在 ISOLATED world 运行，方案 §7.1）。
 *
 * 三源优先级：SSR（rawData）→ capture（商品详情接口）→ DOM 兜底。
 * 三者都是 AsyncIterable：SSR 一次产出完整 draft；capture 每命中一条响应产出一份；
 * DOM 在 DOMContentLoaded 后产出一份。合并交给 shared/merge.ts。
 */

const CDN_HOSTS = pddManifest.cdnHosts;

/** 抓包规则 id：取 manifest 里第一条（宽匹配，ISOLATED 侧再精筛） */
const CAPTURE_RULE_ID = pddManifest.capture[0]?.id ?? 'pdd.goods-detail';

/** DOM 兜底规则（方案 §7.5：主图轮播容器 + 详情图容器 + SKU 图容器） */
export const PDD_DOM_RULES: DomImageRules = {
  main: {
    // 待验证：登录态下真实的类名。常见命名都写进来，第一个能选到 img 的生效
    containers: [
      '[class*="goodsGallery"]',
      '[class*="goods-gallery"]',
      '[class*="main-img"]',
      '[class*="carousel"]',
      '[class*="banner"]',
    ],
    visibleOnly: true,
    limit: 20,
  },
  detail: {
    containers: [
      '[class*="detailGallery"]',
      '[class*="detail-gallery"]',
      '[class*="goods-detail"]',
      '[class*="detail-img"]',
    ],
    limit: 120,
  },
  sku: {
    containers: ['[class*="sku"] [class*="img"]', '[class*="skuImg"]', '[class*="sku-list"]'],
    limit: 60,
  },
  // 推荐位：混进来会把别的商品的图当成本商品素材
  exclude: ['[class*="recommend"]', '[class*="mall-rec"]', '[class*="similar"]'],
};

/* ------------------------------------------------------------------ *
 * 阻断判定（方案 §7.5、docs/phase0/FINDINGS.md §1）
 * ------------------------------------------------------------------ */

/** 「商品已下架」文案（待验证：真实页面的文案和错误码） */
const GONE_TEXTS = ['商品已下架', '该商品已下架', '商品不存在', '商品已失效', '该商品已售罄下架'];

function isLoginLocation(url: URL): boolean {
  return /(^|\/)login(\.html)?(\/|$)/.test(url.pathname);
}

function safeBodyText(doc: Document): string {
  try {
    return (doc.body?.textContent ?? '').slice(0, 8000);
  } catch {
    return '';
  }
}

/**
 * 下架页很短，只有一行提示；正常商品页的推荐区、评价区也可能出现「已下架」字样，
 * 所以正文太长时不按文案判定，交给数据源（没有数据会落到 PARSE_EMPTY）。
 */
function isGonePage(doc: Document): boolean {
  let full = '';
  try {
    full = doc.body?.textContent ?? '';
  } catch {
    return false;
  }
  if (full === '' || full.length > 3000) return false;
  const text = safeBodyText(doc);
  return GONE_TEXTS.some((t) => text.includes(t));
}

/** 登录表单：Phase 0 抓到的登录页有 #user-mobile / .login-ui-form / #submit-button */
function hasLoginForm(doc: Document): boolean {
  try {
    return (
      doc.querySelector('#user-mobile, .login-ui-form, #submit-button, form[class*="login"]') !==
      null
    );
  } catch {
    return false;
  }
}

/**
 * 页面上是否已经有商品图（排除二维码、图标这类小图）。
 * 真实页面的 <img> 基本不写 width 属性，所以同时看 naturalWidth / 渲染宽度，
 * 并且只认 CDN 白名单里的图（二维码、登录插画不在 pddpic 上）。
 */
function hasProductImages(doc: Document): boolean {
  try {
    for (const img of doc.querySelectorAll('img')) {
      const src = pickImgSrc(img);
      if (src === undefined) continue;
      const url = normalizeUrl(src, {
        base: doc.location?.href ?? 'https://mobile.yangkeduo.com/',
      });
      if (url === undefined || !isAllowedCdnUrl(url, CDN_HOSTS)) continue;
      if (imageWidth(img) >= 100) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function imageWidth(img: Element): number {
  const attr = Number(img.getAttribute('width') ?? 0);
  const natural = (img as HTMLImageElement).naturalWidth ?? 0;
  let rendered = 0;
  try {
    rendered = img.getBoundingClientRect().width;
  } catch {
    rendered = 0;
  }
  return Math.max(Number.isFinite(attr) ? attr : 0, natural, rendered);
}

function pickImgSrc(img: Element): string | undefined {
  for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'src']) {
    const v = img.getAttribute(attr);
    if (typeof v === 'string' && v.trim() !== '' && !v.startsWith('data:')) return v.trim();
  }
  return undefined;
}

/** SSR 里是否已经有商品数据（有标题就认为拿到了） */
export function pddHasGoodsData(rawData: unknown): boolean {
  if (rawData === null || rawData === undefined) return false;
  const roots = findPddRoots(rawData);
  if (!roots?.goods) return false;
  return firstNonEmpty(roots.goods, PDD_TITLE_PATHS) !== undefined;
}

/**
 * 同步阻断判定（PlatformResolver.detectBlocker 的实现）。
 *
 * 三个信号都检查，不只看 location：
 * ① location 被跳到 /login.html → LOGIN_REQUIRED；
 * ② 内联脚本里的 `rawData` 标记 `needLogin` 且没有商品数据 → LOGIN_REQUIRED
 *    （Phase 0 实测：未登录时 `initDataObj` 只有 `{ needLogin: true }`）；
 * ③ 页面出现登录表单且没有商品图 → LOGIN_REQUIRED。
 * 另外检查「商品已下架」文案 → PRODUCT_GONE。
 *
 * ② 之所以能在同步函数里做：SSR 数据内联在 `<script>` 里，ISOLATED world 直接可读
 * （见 shared/inline-ssr.ts）；不需要 bridge 的 readGlobal()。
 */
export function detectPddBlocker(doc: Document, url: URL): ErrorCode | null {
  if (isLoginLocation(url)) return 'LOGIN_REQUIRED';

  const inline = readInlineGlobal(doc, 'rawData');
  // SSR 里已经有商品数据：页面上其他元素（PC 侧栏的扫码登录、推荐区文案）都不算阻断
  if (inline !== undefined && pddHasGoodsData(inline)) return null;
  if (inline !== undefined && isNeedLogin(inline)) return 'LOGIN_REQUIRED';

  if (isGonePage(doc)) return 'PRODUCT_GONE';
  if (hasLoginForm(doc) && !hasProductImages(doc)) return 'LOGIN_REQUIRED';
  return null;
}

/**
 * 异步阻断判定：额外经 bridge 读一次 window.rawData。
 *
 * 同步版 detectPddBlocker 已经能读内联 SSR，这个函数是给「SSR 换成外链脚本 / 由 JS 注入」
 * 的情况兜底：PageController 拿到 ctx 之后可以再调一次，判得更准再进 resolving。
 */
export async function detectPddBlockerAsync(
  ctx: Pick<ResolveContext, 'url' | 'document' | 'readGlobal' | 'log'>,
): Promise<ErrorCode | null> {
  const sync = detectPddBlocker(ctx.document, ctx.url);
  if (sync !== null) return sync;

  let rawData: unknown;
  try {
    rawData = await ctx.readGlobal('rawData');
  } catch {
    return null;
  }
  if (rawData === undefined) return null;

  if (isNeedLogin(rawData) && !pddHasGoodsData(rawData)) {
    ctx.log.debug('rawData.store.initDataObj.needLogin === true，判定为登录墙');
    return 'LOGIN_REQUIRED';
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 数据源
 * ------------------------------------------------------------------ */

/** SSR 数据源：读 window.rawData（白名单里已声明），一次产出完整 draft */
export const ssrSource: DataSource = {
  id: 'ssr',
  async *run(ctx: ResolveContext): AsyncIterable<ProductDraft> {
    let rawData: unknown;
    try {
      rawData = await ctx.readGlobal('rawData');
    } catch {
      return;
    }
    if (rawData === undefined) {
      ctx.log.info('SSR：页面上没有 window.rawData');
      return;
    }
    const draft = draftFromPayload(rawData, ctx, 'ssr');
    ctx.log.info('SSR：rawData 解析结果', describeDraft(rawData, draft));
    if (draft) yield draft;
  },
};

/** 诊断摘要：只输出结构和数量，不输出任何字段值（避免把个人信息写进日志） */
function describeDraft(payload: unknown, draft: ProductDraft | null): Record<string, unknown> {
  const roots = findPddRoots(payload);
  const counts: Record<string, number> = {};
  for (const a of draft?.assets ?? []) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  return {
    topKeys: topKeys(payload),
    initDataKeys: topKeys(firstNonEmpty(payload, ['store.initDataObj', 'initDataObj'])),
    goodsKeys: topKeys(roots?.goods),
    hasTitle: draft?.title !== undefined,
    counts,
    // 深度扫描命中的路径（只有路径名，没有值），用来把真实字段补进 schema 候选表
    deepScan: deepScanPdd(roots?.goods ?? payload, { cdnHosts: CDN_HOSTS }).paths,
  };
}

function topKeys(v: unknown): string[] | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  return Object.keys(v as Record<string, unknown>).slice(0, 60);
}

/**
 * 抓包数据源：每命中一条带商品数据的响应就产出一份 draft。
 * 用 `goods_id` 核对是不是当前商品（SPA 切换商品时不会串数据，§7.2 第 1 点）。
 */
export const captureSource: DataSource = {
  id: 'capture',
  async *run(ctx: ResolveContext): AsyncIterable<ProductDraft> {
    for await (const payload of ctx.captures(CAPTURE_RULE_ID)) {
      if (ctx.signal.aborted) return;
      if (payload.json === null || typeof payload.json !== 'object') continue;
      ctx.log.debug('抓包命中', { url: safePath(payload.url) });
      if (!matchesProductId(payload.json, ctx.productId)) {
        ctx.log.debug('抓包数据不是当前商品，丢弃', { productId: ctx.productId });
        continue;
      }
      const draft = draftFromPayload(payload.json, ctx, 'capture');
      if (draft?.assets?.length) {
        ctx.log.info('抓包：商品数据', { url: safePath(payload.url), assets: draft.assets.length });
      }
      if (draft) yield draft;
    }
  },
};

/** DOM 兜底：DOMContentLoaded 之后产出一份，只补结构化来源没给的类别（由 merge 决定） */
export const domSource: DataSource = {
  id: 'dom',
  async *run(ctx: ResolveContext): AsyncIterable<ProductDraft> {
    const doc = ctx.document;
    if (doc.readyState === 'loading') {
      await waitForDomReady(doc, ctx.signal);
    }
    if (ctx.signal.aborted) return;

    // 页面是前端渲染时，DOMContentLoaded 那一刻图片可能还没出来：没找到就隔一会儿再找
    const deadline = Date.now() + DOM_POLL_MS;
    let assets: Asset[] = [];
    while (!ctx.signal.aborted) {
      assets = collectPddDomAssets(doc, ctx.productId);
      if (assets.length > 0 || Date.now() >= deadline) break;
      await sleep(DOM_POLL_INTERVAL_MS, ctx.signal);
    }
    if (ctx.signal.aborted) return;
    ctx.log.info('DOM：页面图片', { assets: assets.length });
    if (assets.length === 0) return;

    const draft: ProductDraft = { source: 'dom', assets };
    const title = pageTitle(doc);
    if (title !== undefined) draft.title = title;
    yield draft;
  },
};

const DOM_POLL_MS = 6000;
const DOM_POLL_INTERVAL_MS = 600;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** 先按类名规则找；拼多多 H5 的类名是编译后的短哈希，规则落空时用「CDN 大图」启发式 */
export function collectPddDomAssets(doc: Document, productId: string): Asset[] {
  const picked = collectDomImages(doc, PDD_DOM_RULES);
  const byRules = [...picked.main, ...picked.detail, ...picked.sku].filter((a) =>
    a.candidates.some((u) => isAllowedCdnUrl(u, CDN_HOSTS)),
  );
  if (byRules.length > 0) return byRules;
  return collectLargeCdnImages(doc, productId);
}

/** 推荐区的标题文案：这些文字之后的图片都不是本商品的 */
const RECOMMEND_HEADINGS =
  /为你推荐|猜你喜欢|相似商品|看了又看|店铺推荐|更多好货|大家都在买|同类好物/;

function findRecommendCutoff(doc: Document): Element | null {
  try {
    const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT);
    let steps = 0;
    for (let node = walker.nextNode(); node !== null && steps < 20_000; node = walker.nextNode()) {
      steps += 1;
      const text = node.textContent ?? '';
      if (text.length <= 12 && RECOMMEND_HEADINGS.test(text)) return node.parentElement;
    }
  } catch {
    // 遍历失败就不截断
  }
  return null;
}

/**
 * 通用 DOM 兜底：页面上来自 pddpic / yangkeduo 的大图。
 * - 推荐区标题之后的图片全部丢弃；链接到别的 goods_id 的图片（推荐卡片）丢弃；
 * - 位于页面顶部（首屏轮播区）的归为主图，其余渲染宽度 ≥ 300 的归为详情图；
 * - 评价晒图、图标、头像渲染尺寸都小，被宽度阈值挡掉。
 */
function collectLargeCdnImages(doc: Document, productId: string): Asset[] {
  const base = doc.location?.href ?? undefined;
  const cutoff = findRecommendCutoff(doc);
  const view = doc.defaultView;
  const scrollY = view?.scrollY ?? 0;
  const viewportH = view?.innerHeight ?? 800;
  const main: string[] = [];
  const detail: string[] = [];
  const seen = new Set<string>();

  let imgs: Element[] = [];
  try {
    imgs = Array.from(doc.querySelectorAll('img'));
  } catch {
    return [];
  }
  for (const img of imgs) {
    if (cutoff && cutoff.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
    const link = img.closest('a[href*="goods_id="]');
    if (link) {
      const href = link.getAttribute('href') ?? '';
      if (!href.includes(`goods_id=${productId}`)) continue;
    }
    const raw = pickImgSrc(img);
    if (raw === undefined) continue;
    const norm = normalizeUrl(raw, base === undefined ? {} : { base });
    if (norm === undefined || !isAllowedCdnUrl(norm, CDN_HOSTS)) continue;
    const original = originalImageCandidates(norm, base)[0] ?? norm;
    const key = assetKeyFromUrl(original);
    if (seen.has(key)) continue;

    let rect: DOMRect | undefined;
    try {
      rect = img.getBoundingClientRect();
    } catch {
      rect = undefined;
    }
    const width = Math.max(rect?.width ?? 0, Number(img.getAttribute('width') ?? 0) || 0);
    const top = (rect?.top ?? 0) + scrollY;
    if (width >= 250 && top < viewportH) {
      seen.add(key);
      if (main.length < 15) main.push(norm);
    } else if (width >= 300) {
      seen.add(key);
      if (detail.length < 80) detail.push(norm);
    }
  }

  const toAsset = (url: string, kind: 'main' | 'detail', index: number): Asset => {
    const candidates = allowedUrls(originalImageCandidates(url, base), CDN_HOSTS, base);
    const preview = thumbnailUrl(url, 200, base);
    return {
      key: assetKeyFromUrl(candidates[0] ?? url),
      kind,
      index,
      candidates: candidates.length > 0 ? candidates : [url],
      ...(preview !== undefined ? { preview } : {}),
      fromDom: true,
    };
  };
  return [
    ...main.map((u, i) => toAsset(u, 'main', i)),
    ...detail.map((u, i) => toAsset(u, 'detail', i)),
  ];
}

function safePath(raw: string | undefined): string {
  if (raw === undefined) return '';
  try {
    return new URL(raw, 'https://mobile.yangkeduo.com/').pathname;
  } catch {
    return '';
  }
}

function waitForDomReady(doc: Document, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      doc.removeEventListener('DOMContentLoaded', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    doc.addEventListener('DOMContentLoaded', done, { once: true });
    signal.addEventListener('abort', done, { once: true });
  });
}

function pageTitle(doc: Document): string | undefined {
  const raw = doc.title?.trim() ?? '';
  if (raw === '' || raw === '拼多多') return undefined;
  // 站点标题常见形式「商品标题 - 拼多多」，去掉站点后缀
  const cleaned = raw.replace(/[\s\-|_—]+拼多多.*$/, '').trim();
  return cleaned === '' ? undefined : cleaned;
}

/** 抓包内容是不是当前商品：有 ID 就比，没有 ID 就放过（部分接口不回 ID） */
function matchesProductId(json: unknown, productId: string): boolean {
  const roots = findPddRoots(json);
  if (!roots?.goods) return true;
  const id = pickGoodsId(roots.goods);
  return id === undefined || id === productId;
}

/* ------------------------------------------------------------------ *
 * 数据 → draft
 * ------------------------------------------------------------------ */

/** 把任意一份拼多多数据（SSR / 抓包）转成 ProductDraft；缺什么就少给什么，不抛异常 */
export function draftFromPayload(
  payload: unknown,
  ctx: Pick<ResolveContext, 'url' | 'document'>,
  source: ProductDraft['source'],
): ProductDraft | null {
  if (payload === null || payload === undefined) return null;
  const roots = findPddRoots(payload);
  // SSR 的 rawData 就是本商品页的数据：找不到 goods 容器时整体做深度扫描；
  // 抓包可能是推荐接口，没有 goods 容器就不扫，免得混入别的商品
  if (!roots && source !== 'ssr') return null;

  const goods = roots?.goods ?? null;
  const mall = roots?.mall ?? null;
  const scanRoot: unknown =
    goods ?? (source === 'ssr' ? (firstNonEmpty(payload, ['store.initDataObj']) ?? payload) : null);
  const base = ctx.url.href;
  const draft: ProductDraft = { source };

  let scanned: ReturnType<typeof deepScanPdd> | undefined;
  const deep = (): ReturnType<typeof deepScanPdd> => {
    scanned ??= deepScanPdd(scanRoot, { cdnHosts: CDN_HOSTS, base });
    return scanned;
  };

  const title = readString(goods, PDD_TITLE_PATHS) ?? (scanRoot ? deep().title : undefined);
  if (title !== undefined) draft.title = title;

  const shopName = readString(mall, PDD_SHOP_PATHS) ?? readString(goods, PDD_SHOP_PATHS);
  if (shopName !== undefined) draft.shopName = shopName;

  /**
   * 价格：拼多多的真实抓包里 minGroupPrice 这类字段**全是字符串 "0"**
   * （未登录 / 优惠前价格不下发），直接显示会得到「¥0.00」，写进 商品信息.txt
   * 反而误导用户。所以 0 和非法值一律当作「拿不到」，宁可不显示。
   */
  const priceFen = readNumber(goods, PDD_PRICE_PATHS);
  if (priceFen !== undefined && Number.isFinite(priceFen) && priceFen > 0) {
    draft.price = `¥${(priceFen / 100).toFixed(2)}`;
  }

  const assets: Asset[] = [];
  let mainImages: PddRawImage[] = normalizeImageList(readArray(goods, PDD_MAIN_IMAGE_PATHS));
  if (mainImages.length === 0 && scanRoot) mainImages = deep().main;
  if (mainImages.length === 0) {
    const single = normalizeImageLike(firstNonEmpty(goods, PDD_SINGLE_MAIN_PATHS));
    if (single) mainImages = [single];
  }
  mainImages.forEach((img, i) => {
    const asset = toPddImageAsset(img, { kind: 'main', index: i, base });
    if (asset) assets.push(asset);
  });

  const mainKeys = new Set(assets.map((a) => a.key));
  let detailImages: PddRawImage[] = normalizeImageList(readArray(goods, PDD_DETAIL_IMAGE_PATHS));
  if (detailImages.length === 0 && scanRoot) detailImages = deep().detail;
  detailImages.forEach((img, i) => {
    const asset = toPddImageAsset(img, { kind: 'detail', index: i, base });
    // 主图数组和详情图数组偶尔指向同一批图，按 key 去重
    if (asset && !mainKeys.has(asset.key)) assets.push(asset);
  });

  const skuPart = buildSkus(goods, base);
  assets.push(...skuPart.assets);
  let videos = buildVideos(readVideoList(goods), base);
  if (videos.length === 0 && scanRoot) videos = buildVideos(deep().videos, base);
  assets.push(...videos);

  const safeAssets = assets
    .map((asset) => withAllowedCandidates(asset, base))
    .filter((asset): asset is Asset => asset !== null);

  if (safeAssets.length > 0) draft.assets = safeAssets;
  if (skuPart.skus.length > 0) draft.skus = skuPart.skus;
  if (!draft.title && !draft.assets?.length && !draft.skus?.length) return null;
  return draft;
}

/** 候选地址过 CDN 白名单；缩略图也必须是白名单内的地址（§13.4） */
function withAllowedCandidates(asset: Asset, base: string): Asset | null {
  const candidates = allowedUrls(asset.candidates, CDN_HOSTS, base);
  const first = candidates[0];
  if (first === undefined) return null;

  const out: Asset = {
    ...asset,
    key: asset.key === '' ? assetKeyFromUrl(first) : asset.key,
    candidates,
  };
  const preview = allowedUrls([asset.preview ?? first], CDN_HOSTS, base)[0];
  if (preview !== undefined) out.preview = preview;
  else delete out.preview;
  return out;
}

function buildSkus(goods: unknown, base: string): { assets: Asset[]; skus: Sku[] } {
  const rawSkus = readArray(goods, PDD_SKU_PATHS);
  const assets: Asset[] = [];
  const skus: Sku[] = [];
  const keyByUrl = new Map<string, string>();

  rawSkus.forEach((raw, i) => {
    const sku = normalizeSkuLike(raw, i);
    if (!sku) return;

    let imageKey: string | undefined;
    if (sku.imageUrl !== undefined) {
      const candidates = allowedUrls(originalImageCandidates(sku.imageUrl, base), CDN_HOSTS, base);
      const first = candidates[0];
      if (first !== undefined) {
        const existing = keyByUrl.get(first);
        if (existing !== undefined) {
          // 多个 SKU 共用一张图时只生成一个素材（§7.3、§9.1）
          imageKey = existing;
        } else {
          const label = sku.specs.map((s) => s.value).join('-');
          const preview = thumbnailUrl(sku.imageUrl, 120, base);
          const asset: Asset = {
            key: assetKeyFromUrl(first),
            kind: 'sku',
            index: assets.length,
            candidates,
            ...(preview !== undefined ? { preview } : {}),
            ...(label !== '' ? { label } : {}),
          };
          imageKey = asset.key;
          keyByUrl.set(first, asset.key);
          assets.push(asset);
        }
      }
    }

    skus.push({
      id: sku.id,
      specs: sku.specs,
      ...(imageKey !== undefined ? { imageKey } : {}),
      ...(sku.price !== undefined && sku.price !== '' ? { price: sku.price } : {}),
      ...(sku.stock !== undefined ? { stock: sku.stock } : {}),
    });
  });

  return { assets, skus };
}

/**
 * 视频：拼多多给的是 mp4 直链，选择规则见 shared/video.ts
 * （优先 H.264、同编码选分辨率最高、再选码率最高）。
 */
/** 视频字段既可能是数组，也可能是单个对象（goods.video = { url }） */
function readVideoList(goods: unknown): PddRawVideo[] {
  const v = firstNonEmpty(goods, PDD_VIDEO_PATHS);
  if (Array.isArray(v)) return normalizeVideoList(v);
  if (v !== undefined) return normalizeVideoList([v]);
  return [];
}

function buildVideos(raws: readonly PddRawVideo[], base: string): Asset[] {
  if (raws.length === 0) return [];

  const out: Asset[] = [];
  for (const raw of raws) {
    const candidate = toPddVideoCandidate(raw, base);
    if (!candidate) continue;
    const picked = selectVideo([candidate]);
    if (!picked) continue;

    const first = allowedUrls([picked.url], CDN_HOSTS, base)[0];
    if (first === undefined) continue;

    const expiresAt = parseExpiry(first);
    const cover =
      picked.cover === undefined ? undefined : allowedUrls([picked.cover], CDN_HOSTS, base)[0];
    // kernel 的 parseExpiry 没有过期参数时返回 null，toVideoMeta 会过滤掉
    const meta = toVideoMeta(picked, { expiresAt });
    if (cover !== undefined) meta.cover = cover;

    // 只有 H.265 时照常下载：UI 依据 video.codec === 'h265' 在视频行上标「H.265」（§10.4）
    const label = picked.label ?? (out.length === 0 ? '主图视频' : undefined);
    out.push({
      key: `video-${assetKeyFromUrl(first)}`,
      kind: 'video',
      index: out.length,
      candidates: [first],
      ...(label !== undefined ? { label } : {}),
      video: meta,
    });
  }
  return out;
}

export const pinduoduoResolver: PlatformResolver = {
  detectBlocker: detectPddBlocker,
  sources: [ssrSource, captureSource, domSource],
};

export default pinduoduoResolver;
