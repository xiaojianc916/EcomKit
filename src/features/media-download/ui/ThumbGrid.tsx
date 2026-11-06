import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, AssetKind } from '../../../kernel/model/asset';
import { Button, Thumb } from '../../../kernel/ui-kit';

/**
 * 缩略图网格（§10.3「缩略图网格」）。
 *
 * 布局：每行 4 格、每格 72px；左下角序号（**和最终文件名一致**，所以序号由调用方
 * 通过 startIndex + 位置算，而不是从 1 重新数）；SKU 格子下方显示规格标签；
 * 视频格子显示时长、H.265 标左上角小字。
 *
 * 交互：
 * - 点格子进入挑选模式（§10.3 在网格里点选单张）
 * - 工具条：已选 3 / 26 · 全选 · 清除
 * - 悬停 400ms 显示 240px 大图和尺寸
 * - 网格最多 360px 高，超出时在网格内部滚动，不带动页面（overscroll-behavior: contain）
 *
 * **memo 的意义**：200 多张详情图展开后一次就是 200 多格（每格 1 个 <img>）。
 * 进度每 200ms 推一次，整块面板重渲染时这里必须能跳过 —— 它的输入
 * （assets / selectedKeys）在下载过程中根本不会变。
 */
export interface ThumbGridProps {
  kind: AssetKind;
  assets: Asset[];
  /** 已选的 key（挑选模式） */
  selectedKeys: ReadonlySet<string>;
  /** 这一类在整个类别里的起始序号（0 基）；只选了部分时也不从 1 重数 */
  startIndex?: number;
  onToggleKey(kind: AssetKind, key: string): void;
  onSelectAll(): void;
  onClear(): void;
  /** SKU 规格标签：asset.key → 文字（§10.3 SKU 格子下方） */
  labels?: ReadonlyMap<string, string>;
}

const CELL = 72;
const COLUMNS = 4;
const GRID_MAX_HEIGHT = 360;
const PREVIEW_DELAY_MS = 400;
const PREVIEW_SIZE = 240;
/**
 * 首屏渲染多少格，之后每次再放这么多。
 *
 * 真实场景：详情图 100~200 张很常见（拼多多长详情页）。一次性渲染 200 格 =
 * 200 个 <button> + 200 个 <img>，展开那一下会明显卡顿，而且这些图全都在
 * 「展开时才第一次挂载」的路径上。分批渲染让第一次展开只付 60 格的代价，
 * 用户滚到底（或被工具条挡住）时再继续放 —— 和虚拟化的体验差不了多少，
 * 但不需要引入虚拟化库、也不会破坏 <button> 的键盘顺序和读屏器语义。
 */
const BATCH_SIZE = 60;

/** 时长格式化成 0:32 / 1:05（§10.3 视频格子右下角） */
export function formatClipDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * 时长可能以秒或毫秒给（平台的字段不统一），大于 10000 认为是毫秒。
 * 单位搞错只会让「0:32」变成「0:00」或「21:20」，统一在这里判一次。
 */
export function normalizeDuration(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 10_000 ? value : value * 1000;
}

/** 序号宽度按「整个类别」的总数算，和 planner 的 padWidth 保持一致（§9.1） */
export function serialText(ordinal: number, categoryTotal: number): string {
  const width = categoryTotal >= 100 ? 3 : 2;
  return String(ordinal).padStart(width, '0');
}

export const ThumbGrid = memo(function ThumbGrid(props: ThumbGridProps) {
  const {
    kind,
    assets,
    selectedKeys,
    startIndex = 0,
    onToggleKey,
    onSelectAll,
    onClear,
    labels,
  } = props;

  const [hovered, setHovered] = useState<Asset | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 已经渲染出来的格数；换类别 / 换商品时回到首批 */
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);

  /**
   * 素材集合变了（换商品、换类别、平台改版）就回到首批，否则会带着上一个商品
   * 「已经放了 180 格」的状态，一展开就是满屏图。
   *
   * 用 React 官方推荐的「渲染期间用上一次的 props 调整 state」，而不是 useEffect：
   * effect 会先渲染一帧旧的 180 格再回退，闪一下；渲染期调整则在这次提交里就生效。
   */
  const [seenAssets, setSeenAssets] = useState(assets);
  if (seenAssets !== assets) {
    setSeenAssets(assets);
    setVisibleCount(BATCH_SIZE);
  }

  const visibleAssets = useMemo(
    () => (assets.length <= visibleCount ? assets : assets.slice(0, visibleCount)),
    [assets, visibleCount],
  );
  const hiddenCount = assets.length - visibleAssets.length;

  // 卸载时清掉悬停计时器：网格随时可能因为切换展开类别而消失，
  // 旧实现在卸载后仍会触发一次 setHovered（对已卸载组件 setState）。
  useEffect(() => {
    return () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    };
  }, []);

  const selectedCount = useMemo(() => {
    if (selectedKeys.size === 0) return 0;
    let count = 0;
    for (const asset of assets) {
      if (selectedKeys.has(asset.key)) count += 1;
    }
    return count;
  }, [assets, selectedKeys]);

  const schedulePreview = (asset: Asset): void => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    // 悬停 400ms 后才显示大图（§10.3），鼠标快速划过时不闪
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      setHovered(asset);
    }, PREVIEW_DELAY_MS);
  };

  const cancelPreview = (): void => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHovered(null);
  };

  return (
    <div style={{ padding: '4px 16px 12px', borderTop: '1px solid var(--ec-line)' }}>
      {/* 工具条：已选 3 / 26 · 全选 · 清除（§10.3） */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 28,
          fontSize: 12,
          color: 'var(--ec-text-2)',
        }}
      >
        <span className="ec-num">
          已选 {selectedCount} / {assets.length}
        </span>
        <span style={{ flex: 1 }} />
        <Button variant="link" onClick={onSelectAll}>
          全选
        </Button>
        <Button variant="link" onClick={onClear} disabled={selectedCount === 0}>
          清除
        </Button>
      </div>

      <div style={{ position: 'relative' }}>
        {/* biome-ignore lint/a11y/useSemanticElements: 缩略图网格是 §10.3 的 4 列格子布局，
            <fieldset> 带边框和 legend 语义，会把 72px 的格子挤变形；这里只需要一个可命名的分组，
            用 role="group" 是 ARIA 里「相关控件集合」的标准角色。 */}
        <div
          role="group"
          aria-label="素材缩略图"
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${COLUMNS}, ${CELL}px)`,
            gap: 4,
            maxHeight: GRID_MAX_HEIGHT,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
          }}
        >
          {visibleAssets.map((asset, i) => {
            const selected = selectedKeys.has(asset.key);
            const ordinal = startIndex + i + 1;
            const duration = normalizeDuration(asset.video?.duration);
            const label = labels?.get(asset.key);

            return (
              // key 用素材 key：它是 planner 的 itemKey 主键，跨渲染稳定。
              // 兜底序号只应对「平台给了重复 key」这种异常数据（否则会整格错位）。
              <div key={asset.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={`${selected ? '取消选择' : '选择'}第 ${ordinal} 个素材`}
                  onClick={() => onToggleKey(kind, asset.key)}
                  onMouseEnter={() => schedulePreview(asset)}
                  onMouseLeave={cancelPreview}
                  onFocus={() => schedulePreview(asset)}
                  onBlur={cancelPreview}
                  style={{
                    width: CELL,
                    height: CELL,
                    padding: 0,
                    border: 'none',
                    borderRadius: 4,
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <Thumb
                    {...(asset.preview === undefined ? {} : { src: asset.preview })}
                    alt={`第 ${ordinal} 个素材`}
                    size={CELL}
                    index={serialText(ordinal, assets.length)}
                    selected={selected}
                    {...(kind === 'video' && asset.video?.codec === 'h265'
                      ? { corner: 'H.265' }
                      : {})}
                  >
                    {kind === 'video' && duration !== undefined ? (
                      <span className="ec-thumb__corner ec-thumb__corner--right ec-num">
                        {formatClipDuration(duration)}
                      </span>
                    ) : null}
                    {selected ? (
                      <span className="ec-thumb__corner ec-thumb__corner--left" aria-hidden="true">
                        ✓
                      </span>
                    ) : null}
                  </Thumb>
                </button>
                {label === undefined ? null : (
                  <span
                    title={label}
                    style={{
                      width: CELL,
                      fontSize: 11,
                      lineHeight: '14px',
                      color: 'var(--ec-text-2)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      textAlign: 'center',
                    }}
                  >
                    {label}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/*
          还有没渲染的格子时，给一个明确的「继续加载」而不是靠滚动自动触发：
          自动触发会让「全选」看起来已经选完了（点完还要再等一批批加载），
          而用户点这个按钮时很清楚自己在放大视野。序号仍然按整个类别的总数算，
          所以第 61 张显示的依然是 61。
        */}
        {hiddenCount > 0 ? (
          <button
            type="button"
            className="ec-btn ec-btn--link"
            onClick={() => setVisibleCount((n) => Math.min(n + BATCH_SIZE, assets.length))}
            style={{ marginTop: 4 }}
          >
            继续加载（还有 {hiddenCount} 个）
          </button>
        ) : null}

        {/*
          悬停 400ms 的大图（§10.3）：显示 240px 图加尺寸。
          在面板内部的固定浮层，不用 Tooltip —— 它要显示图片，而且尺寸比文字提示大得多。
          用 decoding="async" + 固定 240px 宽：大图解码不占主线程，面板不会在悬停时卡一下。
        */}
        {hovered === null || hovered.preview === undefined ? null : (
          <div
            style={{
              position: 'absolute',
              right: 0,
              bottom: '100%',
              marginBottom: 4,
              zIndex: 1,
              padding: 4,
              border: '1px solid var(--ec-line)',
              borderRadius: 6,
              background: 'var(--ec-bg)',
              boxShadow: '0 8px 24px rgba(15, 20, 30, .12)',
              pointerEvents: 'none',
            }}
          >
            <img
              src={hovered.preview}
              alt=""
              decoding="async"
              style={{ display: 'block', width: PREVIEW_SIZE, height: 'auto', borderRadius: 4 }}
            />
            <div
              className="ec-num"
              style={{ fontSize: 12, color: 'var(--ec-text-2)', paddingTop: 2 }}
            >
              {hovered.width !== undefined && hovered.height !== undefined
                ? `${hovered.width} × ${hovered.height}`
                : '尺寸未知'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
