import { describe, expect, it } from 'vitest';
import type { JobRecord } from '../jobs/types';
import {
  buildDiagnostics,
  type DiagnosticsInput,
  diagnosticsFileName,
  dumpDiagnostics,
  isSensitiveKey,
  MAX_ARRAY_ITEMS,
  MAX_JOBS,
  MAX_LOGS,
  scrubUrl,
  toSkeleton,
} from './diagnostics';

function job(id: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    type: 'media-download',
    dedupeKey: 'pinduoduo:' + id,
    payload: { secret: 'x' },
    status: 'done',
    total: 10,
    done: 10,
    skipped: 0,
    bytes: 1024,
    failed: [],
    byGroup: {},
    createdAt: 1000,
    ...overrides,
  };
}

const BASE: DiagnosticsInput = {
  version: '0.0.1',
  userAgent: 'Mozilla/5.0 Chrome/131',
};

describe('toSkeleton（§6.7 值截断成类型名）', () => {
  it('字符串只留长度，不留内容', () => {
    expect(toSkeleton('夏季连衣裙')).toBe('string(5)');
  });

  it('基本类型给出类型名', () => {
    expect(toSkeleton(42)).toBe('number');
    expect(toSkeleton(true)).toBe('boolean');
    expect(toSkeleton(null)).toBe('null');
    expect(toSkeleton(undefined)).toBe('undefined');
  });

  it('数组只保留前几项作为形状样本', () => {
    expect(toSkeleton([1, 2, 3, 4, 5])).toEqual(['number', 'number', 'number']);
    expect((toSkeleton([1, 2, 3, 4, 5]) as unknown[]).length).toBe(MAX_ARRAY_ITEMS);
  });

  it('对象递归展开成结构骨架', () => {
    expect(
      toSkeleton({ goods: { title: '夏季连衣裙', images: [{ url: 'https://x/1.jpg' }] } }),
    ).toEqual({
      goods: { title: 'string(5)', images: [{ url: 'string(15)' }] },
    });
  });

  it('嵌套过深时截断（不会无限递归）', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    expect(JSON.stringify(toSkeleton(deep))).toContain('…');
  });

  it('敏感字段连内容都不出现', () => {
    expect(toSkeleton({ cookie: 'a=1', Cookie: 'b=2', authorization: 'Bearer x' })).toEqual({
      cookie: '⟨redacted⟩',
      Cookie: '⟨redacted⟩',
      authorization: '⟨redacted⟩',
    });
  });

  it('循环引用不会崩（靠深度上限兜住）', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => toSkeleton(cyclic)).not.toThrow();
  });
});

describe('isSensitiveKey', () => {
  it('识别常见敏感字段名', () => {
    for (const key of [
      'cookie',
      'Authorization',
      'access_token',
      'session-id',
      'password',
      'phone',
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it('普通字段不误杀', () => {
    for (const key of ['title', 'images', 'goods_id', 'price']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});

describe('scrubUrl（§6.7 去掉查询参数里的隐私内容）', () => {
  it('只保留商品 ID 参数', () => {
    expect(
      scrubUrl('https://mobile.yangkeduo.com/goods.html?goods_id=482319937501&tracking=abc&ref=x'),
    ).toBe('https://mobile.yangkeduo.com/goods.html?goods_id=482319937501');
  });

  it('抖音的 id 参数也保留', () => {
    expect(
      scrubUrl('https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=123&sig=xyz'),
    ).toBe('https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=123');
  });

  it('没有商品 ID 时只剩 origin + path', () => {
    expect(scrubUrl('https://example.com/a/b?token=secret')).toBe('https://example.com/a/b');
  });

  it('非法 URL 也把查询串去掉', () => {
    expect(scrubUrl('not-a-url?token=secret')).toBe('not-a-url');
  });
});

describe('buildDiagnostics（§6.7 诊断包）', () => {
  it('基本字段齐全且是纯 JSON', () => {
    const pkg = buildDiagnostics(BASE, 5000);
    expect(pkg.v).toBe(1);
    expect(pkg.generatedAt).toBe(5000);
    expect(pkg.version).toBe('0.0.1');
    expect(pkg.logs).toEqual([]);
    expect(pkg.jobs).toEqual([]);
    expect(pkg.sources).toEqual([]);
  });

  it('可以 JSON.stringify 往返（纯数据）', () => {
    const pkg = buildDiagnostics({ ...BASE, jobs: [job('j1')] }, 1);
    const text = JSON.stringify(pkg);
    expect(JSON.parse(text)).toEqual(pkg);
    // 再序列化一次得到同样的字符串：包里没有 Date / Map / undefined 这类
    // 「往返一次就变形」的值 —— 诊断包必须能被 JSON 无损往返
    expect(JSON.stringify(JSON.parse(text))).toBe(text);
  });

  it('页面 URL 被脱敏', () => {
    const pkg = buildDiagnostics({
      ...BASE,
      page: {
        url: 'https://mobile.yangkeduo.com/goods.html?goods_id=123456&token=secret',
        matched: true,
        pageKind: 'pdd.goods',
      },
    });
    expect(pkg.page?.url).toBe('https://mobile.yangkeduo.com/goods.html?goods_id=123456');
    expect(pkg.page?.pageKind).toBe('pdd.goods');
  });

  it('日志最多保留最后 500 条', () => {
    const logs = Array.from({ length: 600 }, (_, i) => ({
      at: i,
      level: 'info' as const,
      scope: 'test',
      msg: 'm' + i,
    }));
    const pkg = buildDiagnostics({ ...BASE, logs });
    expect(pkg.logs).toHaveLength(MAX_LOGS);
    // 保留的是最后 500 条
    expect(pkg.logs[0]?.msg).toBe('m100');
  });

  it('日志的 data 被截断成骨架', () => {
    const pkg = buildDiagnostics({
      ...BASE,
      logs: [{ at: 1, level: 'info', scope: 'pdd', msg: '解析完成', data: { title: '连衣裙' } }],
    });
    expect(pkg.logs[0]?.data).toEqual({ title: 'string(3)' });
  });

  it('任务记录最多保留 20 个', () => {
    const jobs = Array.from({ length: 30 }, (_, i) => job('j' + i));
    expect(buildDiagnostics({ ...BASE, jobs }).jobs).toHaveLength(MAX_JOBS);
  });

  it('任务记录不含 payload（可能带商品数据）', () => {
    const pkg = buildDiagnostics({ ...BASE, jobs: [job('j1')] });
    expect('payload' in (pkg.jobs[0] ?? {})).toBe(false);
    expect(pkg.jobs[0]?.total).toBe(10);
  });

  it('未开始/未结束的 startedAt、endedAt 不出现', () => {
    const pkg = buildDiagnostics({ ...BASE, jobs: [job('j1')] });
    expect('startedAt' in (pkg.jobs[0] ?? {})).toBe(false);
    expect('endedAt' in (pkg.jobs[0] ?? {})).toBe(false);
  });

  it('数据源统计原样带出', () => {
    const pkg = buildDiagnostics({
      ...BASE,
      sources: [
        { id: 'ssr', count: 8, ms: 120 },
        { id: 'capture', count: 0, ms: 3000, failed: true },
      ],
    });
    expect(pkg.sources).toEqual([
      { id: 'ssr', count: 8, ms: 120 },
      { id: 'capture', count: 0, ms: 3000, failed: true },
    ]);
  });
});

describe('dumpDiagnostics / diagnosticsFileName', () => {
  it('输出格式化 JSON 字符串', () => {
    const text = dumpDiagnostics(BASE, 1);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).toContain('"version": "0.0.1"');
  });

  it('文件名带时间戳', () => {
    const name = diagnosticsFileName(new Date(2026, 10, 5, 9, 7).getTime());
    expect(name).toBe('ecbox-diagnostics-20261105-0907.json');
  });
});
