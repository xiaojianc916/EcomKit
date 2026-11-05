/**
 * 按 Chrome match pattern 规范匹配 URL（*://*.host/path*）。
 * 只实现我们需要的子集：scheme 显式、host 支持 * 前缀、path 支持 * 通配。
 */
export function urlMatchesPattern(url: URL, pattern: string): boolean {
  const m = /^(\*|https?|wss?|ftp):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, scheme, host, path] = m as unknown as [string, string, string, string];

  if (scheme !== '*') {
    const urlScheme = url.protocol.replace(':', '');
    if (scheme !== urlScheme) return false;
    if (scheme === 'http' && url.protocol === 'https:') return false;
  }

  if (!hostMatches(url.hostname, host)) return false;

  const pathAndQuery = `${url.pathname}${url.search}`;
  return wildcardToRegExp(path).test(pathAndQuery) || wildcardToRegExp(path).test(url.pathname);
}

function hostMatches(hostname: string, patternHost: string): boolean {
  if (patternHost === '*') return true;
  if (patternHost.startsWith('*.')) {
    const base = patternHost.slice(2).toLowerCase();
    const h = hostname.toLowerCase();
    return h === base || h.endsWith(`.${base}`);
  }
  return hostname.toLowerCase() === patternHost.toLowerCase();
}

function wildcardToRegExp(input: string): RegExp {
  const escaped = input.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}
