import { useCallback, useState } from 'react';
import type { JobRecord } from '../../../kernel/jobs/types';
import type { DirState } from '../../../kernel/messaging/protocol';
import type { AssetKind } from '../../../kernel/model/asset';
import type { ProductSnapshot } from '../../../kernel/model/product';
import type { PageApi } from '../../types';
import type { MediaStore } from '../media-store';
import { buildMediaDownloadPayload } from '../payload';
import type { PrimaryAction } from '../primary-action-model';
import type { MediaDownloadSettings } from '../settings';
import { describeSubmitError } from './panel-derived';

/**
 * 面板能发出去的动作：提交、重试失败项、执行主按钮给出的 action。
 *
 * 为什么单独成 hook：这些函数原来和 §10.9 的订阅/派生混在一个函数体里，
 * 加起来 200 多行，改一处要先读懂整块。它们现在只依赖「当前快照 / 设置 / 目录」，
 * 和每 200ms 推一次的进度无关 —— 所以即使 job 每 200ms 变一次，
 * submit / retryFailed 的引用仍然稳定，memo 过的素材行不会白重渲染。
 */

export interface MediaActionsArgs {
  snapshot: ProductSnapshot;
  settings: MediaDownloadSettings;
  api: PageApi;
  /** 任务去重键：平台 + 商品 ID（§8.2） */
  dedupeKey: string;
  /** 目录状态：openGrant 要按它区分 unset / gone / needs-grant */
  dir: DirState;
  store: MediaStore;
  checkedKinds: ReadonlySet<AssetKind>;
  selectedKeys: ReadonlySet<string>;
  /** 当前任务：只在「重试失败项」和「取消」里用到 */
  job: JobRecord | null;
}

export interface MediaActions {
  /** 正在等 bg 回话：主按钮显示「正在提交…」 */
  submitting: boolean;
  /** 提交失败的原因；非空时显示在主按钮下方，绝不静默 */
  submitError: string | null;
  /**
   * 已经提交、正在等用户在弹出的授权小窗里选目录。
   *
   * 注意这里只记录「提交时发现要授权」这件事，**是否真的还在等**由面板在渲染期
   * 结合目录状态算出来（目录已 ready 就不再等）：那比在 effect 里回写 state 更准，
   * 也不会多付一次渲染。
   */
  grantPending: boolean;
  submit(kinds: readonly AssetKind[], keys?: readonly string[]): void;
  retryFailed(jobId: string): void;
  runAction(action: PrimaryAction): void;
  openGrant(): void;
}

/** 目录状态 → 授权小窗的打开理由（§9.4） */
function grantReason(dir: DirState): 'unset' | 'needs-grant' | 'gone' {
  return dir.status === 'unset' ? 'unset' : dir.status === 'gone' ? 'gone' : 'needs-grant';
}

export function useMediaActions(args: MediaActionsArgs): MediaActions {
  const { snapshot, settings, api, dedupeKey, dir, store, checkedKinds, selectedKeys, job } = args;

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [grantPending, setGrantPending] = useState(false);

  /**
   * 目录一旦可用（授权完成 / 用户换好目录），就不再算「等授权」，同时清掉上一次的失败说明。
   *
   * 旧写法是 useEffect(() => { if (dir.status === 'ready') { setGrantPending(false); setSubmitError(null); } }, [dir.status]) ——
   * 正是 React 文档点名的「prop 变化后回写 state」反模式：先提交一帧旧状态，再立刻重渲染一次。
   * 这里换成 React 同一节给出的收敛写法：记住上一次的目录状态，在渲染期间比较，
   * 需要调整时把「上一次」和要调整的 state **一起**写掉。
   * 收敛性：分支执行后 prevDirStatus === dir.status，同一次渲染不会再进第二次；
   * 之后只有 dir.status 真的变化才会再进 —— 和原来 effect 的触发条件（只认变化）完全一致，
   * 所以 dir 一直是 ready 时不会被反复清掉（那会让「等待选择文件夹」这个态永远看不到）。
   */
  const [prevDirStatus, setPrevDirStatus] = useState(dir.status);
  if (prevDirStatus !== dir.status) {
    setPrevDirStatus(dir.status);
    if (dir.status === 'ready') {
      setGrantPending(false);
      setSubmitError(null);
    }
  }

  const openGrant = useCallback((): void => {
    api.dir.openGrant(grantReason(dir));
  }, [api, dir]);

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
  const submit = useCallback(
    (kinds: readonly AssetKind[], keys?: readonly string[]): void => {
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
    },
    [snapshot, settings, api, dedupeKey, openGrant],
  );

  /**
   * 重试失败项。
   *
   * **不做「静默退化成整单重提」**：引擎返回 null 说明它那边没有这个任务或没有失败项，
   * 这时整单重提会让用户以为自己在重试 1 个失败项，实际重新走了一遍全部素材
   * （并且可能覆盖/跳过一堆本来没问题的文件）。这里明确告诉用户发生了什么，
   * 给一个「重新下载全部」的显式动作，由用户自己决定。
   */
  const retryFailed = useCallback(
    (jobId: string): void => {
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
    },
    [api, checkedKinds, submit],
  );

  const runAction = useCallback(
    (action: PrimaryAction): void => {
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
          retryFailed(job.id);
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
    },
    [api, checkedKinds, job, openGrant, retryFailed, selectedKeys, store, submit],
  );

  return {
    submitting,
    submitError,
    grantPending,
    submit,
    retryFailed,
    runAction,
    openGrant,
  };
}
