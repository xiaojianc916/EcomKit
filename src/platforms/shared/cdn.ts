import { normalizeUrl } from './url';

/**
 * 候选地址的最后一道闸（方案 §13.4、§7.4）。
 *
 * 抓包数据理论上可以被页面脚本伪造，所以任何要写进 ProductSnapshot 的地址
 * 都必须落在平台的 cdnHosts 白名单里，否则直接丢弃。
 * 实现与 platforms/registry.ts 的 isAllowedCdnUrl() 同语义，但允许调用方传入自己的
 * 主机清单——平台目录不能反向依赖 registry（会形成循环，也会把别的平台拖进来）。
 */

/** 把 manifest 里的 '*.pddpic.com' 形式展开成可比较的主机名 */
export function hostMatchesPattern(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const base = pattern.trim().toLowerCase().replace(/^\*\./, '');
  if (base === '') return false;
  return host === base || host.endsWith(`.${base}`);
}

/** 地址是否在给定的 CDN 白名单内（只看主机名，协议必须是 http(s)） */
export function isAllowedCdnUrl(rawUrl: string, cdnHosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return cdnHosts.some((p) => hostMatchesPattern(parsed.hostname, p));
}

/** 规范化 + 白名单过滤 + 去重（保持顺序）；平台层所有候选地址都走这里 */
export function allowedUrls(
  raws: readonly string[],
  cdnHosts: readonly string[],
  base?: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of raws) {
    const url = normalizeUrl(raw, base === undefined ? {} : { base });
    if (!url || seen.has(url)) continue;
    if (!isAllowedCdnUrl(url, cdnHosts)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
