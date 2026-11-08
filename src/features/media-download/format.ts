/**
 * 数字和体积的显示格式。
 *
 * 为什么单独抽出来：§10.7 要求「数字精确」——「缺 3 个文件」而不是「部分文件缺失」，
 * 主按钮、附加说明、失败列表要用同一套写法，避免各处自己 toFixed。
 * 所有函数都是纯函数，不读系统时间，单测不用打桩。
 */

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

/** 一位小数，且整数时不带 .0（12 → "12"，12.4 → "12.4"） */
function oneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 体积：4.1 MB / 12.4 MB / 512 KB（§10.4 进度和完成说明） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < KB) return `${Math.round(bytes)} B`;
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  if (bytes < GB) return `${oneDecimal(bytes / MB)} MB`;
  return `${oneDecimal(bytes / GB)} GB`;
}

/** 计数：23/48（§10.4 进度、§10.3 挑选模式 3/26） */
export function formatCount(done: number, total: number): string {
  return `${done}/${total}`;
}
