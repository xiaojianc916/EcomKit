import { useEffect, useState } from 'react';
import type { JobRecord } from '../../../kernel/jobs/types';
import type { PageApi } from '../../types';
import { createMediaStore, type MediaStore } from '../media-store';
import type { MediaDownloadSettings } from '../settings';

/**
 * 面板私有的 media store（§10.9）。
 *
 * 旧实现在渲染期用 ref 兜「首次渲染建一次」：
 * `if (ref.current === null) ref.current = createMediaStore(...)`。
 * 渲染期写 ref 是 React 明确反对的（渲染可能被重放或丢弃，写进去的东西会跟着泄漏），
 * 而 useState 的惰性初始化语义完全一样 —— 初始化函数只跑第一次渲染 —— 且渲染本身保持纯净。
 *
 * 注意 createMediaStore 只把 prefs / defaultKinds 当**初值**读一次：
 * 之后 settings.checkedKinds 变化不该重建 store，否则用户刚勾好的类别会被设置项盖掉
 * （勾选是全局偏好，§10.3）。
 */
export function useMediaStore(api: PageApi, settings: MediaDownloadSettings): MediaStore {
  const [store] = useState(() =>
    createMediaStore({ prefs: api.prefs, defaultKinds: settings.checkedKinds }),
  );
  return store;
}

export interface MediaJobSyncArgs {
  store: MediaStore;
  api: PageApi;
  dedupeKey: string;
  /** 当前任务（镜像，来自 store 切片）；完成态计时要用它的状态 */
  job: JobRecord | null;
  /** 外壳下传的任务（PanelProps.job）；undefined 表示外壳没给，null 表示「这个商品没有任务」 */
  jobFromShell: JobRecord | null | undefined;
}

/**
 * 把 bg 的任务镜像同步进 store，并在「完成态」那 3 秒里提供一个会走的 now（§8.2、§10.4）。
 *
 * 返回 now：只有任务已经结束、且在 3 秒窗口内才开定时器 —— 平时不空转，页面里也少一个定时器。
 */
export function useMediaJobSync({
  store,
  api,
  dedupeKey,
  job,
  jobFromShell,
}: MediaJobSyncArgs): number {
  const [now, setNow] = useState(() => Date.now());

  // 外壳下传的任务作为初始值（§8.2 PanelProps.job）；之后靠 watchJobs 拿实时进度
  useEffect(() => {
    if (jobFromShell !== undefined) store.getState().setJob(jobFromShell ?? null);
  }, [jobFromShell, store]);

  // 订阅这个商品的任务（§8.2 watchJobs）
  useEffect(() => {
    return api.watchJobs({ type: 'media-download', dedupeKey }, (record: JobRecord) => {
      store.getState().setJob(record);
    });
  }, [api, dedupeKey, store]);

  const needsTick =
    job !== null && (job.status === 'done' || job.status === 'partial' || job.status === 'failed');
  useEffect(() => {
    if (!needsTick) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [needsTick]);

  return now;
}
