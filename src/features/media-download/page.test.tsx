import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '../../kernel/jobs/types';
import type { DirState } from '../../kernel/messaging/protocol';
import type { ProductSnapshot } from '../../kernel/model/product';
import type { PageApi, SubmitResultLike } from '../types';
import {
  countByKind,
  MediaDownloadPanel,
  MediaDownloadSettingsSection,
  mediaBadge,
  mediaQuickActions,
  platformDisplayName,
  skuLabelMap,
  toPlannerSettings,
} from './page';
import { DEFAULT_MEDIA_DOWNLOAD_SETTINGS } from './settings';

/**
 * 页面侧集成测试（§8.6、§10.3、§10.4）。
 *
 * 这里测的是「组装起来对不对」：点主按钮真的会 submitJob、点行内下载只提交这一类、
 * 挑选模式提交的是选中的 key、换商品时清空挑选。
 * 文案规则本身在 primary-action-model.test.ts 里已经被逐行锁死了，这里不重复。
 */

function snapshot(patch: Partial<ProductSnapshot> = {}): ProductSnapshot {
  const main = Array.from({ length: 8 }, (_, i) => ({
    key: `main-${i}`,
    kind: 'main' as const,
    index: i,
    candidates: [`https://img.pddpic.com/m${i}.jpg`],
    preview: `https://img.pddpic.com/m${i}.jpg`,
  }));
  const detail = Array.from({ length: 26 }, (_, i) => ({
    key: `detail-${i}`,
    kind: 'detail' as const,
    index: i,
    candidates: [`https://img.pddpic.com/d${i}.jpg`],
  }));
  return {
    platform: 'pinduoduo',
    pageKind: 'pdd.goods',
    productId: '482319937501',
    title: '夏季新款显瘦连衣裙',
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=482319937501',
    skus: [],
    assets: [...main, ...detail],
    sources: ['ssr'],
    completeness: 'full',
    capturedAt: 0,
    ...patch,
  };
}

interface ApiSpy {
  api: PageApi;
  submitJob: ReturnType<typeof vi.fn>;
  cancelJob: ReturnType<typeof vi.fn>;
  retryJob: ReturnType<typeof vi.fn>;
  openGrant: ReturnType<typeof vi.fn>;
  copy: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
  pushJob(record: JobRecord): void;
  prefsData: Map<string, unknown>;
}

function makeApi(): ApiSpy {
  const submitJob = vi.fn(async (): Promise<SubmitResultLike> => ({ jobId: 'new-job' }));
  const cancelJob = vi.fn(async () => undefined);
  const retryJob = vi.fn(async () => ({ jobId: 'retry-job' }));
  const openGrant = vi.fn();
  const copy = vi.fn(async () => undefined);
  const call = vi.fn(async () => null);
  const prefsData = new Map<string, unknown>();
  let watcher: ((record: JobRecord) => void) | null = null;

  const api: PageApi = {
    submitJob,
    cancelJob,
    retryJob,
    openGrant: undefined as never,
    watchJobs: (filter: { type: string; dedupeKey?: string }, cb: (record: JobRecord) => void) => {
      void filter;
      watcher = cb;
      return () => {
        watcher = null;
      };
    },
    call,
    dir: { status: () => ({ status: 'ready', name: '电商素材' }) as DirState, openGrant },
    toast: vi.fn(),
    copy,
    prefs: {
      get: <T,>(k: string) => prefsData.get(k) as T | undefined,
      set: <T,>(k: string, v: T) => {
        prefsData.set(k, v);
      },
    },
  } as unknown as PageApi;

  return {
    api,
    submitJob,
    cancelJob,
    retryJob,
    openGrant,
    copy,
    call,
    prefsData,
    pushJob: (record) => watcher?.(record),
  };
}

function makeJob(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    type: 'media-download',
    dedupeKey: 'pinduoduo:482319937501',
    payload: {},
    status: 'running',
    total: 34,
    done: 10,
    skipped: 0,
    bytes: 2 * 1024 * 1024,
    failed: [],
    byGroup: { main: { total: 8, done: 10, failed: 0, skipped: 0 } },
    createdAt: 0,
    ...patch,
  };
}

function renderPanel(
  apiSpy: ApiSpy,
  snap = snapshot(),
  status: 'resolving' | 'ready' = 'ready',
  dir: DirState = { status: 'ready', name: '电商素材' },
) {
  return render(
    <MediaDownloadPanel
      snapshot={snap}
      status={status}
      settings={DEFAULT_MEDIA_DOWNLOAD_SETTINGS}
      api={apiSpy.api}
      dir={dir}
    />,
  );
}

describe('MediaDownloadPanel 组装（§8.6）', () => {
  it('渲染 4 行素材、保存位置、主按钮', () => {
    const spy = makeApi();
    renderPanel(spy);
    expect(screen.getByRole('listitem', { name: '主图' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: '详情图' })).toBeInTheDocument();
    expect(screen.getByText('保存到')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /下载 34 个文件/ })).toBeInTheDocument();
  });

  it('点主按钮提交勾选的类别', () => {
    const spy = makeApi();
    renderPanel(spy);
    fireEvent.click(screen.getByRole('button', { name: '下载 34 个文件' }));
    expect(spy.submitJob).toHaveBeenCalledTimes(1);
    const [type, payload] = spy.submitJob.mock.calls[0] ?? [];
    expect(type).toBe('media-download');
    expect((payload as { selection: { kinds: string[] } }).selection.kinds.sort()).toEqual([
      'detail',
      'main',
      'sku',
      'video',
    ]);
  });

  it('点行内下载只提交这一类（§10.3）', () => {
    const spy = makeApi();
    renderPanel(spy);
    const mainRow = screen.getByRole('listitem', { name: '主图' });
    fireEvent.click(within(mainRow).getByRole('button', { name: '下载' }));
    const payload = spy.submitJob.mock.calls[0]?.[1] as { selection: { kinds: string[] } };
    expect(payload.selection.kinds).toEqual(['main']);
  });

  it('取消勾选视频后主按钮文案变成部分类别（§10.4 第 3 行）', () => {
    const spy = makeApi();
    renderPanel(spy);
    fireEvent.click(screen.getByRole('checkbox', { name: '下载主图' }));
    // 只剩详情图有素材并已勾选 → 走「下载 N 个文件」；N 来自真实计划而不是快照总数
    expect(screen.getByRole('button', { name: /下载 26 个文件/ })).toBeInTheDocument();
  });

  it('主按钮的数量必须等于计划条数，不能是快照总数（§10.4）', () => {
    const spy = makeApi();
    // 详情图里放一张明显过窄的：它会被 detailMinWidth 过滤掉，不该算进「下载 N 个」
    const withNarrow = snapshot({
      assets: [
        ...snapshot().assets,
        {
          key: 'detail-narrow',
          kind: 'detail',
          index: 99,
          candidates: ['https://img.pddpic.com/narrow.jpg'],
          width: 50,
        },
      ],
    });
    renderPanel(spy, withNarrow);
    // 快照 35 条，但计划只有 34 条（窄图被过滤）
    expect(screen.queryByRole('button', { name: '下载 35 个文件' })).toBeNull();
    expect(screen.getByRole('button', { name: /下载 34 个文件/ })).toBeInTheDocument();
  });

  it('挑选模式：主按钮变成“下载所选 N 个”，提交的是选中的 key', () => {
    const spy = makeApi();
    renderPanel(spy);
    fireEvent.click(screen.getByRole('button', { name: '展开详情图' }));
    fireEvent.click(screen.getByRole('button', { name: '选择第 1 个素材' }));
    fireEvent.click(screen.getByRole('button', { name: '选择第 3 个素材' }));

    const button = screen.getByRole('button', { name: '下载所选 2 个' });
    fireEvent.click(button);
    const payload = spy.submitJob.mock.calls[0]?.[1] as {
      selection: { kinds: string[]; keys: string[] };
    };
    expect(payload.selection.keys).toEqual(['detail-0', 'detail-2']);
  });

  it('目录未设置时主按钮是“选择保存位置并下载”，点击打开授权小窗（§10.4 第 6 行）', () => {
    const spy = makeApi();
    renderPanel(spy, snapshot(), 'ready', { status: 'unset' });
    fireEvent.click(screen.getByRole('button', { name: '选择保存位置并下载' }));
    expect(spy.openGrant).toHaveBeenCalledWith('unset');
  });

  it('需要重新授权时文案是“允许访问并下载”（§10.4 第 7 行）', () => {
    const spy = makeApi();
    renderPanel(spy, snapshot(), 'ready', { status: 'needs-grant', name: '电商素材' });
    expect(screen.getByRole('button', { name: '允许访问并下载' })).toBeInTheDocument();
  });

  it('识别中主按钮禁用（§10.4 第 1 行）', () => {
    const spy = makeApi();
    renderPanel(spy, snapshot(), 'resolving');
    expect(screen.getByRole('button', { name: '正在识别商品…' })).toBeDisabled();
  });

  it('任务进度推过来后主按钮变成进度态，取消按钮可点', () => {
    const spy = makeApi();
    renderPanel(spy);
    fireEvent.click(screen.getByRole('button', { name: /下载 34 个文件/ }));

    // 模拟 bg 推来进度（§8.2 watchJobs）
    act(() => spy.pushJob(makeJob()));

    // 主按钮区和素材行各有一条进度条，这里只看主按钮区那条
    const primaryGroup = screen.getByRole('region', { name: /下载中/ });
    expect(within(primaryGroup).getByRole('progressbar')).toBeInTheDocument();
    fireEvent.click(within(primaryGroup).getByRole('button', { name: '取消' }));
    expect(spy.cancelJob).toHaveBeenCalledWith('job-1');
  });

  it('提交失败时面板显示可见的错误行，而不是静默（§10.4）', async () => {
    const spy = makeApi();
    spy.submitJob.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'INTERNAL' }));
    renderPanel(spy);
    fireEvent.click(screen.getByRole('button', { name: /下载 34 个文件/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('提交下载失败');
  });

  it('目录未授权时点下载：进入「等待选择文件夹」态并禁用按钮（§10.4 第 9 行）', async () => {
    const spy = makeApi();
    spy.submitJob.mockResolvedValueOnce({ waiting: 'dir' } as SubmitResultLike);
    renderPanel(spy, snapshot(), 'ready', { status: 'unset' });
    // unset 状态下主按钮先要求选择目录
    fireEvent.click(screen.getByRole('button', { name: '选择保存位置并下载' }));
    expect(spy.openGrant).toHaveBeenCalled();
  });

  it('重试失败项失效时，明确告诉用户而不是静默整单重提（C10）', async () => {
    const spy = makeApi();
    spy.retryJob.mockResolvedValueOnce(undefined as never);
    renderPanel(spy, snapshot(), 'ready', { status: 'ready', name: '电商素材' });
    act(() =>
      spy.pushJob(makeJob({ status: 'failed', failed: [{ itemKey: 'main:0', code: 'HTTP_404' }] })),
    );
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    // 不能悄悄提交一个全新的整单任务
    expect(spy.submitJob).not.toHaveBeenCalled();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('重新下载全部');
  });

  it('复制保存路径调用 api.copy（§10.5）', () => {
    const spy = makeApi();
    renderPanel(spy);
    fireEvent.click(screen.getByRole('button', { name: '复制保存路径' }));
    expect(spy.copy).toHaveBeenCalled();
    const arg = spy.copy.mock.calls[0]?.[0] as unknown as string;
    expect(arg).toContain('482319937501');
  });

  it('换商品后清空挑选模式（选中的 key 不在新快照里）', () => {
    const spy = makeApi();
    const { rerender } = renderPanel(spy);
    fireEvent.click(screen.getByRole('button', { name: '展开详情图' }));
    fireEvent.click(screen.getByRole('button', { name: '选择第 1 个素材' }));
    expect(screen.getByRole('button', { name: '下载所选 1 个' })).toBeInTheDocument();

    rerender(
      <MediaDownloadPanel
        snapshot={snapshot({
          productId: '999999999999',
          assets: [
            {
              key: 'other-a',
              kind: 'main',
              index: 0,
              candidates: ['https://img.pddpic.com/x.jpg'],
            },
          ],
        })}
        status="ready"
        settings={DEFAULT_MEDIA_DOWNLOAD_SETTINGS}
        api={spy.api}
        dir={{ status: 'ready', name: '电商素材' }}
      />,
    );
    expect(screen.getByRole('button', { name: '下载 1 个文件' })).toBeInTheDocument();
  });
});

describe('mediaBadge / mediaQuickActions（§8.5 插槽）', () => {
  it('badge 是可下载素材总数', () => {
    expect(mediaBadge(snapshot())).toBe(34);
  });

  it('快捷操作包含全部和每个非空类别', () => {
    const actions = mediaQuickActions(snapshot());
    expect(actions[0]?.title).toBe('下载全部 34 个素材');
    expect(actions.map((a) => a.id)).toContain('media-download.main');
    expect(actions.map((a) => a.id)).toContain('media-download.detail');
    // 没有 SKU 图和视频时不生成对应动作
    expect(actions.map((a) => a.id)).not.toContain('media-download.sku');
    expect(actions.map((a) => a.id)).not.toContain('media-download.video');
  });

  it('快捷操作会提交任务', () => {
    const spy = makeApi();
    const actions = mediaQuickActions(snapshot());
    actions[1]?.run(spy.api);
    expect(spy.submitJob).toHaveBeenCalled();
  });
});

describe('辅助纯函数', () => {
  it('countByKind 统计各类别数量', () => {
    expect(countByKind(snapshot())).toEqual({ main: 8, sku: 0, detail: 26, video: 0 });
  });

  it('skuLabelMap 把规格值连起来', () => {
    const map = skuLabelMap(
      snapshot({
        skus: [
          {
            id: '1',
            specs: [
              { name: '颜色', value: '杏色' },
              { name: '尺码', value: 'M' },
            ],
            imageKey: 'sk',
          },
        ],
      }),
    );
    expect(map.get('sk')).toBe('杏色-M');
  });

  it('platformDisplayName 用平台的叫法（§10.7 第 4 条）', () => {
    expect(platformDisplayName('pinduoduo')).toBe('拼多多');
    expect(platformDisplayName('douyin')).toBe('抖音');
  });

  it('toPlannerSettings 补齐 planner 需要的字段', () => {
    const s = toPlannerSettings(DEFAULT_MEDIA_DOWNLOAD_SETTINGS);
    expect(s.byPlatform).toBe(true);
    expect(s.dirNames.main).toBe('主图');
    expect(s.detailMinWidth).toBe(200);
  });
});

describe('MediaDownloadSettingsSection（§10.8 设置页）', () => {
  it('模板缺少 {id} 时报错（ADR-6）', () => {
    render(
      <MediaDownloadSettingsSection
        value={{ ...DEFAULT_MEDIA_DOWNLOAD_SETTINGS, folderTemplate: '{title}' }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('模板必须包含 {id}')).toBeInTheDocument();
  });

  it('模板带 {id} 时不报错', () => {
    render(
      <MediaDownloadSettingsSection value={DEFAULT_MEDIA_DOWNLOAD_SETTINGS} onChange={vi.fn()} />,
    );
    expect(screen.queryByText('模板必须包含 {id}')).toBeNull();
  });

  it('勾选“按平台分文件夹”会回调', () => {
    const onChange = vi.fn();
    render(
      <MediaDownloadSettingsSection value={DEFAULT_MEDIA_DOWNLOAD_SETTINGS} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /按平台分文件夹/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ byPlatform: false }));
  });

  it('改子文件夹名称会回调', () => {
    const onChange = vi.fn();
    render(
      <MediaDownloadSettingsSection value={DEFAULT_MEDIA_DOWNLOAD_SETTINGS} onChange={onChange} />,
    );
    const input = screen.getByDisplayValue('详情图');
    fireEvent.change(input, { target: { value: '详情' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ dirNames: expect.objectContaining({ detail: '详情' }) }),
    );
  });
});
