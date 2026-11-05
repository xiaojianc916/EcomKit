import type { ErrorCode } from '../errors/codes';
import { EcError } from '../errors/ec-error';

/**
 * 文件系统异常 → 错误码（方案 §9.10 mapFsError）。
 *
 * 为什么必须映射：FSA 抛的是 DOMException，message 是英文且经常是空的；
 * UI 只能按错误码查表显示中文，任何地方都不许直接把 message 显示给用户（CONTRIBUTING）。
 */

/** 磁盘空间不足的几种说法（DOMException 的 name 在不同 Chrome 版本上不一致） */
const DISK_FULL_HINTS = ['quota', 'disk', 'space', '空间', '磁盘'];

export function mapFsError(e: unknown): EcError {
  if (e instanceof EcError) return e;

  if (e instanceof DOMException) {
    switch (e.name) {
      case 'NotFoundError':
        return new EcError('DIR_GONE', { name: e.name });
      case 'NotAllowedError':
      case 'SecurityError':
        return new EcError('DIR_NEEDS_GRANT', { name: e.name });
      case 'QuotaExceededError':
        return new EcError('DISK_FULL', { name: e.name });
      case 'AbortError':
        return new EcError('CANCELED', { name: e.name });
      default:
        break;
    }
    const lowered = `${e.name} ${e.message}`.toLowerCase();
    if (DISK_FULL_HINTS.some((hint) => lowered.includes(hint.toLowerCase()))) {
      return new EcError('DISK_FULL', { name: e.name });
    }
    return new EcError('WRITE_FAILED', { name: e.name });
  }

  if (e instanceof Error) {
    const lowered = `${e.name} ${e.message}`.toLowerCase();
    if (DISK_FULL_HINTS.some((hint) => lowered.includes(hint.toLowerCase()))) {
      return new EcError('DISK_FULL');
    }
    if (e.name === 'AbortError') return new EcError('CANCELED');
    return new EcError('WRITE_FAILED', e.name);
  }

  return new EcError('WRITE_FAILED');
}

/** 判断一个错误码是不是「文件已存在/重名」相关的可继续情况 */
export function isRecoverableFsCode(code: ErrorCode): boolean {
  return code === 'WRITE_FAILED' || code === 'DISK_FULL';
}
