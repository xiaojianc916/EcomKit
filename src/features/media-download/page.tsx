import { useEffect, useMemo, useRef, useState } from 'react';
import type { ErrorCode } from '../../kernel/errors/codes';
import type { JobRecord } from '../../kernel/jobs/types';
import type { HistoryState } from '../../kernel/messaging/protocol';
import type { AssetKind } from '../../kernel/model/asset';
import type { ProductSnapshot } from '../../kernel/model/product';
import type { PageFeature, PanelProps, QuickAction } from '../types';
import { createMediaStore, isSelectionStale, type MediaStore } from './media-store';
import { type PlannerSettings, planDownload } from './planner';
import {
  joinKindLabels,
  KIND_ORDER,
  type PrimaryAction,
  type PrimaryActionState,
  primaryActionModel,
} from './primary-action-model';
import type { MediaDownloadSettings } from './settings';
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

/** 平台显示名（目录和文案都用平台的叫法，§10.7 第 4 条） */
export const PLATFORM_NAMES: Record<string, string> = {
  pinduoduo: '拼多多',
  douyin: '抖音',
};

export function platformDisplayName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

/** 把 feature settings 转成 planner 需要的形状 */
export function toPlannerSettings(settings: MediaDownloadSettings): PlannerSettings {
  return {
    byPlatform: settings.byPlatform,
    folderTemplate: settings.folderTemplate,
    dirNames: {
      main: settings.dirNames.main,
      sku: settings.dirNames.sku,
      detail: settings.dirNames.detail,
      video: settings.dirNames.video,
    },
    infoTxt: settings.infoTxt,
    videoCover: settings.videoCover,
    detailMinWidth: settings.detailMinWidth,
  };
}

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

  const byKind = useMemo(() => groupAssetsByKind(snapshot.assets), [snapshot.assets]);
  const counts = useMemo(() => countByKind(snapshot), [snapshot]);
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

  // 历史记录（§9.11）：目录不是 ready 时不读，避免触发授权
  useEffect(() => {
    if (dir.status !== 'ready') {
      store.getState().setHistory(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const raw = await api.call('history.get', { productId: snapshot.productId });
        if (alive) store.getState().setHistory((raw as HistoryState | null) ?? null);
      } catch {
        // 历史读不到不影响下载，静默
        if (alive) store.getState().setHistory(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, dir.status, snapshot.productId, store]);

  const actionState: PrimaryActionState = {
    status: status === 'resolving' ? 'resolving' : 'ready',
    dir: dir.status,
    counts,
    selectedKinds: [...sync.checkedKinds],
    selectedKeys: [...sync.selectedKeys],
    job: sync.job,
    otherTabJob: null,
    queuedAhead: 0,
    history:
      sync.history === null
        ? null
        : { lastAt: sync.history.lastAt, missingCount: sync.history.missing.length },
    grantPending: false,
    now,
  };
  const model = primaryActionModel(actionState);

  const openGrant = (): void => {
    api.dir.openGrant(
      dir.status === 'unset' ? 'unset' : dir.status === 'gone' ? 'gone' : 'needs-grant',
    );
  };

  /** 提交下载：页面侧只发意图，写入计划由 engine 生成（§8.6） */
  const submit = (kinds: readonly AssetKind[], keys?: readonly string[]): void => {
    void api.submitJob(
      'media-download',
      {
        snapshot,
        selection: { kinds: [...kinds], ...(keys === undefined ? {} : { keys: [...keys] }) },
        settings,
      },
      { dedupeKey, label: `下载 ${snapshot.title}` },
    );
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
      case 'retry-failed':
        if (sync.job !== null) void api.retryJob(sync.job.id, 'failed');
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

  const nonEmptyKinds = KIND_ORDER.filter((k) => counts[k] > 0);

  return (
    <div>
      <AssetList
        byKind={byKind}
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
          if (sync.job !== null) void api.retryJob(sync.job.id, 'failed');
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
        onOpenGrant={openGrant}
        onCopy={(text) => void api.copy(text)}
      />

      <PrimaryActionView
        model={model}
        onAction={runAction}
        {...(sync.job === null ? {} : { bytes: sync.job.bytes })}
      />

      {sync.failuresOpen && sync.job !== null && sync.job.failed.length > 0 ? (
        <FailureList
          items={sync.job.failed.map((f: { itemKey: string; code: ErrorCode }) => ({
            itemKey: f.itemKey,
            code: f.code,
          }))}
          onRetry={() => {
            if (sync.job !== null) void api.retryJob(sync.job.id, 'failed');
          }}
          onRetryAll={() => {
            if (sync.job !== null) void api.retryJob(sync.job.id, 'failed');
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

  const actions: QuickAction[] = [
    {
      id: 'media-download.all',
      title: `下载全部 ${snap.assets.length} 个素材`,
      run: (api) => void api.submitJob('media-download', { snapshot: snap, selection: { kinds } }),
    },
  ];

  for (const kind of kinds) {
    const count = countOf(kind);
    if (count === 0) continue;
    actions.push({
      id: `media-download.${kind}`,
      title: `下载${joinKindLabels([kind])} ${count} 个`,
      run: (api) =>
        void api.submitJob('media-download', { snapshot: snap, selection: { kinds: [kind] } }),
    });
  }
  return actions;
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
