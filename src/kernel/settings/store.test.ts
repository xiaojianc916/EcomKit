import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * settings/store.ts 的单测。
 * wxt/utils/storage 在单测环境里没有真实的 chrome.storage 后端，
 * 所以这里 mock 掉它，只验证「读取一律过 schema.parse、坏数据回落默认值」这些契约。
 */
const fakeStorage = new Map<string, unknown>();

vi.mock('wxt/utils/storage', () => {
  return {
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
  };
});

const {
  createFeatureSettings,
  getSettings,
  resetSettings,
  setSettings,
  updateSettings,
  storageKey,
} = await import('./store');
const { DEFAULT_GLOBAL_SETTINGS } = await import('./schema');
const { z } = await import('zod');

beforeEach(() => {
  fakeStorage.clear();
});

describe('storageKey', () => {
  it('补上 local: 前缀（WXT storage 要求）', () => {
    expect(storageKey('settings')).toBe('local:settings');
  });
});

describe('getSettings（§6.6 读取一律 schema.parse）', () => {
  it('没有存过时返回默认值', async () => {
    expect(await getSettings()).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });

  it('缺字段时补默认值（新增设置项不需要迁移）', async () => {
    fakeStorage.set('local:settings', { debug: true });
    const settings = await getSettings();
    expect(settings.debug).toBe(true);
    expect(settings.jobs.concurrency).toBe(6);
    expect(settings.save.mode).toBe('fsa');
  });

  it('结构坏掉时回落默认值，不抛错', async () => {
    fakeStorage.set('local:settings', { jobs: { concurrency: 'nope' } });
    expect(await getSettings()).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });

  it('非法枚举值回落默认值', async () => {
    fakeStorage.set('local:settings', { save: { mode: 'ftp' } });
    expect(await getSettings()).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });
});

describe('setSettings / updateSettings', () => {
  it('setSettings 写入并返回解析后的值', async () => {
    const next = await setSettings({ ...DEFAULT_GLOBAL_SETTINGS, debug: true });
    expect(next.debug).toBe(true);
    expect((await getSettings()).debug).toBe(true);
  });

  it('updateSettings 基于当前值做局部更新', async () => {
    await setSettings({ ...DEFAULT_GLOBAL_SETTINGS, debug: true });
    const next = await updateSettings((s) => ({ ...s, jobs: { ...s.jobs, concurrency: 3 } }));
    expect(next.jobs.concurrency).toBe(3);
    expect(next.debug).toBe(true);
  });

  it('并发改到越界值时被 schema 拦住', async () => {
    await expect(
      setSettings({ ...DEFAULT_GLOBAL_SETTINGS, jobs: { concurrency: 99 } }),
    ).rejects.toBeDefined();
  });
});

describe('resetSettings', () => {
  it('回到默认值', async () => {
    await setSettings({ ...DEFAULT_GLOBAL_SETTINGS, debug: true });
    await resetSettings();
    expect(await getSettings()).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });
});

describe('createFeatureSettings（§6.6 feature:<id>）', () => {
  const schema = z.object({
    byPlatform: z.boolean().default(true),
    folderTemplate: z.string().default('{title:30}_{id}'),
  });
  const defaults = schema.parse({});

  it('key 是 feature:<id>', () => {
    const store = createFeatureSettings({ featureId: 'media-download', schema, defaults });
    expect(store.key).toBe('local:feature:media-download');
  });

  it('没有存过时返回默认值', async () => {
    const store = createFeatureSettings({ featureId: 'f1', schema, defaults });
    expect(await store.get()).toEqual(defaults);
  });

  it('写入后能读回', async () => {
    const store = createFeatureSettings({ featureId: 'f2', schema, defaults });
    await store.set({ byPlatform: false, folderTemplate: '{id}' });
    expect(await store.get()).toEqual({ byPlatform: false, folderTemplate: '{id}' });
  });

  it('缺字段时补默认值', async () => {
    const store = createFeatureSettings({ featureId: 'f3', schema, defaults });
    fakeStorage.set('local:feature:f3', { byPlatform: false });
    expect(await store.get()).toEqual({ byPlatform: false, folderTemplate: '{title:30}_{id}' });
  });

  it('坏字段用默认值兜住（宽松读取，不让功能不可用）', async () => {
    const store = createFeatureSettings({ featureId: 'f4', schema, defaults });
    fakeStorage.set('local:feature:f4', { byPlatform: 'nope' });
    expect(await store.get()).toEqual(defaults);
  });

  it('update 基于当前值', async () => {
    const store = createFeatureSettings({ featureId: 'f5', schema, defaults });
    await store.set({ byPlatform: true, folderTemplate: '{id}' });
    const next = await store.update((s) => ({ ...s, byPlatform: false }));
    expect(next).toEqual({ byPlatform: false, folderTemplate: '{id}' });
  });

  it('reset 回到默认值', async () => {
    const store = createFeatureSettings({ featureId: 'f6', schema, defaults });
    await store.set({ byPlatform: false, folderTemplate: 'x' });
    expect(await store.reset()).toEqual(defaults);
  });

  it('watch 能收到变化', async () => {
    const store = createFeatureSettings({ featureId: 'f7', schema, defaults });
    const seen: unknown[] = [];
    store.watch((v) => seen.push(v));
    const cb = fakeStorage.get('local:feature:f7#watch') as (v: unknown) => void;
    cb({ byPlatform: false });
    expect(seen).toEqual([{ byPlatform: false, folderTemplate: '{title:30}_{id}' }]);
  });
});
