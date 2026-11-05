import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 同 store.test.ts：mock wxt storage，只验证 UI 偏好的合并语义 */
const fakeStorage = new Map<string, unknown>();

vi.mock('wxt/utils/storage', () => ({
  storage: {
    defineItem: (key: string) => ({
      key,
      getValue: async () => (fakeStorage.has(key) ? fakeStorage.get(key) : null),
      setValue: async (value: unknown) => {
        fakeStorage.set(key, value);
      },
      watch: (cb: (v: unknown) => void) => {
        fakeStorage.set(key + '#watch', cb);
        return () => fakeStorage.delete(key + '#watch');
      },
    }),
  },
}));

import type { UiPrefs } from './store';

const { patchUiPrefs, readUiPrefs, resetUiPrefsForSite, watchUiPrefs } = await import('./store');

beforeEach(() => {
  fakeStorage.clear();
});

describe('readUiPrefs（§6.5 UI 偏好）', () => {
  it('没存过时返回空对象', async () => {
    expect(await readUiPrefs()).toEqual({});
  });

  it('存的东西不是对象时返回空对象（不崩）', async () => {
    fakeStorage.set('local:shell.prefs', [1, 2, 3]);
    expect(await readUiPrefs()).toEqual({});
    fakeStorage.set('local:shell.prefs', 'nope');
    expect(await readUiPrefs()).toEqual({});
  });
});

describe('patchUiPrefs（按站点合并）', () => {
  it('写入新的站点偏好', async () => {
    const next = await patchUiPrefs({ formByPlatform: { 'mobile.yangkeduo.com': 'panel' } });
    expect(next.formByPlatform).toEqual({ 'mobile.yangkeduo.com': 'panel' });
  });

  it('只写一个站点不会清掉别的站点（深合并）', async () => {
    await patchUiPrefs({ formByPlatform: { 'a.com': 'panel' } });
    const next = await patchUiPrefs({ formByPlatform: { 'b.com': 'handle' } });
    expect(next.formByPlatform).toEqual({ 'a.com': 'panel', 'b.com': 'handle' });
  });

  it('把手位置同样按站点合并', async () => {
    await patchUiPrefs({ handleYByPlatform: { 'a.com': 200 } });
    const next = await patchUiPrefs({ handleYByPlatform: { 'b.com': 300 } });
    expect(next.handleYByPlatform).toEqual({ 'a.com': 200, 'b.com': 300 });
  });

  it('普通字段直接覆盖', async () => {
    await patchUiPrefs({ activeFeature: 'media-download' });
    const next = await patchUiPrefs({ activeFeature: 'other' });
    expect(next.activeFeature).toBe('other');
  });

  it('显式传 undefined 时被跳过，不会把已有值抹掉', async () => {
    await patchUiPrefs({ activeFeature: 'media-download' });
    // exactOptionalPropertyTypes 不允许直接写字面量 undefined，这里模拟「运行时传进来 undefined」的情况
    const patch = { activeFeature: undefined } as unknown as Partial<UiPrefs>;
    const next = await patchUiPrefs(patch);
    expect(next.activeFeature).toBe('media-download');
  });
});

describe('resetUiPrefsForSite（设置页按站点重置）', () => {
  it('只清掉指定站点的偏好', async () => {
    await patchUiPrefs({
      formByPlatform: { 'a.com': 'panel', 'b.com': 'handle' },
      handleYByPlatform: { 'a.com': 200, 'b.com': 300 },
    });
    const next = await resetUiPrefsForSite('a.com');
    expect(next.formByPlatform).toEqual({ 'b.com': 'handle' });
    expect(next.handleYByPlatform).toEqual({ 'b.com': 300 });
  });
});

describe('watchUiPrefs', () => {
  it('变化时回调收到新值', async () => {
    const seen: unknown[] = [];
    watchUiPrefs((v) => seen.push(v));
    const cb = fakeStorage.get('local:shell.prefs#watch') as (v: unknown) => void;
    cb({ activeFeature: 'x' });
    expect(seen).toEqual([{ activeFeature: 'x' }]);
  });

  it('坏值回调空对象', async () => {
    const seen: unknown[] = [];
    watchUiPrefs((v) => seen.push(v));
    const cb = fakeStorage.get('local:shell.prefs#watch') as (v: unknown) => void;
    cb('broken');
    expect(seen).toEqual([{}]);
  });
});
