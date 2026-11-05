/**
 * media-download 的 service 部分（方案 §8.6）：跑在 bg 侧，只处理功能私有的 RPC。
 *
 * 目前只有 `history.get`：读商品文件夹里的 .ecbox.json，算出「上次下载于…、还缺几个文件」，
 * 供面板显示「补全 3 个文件」（§9.11 历史提示）。
 *
 * 注意：这里**不做下载**，下载是引擎的事（ADR-5：任务真相源在 Offscreen）。
 * 真正的读取在 offscreen（那里有目录句柄），bg 只做转发。
 */

import type { HistoryState } from '../../kernel/messaging/protocol';
import { sendMessage } from '../../kernel/messaging/runtime';
import type { ServiceFeature } from '../types';

export interface HistoryQuery {
  platform?: string;
  productId: string;
  /** 当前快照里所有 itemKey，用来算缺哪些 */
  itemKeys?: string[];
}

export const mediaDownloadService: ServiceFeature = {
  methods: {
    /** 查询某商品的历史下载状态 */
    async 'history.get'(args): Promise<HistoryState | null> {
      const q = args as HistoryQuery | undefined;
      if (!q?.productId) return null;
      try {
        const res = (await sendMessage('engine.call', {
          feature: 'media-download',
          method: 'history.get',
          args: q,
        })) as HistoryState | null;
        return res ?? null;
      } catch {
        // 拿不到历史不影响下载：返回 null，面板按「没有记录」显示
        return null;
      }
    },
  },
};

export default mediaDownloadService;
