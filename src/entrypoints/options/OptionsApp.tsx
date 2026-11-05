import { type ComponentType, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_MEDIA_DOWNLOAD_SETTINGS,
  MediaDownloadSettings,
} from '../../features/media-download/settings';
import { pageFeatures } from '../../features/registry.page';
import { sendMessage } from '../../kernel/messaging/runtime';
import type { GlobalSettings } from '../../kernel/settings/schema';
import { templateHasId } from '../../kernel/settings/schema';
import { featureSettings, getSettings, setSettings } from '../../kernel/settings/store';

/**
 * 设置页（方案 §10.8、§11）：左侧导航 + 内容区最大 720px。
 *
 * 六个分组：保存位置 / 文件命名 / 素材 / 工具箱 / 高级 / 关于。
 * 设置读写一律走 kernel 的 settings/store（它内部做 schema 校验和默认值补齐）。
 */
type Section = 'save' | 'naming' | 'media' | 'shell' | 'advanced' | 'about';

const SECTIONS: { id: Section; title: string }[] = [
  { id: 'save', title: '保存位置' },
  { id: 'naming', title: '文件命名' },
  { id: 'media', title: '素材' },
  { id: 'shell', title: '工具箱' },
  { id: 'advanced', title: '高级' },
  { id: 'about', title: '关于' },
];

export function OptionsApp() {
  const [section, setSection] = useState<Section>('save');
  const [settings, setLocal] = useState<GlobalSettings | null>(null);

  useEffect(() => {
    void getSettings().then(setLocal);
  }, []);

  const update = async (patch: Partial<GlobalSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setLocal(next);
    await setSettings(next);
  };

  if (!settings) {
    return (
      <div className="opt">
        <main className="opt__main">
          <p className="opt__desc">正在读取设置…</p>
        </main>
      </div>
    );
  }

  return (
    <div className="opt">
      <nav className="opt__nav">
        <div className="opt__brand">电商素材工具箱</div>
        {SECTIONS.map((s) => (
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
        {section === 'save' && <SaveSection settings={settings} update={update} />}
        {section === 'naming' && <NamingSection />}
        {section === 'media' && <MediaSection />}
        {section === 'shell' && <ShellSection settings={settings} update={update} />}
        {section === 'advanced' && <AdvancedSection settings={settings} update={update} />}
        {section === 'about' && <AboutSection />}
      </main>
    </div>
  );
}

/* ---------------- 各分组 ---------------- */

function SaveSection({
  settings,
  update,
}: {
  settings: GlobalSettings;
  update: (p: Partial<GlobalSettings>) => void;
}) {
  return (
    <>
      <h1 className="opt__h">保存位置</h1>
      <p className="opt__desc">素材会按「平台 / 商品 / 类别」归档到你选择的文件夹。</p>

      <div className="opt__field">
        <span className="opt__label">保存方式</span>
        <select
          className="opt__select"
          value={settings.save.mode}
          onChange={(e) =>
            update({ save: { ...settings.save, mode: e.target.value as 'fsa' | 'downloads' } })
          }
        >
          <option value="fsa">自选文件夹（推荐）</option>
          <option value="downloads">浏览器下载目录</option>
        </select>
        <span className="opt__hint">
          选「浏览器下载目录」时，请关闭浏览器的「下载前询问每个文件的保存位置」，否则每个文件都会弹一次对话框。
        </span>
      </div>

      <div className="opt__field">
        <span className="opt__label">根目录绝对路径（可选）</span>
        <input
          className="opt__input"
          placeholder="D:\\电商素材"
          value={settings.save.rootPath}
          onChange={(e) => update({ save: { ...settings.save, rootPath: e.target.value } })}
        />
        <span className="opt__hint">
          浏览器只能拿到文件夹名字，填了绝对路径才能复制出可以直接粘贴到资源管理器的完整路径。
        </span>
      </div>
    </>
  );
}

function NamingSection() {
  // 命名设置属于 media-download 功能，存在 feature:media-download 下；
  // 这里给实时预览，规则本身由功能模块负责（§9.1）
  const [template, setTemplate] = useState('{title:30}_{id}');
  const valid = useMemo(() => templateHasId(template), [template]);
  const preview = useMemo(() => renderPreview(template), [template]);

  return (
    <>
      <h1 className="opt__h">文件命名</h1>
      <p className="opt__desc">商品文件夹名由模板生成，模板里必须包含 {'{id}'}。</p>
      <div className="opt__field">
        <span className="opt__label">商品文件夹模板</span>
        <input
          className="opt__input"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
        />
        {valid ? null : (
          <span className="opt__err">模板缺少 {'{id}'}，无法按商品 ID 定位文件夹</span>
        )}
        <span className="opt__hint">可用变量：{'{platform} {shop:N} {title:N} {id} {date}'}</span>
      </div>
      <div className="opt__field">
        <span className="opt__label">预览</span>
        <div className="opt__preview">{preview}</div>
      </div>
    </>
  );
}

/**
 * 「素材」分组：直接渲染功能自己的 SettingsSection（§8.5 插槽）。
 *
 * 旧实现这里只有一段说明文字，`PageFeature.SettingsSection` 全仓库无人使用 ——
 * 于是「转 JPG / 生成商品信息.txt / 视频封面 / 详情图最小宽度 / 子文件夹名」
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
      const feature = pageFeatures.find((f) => f.manifest.id === 'media-download');
      if (!feature?.page) return;
      const mod = await feature.page.load();
      if (alive && mod.default.SettingsSection) {
        setSection(() => mod.default.SettingsSection as ComponentType<SectionProps>);
      }
      const current = await featureSettings({
        featureId: 'media-download',
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
      featureId: 'media-download',
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
      <h1 className="opt__h">素材</h1>
      <p className="opt__desc">这些设置针对「素材下载」功能，改动立即生效。</p>
      {Section === null ? (
        <p className="opt__desc">正在读取素材设置…</p>
      ) : (
        <Section value={value} onChange={onChange} />
      )}
      {saved ? <p className="opt__hint">已保存</p> : null}
    </>
  );
}

function ShellSection({
  settings,
  update,
}: {
  settings: GlobalSettings;
  update: (p: Partial<GlobalSettings>) => void;
}) {
  return (
    <>
      <h1 className="opt__h">工具箱</h1>
      <p className="opt__desc">控制进入商品页时的行为。</p>
      <div className="opt__field">
        <span className="opt__label">进入商品页时</span>
        <select
          className="opt__select"
          value={settings.shell.autoOpen}
          onChange={(e) =>
            update({
              shell: {
                ...settings.shell,
                autoOpen: e.target.value as 'panel' | 'handle' | 'hidden',
              },
            })
          }
        >
          <option value="panel">展开面板</option>
          <option value="handle">只显示把手</option>
          <option value="hidden">不显示</option>
        </select>
      </div>
      <div className="opt__field">
        <span className="opt__label">主题</span>
        <select
          className="opt__select"
          value={settings.shell.theme}
          onChange={(e) =>
            update({
              shell: { ...settings.shell, theme: e.target.value as 'system' | 'light' | 'dark' },
            })
          }
        >
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </div>
    </>
  );
}

function AdvancedSection({
  settings,
  update,
}: {
  settings: GlobalSettings;
  update: (p: Partial<GlobalSettings>) => void;
}) {
  return (
    <>
      <h1 className="opt__h">高级</h1>
      <p className="opt__desc">一般不需要改。</p>
      <div className="opt__field">
        <span className="opt__label">并发数</span>
        <input
          className="opt__input"
          type="number"
          min={1}
          max={8}
          value={settings.jobs.concurrency}
          onChange={(e) => {
            const n = Math.max(1, Math.min(8, Number(e.target.value) || 6));
            update({ jobs: { concurrency: n } });
          }}
        />
        <span className="opt__hint">同时下载的文件数，1 到 8，默认 6。</span>
      </div>
      <div className="opt__field">
        <span className="opt__label">诊断</span>
        <button
          type="button"
          className="opt__select"
          onClick={() => {
            void exportDiagnostics();
          }}
        >
          导出诊断文件
        </button>
        <span className="opt__hint">
          识别不出来或下载失败时导出这个文件回传。里面只有日志、任务状态和结构骨架， 不含
          Cookie、完整链接和商品内容。
        </span>
      </div>
      <div className="opt__check" style={{ cursor: 'default' }}>
        <span className="opt__hint">
          提示：保存方式、根目录、文件命名、素材选项都在左侧对应分组里，改动立即生效。
        </span>
      </div>
    </>
  );
}

/** 导出诊断包（§6.7）。后台组装 JSON，这里落成文件。 */
async function exportDiagnostics(): Promise<void> {
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
    // 导出失败不阻塞设置页
  }
}

function AboutSection() {
  return (
    <>
      <h1 className="opt__h">关于</h1>
      <p className="opt__desc">电商素材工具箱，内部使用。</p>
      <div className="opt__field">
        <span className="opt__label">版本</span>
        <span className="opt__hint">{chrome.runtime.getManifest().version}</span>
      </div>
      <div className="opt__field">
        <span className="opt__label">快捷键</span>
        <span className="opt__hint">
          Alt+Shift+E 展开或收起工具箱　·　Alt+Shift+D 下载勾选的素材
        </span>
        <span className="opt__hint">
          可在 chrome://extensions/shortcuts 或 edge://extensions/shortcuts 修改。
        </span>
      </div>
    </>
  );
}

/** 模板预览用示例商品（§10.8：模板下面用示例商品实时预览完整路径） */
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
  return `电商素材 ･ 拼多多 ･ ${folder}`;
}
