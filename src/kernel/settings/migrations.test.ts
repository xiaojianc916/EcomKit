import { describe, expect, it } from 'vitest';
import {
  CURRENT_SETTINGS_VERSION,
  migrateSettings,
  migrateV1ToV2,
  runMigrations,
  SETTINGS_MIGRATIONS,
} from './migrations';
import { DEFAULT_GLOBAL_SETTINGS, templateHasId } from './schema';

describe('schema 默认值（§11）', () => {
  it('默认设置符合方案表格', () => {
    expect(DEFAULT_GLOBAL_SETTINGS.save.mode).toBe('fsa');
    expect(DEFAULT_GLOBAL_SETTINGS.save.rootPath).toBe('');
    expect(DEFAULT_GLOBAL_SETTINGS.shell.autoOpen).toBe('panel');
    expect(DEFAULT_GLOBAL_SETTINGS.shell.theme).toBe('system');
    expect(DEFAULT_GLOBAL_SETTINGS.jobs.concurrency).toBe(6);
    expect(DEFAULT_GLOBAL_SETTINGS.debug).toBe(false);
    expect(DEFAULT_GLOBAL_SETTINGS.platforms.enabled).toEqual([]);
  });

  it('模板必须含 {id}（ADR-6）', () => {
    expect(templateHasId('{title:30}_{id}')).toBe(true);
    expect(templateHasId('{id:5}')).toBe(true);
    expect(templateHasId('{title:30}')).toBe(false);
  });
});

describe('runMigrations（§6.6 迁移框架）', () => {
  it('逐版本执行，记录执行过的版本', () => {
    const migrations = {
      2: (v: unknown) => ({ ...(v as object), added: 2 }),
      3: (v: unknown) => ({ ...(v as object), added3: true }),
    };
    const result = runMigrations<{ added?: number; added3?: boolean }>({}, 1, 3, migrations);
    expect(result.value).toEqual({ added: 2, added3: true });
    expect(result.applied).toEqual([2, 3]);
  });

  it('版本已经是最新时不执行任何迁移', () => {
    const result = runMigrations({ a: 1 }, 3, 3, {});
    expect(result.value).toEqual({ a: 1 });
    expect(result.applied).toEqual([]);
  });

  it('某一步抛错时保留原值（不写回未知结构）', () => {
    const migrations = {
      2: () => {
        throw new Error('boom');
      },
      3: (v: unknown) => ({ ...(v as object), added3: true }),
    };
    const result = runMigrations({ keep: true }, 1, 3, migrations);
    expect(result.value).toEqual({ keep: true });
    expect(result.applied).toEqual([]);
  });
});

describe('migrateV1ToV2 示例', () => {
  it('autoOpenPanel: true → shell.autoOpen = panel', () => {
    expect(migrateV1ToV2({ autoOpenPanel: true, debug: false })).toEqual({
      debug: false,
      shell: { autoOpen: 'panel' },
    });
  });

  it('autoOpenPanel: false → shell.autoOpen = handle', () => {
    expect(migrateV1ToV2({ autoOpenPanel: false })).toEqual({ shell: { autoOpen: 'handle' } });
  });

  it('没有旧字段时原样返回', () => {
    expect(migrateV1ToV2({ shell: { theme: 'dark' } })).toEqual({ shell: { theme: 'dark' } });
  });

  it('非对象输入不崩', () => {
    expect(migrateV1ToV2(null)).toBeNull();
    expect(migrateV1ToV2('x')).toBe('x');
  });

  it('保留已有的 shell 字段', () => {
    expect(migrateV1ToV2({ autoOpenPanel: true, shell: { theme: 'dark' } })).toEqual({
      shell: { theme: 'dark', autoOpen: 'panel' },
    });
  });
});

describe('当前迁移表', () => {
  it('版本号是最新的，调用不报错', () => {
    expect(CURRENT_SETTINGS_VERSION).toBeGreaterThanOrEqual(1);
    expect(migrateSettings({}, 1).value).toEqual({});
    expect(Object.keys(SETTINGS_MIGRATIONS)).toBeDefined();
  });
});
