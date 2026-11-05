import { nameKey } from './sanitize';

/**
 * 同目录重名处理（方案 §9.2「大小写不敏感」、§9.11「没有记录但存在同名文件」）。
 *
 * 追加「 (2)」「 (3)」而不是随机后缀：用户要能在资源管理器里一眼看出
 * 这是同一个商品的第二份文件，而不是一堆看不懂的哈希。
 */

/** 拆成主体和扩展名。以点开头的隐藏文件（.ecbox.json）整体当主体，不加序号到点前面 */
export function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * 在已有的名字集合里给 desired 找一个不冲突的名字。
 * 比较一律走 nameKey（小写），因为 Windows 和 FSA 都大小写不敏感。
 */
export function uniqueName(desired: string, existing: Iterable<string>): string {
  const taken = new Set<string>();
  for (const name of existing) taken.add(nameKey(name));
  if (!taken.has(nameKey(desired))) return desired;

  const { stem, ext } = splitExt(desired);
  for (let n = 2; n < 100000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
  // 理论上到不了这里；真到了就退回时间戳，至少保证返回值不重名
  return `${stem} (${Date.now()})${ext}`;
}

/** 文件名重名：序号插在扩展名之前，得到「01 (2).jpg」而不是「01.jpg (2)」 */
export function uniqueFileName(stem: string, ext: string, existing: Iterable<string>): string {
  const suffix = ext === '' ? '' : ext.startsWith('.') ? ext : `.${ext}`;
  return uniqueName(`${stem}${suffix}`, existing);
}
