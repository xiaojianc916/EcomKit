import type { ErrorCode } from '../kernel/errors/codes';
import type { PlatformId, ProductDraft } from '../kernel/model/product';

/**
 * 页面类型：**纯数据**。
 * 判定逻辑由 platforms/registry.ts 通用实现（Chrome match pattern + 查询参数），
 * 这样 manifest.ts 不需要 import 任何东西，既能被代码生成脚本直接加载，
 * 也能原样喂给 wxt.config.ts 生成 matches。
 */
export interface PageKindDef {
  /** 'pdd.goods' | 'dy.haohuo' */
  kind: string;
  /** 写进 manifest.content_scripts.matches 的 match pattern */
  matches: string[];
  /** 商品 ID 所在的查询参数名，值必须是纯数字（§7.5、§7.6） */
  productIdParam: string;
  /** 可选的额外路径约束，正则源码；不填表示 matches 已足够精确 */
  pathPattern?: string;
}

/** 可序列化，交给 MAIN world 使用（§7.4） */
export interface CaptureRule {
  id: string;
  /** 只在这些页面类型生效 */
  pageKinds: string[];
  /** 正则源码，必须精确到接口路径 */
  urlPattern: string;
  /** 默认 3MB，超过不克隆 */
  maxBytes?: number;
}

export interface RefererRule {
  value: string;
  hosts: string[];
}

export interface PlatformManifest {
  id: PlatformId;
  displayName: string;
  brandColor: string;
  /** 抖音 #161823 需要 1px #25F4EE 描边（§10.6） */
  brandRing?: string;
  pageKinds: PageKindDef[];
  /** 写入 host_permissions，也是 DOM 兜底和下载地址的白名单 */
  cdnHosts: string[];
  capture: CaptureRule[];
  /** 允许 bridge 读取的全局变量路径（白名单） */
  globals: string[];
  referer?: RefererRule;
  /** Phase 0 结论：该平台是否需要 DNR 改 UA 才能看到 C 端详情（§7.6.5） */
  supportsMobileMode?: boolean;
}

export interface CapturedPayload {
  ruleId: string;
  url: string;
  /** 已解析的 JSON；解析失败时为 null */
  json: unknown;
  at: number;
}

export interface ResolveContext {
  url: URL;
  productId: string;
  pageKind: string;
  document: Document;
  signal: AbortSignal;
  /** 经 bridge 读取，路径必须在白名单里 */
  readGlobal(path: string): Promise<unknown>;
  /** 包含已缓冲的和之后到达的抓包数据 */
  captures(ruleId: string): AsyncIterable<CapturedPayload>;
  log: { debug(msg: string, data?: unknown): void; info(msg: string, data?: unknown): void };
}

export interface DataSource {
  id: 'ssr' | 'capture' | 'dom';
  /** 渐进产出 */
  run(ctx: ResolveContext): AsyncIterable<ProductDraft>;
}

export interface PlatformResolver {
  /** 登录墙、App 限制、已下架（§7.2 状态机） */
  detectBlocker(doc: Document, url: URL): ErrorCode | null;
  /** 按优先级排列：ssr → capture → dom */
  sources: DataSource[];
}
