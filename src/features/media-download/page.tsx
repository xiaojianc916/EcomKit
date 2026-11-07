import type { AssetKind } from '../../kernel/model/asset';
import type { ProductSnapshot } from '../../kernel/model/product';
import { templateHasId } from '../../kernel/settings/schema';
import { Checkbox } from '../../kernel/ui-kit';
import type { PageApi, PageFeature, PanelProps, QuickAction } from '../types';
import { buildMediaDownloadPayload } from './payload';
import { joinKindLabels } from './primary-action-model';
import { DEFAULT_MEDIA_DOWNLOAD_SETTINGS, type MediaDownloadSettings } from './settings';
import { MediaPanelView } from './ui-panel/media-panel-view';
import { countByKind } from './ui-panel/panel-derived';
import { useMediaPanel } from './ui-panel/use-media-panel';
import { useMediaStore } from './ui-panel/use-media-store';

/**
 * media-download 的面板（§8.6、§10.3）。
 *
 * 这个文件只做「功能注册」：面板入口、把手角标、快捷操作、设置分组。
 * 面板本身拆在 ./ui-panel/ 下：
 * - use-media-panel.ts —— 状态怎么组装（订阅、派生、主按钮模型）
 * - use-media-actions.ts —— 动作怎么发出去（提交、重试、主按钮 action）
 * - media-panel-view.tsx —— 结构怎么画（素材清单 / 保存位置 / 主按钮 / 失败详情）
 * - panel-derived.ts —— 纯换算（计数、SKU 标签、路径预览、错误文案）
 *
 * 所有**规则**仍然在纯函数里（primaryActionModel / assetRowModel / media-store），
 * 这样 §10.4 的每一行都能被单测锁死，而不是靠人肉点界面。
 *
 * 页面侧不下载文件、不碰 chrome.downloads —— 一切通过 PageApi 提交任务（§8.2、§4.1）。
 */

// 平台显示名和设置换算都挪到 ./payload.ts（页面和引擎共用同一份定义），
// 这里重新导出只为兼容既有的调用点和测试。
export { PLATFORM_NAMES, platformDisplayName, toPlannerSettings } from './payload';
// 纯换算拆到 ./ui-panel/panel-derived.ts 后仍然从这里转出：
// page.tsx 是功能的对外入口，调用点和单测都按这个路径取。
export {
  countByKind,
  describeSubmitError,
  previewFolderPath,
  skuLabelMap,
} from './ui-panel/panel-derived';

/**
 * ⑥ 面板入口。
 *
 * 这里只留「接上外壳的 props，挂两个 hook，交给视图」三件事：
 * 任何一条分支、任何一个派生值都不该再长回这个函数 —— 上一版就是长到 400 多行，
 * 读一遍要先在订阅、副作用、布局和文案之间来回跳。
 */
export function MediaDownloadPanel({
  snapshot,
  status,
  settings,
  api,
  // 目录状态和当前任务由外壳查好传下来：§9.4 要求面板挂载时只查一次目录，
  // 每个功能自己再查一次就会多触发一次权限探测。
  dir,
  job: jobFromShell,
  rootPath,
}: PanelProps<MediaDownloadSettings>) {
  const store = useMediaStore(api, settings);
  const panel = useMediaPanel({
    store,
    snapshot,
    status,
    settings,
    api,
    dir,
    jobFromShell,
  });

  return (
    <MediaPanelView
      {...panel.view}
      dir={dir}
      rootPath={rootPath}
      store={store}
      actions={panel.actions}
      onCopy={panel.onCopy}
      {...panel.listHandlers}
    />
  );
}

/** 把手角标（§8.5 handleBadge 插槽）：可下载的素材总数 */
export function mediaBadge(snap: ProductSnapshot): number {
  return snap.assets.length;
}

/**
 * popup 和快捷键用的快捷操作（§8.5 quickActions、§8.6）。
 * 文案遵守 §10.7：动词开头带数量由调用方补（数量在 popup 里按快照算）。
 */
export function mediaQuickActions(snap: ProductSnapshot): QuickAction[] {
  const kinds: AssetKind[] = ['main', 'sku', 'detail', 'video'];
  // 一次遍历替代四次 filter：popup 打开时对每个商品都要算一遍
  const counts = countByKind(snap);
  const countOf = (kind: AssetKind): number => counts[kind];

  // 快捷入口拿不到功能设置，用默认值构造**完整**载荷：同样过一遍共享 schema，
  // 字段不会漏（旧实现就是在这里漏掉了引擎必需的字段）。
  const submitKinds = (api: PageApi, selected: AssetKind[]): void => {
    void api.submitJob(
      'media-download',
      buildMediaDownloadPayload({
        snapshot: snap,
        selection: { kinds: selected },
        settings: DEFAULT_MEDIA_DOWNLOAD_SETTINGS,
      }),
      { dedupeKey: `${snap.platform}:${snap.productId}`, label: `下载 ${snap.title}` },
    );
  };

  const actions: QuickAction[] = [
    {
      id: 'media-download.all',
      title: `下载全部 ${snap.assets.length} 个素材`,
      run: (api) => submitKinds(api, kinds),
    },
  ];

  for (const kind of kinds) {
    const count = countOf(kind);
    if (count === 0) continue;
    actions.push({
      id: `media-download.${kind}`,
      title: `下载${joinKindLabels([kind])} ${count} 个`,
      run: (api) => submitKinds(api, [kind]),
    });
  }
  return actions;
}

/** 设置页分组（§10.8 文件命名 + 素材两组里属于这个功能的部分） */
export function MediaDownloadSettingsSection({
  value,
  onChange,
}: {
  value: MediaDownloadSettings;
  onChange(next: MediaDownloadSettings): void;
}) {
  const patch = (part: Partial<MediaDownloadSettings>): void => onChange({ ...value, ...part });

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/*
        这一组表单的样式**必须和设置页其它分组完全一致**：一律用 ui-kit 的
        ec-field / ec-input / ec-checkbox，不写任何内联边框和内边距。
        旧实现自己画了一套 1px 灰框的 input，和上下几组的控件长得不一样。
      */}
      <div className="ec-field">
        {/*
          标题用 aria-labelledby 关联到输入框，而不是把标题改写成 <label> 再包住输入框：
          视觉上一模一样（标题一行、输入框一行），但读屏器念到输入框时
          会读「商品文件夹模板」而不是干巴巴一句「文本框」。
        */}
        <span className="ec-field__label" id="media-folder-template-label">
          商品文件夹模板
        </span>
        <input
          className="ec-input"
          type="text"
          aria-labelledby="media-folder-template-label"
          value={value.folderTemplate}
          onChange={(e) => patch({ folderTemplate: e.target.value })}
        />
        {/* 模板必须含 {id}（ADR-6），缺少时立刻报错，不要让用户存下一个定位不到的模板 */}
        {templateHasId(value.folderTemplate) ? null : (
          <span className="ec-field__error">模板缺少 {'{id}'}，无法按商品 ID 定位文件夹</span>
        )}
        <span className="ec-field__hint">
          可用变量：{'{platform} {shop:N} {title:N} {id} {date}'}
        </span>
      </div>

      <div className="ec-field">
        <span className="ec-field__label">子文件夹名称</span>
        {(['main', 'sku', 'detail', 'video'] as const).map((kind) => (
          <label
            key={kind}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', marginTop: 4 }}
          >
            <span style={{ width: 60, flex: 'none', color: 'var(--ec-text-2)' }}>
              {kindNameOf(kind)}
            </span>
            <input
              className="ec-input"
              type="text"
              value={value.dirNames[kind]}
              onChange={(e) => patch({ dirNames: { ...value.dirNames, [kind]: e.target.value } })}
            />
          </label>
        ))}
      </div>

      <div className="ec-field">
        <span className="ec-field__label">转换</span>
        <CheckLine
          label="WebP、AVIF 转成 JPG"
          checked={value.toJpeg}
          onChange={(checked) => patch({ toJpeg: checked })}
        />
        <CheckLine
          label="同时下载视频封面"
          checked={value.videoCover}
          onChange={(checked) => patch({ videoCover: checked })}
        />
      </div>

      <div className="ec-field">
        {/* 同上：标题通过 aria-labelledby 关联，数字框才有可访问名字 */}
        <span className="ec-field__label" id="media-detail-min-width-label">
          详情图最小宽度
        </span>
        {/* 左对齐贴着上方的标题：整行居中会把 96px 的输入框挤到面板中线附近 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            className="ec-input"
            type="number"
            min={0}
            aria-labelledby="media-detail-min-width-label"
            // flex:none 让这个定宽输入框不被这一行拉伸，96px 就是它最终的宽度
            style={{ width: 96, flex: 'none' }}
            value={value.detailMinWidth}
            onChange={(e) => patch({ detailMinWidth: Number(e.target.value) || 0 })}
          />
          <span className="ec-field__hint">px</span>
        </div>
        <span className="ec-field__hint">窄于这个宽度的详情图不会下载，0 表示不限制。</span>
      </div>
    </div>
  );
}

function kindNameOf(kind: AssetKind): string {
  return { main: '主图', sku: 'SKU 图', detail: '详情图', video: '视频' }[kind];
}

const mediaDownloadPage: PageFeature<MediaDownloadSettings> = {
  Panel: MediaDownloadPanel,
  badge: mediaBadge,
  quickActions: mediaQuickActions,
  SettingsSection: MediaDownloadSettingsSection,
};

export default mediaDownloadPage;

/**
 * 一行「复选框 + 文字」，整行可点。
 *
 * 为什么不用 <label>：Radix 的 Checkbox 渲染的是 <button role="checkbox">，
 * <label> 关联不到它（点文字不会切换，biome 也会报 noLabelWithoutControl）。
 * 这里把文字交给 Checkbox 自己的可访问名字，再用一个真 <button> 承担点击 ——
 * 键盘用户 Tab 到复选框，鼠标用户点哪儿都行。
 */
function CheckLine({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
      <Checkbox label={label} checked={checked} onCheckedChange={onChange} />
      <button
        type="button"
        onClick={() => onChange(!checked)}
        style={{
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: 'var(--ec-text)',
          fontFamily: 'inherit',
          fontSize: 'var(--ec-fs-13)',
          lineHeight: '20px',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
    </div>
  );
}
