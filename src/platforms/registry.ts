import buildManifest from '../generated/build-manifest.json';
import type { PlatformId } from '../kernel/model/product';
import { urlMatchesPattern } from './shared/match-pattern';
import type { PlatformManifest } from './types';

export const PLATFORM_MANIFESTS: PlatformManifest[] = (buildManifest.platforms ??
  []) as unknown as PlatformManifest[];

export const PLATFORM_MANIFEST_MAP: Record<string, PlatformManifest> = Object.fromEntries(
  PLATFORM_MANIFESTS.map((m) => [m.id, m]),
);

export function getPlatformManifest(id: PlatformId | string): PlatformManifest {
  const m = PLATFORM_MANIFEST_MAP[id];
  if (!m) throw new Error(`unknown platform: ${id}`);
  return m;
}

/** 内容脚本注入范围（wxt.config.ts 的 matches） */
export const PLATFORM_MATCHES: string[] = [
  ...new Set(PLATFORM_MANIFESTS.flatMap((m) => m.pageKinds.flatMap((p) => p.matches))),
];

/** 跨域下载白名单，同时写进 host_permissions */
export const CDN_HOSTS: string[] = [
  ...new Set(PLATFORM_MANIFESTS.flatMap((m) => m.cdnHosts.map((h) => `https://${h}/`))),
];

export const CAPTURE_RULES = PLATFORM_MANIFESTS.flatMap((m) =>
  m.capture.map((r) => ({ ...r, platformId: m.id })),
);

export const PLATFORM_IDS: string[] = PLATFORM_MANIFESTS.map((m) => m.id);

export interface PageMatch {
  platform: PlatformManifest;
  kind: string;
  productId: string;
}

/**
 * pathPattern 编译缓存：manifest 里的正则源码是常量，
 * 原来每次导航都要对每个 pageKind 重新 `new RegExp` 一次。
 */
const PATH_PATTERN_CACHE = new Map<string, RegExp>();

function pathPatternRegExp(source: string): RegExp {
  const cached = PATH_PATTERN_CACHE.get(source);
  if (cached !== undefined) return cached;
  const re = new RegExp(source);
  PATH_PATTERN_CACHE.set(source, re);
  return re;
}

/** 商品 ID 必须是纯数字（§7.5、§7.6），避免把 `abc` 当商品 ID 建目录 */
const PRODUCT_ID_RE = /^\d{5,25}$/;

/** URL → 平台 / 页面类型 / 商品 ID。PageController 的唯一判定入口（§7.2） */
export function findPageKind(url: URL): PageMatch | null {
  for (const m of PLATFORM_MANIFESTS) {
    for (const pk of m.pageKinds) {
      const raw = url.searchParams.get(pk.productIdParam);
      if (!raw || !PRODUCT_ID_RE.test(raw)) continue;
      if (!pk.matches.some((p) => urlMatchesPattern(url, p))) continue;
      if (pk.pathPattern && !pathPatternRegExp(pk.pathPattern).test(url.pathname)) continue;
      return { platform: m, kind: pk.kind, productId: raw };
    }
  }
  return null;
}

/**
 * 白名单主机名展开一次（去掉 `*.` 前缀、小写）。
 *
 * 原来 isAllowedCdnUrl 每次调用都要对每个平台 × 每个 cdnHost 现场做一遍
 * replace + toLowerCase；DOM 兜底对一个页面的每张 <img> 都调用一次，
 * 一个瀑布流页面就是上千次重复字符串处理。manifest 是构建期常量，展开一次即可。
 */
const CDN_HOST_BASES: readonly string[] = [
  ...new Set(
    PLATFORM_MANIFESTS.flatMap((m) => m.cdnHosts.map((h) => h.replace(/^\*\./, '').toLowerCase())),
  ),
];

/** 伪造抓包数据的最后一道闸：下载地址必须在白名单 CDN 上（§13.4） */
export function isAllowedCdnUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return hostAllowed(parsed.hostname);
}

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  for (const base of CDN_HOST_BASES) {
    if (host === base || host.endsWith(`.${base}`)) return true;
  }
  return false;
}

/** 规范化商品链接：只保留商品 ID 参数（写进 .ecbox.json 和 商品信息.txt） */
export function normalizeProductUrl(url: URL): string {
  const hit = findPageKind(url);
  if (!hit) return url.origin + url.pathname;
  const pk = hit.platform.pageKinds.find((p) => p.kind === hit.kind);
  const out = new URL(url.origin + url.pathname);
  out.searchParams.set(pk?.productIdParam ?? 'id', hit.productId);
  return out.toString();
}
