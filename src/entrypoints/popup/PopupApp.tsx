import { useEffect, useState } from 'react';
import { errorMessage } from '../../kernel/errors/messages';
import type { TabState } from '../../kernel/messaging/protocol';
import { sendMessage } from '../../kernel/messaging/runtime';
import type { AssetKind } from '../../kernel/model/asset';

/**
 * 工具栏 popup（方案 §10.8，宽 320px）。
 *
 * 它是**备用入口**：面板被遮挡、或者用户把面板设成"不显示"时用。
 * 数据通过 shell.getTabState 从页面取，和面板共用同一份状态 —— 在任一处操作，另一处都会同步。
 *
 * 为了保持 320px 宽度可读，这里只放简化版素材行（复选框、名称、数量、下载），没有缩略图。
 */
const KIND_LABEL: Record<AssetKind, string> = {
  main: '主图',
  sku: 'SKU图',
  detail: '详情图',
  video: '视频',
};
const KIND_ORDER: AssetKind[] = ['main', 'sku', 'detail', 'video'];

export function PopupApp() {
  const [state, setState] = useState<TabState | null>(null);
  const [loading, setLoading] = useState(true);
  const [checked, setChecked] = useState<Set<AssetKind>>(new Set(KIND_ORDER));

  useEffect(() => {
    // popup 打开时页面可能还在识别：识别中就每 400ms 再问一次，直到有结论（最多约 12 秒）。
    // 旧实现只问一次，打开得早就永远停在「正在识别…」。
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    const poll = async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          if (!cancelled) setLoading(false);
          return;
        }
        const s = await sendMessage('shell.getTabState', { tabId: tab.id });
        if (cancelled) return;
        setState(s);
        const pending = s.matched && (s.status === 'detecting' || s.status === 'resolving');
        if (pending && tries++ < 30) timer = setTimeout(() => void poll(), 400);
      } catch {
        if (!cancelled) setState(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const counts = countAssets(state);

  const toggle = (kind: AssetKind) => {
    const next = new Set(checked);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setChecked(next);
  };

  if (loading) {
    return (
      <main className="pp">
        <header className="pp__hdr">电商素材工具箱</header>
        <div className="pp__body">
          <p className="pp__empty">正在读取当前页面…</p>
        </div>
      </main>
    );
  }

  // 不是商品页：说明支持的页面 + 目录状态 + 设置入口（§10.8）
  if (!state?.matched) {
    return (
      <main className="pp">
        <header className="pp__hdr">
          <span className="pp__dot" />
          电商素材工具箱
        </header>
        <div className="pp__body">
          <p className="pp__empty">当前页面不是商品详情页</p>
          <p className="pp__meta">支持的页面：拼多多商品页、抖音商城商品页</p>
        </div>
        <footer className="pp__ftr">
          <span>{dirLabel(state)}</span>
          <button
            type="button"
            className="pp__link"
            onClick={() => void sendMessage('shell.openOptions')}
          >
            设置
          </button>
        </footer>
      </main>
    );
  }

  const total = KIND_ORDER.reduce((sum, k) => sum + (checked.has(k) ? counts[k] : 0), 0);

  return (
    <main className="pp">
      <header className="pp__hdr">
        <span className="pp__dot" />
        {state.platform === 'pinduoduo' ? '拼多多' : state.platform === 'douyin' ? '抖音' : '商品'}
      </header>
      <div className="pp__body">
        <p className="pp__title" title={state.snapshot?.title ?? ''}>
          {state.snapshot?.title ??
            (state.status === 'blocked'
              ? errorMessage(state.blocker ?? 'PARSE_EMPTY').title
              : '正在识别…')}
        </p>
        {!state.snapshot && state.status === 'blocked' ? (
          <p className="pp__meta">
            {errorMessage(state.blocker ?? 'PARSE_EMPTY').hint ?? ''}
            {state.blocker ? `（${state.blocker}）` : ''}
          </p>
        ) : null}
        <p className="pp__meta">ID {state.snapshot?.productId ?? state.productId ?? '—'}</p>
        {KIND_ORDER.map((kind) => (
          <label key={kind} className="pp__row">
            <input
              type="checkbox"
              checked={checked.has(kind)}
              disabled={counts[kind] === 0}
              onChange={() => toggle(kind)}
            />
            <span className="pp__row-name">{KIND_LABEL[kind]}</span>
            <span className="pp__row-count">{counts[kind] === 0 ? '无' : counts[kind]}</span>
            <button
              type="button"
              className="pp__row-btn"
              disabled={counts[kind] === 0}
              onClick={() => void download([kind])}
            >
              下载
            </button>
          </label>
        ))}
        <button
          type="button"
          className="pp__primary"
          disabled={total === 0}
          onClick={() => void download()}
        >
          {total === 0 ? '请先勾选要下载的素材' : `下载 ${total} 个文件`}
        </button>
      </div>
      <footer className="pp__ftr">
        <span>{dirLabel(state)}</span>
        <button
          type="button"
          className="pp__link"
          onClick={() => void sendMessage('shell.openOptions')}
        >
          设置
        </button>
      </footer>
    </main>
  );
}

function countAssets(state: TabState | null): Record<AssetKind, number> {
  const out: Record<AssetKind, number> = { main: 0, sku: 0, detail: 0, video: 0 };
  for (const a of state?.snapshot?.assets ?? []) out[a.kind] += 1;
  return out;
}

function dirLabel(state: TabState | null): string {
  const st = state?.dir.status;
  if (st === 'ready') return state?.dir.name ?? '已选择保存位置';
  if (st === 'needs-grant') return '需要授权';
  if (st === 'gone') return '找不到保存文件夹';
  return '未选择保存位置';
}

/**
 * 触发下载。popup 不自己拼计划，交给页面（它知道真实快照）。
 *
 * `kinds` 为空数组表示「按页面里的勾选」；否则只下这几类。
 * 旧实现忽略 popup 上的勾选框，永远发 'download-checked' ——
 * 用户取消勾选「视频」后点下载，视频照样会下。
 */
async function download(kinds?: AssetKind[]): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const command =
    kinds === undefined || kinds.length === 0
      ? 'download-checked'
      : kinds.length === 1
        ? `download-${kinds[0]}`
        : `download-kinds:${kinds.join(',')}`;
  await chrome.tabs.sendMessage(tab.id, { type: 'ecbox:command', command });
  window.close();
}
