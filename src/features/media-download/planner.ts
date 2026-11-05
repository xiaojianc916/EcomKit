import type { WorkItem } from '../../kernel/jobs/types';
import type { Asset, AssetKind } from '../../kernel/model/asset';
import type { ProductSnapshot } from '../../kernel/model/product';
import { NAME_LIMITS, sanitizeName, truncateGraphemes } from '../../kernel/naming/sanitize';
import { renderProductFolderName } from '../../kernel/naming/template';
import { KIND_ORDER } from './primary-action-model';
import { skuLabelsByImageKey } from './sku-label';

/**
 * 下载计划（§9.5）。
 *
 * 输入是快照 + 用户的选择 + 设置，输出「要写哪些文件、写到哪、文件名是什么」。
 * 这一步**不发任何网络请求、不碰文件系统**，所以既能在页面侧（点下载时先算一遍给用户看）
 * 也能在 offscreen 的 engine 里跑（任务真正执行的计划），两边结果必然一致。
 *
 * 三条硬规则：
 * 1. **编号以整个类别为基准**，不是以本次选中为基准。只勾第 3 张详情图时，
 *    文件名仍然是 `03.jpg`，以后补全序号才不会错乱。
 * 2. **itemKey 在计划里唯一**，并且跨会话稳定（它同时是 .ecbox.json 的主键），
 *    所以用「类别 + 平台素材 key」，不用序号（序号会随素材增删漂移）。
 * 3. 序号位数按该类别**总量**决定：≤99 补到两位，≥100 补到三位（§9.1）。
 */

export interface PlannerSettings {
  /** 按平台分文件夹（§11 feature:media-download.byPlatform） */
  byPlatform: boolean;
  /** 商品文件夹模板（§11 feature:media-download.folderTemplate） */
  folderTemplate: string;
  /** 四个子文件夹的名字（§11 feature:media-download.dirNames） */
  dirNames: Record<AssetKind, string>;
  /** 生成 商品信息.txt（§9.12） */
  infoTxt: boolean;
  /** 同时下载视频封面（§9.9） */
  videoCover: boolean;
  /** 详情图最小宽度，0 表示不过滤（§11 feature:media-download.detailMinWidth） */
  detailMinWidth: number;
}

export interface PlannerSelection {
  /** 勾选的类别 */
  kinds: readonly AssetKind[];
  /** 挑选模式下选中的单张素材 key；给了就只下这些，优先级高于 kinds */
  keys?: readonly string[];
}

export type PlanExtra = 'info-txt' | 'folder-manifest';

export interface WritePlan {
  /** 商品文件夹的相对路径，例如 ['拼多多', '夏季新款…_482319937501'] */
  folder: string[];
  items: WorkItem[];
  extras: PlanExtra[];
}

export interface PlanInput {
  snapshot: ProductSnapshot;
  selection: PlannerSelection;
  settings: PlannerSettings;
  /** 平台显示名，例如「拼多多」。来自 platform manifest 的 displayName */
  platformDisplayName: string;
  /** 生成 {date} 用的时间，测试里固定它 */
  now?: number;
}

/** 序号宽度：总数 ≤ 99 两位，≥ 100 三位（§9.1） */
function padWidth(total: number): number {
  return total >= 100 ? 3 : 2;
}

function padNumber(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** 子文件夹名同样要清洗（设置里用户可以随便填），并按 §9.2 限制长度 */
function subdirName(raw: string): string {
  return sanitizeName(raw, { maxLength: NAME_LIMITS.subdir });
}

/** 文件名主体：清洗 + 截断到 40 字素（§9.2「文件名 ≤ 40 字」） */
function fileStem(raw: string): string {
  return truncateGraphemes(sanitizeName(raw, { maxLength: NAME_LIMITS.file }), NAME_LIMITS.file);
}

/** 同一类别内按页面原始顺序排好；顺序决定序号 */
function assetsOfKind(snapshot: ProductSnapshot, kind: AssetKind): Asset[] {
  return snapshot.assets.filter((a) => a.kind === kind).sort((a, b) => a.index - b.index);
}

function passesDetailFilter(asset: Asset, minWidth: number, kind: AssetKind): boolean {
  if (kind !== 'detail' || minWidth <= 0) return true;
  // 宽高未知时保留：宁可不漏图，也不要因为平台没给尺寸就悄悄少下几张
  if (asset.width === undefined) return true;
  return asset.width >= minWidth;
}

/**
 * 视频的文件名（§9.1）：
 * - 主图视频 → `主图视频`（不带序号，一个商品最多一个）
 * - 其他有名字的视频 → `{label}_序号`
 * - 名字未知 → `视频_序号`
 */
function videoStem(asset: Asset, serial: string): string {
  const label = asset.label?.trim();
  if (label === '主图视频') return fileStem('主图视频');
  if (label && label !== '') return fileStem(`${label}_${serial}`);
  return fileStem(`视频_${serial}`);
}

function itemKeyOf(kind: AssetKind, asset: Asset): string {
  // 同一平台 key 在同一类别下只会出现一次；万一平台给了重复 key，planner 会去重
  return `${kind}:${asset.key}`;
}

/**
 * 生成写入计划。纯函数：同样的输入得到同样的输出（含 items 的先后顺序）。
 */
export function planDownload(input: PlanInput): WritePlan {
  const { snapshot, selection, settings, platformDisplayName, now } = input;
  const wantsEverything = selection.keys === undefined || selection.keys.length === 0;
  const keySet = wantsEverything ? null : new Set(selection.keys);
  const kindSet = new Set<AssetKind>(selection.kinds);

  const productFolder = renderProductFolderName(
    settings.folderTemplate,
    {
      platform: platformDisplayName,
      ...(snapshot.shopName === undefined ? {} : { shop: snapshot.shopName }),
      title: snapshot.title,
      id: snapshot.productId,
    },
    now === undefined ? {} : { now },
  );

  const folder: string[] = [];
  if (settings.byPlatform)
    folder.push(sanitizeName(platformDisplayName, { maxLength: NAME_LIMITS.platform }));
  folder.push(productFolder);

  const skuLabels = skuLabelsByImageKey(snapshot.skus);
  const items: WorkItem[] = [];
  const seen = new Set<string>();

  const push = (item: WorkItem): void => {
    if (seen.has(item.itemKey)) return;
    seen.add(item.itemKey);
    items.push(item);
  };

  for (const kind of KIND_ORDER) {
    const all = assetsOfKind(snapshot, kind);
    if (all.length === 0) continue;
    const width = padWidth(all.length);
    const dir = [subdirName(settings.dirNames[kind])];

    // 序号以整个类别为基准：先算好「第几个」，再按选择过滤（§9.5）
    let ordinal = 0;
    for (const asset of all) {
      ordinal += 1;
      const selected = keySet ? keySet.has(asset.key) : kindSet.has(kind);
      if (!selected) continue;
      if (!passesDetailFilter(asset, settings.detailMinWidth, kind)) continue;

      const serial = padNumber(ordinal, width);
      let stem: string;
      if (kind === 'sku') {
        const label = skuLabels.get(asset.key);
        stem = fileStem(label === undefined ? serial : `${serial}_${label}`);
      } else if (kind === 'video') {
        stem = videoStem(asset, serial);
      } else {
        stem = fileStem(serial);
      }

      push({
        itemKey: itemKeyOf(kind, asset),
        group: kind,
        dir,
        stem,
        expect: kind === 'video' ? 'video' : 'image',
        candidates: asset.candidates,
        kind,
      });

      // 视频封面（§9.9，默认关闭）：文件名固定成「主图视频_封面」
      if (kind === 'video' && settings.videoCover && asset.video?.cover !== undefined) {
        const coverStem = fileStem(
          asset.label?.trim() === '主图视频' ? '主图视频_封面' : `${stem}_封面`,
        );
        push({
          itemKey: `${kind}-cover:${asset.key}`,
          group: kind,
          dir,
          stem: coverStem,
          expect: 'image',
          candidates: [asset.video.cover],
          kind,
        });
      }
    }
  }

  const extras: PlanExtra[] = ['folder-manifest'];
  if (settings.infoTxt) extras.push('info-txt');

  return { folder, items, extras };
}

/** 计划里各类别的文件数，主按钮和素材行用它显示数量 */
export function planCounts(plan: WritePlan): Record<AssetKind, number> {
  const out: Record<AssetKind, number> = { main: 0, sku: 0, detail: 0, video: 0 };
  for (const item of plan.items) {
    if (item.group in out) out[item.group as AssetKind] += 1;
  }
  return out;
}
