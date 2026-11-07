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

/** popup 打开时页面可能还在识别：最多等这么久（30 × 400ms） */
const POLL_TRIES = 30;
const POLL_INTERVAL_MS = 400;

export function PopupApp() {
  const [state, setState] = useState<TabState | null>(null);
  const [loading, setLoading] = useState(true);
  const [checked, setChecked] = useState<Set<AssetKind>>(() => new Set(KIND_ORDER));
  /** 命令发不出去时的说明（页面没注入 / 扩展刚更新）：popup 不能静默关门 */
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // popup 打开时页面可能还在识别：识别中就每 400ms 再问一次，直到有结论（最多约 12 秒）。
    // 旧实现只问一次，打开得早就永远停在「正在识别…」。
    // 轮询自己持有 timer，也只从 stop() 释放：effect 不需要再关心「timer 变量此刻有没有值」，
    // 卸载后的续期和 setState 都由 stopped 挡住。
    const poll = startTabStatePoll({
      onState: setState,
      onGiveUp: () => setState(null),
      onSettled: () => setLoading(false),
    });
    return () => poll.stop();
  }, []);

  const counts = countAssets(state);

  const toggle = (kind: AssetKind) => {
    const next = new Set(checked);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setChecked(next);
  };

  /**
   * 发命令。**失败必须可见**：popup 里点击按钮后窗口会立刻关闭，
   * 如果 sendMessage 抛错（页面没注入、扩展刚更新导致 context invalidated），
   * 用户看到的就是「点了下载，什么都没发生」。所以先 await，成功才关窗。
   */
  const download = async (kinds?: AssetKind[]): Promise<void> => {
    try {
      await sendDownloadCommand(kinds);
      window.close();
    } catch {
      setError('这个页面没有加载工具箱，请刷新商品页后重试');
    }
  };

  const handleDownload = (kinds?: AssetKind[]): void => {
    void download(kinds);
  };

  if (loading) return <PopupLoading />;

  // 命令发送失败要压过其它所有分支：否则「点了下载没反应」时用户看到的是页面信息，
  // 完全不知道刚才那一下发生了什么。
  if (error !== null) return <PopupErrorNotice text={error} onBack={() => setError(null)} />;

  // 不是商品页：说明支持的页面 + 目录状态 + 设置入口（§10.8）
  if (!state?.matched) return <PopupUnmatched state={state} />;

  return (
    <PopupContent
      state={state}
      checked={checked}
      counts={counts}
      onToggle={toggle}
      onDownload={handleDownload}
    />
  );
}

interface TabStatePollHandlers {
  /** 拿到一次状态（可能还是识别中，之后会再问） */
  onState(state: TabState): void;
  /** 重试次数用完仍然没问到：交给上层显示空状态 */
  onGiveUp(): void;
  /** 这一轮查询结束（成功、放弃、或者根本没拿到 tab）：把 loading 关掉 */
  onSettled(): void;
}

interface TabStatePoll {
  /** 停止轮询并释放 timer。可以重复调用 */
  stop(): void;
}

/**
 * 轮询当前 tab 的状态。
 *
 * 把 timer 的创建和释放都收进这一个把手：effect 里只留「拿到 poll，卸载时 stop」，
 * 这样每一条退出路径都走同一个释放口，不会出现「timer 已经排上、cleanup 却拿不到它」的漏网。
 * stop() 里先置 stopped 再清 timer —— 卸载后不会续期，也不会再 setState。
 */
function startTabStatePoll(handlers: TabStatePollHandlers): TabStatePoll {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tries = 0;

  /** 排下一次轮询（全流程唯一创建 timer 的地方） */
  function schedule(): void {
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
  }

  async function poll(): Promise<void> {
    try {
      // activeTab 在 popup 打开时已经授予，用 lastFocusedWindow 更准：
      // 用户点扩展图标时焦点一定在这个窗口上，而 currentWindow 在多窗口场景下可能取到别的。
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) return;
      const s = await sendMessage('shell.getTabState', { tabId: tab.id });
      if (stopped) return;
      handlers.onState(s);
      const pending = s.matched && (s.status === 'detecting' || s.status === 'resolving');
      if (pending && tries++ < POLL_TRIES) schedule();
    } catch {
      // 背景还没醒（MV3 SW 冷启动）或页面正在导航：再试一次，直到用完次数
      if (stopped) return;
      if (tries++ < POLL_TRIES) {
        schedule();
      } else {
        handlers.onGiveUp();
      }
    } finally {
      if (!stopped) handlers.onSettled();
    }
  }

  void poll();

  return {
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** 顶栏：读取中那一屏不画状态圆点，其余都画（和旧实现一致） */
function PopupHeader({ title, showDot = false }: { title: string; showDot?: boolean }) {
  return (
    <header className="pp__hdr">
      {showDot ? <span className="pp__dot" /> : null}
      {title}
    </header>
  );
}

/** 底栏：保存位置 + 设置入口 */
function PopupFooter({ dirText }: { dirText: string }) {
  return (
    <footer className="pp__ftr">
      <span>{dirText}</span>
      <button
        type="button"
        className="pp__link"
        onClick={() => void sendMessage('shell.openOptions')}
      >
        设置
      </button>
    </footer>
  );
}

/** 读取当前页面（很快，但 popup 不能先闪一下空状态） */
function PopupLoading() {
  return (
    <main className="pp">
      <PopupHeader title="电商素材工具箱" />
      <div className="pp__body">
        <p className="pp__empty">正在读取当前页面…</p>
      </div>
    </main>
  );
}

/** 命令发不出去：把原因写清楚，并且给一个「返回」而不是让用户重开 popup */
function PopupErrorNotice({ text, onBack }: { text: string; onBack(): void }) {
  return (
    <main className="pp">
      <PopupHeader title="电商素材工具箱" showDot />
      <div className="pp__body">
        <p className="pp__empty">{text}</p>
        <button type="button" className="pp__primary" onClick={onBack}>
          返回
        </button>
      </div>
    </main>
  );
}

/** 不是商品页：说明支持哪些页面 + 目录状态 + 设置入口 */
function PopupUnmatched({ state }: { state: TabState | null }) {
  return (
    <main className="pp">
      <PopupHeader title="电商素材工具箱" showDot />
      <div className="pp__body">
        <p className="pp__empty">当前页面不是商品详情页</p>
        <p className="pp__meta">支持的页面：拼多多商品页、抖音商城商品页</p>
      </div>
      <PopupFooter dirText={dirLabel(state)} />
    </main>
  );
}

interface PopupContentProps {
  state: TabState;
  checked: ReadonlySet<AssetKind>;
  counts: Record<AssetKind, number>;
  onToggle(kind: AssetKind): void;
  onDownload(kinds?: AssetKind[]): void;
}

/** 商品页：标题 + 四个类别行 + 主按钮 */
function PopupContent({ state, checked, counts, onToggle, onDownload }: PopupContentProps) {
  const total = countSelected(checked, counts);
  const hint = blockerHint(state);

  return (
    <main className="pp">
      <PopupHeader title={platformLabel(state)} showDot />
      <div className="pp__body">
        <p className="pp__title" title={state.snapshot?.title ?? ''}>
          {titleText(state)}
        </p>
        {hint === null ? null : <p className="pp__meta">{hint}</p>}
        <p className="pp__meta">ID {state.snapshot?.productId ?? state.productId ?? '—'}</p>
        {KIND_ORDER.map((kind) => (
          <KindRow
            key={kind}
            kind={kind}
            checked={checked.has(kind)}
            count={counts[kind]}
            onToggle={onToggle}
            onDownload={onDownload}
          />
        ))}
        <button
          type="button"
          className="pp__primary"
          disabled={total === 0}
          // 必须把 popup 上**实际勾选**的类别传下去：旧实现传 undefined，页面收到
          // 'download-checked' 就按「全部类别」下发，用户取消勾选「视频」也照样会下。
          onClick={() => onDownload(KIND_ORDER.filter((k) => checked.has(k)))}
        >
          {total === 0 ? '请先勾选要下载的素材' : `下载 ${total} 个文件`}
        </button>
      </div>
      <PopupFooter dirText={dirLabel(state)} />
    </main>
  );
}

interface KindRowProps {
  kind: AssetKind;
  checked: boolean;
  count: number;
  onToggle(kind: AssetKind): void;
  onDownload(kinds?: AssetKind[]): void;
}

/**
 * 一个类别的行：<复选框 + 名称 + 数量> + 行内「下载」。
 *
 * label 只包复选框和它的文字（名称、数量），「下载」按钮放在 label 外面：
 * 一个 label 只能标一个控件。旧实现把按钮也塞进 label 里，点「下载」会顺带
 * 切换复选框，读屏器也念不准这一行到底标的是什么。
 * 整行仍是 .pp__row 的 flex 布局和 hover 高亮；label 用 flex:1 铺满按钮以外的区域，
 * 所以「点名称/数量/空白处切换勾选」的手感不变。
 */
function KindRow({ kind, checked, count, onToggle, onDownload }: KindRowProps) {
  const disabled = count === 0;
  return (
    <div className="pp__row">
      <label className="pp__row-label">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={() => onToggle(kind)}
        />
        <span className="pp__row-name">{KIND_LABEL[kind]}</span>
        <span className="pp__row-count">{disabled ? '无' : count}</span>
      </label>
      <button
        type="button"
        className="pp__row-btn"
        disabled={disabled}
        onClick={() => onDownload([kind])}
      >
        下载
      </button>
    </div>
  );
}

/** 平台叫法；识别不出平台时用中性说法 */
function platformLabel(state: TabState): string {
  if (state.platform === 'pinduoduo') return '拼多多';
  if (state.platform === 'douyin') return '抖音';
  return '商品';
}

/** 标题：有快照就用快照标题，被拦下时说原因，否则说正在识别 */
function titleText(state: TabState): string {
  const title = state.snapshot?.title;
  if (title !== undefined) return title;
  if (state.status !== 'blocked') return '正在识别…';
  return errorMessage(state.blocker ?? 'PARSE_EMPTY').title;
}

/** 被拦下时补一行说明（只在没有快照时有意义）；null 表示不显示 */
function blockerHint(state: TabState): string | null {
  if (state.snapshot || state.status !== 'blocked') return null;
  const hint = errorMessage(state.blocker ?? 'PARSE_EMPTY').hint ?? '';
  return `${hint}${state.blocker ? `（${state.blocker}）` : ''}`;
}

/** 勾选的类别一共多少文件 */
function countSelected(checked: ReadonlySet<AssetKind>, counts: Record<AssetKind, number>): number {
  let total = 0;
  for (const kind of KIND_ORDER) {
    if (checked.has(kind)) total += counts[kind];
  }
  return total;
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
async function sendDownloadCommand(kinds?: AssetKind[]): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('no-tab');
  const command =
    kinds === undefined || kinds.length === 0
      ? 'download-checked'
      : kinds.length === 1
        ? `download-${kinds[0]}`
        : `download-kinds:${kinds.join(',')}`;
  await chrome.tabs.sendMessage(tab.id, { type: 'ecbox:command', command });
}
