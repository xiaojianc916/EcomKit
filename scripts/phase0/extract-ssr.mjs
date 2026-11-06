/**
 * Phase 0：不经过浏览器渲染，直接从服务端返回的 HTML 里提取 SSR 全局变量。
 * 用于拿到最原始、未被登录跳转干扰的商品数据结构。
 *
 * 用法：node scripts/phase0/extract-ssr.mjs <url> [globalName] [outName]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const rawDir = join(root, '.phase0-raw');
mkdirSync(rawDir, { recursive: true });

const [, , urlArg, globalName = 'rawData', nameArg] = process.argv;
if (!urlArg) {
  console.error('usage: node scripts/phase0/extract-ssr.mjs <url> [globalName] [outName]');
  process.exit(2);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const res = await fetch(urlArg, {
  headers: {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  },
  redirect: 'follow',
});
const html = await res.text();

/** 从 `window.<name> = {...}` 里做括号配平提取 JSON（允许 = 两侧任意空白） */
function extractGlobal(htmlText, name) {
  const patterns = [
    new RegExp(`window\\s*\\.\\s*${name}\\s*=\\s*(?=\\{)`),
    new RegExp(`window\\s*\\[\\s*["']${name}["']\\s*\\]\\s*=\\s*(?=\\{)`),
    new RegExp(`(?:var|let|const)\\s+${name}\\s*=\\s*(?=\\{)`),
    new RegExp(`(?<![\\w.])window\\s*\\.\\s*${name}\\s*=\\s*`),
  ];
  for (const re of patterns) {
    const m = re.exec(htmlText);
    if (!m) continue;
    const start = htmlText.indexOf('{', m.index + m[0].length - 1);
    if (start < 0) continue;
    let depth = 0;
    let inStr = null;
    let escaped = false;
    for (let i = start; i < htmlText.length; i++) {
      const c = htmlText[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'") {
        inStr = c;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const slice = htmlText.slice(start, i + 1);
          try {
            return JSON.parse(slice);
          } catch (e) {
            return { __parseError: String(e), __raw: slice.slice(0, 500) };
          }
        }
      }
    }
  }
  return null;
}

function skeleton(value, depth = 0, maxDepth = 6) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return depth >= maxDepth
      ? `[array:${value.length}]`
      : [skeleton(value[0], depth + 1, maxDepth)];
  }
  const t = typeof value;
  if (t === 'string')
    return value.length > 160 ? `string(${value.length}) ${value.slice(0, 80)}…` : value;
  if (t === 'number' || t === 'boolean') return value;
  if (t !== 'object') return t;
  if (depth >= maxDepth) return 'object';
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 120))
    out[k] = skeleton(v, depth + 1, maxDepth);
  return out;
}

const data = extractGlobal(html, globalName);
const name = nameArg ?? `ssr-${Date.now()}`;

writeFileSync(join(rawDir, `${name}.html`), html, 'utf8');
if (data) writeFileSync(join(rawDir, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');

console.log(
  JSON.stringify(
    {
      name,
      status: res.status,
      finalUrl: res.url,
      htmlBytes: html.length,
      found: Boolean(data),
      topKeys: data ? Object.keys(data) : [],
      skeleton: data ? skeleton(data) : null,
    },
    null,
    2,
  ),
);
