/**
 * 把构建好的扩展安装进 Chrome / Edge（Windows）。
 *
 * 为什么需要这个脚本：
 *   Chrome 137+ 移除了 --load-extension 命令行开关（安全策略），Playwright 也装不进去了。
 *   但 DevTools Protocol 在 **browser target** 上有 Extensions.loadUnpacked，
 *   配合 --enable-unsafe-extension-debugging 可以自动加载解压扩展。
 *
 * 用法：
 *   node scripts/install-extension.mjs <chrome|edge> [--ext <path>] [--profile <dir>] [--keep-open]
 *
 * 默认：
 *   - 扩展目录 D:\\Tools\\EcBox
 *   - 用独立的 EcBox profile（不碰日常 profile，最安全）
 *   - 装完自动关闭浏览器（加 --keep-open 可保留）
 *
 * 想装进日常使用的 profile：加 --profile "C:\\Users\\<你>\\AppData\\Local\\Google\\Chrome\\User Data"
 * （注意：装之前必须完全退出那个浏览器的所有窗口，否则 profile 被占用会启动失败）
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const browser = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'chrome';
const extPath = arg('--ext', 'D:\\Tools\\EcBox');
const profileDir = arg('--profile', join(root, '.phase0-raw', 'ecbox-profile'));
const keepOpen = process.argv.includes('--keep-open');

const BROWSERS = {
  chrome: {
    exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    exeAlt: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    port: 9222,
  },
  edge: {
    exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    exeAlt: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    port: 9223,
  },
};

const cfg = BROWSERS[browser];
if (!cfg)
  fail(
    '用法: node scripts/install-extension.mjs <chrome|edge> [--ext <path>] [--profile <dir>] [--keep-open]',
  );

const exe = existsSync(cfg.exe) ? cfg.exe : existsSync(cfg.exeAlt) ? cfg.exeAlt : null;
if (!exe) fail('找不到 ' + browser + ' 的可执行文件');
if (!existsSync(join(extPath, 'manifest.json'))) fail('扩展目录里没有 manifest.json: ' + extPath);

mkdirSync(profileDir, { recursive: true });

// 检测这个 profile 是不是正在被占用 —— 占用时浏览器会直接退出，报错很难懂
const running = spawnSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
     Where-Object { $_.CommandLine -notlike '*--type=*' } |
     ForEach-Object { $_.CommandLine }`,
  ],
  { encoding: 'utf8' },
);

const cmdlines = (running.stdout ?? '').split('\n').filter(Boolean);
const normalizedProfile = profileDir.replace(/\\/g, '\\');
const isDefaultProfile = /User Data\s*$/i.test(profileDir);
const occupied = isDefaultProfile
  ? cmdlines.some((c) => !/--user-data-dir=/.test(c)) ||
    cmdlines.some((c) => c.includes('User Data'))
  : cmdlines.some((c) => c.includes(normalizedProfile));

if (occupied) {
  console.error('');
  console.error('❌ 这个 profile 正在被浏览器占用，请先完全退出它。');
  console.error('   profile: ' + profileDir);
  console.error('');
  console.error('   关闭方法：任务栏右键浏览器图标 → 退出；');
  console.error('   或在任务管理器里结束所有 chrome.exe 进程。');
  console.error('');
  console.error('   ⚠️ 如果你不想关浏览器，改用手动安装（30 秒，不用关）：');
  console.error('     1. 地址栏打开 chrome://extensions');
  console.error('     2. 右上角打开「开发者模式」');
  console.error('     3. 点左上角「加载已解压的扩展程序」');
  console.error('     4. 选择文件夹：' + extPath);
  process.exit(1);
}

console.log('浏览器  :', exe);
console.log('扩展目录:', extPath);
console.log('profile :', profileDir);

const child = spawn(
  exe,
  [
    '--user-data-dir=' + profileDir,
    '--remote-debugging-port=' + cfg.port,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { detached: true, stdio: 'ignore' },
);
child.unref();

// 等 CDP 就绪
let wsUrl = null;
for (let i = 0; i < 30; i++) {
  try {
    const info = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json();
    wsUrl = info.webSocketDebuggerUrl;
    if (wsUrl) break;
  } catch {
    /* 还没起来 */
  }
  await sleep(500);
}
if (!wsUrl) fail('连不上浏览器的调试端口 ' + PORT + '（profile 可能被占用，请先完全退出该浏览器）');

// 校验：连上的必须是我们刚启动的这个实例，而不是恰好占了同端口的别的 Chrome
const versionInfo = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json();
const cdpCmd = versionInfo.webSocketDebuggerUrl;
if (!cdpCmd) fail('拿不到 CDP 地址');

// 关键：loadUnpacked 必须在 **browser target** 上调用，page target 会报 Method not available
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('WebSocket 连接失败'));
});

let seq = 0;
function cdpSend(method, params = {}) {
  return new Promise((resolve, reject) => {
    const myId = ++seq;
    const timer = setTimeout(() => reject(new Error('CDP 超时: ' + method)), 15000);
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== myId) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
}

let extensionId = null;
try {
  const result = await cdpSend('Extensions.loadUnpacked', { path: extPath });
  extensionId = result?.id ?? null;
} catch (e) {
  ws.close();
  fail('加载扩展失败: ' + e.message);
}
ws.close();

if (!extensionId) fail('加载扩展失败：没有返回扩展 ID');

// 和 keys/extension-id.txt 比对，确认固定 ID 生效
const idFile = join(root, 'keys', 'extension-id.txt');
let expected = null;
try {
  const { readFileSync } = await import('node:fs');
  expected = readFileSync(idFile, 'utf8').trim();
} catch {
  /* 没有就跳过比对 */
}

console.log('');
console.log('✅ 扩展已加载');
console.log('   扩展 ID:', extensionId);
if (expected) {
  console.log('   预期 ID:', expected, extensionId === expected ? '(一致 ✅)' : '(不一致 ⚠️)');
}
console.log('');
console.log('在地址栏打开以下页面确认：');
console.log('  设置页  : chrome-extension://' + extensionId + '/options.html');
console.log('  工具栏  : chrome-extension://' + extensionId + '/popup.html');
console.log('  扩展管理: chrome://extensions');

if (!keepOpen) {
  console.log('');
  console.log('（浏览器保持打开。关闭后用同样的 profile 重新启动即可，扩展会保留）');
}

function fail(msg) {
  console.error('');
  console.error('❌ ' + msg);
  process.exit(1);
}
