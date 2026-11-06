/**
 * 从内联脚本里同步读 SSR 全局变量。
 *
 * 为什么需要：`rawData` 是页面 MAIN world 的变量，ISOLATED world 里读不到，
 * 正常路径是经 bridge 的 readGlobal()。但 detectBlocker 是**同步**签名（契约在
 * src/platforms/types.ts），拿不到 Promise，而登录墙判定必须在挂 UI 的那一刻就出结果。
 * 好在 SSR 数据是内联在 HTML 里的 `<script>window.rawData={…}</script>`，
 * ISOLATED world 能直接读 script 的文本，所以用它做一次同步兜底。
 *
 * 只用于**判定**（needLogin / 有没有商品数据），不作为数据源：
 * 解析失败、体积过大、脚本被 CSP 换掉都只会让判定退化成「不阻断」，不影响主流程。
 */

/** 单个脚本的解析上限：SSR 数据通常 < 2MB，超过直接放弃，避免卡住页面 */
const MAX_SCRIPT_CHARS = 3_000_000;

/**
 * 在文档的内联脚本里找 `window.<name> = {…}` 并解析成 JSON。
 * 找不到或解析失败返回 undefined。
 */
export function readInlineGlobal(doc: Document, name: string): unknown {
  let scripts: HTMLScriptElement[];
  try {
    scripts = Array.from(doc.querySelectorAll('script:not([src])'));
  } catch {
    return undefined;
  }

  for (const script of scripts) {
    const text = script.textContent ?? '';
    if (text === '' || text.length > MAX_SCRIPT_CHARS) continue;
    if (!text.includes(name)) continue;

    const json = extractAssignedObject(text, name);
    if (json !== undefined) return json;
  }
  return undefined;
}

/**
 * 三种赋写法的正则缓存。
 *
 * readInlineGlobal 会对每个内联 <script> 调用一次 extractAssignedObject，
 * 而 readInlineGlobal 本身在一次页面识别里要被调用好几次（detectBlocker 一次、
 * ssrSource 一次、readInlineSsr 每种全局各一次）。脚本多 + 名字多 = 每次几十个正则编译。
 * name 的取值是有限集合（rawData / __INITIAL_STATE__ / _ROUTER_DATA …），编译一次即可。
 */
const ASSIGN_RE_CACHE = new Map<string, readonly RegExp[]>();

function assignPatterns(name: string): readonly RegExp[] {
  const cached = ASSIGN_RE_CACHE.get(name);
  if (cached !== undefined) return cached;
  // name 拼进正则前先转义：平台字段名目前都是纯标识符，但转义后不会因为将来改名出岔子
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`window\\s*\\.\\s*${escaped}\\s*=\\s*(?=\\{)`),
    new RegExp(`window\\s*\\[\\s*['"]${escaped}['"]\\s*\\]\\s*=\\s*(?=\\{)`),
    new RegExp(`(?:var|let|const)\\s+${escaped}\\s*=\\s*(?=\\{)`),
  ];
  ASSIGN_RE_CACHE.set(name, patterns);
  return patterns;
}

/** 支持 window.name / window['name'] / var name 三种写法，并做括号配平 */
export function extractAssignedObject(code: string, name: string): unknown {
  for (const re of assignPatterns(name)) {
    const m = re.exec(code);
    if (!m) continue;
    const start = code.indexOf('{', m.index + m[0].length - 1);
    if (start < 0) continue;
    const slice = balancedObject(code, start);
    if (slice === undefined) continue;
    try {
      return JSON.parse(slice);
    } catch {
      // SSR 里有时会带 `undefined` 之类非法 JSON，交给下一种写法
    }
  }
  return undefined;
}

/** 从 start 位置的 { 开始做括号配平（跳过字符串里的括号），返回完整的对象字面量 */
function balancedObject(code: string, start: number): string | undefined {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  return undefined;
}
