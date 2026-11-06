import { useState } from 'react';
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  SettingsSectionView,
  useSettingsDraft,
} from './sections';

/**
 * 工具箱面板里的**设置视图**（§10.3）：点标题栏 ⚙ 原地切过来的那一屏。
 *
 * 它和设置页（options）不是两套设置：表单本身来自 ./sections，两边共用，
 * 所以「面板里能改的」和「设置页里能改的」永远一致。区别只有骨架 ——
 * 面板只有 360px 宽，塞不下一栏导航，所以分组做成一行文字标签（和功能标签同一套外观）。
 *
 * 外观全部走 var(--ec-*)/ec-* 类，和素材清单同一套字号、圆角、分隔线；
 * 不用 options.css 那套大行距排版，否则一屏只能放下两个设置项。
 */
export function PanelSettingsView() {
  const [section, setSection] = useState<SettingsSectionId>('save');
  const draft = useSettingsDraft();

  return (
    <div>
      {/*
        一行放得下六个分组：12px 字 + 6px 内边距，最长的「保存位置」48px，
        合计约 296px，落在面板内容宽 328px 之内（换行就会把最后一项挤到第二行）。
      */}
      <div
        role="tablist"
        aria-label="设置分组"
        style={{
          display: 'flex',
          gap: 4,
          padding: '0 12px',
          borderBottom: '1px solid var(--ec-line)',
        }}
      >
        {SETTINGS_SECTIONS.map((s) => {
          const active = s.id === section;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSection(s.id)}
              style={{
                height: 32,
                padding: '0 6px',
                border: 'none',
                borderBottom: active ? '2px solid var(--ec-accent)' : '2px solid transparent',
                background: 'transparent',
                color: active ? 'var(--ec-text)' : 'var(--ec-text-2)',
                fontFamily: 'inherit',
                fontSize: 12,
                fontWeight: active ? 600 : 400,
                whiteSpace: 'nowrap',
                cursor: 'pointer',
              }}
            >
              {s.title}
            </button>
          );
        })}
      </div>

      {/* 分组之间用间距分开即可：再插一条分隔线会和标签条的下边框叠成两条 */}
      <div style={{ paddingTop: 12 }}>
        <SettingsSectionView id={section} settings={draft.settings} update={draft.update} />
      </div>
    </div>
  );
}
