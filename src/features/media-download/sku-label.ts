import type { Sku } from '../../kernel/model/product';

/**
 * SKU 图标签算法（§9.1「SKU 图：序号_规格.ext」、方案原文「沿用 v1 的共同规格值算法」）。
 *
 * 规则：
 * - 多个 SKU 共用同一张图时只下载一次，标签取这组 SKU 的**共同规格值**；
 *   例如「颜色=杏色 + 尺码=S/M/L」只取「杏色」。
 * - 没有共同规格时（例如只有一件商品、或规格值全都不同），用第一个 SKU 的全部规格，
 *   用 `-` 连接。
 *
 * 为什么这样定：商家的诉求是「一眼看出这张图是哪个款」。共同规格能把尺码这种
 * 无关维度自动去掉，得到最短又有区分度的标签；实在没有共同点时退回全量，
 * 宁可长一点也不丢信息。
 */

export interface SkuSpec {
  name: string;
  value: string;
}

/** 一组 SKU 在某个规格维度上是否全部同值；返回共同值，否则 null */
function commonValueOf(skus: readonly Sku[], specName: string): string | null {
  let common: string | null = null;
  for (const sku of skus) {
    const hit = sku.specs.find((s) => s.name === specName);
    if (!hit) return null;
    const value = hit.value.trim();
    if (value === '') return null;
    if (common === null) {
      common = value;
      continue;
    }
    if (common.toLowerCase() !== value.toLowerCase()) return null;
  }
  return common;
}

/** 去重但保留第一次出现的顺序 */
function uniq(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * 一组共用同一张图的 SKU → 一个规格标签。
 *
 * @param skus 这组 SKU；数组顺序就是页面里的顺序，第一个会被当作「第一个 SKU」
 * @returns 规格标签；没有任何规格时返回空串（调用方负责退化成不带标签的文件名）
 */
export function skuLabel(skus: readonly Sku[]): string {
  if (skus.length === 0) return '';
  const first = skus[0];
  if (!first || first.specs.length === 0) return '';

  // 维度顺序以第一个 SKU 为准：商家的填法通常就是「颜色 → 尺码」
  const specNames = uniq(first.specs.map((s) => s.name));
  const common: string[] = [];
  for (const name of specNames) {
    const value = commonValueOf(skus, name);
    if (value !== null) common.push(value);
  }
  if (common.length > 0) return common.join('-');

  // 没有共同规格：用第一个 SKU 的全部规格
  return first.specs
    .map((s) => s.value.trim())
    .filter((v) => v !== '')
    .join('-');
}

/**
 * 商品的全部 SKU 按 imageKey 分组 → Map<imageKey, 标签>。
 * planner 用它给 SKU 素材生成文件名（§9.1）。
 * 没有 imageKey 的 SKU 不参与（它们本来就没有图）。
 */
export function skuLabelsByImageKey(skus: readonly Sku[]): Map<string, string> {
  const groups = new Map<string, Sku[]>();
  for (const sku of skus) {
    if (!sku.imageKey) continue;
    const list = groups.get(sku.imageKey);
    if (list) list.push(sku);
    else groups.set(sku.imageKey, [sku]);
  }
  const out = new Map<string, string>();
  for (const [key, list] of groups) {
    const label = skuLabel(list);
    if (label !== '') out.set(key, label);
  }
  return out;
}
