import { describe, expect, it } from 'vitest';
import {
  CHECKED_KINDS_PREF,
  createMediaStore,
  isPicking,
  isSelectionStale,
  type MediaPrefsPort,
} from './media-store';

function memoryPrefs(): MediaPrefsPort & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get<T>(key: string): T | undefined {
      return data.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      data.set(key, value);
    },
  };
}

const ALL = ['main', 'sku', 'detail', 'video'] as const;

describe('createMediaStore 勾选类别（§10.3 全局偏好）', () => {
  it('没有存过的偏好时用 feature settings 的默认值', () => {
    const store = createMediaStore({ prefs: memoryPrefs(), defaultKinds: ['main'] });
    expect([...store.getState().checkedKinds]).toEqual(['main']);
  });

  it('存过的偏好优先于默认值', () => {
    const prefs = memoryPrefs();
    prefs.set(CHECKED_KINDS_PREF, ['main', 'video']);
    const store = createMediaStore({ prefs, defaultKinds: ['main'] });
    expect([...store.getState().checkedKinds]).toEqual(['main', 'video']);
  });

  it('切换一个类别会立刻写回偏好（跨商品记住）', () => {
    const prefs = memoryPrefs();
    const store = createMediaStore({ prefs, defaultKinds: ALL });
    store.getState().toggleKind('video');
    expect(store.getState().checkedKinds.has('video')).toBe(false);
    expect(prefs.get<string[]>(CHECKED_KINDS_PREF)).not.toContain('video');
  });

  it('全选/全不选按“有素材的类别”算', () => {
    const prefs = memoryPrefs();
    const store = createMediaStore({ prefs, defaultKinds: ALL });
    store.getState().toggleAll(['main', 'detail']);
    expect([...store.getState().checkedKinds]).toEqual([]);
    store.getState().toggleAll(['main', 'detail']);
    expect([...store.getState().checkedKinds].sort()).toEqual(['detail', 'main']);
  });

  it('偏好里的脏数据被过滤掉', () => {
    const prefs = memoryPrefs();
    prefs.set(CHECKED_KINDS_PREF, ['main', 'oops', 42]);
    const store = createMediaStore({ prefs, defaultKinds: ALL });
    expect([...store.getState().checkedKinds]).toEqual(['main']);
  });
});

describe('createMediaStore 挑选模式（§10.3 不持久化）', () => {
  it('选中单张后进入挑选模式', () => {
    const store = createMediaStore({ prefs: memoryPrefs(), defaultKinds: ALL });
    store.getState().toggleKey('detail', 'detail-a');
    expect(isPicking(store.getState())).toBe(true);
  });

  it('再点一次取消', () => {
    const store = createMediaStore({ prefs: memoryPrefs(), defaultKinds: ALL });
    store.getState().toggleKey('detail', 'detail-a');
    store.getState().toggleKey('detail', 'detail-a');
    expect(isPicking(store.getState())).toBe(false);
  });

  it('全选一类只影响这一类', () => {
    const store = createMediaStore({ prefs: memoryPrefs(), defaultKinds: ALL });
    store.getState().selectAllIn('detail', ['d1', 'd2']);
    store.getState().selectAllIn('main', ['m1']);
    expect([...store.getState().selectedKeys].sort()).toEqual(['d1', 'd2', 'm1']);
  });

  it('清除后回到按类别下载', () => {
    const store = createMediaStore({ prefs: memoryPrefs(), defaultKinds: ALL });
    store.getState().selectAllIn('detail', ['d1', 'd2']);
    store.getState().clearSelection();
    expect(isPicking(store.getState())).toBe(false);
  });

  it('挑选状态不写进偏好（不持久化）', () => {
    const prefs = memoryPrefs();
    const store = createMediaStore({ prefs, defaultKinds: ALL });
    store.getState().toggleKey('detail', 'detail-a');
    expect([...prefs.data.keys()]).toEqual([]);
  });
});

describe('createMediaStore 展开类别（§10.3 同一时间只展开一类）', () => {
  it('展开再点一次收起', () => {
    const store = createMediaStore({ prefs: memoryPrefs(), defaultKinds: ALL });
    store.getState().expand('detail');
    expect(store.getState().expandedKind).toBe('detail');
    store.getState().expand('detail');
    expect(store.getState().expandedKind).toBeNull();
  });

  it('展开另一类会替换当前展开的', () => {
    const store = createMediaStore({ prefs: memoryPrefs(), defaultKinds: ALL });
    store.getState().expand('detail');
    store.getState().expand('main');
    expect(store.getState().expandedKind).toBe('main');
  });

  it('收起时清空挑选，避免主按钮写着“下载所选 3 个”却看不到选了什么', () => {
    const store = createMediaStore({ prefs: memoryPrefs(), defaultKinds: ALL });
    store.getState().expand('detail');
    store.getState().toggleKey('detail', 'detail-a');
    store.getState().expand('detail');
    expect(store.getState().selectedKeys.size).toBe(0);
  });
});

describe('isSelectionStale（换商品时清空挑选）', () => {
  it('选中的 key 仍在快照里时不算过期', () => {
    expect(isSelectionStale(new Set(['a']), new Set(['a', 'b']))).toBe(false);
  });

  it('一个都不在时算过期', () => {
    expect(isSelectionStale(new Set(['x']), new Set(['a', 'b']))).toBe(true);
  });

  it('没有选择时不算过期', () => {
    expect(isSelectionStale(new Set(), new Set(['a']))).toBe(false);
  });
});
