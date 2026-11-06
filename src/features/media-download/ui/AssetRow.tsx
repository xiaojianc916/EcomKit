import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { memo, useCallback } from 'react';
import type { Asset, AssetKind } from '../../../kernel/model/asset';
import { Checkbox, Progress, Thumb } from '../../../kernel/ui-kit';
import { KIND_LABELS } from '../primary-action-model';
import { type AssetRowModel, previewAssets, rowTags } from './asset-row-model';

/**
 * 素材行（§10.3 ④，每行 48px）。
 *
 * 一行里放：复选框 · 名称 · 数量（等宽数字）· 前 4 张缩略图加“+N” · 行内“下载”。
 * 数量和缩略图并排放在右侧，用户看一眼就知道「这一类有几张、长什么样」。
 *
 * 交互（§10.3 素材行交互表）：
 * - 点复选框：勾选/取消这一类（全局偏好，以后所有商品都按这个默认勾选）
 * - 点行内“下载”：只下载这一类，不受复选框影响
 * - 点行的其余区域：展开缩略图网格（同一时间只展开一类）
 * - 键盘：行上 Enter 展开网格、空格切换勾选（§10.5 键盘操作）
 *
 * **为什么是 memo 且要自定义比较**：进度每 200ms 推一次，job 对象每次都是新的
 * （跨 Port 结构克隆），引用比较必然失配。真正决定这一行长什么样的是
 * assetRowModel 的四个结果字段，所以这里逐个比它们，而不是比 job 的引用 ——
 * 否则 200ms 一次的四行重渲染就白省了。
 */
export interface AssetRowProps {
  kind: AssetKind;
  /** 这一类在快照里的素材（引用稳定，来自 groupAssetsByKind 的缓存） */
  assets: Asset[];
  /**
   * 右半部分的状态与文案。由 AssetList 统一用 assetRowModel 算好传进来 ——
   * 放在这里算的话比较函数拿不到「上一份」结果，memo 就退化成引用比较。
   */
  model: AssetRowModel;
  checked: boolean;
  /** 挑选模式下这一行是半选（§10.3 勾选状态显示为半选） */
  indeterminate: boolean;
  expanded: boolean;
  onToggleCheck(kind: AssetKind): void;
  onDownloadKind(kind: AssetKind): void;
  onRetryKind(kind: AssetKind): void;
  onToggleExpand(kind: AssetKind): void;
}

export const ROW_HEIGHT = 48;

/** 两行的显示是否等价（不含 job 引用本身，只含它算出来的状态） */
export function areAssetRowModelsEqual(a: AssetRowModel, b: AssetRowModel): boolean {
  if (a === b) return true;
  if (a.countText !== b.countText || a.showDownload !== b.showDownload) return false;
  if (a.showRetry !== b.showRetry) return false;
  const sa = a.status;
  const sb = b.status;
  if (sa.kind !== sb.kind) return false;
  switch (sa.kind) {
    case 'progress':
      return sa.done === (sb as typeof sa).done && sa.total === (sb as typeof sa).total;
    case 'partial':
      return (
        sa.done === (sb as typeof sa).done &&
        sa.total === (sb as typeof sa).total &&
        sa.failed === (sb as typeof sa).failed
      );
    case 'done':
    case 'skipped':
      return sa.count === (sb as typeof sa).count;
    default:
      // resolving / ready / empty 没有负载字段
      return true;
  }
}

/** 素材行的 memo 比较器（导出以便单测直接验证「什么会触发重渲染」） */
export function areAssetRowPropsEqual(a: AssetRowProps, b: AssetRowProps): boolean {
  return (
    a.kind === b.kind &&
    a.assets === b.assets &&
    a.checked === b.checked &&
    a.indeterminate === b.indeterminate &&
    a.expanded === b.expanded &&
    a.onToggleCheck === b.onToggleCheck &&
    a.onDownloadKind === b.onDownloadKind &&
    a.onRetryKind === b.onRetryKind &&
    a.onToggleExpand === b.onToggleExpand &&
    areAssetRowModelsEqual(a.model, b.model)
  );
}

export const AssetRow = memo(function AssetRow(props: AssetRowProps) {
  const {
    kind,
    assets,
    checked,
    indeterminate = false,
    expanded,
    model,
    onToggleCheck,
    onDownloadKind,
    onRetryKind,
    onToggleExpand,
  } = props;

  const disabled = model.status.kind === 'empty';
  const tags = rowTags(assets, kind);
  const { shown, rest } = previewAssets(assets, 4);
  const label = KIND_LABELS[kind];

  const handleRowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      // 已经在控件上时不要抢按键（复选框自己会处理空格）
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        onToggleExpand(kind);
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        if (!disabled) onToggleCheck(kind);
      }
    },
    [disabled, kind, onToggleCheck, onToggleExpand],
  );

  return (
    /*
      行内布局：<li> 只承担列表语义（父级是 <ul>，四个类别是一个列表），
      「点行的其余区域展开网格」用一个铺满整行的真实 <button> 覆盖层实现 ——
      比给 li 挂 role="button" 更符合 a11y：它是一个真按钮，Tab 能到、读屏器念得出
      aria-expanded，而复选框和行内“下载”按钮叠在它上面，各自保留自己的语义。
      覆盖层在 zIndex 0，内容在 zIndex 1；非交互的文字设 pointerEvents:none，
      点击会穿透到覆盖层（§10.3 素材行交互）。
    */
    // 外层 <li> 由 AssetList 提供；这里必须用 div，否则 <li> 套 <li>，React 会报
    // 「validateDOMNesting: <li> cannot appear as a descendant of <li>」。
    <div
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: ROW_HEIGHT,
        padding: '0 16px',
        opacity: disabled ? 0.5 : 1,
        borderTop: '1px solid var(--ec-line)',
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? '收起' : '展开'}${label}`}
        onClick={() => onToggleExpand(kind)}
        onKeyDown={handleRowKeyDown}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 0,
          padding: 0,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
        }}
      />
      <span style={{ position: 'relative', zIndex: 1, display: 'flex' }}>
        <Checkbox
          checked={indeterminate ? 'indeterminate' : checked}
          disabled={disabled}
          label={`下载${label}`}
          onCheckedChange={() => onToggleCheck(kind)}
        />
      </span>

      <span style={{ fontSize: 13, color: 'var(--ec-text)', pointerEvents: 'none' }}>{label}</span>
      {tags.map((tag) => (
        <span key={tag} className="ec-tag">
          {tag}
        </span>
      ))}

      <span style={{ flex: 1, pointerEvents: 'none' }} />

      {/* 数量：等宽数字（§10.6 字体） */}
      <span
        className="ec-num"
        style={{ fontSize: 12, color: 'var(--ec-text-2)', whiteSpace: 'nowrap' }}
      >
        {model.countText}
      </span>

      {/* 右半部分：下载中换成细进度条，否则是缩略图条（§10.4 素材行） */}
      {model.status.kind === 'progress' ? (
        <span style={{ width: 72, flex: 'none', pointerEvents: 'none' }}>
          <Progress
            value={model.status.total > 0 ? (model.status.done / model.status.total) * 100 : 0}
            label={`${label} 下载中 ${model.status.done}/${model.status.total}`}
          />
        </span>
      ) : model.status.kind === 'resolving' ? (
        // 识别中：骨架占位
        <span style={{ display: 'flex', gap: 2 }} aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              style={{ width: 32, height: 32, borderRadius: 4, background: 'var(--ec-bg-subtle)' }}
            />
          ))}
        </span>
      ) : (
        <span style={{ display: 'flex', alignItems: 'center', gap: 2, pointerEvents: 'none' }}>
          {shown.map((asset) => (
            <Thumb
              key={asset.key}
              {...(asset.preview === undefined ? {} : { src: asset.preview })}
              alt={`${label}${asset.index + 1}`}
              size={32}
              {...(kind === 'video' && asset.video?.codec === 'h265' ? { corner: 'H.265' } : {})}
            />
          ))}
          {rest > 0 ? (
            <span className="ec-num" style={{ fontSize: 12, color: 'var(--ec-text-3)' }}>
              +{rest}
            </span>
          ) : null}
        </span>
      )}

      {/* 行内“下载”/“重试”：只作用于这一类，不受复选框影响（§10.3） */}
      {model.showRetry ? (
        <button
          type="button"
          className="ec-btn ec-btn--link"
          style={{ position: 'relative', zIndex: 1 }}
          onClick={() => onRetryKind(kind)}
        >
          重试
        </button>
      ) : null}
      {model.showDownload ? (
        <button
          type="button"
          className="ec-btn ec-btn--link"
          style={{ position: 'relative', zIndex: 1 }}
          onClick={() => onDownloadKind(kind)}
        >
          下载
        </button>
      ) : null}
    </div>
  );
}, areAssetRowPropsEqual);
