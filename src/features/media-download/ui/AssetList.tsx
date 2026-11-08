import type { JobRecord } from '../../../kernel/jobs/types';
import type { Asset, AssetKind } from '../../../kernel/model/asset';
import { ASSET_KINDS } from '../../../kernel/model/asset';
import { KIND_LABELS } from '../primary-action-model';
import { AssetRow } from './AssetRow';
import { type AssetRowModel, assetRowModel, selectedCountOf } from './asset-row-model';
import { ThumbGrid } from './ThumbGrid';

/**
 * 素材清单（§10.3 ④，固定 4 行）。
 *
 * 关键点（§8.4）：**某一类素材数量为 0 时，这一行仍然显示，但置灰并标注“无”**。
 * 目的是让用户知道「这个商品确实没有视频」，而不是怀疑插件漏了。
 * 所以这里永远遍历 ASSET_KINDS 四项，而不是遍历 snapshot.assets。
 *
 * 每行的状态模型（assetRowModel）在这里算一次，而不是在 AssetRow 里：
 * AssetRow 是 memo 的，只有把「算好的结果」交给它，比较函数才能按结果比，
 * 而不是按每 200ms 都换新引用的 job 对象比（那样 memo 形同虚设）。
 */
export interface AssetListProps {
  /** 快照里的素材，按类别分组后的结果 */
  byKind: Record<AssetKind, Asset[]>;
  /** 全局勾选的类别 */
  checkedKinds: ReadonlySet<AssetKind>;
  /** 挑选模式：每个类别里选中的 key */
  selectedKeys: ReadonlySet<string>;
  /** 展开的类别；同一时间只展开一类（§10.3） */
  expandedKind: AssetKind | null;
  resolving: boolean;
  job: JobRecord | null;
  /** SKU 规格标签：asset.key → 文字 */
  skuLabels?: ReadonlyMap<string, string>;
  onToggleCheck(kind: AssetKind): void;
  onToggleAll(): void;
  allChecked: boolean;
  onDownloadKind(kind: AssetKind): void;
  onRetryKind(kind: AssetKind): void;
  onExpand(kind: AssetKind): void;
  onToggleKey(kind: AssetKind, key: string): void;
  /** 「全选」只作用于展开的这一类，参数由这里补 */
  onSelectAllIn(kind: AssetKind): void;
  /** 「清除」清掉全部挑选（store 的 clearSelection 本来就不分类别） */
  onClearIn(): void;
}

export function AssetList(props: AssetListProps) {
  const {
    byKind,
    checkedKinds,
    selectedKeys,
    expandedKind,
    resolving,
    job,
    skuLabels,
    onToggleCheck,
    onToggleAll,
    allChecked,
    onDownloadKind,
    onRetryKind,
    onExpand,
    onToggleKey,
    onSelectAllIn,
    onClearIn,
  } = props;

  return (
    <section aria-label="素材清单">
      {/* ③ 区块标题 28px：左边「素材」，右边「全不选 / 全选」切换（§10.3） */}
      <div className="ec-section-title">
        <span>素材</span>
        <button type="button" className="ec-btn ec-btn--link" onClick={onToggleAll}>
          {allChecked ? '全不选' : '全选'}
        </button>
      </div>

      {/* 用真实的列表语义：素材清单是「四个类别」的列表，不是二维表格 */}
      <ul aria-label="素材类别" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {ASSET_KINDS.map((kind) => {
          const assets = byKind[kind] ?? [];
          const selectedCount = selectedCountOf(assets, selectedKeys);
          const model: AssetRowModel = assetRowModel({
            kind,
            total: assets.length,
            selectedCount,
            resolving,
            job,
          });
          return (
            <li key={kind} aria-label={kindTitle(kind)} style={{ listStyle: 'none' }}>
              <AssetRow
                kind={kind}
                assets={assets}
                model={model}
                checked={checkedKinds.has(kind)}
                indeterminate={selectedCount > 0 && selectedCount < assets.length}
                expanded={expandedKind === kind}
                onToggleCheck={onToggleCheck}
                onDownloadKind={onDownloadKind}
                onRetryKind={onRetryKind}
                onToggleExpand={onExpand}
              />
              {expandedKind === kind ? (
                <ThumbGrid
                  kind={kind}
                  assets={assets}
                  selectedKeys={selectedKeys}
                  {...(skuLabels === undefined ? {} : { labels: skuLabels })}
                  onToggleKey={onToggleKey}
                  onSelectAll={() => onSelectAllIn(kind)}
                  onClear={onClearIn}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 按类别分组（快照里素材是混在一起的一维数组） */
export function groupAssetsByKind(assets: readonly Asset[]): Record<AssetKind, Asset[]> {
  const out: Record<AssetKind, Asset[]> = { main: [], sku: [], detail: [], video: [] };
  for (const asset of assets) out[asset.kind].push(asset);
  return out;
}

/** 全选状态：所有有素材的类别都被勾选（0 个的类别不参与判断，§10.4 主按钮第 2 行同理） */
export function isAllChecked(
  byKind: Record<AssetKind, Asset[]>,
  checkedKinds: ReadonlySet<AssetKind>,
): boolean {
  const nonEmpty = ASSET_KINDS.filter((k) => (byKind[k] ?? []).length > 0);
  return nonEmpty.length > 0 && nonEmpty.every((k) => checkedKinds.has(k));
}

/** 可下载素材总数（把手角标 §10.2「就绪：可下载的素材总数」） */
export function countAssets(byKind: Record<AssetKind, Asset[]>): number {
  return ASSET_KINDS.reduce((sum, kind) => sum + (byKind[kind] ?? []).length, 0);
}

/** 行标签文案，供测试和 popup 复用 */
export function kindTitle(kind: AssetKind): string {
  return KIND_LABELS[kind];
}
