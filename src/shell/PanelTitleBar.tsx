import { ArrowLeft, ChevronRight, Settings } from 'lucide-react';
import { Tooltip } from '../kernel/ui-kit';
import { PlatformLogo } from './PlatformLogo';

/**
 * 面板标题栏（§10.3 ①，40px，不能拖动）。
 *
 * 从 Panel 里拆出来：标题栏只关心「我在哪个平台」和「两个图标按钮该出哪个」，
 * 和面板内容、滚动区、Esc 处理没有关系。
 *
 * - 左上角是平台图标而不是「色点 + 平台名」：用户一眼就知道自己在哪个平台，
 *   图标比两个汉字更省标题栏的宽度（360px 里还要放两个图标按钮）。
 *   没有对应图标时退回色点 + 文字，不至于空一块。
 * - 不写产品名：用户知道自己装的是什么（§10.3 ①）。
 */
export interface PanelTitleBarProps {
  platformName: string;
  /** 平台 id：有图标时优先画图标 */
  platformId?: string;
  platformColor?: string;
  platformRing?: string;
  /** 面板里显示的是设置视图（图标按钮从「设置」变成「返回素材」） */
  settingsVisible: boolean;
  onOpenSettings(): void;
  onCloseSettings(): void;
  onClose(): void;
}

export function PanelTitleBar({
  platformName,
  platformId,
  platformColor,
  platformRing,
  settingsVisible,
  onOpenSettings,
  onCloseSettings,
  onClose,
}: PanelTitleBarProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 40,
        padding: '0 8px 0 16px',
        borderBottom: '1px solid var(--ec-line)',
        flex: 'none',
      }}
    >
      {platformId === undefined ? (
        <>
          {platformColor === undefined ? null : (
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: platformColor,
                ...(platformRing === undefined ? {} : { boxShadow: `0 0 0 1px ${platformRing}` }),
              }}
            />
          )}
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ec-text)' }}>
            {platformName}
          </span>
        </>
      ) : (
        <PlatformLogo platformId={platformId} name={platformName} height={18} />
      )}
      <span style={{ flex: 1 }} />
      {settingsVisible ? (
        <Tooltip content="返回素材">
          <button
            type="button"
            className="ec-icon-btn"
            aria-label="返回素材"
            onClick={onCloseSettings}
          >
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </Tooltip>
      ) : (
        <Tooltip content="设置">
          <button type="button" className="ec-icon-btn" aria-label="设置" onClick={onOpenSettings}>
            <Settings size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      <Tooltip content="收起到边缘 · Alt+Shift+E">
        <button type="button" className="ec-icon-btn" aria-label="收起到边缘" onClick={onClose}>
          <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}
