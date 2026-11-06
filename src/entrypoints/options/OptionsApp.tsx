import { useState } from 'react';
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  SettingsSectionView,
  useSettingsDraft,
} from '../../shell/settings/sections';

/**
 * 设置页（方案 §10.8、§11）：左侧导航 + 内容区最大 720px。
 *
 * 六个分组：保存位置 / 文件命名 / 素材 / 工具箱 / 高级 / 关于。
 * **表单本身在 shell/settings/sections.tsx**，和工具箱面板里的设置视图共用 ——
 * 这里只负责这个独立页面才有的骨架（左侧导航、页标题、整页排版）。
 */
export function OptionsApp() {
  const [section, setSection] = useState<SettingsSectionId>('save');
  const draft = useSettingsDraft();
  const current = SETTINGS_SECTIONS.find((s) => s.id === section);

  return (
    <div className="opt">
      <nav className="opt__nav">
        <div className="opt__brand">电商素材工具箱</div>
        {SETTINGS_SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="opt__nav-item"
            aria-current={section === s.id}
            onClick={() => setSection(s.id)}
          >
            {s.title}
          </button>
        ))}
      </nav>
      <main className="opt__main">
        <h1 className="opt__h">{current?.title ?? ''}</h1>
        {draft.settings === null ? (
          <p className="opt__desc">正在读取设置…</p>
        ) : (
          <SettingsSectionView id={section} settings={draft.settings} update={draft.update} />
        )}
      </main>
    </div>
  );
}
