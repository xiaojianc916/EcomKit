import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '../../../kernel/jobs/types';
import type { Asset } from '../../../kernel/model/asset';
import { AssetList, countAssets, groupAssetsByKind, isAllChecked } from './AssetList';

/**
 * 素材清单与素材行的渲染（§10.3 ④、§10.4 素材行表、§8.4 空类别也显示）。
 */

function asset(patch: Partial<Asset> & Pick<Asset, 'key' | 'kind' | 'index'>): Asset {
  return { candidates: [`https://img.pddpic.com/${patch.key}.jpg`], ...patch };
}

function makeJob(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'j1',
    type: 'media-download',
    dedupeKey: 'pdd:1',
    payload: {},
    status: 'running',
    total: 10,
    done: 0,
    skipped: 0,
    bytes: 0,
    failed: [],
    byGroup: {},
    createdAt: 0,
    ...patch,
  };
}

interface SetupOptions {
  mainCount?: number;
  detailCount?: number;
  videoCount?: number;
  /** 视频是否带封面；false 时走「用视频首帧兜底」的路径 */
  videoCover?: boolean;
  checkedKinds?: ('main' | 'sku' | 'detail' | 'video')[];
  selectedKeys?: string[];
  expandedKind?: 'main' | 'sku' | 'detail' | 'video' | null;
  job?: JobRecord | null;
  resolving?: boolean;
}

function renderList(opts: SetupOptions = {}) {
  const main = Array.from({ length: opts.mainCount ?? 8 }, (_, i) =>
    asset({
      key: `main-${i}`,
      kind: 'main',
      index: i,
      preview: `https://img.pddpic.com/m${i}.jpg`,
    }),
  );
  const detail = Array.from({ length: opts.detailCount ?? 26 }, (_, i) =>
    asset({ key: `detail-${i}`, kind: 'detail', index: i }),
  );
  const video = Array.from({ length: opts.videoCount ?? 0 }, (_, i) =>
    asset({
      key: `video-${i}`,
      kind: 'video',
      index: i,
      // 真实快照里视频没有 preview；封面来自 video.cover，没有封面时由 Thumb 画首帧
      candidates: [`https://video.pddpic.com/v${i}.mp4`],
      video:
        opts.videoCover === false
          ? { codec: 'h264', container: 'mp4' }
          : {
              codec: 'h264',
              container: 'mp4',
              cover: `https://img.pddpic.com/cover${i}.jpg`,
            },
    }),
  );
  const byKind = groupAssetsByKind([...main, ...detail, ...video]);
  const handlers = {
    onToggleCheck: vi.fn(),
    onToggleAll: vi.fn(),
    onDownloadKind: vi.fn(),
    onRetryKind: vi.fn(),
    onExpand: vi.fn(),
    onToggleKey: vi.fn(),
    onSelectAllIn: vi.fn(),
    onClearIn: vi.fn(),
  };
  render(
    <AssetList
      byKind={byKind}
      checkedKinds={new Set(opts.checkedKinds ?? ['main', 'sku', 'detail', 'video'])}
      selectedKeys={new Set(opts.selectedKeys ?? [])}
      expandedKind={opts.expandedKind ?? null}
      resolving={opts.resolving ?? false}
      job={opts.job ?? null}
      onToggleCheck={handlers.onToggleCheck}
      onToggleAll={handlers.onToggleAll}
      onDownloadKind={handlers.onDownloadKind}
      onRetryKind={handlers.onRetryKind}
      onExpand={handlers.onExpand}
      onToggleKey={handlers.onToggleKey}
      onSelectAllIn={handlers.onSelectAllIn}
      onClearIn={handlers.onClearIn}
      allChecked={isAllChecked(
        byKind,
        new Set(opts.checkedKinds ?? ['main', 'sku', 'detail', 'video']),
      )}
    />,
  );
  return handlers;
}

describe('AssetList 固定 4 行（§8.4 数量为 0 也显示）', () => {
  it('四个类别始终各占一行', () => {
    renderList();
    expect(screen.getByRole('listitem', { name: '主图' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'SKU 图' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: '详情图' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: '视频' })).toBeInTheDocument();
  });

  it('数量为 0 的类别显示“无”，复选框禁用', () => {
    renderList({ mainCount: 8, detailCount: 0 });
    const videoRow = screen.getByRole('listitem', { name: '视频' });
    expect(within(videoRow).getByText('无')).toBeInTheDocument();
    expect(within(videoRow).getByRole('checkbox', { name: '下载视频' })).toBeDisabled();
  });

  it('区块标题右侧是全选/全不选切换', () => {
    const handlers = renderList({ checkedKinds: [] });
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(handlers.onToggleAll).toHaveBeenCalled();
  });
});

describe('素材行交互（§10.3 素材行交互表）', () => {
  it('点复选框切换这一类', () => {
    const handlers = renderList();
    fireEvent.click(screen.getByRole('checkbox', { name: '下载主图' }));
    expect(handlers.onToggleCheck).toHaveBeenCalledWith('main');
  });

  it('点行内“下载”只下这一类', () => {
    const handlers = renderList();
    const mainRow = screen.getByRole('listitem', { name: '主图' });
    fireEvent.click(within(mainRow).getByRole('button', { name: '下载' }));
    expect(handlers.onDownloadKind).toHaveBeenCalledWith('main');
    // 点“下载”不应该同时展开网格
    expect(handlers.onExpand).not.toHaveBeenCalled();
  });

  it('点行的其余区域展开网格', () => {
    const handlers = renderList();
    const mainRow = screen.getByRole('listitem', { name: '主图' });
    fireEvent.click(within(mainRow).getByRole('button', { name: '展开主图' }));
    expect(handlers.onExpand).toHaveBeenCalledWith('main');
  });

  it('行上按空格切换勾选（§10.5 键盘操作）', () => {
    const handlers = renderList();
    const mainRow = screen.getByRole('listitem', { name: '主图' });
    fireEvent.keyDown(within(mainRow).getByRole('button', { name: '展开主图' }), { key: ' ' });
    expect(handlers.onToggleCheck).toHaveBeenCalledWith('main');
  });

  it('行上按 Enter 展开网格（§10.5 键盘操作）', () => {
    const handlers = renderList();
    const mainRow = screen.getByRole('listitem', { name: '主图' });
    fireEvent.keyDown(within(mainRow).getByRole('button', { name: '展开主图' }), { key: 'Enter' });
    expect(handlers.onExpand).toHaveBeenCalledWith('main');
  });

  it('数量为 0 的行不能展开（展开也是空的）', () => {
    const handlers = renderList({ mainCount: 8, detailCount: 0 });
    const detailRow = screen.getByRole('listitem', { name: '详情图' });
    const expander = within(detailRow).getByRole('button', { name: '展开详情图' });
    expect(expander).toBeDisabled();
    fireEvent.click(expander);
    expect(handlers.onExpand).not.toHaveBeenCalled();
  });

  it('数量为 0 的行按空格不切换勾选', () => {
    const handlers = renderList({ detailCount: 0 });
    const detailRow = screen.getByRole('listitem', { name: '详情图' });
    fireEvent.keyDown(within(detailRow).getByRole('button', { name: '展开详情图' }), { key: ' ' });
    expect(handlers.onToggleCheck).not.toHaveBeenCalled();
  });

  it('行的 aria-expanded 跟着展开状态（挂在整行的展开按钮上）', () => {
    renderList({ expandedKind: 'main' });
    const mainRow = screen.getByRole('listitem', { name: '主图' });
    const detailRow = screen.getByRole('listitem', { name: '详情图' });
    expect(within(mainRow).getByRole('button', { name: '收起主图' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(detailRow).getByRole('button', { name: '展开详情图' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

describe('素材行状态渲染（§10.4 素材行表）', () => {
  it('识别中：数量显示“—”', () => {
    renderList({ resolving: true });
    const mainRow = screen.getByRole('listitem', { name: '主图' });
    expect(within(mainRow).getByText('—')).toBeInTheDocument();
    expect(within(mainRow).queryByRole('button', { name: '下载' })).toBeNull();
  });

  it('下载中：缩略图条换成进度条并显示 12/26', () => {
    const job = makeJob({
      status: 'running',
      byGroup: { detail: { total: 26, done: 12, failed: 0, skipped: 0 } },
    });
    renderList({ job });
    const detailRow = screen.getByRole('listitem', { name: '详情图' });
    expect(within(detailRow).getByText('12/26')).toBeInTheDocument();
    expect(within(detailRow).getByRole('progressbar')).toBeInTheDocument();
  });

  it('完成：显示 ✓ 26', () => {
    const job = makeJob({
      status: 'done',
      byGroup: { detail: { total: 26, done: 26, failed: 0, skipped: 0 } },
    });
    renderList({ job });
    expect(
      within(screen.getByRole('listitem', { name: '详情图' })).getByText('✓ 26'),
    ).toBeInTheDocument();
  });

  it('部分失败：24/26 · 2 个失败，带“重试”', () => {
    const handlers = renderList({
      job: makeJob({
        status: 'partial',
        byGroup: { detail: { total: 26, done: 24, failed: 2, skipped: 0 } },
        failed: [
          { itemKey: 'detail:a', code: 'NETWORK' },
          { itemKey: 'detail:b', code: 'HTTP_404' },
        ],
      }),
    });
    const detailRow = screen.getByRole('listitem', { name: '详情图' });
    expect(within(detailRow).getByText('24/26 · 2 个失败')).toBeInTheDocument();
    fireEvent.click(within(detailRow).getByRole('button', { name: '重试' }));
    expect(handlers.onRetryKind).toHaveBeenCalledWith('detail');
  });

  it('视频行显示封面缩略图，不把 mp4 直链当图片（§10.3）', () => {
    renderList({ videoCount: 1 });
    const videoRow = screen.getByRole('listitem', { name: '视频' });
    const img = within(videoRow).getByRole('img', { name: '视频1' });
    expect(img).toHaveAttribute('src', 'https://img.pddpic.com/cover0.jpg');
  });

  it('平台没给视频封面时用视频首帧兜底，不是灰色空块', () => {
    renderList({ videoCount: 1, videoCover: false });
    const videoRow = screen.getByRole('listitem', { name: '视频' });
    const video = videoRow.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toBe('https://video.pddpic.com/v0.mp4#t=0.1');
    expect(within(videoRow).queryByRole('img')).toBeNull();
  });

  it('挑选模式：这一行数量变成 3/26，复选框半选', () => {
    renderList({ selectedKeys: ['detail-0', 'detail-1', 'detail-2'] });
    const detailRow = screen.getByRole('listitem', { name: '详情图' });
    expect(within(detailRow).getByText('3/26')).toBeInTheDocument();
    expect(within(detailRow).getByRole('checkbox', { name: '下载详情图' })).toHaveAttribute(
      'data-state',
      'indeterminate',
    );
  });
});

describe('缩略图网格（§10.3）', () => {
  it('展开后出现工具条，全选把这一类的 key 都选上', () => {
    const handlers = renderList({ expandedKind: 'detail' });
    expect(screen.getByText('已选 0 / 26')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(handlers.onSelectAllIn).toHaveBeenCalledWith('detail');
  });

  it('一个都没选时“清除”是禁用的，选了之后可以点', () => {
    const emptyHandlers = renderList({ expandedKind: 'detail' });
    expect(screen.getByRole('button', { name: '清除' })).toBeDisabled();
    expect(emptyHandlers.onClearIn).not.toHaveBeenCalled();
  });

  it('选了之后点“清除”回到按类别下载', () => {
    const handlers = renderList({ expandedKind: 'detail', selectedKeys: ['detail-0'] });
    expect(screen.getByText('已选 1 / 26')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(handlers.onClearIn).toHaveBeenCalled();
  });

  it('点格子进入挑选模式', () => {
    const handlers = renderList({ expandedKind: 'detail' });
    fireEvent.click(screen.getByRole('button', { name: '选择第 1 个素材' }));
    expect(handlers.onToggleKey).toHaveBeenCalledWith('detail', 'detail-0');
  });

  it('选中的格子 aria-pressed 为 true', () => {
    renderList({ expandedKind: 'detail', selectedKeys: ['detail-0'] });
    expect(screen.getByRole('button', { name: '取消选择第 1 个素材' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('缩略图网格分批渲染（200 张详情图的真实场景）', () => {
  it('超过一批时只渲染第一批，并给出「继续加载」', () => {
    renderList({ expandedKind: 'detail', detailCount: 200 });
    // 第一批 60 格，其余延后
    expect(screen.getAllByRole('button', { name: /选择第 |取消选择第 / })).toHaveLength(60);
    expect(screen.getByRole('button', { name: '继续加载（还有 140 个）' })).toBeInTheDocument();
  });

  it('点「继续加载」多放一批，序号仍然按整个类别算', () => {
    renderList({ expandedKind: 'detail', detailCount: 200 });
    fireEvent.click(screen.getByRole('button', { name: '继续加载（还有 140 个）' }));
    expect(screen.getAllByRole('button', { name: /选择第 |取消选择第 / })).toHaveLength(120);
    // 第 61 个格子的序号是 61，不是 01
    expect(screen.getByRole('button', { name: '选择第 61 个素材' })).toBeInTheDocument();
  });

  it('不超过一批时不出现「继续加载」', () => {
    renderList({ expandedKind: 'detail', detailCount: 26 });
    expect(screen.queryByRole('button', { name: /继续加载/ })).toBeNull();
  });

  it('工具条上的「已选 N / 总数」用的是整个类别的总数，不是已渲染数', () => {
    renderList({ expandedKind: 'detail', detailCount: 200 });
    expect(screen.getByText('已选 0 / 200')).toBeInTheDocument();
  });
});

describe('countAssets / isAllChecked', () => {
  it('统计所有类别的素材总数', () => {
    const byKind = groupAssetsByKind([
      asset({ key: 'a', kind: 'main', index: 0 }),
      asset({ key: 'b', kind: 'detail', index: 0 }),
      asset({ key: 'c', kind: 'detail', index: 1 }),
    ]);
    expect(countAssets(byKind)).toBe(3);
  });

  it('有素材的类别全勾才算全选（0 个的类别不参与）', () => {
    const byKind = groupAssetsByKind([asset({ key: 'a', kind: 'main', index: 0 })]);
    expect(isAllChecked(byKind, new Set(['main']))).toBe(true);
    expect(isAllChecked(byKind, new Set())).toBe(false);
  });

  it('没有任何素材时不算全选', () => {
    expect(isAllChecked(groupAssetsByKind([]), new Set())).toBe(false);
  });
});
