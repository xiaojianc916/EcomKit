/**
 * Windows 文件名清洗（方案 §9.2）。
 *
 * 为什么必须在落盘前洗：商品标题来自平台，里面有营销符号、全角标点、控制符；
 * Windows 会直接拒绝 \ / : * ? " < > |、保留名和末尾的点，而 FSA 写入时只会抛一个
 * 看不出原因的 NotAllowedError。这里把方案 §9.2 的规则逐条实现，供平台层、功能层和
 * 写入层共用同一份实现（三处各写一套会让同一个商品建出两个文件夹）。
 */

/** 各类路径段的最大字素数（§9.2「路径长度」：FSA 拿不到绝对路径，只限制相对路径） */
export const NAME_LIMITS = {
  /** 平台文件夹，例如「拼多多」 */
  platform: 10,
  /** 商品文件夹，例如「夏季新款…_482319937501」 */
  folder: 50,
  /** 子文件夹，例如「主图」「SKU图」 */
  subdir: 10,
  /** 文件名主体（不含扩展名） */
  file: 40,
  /** 相对路径总长度上限，保证远小于 Windows MAX_PATH 的 260 */
  totalPath: 120,
} as const;

/** Windows 非法字符 → 全角对应字符（可读性保留；§9.2「规格值」里 / 变 ／ 是同一条规则） */
const FULLWIDTH_MAP: Readonly<Record<string, string>> = {
  '\\': '＼',
  '/': '／',
  ':': '：',
  '*': '＊',
  '?': '？',
  '"': '＂',
  '<': '＜',
  '>': '＞',
  '|': '｜',
};

const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;

/**
 * 控制符与零宽字符（§9.2）。区间 \u200B-\u200F 里含 ZWJ（\u200D），按方案原文一并移除，
 * 所以「家庭/职业」类组合 emoji 会被拆成多个独立 emoji。这是刻意取舍：
 * 不可见字符会让文件在资源管理器里显示成空白名，比拆 emoji 更难排查。
 */
/**
 * 删掉控制符和零宽字符。用码点判断而不是正则字面量：
 * Biome 的 noControlCharactersInRegex 会拦下正则里的控制符（而我们要匹配的恰恰是它们），
 * 逐字符判断也更直观，不必在正则转义里绕。
 */
function stripInvisible(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f;
    const isZeroWidth = code >= 0x200b && code <= 0x200f;
    const isBom = code === 0xfeff;
    if (!isControl && !isZeroWidth && !isBom) out += ch;
  }
  return out;
}

/** 连续分隔符合并成一个（§9.2「标题里的营销符号」） */
const SEPARATOR_RUN = /[-_｜|]{2,}/g;

/** 「空括号」判定：括号里只有空白、标点或符号 */
const ONLY_FILLER = /^[\s\p{P}\p{S}]*$/u;

/** 成对括号，内容只由标点和空白组成时整对删掉（「【】连衣裙」→「连衣裙」） */
const BRACKET_PAIRS: ReadonlyArray<readonly [open: string, close: string]> = [
  ['【', '】'],
  ['「', '」'],
  ['(', ')'],
  ['（', '）'],
];

/** Windows 保留设备名。大小写不敏感，带扩展名（CON.txt）同样被占用 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** 清洗后什么都不剩时的占位名，避免出现空文件名 */
export const FALLBACK_NAME = '未命名';

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
    : null;

/** 数一段文字有多少字素（emoji、组合字符都算 1 个）。Segmenter 不可用时退化成码点计数 */
export function countGraphemes(text: string): number {
  if (!segmenter) return Array.from(text).length;
  let count = 0;
  for (const _segment of segmenter.segment(text)) count += 1;
  return count;
}

/** 按字素截断，不会把一个 emoji 或组合字符切成半个（§9.2） */
export function truncateGraphemes(text: string, max: number): string {
  if (max <= 0) return '';
  if (!segmenter) return Array.from(text).slice(0, max).join('');
  let out = '';
  let count = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (count >= max) break;
    out += segment;
    count += 1;
  }
  return out;
}

/**
 * 大小写不敏感去重用的比较键（§9.2「大小写不敏感」）。
 * 同一目录内判重一律走这个函数，不许各处自己 toLowerCase。
 */
export function nameKey(name: string): string {
  return name.toLowerCase();
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeEmptyBrackets(text: string): string {
  let out = text;
  // 循环到稳定：嵌套的空括号（例如「【「」】」）要一层层剥掉
  for (;;) {
    let changed = false;
    for (const [open, close] of BRACKET_PAIRS) {
      const re = new RegExp(`${escapeRegExp(open)}([^]*?)${escapeRegExp(close)}`, 'u');
      const next = out.replace(re, (whole, inner: string) =>
        ONLY_FILLER.test(inner) ? '' : whole,
      );
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
    if (!changed) return out;
  }
}

/** Windows 不允许文件名以点或空格结尾（资源管理器可以建，但 API 和命令行会失败） */
function stripTrailingDotsAndSpaces(text: string): string {
  return text.replace(/^[\s]+/u, '').replace(/[. ]+$/u, '');
}

/** 保留名规避：在前面加下划线（CON → _CON，con.txt → _con.txt） */
function avoidReservedName(name: string): string {
  const dot = name.indexOf('.');
  const stem = dot >= 0 ? name.slice(0, dot) : name;
  if (!RESERVED_NAMES.has(stem.toUpperCase())) return name;
  return `_${name}`;
}

export interface SanitizeOptions {
  /** 按字素截断到的最大长度；不传则只做清洗 */
  maxLength?: number;
}

/**
 * 清洗一段文件名或文件夹名。纯函数，且幂等（sanitize(sanitize(x)) === sanitize(x)）。
 *
 * 顺序有讲究：先替换非法字符再合并分隔符，否则「a/｜b」这类组合会漏掉一次合并；
 * 截断之后要再清一次末尾的点和空格，避免截断刚好留下「标题.」这种结尾。
 */
export function sanitizeName(raw: string, opts: SanitizeOptions = {}): string {
  let out = raw.replace(ILLEGAL_CHARS, (ch) => FULLWIDTH_MAP[ch] ?? ch);
  // 先把换行换成空格再删控制符：否则换行会被下面的清洗直接吞掉，
  // 「夏季\n连衣裙」会粘成「夏季连衣裙」，标题里的分行信息就丢了
  out = out.replace(/\r\n?|\n/g, ' ');
  out = stripInvisible(out);
  out = removeEmptyBrackets(out);
  out = out.replace(SEPARATOR_RUN, (run) => run[0] ?? '');
  out = stripTrailingDotsAndSpaces(out);

  if (opts.maxLength !== undefined) {
    out = truncateGraphemes(out, opts.maxLength);
    out = stripTrailingDotsAndSpaces(out);
  }

  if (out.length === 0) return FALLBACK_NAME;
  return avoidReservedName(out);
}

/**
 * 校验一段名字能不能直接落盘：清洗后是否保持不变。
 * 设置页改子文件夹名时用它提示「这个名字会被改成 …」。
 */
export function needsSanitizing(raw: string, maxLength: number): boolean {
  return sanitizeName(raw, { maxLength }) !== raw;
}
