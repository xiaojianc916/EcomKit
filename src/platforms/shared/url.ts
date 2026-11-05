/**
 * 图片 / 视频地址规范化（平台层共用）。
 *
 * 各平台 CDN 的地址有三种常见脏数据：
 * 1. JSON 里被转义的斜杠 `https:\/\/img.pddpic.com\/...`（服务端转义残留）；
 * 2. 协议相对地址 `//img.pddpic.com/...`；
 * 3. http 明文，扩展只允许 https（下载时混用会被浏览器拦截）。
 */
export interface NormalizeUrlOptions {
  /** 相对地址的基准（一般是 location.href）；为空时相对地址直接丢弃 */
  base?: string;
}

/** 规范化单个地址，不可用时返回 undefined */
export function normalizeUrl(raw: string, opts: NormalizeUrlOptions = {}): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let s = raw.trim();
  if (s === '') return undefined;
  if (s.startsWith('data:') || s.startsWith('blob:') || s.startsWith('javascript:'))
    return undefined;

  s = s.replace(/\\\//g, '/');
  if (s.startsWith('//')) s = `https:${s}`;

  let url: URL;
  try {
    url = opts.base ? new URL(s, opts.base) : new URL(s);
  } catch {
    return undefined;
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') return undefined;
  if (url.hostname === '') return undefined;
  return url.toString();
}

/** 批量规范化并去重（保持顺序） */
export function normalizeUrls(raws: readonly string[], opts: NormalizeUrlOptions = {}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of raws) {
    const u = normalizeUrl(raw, opts);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/** 从任意「地址载体」里取字符串：字符串本身，或者对象里常见的 url 字段 */
export function pickUrlLike(value: unknown, fields: readonly string[]): string | undefined {
  if (typeof value === 'string') {
    const s = value.trim();
    return s === '' ? undefined : s;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  for (const f of fields) {
    const v = rec[f];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}
