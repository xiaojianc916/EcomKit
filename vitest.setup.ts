import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

/** 内容脚本和 offscreen 里用到的浏览器 API，在 happy-dom 下补齐最小实现 */
if (!globalThis.chrome) {
  (globalThis as any).chrome = {
    runtime: { id: 'test-extension-id', getURL: (p: string) => `chrome-extension://test/${p}` },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
    },
  };
}

if (!globalThis.createImageBitmap) {
  (globalThis as any).createImageBitmap = vi.fn(async () => ({ width: 1, height: 1, close() {} }));
}
