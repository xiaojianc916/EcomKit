import type { AssetKind } from '../../../kernel/model/asset';
import type { ProductSnapshot } from '../../../kernel/model/product';

/**
 * 面板用到的纯换算（不碰 React，也不碰 store）。
 *
 * 为什么单独一个文件：这些函数既被面板的计划计算用，也被 mediaQuickActions 和单测用；
 * 留在 page.tsx 里会和 §10.9 的订阅/副作用逻辑混在一起，改一处要先读完一屏别的东西。
 * 它们都是纯函数，放这里之后 page.tsx 只剩「组装」。
 */

/**
 * ⑤ 保存位置的相对路径预览。用 planner 算，保证预览的名字和真正落盘的名字一致
 * （模板渲染、截断、清洗都由同一处决定）。
 */
export function previewFolderPath(plan: { folder: string[] }): string {
  // 用反斜杠拼接：Windows 资源管理器地址栏里就是这个形状（§10.5 复制路径）
  return plan.folder.join('\\');
}

/** 各类别素材数（主按钮和素材行都要用） */
export function countByKind(snapshot: ProductSnapshot): Record<AssetKind, number> {
  const out: Record<AssetKind, number> = { main: 0, sku: 0, detail: 0, video: 0 };
  for (const asset of snapshot.assets) out[asset.kind] += 1;
  return out;
}

/** SKU 图的规格标签：asset.key → 文字（§10.3 SKU 格子下方） */
export function skuLabelMap(snapshot: ProductSnapshot): Map<string, string> {
  const map = new Map<string, string>();
  for (const sku of snapshot.skus) {
    if (sku.imageKey === undefined || sku.specs.length === 0) continue;
    // 同一张图可能被多个 SKU 共用，标签取第一个出现的即可（精确的共同规格值
    // 算法在 sku-label.ts，那个在 engine 侧生成文件名时用）
    if (!map.has(sku.imageKey)) {
      map.set(sku.imageKey, sku.specs.map((s) => s.value).join('-'));
    }
  }
  return map;
}

/**
 * 当天 0 点的时间戳（本地时区）。
 *
 * planner 的 `{date}` 变量只精确到天，但计划里还带着 `now`。完成态那 3 秒里
 * `now` 每 250ms 变一次，直接把它当依赖会让整份计划（含几百条 WorkItem）
 * 每 250ms 重算一遍。换成「天」这个量级后，同一天内这个数字不变，
 * useMemo 的依赖比较（Object.is）就稳住了。
 */
export function localDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 提交失败时给用户看的一句话（不显示异常 message，§6.2） */
export function describeSubmitError(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'INTERNAL') return '提交下载失败：任务参数不完整，请刷新页面后重试';
  if (code === 'DIR_UNSET' || code === 'DIR_NEEDS_GRANT' || code === 'DIR_GONE') {
    return '需要先选择保存位置';
  }
  return '提交下载失败，请重试';
}
