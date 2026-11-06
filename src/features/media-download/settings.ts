import { z } from 'zod';
import { AssetKind } from '../../kernel/model/asset';

/**
 * media-download 的设置项（方案 §11 中 `feature:media-download.*`）。
 *
 * 为什么单独一个文件、而不是直接写在 manifest.ts 里：
 * manifest.ts 必须是纯数据模块（CONTRIBUTING「重要」一节），只能 import type，
 * 因为构建期的 Node 脚本要直接 load 它来生成 matches / commands；
 * 而 zod 是运行时依赖。这里把 schema 和默认值放在这个运行时模块，
 * manifest.ts 只引用它的**值**（见该文件的说明），页面、设置页、内核 store 共用同一份定义，
 * 保证「默认值」只有一处。
 */

export const DirNames = z.object({
  main: z.string().min(1).default('主图'),
  sku: z.string().min(1).default('SKU图'),
  detail: z.string().min(1).default('详情图'),
  video: z.string().min(1).default('视频'),
});
export type DirNames = z.infer<typeof DirNames>;

/** 同名文件处理（§9.11）：默认另存为「名称 (2)」 */
export const OnConflict = z.enum(['rename', 'overwrite', 'skip']);
export type OnConflict = z.infer<typeof OnConflict>;

export const MediaDownloadSettings = z.object({
  /**
   * 商品文件夹模板，必须含 {id}（ADR-6），设置页强制校验。
   * 默认 `{platform}_商品ID_{id}`：文件夹名直接带平台和商品 ID，
   * 所以外面**不再套平台目录**，根目录下就是「拼多多_商品ID_1019084314929」。
   */
  folderTemplate: z.string().min(1).default('{platform}_商品ID_{id}'),
  /**
   * 子文件夹名必须互不相同（大小写不敏感，Windows 就是这样）。
   * 主图和详情图都叫「图片」时，两类文件会在同一个目录里互相让路，
   * 出现 主图01.jpg / 主图01 (2).jpg 这种谁也认不出来的结果。
   */
  dirNames: DirNames.prefault({}).superRefine((value, ctx) => {
    const seen = new Map<string, string>();
    for (const [kind, name] of Object.entries(value)) {
      const key = name.trim().toLowerCase();
      const prev = seen.get(key);
      if (prev !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [kind],
          message: `子文件夹名称重复：「${name}」和「${prev}」用的同一个名字`,
        });
        continue;
      }
      seen.set(key, name);
    }
  }),
  onConflict: OnConflict.default('rename'),
  /** 默认勾选的类别，全局偏好（§10.3 素材行交互：勾选状态跨商品记住） */
  checkedKinds: z.array(AssetKind).default(['main', 'sku', 'detail', 'video']),
  /** WebP / AVIF 转 JPG（§9.8） */
  toJpeg: z.boolean().default(true),
  /** 同时下载视频封面（§9.9） */
  videoCover: z.boolean().default(false),
  /** 详情图最小宽度，低于它的详情图不下载（§11「素材」组） */
  detailMinWidth: z.number().int().min(0).default(200),
});
export type MediaDownloadSettings = z.infer<typeof MediaDownloadSettings>;

export const DEFAULT_MEDIA_DOWNLOAD_SETTINGS: MediaDownloadSettings = MediaDownloadSettings.parse(
  {},
);

/** 读取一律走 parse，缺失字段补默认值（和 kernel/settings 的约定一致） */
export function parseMediaDownloadSettings(raw: unknown): MediaDownloadSettings {
  return MediaDownloadSettings.parse(raw ?? {});
}

/**
 * 给 registry 用的 `FeatureManifest.settings` 片段。
 *
 * 为什么从 manifest.ts 挪到这里：manifest.ts 必须能被 Node 直接加载（纯数据），
 * 而 zod schema 是运行时对象。registry.page.ts 收集功能时把这一片段贴回 manifest，
 * 于是外壳拿到的 FeatureManifest 仍然是完整的，各处默认值也仍然只有一处。
 */
export const mediaDownloadFeatureSettings = {
  schema: MediaDownloadSettings,
  defaults: DEFAULT_MEDIA_DOWNLOAD_SETTINGS,
};

/**
 * 也做成 default 导出：features/registry.*.ts 按约定用 import.meta.glob
 * 收集同目录的 settings.ts，然后取 .default 贴回 manifest 的 settings 字段。
 */
export default mediaDownloadFeatureSettings;
