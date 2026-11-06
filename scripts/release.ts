/**
 * 发布脚本（§14）：构建 → 打 zip → 写版本号和更新日志。
 *
 * 用法：
 *   node scripts/release.ts            # 用 package.json 里的版本
 *   node scripts/release.ts --bump patch
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pkgPath = join(root, 'package.json');

function sh(cmd: string): string {
  return execSync(cmd, { cwd: root, stdio: 'pipe', encoding: 'utf8' });
}

function readPkg(): { version: string; [k: string]: unknown } {
  return JSON.parse(readFileSync(pkgPath, 'utf8'));
}

function main(): void {
  const pkg = readPkg();
  let version = pkg.version as string;

  const bumpIdx = process.argv.indexOf('--bump');
  if (bumpIdx >= 0) {
    const kind = process.argv[bumpIdx + 1] as 'patch' | 'minor' | 'major';
    if (!['patch', 'minor', 'major'].includes(kind)) {
      console.error('--bump 只接受 patch | minor | major');
      process.exit(2);
    }
    const [maj, min, pat] = version.split('.').map(Number) as [number, number, number];
    version =
      kind === 'major'
        ? `${maj + 1}.0.0`
        : kind === 'minor'
          ? `${maj}.${min + 1}.0`
          : `${maj}.${min}.${pat + 1}`;
    pkg.version = version;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    console.log('版本更新为', version);
  }

  // 固定扩展 ID 的公钥：只在本地 keys/ 里，通过环境变量注入构建
  const pubPath = join(root, 'keys', 'public-key.b64');
  if (existsSync(pubPath)) {
    process.env.ECBOX_PUBLIC_KEY = readFileSync(pubPath, 'utf8').trim();
    console.log('已注入固定扩展 ID 的公钥');
  } else {
    console.warn('警告：没有 keys/public-key.b64，本次构建的扩展 ID 会随安装路径变化。');
    console.warn('      先运行 node scripts/gen-key.ts 生成。');
  }

  console.log('构建中…');
  sh('bun run build');

  console.log('打包中…');
  sh('bun run zip');

  const zipDir = join(root, '.output');
  const zips = existsSync(zipDir)
    ? execSync(`dir /b "${zipDir}\\*.zip"`, { cwd: root, encoding: 'utf8', shell: 'cmd.exe' })
        .split(/\r?\n/)
        .filter(Boolean)
    : [];

  const changelog = join(root, 'CHANGELOG.md');
  const entry = `## ${version} — ${new Date().toISOString().slice(0, 10)}\n\n- 见提交记录\n\n`;
  if (existsSync(changelog)) {
    const body = readFileSync(changelog, 'utf8');
    writeFileSync(changelog, entry + body, 'utf8');
  } else {
    writeFileSync(changelog, `# 更新日志\n\n${entry}`, 'utf8');
  }

  console.log('产物：', zips.length ? zips.join(', ') : '（见 .output 目录）');
  console.log('版本：', version);
}

main();
