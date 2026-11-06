import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { ErrorCode } from '../../kernel/errors/codes';
import type { JobRecord } from '../../kernel/jobs/types';
import type { AssetKind } from '../../kernel/model/asset';
import type { ProductSnapshot } from '../../kernel/model/product';
import { templateHasId } from '../../kernel/settings/schema';
import { Checkbox } from '../../kernel/ui-kit';
import type { PageApi, PageFeature, PanelProps, QuickAction } from '../types';
import {
  createMediaStore,
  isSelectionStale,
  type MediaStore,
  type MediaStoreState,
} from './media-store';
import { buildMediaDownloadPayload, platformDisplayName, toPlannerSettings } from './payload';
import { planCounts, planDownload, type WritePlan } from './planner';
import {
  joinKindLabels,
  KIND_ORDER,
  type PrimaryAction,
  type PrimaryActionState,
  primaryActionModel,
} from './primary-action-model';
import { DEFAULT_MEDIA_DOWNLOAD_SETTINGS, type MediaDownloadSettings } from './settings';
import { AssetList, groupAssetsByKind, isAllChecked } from './ui/AssetList';
import { FailureList } from './ui/FailureList';
import { PrimaryActionView } from './ui/PrimaryAction';
import { SaveBar } from './ui/SaveBar';

/**
 * media-download 的面板（§8.6、§10.3）。
 *
 * 这个文件只做「状态怎么组装、动作怎么发出去」，所有**规则**都在纯函数里
 * （primaryActionModel / assetRowModel / media-store），这样 §10.4 的每一行
 * 都能被单测锁死，而不是靠人肉点界面。
 *
 * 页面侧不下载文件、不碰 chrome.downloads —— 一切通过 PageApi 提交任务（§8.2、§4.1）。
 */

// 平台显示名和设置换算都挪到 ./payload.ts（页面和引擎共用同一份定义），
// 这里重新导出只为兼容既有的调用点和测试。
export { PLATFORM_NAMES, platformDisplayName, toPlannerSettings } from './payload';

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
 * store 切片的选择器提到模块级：每次渲染都传一个新箭头函数虽然也能工作，
 * 但稳定引用能让 zustand 的 useStore 走最省的那条路。
 */
const selectCheckedKinds = (s: MediaStoreState): Set<AssetKind> => s.checkedKinds;
const selectSelectedKeys = (s: MediaStoreState): Set<string> => s.selectedKeys;
const selectExpandedKind = (s: MediaStoreState): AssetKind | null => s.expandedKind;
const selectJob = (s: MediaStoreState): JobRecord | null => s.job;
const selectFailuresOpen = (s: MediaStoreState): boolean => s.failuresOpen;

/**
 * 当天 0 点的时间戳（本地时区）。
 *
 * planner 的 \`{date}\` 变量只精确到天，但计划里还带着 \`now\`。完成态那 3 秒里
 * \`now\` 每 250ms 变一次，直接把它当依赖会让整份计划（含几百条 WorkItem）
 * 每 250ms 重算一遍。换成「天」这个量级后，同一天内这个数字不变，
 * useMemo 的依赖比较（Object.is）就稳住了。
 */
function localDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function MediaDownloadPanel({
  snapshot,
  status,
  settings,
  api,
  // 目录状态和当前任务由外壳查好传下来：§9.4 要求面板挂载时只查一次目录，
  // 每个功能自己再查一次就会多触发一次权限探测。
  dir,
  job: jobFromShell,
  rootPath,
}: PanelProps<MediaDownloadSettings>) {
  const mediaStoreRef = useRef<MediaStore | null>(null);
  if (mediaStoreRef.current === null) {
    mediaStoreRef.current = createMediaStore({
      prefs: api.prefs,
      defaultKinds: settings.checkedKinds,
    });
  }
  const store = mediaStoreRef.current;

  /**
   * 按切片订阅（React 19 的 useSyncExternalStore，zustand 的 useStore 就是它的封装）。
   *
   * §10.9 要求「进度每 200ms 更新一次时，只有对应的行和主按钮会重新渲染」。
   * 旧实现是 \`store.subscribe((state) => setSnapshotState(state))\` —— 订阅的是**整棵** store，
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

  const [now, setNow] = useState(() => Date.now());
  /** 提交过程中的状态：让主按钮在等待 bg 回话时也给出可见反馈 */
  const [submitting, setSubmitting] = useState(false);
  /** 提交失败的原因；非空时显示在主按钮下方，绝不静默 */
  const [submitError, setSubmitError] = useState<string | null>(null);
  /**
   * 已经提交、正在等用户在弹出的授权小窗里选目录。
   *
   * 没有它的话，用户点下载 → 弹出小窗 → 面板上仍然是「下载 N 个文件」且照样能点，
   * 看起来就像「点了没反应，还让我再点一次」。
   */
  const [grantPending, setGrantPending] = useState(false);

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

  // 完成态要显示 3 秒再回落（§10.4），这期间需要一个会走的 now。
  // 只在任务已经结束、且在 3 秒窗口内才开定时器 —— 平时不空转，页面里也少一个定时器。
  const needsTick =
    job !== null && (job.status === 'done' || job.status === 'partial' || job.status === 'failed');
  useEffect(() => {
    if (!needsTick) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [needsTick]);

  // 外壳下传的任务作为初始值（§8.2 PanelProps.job）；之后靠 watchJobs 拿实时进度
  useEffect(() => {
    if (jobFromShell !== undefined) store.getState().setJob(jobFromShell ?? null);
  }, [jobFromShell, store]);

  // 订阅这个商品的任务（§8.2 watchJobs）
  const dedupeKey = `${snapshot.platform}:${snapshot.productId}`;
  useEffect(() => {
    return api.watchJobs({ type: 'media-download', dedupeKey }, (record: JobRecord) => {
      store.getState().setJob(record);
    });
  }, [api, dedupeKey, store]);

  // 目录一旦可用（授权完成 / 用户换好目录），就不再算「等授权」
  useEffect(() => {
    if (dir.status === 'ready') {
      setGrantPending(false);
      setSubmitError(null);
    }
  }, [dir.status]);

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
    grantPending,
    now,
  };
  const model = primaryActionModel(actionState);

  const openGrant = (): void => {
    api.dir.openGrant(
      dir.status === 'unset' ? 'unset' : dir.status === 'gone' ? 'gone' : 'needs-grant',
    );
  };

  /**
   * 提交下载：页面侧只发意图，写入计划由 engine 生成（§8.6）。
   *
   * 三个都必须做，少一个就会变成「点了没反应」：
   * 1. **用 ./payload.ts 的同一个 schema 构造载荷**：少了 platformDisplayName 之类的字段，
   *    引擎会整单拒绝；在这里 parse 一次，字段漂移当场就报出来；
   * 2. **处理返回值**：目录没授权时 bg 返回 { waiting: 'dir' } 并去开授权小窗；
   * 3. **把失败留在面板上**：Toast 可能因为外壳没挂载而不可见，所以同时写进 submitError，
   *    由主按钮下方的说明行显示（用户至少能看到「为什么没开始」）。
   */
  const submit = (kinds: readonly AssetKind[], keys?: readonly string[]): void => {
    setSubmitting(true);
    setSubmitError(null);
    void (async () => {
      try {
        const payload = buildMediaDownloadPayload({
          snapshot,
          selection: {
            kinds: [...kinds],
            ...(keys === undefined ? {} : { keys: [...keys] }),
          },
          settings,
        });
        const res = await api.submitJob('media-download', payload, {
          dedupeKey,
          label: `下载 ${snapshot.title}`,
        });
        if (res && 'waiting' in res && res.waiting === 'dir') {
          // bg 已经尝试开过小窗；这里只在它没开成时补一次，并告诉用户去哪儿操作
          setGrantPending(true);
          openGrant();
          api.toast('请在弹出的小窗中选择保存位置');
        }
      } catch (e) {
        // 提交失败必须可见：Toast + 面板内说明行各一份
        const reason = describeSubmitError(e);
        setSubmitError(reason);
        api.toast(reason, {
          action: { label: '重试', run: () => submit(kinds, keys) },
        });
      } finally {
        setSubmitting(false);
      }
    })();
  };

  /**
   * 重试失败项。
   *
   * **不做「静默退化成整单重提」**：引擎返回 null 说明它那边没有这个任务或没有失败项，
   * 这时整单重提会让用户以为自己在重试 1 个失败项，实际重新走了一遍全部素材
   * （并且可能覆盖/跳过一堆本来没问题的文件）。这里明确告诉用户发生了什么，
   * 给一个「重新下载全部」的显式动作，由用户自己决定。
   */
  const retryFailed = (jobId: string): void => {
    void (async () => {
      try {
        const res = await api.retryJob(jobId, 'failed');
        if (res === undefined || res === null) {
          setSubmitError('这些失败项已经不在队列里了，可以重新下载全部');
          api.toast('失败项已失效，可重新下载全部', {
            action: { label: '重新下载', run: () => submit([...checkedKinds]) },
          });
        }
      } catch {
        setSubmitError('重试失败，请重新下载全部');
        api.toast('重试失败，请重新下载全部', {
          action: { label: '重新下载', run: () => submit([...checkedKinds]) },
        });
      }
    })();
  };

  const runAction = (action: PrimaryAction): void => {
    switch (action.kind) {
      case 'submit':
        // 挑选模式只下选中的单张；否则下勾选的类别（§10.4 第 2–4 行）
        submit([...checkedKinds], selectedKeys.size > 0 ? [...selectedKeys] : undefined);
        return;
      case 'resume':
        // 取消 / 中断后「继续下载」：不是重试失败项，而是**重新提交**同一份选择。
        // 已经落盘的文件靠引擎的「同名文件已存在就跳过」自动略过，所以等于续传（§9.11）。
        // 旧实现把 resume 接到了 retryJob 上，没有失败项时 runner 直接返回 null ——
        // 按钮点了什么都不发生。
        submit([...checkedKinds]);
        return;
      case 'retry-failed':
        if (job === null) {
          submit([...checkedKinds]);
          return;
        }
        void retryFailed(job.id);
        return;
      case 'verify':
        // 历史记录没了之后主按钮不会再给出 verify，保留这一支只为兼容旧的 model 值：
        // 语义和 submit 一样，都是重新提交同一份选择。
        submit([...checkedKinds]);
        return;
      case 'open-grant':
        openGrant();
        return;
      case 'cancel':
        if (job !== null) void api.cancelJob(job.id);
        return;
      case 'show-failures':
        store.getState().setFailuresOpen(true);
        return;
      case 'none':
      case 'cancel-grant':
        return;
    }
  };

  const folderPreview = useMemo(() => {
    // 模板缺少 {id} 这类错误应该在设置页拦掉；这里退回只显示平台名，至少不是空白
    if (planForKinds === null) return platformName;
    return previewFolderPath(planForKinds);
  }, [planForKinds, platformName]);

  // 每一类里「已存在、这次跳过」的数量（§10.4 素材行的「✓ N · 已存在」）
  const skippedByKind = useMemo(() => {
    const out: Partial<Record<AssetKind, number>> = {};
    if (job === null) return out;
    for (const kind of KIND_ORDER) {
      const group = job.byGroup[kind];
      if (group !== undefined && group.skipped > 0) out[kind] = group.skipped;
    }
    return out;
  }, [job]);

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

  return (
    <div>
      <AssetList
        byKind={byKind}
        skippedByKind={skippedByKind}
        checkedKinds={checkedKinds}
        selectedKeys={selectedKeys}
        expandedKind={expandedKind}
        resolving={status === 'resolving'}
        job={job}
        skuLabels={skuLabels}
        onToggleCheck={onToggleCheck}
        onToggleAll={onToggleAll}
        allChecked={allChecked}
        onDownloadKind={(kind) => submit([kind])}
        onRetryKind={() => {
          if (job === null) return;
          void retryFailed(job.id);
        }}
        onExpand={onExpand}
        onToggleKey={onToggleKey}
        onSelectAllIn={onSelectAllIn}
        onClearIn={onClearIn}
      />

      <SaveBar
        dir={dir}
        relativePath={folderPreview}
        {...(rootPath === undefined ? {} : { rootPath })}
        onOpenGrant={openGrant}
        onCopy={(text) => void api.copy(text)}
      />

      <PrimaryActionView
        model={model}
        onAction={runAction}
        submitting={submitting}
        errorText={submitError}
        {...(job === null ? {} : { bytes: job.bytes })}
      />

      {failuresOpen && job !== null && job.failed.length > 0 ? (
        <FailureList
          items={job.failed.map((f: { itemKey: string; code: ErrorCode }) => ({
            itemKey: f.itemKey,
            code: f.code,
          }))}
          onRetry={(_itemKey) => {
            /**
             * 单项重试和「重试全部」结果相同：引擎的重试单位是**任务**（runner.retry 只接受
             * jobId），没有「只重跑某一个 itemKey」的接口。与其假装支持，不如把文案说清楚 ——
             * FailureList 的单项按钮改成「重试失败项」，点哪一个都是重跑这一批。
             * 真要做逐项重试，得先给 JobTypeDef 加一个「按 itemKey 过滤计划」的入口。
             */
            if (job === null) return;
            retryFailed(job.id);
          }}
          onRetryAll={() => {
            if (job === null) return;
            retryFailed(job.id);
          }}
          onClose={() => store.getState().setFailuresOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** 把手角标（§8.5 handleBadge 插槽）：可下载的素材总数 */
export function mediaBadge(snap: ProductSnapshot): number {
  return snap.assets.length;
}

/**
 * popup 和快捷键用的快捷操作（§8.5 quickActions、§8.6）。
 * 文案遵守 §10.7：动词开头带数量由调用方补（数量在 popup 里按快照算）。
 */
export function mediaQuickActions(snap: ProductSnapshot): QuickAction[] {
  const kinds: AssetKind[] = ['main', 'sku', 'detail', 'video'];
  // 一次遍历替代四次 filter：popup 打开时对每个商品都要算一遍
  const counts = countByKind(snap);
  const countOf = (kind: AssetKind): number => counts[kind];

  // 快捷入口拿不到功能设置，用默认值构造**完整**载荷：同样过一遍共享 schema，
  // 字段不会漏（旧实现就是在这里漏掉了引擎必需的字段）。
  const submitKinds = (api: PageApi, selected: AssetKind[]): void => {
    void api.submitJob(
      'media-download',
      buildMediaDownloadPayload({
        snapshot: snap,
        selection: { kinds: selected },
        settings: DEFAULT_MEDIA_DOWNLOAD_SETTINGS,
      }),
      { dedupeKey: `${snap.platform}:${snap.productId}`, label: `下载 ${snap.title}` },
    );
  };

  const actions: QuickAction[] = [
    {
      id: 'media-download.all',
      title: `下载全部 ${snap.assets.length} 个素材`,
      run: (api) => submitKinds(api, kinds),
    },
  ];

  for (const kind of kinds) {
    const count = countOf(kind);
    if (count === 0) continue;
    actions.push({
      id: `media-download.${kind}`,
      title: `下载${joinKindLabels([kind])} ${count} 个`,
      run: (api) => submitKinds(api, [kind]),
    });
  }
  return actions;
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

/** 设置页分组（§10.8 文件命名 + 素材两组里属于这个功能的部分） */
export function MediaDownloadSettingsSection({
  value,
  onChange,
}: {
  value: MediaDownloadSettings;
  onChange(next: MediaDownloadSettings): void;
}) {
  const patch = (part: Partial<MediaDownloadSettings>): void => onChange({ ...value, ...part });

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/*
        这一组表单的样式**必须和设置页其它分组完全一致**：一律用 ui-kit 的
        ec-field / ec-input / ec-checkbox，不写任何内联边框和内边距。
        旧实现自己画了一套 1px 灰框的 input，和上下几组的控件长得不一样。
      */}
      <div className="ec-field">
        <span className="ec-field__label">商品文件夹模板</span>
        <input
          className="ec-input"
          type="text"
          value={value.folderTemplate}
          onChange={(e) => patch({ folderTemplate: e.target.value })}
        />
        {/* 模板必须含 {id}（ADR-6），缺少时立刻报错，不要让用户存下一个定位不到的模板 */}
        {templateHasId(value.folderTemplate) ? null : (
          <span className="ec-field__error">模板缺少 {'{id}'}，无法按商品 ID 定位文件夹</span>
        )}
        <span className="ec-field__hint">
          可用变量：{'{platform} {shop:N} {title:N} {id} {date}'}
        </span>
      </div>

      <div className="ec-field">
        <span className="ec-field__label">子文件夹名称</span>
        {(['main', 'sku', 'detail', 'video'] as const).map((kind) => (
          <label
            key={kind}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', marginTop: 4 }}
          >
            <span style={{ width: 60, flex: 'none', color: 'var(--ec-text-2)' }}>
              {kindNameOf(kind)}
            </span>
            <input
              className="ec-input"
              type="text"
              value={value.dirNames[kind]}
              onChange={(e) => patch({ dirNames: { ...value.dirNames, [kind]: e.target.value } })}
            />
          </label>
        ))}
      </div>

      <div className="ec-field">
        <span className="ec-field__label">转换</span>
        <CheckLine
          label="WebP、AVIF 转成 JPG"
          checked={value.toJpeg}
          onChange={(checked) => patch({ toJpeg: checked })}
        />
        <CheckLine
          label="同时下载视频封面"
          checked={value.videoCover}
          onChange={(checked) => patch({ videoCover: checked })}
        />
      </div>

      <div className="ec-field">
        <span className="ec-field__label">详情图最小宽度</span>
        {/* 左对齐贴着上方的标题：整行居中会把 96px 的输入框挤到面板中线附近 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            className="ec-input"
            type="number"
            min={0}
            // flex:none 让这个定宽输入框不被这一行拉伸，96px 就是它最终的宽度
            style={{ width: 96, flex: 'none' }}
            value={value.detailMinWidth}
            onChange={(e) => patch({ detailMinWidth: Number(e.target.value) || 0 })}
          />
          <span className="ec-field__hint">px</span>
        </div>
        <span className="ec-field__hint">窄于这个宽度的详情图不会下载，0 表示不限制。</span>
      </div>
    </div>
  );
}

function kindNameOf(kind: AssetKind): string {
  return { main: '主图', sku: 'SKU 图', detail: '详情图', video: '视频' }[kind];
}

const mediaDownloadPage: PageFeature<MediaDownloadSettings> = {
  Panel: MediaDownloadPanel,
  badge: mediaBadge,
  quickActions: mediaQuickActions,
  SettingsSection: MediaDownloadSettingsSection,
};

export default mediaDownloadPage;

/**
 * 一行「复选框 + 文字」，整行可点。
 *
 * 为什么不用 <label>：Radix 的 Checkbox 渲染的是 <button role="checkbox">，
 * <label> 关联不到它（点文字不会切换，biome 也会报 noLabelWithoutControl）。
 * 这里把文字交给 Checkbox 自己的可访问名字，再用一个真 <button> 承担点击 ——
 * 键盘用户 Tab 到复选框，鼠标用户点哪儿都行。
 */
function CheckLine({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
      <Checkbox label={label} checked={checked} onCheckedChange={onChange} />
      <button
        type="button"
        onClick={() => onChange(!checked)}
        style={{
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: 'var(--ec-text)',
          fontFamily: 'inherit',
          fontSize: 'var(--ec-fs-13)',
          lineHeight: '20px',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
    </div>
  );
}
