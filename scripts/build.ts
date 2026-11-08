/**
 * 构建入口：先生成清单，再注入固定扩展 ID 的公钥，最后调 wxt build。
 *
 * 为什么要包一层：
 *   1. src/generated/build-manifest.json 必须在 wxt 读配置前就绪（它决定 matches / host_permissions）
 *   2. 固定扩展 ID 的公钥在 keys/public-key.b64（不入库），要经环境变量传给 manifest.key ——
 *      不注入的话扩展 ID 会随安装路径变化，用户设置和目录授权全部丢失（§14）
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './gen-registries.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/**
 * 构建完成后把产物同步到「加载已解压的扩展程序」指向的目录。
 *
 * Chrome 从固定目录读代码，不覆盖它就还是上一次构建的版本 —— 改完刷新页面
 * 看不到任何变化，很容易误判成「没修好」。目标是纯构建产物目录，先清空再
 * 全量复制，避免旧的 hash chunk 残留下来。
 *
 * 默认 D:\Tools\EcBox（本机日常加载目录）；目录不存在（CI / 别的机器）就跳过。
 * 需要换位置时用 ECBOX_OUT_DIR 指定（此时即使目录不存在也会创建）。
 */
function syncExtensionDir(): void {
  const explicit = process.env.ECBOX_OUT_DIR;
  const target = explicit ?? 'D:\\Tools\\EcBox';
  if (explicit === undefined && !existsSync(target)) {
    console.log('[build] 未发现扩展加载目录，跳过同步（可用 ECBOX_OUT_DIR 指定）');
    return;
  }
  const built = join(root, '.output', 'chrome-mv3');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(built, target, { recursive: true });
  console.log(`[build] 已同步到 ${target}`);
}

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
  // 直接调本地 bin：不带 shell 就没有 Windows 上的 .cmd 再解析一遍的问题，
  // 参数数组也不触发 Node 22 的 DEP0190。旧实现不检查退出码 —— 构建失败时
  // 脚本本身仍返回 0，CI 上看不出来。
  const bin = join(root, 'node_modules', '.bin', 'wxt');
  const result = spawnSync(bin, ['build'], { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }

  // 4. 构建成功才同步：失败时保留上一次可用的扩展目录
  syncExtensionDir();
}

void main();
