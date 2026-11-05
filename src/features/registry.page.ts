import type { FeatureManifest, PageFeature, RegisteredFeature } from './types';

/**
 * 功能注册表（方案 §8.3）。
 *
 * 三件事需要在这一层做完，功能作者不用操心：
 * 1. manifest.ts 是**纯数据**（构建期 Node 脚本要直接加载它生成 commands），
 *    所以 settings 的 zod schema 单独放在 settings.ts 里，这里贴回去。
 * 2. page.tsx **懒加载**：功能多了以后内容脚本首屏体积不线性增长。
 * 3. 启动自检：功能 id 唯一、命令 id 不冲突、requires 里的能力是已知的。
 */
const manifestModules = import.meta.glob<{ default: FeatureManifest }>('./*/manifest.ts', {
  eager: true,
});
const settingsModules = import.meta.glob<{ default: NonNullable<FeatureManifest['settings']> }>(
  './*/settings.ts',
  { eager: true },
);
const pageModules = import.meta.glob<{ default: PageFeature }>('./*/page.tsx');

export const pageFeatures: RegisteredFeature[] = Object.entries(manifestModules)
  .map(([path, mod]) => {
    const settings = settingsModules[path.replace('manifest.ts', 'settings.ts')]?.default;
    const manifest: FeatureManifest = settings ? { ...mod.default, settings } : mod.default;
    const load = pageModules[path.replace('manifest.ts', 'page.tsx')];
    return {
      manifest,
      ...(load ? { page: { load: load as () => Promise<{ default: PageFeature }> } } : {}),
    };
  })
  .sort((a, b) => a.manifest.order - b.manifest.order || a.manifest.id.localeCompare(b.manifest.id));

export function featuresForPlatform(platform: string): RegisteredFeature[] {
  return pageFeatures.filter(
    (f) => !f.manifest.platforms || f.manifest.platforms.includes(platform as never),
  );
}
