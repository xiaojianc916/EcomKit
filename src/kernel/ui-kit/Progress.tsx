/**
 * 细进度条（§10.1「进度用细进度条加精确数字 23/48」、§10.6 动效）。
 *
 * 只有 2px 高、强调色，永远配着文字数字出现 —— 单独一条没有数字的进度条
 * 用户没法判断还剩多少。所以这里只管画条，数字由调用方放在旁边。
 */
export interface ProgressProps {
  /** 0–100 */
  value: number;
  /** 读屏器播报用，例如「下载中 23/48」 */
  label: string;
}

export function Progress({ value, label }: ProgressProps) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div
      className="ec-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <div className="ec-progress__fill" style={{ width: `${clamped}%` }} />
    </div>
  );
}
