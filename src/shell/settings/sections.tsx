import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_MEDIA_DOWNLOAD_SETTINGS,
  MediaDownloadSettings,
} from '../../features/media-download/settings';
import { pageFeatures } from '../../features/registry.page';
import { sendMessage } from '../../kernel/messaging/runtime';
import type { GlobalSettings } from '../../kernel/settings/schema';
import { templateHasId } from '../../kernel/settings/schema';
import { featureSettings, getSettings, setSettings } from '../../kernel/settings/store';
import { Select } from '../../kernel/ui-kit';

/**
 * 设置分组的内容（方案 §10.8、§11）。
 *
 * 这里**只有表单本身**，不含任何「页面骨架」：设置页（options）用左侧导航 + 内容区渲染它，
 * 工具箱面板用「面板内视图」渲染同一批组件（§10.3）。两份入口共用一套表单，
 * 所以「面板里能改的设置」和「设置页里能改的设置」永远不会漂移。
 *
 * 样式一律走 ui-kit 的 ec-* 类和 var(--ec-*) 令牌：面板在 Shadow DOM 里，
 * 拿不到 options.css 的类；把外观统一到令牌上，两处看起来才是同一个产品。
 */
export type SettingsSectionId = 'save' | 'naming' | 'media' | 'shell' | 'advanced' | 'about';

/** v1 只有这一个功能：命名等设置都挂在它下面 */
export const MEDIA_FEATURE_ID = 'media-download';

/** 设置写入的防抖间隔。输入框每敲一个字都写一次 chrome.storage 会明显掉帧 */
const SAVE_DEBOUNCE_MS = 300;

export const SETTINGS_SECTIONS: readonly { id: SettingsSectionId; title: string }[] = [
  { id: 'save', title: '保存位置' },
  { id: 'naming', title: '文件命名' },
  { id: 'media', title: '素材' },
  { id: 'shell', title: '工具箱' },
  { id: 'advanced', title: '高级' },
  { id: 'about', title: '关于' },
];

const SAVE_MODE_OPTIONS = [
  { value: 'fsa', label: '自选文件夹（推荐）' },
  { value: 'downloads', label: '浏览器下载目录' },
] as const;

const AUTO_OPEN_OPTIONS = [
  { value: 'panel', label: '展开面板' },
  { value: 'handle', label: '只显示把手' },
  { value: 'hidden', label: '不显示' },
] as const;

const THEME_OPTIONS = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
] as const;

export interface SettingsDraft {
  /** 还没读回来时为 null */
  settings: GlobalSettings | null;
  /** 界面立刻更新，落盘防抖 */
  update(patch: Partial<GlobalSettings>): void;
}

/**
 * 全局设置的本地草稿 + 防抖落盘（设置页和面板设置视图共用）。
 *
 * 旧实现（只在设置页里）每敲一个字符就 `await setSettings(...)`，而它在写之前会先做一次
 * 全量 Zod 解析 + chrome.storage 往返；在「根目录绝对路径」这种长输入框里表现为明显的输入延迟。
 * 这里把**状态更新**（同步）和**落盘**（防抖）拆开。
 */
export function useSettingsDraft(): SettingsDraft {
  const [settings, setLocal] = useState<GlobalSettings | null>(null);
  /** 最新一次待写入的设置（防抖窗口内以它为准，避免用旧闭包覆盖新值） */
  const pendingSave = useRef<GlobalSettings | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void getSettings().then(setLocal);
  }, []);

  // 卸载前把最后一次改动落盘，用户改完立刻切走也不会丢
  useEffect(() => {
    return () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      const pending = pendingSave.current;
      pendingSave.current = null;
      if (pending !== null) void setSettings(pending).catch(() => {});
    };
  }, []);

  const update = useCallback((patch: Partial<GlobalSettings>) => {
    setLocal((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      pendingSave.current = next;
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        const value = pendingSave.current;
        pendingSave.current = null;
        if (value !== null) void setSettings(value).catch(() => {});
      }, SAVE_DEBOUNCE_MS);
      return next;
    });
  }, []);

  return { settings, update };
}

/** 一个分组的表单（不含标题）：两个入口按各自的骨架套标题 */
export function SettingsSectionView({
  id,
  settings,
  update,
}: SettingsDraft & { id: SettingsSectionId }) {
  if (settings === null) {
    return <p className="ec-field__hint">正在读取设置…</p>;
  }
  switch (id) {
    case 'save':
      return <SaveSection settings={settings} update={update} />;
    case 'naming':
      return <NamingSection />;
    case 'media':
      return <MediaSection />;
    case 'shell':
      return <ShellSection settings={settings} update={update} />;
    case 'advanced':
      return <AdvancedSection settings={settings} update={update} />;
    case 'about':
      return <AboutSection />;
  }
}

/* ---------------- 各分组 ---------------- */

function SaveSection({
  settings,
  update,
}: {
  settings: GlobalSettings;
  update: SettingsDraft['update'];
}) {
  return (
    <>
      <div className="ec-field">
        <span className="ec-field__label">保存方式</span>
        <Select
          label="保存方式"
          value={settings.save.mode}
          options={SAVE_MODE_OPTIONS}
          onChange={(mode) =>
            update({ save: { ...settings.save, mode: mode as 'fsa' | 'downloads' } })
          }
        />
        <span className="ec-field__hint">
          选「浏览器下载目录」时，请关闭浏览器的「下载前询问每个文件的保存位置」，否则每个文件都会弹一次对话框。
        </span>
      </div>

      <div className="ec-field">
        <span className="ec-field__label">根目录绝对路径（可选）</span>
        <input
          className="ec-input"
          placeholder="D:\电商素材"
          value={settings.save.rootPath}
          onChange={(e) => update({ save: { ...settings.save, rootPath: e.target.value } })}
        />
        <span className="ec-field__hint">
          浏览器只能拿到文件夹名字，填了绝对路径才能复制出可以直接粘贴到资源管理器的完整路径。
        </span>
      </div>
    </>
  );
}

function NamingSection() {
  // 命名设置属于 media-download 功能，存在 feature:media-download 下；
  // 这里是**同一个**模板的读写入口（旧实现是写死的本地 state，用户在设置页改模板
  // 既不落盘也不影响下载，等于一个假的设置项）。
  const [template, setTemplate] = useState('');
  const valid = useMemo(() => templateHasId(template), [template]);
  const preview = useMemo(() => renderPreview(template), [template]);

  useEffect(() => {
    let alive = true;
    void featureSettings({
      featureId: MEDIA_FEATURE_ID,
      schema: MediaDownloadSettings,
      defaults: DEFAULT_MEDIA_DOWNLOAD_SETTINGS,
    })
      .get()
      .then((value) => {
        if (alive) setTemplate(value.folderTemplate);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const onChange = (next: string): void => {
    setTemplate(next);
    // 非法模板不落盘：模板缺 {id} 时下载会全部退化成模板路径，宁可不保存也不要存个坏值
    if (!templateHasId(next)) return;
    void featureSettings({
      featureId: MEDIA_FEATURE_ID,
      schema: MediaDownloadSettings,
      defaults: DEFAULT_MEDIA_DOWNLOAD_SETTINGS,
    })
      .update((current) => ({ ...current, folderTemplate: next }))
      .catch(() => {});
  };

  return (
    <>
      <div className="ec-field">
        <span className="ec-field__label">商品文件夹模板</span>
        <input className="ec-input" value={template} onChange={(e) => onChange(e.target.value)} />
        {valid ? null : (
          <span style={{ fontSize: 12, color: 'var(--ec-danger)' }}>
            模板缺少 {'{id}'}，无法按商品 ID 定位文件夹
          </span>
        )}
        <span className="ec-field__hint">
          可用变量：{'{platform} {shop:N} {title:N} {id} {date}'}
        </span>
      </div>
      <div className="ec-field">
        <span className="ec-field__label">预览</span>
        <div className="ec-preview">{preview}</div>
      </div>
    </>
  );
}

/**
 * 「素材」分组：直接渲染功能自己的 SettingsSection（§8.5 插槽）。
 *
 * 旧实现这里只有一段说明文字，`PageFeature.SettingsSection` 全仓库无人使用 ——
 * 于是「转 JPG / 视频封面 / 详情图最小宽度 / 子文件夹名」
 * 这些设置项**在界面上根本没有入口**，用户只能接受默认值。
 */
function MediaSection() {
  type SectionProps = {
    value: MediaDownloadSettings;
    onChange(next: MediaDownloadSettings): void;
  };
  const [Section, setSection] = useState<ComponentType<SectionProps> | null>(null);
  const [value, setValue] = useState<MediaDownloadSettings>(DEFAULT_MEDIA_DOWNLOAD_SETTINGS);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const feature = pageFeatures.find((f) => f.manifest.id === MEDIA_FEATURE_ID);
      if (!feature?.page) return;
      const mod = await feature.page.load();
      if (alive && mod.default.SettingsSection) {
        setSection(() => mod.default.SettingsSection as ComponentType<SectionProps>);
      }
      const current = await featureSettings({
        featureId: MEDIA_FEATURE_ID,
        schema: MediaDownloadSettings,
        defaults: DEFAULT_MEDIA_DOWNLOAD_SETTINGS,
      }).get();
      if (alive) setValue(current);
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const onChange = (next: MediaDownloadSettings): void => {
    setValue(next);
    void featureSettings({
      featureId: MEDIA_FEATURE_ID,
      schema: MediaDownloadSettings,
      defaults: DEFAULT_MEDIA_DOWNLOAD_SETTINGS,
    })
      .set(next)
      .then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <>
      {Section === null ? (
        <p className="ec-field__hint">正在读取素材设置…</p>
      ) : (
        <div className="ec-field">
          <Section value={value} onChange={onChange} />
        </div>
      )}
      {saved ? <p className="ec-field__hint">已保存</p> : null}
    </>
  );
}

function ShellSection({
  settings,
  update,
}: {
  settings: GlobalSettings;
  update: SettingsDraft['update'];
}) {
  return (
    <>
      <div className="ec-field">
        <span className="ec-field__label">进入商品页时</span>
        <Select
          label="进入商品页时"
          value={settings.shell.autoOpen}
          options={AUTO_OPEN_OPTIONS}
          onChange={(autoOpen) =>
            update({
              shell: {
                ...settings.shell,
                autoOpen: autoOpen as 'panel' | 'handle' | 'hidden',
              },
            })
          }
        />
      </div>
      <div className="ec-field">
        <span className="ec-field__label">主题</span>
        <Select
          label="主题"
          value={settings.shell.theme}
          options={THEME_OPTIONS}
          onChange={(theme) =>
            update({
              shell: { ...settings.shell, theme: theme as 'system' | 'light' | 'dark' },
            })
          }
        />
      </div>
    </>
  );
}

function AdvancedSection({
  settings,
  update,
}: {
  settings: GlobalSettings;
  update: SettingsDraft['update'];
}) {
  return (
    <>
      <div className="ec-field">
        <span className="ec-field__label">并发数</span>
        <input
          className="ec-input"
          type="number"
          min={1}
          max={8}
          value={settings.jobs.concurrency}
          onChange={(e) => {
            const n = Math.max(1, Math.min(8, Number(e.target.value) || 6));
            update({ jobs: { concurrency: n } });
          }}
        />
        <span className="ec-field__hint">同时下载的文件数，1 到 8，默认 6。</span>
      </div>
      <div className="ec-field">
        <span className="ec-field__label">诊断</span>
        <button
          type="button"
          className="ec-btn"
          onClick={() => {
            void exportDiagnosticsFile();
          }}
        >
          导出诊断文件
        </button>
        <span className="ec-field__hint">
          识别不出来或下载失败时导出这个文件回传。里面只有日志、任务状态和结构骨架， 不含
          Cookie、完整链接和商品内容。
        </span>
      </div>
    </>
  );
}

/** 导出诊断包（§6.7）。后台组装 JSON，这里落成文件。 */
export async function exportDiagnosticsFile(): Promise<void> {
  try {
    const res = (await sendMessage('shell.diagnostics')) as { json?: string } | undefined;
    if (!res?.json) return;
    const blob = new Blob([res.json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ecbox-diagnostics-${stamp}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    // 导出失败不阻塞设置界面
  }
}

function AboutSection() {
  return (
    <>
      <div className="ec-field">
        <span className="ec-field__label">版本</span>
        <span className="ec-field__value">{chrome.runtime.getManifest().version}</span>
      </div>
      <div className="ec-field">
        <span className="ec-field__label">快捷键</span>
        <span className="ec-field__hint">
          Alt+Shift+E 展开或收起工具箱　·　Alt+Shift+D 下载勾选的素材
        </span>
        <span className="ec-field__hint">
          可在 chrome://extensions/shortcuts 或 edge://extensions/shortcuts 修改。
        </span>
      </div>
    </>
  );
}

/**
 * 模板预览用示例商品（§10.8：模板下面用示例商品实时预览完整路径）。
 *
 * 根目录下直接就是商品文件夹，外面**没有平台层** —— 默认模板
 * `{platform}_商品ID_{id}` 已经把平台写进文件夹名里了，预览再套一层「拼多多 ･」
 * 会让用户以为实际会多建一级目录。
 */
function renderPreview(template: string): string {
  const sample: Record<string, string> = {
    platform: '拼多多',
    shop: '示例店铺',
    title: '夏季新款显瘦连衣裙女小个子法式复古方领泡泡袖碎花裙',
    id: '482319937501',
    date: new Date().toISOString().slice(0, 10),
  };
  const folder = template.replace(/\{(\w+)(?::(\d+))?\}/g, (_m, key: string, len?: string) => {
    const v = sample[key] ?? `{${key}}`;
    return len
      ? Array.from(new Intl.Segmenter().segment(v), (s) => s.segment)
          .slice(0, Number(len))
          .join('')
      : v;
  });
  return `电商素材 ･ ${folder}`;
}
