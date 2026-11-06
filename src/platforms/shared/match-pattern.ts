/**
 * 按 Chrome match pattern 规范匹配 URL（*://*.host/path*）。
 * 只实现我们需要的子集：scheme 显式、host 支持 * 前缀、path 支持 * 通配。
 */

const PATTERN_RE = /^(\*|https?|wss?|ftp):\/\/([^/]+)(\/.*)$/;

/**
 * 编译结果缓存：pattern → 正则。
 *
 * 原来每次调用都要把 path 重新转义 + `new RegExp` 两遍（带 query 一遍、不带 query 一遍）。
 * 调用点在 registry.findPageKind 里，每次页面导航 × 每个平台 × 每个 pageKind 都会走一遍；
 * pattern 全是 manifest 里的固定字符串，编译一次就够了。
 */
const REGEXP_CACHE = new Map<string, RegExp>();

export function urlMatchesPattern(url: URL, pattern: string): boolean {
  const m = PATTERN_RE.exec(pattern);
  if (!m) return false;
  const [, scheme, host, path] = m as unknown as [string, string, string, string];

  if (scheme !== '*') {
    const urlScheme = url.protocol.replace(':', '');
    if (scheme !== urlScheme) return false;
    if (scheme === 'http' && url.protocol === 'https:') return false;
  }

  if (!hostMatches(url.hostname, host)) return false;

  const re = wildcardRegExp(path);
  return re.test(`${url.pathname}${url.search}`) || re.test(url.pathname);
}

function hostMatches(hostname: string, patternHost: string): boolean {
  if (patternHost === '*') return true;
  const h = hostname.toLowerCase();
  if (patternHost.startsWith('*.')) {
    const base = patternHost.slice(2).toLowerCase();
    return h === base || h.endsWith(`.${base}`);
  }
  return h === patternHost.toLowerCase();
}

function wildcardRegExp(input: string): RegExp {
  const cached = REGEXP_CACHE.get(input);
  if (cached !== undefined) return cached;
  const escaped = input.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp(`^${escaped}$`);
  REGEXP_CACHE.set(input, re);
  return re;
}
