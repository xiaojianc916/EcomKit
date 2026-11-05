import type { FeatureManifest } from '../types';

/**
 * media-download 的清单（§8.1、§8.6、§11）。
 *
 * **纯数据模块**：整个文件只有 type-only import 和字面量，没有任何运行时依赖，
 * 因为 `scripts/gen-registries.ts` 用 Node 的 TypeScript 剥离模式直接 import 它来生成
 * matches / host_permissions / commands（CONTRIBUTING「重要」一节）。
 *
 * 设置项 schema 是 zod 对象，只能在运行时构造，所以它不在本文件里，
 * 而是在 `./settings.ts`；`registry.page.ts` 会在收集时把它贴回来。
 * 这样 manifest 的其余字段（id/title/icon/order/requires/commands）
 * 仍然是「一份数据、构建脚本和运行时两处一致」。
 */
const manifest = {
  id: 'media-download',
  title: '素材下载',
  icon: 'download',
  order: 10,
  // 媒体下载需要商品基本信息；具体有哪几类素材由 §8.4 的「数量为 0 也显示这一行」处理
  requires: ['product.basic'],
  commands: [
    // 主按钮的快捷键（§10.5）：下载勾选的类别，等同于点主按钮
    { id: 'download-checked', title: '下载勾选的素材', suggestedKey: 'Alt+Shift+D' },
  ],
} satisfies FeatureManifest;

export default manifest;
