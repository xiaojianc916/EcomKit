/**
 * 视频链接过期参数解析（方案 §9.7「403 重试前先检查链接是否过期」、§6.2 URL_EXPIRED）。
 *
 * 抖音等平台的 CDN 直链带签名和过期时间，过期后返回 403。与其重试三次白白浪费 30 秒，
 * 不如先看 URL 里的时间戳，过期的直接报 URL_EXPIRED 让用户刷新页面。
 *
 * 参数名各家不统一，所以这里按「多候选」处理：任何名字命中就采用。
 */

/** 常见的过期参数名，命中任意一个即可 */
export const EXPIRY_PARAMS: readonly string[] = [
  'x-expires',
  'expires',
  'Expires',
  'e',
  'x-expiration',
  'timestamp',
];

/** 可信时间戳的下限：2001-09-09。低于它的值基本是别的东西（比如序号），直接忽略 */
const MIN_VALID_MS = 1_000_000_000_000;
/** 秒级时间戳：小于这个数说明单位是秒 */
const SECONDS_CUTOFF = 1_000_000_000_000;

const HEX_PREFIX_RE = /^0x[0-9a-f]+$/i;
const DECIMAL_RE = /^\d+$/;
const BARE_HEX_RE = /^[0-9a-f]{8,12}$/i;
const HAS_HEX_LETTER_RE = /[a-f]/i;
/** 去掉首尾的单个引号（部分 CDN 会把时间戳包在引号里：e="1793000000000"） */
function stripQuotes(raw: string): string {
  let text = raw.trim();
  const head = text.charAt(0);
  if (head === '"' || head === "'") text = text.slice(1);
  const tail = text.charAt(text.length - 1);
  if (tail === '"' || tail === "'") text = text.slice(0, -1);
  return text;
}

function normalizeTimestamp(raw: string): number | null {
  const text = stripQuotes(raw);
  if (text === '') return null;

  // 十六进制形式（部分 CDN 用 8~12 位 hex），必须以 0x 开头或明显含 a-f
  let value: number;
  if (HEX_PREFIX_RE.test(text)) {
    value = Number.parseInt(text.slice(2), 16);
  } else if (DECIMAL_RE.test(text)) {
    value = Number(text);
  } else if (BARE_HEX_RE.test(text) && HAS_HEX_LETTER_RE.test(text)) {
    value = Number.parseInt(text, 16);
  } else {
    return null;
  }

  if (!Number.isFinite(value) || value <= 0) return null;
  // 秒 → 毫秒（抖音的 e= 有时是秒）
  const ms = value < SECONDS_CUTOFF ? value * 1000 : value;
  return ms >= MIN_VALID_MS ? ms : null;
}

/** 在一组查询参数里按候选名字找过期时间 */
function scan(params: URLSearchParams): number | null {
  for (let i = 0; i < EXPIRY_PARAMS.length; i += 1) {
    const name = EXPIRY_PARAMS[i];
    if (name === undefined) continue;
    const raw = params.get(name);
    if (raw === null) continue;
    const ts = normalizeTimestamp(raw);
    if (ts !== null) return ts;
  }
  return null;
}

/**
 * 从 URL 里解析出过期时间（毫秒时间戳）；没有过期参数时返回 null。
 * 查询参数和 hash 里的参数都看，因为有的播放页把签名塞在 # 后面。
 */
export function parseExpiry(url: string | URL): number | null {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return null;
  }

  const found = scan(parsed.searchParams);
  if (found !== null) return found;

  const hash = parsed.hash;
  // 有的播放页把签名塞在 # 后面；没有 '=' 就不是查询串，直接跳过
  if (hash.includes('=')) {
    return scan(new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash));
  }
  return null;
}

/** 解析出过期时间，并返回距离过期还有多久（毫秒）；没有过期参数返回 null */
export function expiryRemaining(url: string | URL, now = Date.now()): number | null {
  const at = parseExpiry(url);
  return at === null ? null : at - now;
}

/**
 * 链接是否已过期（或者即将过期）。默认留 60 秒余量：
 * 视频几百 MB 要下好几分钟，剩下几秒的链接等于必然会失败。
 */
export function isExpired(url: string | URL, skewMs = 60_000, now = Date.now()): boolean {
  const at = parseExpiry(url);
  if (at === null) return false;
  return at - skewMs <= now;
}

/** 给日志和诊断包用的简短描述，不含完整签名参数（§6.7 不出账号和敏感参数） */
export function describeExpiry(url: string | URL, now = Date.now()): string {
  const at = parseExpiry(url);
  if (at === null) return '无过期参数';
  const remain = Math.round((at - now) / 1000);
  return remain >= 0 ? `还剩 ${remain} 秒过期` : `已过期 ${-remain} 秒`;
}
