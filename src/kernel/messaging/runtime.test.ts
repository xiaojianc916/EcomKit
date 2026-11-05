import { describe, expect, it } from 'vitest';
import { classifySender, guardSender, validateJobList, validatePayload } from './runtime';

function sender(
  overrides: Partial<chrome.runtime.MessageSender> = {},
): chrome.runtime.MessageSender {
  return { id: 'ext-id', ...overrides } as chrome.runtime.MessageSender;
}

const fromContent = () =>
  sender({ tab: { id: 7 } as chrome.tabs.Tab, url: 'https://mobile.yangkeduo.com/goods.html' });
const fromOffscreen = () => sender({ url: 'chrome-extension://abc/offscreen.html' });
const fromPopup = () => sender({ url: 'chrome-extension://abc/popup.html' });

describe('classifySender（§6.3 约定 1）', () => {
  it('内容脚本：有 tab.id', () => {
    expect(classifySender(fromContent())).toBe('content');
  });

  it('offscreen 文档：url 以 offscreen.html 结尾', () => {
    expect(classifySender(fromOffscreen())).toBe('offscreen');
  });

  it('扩展页面：chrome-extension:// 但不是 offscreen', () => {
    expect(classifySender(fromPopup())).toBe('extension-page');
  });

  it('SW 自己：没有 tab 也没有 url', () => {
    expect(classifySender(sender())).toBe('background');
  });
});

describe('guardSender（§6.3 约定 1）', () => {
  it('内容脚本可以调 shell.* / fs.status / fs.openGrant / job.* / feature.call', () => {
    for (const method of [
      'shell.getTabState',
      'shell.togglePanel',
      'fs.status',
      'fs.openGrant',
      'job.submit',
      'job.cancel',
      'job.retry',
      'job.list',
      'feature.call',
    ]) {
      expect(guardSender(method, fromContent()).ok, method).toBe(true);
    }
  });

  it('内容脚本不能调 engine.*', () => {
    for (const method of ['engine.enqueue', 'engine.cancel', 'engine.ready', 'engine.event']) {
      expect(guardSender(method, fromContent()).ok, method).toBe(false);
    }
  });

  it('内容脚本不能调 grant.*（那是授权小窗的事）', () => {
    expect(guardSender('grant.persist', fromContent()).ok).toBe(false);
    expect(guardSender('grant.getHandle', fromContent()).ok).toBe(false);
  });

  it('engine.* 只接受 offscreen', () => {
    expect(guardSender('engine.enqueue', fromOffscreen()).ok).toBe(true);
    expect(guardSender('engine.ready', fromOffscreen()).ok).toBe(true);
    expect(guardSender('engine.enqueue', fromPopup()).ok).toBe(false);
    expect(guardSender('engine.enqueue', sender()).ok).toBe(false);
  });

  it('扩展页面可以调授权小窗的方法', () => {
    for (const method of ['grant.getInit', 'grant.persist', 'grant.getHandle', 'grant.close']) {
      expect(guardSender(method, fromPopup()).ok, method).toBe(true);
    }
  });

  it('扩展页面调 engine.* 也被拒绝', () => {
    expect(guardSender('engine.call', fromPopup()).ok).toBe(false);
  });

  it('拒绝时给出原因', () => {
    const result = guardSender('engine.enqueue', fromContent());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('offscreen');
  });
});

describe('validatePayload（§6.3 入口 Zod 校验）', () => {
  it('合法 payload 原样通过', () => {
    expect(validatePayload('shell.getTabState', { tabId: 7 })).toEqual({ tabId: 7 });
  });

  it('缺字段时抛 EcError，不把 Zod 报错抛出去', () => {
    expect(() => validatePayload('shell.getTabState', {})).toThrow(
      expect.objectContaining({ code: 'INTERNAL' }),
    );
  });

  it('类型不对时拒绝', () => {
    expect(() => validatePayload('shell.getTabState', { tabId: '7' })).toThrow();
  });

  it('job.submit 校验必填字段', () => {
    const valid = {
      type: 'media-download',
      payload: { snapshot: {} },
      dedupeKey: 'pinduoduo:1',
    };
    expect(validatePayload('job.submit', valid)).toEqual(valid);
    expect(() => validatePayload('job.submit', { ...valid, dedupeKey: '' })).toThrow();
    expect(() => validatePayload('job.submit', { ...valid, type: 1 })).toThrow();
  });

  it('fs.changed 校验 DirState 结构', () => {
    expect(validatePayload('fs.changed', { status: 'ready', name: '电商素材' })).toEqual({
      status: 'ready',
      name: '电商素材',
    });
    expect(() => validatePayload('fs.changed', { status: 'wat' })).toThrow();
  });

  it('fs.openGrant 只接受四种 reason', () => {
    for (const reason of ['unset', 'needs-grant', 'gone', 'change']) {
      expect(() => validatePayload('fs.openGrant', { reason })).not.toThrow();
    }
    expect(() => validatePayload('fs.openGrant', { reason: 'other' })).toThrow();
  });

  it('job.retry 只接受 only=failed', () => {
    expect(() => validatePayload('job.retry', { jobId: 'j1', only: 'failed' })).not.toThrow();
    expect(() => validatePayload('job.retry', { jobId: 'j1', only: 'all' })).toThrow();
  });

  it('没有校验器的方法直接放行', () => {
    expect(validatePayload('shell.diagnostics', undefined)).toBeUndefined();
  });
});

describe('validateJobList', () => {
  it('没有参数时返回空对象', () => {
    expect(validateJobList(undefined)).toEqual({});
    expect(validateJobList(null)).toEqual({});
  });

  it('带 tabId 时原样返回', () => {
    expect(validateJobList({ tabId: 3 })).toEqual({ tabId: 3 });
  });

  it('非法 tabId 时返回空对象（不崩）', () => {
    expect(validateJobList({ tabId: 'x' })).toEqual({});
  });
});
