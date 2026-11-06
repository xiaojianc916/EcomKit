import { createStore, type StoreApi } from 'zustand/vanilla';
import type { JobRecord } from '../../kernel/jobs/types';
import type { AssetKind } from '../../kernel/model/asset';

/**
 * 功能私有状态（§10.9 的 mediaStore）。
 *
 * 持久化边界（方案表格里写死的）：
 * - **勾选的类别 → 全局持久化**：§10.3「勾选状态是全局偏好，以后所有商品都按这个默认勾选」
 *   （比如永远不要视频）。
 * - **挑选模式选的 key → 不持久化**：它是「这个商品这次要下哪几张小图」的临时选择，
 *   换商品就该清空；持久化会让用户下次打开时莫名其妙少下几张。
 * - **展开的类别 → 不持久化**：换个商品还展开着上次那一类没有意义。
 * - **当前任务 → 不持久化**：真值在 bg/offscreen，这里只是镜像。
 *
 * 持久化的那一项通过注入的 PrefsPort 写，不在这个模块里碰 chrome.storage，
 * 这样组件测试和单测都能用内存实现。
 */

export interface MediaPrefsPort {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

/** 全局偏好里保存的键（功能私有 UI 偏好，不是 feature settings） */
export const CHECKED_KINDS_PREF = 'media-download.checkedKinds';
export const EXPANDED_KIND_PREF = 'media-download.expandedKind';

export interface MediaStoreState {
  /** 全局勾选的类别 */
  checkedKinds: Set<AssetKind>;
  /** 挑选模式选中的素材 key（跨类别，不持久化） */
  selectedKeys: Set<string>;
  /** 当前展开的类别；同一时间只展开一类（§10.3） */
  expandedKind: AssetKind | null;
  /** 当前商品的任务（镜像，真值在 bg/offscreen） */
  job: JobRecord | null;
  /** 是否展开失败列表（§10.5 失败详情，面板内展开，不用弹窗） */
  failuresOpen: boolean;
}

export interface MediaStoreActions {
  toggleKind(kind: AssetKind): void;
  setCheckedKinds(kinds: Iterable<AssetKind>): void;
  /** 「全选 / 全不选」：有素材的类别全选，否则全不选 */
  toggleAll(nonEmptyKinds: readonly AssetKind[]): void;
  toggleKey(kind: AssetKind, key: string): void;
  /** 网格工具条「全选」：只勾这一类的全部 */
  selectAllIn(kind: AssetKind, keys: readonly string[]): void;
  /** 网格工具条「清除」：回到按类别下载的状态 */
  clearSelection(): void;
  /** 只清空某一类的挑选（切展开类别时不自动清） */
  clearKindSelection(): void;
  expand(kind: AssetKind | null): void;
  setJob(job: JobRecord | null): void;
  setFailuresOpen(open: boolean): void;
  /** 进入挑选模式：从按类别下载转成按单张下载 */
  enterPicking(keys: Iterable<string>): void;
}

export type MediaStore = StoreApi<MediaStoreState & MediaStoreActions>;

export interface CreateMediaStoreOptions {
  prefs: MediaPrefsPort;
  /** feature settings 里的默认勾选类别（§11 checkedKinds） */
  defaultKinds: readonly AssetKind[];
}

function readChecked(prefs: MediaPrefsPort, fallback: readonly AssetKind[]): Set<AssetKind> {
  const raw = prefs.get<string[]>(CHECKED_KINDS_PREF);
  const list = Array.isArray(raw) ? raw : fallback;
  return new Set(
    list.filter(
      (k): k is AssetKind => k === 'main' || k === 'sku' || k === 'detail' || k === 'video',
    ),
  );
}

export function createMediaStore(opts: CreateMediaStoreOptions): MediaStore {
  const { prefs, defaultKinds } = opts;

  const persistChecked = (kinds: Set<AssetKind>): void => {
    prefs.set(CHECKED_KINDS_PREF, [...kinds]);
  };

  return createStore<MediaStoreState & MediaStoreActions>()((set, get) => ({
    checkedKinds: readChecked(prefs, defaultKinds),
    selectedKeys: new Set<string>(),
    expandedKind: null,
    job: null,
    failuresOpen: false,

    toggleKind(kind) {
      const next = new Set(get().checkedKinds);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      set({ checkedKinds: next });
      // 勾选状态是全局偏好（§10.3）
      persistChecked(next);
    },

    setCheckedKinds(kinds) {
      const next = new Set(kinds);
      set({ checkedKinds: next });
      persistChecked(next);
    },

    toggleAll(nonEmptyKinds) {
      // 空数组时 [].every(...) === true，会被当成「全都勾着」去执行清空 ——
      // 没有可勾的类别时什么都不做，而不是把用户已经勾上的类别清掉。
      if (nonEmptyKinds.length === 0) return;
      const current = get().checkedKinds;
      const all = nonEmptyKinds.every((k) => current.has(k));
      const next = all ? new Set<AssetKind>() : new Set(nonEmptyKinds);
      set({ checkedKinds: next });
      persistChecked(next);
    },

    toggleKey(_kind, key) {
      const next = new Set(get().selectedKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      set({ selectedKeys: next });
    },

    selectAllIn(_kind, keys) {
      const next = new Set(get().selectedKeys);
      for (const key of keys) next.add(key);
      set({ selectedKeys: next });
    },

    clearSelection() {
      set({ selectedKeys: new Set<string>() });
    },

    clearKindSelection() {
      set({ selectedKeys: new Set<string>() });
    },

    expand(kind) {
      // 同一时间只展开一类，再点一次收起（§10.3 素材行交互）
      const current = get().expandedKind;
      const next = current === kind ? null : kind;
      set({ expandedKind: next });
      // 收起时清掉挑选：否则用户看不到是哪些被选着，主按钮却还写着「下载所选 3 个」
      if (next === null) set({ selectedKeys: new Set<string>() });
    },

    setJob(job) {
      set({ job });
    },

    setFailuresOpen(open) {
      set({ failuresOpen: open });
    },

    enterPicking(keys) {
      set({ selectedKeys: new Set(keys) });
    },
  }));
}

/** 挑选模式是否生效：有选中的单张素材（§10.4 主按钮第 4 行） */
export function isPicking(state: Pick<MediaStoreState, 'selectedKeys'>): boolean {
  return state.selectedKeys.size > 0;
}

/**
 * 退出挑选模式的判定：当前选中的 key 都不在快照里了（换商品、平台改版），
 * 或者用户点了清除。返回 true 时由调用方清空 selection。
 */
export function isSelectionStale(
  selectedKeys: ReadonlySet<string>,
  availableKeys: ReadonlySet<string>,
): boolean {
  if (selectedKeys.size === 0) return false;
  for (const key of selectedKeys) {
    if (availableKeys.has(key)) return false;
  }
  return true;
}
