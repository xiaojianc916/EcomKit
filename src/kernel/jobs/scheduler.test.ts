import { describe, expect, it } from 'vitest';
import { createJobRecord } from './progress';
import { createScheduler } from './scheduler';

function rec(id: string, dedupeKey: string) {
  return createJobRecord({ id, type: 't', dedupeKey, payload: null });
}

describe('createScheduler（§6.4 去重与轮转）', () => {
  it('同一 dedupeKey 只接受一个活跃任务', () => {
    const s = createScheduler();
    expect(s.submit(rec('a', 'k')).kind).toBe('accepted');
    const dup = s.submit(rec('b', 'k'));
    expect(dup.kind).toBe('duplicate');
    if (dup.kind === 'duplicate') expect(dup.existing.id).toBe('a');
    expect(s.active().map((j) => j.id)).toEqual(['a']);
  });

  it('finish 之后 dedupeKey 立刻可复用（取消后马上再点下载）', () => {
    const s = createScheduler();
    s.submit(rec('a', 'k'));
    s.finish('a');
    expect(s.findByDedupeKey('k')).toBeUndefined();
    expect(s.submit(rec('b', 'k')).kind).toBe('accepted');
  });

  it('状态被改成终态但没调 finish 时，再次提交不会卡在旧记录上', () => {
    const s = createScheduler();
    const a = rec('a', 'k');
    s.submit(a);
    // 模拟「有人绕过 finish 直接改了状态」
    (a as { status: string }).status = 'done';
    const again = s.submit(rec('b', 'k'));
    expect(again.kind).toBe('accepted');
    expect(s.findByDedupeKey('k')?.id).toBe('b');
  });

  it('nextRotation 每调一次轮转一格，且不重复/不遗漏', () => {
    const s = createScheduler();
    s.submit(rec('a', 'k1'));
    s.submit(rec('b', 'k2'));
    s.submit(rec('c', 'k3'));
    const first = s.nextRotation().map((j) => j.id);
    const second = s.nextRotation().map((j) => j.id);
    expect(first).toHaveLength(3);
    expect(new Set(first).size).toBe(3);
    expect(second).toHaveLength(3);
    expect(second).not.toEqual(first);
    expect(second[0]).toBe(first[1]);
  });

  it('pending 只返回 queued，active 返回 queued + running', () => {
    const s = createScheduler();
    const a = rec('a', 'k1');
    const b = rec('b', 'k2');
    s.submit(a);
    s.submit(b);
    (a as { status: string }).status = 'running';
    expect(s.pending().map((j) => j.id)).toEqual(['b']);
    expect(
      s
        .active()
        .map((j) => j.id)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('clear 之后表是空的', () => {
    const s = createScheduler();
    s.submit(rec('a', 'k'));
    s.clear();
    expect(s.active()).toEqual([]);
    expect(s.findByDedupeKey('k')).toBeUndefined();
    expect(s.nextRotation()).toEqual([]);
  });
});
