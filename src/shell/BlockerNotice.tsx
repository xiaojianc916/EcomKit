import type { ErrorCode } from '../kernel/errors/codes';
import { errorMessage } from '../kernel/errors/messages';
import { Button } from '../kernel/ui-kit';

/**
 * 阻断与异常区块（§10.4「阻断和异常」）。
 *
 * 出现时 ② 商品信息区整块被它替换，④⑤⑥ 隐藏 —— 没有商品数据，谈下载没有意义。
 * 布局是「标题 + 一行说明 + 一个主按钮 + 一个次要动作」，不做插画、不做引导浮层（§10.1）。
 */
export type BlockerActionId =
  | 'refresh'
  | 'mobile-mode'
  | 'grant'
  | 'reset-grant'
  | 'retry'
  | 'diagnostics'
  | 'settings'
  | 'rescan';

export interface BlockerNoticeProps {
  code: ErrorCode;
  onAction(action: BlockerActionId): void;
  /**
   * 平台是否支持「以手机模式重新打开」（§7.6.5）。
   * Phase 0 结论：抖音无论如何都只给扫码页，所以 supportsMobileMode=false 时不出这个按钮
   * （docs/phase0/FINDINGS.md 第 1 节）。
   */
  supportsMobileMode?: boolean;
  /** 「页面可能还没加载完」这类说明之后再补一个“重新识别” */
  extraAction?: { id: BlockerActionId; label: string };
}

/** 错误码 → 面板里能点的按钮。文案一律来自 errorMessage（§6.2 不显示异常 message） */
const ACTION_LABEL: Partial<Record<BlockerActionId, string>> = {
  refresh: '刷新页面',
  'mobile-mode': '以手机模式重新打开',
  grant: '选择文件夹',
  'reset-grant': '重新选择文件夹',
  retry: '重试',
  diagnostics: '导出诊断',
  settings: '打开设置',
  rescan: '重新识别',
};

export function BlockerNotice({
  code,
  onAction,
  supportsMobileMode = true,
  extraAction,
}: BlockerNoticeProps) {
  const preset = errorMessage(code);
  const action = preset.action;

  // §10.4：APP_ONLY 时如果平台不支持手机模式（Phase 0 已证否），只提示「在手机上打开」
  const showPrimary =
    action !== undefined && !(action === 'mobile-mode' && supportsMobileMode === false);

  return (
    <div style={{ padding: '12px 16px 16px' }}>
      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: '20px', color: 'var(--ec-text)' }}>
        {preset.title}
      </div>
      {preset.hint === undefined ? null : (
        <div style={{ marginTop: 4, fontSize: 13, lineHeight: '20px', color: 'var(--ec-text-2)' }}>
          {preset.hint}
        </div>
      )}
      {action === 'mobile-mode' && supportsMobileMode === false ? (
        <div style={{ marginTop: 4, fontSize: 13, color: 'var(--ec-text-2)' }}>请在手机上打开</div>
      ) : null}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}
      >
        {showPrimary && action !== undefined ? (
          <Button variant="primary" onClick={() => onAction(action)}>
            {ACTION_LABEL[action] ?? preset.title}
          </Button>
        ) : null}
        {extraAction === undefined ? null : (
          <Button variant="outline" onClick={() => onAction(extraAction.id)}>
            {extraAction.label}
          </Button>
        )}
        {/* PARSE_EMPTY 的主按钮已经是“导出诊断”，这里只在主按钮不是诊断时才补一个 */}
        {code === 'PARSE_EMPTY' && action !== 'diagnostics' ? (
          <Button variant="outline" onClick={() => onAction('diagnostics')}>
            导出诊断
          </Button>
        ) : null}
      </div>
    </div>
  );
}
