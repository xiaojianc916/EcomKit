/**
 * Phase 0 真机采样（方案 §17）。
 *
 * 用系统 Chrome（Playwright channel: 'chrome'）打开真实商品页，导出：
 *   - window 全局变量白名单的 JSON 结构骨架
 *   - 旁听到的 JSON 接口响应（结构骨架 + 原始 JSON）
 *   - 页面上的 IMG/VIDEO 元素与资源列表
 *   - 去掉 script 的 HTML 快照
 *
 * 用法：
 *   node scripts/phase0/sample.mjs <pdd|douyin> <url> [outName] [--mobile]
 *
 * 产物落在 .phase0-raw/（已 gitignore）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const rawDir = join(root, '.phase0-raw');
mkdirSync(rawDir, { recursive: true });

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const args = argv.filter((a) => !a.startsWith('--'));
const [platformArg, urlArg, nameArg] = args;
if (!platformArg || !urlArg) {
  console.error('usage: node scripts/phase0/sample.mjs <pdd|douyin> <url> [outName] [--mobile]');
  process.exit(2);
}

const MOBILE = flags.has('--mobile');

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

const GLOBAL_PATHS = {
  pdd: [
    'rawData',
    'rawData.store',
    'rawData.store.initDataObj',
    'rawData.store.initDataObj.goods',
    'rawData.store.initDataObj.mall',
    '_oakRawData',
    '__NEXT_DATA__',
  ],
  douyin: [
    '__INITIAL_STATE__',
    '_ROUTER_DATA',
    '__NEXT_DATA__',
    'RENDER_DATA',
    '__SSR_DATA__',
    '__INITIAL_SSR_STATE__',
  ],
};

const CAPTURE_HINTS = {
  pdd: /goods|detail|mall|sku/i,
  douyin: /product|detail|ecommerce|promotion|sku|api/i,
};

function skeleton(value, depth = 0, maxDepth = 5) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return depth >= maxDepth
      ? `[array:${value.length}]`
      : [skeleton(value[0], depth + 1, maxDepth)];
  }
  const t = typeof value;
  if (t === 'string')
    return value.length > 120 ? `string(${value.length}) ${value.slice(0, 60)}…` : value;
  if (t === 'number' || t === 'boolean') return value;
  if (t !== 'object') return t;
  if (depth >= maxDepth) return 'object';
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 80))
    out[k] = skeleton(v, depth + 1, maxDepth);
  return out;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: MOBILE ? { width: 414, height: 896 } : { width: 1440, height: 900 },
  userAgent: MOBILE ? UA_MOBILE : UA_DESKTOP,
  isMobile: MOBILE,
  hasTouch: MOBILE,
  deviceScaleFactor: MOBILE ? 2 : 1,
});

const captured = [];
const page = await context.newPage();

page.on('response', async (res) => {
  try {
    const u = res.url();
    const ct = res.headers()['content-type'] ?? '';
    if (!ct.includes('json')) return;
    if (!CAPTURE_HINTS[platformArg].test(u)) return;
    const body = await res.text().catch(() => '');
    if (!body || body.length > 4_000_000) return;
    captured.push({ url: u, status: res.status(), bytes: body.length, json: JSON.parse(body) });
  } catch {
    /* 旁听失败不影响主流程 */
  }
});

const started = Date.now();
let navError = null;
try {
  await page.goto(urlArg, { waitUntil: 'domcontentloaded', timeout: 60_000 });
} catch (e) {
  navError = String(e.message ?? e);
}
await page.waitForTimeout(9000);

const report = await page.evaluate(
  ({ globalPaths }) => {
    const out = {
      globals: {},
      resources: [],
      images: [],
      videos: [],
      bodyText: '',
      title: document.title,
    };
    for (const path of globalPaths) {
      try {
        const value = path
          .split('.')
          .reduce((acc, k) => (acc == null ? undefined : acc[k]), window);
        out.globals[path] = value === undefined ? '__undefined__' : value;
      } catch (e) {
        out.globals[path] = `__error__:${String(e)}`;
      }
    }
    out.resources = performance
      .getEntriesByType('resource')
      .map((r) => r.name)
      .filter((n) => /goods|detail|product|sku|api\/|promotion/i.test(n))
      .slice(0, 80);
    out.images = [...document.querySelectorAll('img')].slice(0, 120).map((i) => ({
      src: i.currentSrc || i.src,
      w: i.naturalWidth,
      h: i.naturalHeight,
      cls: String(i.className).slice(0, 60),
    }));
    out.videos = [...document.querySelectorAll('video')].slice(0, 20).map((v) => ({
      src: v.currentSrc || v.src,
      sources: [...v.querySelectorAll('source')].map((s) => s.src),
    }));
    out.bodyText = document.body?.textContent?.slice(0, 4000) ?? '';
    return out;
  },
  { globalPaths: GLOBAL_PATHS[platformArg] ?? [] },
);

const name = nameArg ?? `${platformArg}-${Date.now()}`;
const html = await page.content();
const htmlNoScript = html.replace(/<script[\s\S]*?<\/script>/gi, '');

const out = {
  platform: platformArg,
  mobile: MOBILE,
  url: urlArg,
  finalUrl: page.url(),
  fetchedAt: new Date().toISOString(),
  elapsedMs: Date.now() - started,
  navError,
  title: report.title,
  globals: Object.fromEntries(
    Object.entries(report.globals).map(([k, v]) => [k, v === '__undefined__' ? v : skeleton(v)]),
  ),
  globalsRaw: report.globals,
  resources: report.resources,
  images: report.images,
  videos: report.videos,
  bodyText: report.bodyText,
  captured: captured.map((c) => ({
    url: c.url,
    status: c.status,
    bytes: c.bytes,
    skeleton: skeleton(c.json),
  })),
  capturedRaw: captured,
  htmlNoScript,
};

writeFileSync(join(rawDir, `${name}.json`), JSON.stringify(out, null, 2), 'utf8');
writeFileSync(join(rawDir, `${name}.html`), html, 'utf8');

console.log(
  JSON.stringify(
    {
      name,
      mobile: MOBILE,
      finalUrl: out.finalUrl,
      navError,
      title: out.title,
      definedGlobals: Object.entries(out.globals)
        .filter(([, v]) => v !== '__undefined__')
        .map(([k]) => k),
      images: report.images.length,
      videos: report.videos.length,
      resources: report.resources.slice(0, 15),
      captured: captured.map((c) => ({ url: c.url.slice(0, 140), bytes: c.bytes })),
      bodyTextHead: out.bodyText.slice(0, 500),
    },
    null,
    2,
  ),
);

await browser.close();
