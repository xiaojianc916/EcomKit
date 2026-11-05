import { z } from 'zod';

/**
 * 全局设置（方案 §11）。功能自己的设置在各自 manifest.settings 里，
 * 存在 `feature:<id>` 这个 key 下，不在这里。
 *
 * 读取时一律 schema.parse，缺失字段补默认值 —— 所以新增设置项不需要写迁移，
 * 只有改名/改结构才需要在 migrations.ts 里加版本。
 */

export const SaveMode = z.enum(['fsa', 'downloads']);
export type SaveMode = z.infer<typeof SaveMode>;

export const AutoOpenMode = z.enum(['panel', 'handle', 'hidden']);
export type AutoOpenMode = z.infer<typeof AutoOpenMode>;

export const ThemeMode = z.enum(['system', 'light', 'dark']);
export type ThemeMode = z.infer<typeof ThemeMode>;

export const GlobalSettings = z.object({
  save: z
    .object({
      mode: SaveMode.default('fsa'),
      /** 用户自己填的根目录绝对路径，只用来复制完整路径（§10.5） */
      rootPath: z.string().default(''),
    })
    .prefault({}),
  shell: z
    .object({
      autoOpen: AutoOpenMode.default('panel'),
      theme: ThemeMode.default('system'),
    })
    .prefault({}),
  platforms: z
    .object({
      enabled: z.array(z.string()).default([]),
    })
    .prefault({}),
  jobs: z
    .object({
      concurrency: z.number().int().min(1).max(8).default(6),
    })
    .prefault({}),
  debug: z.boolean().default(false),
});

export type GlobalSettings = z.infer<typeof GlobalSettings>;

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = GlobalSettings.parse({});

/** 产品文件夹模板的可用变量（§9.1） */
export const TEMPLATE_VARS = ['platform', 'shop', 'title', 'id', 'date'] as const;
export type TemplateVar = (typeof TEMPLATE_VARS)[number];

/** 模板必须包含 {id} —— 这是按 ID 定位文件夹的前提（ADR-6） */
export function templateHasId(template: string): boolean {
  return /\{id(?::\d+)?\}/.test(template);
}
