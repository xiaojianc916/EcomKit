import { useCallback, useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import type { JobRecord } from '../../../kernel/jobs/types';
import type { DirState } from '../../../kernel/messaging/protocol';
import type { Asset, AssetKind } from '../../../kernel/model/asset';
import type { ProductSnapshot } from '../../../kernel/model/product';
import type { PageApi } from '../../types';
import { isSelectionStale, type MediaStore, type MediaStoreState } from '../media-store';
import { platformDisplayName, toPlannerSettings } from '../payload';
import { planCounts, planDownload, type WritePlan } from '../planner';
import { KIND_ORDER, type PrimaryActionState, primaryActionModel } from '../primary-action-model';
import type { MediaDownloadSettings } from '../settings';
import { groupAssetsByKind, isAllChecked } from '../ui/AssetList';
import { countByKind, localDayStart, previewFolderPath, skuLabelMap } from './panel-derived';
import { type MediaActions, useMediaActions } from './use-media-actions';
import { useMediaJobSync } from './use-media-store';

/**
 * 面板的全部状态组装（§8.6、§10.3、§10.9）。
 *
 * 这个 hook 只回答一个问题：**这一帧面板应该长什么样**。
 * 渲染在 media-panel-view.tsx，动作在 use-media-actions.ts，纯换算在 panel-derived.ts，
 * 订阅和副作用在这里 —— 每块只有一个职责，改动不会互相牵连。
 */

/**
 * store 切片的选择器提到模块级：每次渲染都传一个新箭头函数虽然也能工作，
 * 但稳定引用能让 zustand 的 useStore 走最省的那条路。
 */
const selectCheckedKinds = (s: MediaStoreState): Set<AssetKind> => s.checkedKinds;
const selectSelectedKeys = (s: MediaStoreState): Set<string> => s.selectedKeys;
const selectExpandedKind = (s: MediaStoreState): AssetKind | null => s.expandedKind;
const selectJob = (s: MediaStoreState): JobRecord | null => s.job;
const selectFailuresOpen = (s: MediaStoreState): boolean => s.failuresOpen;

export interface MediaPanelArgs {
  store: MediaStore;
  snapshot: ProductSnapshot;
  status: 'resolving' | 'ready';
  settings: MediaDownloadSettings;
  api: PageApi;
  /** 目录状态：外壳已经查过，直接传下来（§9.4：功能不要再查一次） */
  dir: DirState;
  jobFromShell: JobRecord | null | undefined;
}

export interface MediaPanelState {
  /** 交给渲染层的全部内容：视图需要的字段 + 主按钮模型 */
  view: {
    byKind: Record<AssetKind, Asset[]>;
    checkedKinds: ReadonlySet<AssetKind>;
    selectedKeys: ReadonlySet<string>;
    expandedKind: AssetKind | null;
    resolving: boolean;
    job: JobRecord | null;
    skuLabels: ReadonlyMap<string, string>;
    allChecked: boolean;
    folderPreview: string;
    model: ReturnType<typeof primaryActionModel>;
    submitting: boolean;
    submitError: string | null;
    bytes: number | undefined;
    failuresOpen: boolean;
  };
  actions: MediaActions;
  /** 素材清单的回调（引用固定，缩略图网格靠它才 memo 得住） */
  listHandlers: {
    onToggleCheck(kind: AssetKind): void;
    onToggleAll(): void;
    onExpand(kind: AssetKind): void;
    onToggleKey(kind: AssetKind, key: string): void;
    onSelectAllIn(kind: AssetKind): void;
    onClearIn(): void;
  };
  onCopy(text: string): void;
}

export function useMediaPanel(args: MediaPanelArgs): MediaPanelState {
  const { store, snapshot, status, settings, api, dir, jobFromShell } = args;

  /**
   * 按切片订阅（React 19 的 useSyncExternalStore，zustand 的 useStore 就是它的封装）。
   *
   * §10.9 要求「进度每 200ms 更新一次时，只有对应的行和主按钮会重新渲染」。
   * 旧实现是 `store.subscribe((state) => setSnapshotState(state))` —— 订阅的是**整棵** store，
   * 每次 set()（包括每 200ms 的进度）都换一个新快照，整块面板（含展开后 200 多格的缩略图网格）
   * 全部重渲染。改成逐切片订阅后，每个切片只在它自己的引用变化时才触发重渲染。
   *
   * 用 Set/对象本身作为切片是安全的：media-store 的 action 每次都新建 Set 后才 set，
   * 没变时引用保持不变，所以不会出现「每次渲染都当成变了」的空转。
   */
  const checkedKinds = useStore(store, selectCheckedKinds);
  const selectedKeys = useStore(store, selectSelectedKeys);
  const expandedKind = useStore(store, selectExpandedKind);
  const job = useStore(store, selectJob);
  const failuresOpen = useStore(store, selectFailuresOpen);

  const dedupeKey = `${snapshot.platform}:${snapshot.productId}`;
  const now = useMediaJobSync({ store, api, dedupeKey, job, jobFromShell });
  const actions = useMediaActions({
    snapshot,
    settings,
    api,
    dedupeKey,
    dir,
    store,
    checkedKinds,
    selectedKeys,
    job,
  });

  const byKind = useMemo(() => groupAssetsByKind(snapshot.assets), [snapshot.assets]);
  // 这两个换算以前在 counts / folderPreview 里各做一次，现在只做一次
  const plannerSettings = useMemo(() => toPlannerSettings(settings), [settings]);
  const platformName = useMemo(() => platformDisplayName(snapshot.platform), [snapshot.platform]);
  const planDay = localDayStart(now);

  /**
   * 「按类别全下」的计划：主按钮数量和保存路径预览共用一份。
   *
   * 旧实现为这两处各调一次 planDownload，每次都把整份计划
   * （几百条 WorkItem，含文件名清洗、模板渲染、字素截断）从头算一遍 —— 两份结果完全一样，
   * 而挑选模式下 counts 用的是另一份计划。合并成一次 useMemo 后，只在快照 / 勾选 /
   * 设置 / 日期真正变化时才算。
   *
   * 计划算不出来（模板缺 {id} 等）时返回 null，由调用方各自退回原行为。
   */
  const planForKinds = useMemo<WritePlan | null>(() => {
    try {
      return planDownload({
        snapshot,
        selection: { kinds: [...checkedKinds] },
        settings: plannerSettings,
        platformDisplayName: platformName,
        now: planDay,
      });
    } catch {
      return null;
    }
  }, [snapshot, checkedKinds, plannerSettings, platformName, planDay]);

  /**
   * 挑选模式下的计划：只下选中的 key。没进入挑选模式时不给 planDownload 机会
   * （返回 null 表示「不在挑选模式」，而不是「计算出错」）。
   */
  const planForPicked = useMemo<WritePlan | null>(() => {
    if (selectedKeys.size === 0) return null;
    try {
      return planDownload({
        snapshot,
        selection: { kinds: [...checkedKinds], keys: [...selectedKeys] },
        settings: plannerSettings,
        platformDisplayName: platformName,
        now: planDay,
      });
    } catch {
      return null;
    }
  }, [snapshot, checkedKinds, selectedKeys, plannerSettings, platformName, planDay]);

  /**
   * 每类**真正会被写入**的数量（不是快照里的素材数）。
   *
   * 主按钮写「下载 N 个文件」，N 必须等于任务实际要写的条数：
   * detailMinWidth 会把过窄的详情图过滤掉、视频封面会多出一条、重复 key 会去重。
   * 旧实现直接用快照总数，用户点了「下载 24 个」结果只下来 22 个。
   */
  const counts = useMemo(() => {
    const plan = planForPicked ?? planForKinds;
    // 模板非法等情况下退回原始计数，至少数量不会突然变成 0
    if (plan === null) return countByKind(snapshot);
    return planCounts(plan);
  }, [planForPicked, planForKinds, snapshot]);

  const allChecked = useMemo(() => isAllChecked(byKind, checkedKinds), [byKind, checkedKinds]);
  const skuLabels = useMemo(() => skuLabelMap(snapshot), [snapshot]);

  // 换商品后之前选中的 key 可能一个都不在了，此时退出挑选模式
  const availableKeys = useMemo(
    () => new Set(snapshot.assets.map((a) => a.key)),
    [snapshot.assets],
  );
  useEffect(() => {
    if (isSelectionStale(selectedKeys, availableKeys)) store.getState().clearSelection();
  }, [availableKeys, selectedKeys, store]);

  const actionState: PrimaryActionState = {
    status: status === 'resolving' ? 'resolving' : 'ready',
    dir: dir.status,
    counts,
    selectedKinds: [...checkedKinds],
    selectedKeys: [...selectedKeys],
    job,
    // 其他标签页 / 排队 / 等授权小窗这三个状态目前没有数据源：
    // 保持 null / 0 / false 是**如实**的，不是遗忘 —— 主按钮就不会显示根本没有的状态。
    // 需要它们时必须先有「跨标签页任务查询」和「授权小窗的 pending 回执」，见 docs/audit-c §C3。
    otherTabJob: null,
    queuedAhead: 0,
    grantPending: actions.grantPending,
    now,
  };
  const model = primaryActionModel(actionState);

  const folderPreview = useMemo(() => {
    // 模板缺少 {id} 这类错误应该在设置页拦掉；这里退回只显示平台名，至少不是空白
    if (planForKinds === null) return platformName;
    return previewFolderPath(planForKinds);
  }, [planForKinds, platformName]);

  // 「全选」按快照里实际有素材的类别算：计划里的 counts 只统计**已勾选**的类别，
  // 全部取消勾选后 counts 全 0，再点「全选」就会传下去一个空数组（看起来像没反应）。
  const nonEmptyKinds = useMemo(
    () => KIND_ORDER.filter((k) => (byKind[k]?.length ?? 0) > 0),
    [byKind],
  );

  /**
   * 传给素材清单的回调全部 useCallback 固定引用：
   * 缩略图网格是 React.memo 的，回调不稳定会让它每次进度 tick 都白重渲染一遍
   * （200 多格 DOM + 200 多个 <img>，那才是 200ms 卡顿的真正来源）。
   * 这里一律走 store.getState()，不依赖闭包里的状态快照。
   */
  const onToggleCheck = useCallback(
    (kind: AssetKind) => {
      store.getState().toggleKind(kind);
    },
    [store],
  );
  const onToggleAll = useCallback(() => {
    store.getState().toggleAll(nonEmptyKinds);
  }, [store, nonEmptyKinds]);
  const onExpand = useCallback(
    (kind: AssetKind) => {
      store.getState().expand(kind);
    },
    [store],
  );
  const onToggleKey = useCallback(
    (kind: AssetKind, key: string) => {
      store.getState().toggleKey(kind, key);
    },
    [store],
  );
  const onSelectAllIn = useCallback(
    (kind: AssetKind) => {
      store.getState().selectAllIn(
        kind,
        (byKind[kind] ?? []).map((a) => a.key),
      );
    },
    [store, byKind],
  );
  const onClearIn = useCallback(() => {
    store.getState().clearSelection();
  }, [store]);

  const onCopy = useCallback(
    (text: string) => {
      void api.copy(text);
    },
    [api],
  );

  return {
    view: {
      byKind,
      checkedKinds,
      selectedKeys,
      expandedKind,
      resolving: status === 'resolving',
      job,
      skuLabels,
      allChecked,
      folderPreview,
      model,
      submitting: actions.submitting,
      submitError: actions.submitError,
      bytes: job === null ? undefined : job.bytes,
      failuresOpen,
    },
    actions,
    listHandlers: {
      onToggleCheck,
      onToggleAll,
      onExpand,
      onToggleKey,
      onSelectAllIn,
      onClearIn,
    },
    onCopy,
  };
}
