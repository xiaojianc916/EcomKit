/**
 * 构建入口：先生成清单，再注入固定扩展 ID 的公钥，最后调 wxt build。
 *
 * 为什么要包一层：
 *   1. src/generated/build-manifest.json 必须在 wxt 读配置前就绪（它决定 matches / host_permissions）
 *   2. 固定扩展 ID 的公钥在 keys/public-key.b64（不入库），要经环境变量传给 manifest.key ——
 *      不注入的话扩展 ID 会随安装路径变化，用户设置和目录授权全部丢失（§14）
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './gen-registries.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

async function main(): Promise<void> {
  // 1. 平台 / 功能的 manifest 汇总（决定 matches、host_permissions、commands）
  const build = await generate(root);
  console.log('[build] ' + build.platforms.length + ' platforms, ' + build.features.length + ' features');

  // 2. 固定扩展 ID
  const pubPath = join(root, 'keys', 'public-key.b64');
  if (existsSync(pubPath)) {
    process.env.ECBOX_PUBLIC_KEY = readFileSync(pubPath, 'utf8').trim();
    console.log('[build] fixed extension ID key injected');
  } else {
    console.warn('[build] 警告：没有 keys/public-key.b64，扩展 ID 会随安装路径变化。');
    console.warn('[build]       先运行 node scripts/gen-key.ts 生成。');
  }

  // 3. 交给 wxt（透传环境变量）
  execSync('pnpm exec wxt build', { cwd: root, stdio: 'inherit', env: process.env });
}

void main();
