import type { ErrorCode } from './codes';
import { isRetryable } from './codes';

/** 扩展里所有错误的唯一表示。任何地方都不直接把异常 message 显示给用户 */
export class EcError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly detail: unknown;

  constructor(code: ErrorCode, detail?: unknown) {
    super(code);
    this.name = 'EcError';
    this.code = code;
    this.retryable = isRetryable(code);
    this.detail = detail;
  }

  static is(e: unknown): e is EcError {
    return e instanceof EcError;
  }

  static from(e: unknown, fallback: ErrorCode = 'INTERNAL'): EcError {
    if (e instanceof EcError) return e;
    if (e instanceof DOMException) return new EcError(mapDomErrorCode(e.name), { name: e.name });
    return new EcError(fallback, e instanceof Error ? e.message : String(e));
  }

  toJSON(): { code: ErrorCode; retryable: boolean; detail?: unknown } {
    return this.detail === undefined
      ? { code: this.code, retryable: this.retryable }
      : { code: this.code, retryable: this.retryable, detail: this.detail };
  }
}

function mapDomErrorCode(name: string): ErrorCode {
  switch (name) {
    case 'NotFoundError':
      return 'DIR_GONE';
    case 'NotAllowedError':
    case 'SecurityError':
      return 'DIR_NEEDS_GRANT';
    case 'QuotaExceededError':
      return 'DISK_FULL';
    case 'AbortError':
      return 'CANCELED';
    default:
      return 'WRITE_FAILED';
  }
}

/** 消息通道上传输的序列化形式（structured clone 后 instanceof 会失效） */
export type EcErrorPayload = ReturnType<EcError['toJSON']>;
