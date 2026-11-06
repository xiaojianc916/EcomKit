/**
 * 加载构建产物到真实 Chrome，验证扩展能起来。
 *
 * 为什么需要：`bun run build` 成功只说明打包没报错，不代表扩展能在浏览器里加载。
 * manifest 写错、SW 启动抛异常、内容脚本注入范围错，都只有真正加载才看得出来。
 *
 * 跑法：node scripts/verify-build.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const extPath = join(root, '.output', 'chrome-mv3');
const outDir = join(root, '.phase0-raw');
mkdirSync(outDir, { recursive: true });

const profile = join(outDir, 'chrome-profile-verify');

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

const logs = [];
context.on('console', (m) => logs.push({ type: m.type(), text: m.text() }));

const result = { steps: [] };
const push = (k, v) => {
  result.steps.push({ k, v });
  console.log(k, '=', JSON.stringify(v));
};

// 1. service worker 起来了吗
let sw = context.serviceWorkers()[0];
if (!sw) {
  try {
    sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  } catch {
    push('serviceWorker', 'NOT FOUND');
  }
}

if (sw) {
  const extId = new URL(sw.url()).host;
  push('extensionId', extId);
  push('serviceWorker', sw.url());

  // 2. manifest 里的关键字段
  const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
  push('manifest.name', manifest.manifest_version === 3 ? manifest.name : 'not-mv3');
  push('manifest.permissions', manifest.permissions);
  push('manifest.contentScripts', manifest.content_scripts?.length ?? 0);

  // 3. options / popup / grant 页面能打开吗
  for (const page of ['options.html', 'popup.html', 'grant.html']) {
    const p = await context.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    try {
      const res = await p.goto(`chrome-extension://${extId}/${page}`, { timeout: 15000 });
      await p.waitForTimeout(1200);
      const hasRoot = await p.evaluate(() => {
        const root = document.getElementById('root');
        return root ? root.childElementCount > 0 : false;
      });
      push(page, { status: res?.status(), rendered: hasRoot, errors });
    } catch (e) {
      push(page, { error: String(e).slice(0, 200) });
    }
    await p.close();
  }

  // 4. 打开一个非商品页，确认内容脚本不会乱注入
  const p = await context.newPage();
  await p.goto('https://example.com');
  await p.waitForTimeout(2000);
  const injected = await p.evaluate(() => Boolean(document.querySelector('ecbox-root')));
  push('injectOnNonProductPage', injected === false ? 'correctly skipped' : 'WRONGLY INJECTED');
  await p.close();
}

writeFileSync(
  join(outDir, 'build-verify.json'),
  JSON.stringify({ result, logs: logs.slice(-60) }, null, 2),
  'utf8',
);
push(
  'consoleErrors',
  logs.filter((l) => l.type === 'error').map((l) => l.text.slice(0, 160)),
);

await context.close();
