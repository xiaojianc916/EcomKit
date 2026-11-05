/**
 * 收集 platforms/<id>/manifest.ts 和 features/<id>/manifest.ts 这类**纯数据**模块，
 * 生成 src/generated/build-manifest.json。
 *
 * 为什么需要这一步：wxt.config.ts 运行在 Node 里，拿不到 import.meta.glob，
 * 而内容脚本注入范围、host_permissions、快捷键都必须在这里算出来。
 * 生成物同时被运行时读取，保证"一份数据、两处一致"。
 *
 * 平台/功能的 manifest 必须是纯数据模块：只能有 `import type`，否则 Node 无法直接加载。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

export interface BuildManifest {
  platforms: PlatformManifestData[];
  features: FeatureManifestData[];
  featureCommands: Record<string, { suggested_key: { default: string }; description: string }>;
}

export interface PlatformManifestData {
  id: string;
  displayName: string;
  brandColor: string;
  brandRing?: string;
  pageKinds: { kind: string; matches: string[]; productIdParam: string; pathPattern?: string }[];
  cdnHosts: string[];
  capture: { id: string; pageKinds: string[]; urlPattern: string; maxBytes?: number }[];
  globals: string[];
  referer?: { value: string; hosts: string[] };
  supportsMobileMode?: boolean;
}

export interface FeatureManifestData {
  id: string;
  title: string;
  icon: string;
  order: number;
  platforms?: string[];
  requires: string[];
  commands?: { id: string; title: string; suggestedKey?: string }[];
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && d.name !== 'shared')
    .map((d) => d.name)
    .sort();
}

async function loadDefault<T>(file: string): Promise<T | null> {
  if (!existsSync(file)) return null;
  const mod = (await import(pathToFileURL(file).href)) as { default: T };
  return mod.default;
}

export async function generate(rootDir = root): Promise<BuildManifest> {
  const platformsDir = join(rootDir, 'src', 'platforms');
  const featuresDir = join(rootDir, 'src', 'features');

  const platforms: PlatformManifestData[] = [];
  for (const name of subdirs(platformsDir)) {
    const m = await loadDefault<PlatformManifestData>(join(platformsDir, name, 'manifest.ts'));
    if (m) platforms.push(m);
  }
  platforms.sort((a, b) => a.id.localeCompare(b.id));

  const features: FeatureManifestData[] = [];
  for (const name of subdirs(featuresDir)) {
    const m = await loadDefault<FeatureManifestData>(join(featuresDir, name, 'manifest.ts'));
    if (m) features.push(m);
  }
  features.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const featureCommands: BuildManifest['featureCommands'] = {};
  for (const f of features) {
    for (const c of f.commands ?? []) {
      if (!c.suggestedKey) continue;
      featureCommands[c.id] = { suggested_key: { default: c.suggestedKey }, description: c.title };
    }
  }

  const out: BuildManifest = { platforms, features, featureCommands };
  const outFile = join(rootDir, 'src', 'generated', 'build-manifest.json');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return out;
}

/** --check 模式：只校验生成物是不是最新的（CI 用） */
export async function checkFresh(rootDir = root): Promise<boolean> {
  const outFile = join(rootDir, 'src', 'generated', 'build-manifest.json');
  if (!existsSync(outFile)) return false;
  const before = readFileSync(outFile, 'utf8');
  const manifest = await generate(rootDir);
  return before === JSON.stringify(manifest, null, 2) + '\n';
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const check = process.argv.includes('--check');
  if (check) {
    const ok = await checkFresh();
    console.log(ok ? 'build-manifest.json is up to date' : 'build-manifest.json is STALE');
    if (!ok) process.exitCode = 1;
  } else {
    const m = await generate();
    console.log(
      `wrote src/generated/build-manifest.json: ${m.platforms.length} platforms, ` +
        `${m.features.length} features, ${Object.keys(m.featureCommands).length} commands`,
    );
  }
}
