import type { ErrorCode } from '../../kernel/errors/codes';
import type { Asset } from '../../kernel/model/asset';
import type { ProductDraft, Sku } from '../../kernel/model/product';
import { parseExpiry } from '../../kernel/net/expiry';
import { allowedUrls } from '../shared/cdn';
import { collectDomImages, type DomImageRules } from '../shared/dom-heuristics';
import { assetKeyFromUrl } from '../shared/html-images';
import { readInlineGlobal } from '../shared/inline-ssr';
import { firstNonEmpty, readArray, readNumber, readString } from '../shared/read-path';
import { selectVideo, toVideoMeta } from '../shared/video';
import type { DataSource, PlatformResolver, ResolveContext } from '../types';
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
  normalizeImageList,
  normalizeSkuLike,
  normalizeVideoList,
  PDD_DETAIL_IMAGE_PATHS,
  PDD_MAIN_IMAGE_PATHS,
  PDD_PRICE_PATHS,
  PDD_SHOP_PATHS,
  PDD_SKU_PATHS,
  PDD_TITLE_PATHS,
  PDD_VIDEO_PATHS,
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

function isGonePage(doc: Document): boolean {
  const text = safeBodyText(doc);
  if (text === '') return false;
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

/** 页面上是否已经有商品图（排除二维码、图标这类小图） */
function hasProductImages(doc: Document): boolean {
  try {
    for (const img of doc.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? img.getAttribute('data-src') ?? '';
      if (!/^https?:\/\//.test(src)) continue;
      const w = Number(img.getAttribute('width') ?? 0);
      if (w >= 100) return true;
    }
    return false;
  } catch {
    return false;
  }
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
  if (isGonePage(doc)) return 'PRODUCT_GONE';

  const inline = readInlineGlobal(doc, 'rawData');
  if (inline !== undefined && isNeedLogin(inline) && !pddHasGoodsData(inline)) {
    return 'LOGIN_REQUIRED';
  }

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
    if (rawData === undefined) return;
    const draft = draftFromPayload(rawData, ctx, 'ssr');
    if (draft) yield draft;
  },
};

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
      if (!matchesProductId(payload.json, ctx.productId)) {
        ctx.log.debug('抓包数据不是当前商品，丢弃', { productId: ctx.productId });
        continue;
      }
      const draft = draftFromPayload(payload.json, ctx, 'capture');
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

    const picked = collectDomImages(doc, PDD_DOM_RULES);
    const assets: Asset[] = [...picked.main, ...picked.detail, ...picked.sku];
    if (assets.length === 0) return;

    const draft: ProductDraft = { source: 'dom', assets };
    const title = pageTitle(doc);
    if (title !== undefined) draft.title = title;
    yield draft;
  },
};

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
  if (!roots) return null;

  const goods = roots.goods;
  const mall = roots.mall;
  const base = ctx.url.href;
  const draft: ProductDraft = { source };

  const title = readString(goods, PDD_TITLE_PATHS);
  if (title !== undefined) draft.title = title;

  const shopName = readString(mall, PDD_SHOP_PATHS) ?? readString(goods, PDD_SHOP_PATHS);
  if (shopName !== undefined) draft.shopName = shopName;

  const priceFen = readNumber(goods, PDD_PRICE_PATHS);
  if (priceFen !== undefined && Number.isFinite(priceFen)) {
    draft.price = `¥${(priceFen / 100).toFixed(2)}`;
  }

  const assets: Asset[] = [];
  const mainImages = normalizeImageList(readArray(goods, PDD_MAIN_IMAGE_PATHS));
  mainImages.forEach((img, i) => {
    const asset = toPddImageAsset(img, { kind: 'main', index: i, base });
    if (asset) assets.push(asset);
  });

  const mainKeys = new Set(assets.map((a) => a.key));
  const detailImages = normalizeImageList(readArray(goods, PDD_DETAIL_IMAGE_PATHS));
  detailImages.forEach((img, i) => {
    const asset = toPddImageAsset(img, { kind: 'detail', index: i, base });
    // 主图数组和详情图数组偶尔指向同一批图，按 key 去重
    if (asset && !mainKeys.has(asset.key)) assets.push(asset);
  });

  const skuPart = buildSkus(goods, base);
  assets.push(...skuPart.assets);
  assets.push(...buildVideos(goods, base));

  const safeAssets = assets
    .map((asset) => withAllowedCandidates(asset, base))
    .filter((asset): asset is Asset => asset !== null);

  if (safeAssets.length > 0) draft.assets = safeAssets;
  if (skuPart.skus.length > 0) draft.skus = skuPart.skus;
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
function buildVideos(goods: unknown, base: string): Asset[] {
  const raws = normalizeVideoList(readArray(goods, PDD_VIDEO_PATHS));
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
