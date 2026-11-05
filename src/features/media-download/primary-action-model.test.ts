import { describe, expect, it } from 'vitest';
import type { JobRecord } from '../../kernel/jobs/types';
import type { AssetKind } from '../../kernel/model/asset';
import {
  DONE_LABEL_TTL_MS,
  joinKindLabels,
  type PrimaryActionState,
  primaryActionModel,
} from './primary-action-model';

/**
 * 覆盖 §10.4「主按钮和附加说明」表的每一行。
 * 表的行号写在各 it 的注释里，方便方案改版时逐行核对。
 */

const NOW = new Date(2026, 10, 5, 9, 0, 0).getTime();

function counts(partial: Partial<Record<AssetKind, number>> = {}): Record<AssetKind, number> {
  return { main: 8, sku: 12, detail: 26, video: 2, ...partial };
}

function makeJob(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    type: 'media-download',
    dedupeKey: 'pinduoduo:482319937501',
    payload: {},
    status: 'running',
    total: 48,
    done: 23,
    skipped: 0,
    bytes: 4_300_000,
    failed: [],
    byGroup: {},
    createdAt: NOW - 10_000,
    ...patch,
  };
}

function state(patch: Partial<PrimaryActionState> = {}): PrimaryActionState {
  return {
    status: 'ready',
    dir: 'ready',
    counts: counts(),
    selectedKinds: ['main', 'sku', 'detail', 'video'],
    selectedKeys: [],
    job: null,
    otherTabJob: null,
    queuedAhead: 0,
    history: null,
    grantPending: false,
    now: NOW,
    ...patch,
  };
}

describe('§10.4 主按钮第 1 行：识别中', () => {
  it('文案是“正在识别商品…”，禁用', () => {
    const m = primaryActionModel(state({ status: 'resolving' }));
    expect(m.label).toBe('正在识别商品…');
    expect(m.disabled).toBe(true);
    expect(m.progress).toBeNull();
    expect(m.meta).toEqual([]);
  });
});

describe('§10.4 主按钮第 2 行：就绪，全部类别勾选', () => {
  it('“下载 48 个文件”，强调色', () => {
    const m = primaryActionModel(state());
    expect(m.label).toBe('下载 48 个文件');
    expect(m.variant).toBe('accent');
    expect(m.disabled).toBe(false);
    expect(m.action.kind).toBe('submit');
  });

  it('数量为 0 的类别不参与“全部勾选”判断（视频 0 个时仍算全部）', () => {
    const m = primaryActionModel(state({ counts: counts({ video: 0 }) }));
    expect(m.label).toBe('下载 46 个文件');
  });
});

describe('§10.4 主按钮第 3 行：就绪，只勾选部分类别', () => {
  it('“下载主图和 SKU 图 · 20 个”', () => {
    const m = primaryActionModel(state({ selectedKinds: ['main', 'sku'] }));
    expect(m.label).toBe('下载主图和 SKU 图 · 20 个');
    expect(m.variant).toBe('accent');
  });

  it('三个类别用顿号加“和”', () => {
    const m = primaryActionModel(state({ selectedKinds: ['detail', 'main', 'sku'] }));
    expect(m.label).toBe('下载主图、SKU 图和详情图 · 46 个');
  });
});

describe('§10.4 主按钮第 4 行：挑选模式', () => {
  it('“下载所选 3 个”', () => {
    const m = primaryActionModel(state({ selectedKeys: ['k1', 'k2', 'k3'] }));
    expect(m.label).toBe('下载所选 3 个');
    expect(m.action.kind).toBe('submit');
  });

  it('挑选模式优先于历史记录里的“已全部下载”', () => {
    const m = primaryActionModel(
      state({
        selectedKeys: ['k1'],
        history: { lastAt: NOW - 86_400_000, missingCount: 0 },
      }),
    );
    expect(m.label).toBe('下载所选 1 个');
  });
});

describe('§10.4 主按钮第 5 行：没有勾选任何类别', () => {
  it('禁用并提示先勾选', () => {
    const m = primaryActionModel(state({ selectedKinds: [] }));
    expect(m.label).toBe('请先勾选要下载的素材');
    expect(m.disabled).toBe(true);
    expect(m.variant).toBe('neutral');
  });

  it('勾选的类别都为 0 个时同样禁用', () => {
    const m = primaryActionModel(state({ selectedKinds: ['video'], counts: counts({ video: 0 }) }));
    expect(m.label).toBe('请先勾选要下载的素材');
    expect(m.disabled).toBe(true);
  });
});

describe('§10.4 主按钮第 6 行：还没选目录', () => {
  it('“选择保存位置并下载”，点击打开授权小窗', () => {
    const m = primaryActionModel(state({ dir: 'unset' }));
    expect(m.label).toBe('选择保存位置并下载');
    expect(m.variant).toBe('accent');
    expect(m.action.kind).toBe('open-grant');
  });
});

describe('§10.4 主按钮第 7 行：需要重新授权', () => {
  it('“允许访问并下载”，附加说明“浏览器重启后需要确认一次”', () => {
    const m = primaryActionModel(state({ dir: 'needs-grant' }));
    expect(m.label).toBe('允许访问并下载');
    expect(m.variant).toBe('accent');
    expect(m.action.kind).toBe('open-grant');
    expect(m.meta).toEqual(['浏览器重启后需要确认一次']);
  });
});

describe('§10.4 主按钮第 8 行：目录丢失', () => {
  it('“重新选择保存位置”，说明找不到文件夹', () => {
    const m = primaryActionModel(state({ dir: 'gone' }));
    expect(m.label).toBe('重新选择保存位置');
    expect(m.action.kind).toBe('open-grant');
    expect(m.meta).toEqual(['找不到「电商素材」文件夹']);
  });
});

describe('§10.4 主按钮第 9 行：等待在小窗中操作', () => {
  it('禁用，右侧有“取消”', () => {
    const m = primaryActionModel(state({ grantPending: true }));
    expect(m.label).toBe('请在弹出的窗口中选择文件夹');
    expect(m.disabled).toBe(true);
    expect(m.secondary?.label).toBe('取消');
    expect(m.secondary?.action.kind).toBe('cancel-grant');
  });

  it('优先于所有其他状态（包括下载中）', () => {
    const m = primaryActionModel(state({ grantPending: true, job: makeJob() }));
    expect(m.label).toBe('请在弹出的窗口中选择文件夹');
  });
});

describe('§10.4 主按钮第 10 行：排队中', () => {
  it('写出前面还有几个任务', () => {
    const m = primaryActionModel(
      state({ job: makeJob({ status: 'queued', done: 0 }), queuedAhead: 1 }),
    );
    expect(m.label).toBe('排队中 · 前面还有 1 个任务');
    expect(m.variant).toBe('progress');
    expect(m.secondary?.action.kind).toBe('cancel');
  });
});

describe('§10.4 主按钮第 11 行：下载中', () => {
  it('进度条文案带精确数字和体积，右侧“取消”', () => {
    const m = primaryActionModel(state({ job: makeJob() }));
    expect(m.label).toBe('下载中 23/48 · 4.1 MB');
    expect(m.variant).toBe('progress');
    expect(m.progress).toEqual({ done: 23, total: 48 });
    expect(m.secondary?.label).toBe('取消');
    expect(m.secondary?.action.kind).toBe('cancel');
  });

  it('跳过计入已完成', () => {
    const m = primaryActionModel(state({ job: makeJob({ done: 20, skipped: 3 }) }));
    expect(m.progress).toEqual({ done: 23, total: 48 });
  });

  it('按钮主体不可点（防误触，§10.5）', () => {
    const m = primaryActionModel(state({ job: makeJob() }));
    expect(m.disabled).toBe(true);
    expect(m.action.kind).toBe('none');
  });
});

describe('§10.4 主按钮第 12 行：下载完成', () => {
  it('显示“已保存 48 个文件”并带跳过/体积/用时', () => {
    const m = primaryActionModel(
      state({
        job: makeJob({
          status: 'done',
          done: 48,
          bytes: 12.4 * 1024 * 1024,
          startedAt: NOW - 3200,
          endedAt: NOW,
        }),
      }),
    );
    expect(m.label).toBe('已保存 48 个文件');
    expect(m.variant).toBe('neutral');
    expect(m.meta).toEqual(['跳过 0 个 · 12.4 MB · 用时 3.2 秒']);
  });

  it('3 秒后不再显示完成文案，回落到历史/就绪', () => {
    const job = makeJob({
      status: 'done',
      done: 48,
      startedAt: NOW - 10_000,
      endedAt: NOW - DONE_LABEL_TTL_MS - 1,
    });
    const m = primaryActionModel(state({ job }));
    expect(m.label).not.toBe('已保存 48 个文件');
  });
});

describe('§10.4 主按钮第 13 行：部分失败', () => {
  it('“重试 3 个失败项”，说明按错误码归并', () => {
    const m = primaryActionModel(
      state({
        job: makeJob({
          status: 'partial',
          failed: [
            { itemKey: 'a', code: 'NETWORK' },
            { itemKey: 'b', code: 'NETWORK' },
            { itemKey: 'c', code: 'HTTP_404' },
          ],
        }),
      }),
    );
    expect(m.label).toBe('重试 3 个失败项');
    expect(m.variant).toBe('accent');
    expect(m.action.kind).toBe('retry-failed');
    expect(m.meta).toEqual(['网络不稳定（2）·图片已失效（1）']);
    expect(m.metaAction?.label).toBe('查看');
    expect(m.metaAction?.action.kind).toBe('show-failures');
  });
});

describe('§10.4 主按钮第 14 行：已取消', () => {
  it('“继续下载（剩余 25 个）”', () => {
    const m = primaryActionModel(
      state({ job: makeJob({ status: 'canceled', done: 23, total: 48 }) }),
    );
    expect(m.label).toBe('继续下载（剩余 25 个）');
    expect(m.action.kind).toBe('resume');
  });

  it('剩余为 0 时只说“继续下载”', () => {
    const m = primaryActionModel(
      state({ job: makeJob({ status: 'canceled', done: 48, total: 48 }) }),
    );
    expect(m.label).toBe('继续下载');
  });
});

describe('§10.4 主按钮第 15 行：中断', () => {
  it('“继续下载”加说明“上次下载中断了”', () => {
    const m = primaryActionModel(state({ job: makeJob({ status: 'interrupted' }) }));
    expect(m.label).toBe('继续下载');
    expect(m.meta).toEqual(['上次下载中断了']);
  });
});

describe('§10.4 主按钮第 16 行：有历史记录，缺文件', () => {
  it('“补全 3 个文件”，说明上次下载时间', () => {
    const m = primaryActionModel(
      state({ history: { lastAt: new Date(2026, 10, 3, 14, 20).getTime(), missingCount: 3 } }),
    );
    expect(m.label).toBe('补全 3 个文件');
    expect(m.variant).toBe('accent');
    expect(m.meta).toEqual(['上次下载于 11月3日 14:20']);
  });
});

describe('§10.4 主按钮第 17 行：有历史记录，已经齐全', () => {
  it('“已全部下载”，中性色但可点，点击做增量检查', () => {
    const m = primaryActionModel(
      state({ history: { lastAt: new Date(2026, 10, 3, 14, 20).getTime(), missingCount: 0 } }),
    );
    expect(m.label).toBe('已全部下载');
    expect(m.variant).toBe('neutral');
    expect(m.disabled).toBe(false);
    expect(m.action.kind).toBe('verify');
    expect(m.meta).toEqual(['上次下载于 11月3日 14:20 · 点击可重新检查']);
  });
});

describe('§10.4 主按钮第 18 行：同一商品正在其他标签页下载', () => {
  it('“正在其他标签页下载 23/48”', () => {
    const m = primaryActionModel(state({ otherTabJob: makeJob({ id: 'job-other', tabId: 99 }) }));
    expect(m.label).toBe('正在其他标签页下载 23/48');
    expect(m.variant).toBe('progress');
    expect(m.disabled).toBe(true);
  });

  it('本页自己正在下载时以本页为准', () => {
    const m = primaryActionModel(
      state({ job: makeJob({ id: 'job-mine' }), otherTabJob: makeJob({ id: 'job-other' }) }),
    );
    expect(m.label).toBe('下载中 23/48 · 4.1 MB');
  });
});

describe('优先级细节', () => {
  it('目录 needs-grant 优先于历史记录（目录没授权时读不到历史）', () => {
    const m = primaryActionModel(
      state({ dir: 'needs-grant', history: { lastAt: NOW, missingCount: 2 } }),
    );
    expect(m.label).toBe('允许访问并下载');
  });

  it('没勾选优先于没选目录：避免骗用户去选文件夹却下不了', () => {
    const m = primaryActionModel(state({ dir: 'unset', selectedKinds: [] }));
    expect(m.label).toBe('请先勾选要下载的素材');
  });

  it('整单失败且没有逐项记录时给“重试”', () => {
    const m = primaryActionModel(
      state({ job: makeJob({ status: 'failed', failed: [], done: 0 }) }),
    );
    expect(m.label).toBe('重试');
    expect(m.meta).toEqual(['上次下载没有开始']);
  });
});

describe('joinKindLabels', () => {
  it('西文词前补一个空格', () => {
    expect(joinKindLabels(['detail'])).toBe('详情图');
  });

  it('单个不加连接词', () => {
    expect(joinKindLabels(['main'])).toBe('主图');
  });

  it('两个用“和”', () => {
    expect(joinKindLabels(['main', 'sku'])).toBe('主图和 SKU 图');
  });

  it('三个用顿号加“和”', () => {
    expect(joinKindLabels(['main', 'sku', 'detail'])).toBe('主图、SKU 图和详情图');
  });

  it('空数组给空串', () => {
    expect(joinKindLabels([])).toBe('');
  });
});
