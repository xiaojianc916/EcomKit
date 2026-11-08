import type { Asset, AssetKind } from '../../kernel/model/asset';
import {
  type DataSourceId,
  type ProductDraft,
  ProductSnapshot,
  type Sku,
} from '../../kernel/model/product';

/**
 * 多数据源合并（方案 §7.3）。
 *
 * 规则：
 * 1. **标量字段**（标题、店铺、价格、链接）：按 ssr > capture > dom 取第一个非空值；
 * 2. **素材**：按 `kind + key` 去重；同一素材的 candidates 合并，高优先级来源的地址排前面；
 * 3. **顺序**：某一类素材以「产出过它的最高优先级来源」的顺序为准；
 * 4. **DOM 只补空**：ssr 和 capture 都没给某一类时，才用 DOM 的结果，并标 `fromDom: true`。
 *    DOM 启发式容易混进推荐商品的图片，所以绝不和结构化数据混在一起。
 * 5. **SKU**：整组取最高优先级来源；imageKey 指向 kind='sku' 的素材，多 SKU 共用一张图只留一个素材。
 */

const PRIORITY: Record<DataSourceId, number> = { ssr: 3, capture: 2, dom: 1 };

/** 快照里素材类别的固定输出顺序（决定文件序号与目录结构） */
const ASSET_KIND_ORDER: readonly AssetKind[] = ['main', 'sku', 'detail', 'video'];

export const SOURCE_PRIORITY: Readonly<Record<DataSourceId, number>> = PRIORITY;

interface RankedAsset {
  asset: Asset;
  priority: number;
  /** 同一 kind 内的插入顺序（来自最高优先级来源的自然顺序） */
  order: number;
}

interface RankedScalar {
  value: string;
  priority: number;
}

export interface SnapshotBase {
  platform: ProductSnapshot['platform'];
  pageKind: string;
  productId: string;
  /** 外部没有给标题时用的兜底（例如 DOM <title>） */
  fallbackTitle?: string;
  capturedAt?: number;
  fallbackUrl?: string;
}

/** 渐进合并器：每个 draft 进来调一次 add()，任何时候都能取 snapshot */
export class DraftAccumulator {
  private readonly scalars = new Map<'title' | 'shopName' | 'price' | 'url', RankedScalar>();
  private readonly assets = new Map<string, RankedAsset>();
  /** 每一类素材已经由哪些来源提供过（用来实现「DOM 只补空」） */
  private readonly kindSources = new Map<AssetKind, Set<DataSourceId>>();
  private readonly orderCounter = new Map<AssetKind, number>();
  private skus: { list: Sku[]; priority: number } | null = null;
  private readonly sources = new Set<DataSourceId>();

  /** 合入一个 draft；返回本次是否真的带来了新内容 */
  add(draft: ProductDraft): boolean {
    const priority = PRIORITY[draft.source];
    this.sources.add(draft.source);
    let changed = false;

    changed = this.addScalar('title', draft.title, priority) || changed;
    changed = this.addScalar('shopName', draft.shopName, priority) || changed;
    changed = this.addScalar('price', draft.price, priority) || changed;
    changed = this.addScalar('url', draft.url, priority) || changed;

    for (const asset of draft.assets ?? []) {
      changed = this.addAsset(asset, draft.source, priority) || changed;
    }

    if (draft.skus && draft.skus.length > 0) {
      if (!this.skus || priority > this.skus.priority) {
        this.skus = { list: draft.skus, priority };
        changed = true;
      }
    }
    return changed;
  }

  private addScalar(
    field: 'title' | 'shopName' | 'price' | 'url',
    raw: string | undefined,
    priority: number,
  ): boolean {
    const value = raw?.trim();
    if (!value) return false;
    const cur = this.scalars.get(field);
    if (cur && cur.priority >= priority) return false;
    this.scalars.set(field, { value, priority });
    return true;
  }

  private addAsset(asset: Asset, source: DataSourceId, priority: number): boolean {
    const key = `${asset.kind}:${asset.key}`;
    const seenSources = this.kindSources.get(asset.kind) ?? new Set<DataSourceId>();

    if (source === 'dom') {
      // DOM 只补空：这一类已经有结构化来源提供过素材时，DOM 的结果一律丢弃
      if (hasStructured(seenSources)) return false;
    } else if (seenSources.has('dom') && !hasStructured(seenSources)) {
      // 结构化来源后到：之前 DOM 补进来的这一类素材只是占位，整类丢掉再以结构化数据为准
      this.dropDomAssets(asset.kind);
      seenSources.delete('dom');
      this.kindSources.set(asset.kind, seenSources);
    }

    const existing = this.assets.get(key);
    if (!existing) {
      const order = this.orderCounter.get(asset.kind) ?? 0;
      this.orderCounter.set(asset.kind, order + 1);
      seenSources.add(source);
      this.kindSources.set(asset.kind, seenSources);
      this.assets.set(key, {
        asset: { ...asset, fromDom: source === 'dom' },
        priority,
        order,
      });
      return true;
    }

    let changed = false;
    if (priority > existing.priority) {
      // 高优先级来源的地址排在前面，其余元信息也跟着升级
      const merged = mergeAsset(existing.asset, asset);
      this.assets.set(key, { ...existing, asset: merged, priority });
      changed = true;
    } else if (priority === existing.priority) {
      const merged = mergeAsset(existing.asset, asset);
      if (!sameCandidates(merged.candidates, existing.asset.candidates)) {
        this.assets.set(key, { ...existing, asset: merged });
        changed = true;
      }
    }
    seenSources.add(source);
    this.kindSources.set(asset.kind, seenSources);
    return changed;
  }

  /** 清掉某一类里由 DOM 补进来的素材 */
  private dropDomAssets(kind: AssetKind): void {
    for (const [key, item] of this.assets) {
      if (item.asset.kind === kind && item.priority === PRIORITY.dom) this.assets.delete(key);
    }
  }

  /** 哪些类别已经有结构化（ssr / capture）数据 */
  hasStructuredKind(kind: AssetKind): boolean {
    const s = this.kindSources.get(kind);
    return s !== undefined && hasStructured(s);
  }

  /**
   * 能不能拼出一份快照 —— **不构造、不跑 Zod**。
   *
   * 判定条件与 toSnapshot() 返回 null 的分支完全一致（标题、链接、至少一个素材）。
   * resolver-runner 的 maybeSettle() 每收到一份抓包 draft 都要问一次这个问题；
   * 旧实现直接调 toSnapshot()，等于每份 draft 都把全部素材复制一遍、
   * 再跑一次 ProductSnapshot.safeParse。抓包源连吐几十份 draft 时这是纯浪费。
   */
  hasSnapshot(base: SnapshotBase): boolean {
    const title = this.scalars.get('title')?.value ?? base.fallbackTitle?.trim();
    const url = this.scalars.get('url')?.value ?? base.fallbackUrl;
    return Boolean(title && url) && this.assets.size > 0;
  }

  get isEmpty(): boolean {
    return !this.scalars.has('title') && this.assets.size === 0 && this.skus === null;
  }

  get assetCount(): number {
    return this.assets.size;
  }

  get usedSources(): DataSourceId[] {
    return [...this.sources];
  }

  /** 生成快照；缺标题或缺素材时返回 null（由调用方决定是否进 empty 状态） */
  toSnapshot(base: SnapshotBase): ProductSnapshot | null {
    const title = this.scalars.get('title')?.value ?? base.fallbackTitle?.trim();
    const url = this.scalars.get('url')?.value ?? base.fallbackUrl;
    if (!title || !url) return null;

    const assets = this.buildAssets();
    if (assets.length === 0) return null;

    const skus = this.buildSkus(assets);

    const candidate = {
      platform: base.platform,
      pageKind: base.pageKind,
      productId: base.productId,
      title,
      ...(this.scalars.get('shopName')?.value
        ? { shopName: this.scalars.get('shopName')?.value as string }
        : {}),
      url,
      ...(this.scalars.get('price')?.value
        ? { price: this.scalars.get('price')?.value as string }
        : {}),
      skus,
      assets,
      sources: this.sourceOrder(),
      completeness: 'partial' as const,
      capturedAt: base.capturedAt ?? Date.now(),
    };

    const parsed = ProductSnapshot.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }

  /**
   * 素材按类别聚合并重新编号：index 在每一类内部从 0 开始，决定文件序号。
   *
   * assets 里的插入顺序就是 order 顺序（order 是单调递增的插入序号，中途只会删掉 DOM 占位），
   * 所以遍历一次 Map 就能得到每类已排好序的列表，不用再按 order 排序。
   * 这个方法在渐进解析里会被反复调用（每来一份 draft 一次），原来每次都要重建 Map + 排序。
   */
  private buildAssets(): Asset[] {
    const grouped = new Map<AssetKind, Asset[]>();
    for (const item of this.assets.values()) {
      const list = grouped.get(item.asset.kind);
      if (list === undefined) grouped.set(item.asset.kind, [{ ...item.asset }]);
      else list.push({ ...item.asset });
    }
    const out: Asset[] = [];
    for (const kind of ASSET_KIND_ORDER) {
      const list = grouped.get(kind);
      if (list === undefined) continue;
      for (let i = 0; i < list.length; i += 1) {
        const asset = list[i] as Asset;
        asset.index = i;
        out.push(stripEmpty(asset));
      }
    }
    return out;
  }

  private buildSkus(assets: Asset[]): Sku[] {
    const list = this.skus?.list ?? [];
    const skuAssets = assets.filter((a) => a.kind === 'sku');
    const byKey = new Map(skuAssets.map((a) => [a.key, a]));
    const out: Sku[] = [];
    for (const sku of list) {
      // imageKey 必须指向真实存在的 SKU 素材，指向不存在的就丢掉这个字段
      const resolved =
        sku.imageKey !== undefined && byKey.has(sku.imageKey) ? sku.imageKey : undefined;
      const { imageKey: _ignored, ...rest } = sku;
      out.push(resolved === undefined ? rest : { ...rest, imageKey: resolved });
    }
    return out;
  }

  private sourceOrder(): DataSourceId[] {
    return (['ssr', 'capture', 'dom'] as const).filter((s) => this.sources.has(s));
  }
}

function hasStructured(sources: Set<DataSourceId>): boolean {
  return sources.has('ssr') || sources.has('capture');
}

/** 合并两个相同素材：next 的地址排前面（调用方保证 next 的来源优先级不低） */
function mergeAsset(keep: Asset, next: Asset): Asset {
  const candidates = dedupeStrings([...next.candidates, ...keep.candidates]);
  const out: Asset = {
    ...keep,
    candidates,
  };
  // 元信息以「有值」为准；next 有值时优先用 next
  if (next.preview !== undefined) out.preview = next.preview;
  if (next.label !== undefined) out.label = next.label;
  if (next.width !== undefined) out.width = next.width;
  if (next.height !== undefined) out.height = next.height;
  if (next.video !== undefined) out.video = next.video;
  if (next.fromDom === false) out.fromDom = false;
  return out;
}

/** 去掉「显式 false」的可选字段，避免 exactOptionalPropertyTypes 下的脏数据 */
function stripEmpty(asset: Asset): Asset {
  const out: Asset = { ...asset };
  if (out.fromDom === false) delete out.fromDom;
  return out;
}

function dedupeStrings(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function sameCandidates(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
