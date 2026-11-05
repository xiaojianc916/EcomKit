import type { FeatureManifest, ServiceFeature, RegisteredFeature } from './types';

const manifestModules = import.meta.glob<{ default: FeatureManifest }>('./*/manifest.ts', {
  eager: true,
});
const settingsModules = import.meta.glob<{ default: NonNullable<FeatureManifest['settings']> }>(
  './*/settings.ts',
  { eager: true },
);
const serviceModules = import.meta.glob<{ default: ServiceFeature }>('./*/service.ts', {
  eager: true,
});

/** bg 侧只需要 service 部分，page.tsx / ui 一律不进包（方案 ADR-3） */
export const serviceFeatures: RegisteredFeature[] = Object.entries(manifestModules).map(
  ([path, mod]) => {
    const settings = settingsModules[path.replace('manifest.ts', 'settings.ts')]?.default;
    const manifest: FeatureManifest = settings ? { ...mod.default, settings } : mod.default;
    const svc = serviceModules[path.replace('manifest.ts', 'service.ts')];
    return { manifest, ...(svc ? { service: svc.default } : {}) };
  },
);

export function serviceFor(featureId: string): ServiceFeature | undefined {
  return serviceFeatures.find((f) => f.manifest.id === featureId)?.service;
}

/** 功能私有设置的 key（方案 §6.6） */
export function featureSettingsKey(featureId: string): string {
  return `feature:${featureId}`;
}
