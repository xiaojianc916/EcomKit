/** 全部错误码（§6.2）。UI 文案按错误码查表，绝不直接显示异常 message */
export const ERROR_CODES = [
  'LOGIN_REQUIRED',
  'APP_ONLY',
  'PRODUCT_GONE',
  'PARSE_EMPTY',
  'DIR_UNSET',
  'DIR_NEEDS_GRANT',
  'DIR_GONE',
  'HTTP_403',
  'HTTP_404',
  'HTTP_429',
  'HTTP_5XX',
  'TIMEOUT',
  'NETWORK',
  'URL_EXPIRED',
  'UNSUPPORTED_STREAM',
  'DISK_FULL',
  'WRITE_FAILED',
  'CANCELED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'HTTP_403',
  'HTTP_429',
  'HTTP_5XX',
  'TIMEOUT',
  'NETWORK',
  'WRITE_FAILED',
]);

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

/** 需要用户处置（重新授权 / 刷新 / 换目录）的错误码，UI 要给一个可执行的动作 */
export const DIR_ERROR_CODES: readonly ErrorCode[] = ['DIR_UNSET', 'DIR_NEEDS_GRANT', 'DIR_GONE'];
