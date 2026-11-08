import type { ErrorCode } from '../../kernel/errors/codes';
import type { Asset } from '../../kernel/model/asset';
import type { ProductDraft, Sku } from '../../kernel/model/product';
import { parseExpiry } from '../../kernel/net/expiry';
import { isAllowedCdnUrl } from '../shared/cdn';
import { collectDomImages, type DomImageRules } from '../shared/dom-heuristics';
import { assetKeyFromUrl, extractImageUrls } from '../shared/html-images';
import { firstNonEmpty, readArray, readString } from '../shared/read-path';
import { selectVideo, toVideoMeta } from '../shared/video';
import type { DataSource, PlatformResolver, ResolveContext } from '../types';
import dyManifest from './manifest';
import { originalImageCandidates, thumbnailUrl, toDyImageAsset, toVideoCandidates } from './media';
import {
  DY_DETAIL_HTML_PATHS,
  DY_DETAIL_IMAGE_PATHS,
  DY_MAIN_IMAGE_PATHS,
  DY_PRICE_PATHS,
  DY_SHOP_PATHS,
  DY_SKU_PATHS,
  DY_TITLE_PATHS,
  DY_VIDEO_PATHS,
  findDyRoot,
  formatDyPrice,
  isDyErrorPayload,
  normalizeSkuLike,
  normalizeVideoList,
  pickImageList,
  pickProductId,
} from './schema';

/**
 * 抖音商城页面识别与数据解析（只在 ISOLATED world 运行，方案 §7.1）。
 *
 * 优先级：capture（主）→ SSR（次）→ DOM（兜底）。
 * 主源是抓包：页面接口带签名，我们只能旁听页面自己的请求（ADR-7）。
 *
 * Phase 0 实测（docs/phase0/FINDINGS.md §1）：任何 UA 下页面都只给扫码页，
 * 拿不到商品数据，所以 detectBlocker 把 APP_ONLY 当作**必然**而非偶发。
 */

const CAPTURE_RULES = dyManifest.capture.map((r) => r.id);
const CDN_HOSTS = dyManifest.cdnHosts;

/** DOM 兜底规则（待验证：登录态下的真实类名） */
export const DY_DOM_RULES: DomImageRules = {
  main: {
    containers: [
      '[class*="swiper"] [class*="img"]',
      '[class*="gallery"] [class*="img"]',
      '[class*="carousel"] [class*="img"]',
      '[class*="banner"] [class*="img"]',
    ],
    visibleOnly: true,
    limit: 20,
  },
  detail: {
    containers: ['[class*="detail"] [class*="img"]', '[class*="desc"] [class*="img"]'],
    limit: 120,
  },
  sku: {
    containers: ['[class*="sku"] [class*="img"]', '[class*="spec"] [class*="img"]'],
    limit: 60,
  },
  exclude: ['[class*="recommend"]', '[class*="similar"]', '[class*="comment"]'],
};

/* ------------------------------------------------------------------ *
 * 阻断判定（方案 §7.6、docs/phase0/FINDINGS.md §1）
 * ------------------------------------------------------------------ */

/** APP_ONLY 文案（Phase 0 实测原文） */
const APP_ONLY_TEXTS = [
  '请使用抖音APP扫码',
  '请使用抖音app扫码',
  '检测到当前环境存在安全风险',
  '点此进入抖音查看商品信息',
  '进入抖音查看商品详情',
  '请进入抖音查看',
];

const GONE_TEXTS = ['商品已下架', '该商品已下架', '商品不存在', '商品已失效', '已结束'];

function safeBodyText(doc: Document): string {
  try {
    return (doc.body?.textContent ?? '').slice(0, 8000);
  } catch {
    return '';
  }
}

/** 页面上是否已经有商品图（排除二维码） */
function hasProductImages(doc: Document): boolean {
  try {
    for (const img of doc.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? img.getAttribute('data-src') ?? '';
      if (src.startsWith('data:')) continue;
      if (!/^https?:\/\//.test(src)) continue;
      if (src.includes('qrcode') || src.includes('qr_code')) continue;
      const w = Number(img.getAttribute('width') ?? img.naturalWidth ?? 0);
      if (w >= 100) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 扫码页结构：Phase 0 抓到的真实结构是 .detail-abnormal + .na-rq-code */
function hasQrCode(doc: Document): boolean {
  try {
    return (
      doc.querySelector('.na-rq-code, .detail-abnormal .err-reason-text, [class*="qr-code"]') !==
      null
    );
  } catch {
    return false;
  }
}

/**
 * 同步阻断判定（PlatformResolver.detectBlocker 的实现）。
 *
 * Phase 0 实测（FINDINGS §1）：任何 UA 下页面都只给扫码页，所以 APP_ONLY 是**主路径**。
 * 两个信号都检查，不只看文案：
 * ① 页面文案命中「请使用抖音APP扫码」/「检测到当前环境存在安全风险」等，且没有商品图；
 * ② 出现二维码结构（Phase 0 抓到的 `.detail-abnormal` + `.na-rq-code`），且没有商品图。
 * 另外「商品已下架」文案 → PRODUCT_GONE。
 *
 * 有商品图时一律不判 APP_ONLY：用户自己登录后浏览器里页面能正常加载，
 * 这时页面底部偶尔还会残留扫码提示，不能误伤。
 */
export function detectDyBlocker(doc: Document, _url: URL): ErrorCode | null {
  const text = safeBodyText(doc);
  const hasImages = hasProductImages(doc);

  if (hasImages) {
    return GONE_TEXTS.some((t) => text.includes(t)) ? 'PRODUCT_GONE' : null;
  }

  if (APP_ONLY_TEXTS.some((t) => text.includes(t))) return 'APP_ONLY';
  if (hasQrCode(doc)) return 'APP_ONLY';
  if (GONE_TEXTS.some((t) => text.includes(t))) return 'PRODUCT_GONE';
  return null;
}

/**
 * 异步阻断判定：拿到 SSR 全局变量之后再用一次。
 * 抖音目前没有 SSR 全局变量（Phase 0 实测），这里保留是为了平台日后改成 SSR 时不用改架构。
 */
export async function detectDyBlockerAsync(
  ctx: Pick<ResolveContext, 'url' | 'document' | 'readGlobal'>,
): Promise<ErrorCode | null> {
  const sync = detectDyBlocker(ctx.document, ctx.url);
  if (sync !== null) return sync;

  for (const name of ['__INITIAL_STATE__', '_ROUTER_DATA', '__SSR_DATA__']) {
    let value: unknown;
    try {
      value = await ctx.readGlobal(name);
    } catch {
      continue;
    }
    if (value === undefined || value === null) continue;
    if (findDyRoot(value) !== null) return null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 数据源
 * ------------------------------------------------------------------ */

/**
 * 抓包数据源（主）：每命中一条带商品数据的响应就产出一份 draft。
 * 两条规则（promotion/pack/h5 与 ecom/product/detail）都听，谁是完整数据就用谁。
 */
export const captureSource: DataSource = {
  id: 'capture',
  async *run(ctx: ResolveContext): AsyncIterable<ProductDraft> {
    // 两条规则同时旁听（串行会漏掉另一条规则先到的数据），合并交给 shared/merge.ts
    const streams = CAPTURE_RULES.map((ruleId) => tagStream(ruleId, ctx.captures(ruleId)));
    for await (const { ruleId, payload } of mergeStreams(streams)) {
      if (ctx.signal.aborted) return;
      if (payload.json === null || typeof payload.json !== 'object') continue;
      if (isDyErrorPayload(payload.json)) {
        ctx.log.debug('抖音接口返回失败，跳过', { ruleId });
        continue;
      }
      if (!matchesProductId(payload.json, ctx.productId)) continue;
      const draft = draftFromPayload(payload.json, ctx, 'capture');
      if (draft) yield draft;
    }
  },
};

/** 给每条规则的抓包数据打上规则 id，便于日志和排查 */
async function* tagStream<T>(ruleId: string, src: AsyncIterable<T>): AsyncIterable<Tagged<T>> {
  for await (const payload of src) {
    yield { ruleId, payload };
  }
}

interface Tagged<T> {
  ruleId: string;
  payload: T;
}

/**
 * 合并多条 AsyncIterable：谁先到谁先产出。
 * 任何一条抛错只结束它自己，不影响其他流（旁听失败不应拖垮整个解析）。
 */
async function* mergeStreams<T>(streams: AsyncIterable<T>[]): AsyncIterable<T> {
  const queue: T[] = [];
  /** 已消费到的下标；用游标而不是 queue.shift()，后者每次都要把整个数组前移一位 */
  let head = 0;
  let waiting: (() => void) | null = null;
  let pending = streams.length;

  const push = (item: T): void => {
    queue.push(item);
    waiting?.();
  };
  const finish = (): void => {
    pending -= 1;
    waiting?.();
  };

  for (const stream of streams) {
    void (async () => {
      try {
        for await (const item of stream) push(item);
      } catch {
        // 单条流失败不影响其他流
      } finally {
        finish();
      }
    })();
  }

  while (pending > 0 || head < queue.length) {
    if (head < queue.length) {
      const next = queue[head] as T;
      head += 1;
      // 队列被消费光时把数组还回去，避免长连接会话里无限增长
      if (head >= 64 && head * 2 >= queue.length) {
        queue.splice(0, head);
        head = 0;
      }
      yield next;
      continue;
    }
    if (pending === 0) break;
    await new Promise<void>((resolve) => {
      waiting = resolve;
    });
    waiting = null;
  }
}

/** SSR 数据源（次）：抖音目前没有 SSR 全局变量，保留是为了平台改版时不用动架构 */
export const ssrSource: DataSource = {
  id: 'ssr',
  async *run(ctx: ResolveContext): AsyncIterable<ProductDraft> {
    // 下面的候选按优先级排列，必须**顺序**尝试：同一来源产出的 draft 先到先得
    // （合并器对同优先级是「先到者定标题」），调用方也可能拿到第一份就收尾。
    // 候选推进本身要等 I/O（经 bridge 读全局变量），所以用 for await 逐个推进。
    for await (const name of [
      '__INITIAL_STATE__',
      '_ROUTER_DATA',
      '__SSR_DATA__',
      '__INITIAL_SSR_STATE__',
    ]) {
      if (ctx.signal.aborted) return;
      let value: unknown;
      try {
        value = await ctx.readGlobal(name);
      } catch {
        continue;
      }
      if (value === undefined || value === null) continue;
      const draft = draftFromPayload(value, ctx, 'ssr');
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

    // 让出一个宏任务：SSR 源的 await 链在这一拍内落地，hasStructured() 才有意义
    const yieldTurn = Promise.withResolvers<void>();
    setTimeout(yieldTurn.resolve, 0);
    await yieldTurn.promise;
    if (ctx.signal.aborted) return;

    const picked = collectDomImages(doc, DY_DOM_RULES);
    const assets: Asset[] = [...picked.main, ...picked.detail, ...picked.sku].filter(
      // 结构化来源已覆盖的类别，合并器会整类丢弃 DOM 结果（§7.3「DOM 只补空」）
      (asset) => !(ctx.hasStructured?.(asset.kind) ?? false),
    );
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
  if (raw === '') return undefined;
  const cleaned = raw.replace(/[\s\-|_—]+(抖音电商|抖音商城|抖音).*$/, '').trim();
  return cleaned === '' ? undefined : cleaned;
}

/** 抓包内容是不是当前商品：有 ID 就比，没有 ID 就放过 */
function matchesProductId(json: unknown, productId: string): boolean {
  const root = findDyRoot(json);
  if (root === null) return true;
  const id = pickProductId(root);
  return id === undefined || id === productId;
}

/* ------------------------------------------------------------------ *
 * 数据 → draft
 * ------------------------------------------------------------------ */

/** 把任意一份抖音数据（抓包 / SSR）转成 ProductDraft */
export function draftFromPayload(
  payload: unknown,
  ctx: Pick<ResolveContext, 'url' | 'document'>,
  source: ProductDraft['source'],
): ProductDraft | null {
  const root = findDyRoot(payload);
  if (root === null) return null;

  const base = ctx.url.href;
  const draft: ProductDraft = { source };

  const title = readString(root, DY_TITLE_PATHS);
  if (title !== undefined) draft.title = title;

  const shopName = readString(root, DY_SHOP_PATHS);
  if (shopName !== undefined) draft.shopName = shopName;

  const price = formatDyPrice(firstNonEmpty(root, DY_PRICE_PATHS));
  if (price !== undefined) draft.price = price;

  const assets: Asset[] = [];
  const mainImages = pickImageList(readArray(root, DY_MAIN_IMAGE_PATHS));
  mainImages.forEach((img, i) => {
    const asset = toDyImageAsset(img, { kind: 'main', index: i, base });
    if (asset) assets.push(asset);
  });

  assets.push(...buildDetailAssets(root, base));

  const skuPart = buildSkus(root, base);
  assets.push(...skuPart.assets);
  assets.push(...buildVideos(root, base));

  const safeAssets = assets
    .map((asset) => withAllowedCandidates(asset))
    .filter((asset): asset is Asset => asset !== null);

  if (safeAssets.length > 0) draft.assets = safeAssets;
  if (skuPart.skus.length > 0) draft.skus = skuPart.skus;
  return draft;
}

/**
 * 详情图：优先富文本 HTML（§7.6.1），没有再退回结构化数组。
 * 富文本里解析出的地址同样要过一遍原图规则，所以不直接用 htmlToDetailAssets() 的成品。
 */
function buildDetailAssets(root: unknown, base: string): Asset[] {
  const html = firstNonEmpty(root, DY_DETAIL_HTML_PATHS);
  if (typeof html === 'string' && html.includes('<')) {
    const urls = extractImageUrls(html, { base });
    const fromHtml: Asset[] = [];
    urls.forEach((url, i) => {
      const asset = toDyImageAsset({ url }, { kind: 'detail', index: i, base });
      if (asset) fromHtml.push(asset);
    });
    if (fromHtml.length > 0) return fromHtml;
  }

  const images = pickImageList(readArray(root, DY_DETAIL_IMAGE_PATHS));
  const out: Asset[] = [];
  images.forEach((img, i) => {
    const asset = toDyImageAsset(img, { kind: 'detail', index: i, base });
    if (asset) out.push(asset);
  });
  return out;
}

function buildSkus(root: unknown, base: string): { assets: Asset[]; skus: Sku[] } {
  const raws = readArray(root, DY_SKU_PATHS);
  const assets: Asset[] = [];
  const skus: Sku[] = [];
  const keyByUrl = new Map<string, string>();

  raws.forEach((raw, i) => {
    const sku = normalizeSkuLike(raw, i);
    if (!sku) return;

    let imageKey: string | undefined;
    if (sku.imageUrl !== undefined) {
      const candidates = dedupeAllowed(originalImageCandidates(sku.imageUrl, base));
      const first = candidates[0];
      if (first !== undefined) {
        const existing = keyByUrl.get(first);
        if (existing !== undefined) {
          imageKey = existing;
        } else {
          const label = sku.specs.map((s) => s.value).join('-');
          const preview = thumbnailUrl(sku.imageUrl, base);
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
 * 视频（§7.6.3，Windows 关键点）：
 * 只考虑 mp4 直链 → 优先 H.264 → 同编码选分辨率最高 → 再选码率最高。
 * 只有 H.265 时照常下载，UI 依据 video.codec === 'h265' 在视频行显示「H.265」。
 */
function buildVideos(root: unknown, base: string): Asset[] {
  // 抖音的 video 字段既可能是单个对象（主图视频），也可能是数组（主图视频 + 讲解视频）
  const rawVideo = firstNonEmpty(root, DY_VIDEO_PATHS);
  const videoValues = Array.isArray(rawVideo) ? rawVideo : rawVideo === undefined ? [] : [rawVideo];
  const raws = normalizeVideoList(videoValues);
  if (raws.length === 0) return [];

  const out: Asset[] = [];
  for (const raw of raws) {
    const candidates = toVideoCandidates(raw, base)
      .map((c) => ({ ...c, url: dedupeAllowed([c.url])[0] }))
      .filter((c): c is typeof c & { url: string } => c.url !== undefined);

    const picked = selectVideo(candidates);
    if (!picked) continue;

    const expiresAt = parseExpiry(picked.url);
    const cover = picked.cover === undefined ? undefined : dedupeAllowed([picked.cover])[0];
    // kernel 的 parseExpiry 没有过期参数时返回 null，toVideoMeta 会过滤掉
    const meta = toVideoMeta(picked, { expiresAt });
    if (cover !== undefined) meta.cover = cover;

    const label = picked.label ?? (out.length === 0 ? '主图视频' : undefined);
    out.push({
      key: `video-${assetKeyFromUrl(picked.url)}`,
      kind: 'video',
      index: out.length,
      candidates: [picked.url],
      ...(label !== undefined ? { label } : {}),
      video: meta,
    });
  }
  return out;
}

/**
 * 候选地址过 CDN 白名单；缩略图也必须是白名单内的地址。
 *
 * 入参到这里时已由 normalizeUrl 规范化过（各 to*Asset / buildVideos 都走它），
 * 再让 allowedUrls 跑一遍 normalizeUrl 是纯重复解析（单条候选的视频行尤其明显）。
 */
function withAllowedCandidates(asset: Asset): Asset | null {
  const candidates = dedupeAllowed(asset.candidates);
  const first = candidates[0];
  if (first === undefined) return null;

  const out: Asset = {
    ...asset,
    key: asset.key === '' ? assetKeyFromUrl(first) : asset.key,
    candidates,
  };
  // 视频的 preview 不能回退到候选地址：那是 mp4 直链，`<img>` 必然加载失败，
  // 面板上视频行就永远是灰色空块。视频能当缩略图的只有平台给的封面（§10.3）。
  const previewSource = asset.preview ?? (asset.kind === 'video' ? asset.video?.cover : first);
  const preview = previewSource === undefined ? undefined : dedupeAllowed([previewSource])[0];
  if (preview !== undefined) out.preview = preview;
  else delete out.preview;
  return out;
}

/** 白名单过滤 + 去重（保持顺序）；入参必是已规范化的绝对 https 地址 */
function dedupeAllowed(raws: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of raws) {
    if (seen.has(raw)) continue;
    if (!isAllowedCdnUrl(raw, CDN_HOSTS)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

export const douyinResolver: PlatformResolver = {
  detectBlocker: detectDyBlocker,
  sources: [captureSource, ssrSource, domSource],
};

export default douyinResolver;
