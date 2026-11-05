/**
 * 平台字段「多候选路径」读取器。
 *
 * 方案 §7.5、§7.6 的字段表都标着「待验证」：平台改版时最常见的变化就是字段改名或换层级。
 * 所以平台层所有字段都写成**候选路径数组**，取第一个命中非空值的，配合宽松 Zod 兜底。
 * 路径语法：`a.b[0].c`，数组只支持数字下标。
 */

/** 空值：null / undefined / 空白串 / NaN / 空数组。0 和 false 不算空 */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'number') return Number.isNaN(v);
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function readSegment(cur: unknown, segment: string): unknown {
  const m = /^([^[\]]+)((?:\[\d+\])*)$/.exec(segment);
  if (!m) return undefined;
  const key = m[1];
  const idxSrc = m[2] ?? '';
  if (key === undefined) return undefined;

  let v: unknown = key === '*' ? cur : readKey(cur, key);
  if (v === undefined) return undefined;

  const idxs = idxSrc.match(/\d+/g) ?? [];
  for (const raw of idxs) {
    const i = Number(raw);
    if (!Array.isArray(v)) return undefined;
    v = v[i];
    if (v === undefined) return undefined;
  }
  return v;
}

function readKey(cur: unknown, key: string): unknown {
  if (cur === null || typeof cur !== 'object') return undefined;
  return (cur as Record<string, unknown>)[key];
}

/** 读取单个路径，路径不存在时返回 undefined */
export function readPath(root: unknown, path: string): unknown {
  if (root === null || root === undefined) return undefined;
  let cur: unknown = root;
  for (const segment of path.split('.')) {
    cur = readSegment(cur, segment);
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** 按顺序尝试候选路径，返回第一个非空值 */
export function firstNonEmpty(root: unknown, paths: readonly string[]): unknown {
  for (const p of paths) {
    const v = readPath(root, p);
    if (!isEmptyValue(v)) return v;
  }
  return undefined;
}

/** 多候选路径取第一个非空字符串；数字会转成字符串（平台有时用数字传 ID） */
export function readString(root: unknown, paths: readonly string[]): string | undefined {
  const v = firstNonEmpty(root, paths);
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' ? undefined : s;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** 多候选路径取第一个非空数字；数字字符串也会被接受 */
export function readNumber(root: unknown, paths: readonly string[]): number | undefined {
  const v = firstNonEmpty(root, paths);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 多候选路径取第一个非空数组 */
export function readArray(root: unknown, paths: readonly string[]): unknown[] {
  const v = firstNonEmpty(root, paths);
  return Array.isArray(v) ? v : [];
}

/** 数组里每个元素取候选路径，过滤掉空值 */
export function readStrings(root: unknown, paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const v = readPath(root, p);
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string' && item.trim() !== '') out.push(item.trim());
        else if (typeof item === 'number') out.push(String(item));
      }
    } else if (typeof v === 'string' && v.trim() !== '') {
      out.push(v.trim());
    }
    if (out.length > 0) return out;
  }
  return out;
}
