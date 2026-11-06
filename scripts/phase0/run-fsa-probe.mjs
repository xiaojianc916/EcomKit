/**
 * 用真实 Chrome 加载 fsa-probe 扩展，验证 Phase 0 §17-1 / §17-2。
 * 结论写到 .phase0-raw/fsa-probe-result.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const extPath = join(here, 'fsa-probe');
const outDir = join(root, '.phase0-raw');
mkdirSync(outDir, { recursive: true });

const userDataDir = join(outDir, 'chrome-profile-fsa');

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
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

let extId = null;

// 方式 1：等 serviceworker 事件
try {
  const sw =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 8000 }));
  extId = new URL(sw.url()).host;
  console.log('ext id via serviceworker:', extId);
} catch {
  console.log('no serviceworker event, falling back to chrome://extensions');
}

// 方式 2：读 chrome://extensions 的 DOM
if (!extId) {
  const p = await context.newPage();
  await p.goto('chrome://extensions/');
  await p.waitForTimeout(2500);
  extId = await p.evaluate(() => {
    const mgr = document.querySelector('extensions-manager');
    const itemList = mgr?.shadowRoot?.querySelector('extensions-item-list');
    const items = itemList?.shadowRoot?.querySelectorAll('extensions-item') ?? [];
    for (const item of items) {
      const id = item.getAttribute('id');
      const name = item.shadowRoot?.querySelector('#name')?.textContent;
      if (id && name?.includes('EcBox')) return id;
      if (id) return id;
    }
    return null;
  });
  console.log('ext id via chrome://extensions:', extId);
  await p.close();
}

if (!extId) {
  console.log('ALL LOGS:', JSON.stringify(logs.slice(-40), null, 2));
  writeFileSync(
    join(outDir, 'fsa-probe-result.json'),
    JSON.stringify({ error: 'no ext id', logs }, null, 2),
  );
  await context.close();
  process.exit(1);
}

const page = await context.newPage();
page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }));
await page.goto(`chrome-extension://${extId}/probe.html`);
await page
  .waitForFunction(
    () => {
      const t = document.getElementById('out')?.textContent ?? '';
      return t.includes('DONE') || t.includes('FATAL');
    },
    { timeout: 60_000 },
  )
  .catch(() => {});

const outText = await page.textContent('#out');
let parsed = null;
try {
  parsed = JSON.parse(outText ?? '[]');
} catch {
  parsed = outText;
}

// 尝试直接抓 offscreen 文档
await page.waitForTimeout(1500);
const offscreenPages = context.pages().filter((p) => p.url().includes('offscreen'));
const offscreenLogs = logs.filter((l) => /OFFSCREEN/.test(l.text));

writeFileSync(
  join(outDir, 'fsa-probe-result.json'),
  JSON.stringify(
    {
      extId,
      parsed,
      offscreenPages: offscreenPages.map((p) => p.url()),
      offscreenLogs,
      logs: logs.slice(-80),
    },
    null,
    2,
  ),
  'utf8',
);

console.log(
  JSON.stringify(
    { extId, parsed, offscreenPageUrls: offscreenPages.map((p) => p.url()), offscreenLogs },
    null,
    2,
  ),
);
await context.close();
