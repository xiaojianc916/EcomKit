import type { ErrorCode } from '../errors/codes';

/**
 * 写入层接口（方案 §9.10、§9.13）。
 *
 * **契约调整说明**：原方案用 `FileSystemDirectoryHandle` 作为目录参数，Download 兜底模式
 * （§9.13，没有 FSA 授权时用 chrome.downloads 落盘）拿不到任何句柄，同一个接口签名
 * 无法两种实现共用。因此改为**相对路径字符串数组**（`RelPath`，从用户选的根目录开始）。
 * 好处：FSA 实现内部把路径解析成句柄，downloads 实现直接把路径拼成下载文件名；
 * 引擎层和功能层完全不需要知道当前是哪种模式。
 */

export type DirStatus = 'unset' | 'needs-grant' | 'gone' | 'ready';

export interface DirState {
  status: DirStatus;
  /** 根目录的显示名（只有名字，浏览器拿不到绝对路径，§9.4） */
  name?: string;
}

export interface WriteResult {
  size: number;
  name: string;
}

/**
 * 相对根目录的路径分段，例如 `['拼多多', '夏季连衣裙_482319937501', '主图']`。
 * 空数组表示根目录本身。
 */
export type RelPath = readonly string[];

export interface DirEntry {
  name: string;
  kind: 'file' | 'directory';
  /** 目录项的最后修改时间；拿不到时省略（§9.3 的 `_ID` 扫描要取最大的一个） */
  lastModified?: number;
}

/** 写入层抽象：FSA（主）和 chrome.downloads（兜底）同一套接口（§9.13） */
export interface FsSink {
  readonly kind: 'fsa' | 'downloads';
  /** 目录授权状态（§9.4 状态机） */
  status(): Promise<DirState>;
  /** 授权小窗完成后由 bg 通知，重新读句柄再判状态 */
  refresh(): Promise<DirState>;
  /** 根目录的显示名，供 UI 显示「电商素材 › …」；没有根目录时返回 null */
  rootName(): Promise<string | null>;
  /** 逐级创建目录；已存在时视作成功（§9.3、§9.10） */
  ensureDir(path: RelPath): Promise<void>;
  /** 已存在同名文件（大小写不敏感）时返回实际要用的名字（§9.2、§9.11） */
  resolveName(dir: RelPath, stem: string, ext: string): Promise<string>;
  writeFile(
    dir: RelPath,
    name: string,
    data: Blob | ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<WriteResult>;
  readText(dir: RelPath, name: string): Promise<string | null>;
  writeText(dir: RelPath, name: string, text: string): Promise<void>;
  listDir(dir: RelPath): Promise<DirEntry[]>;
  removeFile(dir: RelPath, name: string): Promise<void>;
  /** 改名（§9.11：损坏的 .ecbox.json 要改名为 .ecbox.broken-<时间>.json 保留现场） */
  rename(dir: RelPath, from: string, to: string): Promise<void>;
  /** 文件大小（字节）；不存在返回 null。downloads 模式拿不到大小时返回 0 */
  exists(dir: RelPath, name: string): Promise<number | null>;
}

export interface FsGateway {
  /** 当前生效的写入层。切换后会指向新的 sink（§11 设置项 settings.save.mode） */
  readonly sink: FsSink;
  /**
   * 运行时切换写入层。用户在设置里把保存方式从「自选文件夹」改成
   * 「浏览器下载目录」（或反过来）时调用，不需要重建 gateway（§9.13、§11）。
   */
  setSink(sink: FsSink): void;
  status(): Promise<DirState>;
  /** 商品文件夹定位：索引 → `_ID` 后缀扫描 → 新建（§9.3、ADR-6） */
  resolveProductFolder(opts: {
    platform: string;
    productId: string;
    preferredName: string;
  }): Promise<{ dir: RelPath; folderName: string; platformDir: RelPath }>;
  ensurePlatformDir(platform: string): Promise<RelPath>;
  ensureSubdir(parent: RelPath, name: string): Promise<RelPath>;
  writeFile(
    dir: RelPath,
    name: string,
    data: Blob | ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<WriteResult>;
  readJson<T>(dir: RelPath, name: string): Promise<T | null>;
  writeJson(dir: RelPath, name: string, value: unknown): Promise<void>;
  readText(dir: RelPath, name: string): Promise<string | null>;
  writeText(dir: RelPath, name: string, text: string): Promise<void>;
  rename(dir: RelPath, from: string, to: string): Promise<void>;
  exists(dir: RelPath, name: string): Promise<number | null>;
}

export function dirError(code: ErrorCode): never {
  throw Object.assign(new Error(code), { code });
}
