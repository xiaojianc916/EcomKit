import { EcError } from '../errors/ec-error';
import { createLogger } from '../log/logger';
import { STORAGE_KEYS } from '../storage/keys';

/**
 * 设置版本迁移框架（方案 §6.6）。
 *
 * 什么时候需要迁移：只有**改名**或**改结构**才需要 —— 新增设置项不用写迁移，
 * 因为读取时一律 schema.parse，缺失字段自动补默认值（schema.ts 顶部注释）。
 *
 * 迁移函数必须是纯函数：输入旧值、输出新值，不许有副作用（不能在里面读别的 key）。
 * 这样才能在任意上下文里安全重放。
 */

const log = createLogger('settings.migrations');

/** 迁移脚本表：版本号 → 把 v(n-1) 的数据转成 v(n) 的函数 */
export type Migrations = Record<number, (oldValue: unknown) => unknown>;

export interface MigrationResult<T> {
  value: T;
  /** 实际执行过的版本号，按顺序 */
  applied: number[];
}

/**
 * 依次执行 [from+1 .. to] 的迁移。
 * 任何一步抛错都保留原值不动 —— 迁移失败时宁可让用户留在旧版本，
 * 也不要写回一个结构未知的对象把所有设置清空。
 */
export function runMigrations<T>(
  oldValue: unknown,
  fromVersion: number,
  toVersion: number,
  migrations: Migrations,
): MigrationResult<T> {
  let value = oldValue;
  const applied: number[] = [];
  for (let v = fromVersion + 1; v <= toVersion; v += 1) {
    const migrate = migrations[v];
    if (!migrate) continue;
    try {
      value = migrate(value);
      applied.push(v);
    } catch (e) {
      log.warn('迁移步骤失败，保留原值', { version: v, code: EcError.from(e).code });
      return { value: oldValue as T, applied: [] };
    }
  }
  return { value: value as T, applied };
}

/**
 * 示例迁移（v1 → v2）。
 *
 * 真实的例子：设置项从 `autoOpenPanel: boolean` 改名成 `shell.autoOpen: 'panel' | 'handle' | 'hidden'`。
 * 保留这个示例是为了让下一个人知道怎么写，而不是让你删掉它 —— 它同时被单测覆盖。
 */
export function migrateV1ToV2(oldValue: unknown): unknown {
  if (!oldValue || typeof oldValue !== 'object') return oldValue;
  const source = { ...(oldValue as Record<string, unknown>) };

  if (typeof source.autoOpenPanel === 'boolean') {
    const autoOpen = source.autoOpenPanel ? 'panel' : 'handle';
    delete source.autoOpenPanel;
    const shell = typeof source.shell === 'object' && source.shell !== null ? source.shell : {};
    source.shell = { ...(shell as object), autoOpen };
  }
  return source;
}

/** 当前数据版本。改结构时 +1 并在上面加一条迁移 */
export const CURRENT_SETTINGS_VERSION = 1;

/** 现成的迁移表，供 settings/store.ts 或 bg 启动时调用 */
export const SETTINGS_MIGRATIONS: Migrations = {
  // 版本 1 是初始版本，没有需要迁移的东西。
  // 以后加 v2 时把 2 指向真实函数，例如：
  // 2: migrateV1ToV2,
};

export const SETTINGS_KEY = STORAGE_KEYS.settings;

/** 官方示例用：把当前迁移表跑一遍（bg 启动时如果发现版本落后就调用） */
export function migrateSettings(oldValue: unknown, fromVersion: number): MigrationResult<unknown> {
  return runMigrations(oldValue, fromVersion, CURRENT_SETTINGS_VERSION, SETTINGS_MIGRATIONS);
}
