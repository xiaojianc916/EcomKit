import { describe, expect, it } from 'vitest';
import type { JobRecord } from '../kernel/jobs/types';
import {
  clampHandleY,
  createShellStore,
  HANDLE_MIN_Y,
  handleBadge,
  handleBadgeEq,
  isDrag,
  isViewportNarrow,
  type PrefsPort,
  resolveForm,
  siteKeyOf,
  themeAttr,
} from './store';

function memoryPrefs(): PrefsPort & { data: Map<string, unknown> } {
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

function makeJob(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'j1',
    type: 'media-download',
    dedupeKey: 'pdd:1',
    payload: {},
    status: 'running',
    total: 48,
    done: 23,
    skipped: 0,
    bytes: 0,
    failed: [],
    byGroup: {},
    createdAt: 0,
    ...patch,
  };
}

describe('resolveForm（§10.5 自动展开策略）', () => {
  const base = { autoOpen: 'panel' as const, saved: undefined, blocked: false, narrow: false };

  it('默认展开面板', () => {
    expect(resolveForm(base)).toBe('panel');
  });

  it('被阻断时必须展开，否则看不到原因', () => {
    expect(resolveForm({ ...base, blocked: true, autoOpen: 'hidden' })).toBe('panel');
  });

  it('设置成不显示且用户没手动改过 → 不显示', () => {
    expect(resolveForm({ ...base, autoOpen: 'hidden' })).toBe('hidden');
  });

  it('用户在站点手动收起后 → 只显示把手（覆盖全局设置）', () => {
    expect(resolveForm({ ...base, autoOpen: 'hidden', saved: 'handle' })).toBe('handle');
    expect(resolveForm({ ...base, saved: 'handle' })).toBe('handle');
  });

  it('用户手动展开后又恢复为展开面板', () => {
    expect(resolveForm({ ...base, autoOpen: 'handle', saved: 'panel' })).toBe('panel');
  });

  it('视口太窄 → 只显示把手，不自动展开', () => {
    expect(resolveForm({ ...base, narrow: true })).toBe('handle');
  });

  it('设置成只显示把手', () => {
    expect(resolveForm({ ...base, autoOpen: 'handle' })).toBe('handle');
  });
});

describe('isViewportNarrow（§10.5 窗口太窄）', () => {
  it('小于内容宽 + 面板宽时算窄', () => {
    expect(isViewportNarrow(720)).toBe(true);
    expect(isViewportNarrow(1920)).toBe(false);
  });
});

describe('clampHandleY（§10.2 位置限制）', () => {
  it('夹在 [80, 视口高 − 160]', () => {
    expect(clampHandleY(0, 900)).toBe(HANDLE_MIN_Y);
    expect(clampHandleY(430, 900)).toBe(430);
    expect(clampHandleY(1000, 900)).toBe(740);
  });

  it('视口很矮时取下界，保证把手可见', () => {
    expect(clampHandleY(200, 200)).toBe(HANDLE_MIN_Y);
  });
});

describe('isDrag（§10.2 拖动超过 4px 才算拖动）', () => {
  it('4px 以内算点击', () => {
    expect(isDrag(3, 3)).toBe(false);
    expect(isDrag(-4, 0)).toBe(false);
  });

  it('超过 4px 算拖动', () => {
    expect(isDrag(0, 5)).toBe(true);
    expect(isDrag(-9, 0)).toBe(true);
  });
});

describe('handleBadge（§10.2 把手上的数字和状态表）', () => {
  const now = 1_000_000;

  it('识别中显示旋转指示器，没有数字', () => {
    expect(
      handleBadge({ status: 'resolving', total: 0, job: null, now, needsAttention: false }),
    ).toEqual({ kind: 'resolving' });
  });

  it('就绪显示素材总数', () => {
    expect(
      handleBadge({ status: 'ready', total: 48, job: null, now, needsAttention: false }),
    ).toEqual({ kind: 'count', count: 48 });
  });

  it('下载中显示百分比', () => {
    const badge = handleBadge({
      status: 'ready',
      total: 48,
      job: makeJob(),
      now,
      needsAttention: false,
    });
    expect(badge).toEqual({ kind: 'progress', percent: 48 });
  });

  it('完成显示对勾 3 秒后恢复总数', () => {
    const job = makeJob({ status: 'done', done: 48, endedAt: now - 1000 });
    expect(handleBadge({ status: 'ready', total: 48, job, now, needsAttention: false })).toEqual({
      kind: 'done',
    });
    expect(
      handleBadge({ status: 'ready', total: 48, job, now: now + 5000, needsAttention: false }),
    ).toEqual({ kind: 'count', count: 48 });
  });

  it('需要处理时给红点', () => {
    expect(
      handleBadge({ status: 'ready', total: 48, job: null, now, needsAttention: true }),
    ).toEqual({ kind: 'attention', count: 0 });
  });

  it('同时有失败和数字时，红点优先于数字', () => {
    const job = makeJob({ status: 'partial', failed: [{ itemKey: 'a', code: 'NETWORK' }] });
    expect(handleBadge({ status: 'ready', total: 48, job, now, needsAttention: true })).toEqual({
      kind: 'attention',
      count: 1,
    });
  });
});

describe('handleBadgeEq（角标引用复用）', () => {
  it('同类同内容算相等', () => {
    expect(handleBadgeEq({ kind: 'count', count: 3 }, { kind: 'count', count: 3 })).toBe(true);
    expect(
      handleBadgeEq({ kind: 'progress', percent: 42 }, { kind: 'progress', percent: 42 }),
    ).toBe(true);
    expect(handleBadgeEq({ kind: 'resolving' }, { kind: 'resolving' })).toBe(true);
    expect(handleBadgeEq({ kind: 'done' }, { kind: 'done' })).toBe(true);
  });

  it('内容不同算不等', () => {
    expect(handleBadgeEq({ kind: 'count', count: 3 }, { kind: 'count', count: 4 })).toBe(false);
    expect(
      handleBadgeEq({ kind: 'progress', percent: 42 }, { kind: 'progress', percent: 43 }),
    ).toBe(false);
    expect(handleBadgeEq({ kind: 'attention', count: 1 }, { kind: 'attention', count: 2 })).toBe(
      false,
    );
  });

  it('不同类型的角标永远不等（否则图标会停在上一个状态）', () => {
    expect(handleBadgeEq({ kind: 'count', count: 3 }, { kind: 'progress', percent: 3 })).toBe(
      false,
    );
    expect(handleBadgeEq({ kind: 'done' }, { kind: 'count', count: 0 })).toBe(false);
  });

  it('同一个引用直接相等', () => {
    const badge = { kind: 'count' as const, count: 7 };
    expect(handleBadgeEq(badge, badge)).toBe(true);
  });
});

describe('createShellStore 持久化', () => {
  const siteKey = siteKeyOf('mobile.yangkeduo.com');

  it('按站点读回把手位置', () => {
    const prefs = memoryPrefs();
    prefs.set(siteKey, { handleY: 320 });
    const store = createShellStore({
      prefs,
      siteKey,
      settings: { autoOpen: 'panel', theme: 'system' },
      viewportWidth: 1920,
      viewportHeight: 900,
    });
    expect(store.getState().handleY).toBe(320);
  });

  it('用户收起后写回站点偏好', () => {
    const prefs = memoryPrefs();
    const store = createShellStore({
      prefs,
      siteKey,
      settings: { autoOpen: 'panel', theme: 'system' },
      viewportWidth: 1920,
      viewportHeight: 900,
    });
    store.getState().setForm('handle');
    expect(prefs.get<{ form?: string }>(siteKey)?.form).toBe('handle');
  });

  it('togglePanel 在面板和把手之间切换', () => {
    const store = createShellStore({
      prefs: memoryPrefs(),
      siteKey,
      settings: { autoOpen: 'panel', theme: 'system' },
      viewportWidth: 1920,
      viewportHeight: 900,
    });
    store.getState().setForm('panel');
    store.getState().togglePanel();
    expect(store.getState().form).toBe('handle');
    store.getState().togglePanel();
    expect(store.getState().form).toBe('panel');
  });

  it('syncForm 按用户上次的选择决定形态', () => {
    const prefs = memoryPrefs();
    prefs.set(siteKey, { form: 'handle' });
    const store = createShellStore({
      prefs,
      siteKey,
      settings: { autoOpen: 'panel', theme: 'system' },
      viewportWidth: 1920,
      viewportHeight: 900,
    });
    store.getState().syncForm({ blocked: false, narrow: false, autoOpen: 'panel' });
    expect(store.getState().form).toBe('handle');
  });

  it('窄视口下 syncForm 不自动展开', () => {
    const store = createShellStore({
      prefs: memoryPrefs(),
      siteKey,
      settings: { autoOpen: 'panel', theme: 'system' },
      viewportWidth: 700,
      viewportHeight: 900,
    });
    store.getState().syncForm({ blocked: false, narrow: true, autoOpen: 'panel' });
    expect(store.getState().form).toBe('handle');
  });

  it('视口变矮时把手位置被重新夹紧', () => {
    const store = createShellStore({
      prefs: memoryPrefs(),
      siteKey,
      settings: { autoOpen: 'panel', theme: 'system' },
      viewportWidth: 1920,
      viewportHeight: 900,
    });
    store.getState().setHandleY(700);
    store.getState().setViewport(1920, 500);
    expect(store.getState().handleY).toBe(340);
  });
});

describe('themeAttr（§10.6 主题）', () => {
  it('跟随系统时不写属性', () => {
    expect(themeAttr('system')).toBeUndefined();
  });

  it('强制主题时写 data-ec-theme', () => {
    expect(themeAttr('dark')).toBe('dark');
    expect(themeAttr('light')).toBe('light');
  });
});
