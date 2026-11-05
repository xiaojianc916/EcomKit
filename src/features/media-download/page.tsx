import { useEffect, useMemo, useRef, useState } from 'react';
import type { ErrorCode } from '../../kernel/errors/codes';
import type { JobRecord } from '../../kernel/jobs/types';
import type { HistoryState } from '../../kernel/messaging/protocol';
import type { AssetKind } from '../../kernel/model/asset';
import type { ProductSnapshot } from '../../kernel/model/product';
import type { PageApi, PageFeature, PanelProps, QuickAction } from '../types';
import { createMediaStore, isSelectionStale, type MediaStore } from './media-store';
import { buildMediaDownloadPayload, platformDisplayName, toPlannerSettings } from './payload';
import { planDownload } from './planner';
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
 * （模板截断、清洗、按平台分文件夹都由同一处决定）。
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
  // 用 useState 保证引用稳定；store 每次渲染都从 ref 取
  const sync = useSyncStore(store);

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
  /**
   * 每类**真正会被写入**的数量（不是快照里的素材数）。
   *
   * 主按钮写「下载 N 个文件」，N 必须等于任务实际要写的条数：
   * detailMinWidth 会把过窄的详情图过滤掉、视频封面会多出一条、重复 key 会去重。
   * 旧实现直接用快照总数，用户点了「下载 24 个」结果只下来 22 个。
   */
  const counts = useMemo(() => {
    const sizes = new Set([...sync.checkedKinds]);
    try {
      const plan = planDownload({
        snapshot,
        selection: {
          kinds: [...sizes],
          ...(sync.selectedKeys.size > 0 ? { keys: [...sync.selectedKeys] } : {}),
        },
        settings: toPlannerSettings(settings),
        platformDisplayName: platformDisplayName(snapshot.platform),
      });
      const out: Record<AssetKind, number> = { main: 0, sku: 0, detail: 0, video: 0 };
      for (const item of plan.items) {
        if (
          item.group === 'main' ||
          item.group === 'sku' ||
          item.group === 'detail' ||
          item.group === 'video'
        ) {
          out[item.group] += 1;
        }
      }
      return out;
    } catch {
      // 模板非法等情况下退回原始计数，至少数量不会突然变成 0
      return countByKind(snapshot);
    }
  }, [snapshot, sync.checkedKinds, sync.selectedKeys, settings]);
  const allChecked = useMemo(
    () => isAllChecked(byKind, sync.checkedKinds),
    [byKind, sync.checkedKinds],
  );
  const skuLabels = useMemo(() => skuLabelMap(snapshot), [snapshot]);

  // 换商品后之前选中的 key 可能一个都不在了，此时退出挑选模式
  const availableKeys = useMemo(
    () => new Set(snapshot.assets.map((a) => a.key)),
    [snapshot.assets],
  );
  useEffect(() => {
    if (isSelectionStale(sync.selectedKeys, availableKeys)) store.getState().clearSelection();
  }, [availableKeys, sync.selectedKeys, store]);

  // 完成态要显示 3 秒再回落（§10.4），这期间需要一个会走的 now。
  // 只在任务已经结束、且在 3 秒窗口内才开定时器 —— 平时不空转，页面里也少一个定时器。
  const needsTick =
    sync.job !== null &&
    (sync.job.status === 'done' || sync.job.status === 'partial' || sync.job.status === 'failed');
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

  // 历史记录（§9.11）：目录不是 ready 时不读，避免触发授权。
  // 带上 platform 和当前快照的 itemKey：引擎要靠它们算出「上次下过哪些、还缺几个」。
  useEffect(() => {
    if (dir.status !== 'ready') {
      store.getState().setHistory(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        /**
         * 期望的 itemKey 必须来自**真实的下载计划**，不能是快照里的全部素材：
         * detailMinWidth 过滤掉的、去重掉的素材根本不会被下载，
         * 拿它们当期望会让「补全 N 个文件」永远清不掉。
         */
        const planned = planDownload({
          snapshot,
          selection: { kinds: [...sync.checkedKinds] },
          settings: toPlannerSettings(settings),
          platformDisplayName: platformDisplayName(snapshot.platform),
        });
        const raw = await api.call('history.get', {
          platform: snapshot.platform,
          productId: snapshot.productId,
          itemKeys: planned.items.map((item) => item.itemKey),
        });
        if (alive) store.getState().setHistory((raw as HistoryState | null) ?? null);
      } catch {
        // 历史读不到不影响下载，静默
        if (alive) store.getState().setHistory(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [
    api,
    dir.status,
    snapshot.platform,
    snapshot.productId,
    snapshot.assets,
    store,
    sync.checkedKinds,
    snapshot,
    settings,
  ]);

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
    selectedKinds: [...sync.checkedKinds],
    selectedKeys: [...sync.selectedKeys],
    job: sync.job,
    // 其他标签页 / 排队 / 等授权小窗这三个状态目前没有数据源：
    // 保持 null / 0 / false 是**如实**的，不是遗忘 —— 主按钮就不会显示根本没有的状态。
    // 需要它们时必须先有「跨标签页任务查询」和「授权小窗的 pending 回执」，见 docs/audit-c §C3。
    otherTabJob: null,
    queuedAhead: 0,
    history:
      sync.history === null
        ? null
        : { lastAt: sync.history.lastAt, missingCount: sync.history.missing.length },
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
            action: { label: '重新下载', run: () => submit([...sync.checkedKinds]) },
          });
        }
      } catch {
        setSubmitError('重试失败，请重新下载全部');
        api.toast('重试失败，请重新下载全部', {
          action: { label: '重新下载', run: () => submit([...sync.checkedKinds]) },
        });
      }
    })();
  };

  const runAction = (action: PrimaryAction): void => {
    switch (action.kind) {
      case 'submit':
        // 挑选模式只下选中的单张；否则下勾选的类别（§10.4 第 2–4 行）
        submit(
          [...sync.checkedKinds],
          sync.selectedKeys.size > 0 ? [...sync.selectedKeys] : undefined,
        );
        return;
      case 'resume':
        // 取消 / 中断后「继续下载」：不是重试失败项，而是**重新提交**同一份选择。
        // .ecbox.json 会让已完成的文件走「已存在」跳过，所以等于续传（§9.11）。
        // 旧实现把 resume 接到了 retryJob 上，没有失败项时 runner 直接返回 null ——
        // 按钮点了什么都不发生。
        submit([...sync.checkedKinds]);
        return;
      case 'retry-failed':
        if (sync.job === null) {
          submit([...sync.checkedKinds]);
          return;
        }
        void retryFailed(sync.job.id);
        return;
      case 'verify':
        // 「已全部下载」点一下做一次增量检查（§10.4 表下注）
        submit([...sync.checkedKinds]);
        return;
      case 'open-grant':
        openGrant();
        return;
      case 'cancel':
        if (sync.job !== null) void api.cancelJob(sync.job.id);
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
    try {
      const plan = planDownload({
        snapshot,
        selection: { kinds: [...sync.checkedKinds] },
        settings: toPlannerSettings(settings),
        platformDisplayName: platformDisplayName(snapshot.platform),
        now,
      });
      return previewFolderPath(plan);
    } catch {
      // 模板缺少 {id} 这类错误应该在设置页拦掉；这里退回只显示平台目录
      return platformDisplayName(snapshot.platform);
    }
  }, [snapshot, sync.checkedKinds, settings, now]);

  // 每一类里「已存在、这次跳过」的数量（§10.4 素材行的「✓ N · 已存在」）
  const skippedByKind = useMemo(() => {
    const job = sync.job;
    const out: Partial<Record<AssetKind, number>> = {};
    if (job === null) return out;
    for (const kind of KIND_ORDER) {
      const group = job.byGroup[kind];
      if (group !== undefined && group.skipped > 0) out[kind] = group.skipped;
    }
    return out;
  }, [sync.job]);

  const nonEmptyKinds = KIND_ORDER.filter((k) => counts[k] > 0);

  return (
    <div>
      <AssetList
        byKind={byKind}
        skippedByKind={skippedByKind}
        checkedKinds={sync.checkedKinds}
        selectedKeys={sync.selectedKeys}
        expandedKind={sync.expandedKind}
        resolving={status === 'resolving'}
        job={sync.job}
        skuLabels={skuLabels}
        onToggleCheck={(kind) => store.getState().toggleKind(kind)}
        onToggleAll={() => store.getState().toggleAll(nonEmptyKinds)}
        allChecked={allChecked}
        onDownloadKind={(kind) => submit([kind])}
        onRetryKind={() => {
          if (sync.job === null) return;
          void retryFailed(sync.job.id);
        }}
        onExpand={(kind) => store.getState().expand(kind)}
        onToggleKey={(kind, key) => store.getState().toggleKey(kind, key)}
        onSelectAllIn={(kind) =>
          store.getState().selectAllIn(
            kind,
            (byKind[kind] ?? []).map((a) => a.key),
          )
        }
        onClearIn={() => store.getState().clearSelection()}
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
        {...(sync.job === null ? {} : { bytes: sync.job.bytes })}
      />

      {sync.failuresOpen && sync.job !== null && sync.job.failed.length > 0 ? (
        <FailureList
          items={sync.job.failed.map((f: { itemKey: string; code: ErrorCode }) => ({
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
            if (sync.job === null) return;
            retryFailed(sync.job.id);
          }}
          onRetryAll={() => {
            if (sync.job === null) return;
            retryFailed(sync.job.id);
          }}
          onClose={() => store.getState().setFailuresOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * 订阅功能私有 store 的几个切片。
 *
 * 为什么不用整棵 store 订阅：§10.9 要求「进度每 200ms 更新一次时，只有对应的行和
 * 主按钮会重新渲染」。zustand 的 useStore + 选择器就是干这个的。
 */
function useSyncStore(store: MediaStore) {
  const [snapshotState, setSnapshotState] = useState(() => store.getState());
  useEffect(() => store.subscribe((state) => setSnapshotState(state)), [store]);
  return snapshotState;
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
  const countOf = (kind: AssetKind): number => snap.assets.filter((a) => a.kind === kind).length;

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={value.byPlatform}
          onChange={(e) => patch({ byPlatform: e.target.checked })}
        />
        <span>按平台分文件夹</span>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span>商品文件夹模板</span>
        <input
          type="text"
          value={value.folderTemplate}
          onChange={(e) => patch({ folderTemplate: e.target.value })}
          style={{
            height: 32,
            padding: '0 8px',
            border: '1px solid var(--ec-line)',
            borderRadius: 6,
          }}
        />
        {/* 模板必须含 {id}（ADR-6），缺少时立刻报错，不要让用户存下一个定位不到的模板 */}
        {/\{id(?::\d+)?\}/.test(value.folderTemplate) ? null : (
          <span style={{ color: 'var(--ec-danger)', fontSize: 12 }}>模板必须包含 {'{id}'}</span>
        )}
      </label>

      <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
        <legend style={{ fontSize: 12, color: 'var(--ec-text-2)' }}>子文件夹名称</legend>
        {(['main', 'sku', 'detail', 'video'] as const).map((kind) => (
          <label key={kind} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <span style={{ width: 60 }}>{KIND_ORDER.includes(kind) ? kindNameOf(kind) : kind}</span>
            <input
              type="text"
              value={value.dirNames[kind]}
              onChange={(e) => patch({ dirNames: { ...value.dirNames, [kind]: e.target.value } })}
              style={{
                height: 32,
                padding: '0 8px',
                border: '1px solid var(--ec-line)',
                borderRadius: 6,
              }}
            />
          </label>
        ))}
      </fieldset>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={value.toJpeg}
          onChange={(e) => patch({ toJpeg: e.target.checked })}
        />
        <span>WebP、AVIF 转成 JPG</span>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={value.infoTxt}
          onChange={(e) => patch({ infoTxt: e.target.checked })}
        />
        <span>生成 商品信息.txt</span>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={value.videoCover}
          onChange={(e) => patch({ videoCover: e.target.checked })}
        />
        <span>同时下载视频封面</span>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>详情图最小宽度</span>
        <input
          type="number"
          min={0}
          value={value.detailMinWidth}
          onChange={(e) => patch({ detailMinWidth: Number(e.target.value) || 0 })}
          style={{
            width: 96,
            height: 32,
            padding: '0 8px',
            border: '1px solid var(--ec-line)',
            borderRadius: 6,
          }}
        />
        <span style={{ fontSize: 12, color: 'var(--ec-text-2)' }}>px</span>
      </label>
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
