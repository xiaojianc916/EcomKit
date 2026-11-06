import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'wxt';
import { type BuildManifest, generate } from './scripts/gen-registries';

/**
 * manifest 的 matches / host_permissions / commands 全部由平台层和功能层的
 * manifest.ts 生成（§12）。源头只有一处，避免手写清单和代码漂移。
 */
function loadBuildManifest(): BuildManifest {
  const file = resolve(__dirname, 'src/generated/build-manifest.json');
  if (!existsSync(file)) {
    return { platforms: [], features: [], featureCommands: {} };
  }
  return JSON.parse(readFileSync(file, 'utf8')) as BuildManifest;
}

const build = loadBuildManifest();

const PLATFORM_MATCHES = [
  ...new Set(build.platforms.flatMap((p) => p.pageKinds.flatMap((k) => k.matches))),
];
const CDN_HOSTS = [
  ...new Set(build.platforms.flatMap((p) => p.cdnHosts.map((h) => `https://${h}/`))),
];
const REFERER_HOSTS = [
  ...new Set(build.platforms.flatMap((p) => p.referer?.hosts ?? []).map((h) => `https://${h}/`)),
];

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '电商素材工具箱',
    description: '拼多多、抖音商品主图、SKU 图、详情图、视频归档下载',
    // 固定扩展 ID：公钥来自 scripts/gen-key.ts，私钥不入库（§14）
    ...(process.env.ECBOX_PUBLIC_KEY ? { key: process.env.ECBOX_PUBLIC_KEY } : {}),
    minimum_chrome_version: '122',
    permissions: ['storage', 'offscreen', 'downloads', 'declarativeNetRequestWithHostAccess'],
    host_permissions: [...PLATFORM_MATCHES, ...CDN_HOSTS, ...REFERER_HOSTS],
    action: { default_title: '电商素材工具箱' },
    commands: {
      'toggle-toolbox': {
        suggested_key: { default: 'Alt+Shift+E' },
        description: '展开或收起工具箱',
      },
      ...build.featureCommands,
    },
  },
  hooks: {
    // 构建前重新生成清单，保证改了平台/功能 manifest 即时生效
    'build:before': async () => {
      await generate();
    },
  },
});
