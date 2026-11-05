import { Progress } from '../../../kernel/ui-kit';
import { formatBytes } from '../format';
import type { PrimaryAction, PrimaryActionModel } from '../primary-action-model';

/**
 * ⑥ 主按钮（§10.3，高 36px；§10.4 主按钮和附加说明整表）。
 *
 * 文案、配色、能不能点，全部来自纯函数 primaryActionModel —— 这里只负责画。
 * 两条容易漏的规则：
 * - **进度态下按钮主体不响应点击，只有右侧的“取消”能点**（§10.5 防误触）。
 *   所以进度态渲染的是 div + 进度条，不是 <button disabled>，
 *   否则“取消”会被包在一个不可交互的区域里，鼠标和读屏器都够不到。
 * - 完成后 3 秒内显示「已保存 N 个文件」，之后由上层重新算模型，自动回落。
 */
export interface PrimaryActionProps {
  model: PrimaryActionModel;
  onAction(action: PrimaryAction): void;
  /** 进度态下由上层传进来的任务体积，用于 aria 文案 */
  bytes?: number;
  /** 正在等 bg 回话：按钮变「正在提交…」，让点击有可见反馈 */
  submitting?: boolean;
  /** 提交失败的一句话原因；非空时显示在主按钮下方，绝不静默 */
  errorText?: string | null;
}

export function PrimaryActionView({
  model,
  onAction,
  bytes,
  submitting = false,
  errorText = null,
}: PrimaryActionProps) {
  const { variant, disabled, progress, secondary, meta, metaAction } = model;
  // 提交中：保留原文案的语义，但明确告诉用户「已经收到了，正在处理」
  const label = submitting && variant !== 'progress' ? '正在提交…' : model.label;

  const isProgress = variant === 'progress' && progress !== null;

  return (
    <div style={{ padding: '8px 16px 12px' }}>
      {isProgress ? (
        // 进度态：按钮变成进度条（§10.4 第 11 行），主体不可点，右侧“取消”
        <section
          aria-label={label}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 36,
            padding: '0 12px',
            border: '1px solid var(--ec-line)',
            borderRadius: 6,
            background: 'var(--ec-bg-subtle)',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <Progress
              value={progress.total > 0 ? (progress.done / progress.total) * 100 : 0}
              label={label}
            />
          </div>
          {/*
            体积已经拼在 label 里（primaryActionModel 的「下载中 6/24 · 2 MB」），
            这里再拼一次会显示成「… · 2 MB · 2 MB」。只补 label 里没有体积的情况。
          */}
          <span
            className="ec-num"
            style={{ fontSize: 13, color: 'var(--ec-text)', whiteSpace: 'nowrap' }}
          >
            {bytes !== undefined && !label.includes(formatBytes(bytes))
              ? `${label} · ${formatBytes(bytes)}`
              : label}
          </span>
          {secondary === null ? null : (
            <button
              type="button"
              className="ec-btn ec-btn--link"
              onClick={() => onAction(secondary.action)}
            >
              {secondary.label}
            </button>
          )}
        </section>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            // 只有真正的操作按钮；禁用时确实不可点
            disabled={disabled || submitting}
            onClick={() => onAction(model.action)}
            className={`ec-btn ${variant === 'accent' ? 'ec-btn--primary' : 'ec-btn--neutral'}`}
            style={{ flex: 1, width: '100%' }}
          >
            {label}
          </button>
          {secondary === null ? null : (
            <button
              type="button"
              className="ec-btn ec-btn--link"
              onClick={() => onAction(secondary.action)}
            >
              {secondary.label}
            </button>
          )}
        </div>
      )}

      {/* 提交失败：单独一行、红字，保证「点了没反应」绝不发生 */}
      {errorText === null ? null : (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            marginTop: 6,
            fontSize: 12,
            lineHeight: '16px',
            color: 'var(--ec-danger)',
          }}
        >
          {errorText}
        </div>
      )}

      {/* ⑦ 附加说明：最多两行（§10.3），右侧可带“查看”这类动作 */}
      {meta.length === 0 ? null : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            marginTop: 6,
            fontSize: 12,
            lineHeight: '16px',
            color: 'var(--ec-text-2)',
            flexWrap: 'wrap',
          }}
        >
          {meta.map((line) => (
            <span key={line}>{line}</span>
          ))}
          {metaAction === null ? null : (
            <button
              type="button"
              className="ec-btn ec-btn--link"
              onClick={() => onAction(metaAction.action)}
            >
              {metaAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
