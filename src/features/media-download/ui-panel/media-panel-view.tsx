import type { ErrorCode } from '../../../kernel/errors/codes';
import type { JobRecord } from '../../../kernel/jobs/types';
import type { DirState } from '../../../kernel/messaging/protocol';
import type { Asset, AssetKind } from '../../../kernel/model/asset';
import type { MediaStore } from '../media-store';
import type { PrimaryActionModel } from '../primary-action-model';
import { AssetList } from '../ui/AssetList';
import { FailureList } from '../ui/FailureList';
import { PrimaryActionView } from '../ui/PrimaryAction';
import { SaveBar } from '../ui/SaveBar';
import type { MediaActions } from './use-media-actions';

/**
 * 面板的**静态骨架**：素材清单 → 保存位置 → 主按钮 → 失败详情。
 *
 * 这里只做布局：顺序、间距、以及「什么条件下出现哪一块」。
 * 所有状态、副作用和动作都在 useMediaPanel / useMediaActions 里，
 * 所有文案规则都在 primary-action-model 的纯函数里。
 * 拆出来的目的不只是行数：进度每 200ms 推一次时，这一层拿到的 props
 * 大部分引用没变，React 只需要重跑这一层，素材行和缩略图网格照旧被 memo 挡住。
 */
export interface MediaPanelViewProps {
  byKind: Record<AssetKind, Asset[]>;
  skippedByKind: Partial<Record<AssetKind, number>>;
  checkedKinds: ReadonlySet<AssetKind>;
  selectedKeys: ReadonlySet<string>;
  expandedKind: AssetKind | null;
  resolving: boolean;
  job: JobRecord | null;
  skuLabels: ReadonlyMap<string, string>;
  allChecked: boolean;

  dir: DirState;
  folderPreview: string;
  rootPath: string | undefined;

  model: PrimaryActionModel;
  submitting: boolean;
  submitError: string | null;
  /** 进度态下主按钮区的体积文案；没有任务时不传 */
  bytes: number | undefined;

  failuresOpen: boolean;
  store: MediaStore;
  actions: Pick<MediaActions, 'runAction' | 'retryFailed' | 'openGrant' | 'submit'>;
  onCopy(text: string): void;

  onToggleCheck(kind: AssetKind): void;
  onToggleAll(): void;
  onExpand(kind: AssetKind): void;
  onToggleKey(kind: AssetKind, key: string): void;
  onSelectAllIn(kind: AssetKind): void;
  onClearIn(): void;
}

export function MediaPanelView(props: MediaPanelViewProps) {
  const {
    byKind,
    skippedByKind,
    checkedKinds,
    selectedKeys,
    expandedKind,
    resolving,
    job,
    skuLabels,
    allChecked,
    dir,
    folderPreview,
    rootPath,
    model,
    submitting,
    submitError,
    bytes,
    failuresOpen,
    store,
    actions,
    onCopy,
    onToggleCheck,
    onToggleAll,
    onExpand,
    onToggleKey,
    onSelectAllIn,
    onClearIn,
  } = props;

  return (
    <div>
      <AssetList
        byKind={byKind}
        skippedByKind={skippedByKind}
        checkedKinds={checkedKinds}
        selectedKeys={selectedKeys}
        expandedKind={expandedKind}
        resolving={resolving}
        job={job}
        skuLabels={skuLabels}
        onToggleCheck={onToggleCheck}
        onToggleAll={onToggleAll}
        allChecked={allChecked}
        // 行内「下载」只提交这一类（§10.3），和勾选状态无关
        onDownloadKind={(kind) => actions.submit([kind])}
        onRetryKind={() => {
          if (job === null) return;
          actions.retryFailed(job.id);
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
        onOpenGrant={actions.openGrant}
        onCopy={onCopy}
      />

      <PrimaryActionView
        model={model}
        onAction={actions.runAction}
        submitting={submitting}
        errorText={submitError}
        {...(bytes === undefined ? {} : { bytes })}
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
            actions.retryFailed(job.id);
          }}
          onRetryAll={() => {
            if (job === null) return;
            actions.retryFailed(job.id);
          }}
          onClose={() => store.getState().setFailuresOpen(false)}
        />
      ) : null}
    </div>
  );
}
