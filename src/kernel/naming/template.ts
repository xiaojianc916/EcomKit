import { EcError } from '../errors/ec-error';
import { TEMPLATE_VARS, type TemplateVar, templateHasId } from '../settings/schema';
import { NAME_LIMITS, sanitizeName, truncateGraphemes } from './sanitize';

/**
 * 商品文件夹命名模板（方案 §9.1）。
 *
 * 可用变量：{platform} {shop:N} {title:N} {id} {date}，N 表示按字素截断到 N 个字符。
 * 模板里必须包含 {id} —— ADR-6 按 ID 定位文件夹的前提，所以 validateTemplate() 要能报出来
 * （设置页据此禁用保存按钮）；渲染时如果确实拿不到 id 就直接抛错，
 * 绝不生成一个以后再也定位不到的文件夹。
 */

/** 匹配 {var} 或 {var:N} */
const TOKEN_RE = /\{([A-Za-z_][A-Za-z0-9_]*)(?::(\d+))?\}/g;

export interface TemplateVars {
  platform?: string;
  shop?: string;
  title?: string;
  id?: string;
  /** {date} 用的时间，默认取当前时间 */
  date?: Date | number;
}

export interface TemplateProblem {
  kind: 'missing-id' | 'unknown-var' | 'bad-length';
  /** 出问题的变量名或原始片段，给设置页做行内提示 */
  detail?: string;
}

/** 模板里出现过的变量名（去重、按出现顺序） */
export function collectTemplateVars(template: string): string[] {
  const out: string[] = [];
  for (const match of template.matchAll(TOKEN_RE)) {
    const name = match[1];
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 校验模板，空数组表示可用。
 * 未知变量不阻止渲染（原样保留），但必须让设置页报错，
 * 否则用户会静默得到一个带 {foo} 的文件夹名。
 */
export function validateTemplate(template: string): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  const known = new Set<string>(TEMPLATE_VARS);
  for (const name of collectTemplateVars(template)) {
    if (!known.has(name)) problems.push({ kind: 'unknown-var', detail: name });
  }
  if (!templateHasId(template)) problems.push({ kind: 'missing-id', detail: '{id}' });
  for (const match of template.matchAll(TOKEN_RE)) {
    const raw = match[2];
    if (raw !== undefined && Number(raw) <= 0) {
      problems.push({ kind: 'bad-length', detail: match[0] });
    }
  }
  return problems;
}

/** {date} 用紧凑的 YYYYMMDD 本地时间，避免文件名里再多两种分隔符 */
export function formatTemplateDate(value: Date | number): string {
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function readVar(name: string, vars: TemplateVars, dateValue: number): string | undefined {
  switch (name as TemplateVar) {
    case 'platform':
      return vars.platform;
    case 'shop':
      return vars.shop;
    case 'title':
      return vars.title;
    case 'id':
      return vars.id;
    case 'date':
      return formatTemplateDate(vars.date ?? dateValue);
    default:
      return undefined;
  }
}

export interface RenderOptions {
  /** 没有传 vars.date 时用它算 {date}，方便测试固定时间 */
  now?: number;
}

/**
 * 渲染模板。
 * — 引用了 {id} 但没给 id：直接抛 EcError（调用方本就该保证 id 存在）；
 * — 未知变量：原样保留，配合 validateTemplate() 在设置页报错。
 */
export function renderTemplate(
  template: string,
  vars: TemplateVars,
  opts: RenderOptions = {},
): string {
  const dateValue = vars.date === undefined ? (opts.now ?? Date.now()) : Number(vars.date);
  return template.replace(TOKEN_RE, (whole, name: string, len?: string) => {
    if (!(TEMPLATE_VARS as readonly string[]).includes(name)) return whole;
    const value = readVar(name, vars, dateValue);
    if (value === undefined) {
      if (name === 'id') throw new EcError('INTERNAL', { reason: 'template-missing-id' });
      // 缺数据的可选变量整体变空，不留一个孤零零的分隔符（后面会合并连续分隔符）
      return '';
    }
    if (len === undefined) return value;
    const max = Number(len);
    return max > 0 ? truncateGraphemes(value, max) : value;
  });
}

/**
 * 渲染商品文件夹名：渲染 + 按 §9.2 清洗截断（folder ≤ 50 字素）。
 * 模板缺少 {id} 直接抛错，和设置页的校验规则保持一致。
 */
export function renderProductFolderName(
  template: string,
  vars: TemplateVars,
  opts: RenderOptions & { maxLength?: number } = {},
): string {
  if (!templateHasId(template)) {
    throw new EcError('INTERNAL', { reason: 'template-missing-id' });
  }
  const rendered = renderTemplate(template, vars, opts);
  return sanitizeName(rendered, { maxLength: opts.maxLength ?? NAME_LIMITS.folder });
}
