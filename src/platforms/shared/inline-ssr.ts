/**
 * 从内联脚本里同步读 SSR 全局变量。
 *
 * 为什么需要：`rawData` 是页面 MAIN world 的变量，ISOLATED world 里读不到，
 * 正常路径是经 bridge 的 readGlobal()。但 detectBlocker 是**同步**签名（契约在
 * src/platforms/types.ts），拿不到 Promise，而登录墙判定必须在挂 UI 的那一刻就出结果。
 * 好在 SSR 数据是内联在 HTML 里的 `<script>window.rawData={…}</script>`，
 * ISOLATED world 能直接读 script 的文本，所以用它做一次同步兜底。
 *
 * 两个用途：
 *   1. 同步阻断判定（needLogin / 有没有商品数据）—— 必须是同步的；
 *   2. 解析时的快路径 —— resolver-runner 先试内联读取，读不到才走 bridge 的
 *      readGlobal()（跨 world 的 JSON 往返）。常见情况下第 2 条完全省掉一次 IPC。
 *
 * 解析失败、体积过大、脚本被 CSP 换掉都只会让调用方退到下一来源，不影响主流程。
 */

/** 单个脚本的解析上限：SSR 数据通常 < 2MB，超过直接放弃，避免卡住页面 */
const MAX_SCRIPT_CHARS = 3_000_000;

/**
 * 每个 Document 上一次解析结果的缓存。
 *
 * 为什么必须缓存：一次页面识别里同一个名字至少要被读两次 ——
 * PageController 的同步阻断判定一次、SSR 数据源经 readGlobal() 再一次。
 * 而每次调用的代价是「取出整个内联脚本的 textContent + includes 扫描 +
 * 括号配平 + JSON.parse」，实测 276KB 的 rawData 单次约 5ms（happy-dom），
 * 真实商品页常见 1~3MB，就是两次 20~50ms 的页面主线程卡顿。
 *
 * 失效条件（两条都要有）：
 *   · 内联脚本数量变化 —— SPA 切换商品时通常会新插入 SSR 脚本；
 *   · 调用方显式 clearInlineGlobalCache(doc) —— pushState 换商品也可能原地改写
 *     window.rawData 而脚本数量不变，这种情况只能由知道「换商品了」的调用方通知。
 *
 * 缓存的是**解析后的对象引用**：调用方只读（findPddRoots 本来就用 WeakMap 按对象缓存）。
 */
interface InlineCache {
  scriptCount: number;
  values: Map<string, unknown>;
}

const INLINE_CACHE = new WeakMap<Document, InlineCache>();

function inlineScripts(doc: Document): HTMLScriptElement[] | null {
  try {
    return Array.from(doc.querySelectorAll('script:not([src])'));
  } catch {
    return null;
  }
}

function scanScripts(scripts: readonly HTMLScriptElement[], name: string): unknown {
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
 * 在文档的内联脚本里找 `window.<name> = {…}` 并解析成 JSON。
 * 找不到或解析失败返回 undefined。同一份文档 + 同一个名字只解析一次（见 InlineCache）。
 */
export function readInlineGlobal(doc: Document, name: string): unknown {
  const scripts = inlineScripts(doc);
  if (scripts === null) return undefined;

  let cache = INLINE_CACHE.get(doc);
  if (cache === undefined || cache.scriptCount !== scripts.length) {
    cache = { scriptCount: scripts.length, values: new Map() };
    INLINE_CACHE.set(doc, cache);
  }
  if (cache.values.has(name)) return cache.values.get(name);

  const value = scanScripts(scripts, name);
  cache.values.set(name, value);
  return value;
}

/** 丢掉某份文档的缓存（PageController 在识别到新商品时调用，见 InlineCache 的说明） */
export function clearInlineGlobalCache(doc: Document): void {
  INLINE_CACHE.delete(doc);
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
