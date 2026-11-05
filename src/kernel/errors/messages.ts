import type { ErrorCode } from './codes';

export interface ErrorPreset {
  /** 用户能看懂的一句话（§10.7：错误要说原因和下一步） */
  title: string;
  /** 第二行补充说明，可省略 */
  hint?: string;
  /** 附带的动作 id，由 UI 决定渲染成什么按钮 */
  action?:
    | 'refresh'
    | 'mobile-mode'
    | 'grant'
    | 'reset-grant'
    | 'retry'
    | 'diagnostics'
    | 'settings';
}

/** 错误码 → 文案查表。UI 永远从这里取文案，不读异常 message */
export const ERROR_MESSAGES: Record<ErrorCode, ErrorPreset> = {
  LOGIN_REQUIRED: {
    title: '需要先登录拼多多',
    hint: '登录后刷新页面，就能识别商品',
    action: 'refresh',
  },
  APP_ONLY: {
    title: '抖音限制了电脑端查看',
    hint: '这个页面只显示扫码提示，没有加载商品数据',
    action: 'mobile-mode',
  },
  PRODUCT_GONE: { title: '商品已下架' },
  PARSE_EMPTY: {
    title: '没有在这个页面找到素材',
    hint: '页面可能还没加载完，或者平台改版了',
    action: 'diagnostics',
  },
  DIR_UNSET: { title: '选择保存位置', action: 'grant' },
  DIR_NEEDS_GRANT: { title: '继续使用「电商素材」', action: 'grant' },
  DIR_GONE: {
    title: '找不到「电商素材」文件夹',
    hint: '它可能被移动、重命名或删除了',
    action: 'reset-grant',
  },
  HTTP_403: { title: '平台拒绝访问', action: 'retry' },
  HTTP_404: { title: '图片已失效' },
  HTTP_429: { title: '请求太频繁', action: 'retry' },
  HTTP_5XX: { title: '服务器出错', action: 'retry' },
  TIMEOUT: { title: '网络超时', action: 'retry' },
  NETWORK: { title: '网络不稳定', action: 'retry' },
  URL_EXPIRED: { title: '视频链接已过期', hint: '刷新页面后重新识别', action: 'refresh' },
  UNSUPPORTED_STREAM: { title: '这个视频格式暂不支持' },
  DISK_FULL: { title: '磁盘空间不足' },
  WRITE_FAILED: { title: '保存失败', action: 'retry' },
  CANCELED: { title: '已取消' },
  INTERNAL: { title: '出了点问题', action: 'diagnostics' },
};

export function errorMessage(code: ErrorCode): ErrorPreset {
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INTERNAL;
}
