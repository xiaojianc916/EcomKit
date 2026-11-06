export interface SniffResult {
  ext: string;
  mime: string;
  /** 'mp4' | 'hls' | ... 视频容器 */
  container?: string;
  isVideo: boolean;
  isImage: boolean;
}

export interface FetchOpts {
  signal: AbortSignal;
  /** 图片 20s 总超时；视频用空闲超时（§9.7） */
  kind: 'image' | 'video';
  host?: string;
  referer?: string;
}

export interface Fetcher {
  /** 依次尝试候选地址：404/410/403/429/5xx 或内容不符就换下一个；全部失败抛最后一个 EcError */
  fetchWithFallback(candidates: string[], opts: FetchOpts): Promise<Response>;
  /** 流式拿到视频，大小不限 */
  fetchStream(url: string, opts: FetchOpts): Promise<Response>;
}
