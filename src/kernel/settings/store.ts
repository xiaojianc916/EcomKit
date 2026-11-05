import { type StorageItemKey, storage, type WxtStorageItem } from 'wxt/utils/storage';
import type { z } from 'zod';
import { EcError } from '../errors/ec-error';
import { createLogger } from '../log/logger';
import { STORAGE_KEYS } from '../storage/keys';
import {
  DEFAULT_GLOBAL_SETTINGS,
  GlobalSettings,
  type GlobalSettings as GlobalSettingsType,
} from './schema';

/**
 * 设置读写（方案 §6.6、§11）。
 *
 * 三条约定：
 *   1. **读一律过 schema.parse**：缺失字段补默认值，所以新增设置项不需要写迁移（§6.6）；
 *   2. 全局设置存在 `local:settings`，功能私有设置存在 `local:feature:<id>`；
 *   3. 每个写入点都返回解析后的值，调用方永远拿到完整对象，不用自己合并默认值。
 *
 * 为什么用 WXT 的 storage 而不是裸 chrome.storage：它支持 watch 和版本迁移，
 * 而且各上下文（bg / offscreen / 页面 / 设置页）读到的都是同一份。
 */

const log = createLogger('settings');

/** WXT storage 的 key 必须带区域前缀（local: / session:） */
export function storageKey(name: string): StorageItemKey {
  return `local:${name}` as StorageItemKey;
}

/** 全局设置的完整对象（解析后的） */
export type Settings = GlobalSettingsType;

let globalItem: WxtStorageItem<unknown, Record<string, unknown>> | null = null;

function item(): WxtStorageItem<unknown, Record<string, unknown>> {
  globalItem ??= storage.defineItem<unknown>(storageKey(STORAGE_KEYS.settings));
  return globalItem;
}

/**
 * 读全局设置。
 * 解析失败（旧版本数据、被人为改坏）时回落到默认值并打警告 ——
 * 绝不能因为一个设置项读不出来就让整个工具箱不可用。
 */
export async function getSettings(): Promise<Settings> {
  let raw: unknown;
  try {
    raw = await item().getValue();
  } catch (e) {
    log.warn('读取设置失败，使用默认值', { code: EcError.from(e).code });
    return DEFAULT_GLOBAL_SETTINGS;
  }
  if (raw === null || raw === undefined) return DEFAULT_GLOBAL_SETTINGS;

  const parsed = GlobalSettings.safeParse(raw);
  if (!parsed.success) {
    log.warn('设置结构不合法，使用默认值', { issues: parsed.error.issues.length });
    return DEFAULT_GLOBAL_SETTINGS;
  }
  return parsed.data;
}

/** 别名：offscreen 和 bg 的启动代码用这个名字读设置，语义更直白 */
export const readSettings = getSettings;

/** 局部更新全局设置：传一个返回新对象的函数，避免并发写互相覆盖 */
export async function updateSettings(mutate: (current: Settings) => Settings): Promise<Settings> {
  const current = await getSettings();
  const next = GlobalSettings.parse(mutate(current));
  await item().setValue(next);
  return next;
}

/** 直接覆盖（设置页整体保存用） */
export async function setSettings(next: Settings): Promise<Settings> {
  const parsed = GlobalSettings.parse(next);
  await item().setValue(parsed);
  return parsed;
}

/** 监听全局设置变化；返回取消订阅函数（§6.5 支持 watch） */
export function watchSettings(cb: (next: Settings) => void): () => void {
  return item().watch((value) => {
    const parsed = GlobalSettings.safeParse(value);
    if (parsed.success) cb(parsed.data);
    else cb(DEFAULT_GLOBAL_SETTINGS);
  });
}

/** 重置为默认设置（设置页「清除所有本地数据」用） */
export async function resetSettings(): Promise<Settings> {
  await item().setValue(DEFAULT_GLOBAL_SETTINGS);
  return DEFAULT_GLOBAL_SETTINGS;
}

// ---------- 功能私有设置（§6.6：存 feature:<id>）----------

export interface FeatureSettingsOptions<T> {
  featureId: string;
  schema: z.ZodType<T>;
  defaults: T;
}

/** 功能设置的读写器：每个功能一个，key 固定为 feature:<id> */
export interface FeatureSettingsStore<T> {
  readonly key: string;
  get(): Promise<T>;
  set(next: T): Promise<T>;
  update(mutate: (current: T) => T): Promise<T>;
  watch(cb: (next: T) => void): () => void;
  reset(): Promise<T>;
}

export function createFeatureSettings<T>(
  options: FeatureSettingsOptions<T>,
): FeatureSettingsStore<T> {
  const key = storageKey(STORAGE_KEYS.featureSettings(options.featureId));
  const item = storage.defineItem<unknown>(key);
  const { schema, defaults } = options;

  function parse(raw: unknown): T {
    if (raw === null || raw === undefined) return defaults;
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    // 单字段坏掉不该让整个功能不可用：逐字段尝试，能救的救回来（宽松读取）
    if (typeof raw === 'object' && raw !== null) {
      const merged = { ...(defaults as object), ...(raw as object) };
      const retry = schema.safeParse(merged);
      if (retry.success) return retry.data;
    }
    log.warn('功能设置结构不合法，使用默认值', { featureId: options.featureId });
    return defaults;
  }

  return {
    key,
    async get() {
      try {
        return parse(await item.getValue());
      } catch (e) {
        log.warn('读取功能设置失败', { featureId: options.featureId, code: EcError.from(e).code });
        return defaults;
      }
    },
    async set(next) {
      const parsed = schema.parse(next);
      await item.setValue(parsed);
      return parsed;
    },
    async update(mutate) {
      const current = await this.get();
      return this.set(mutate(current));
    },
    watch(cb) {
      return item.watch((value) => cb(parse(value)));
    },
    async reset() {
      await item.setValue(defaults);
      return defaults;
    },
  };
}

/** 功能设置缓存：同一个功能只建一次读写器 */
const featureStores = new Map<string, FeatureSettingsStore<unknown>>();

export function featureSettings<T>(options: FeatureSettingsOptions<T>): FeatureSettingsStore<T> {
  const existing = featureStores.get(options.featureId);
  if (existing) return existing as FeatureSettingsStore<T>;
  const created = createFeatureSettings(options);
  featureStores.set(options.featureId, created as FeatureSettingsStore<unknown>);
  return created;
}
// ---------- UI 偏好（§6.5「UI 偏好」：把手位置、各站点展开策略、类别勾选）----------

/**
 * UI 偏好存在 `local:shell.prefs` 里，按站点分包。
 *
 * 为什么和功能设置分开：这类数据是「用户在这个站点上的界面习惯」，
 * 不是功能的业务参数；混在一起会让设置页的「按站点重置」变得很难写。
 * 结构故意保持宽松（passthrough）：站点名是运行时才知道的，做不出严格 schema。
 */
export interface UiPrefs {
  /** 站点 key → 形态（§10.2 三形态） */
  formByPlatform?: Record<string, string>;
  /** 站点 key → 把手纵向位置 px */
  handleYByPlatform?: Record<string, number>;
  /** 最后选中的功能标签 */
  activeFeature?: string;
  /** 其它前端偏好，保持向前兼容 */
  [key: string]: unknown;
}

let uiPrefsItem: WxtStorageItem<unknown, Record<string, unknown>> | null = null;

function prefsItem(): WxtStorageItem<unknown, Record<string, unknown>> {
  uiPrefsItem ??= storage.defineItem<unknown>(storageKey(STORAGE_KEYS.shellPrefs));
  return uiPrefsItem;
}

/** 读 UI 偏好；读不到或坏掉时返回空对象（界面回落默认形态，不会白屏） */
export async function readUiPrefs(): Promise<UiPrefs> {
  try {
    const raw = await prefsItem().getValue();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as UiPrefs;
  } catch (e) {
    log.warn('读取界面偏好失败', { code: EcError.from(e).code });
    return {};
  }
}

/** 局部合并写入 UI 偏好（多个站点共用一份，必须合并而不是覆盖） */
export async function patchUiPrefs(patch: Partial<UiPrefs>): Promise<UiPrefs> {
  const current = await readUiPrefs();
  const next: UiPrefs = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // 站点映射类字段要按 key 深合并：只写一个站点不能把别的站点清掉
    if (
      (key === 'formByPlatform' || key === 'handleYByPlatform') &&
      typeof value === 'object' &&
      value !== null &&
      typeof current[key] === 'object' &&
      current[key] !== null
    ) {
      next[key] = { ...(current[key] as object), ...(value as object) };
    } else {
      next[key] = value;
    }
  }
  try {
    await prefsItem().setValue(next);
  } catch (e) {
    log.warn('写入界面偏好失败', { code: EcError.from(e).code });
  }
  return next;
}

/** 监听 UI 偏好变化 */
export function watchUiPrefs(cb: (next: UiPrefs) => void): () => void {
  return prefsItem().watch((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      cb({});
      return;
    }
    cb(value as UiPrefs);
  });
}

/** 清掉某个站点的偏好（设置页「按站点重置」） */
export async function resetUiPrefsForSite(siteKey: string): Promise<UiPrefs> {
  const current = await readUiPrefs();
  const forms = { ...(current.formByPlatform ?? {}) };
  const ys = { ...(current.handleYByPlatform ?? {}) };
  delete forms[siteKey];
  delete ys[siteKey];
  const next: UiPrefs = { ...current, formByPlatform: forms, handleYByPlatform: ys };
  await prefsItem().setValue(next);
  return next;
}

/**
 * 读功能设置（给 page 侧用：它只拿到功能 id 和 manifest 里的 schema）。
 *
 * 为什么不直接用 featureSettings()：page 侧是从 `features/registry.page` 动态拿到的
 * manifest.settings，schema 和 defaults 都在里面，没必要再建一个缓存表。
 */
export async function readFeatureSettings<T>(options: FeatureSettingsOptions<T>): Promise<T> {
  return createFeatureSettings(options).get();
}

/** 写功能设置（同上，page 侧改设置时用） */
export async function writeFeatureSettings<T>(
  options: FeatureSettingsOptions<T>,
  next: T,
): Promise<T> {
  return createFeatureSettings(options).set(next);
}
