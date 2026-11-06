/**
 * 构建入口：先生成清单，再注入固定扩展 ID 的公钥，最后调 wxt build。
 *
 * 为什么要包一层：
 *   1. src/generated/build-manifest.json 必须在 wxt 读配置前就绪（它决定 matches / host_permissions）
 *   2. 固定扩展 ID 的公钥在 keys/public-key.b64（不入库），要经环境变量传给 manifest.key ——
 *      不注入的话扩展 ID 会随安装路径变化，用户设置和目录授权全部丢失（§14）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './gen-registries.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

async function main(): Promise<void> {
  // 1. 平台 / 功能的 manifest 汇总（决定 matches、host_permissions、commands）
  const build = await generate(root);
  console.log(
    '[build] ' + build.platforms.length + ' platforms, ' + build.features.length + ' features',
  );

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
  //
  // 用 spawnSync 而不是 execSync：Windows 上 pnpm 装的是 .cmd 启动器，execSync 会经
  // cmd.exe 再解析一次命令串；spawnSync + shell 只交给一次 shell，且能拿到真实退出码。
  // 旧实现不检查退出码 —— 构建失败时脚本本身仍返回 0，CI 上看不出来。
  // 整串交给 shell（而不是「命令 + 参数数组 + shell」）：后者在 Node 22 会触发
  // DEP0190（参数不转义直接拼接），而且 .cmd 启动器本来也只能由 shell 执行。
  const result = spawnSync('pnpm exec wxt build', {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

void main();
