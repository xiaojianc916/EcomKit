import type { FeatureManifest, EngineFeature, RegisteredFeature } from './types';
import type { JobTypeDef } from '../kernel/jobs/types';

const manifestModules = import.meta.glob<{ default: FeatureManifest }>('./*/manifest.ts', {
  eager: true,
});
const settingsModules = import.meta.glob<{ default: NonNullable<FeatureManifest['settings']> }>(
  './*/settings.ts',
  { eager: true },
);
const engineModules = import.meta.glob<{ default: EngineFeature }>('./*/engine.ts', {
  eager: true,
});

/** offscreen 侧只需要 engine 部分：任务类型 + 私有 RPC（方案 ADR-3） */
export const engineFeatures: RegisteredFeature[] = Object.entries(manifestModules).map(
  ([path, mod]) => {
    const settings = settingsModules[path.replace('manifest.ts', 'settings.ts')]?.default;
    const manifest: FeatureManifest = settings ? { ...mod.default, settings } : mod.default;
    const eng = engineModules[path.replace('manifest.ts', 'engine.ts')];
    return { manifest, ...(eng ? { engine: eng.default } : {}) };
  },
);

export function jobTypes(): JobTypeDef<any, any>[] {
  return engineFeatures.flatMap((f) => f.engine?.jobTypes ?? []);
}

export function engineFor(featureId: string): EngineFeature | undefined {
  return engineFeatures.find((f) => f.manifest.id === featureId)?.engine;
}

/** wxt.config.ts 里汇总所有功能命令（构建期由 scripts/gen-registries.ts 读 manifest 生成） */
export function featureCommands(): Record<
  string,
  { suggested_key: { default: string }; description: string }
> {
  const out: Record<string, { suggested_key: { default: string }; description: string }> = {};
  for (const f of engineFeatures) {
    for (const c of f.manifest.commands ?? []) {
      if (c.suggestedKey) {
        out[c.id] = { suggested_key: { default: c.suggestedKey }, description: c.title };
      }
    }
  }
  return out;
}
