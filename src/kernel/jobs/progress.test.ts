import { describe, expect, it } from 'vitest';
import {
  applyItemResult,
  createEmptyRecord,
  finalStatus,
  finishRecord,
  percentOf,
  processedCount,
} from './progress';
import type { JobRecord, WorkItem } from './types';

function item(itemKey: string, group: string): WorkItem {
  return {
    itemKey,
    group,
    dir: [],
    stem: itemKey,
    expect: 'image',
    candidates: ['https://x/1.jpg'],
    kind: 'image',
  };
}

const ITEMS = [item('a', 'main'), item('b', 'main'), item('c', 'detail')];

function emptyRecord(): JobRecord {
  return createEmptyRecord({
    id: 'j1',
    type: 'media-download',
    dedupeKey: 'pinduoduo:1',
    payload: {},
    items: ITEMS,
  });
}

describe('createEmptyRecord', () => {
  it('按 group 统计 total', () => {
    const r = emptyRecord();
    expect(r.total).toBe(3);
    expect(r.byGroup.main?.total).toBe(2);
    expect(r.byGroup.detail?.total).toBe(1);
    expect(r.status).toBe('queued');
    expect(r.failed).toEqual([]);
  });

  it('tabId / label 可选，undefined 时不出现在对象里', () => {
    const r = emptyRecord();
    expect('tabId' in r).toBe(false);
    expect('label' in r).toBe(false);
  });
});

describe('applyItemResult', () => {
  it('成功累加 done 和 bytes，不改入参', () => {
    const r = emptyRecord();
    const next = applyItemResult(r, ITEMS[0]!, { itemKey: 'a', status: 'ok', bytes: 100 });
    expect(next.done).toBe(1);
    expect(next.bytes).toBe(100);
    expect(next.byGroup.main?.done).toBe(1);
    expect(r.done).toBe(0);
    expect(r.bytes).toBe(0);
  });

  it('跳过只加 skipped，不算 done', () => {
    const next = applyItemResult(emptyRecord(), ITEMS[1]!, { itemKey: 'b', status: 'skipped' });
    expect(next.done).toBe(0);
    expect(next.skipped).toBe(1);
    expect(next.byGroup.main?.skipped).toBe(1);
  });

  it('失败记录 code，不算 done', () => {
    const next = applyItemResult(emptyRecord(), ITEMS[2]!, {
      itemKey: 'c',
      status: 'failed',
      code: 'HTTP_404',
    });
    expect(next.failed).toEqual([{ itemKey: 'c', code: 'HTTP_404' }]);
    expect(next.byGroup.detail?.failed).toBe(1);
    expect(next.done).toBe(0);
  });

  it('多个结果按顺序累加', () => {
    let r = emptyRecord();
    r = applyItemResult(r, ITEMS[0]!, { itemKey: 'a', status: 'ok', bytes: 10 });
    r = applyItemResult(r, ITEMS[1]!, { itemKey: 'b', status: 'ok', bytes: 20 });
    r = applyItemResult(r, ITEMS[2]!, { itemKey: 'c', status: 'failed', code: 'TIMEOUT' });
    expect(r.done).toBe(2);
    expect(r.bytes).toBe(30);
    expect(r.failed).toHaveLength(1);
    expect(r.byGroup.main).toEqual({ total: 2, done: 2, failed: 0, skipped: 0 });
  });
});

describe('finalStatus / finishRecord', () => {
  it('全成功 → done', () => {
    let r = emptyRecord();
    for (const it of ITEMS)
      r = applyItemResult(r, it, { itemKey: it.itemKey, status: 'ok', bytes: 1 });
    expect(finalStatus(r)).toBe('done');
    expect(finishRecord(r).status).toBe('done');
    expect(finishRecord(r).endedAt).toBeTypeOf('number');
  });

  it('有失败 → partial', () => {
    let r = emptyRecord();
    r = applyItemResult(r, ITEMS[0]!, { itemKey: 'a', status: 'ok', bytes: 1 });
    r = applyItemResult(r, ITEMS[1]!, { itemKey: 'b', status: 'failed', code: 'NETWORK' });
    expect(finalStatus(r)).toBe('partial');
  });

  it('一个都没成功 → failed', () => {
    let r = emptyRecord();
    for (const it of ITEMS)
      r = applyItemResult(r, it, { itemKey: it.itemKey, status: 'failed', code: 'NETWORK' });
    expect(finalStatus(r)).toBe('failed');
  });

  it('全部跳过也算完成（没有失败时不是 failed）', () => {
    let r = emptyRecord();
    for (const it of ITEMS) r = applyItemResult(r, it, { itemKey: it.itemKey, status: 'skipped' });
    expect(finalStatus(r)).toBe('done');
  });

  it('取消时状态是 canceled，不管有没有失败', () => {
    let r = emptyRecord();
    r = applyItemResult(r, ITEMS[0]!, { itemKey: 'a', status: 'ok', bytes: 1 });
    expect(finishRecord(r, true).status).toBe('canceled');
  });
});

describe('percentOf / processedCount', () => {
  it('百分数按 完成+跳过+失败 计算', () => {
    let r = emptyRecord();
    r = applyItemResult(r, ITEMS[0]!, { itemKey: 'a', status: 'ok', bytes: 1 });
    expect(processedCount(r)).toBe(1);
    expect(percentOf(r)).toBe(33);
  });

  it('total 为 0 时是 0，不是 NaN', () => {
    const r = createEmptyRecord({
      id: 'j',
      type: 't',
      dedupeKey: 'k',
      payload: {},
      items: [],
    });
    expect(percentOf(r)).toBe(0);
  });
});
