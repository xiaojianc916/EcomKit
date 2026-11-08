import { describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '../../../kernel/jobs/types';
import type { Asset, AssetKind } from '../../../kernel/model/asset';
import { type AssetRowProps, areAssetRowModelsEqual, areAssetRowPropsEqual } from './AssetRow';
import { type AssetRowModel, assetRowModel } from './asset-row-model';

/**
 * 素材行的 memo 比较器（§10.9「进度每 200ms 更新时只有对应的行和主按钮重渲染」）。
 *
 * 行内进度条移除后，下载中的 200ms 推送不应该让任何素材行重渲染 ——
 * 比较器只要退化成「比 job 引用」，每 200ms 四次全量重渲染就回来了。
 * 所以把「什么该重渲染 / 什么不该」逐条锁在单测里。
 */

function asset(key: string, kind: AssetKind = 'detail', index = 0): Asset {
  return { key, kind, index, candidates: [`https://img.pddpic.com/${key}.jpg`] };
}

const assets: Asset[] = [asset('a'), asset('b')];
const model: AssetRowModel = assetRowModel({
  kind: 'detail',
  total: 2,
  selectedCount: 0,
  resolving: false,
  job: null,
});

// 回调必须是**稳定引用**（真实调用点都用 useCallback）：每次渲染新建一个箭头函数
// 会让 memo 永远失配，测试里用常量来模拟稳定回调
const noop = (): void => {};
const handlers = {
  onToggleCheck: noop,
  onDownloadKind: noop,
  onRetryKind: noop,
  onToggleExpand: noop,
};

function props(patch: Partial<AssetRowProps> = {}): AssetRowProps {
  return {
    kind: 'detail',
    assets,
    model,
    checked: true,
    indeterminate: false,
    expanded: false,
    ...handlers,
    ...patch,
  };
}

function runningJob(done: number): JobRecord {
  return {
    id: 'j1',
    type: 'media-download',
    dedupeKey: 'pdd:1',
    payload: {},
    status: 'running',
    total: 26,
    done,
    skipped: 0,
    bytes: 0,
    failed: [],
    byGroup: { detail: { total: 26, done, failed: 0, skipped: 0 } },
    createdAt: 0,
  };
}

describe('areAssetRowModelsEqual', () => {
  it('同一个引用直接相等', () => {
    expect(areAssetRowModelsEqual(model, model)).toBe(true);
  });

  it('下载中进度前进不改变行模型，不触发重渲染', () => {
    const modelAt = (done: number): AssetRowModel =>
      assetRowModel({
        kind: 'detail',
        total: 26,
        selectedCount: 0,
        resolving: false,
        job: runningJob(done),
      });
    expect(areAssetRowModelsEqual(modelAt(3), modelAt(4))).toBe(true);
  });

  it('状态种类变了算不等', () => {
    expect(
      areAssetRowModelsEqual(model, {
        status: { kind: 'done', count: 2 },
        countText: '✓ 2',
        showDownload: true,
        showRetry: false,
      }),
    ).toBe(false);
  });

  it('部分失败里失败数变了算不等', () => {
    const partial = (failed: number): AssetRowModel => ({
      status: { kind: 'partial', done: 8, total: 10, failed },
      countText: `8/10 · ${failed} 个失败`,
      showDownload: false,
      showRetry: true,
    });
    expect(areAssetRowModelsEqual(partial(2), partial(2))).toBe(true);
    expect(areAssetRowModelsEqual(partial(2), partial(3))).toBe(false);
  });

  it('完成态的计数变了算不等', () => {
    const done = (count: number): AssetRowModel => ({
      status: { kind: 'done', count },
      countText: `✓ ${count}`,
      showDownload: true,
      showRetry: false,
    });
    expect(areAssetRowModelsEqual(done(26), done(26))).toBe(true);
    expect(areAssetRowModelsEqual(done(26), done(27))).toBe(false);
  });
});

describe('areAssetRowPropsEqual', () => {
  it('全都一样时相等（进度推送里 job 换了对象也不重渲染）', () => {
    expect(areAssetRowPropsEqual(props(), props())).toBe(true);
  });

  it('勾选状态变了要重渲染', () => {
    expect(areAssetRowPropsEqual(props(), props({ checked: false }))).toBe(false);
  });

  it('半选状态变了要重渲染', () => {
    expect(areAssetRowPropsEqual(props(), props({ indeterminate: true }))).toBe(false);
  });

  it('展开状态变了要重渲染', () => {
    expect(areAssetRowPropsEqual(props(), props({ expanded: true }))).toBe(false);
  });

  it('素材数组换了引用要重渲染', () => {
    expect(areAssetRowPropsEqual(props(), props({ assets: [...assets] }))).toBe(false);
  });

  it('回调换了引用要重渲染（否则点了没反应）', () => {
    expect(areAssetRowPropsEqual(props(), props({ onDownloadKind: vi.fn() }))).toBe(false);
  });

  it('行模型变了要重渲染', () => {
    expect(
      areAssetRowPropsEqual(
        props(),
        props({
          model: {
            status: { kind: 'done', count: 2 },
            countText: '✓ 2',
            showDownload: true,
            showRetry: false,
          },
        }),
      ),
    ).toBe(false);
  });
});
