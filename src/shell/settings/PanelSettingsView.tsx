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
 * 面板只有 360px 宽，塞不下一栏导航，所以分组做成一行胶囊标签。
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
        一行放得下六个分组：12px 字 + 8px 内边距 + 2px 间隙，最长的「保存位置」56px，
        合计约 320px，落在面板内容宽 328px 之内（换行就会把最后一项挤到第二行）。
      */}
      <div
        role="tablist"
        aria-label="设置分组"
        style={{ display: 'flex', gap: 2, padding: '6px 12px 8px' }}
      >
        {SETTINGS_SECTIONS.map((s) => {
          const active = s.id === section;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={active}
              className="ec-tab"
              onClick={() => setSection(s.id)}
            >
              {s.title}
            </button>
          );
        })}
      </div>

      <div style={{ paddingTop: 4 }}>
        <SettingsSectionView id={section} settings={draft.settings} update={draft.update} />
      </div>
    </div>
  );
}
