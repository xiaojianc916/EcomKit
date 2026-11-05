/**
 * media-download 的 service 部分（方案 §8.6）：跑在 bg 侧，只处理功能私有的 RPC。
 *
 * 目前只有 `history.get`：读商品文件夹里的 .ecbox.json，算出「上次下载于…、还缺几个文件」，
 * 供面板显示「补全 3 个文件」（§9.11 历史提示）。
 *
 * 注意：这里**不做下载**，下载是引擎的事（ADR-5：任务真相源在 Offscreen）。
 */
import type { ServiceFeature } from '../types';

export interface HistoryQuery {
  platform: string;
  productId: string;
  folderName: string;
  /** 当前快照里所有 itemKey，用来算缺哪些 */
  itemKeys: string[];
}

export interface HistoryResult {
  /** 上次下载时间（毫秒）；没有记录时为 null */
  lastAt: number | null;
  /** 快照里有、但清单里没有（或文件不在）的 itemKey */
  missing: string[];
  total: number;
}

export const mediaDownloadService: ServiceFeature = {
  methods: {
    /** 查询某商品的历史下载状态 */
    async 'history.get'(args): Promise<HistoryResult> {
      const q = args as HistoryQuery;
      const empty: HistoryResult = { lastAt: null, missing: q?.itemKeys ?? [], total: 0 };
      if (!q?.itemKeys) return empty;

      // 真正的读取在 offscreen（那里有句柄）。bg 只做转发，拿不到就返回空。
      // 之所以保留这一层而不是页面直接调 engine：页面不该知道 FS 的存在（§8.2 PageApi）。
      try {
        const { sendMessage } = await import('../../kernel/messaging/runtime');
        const res = (await sendMessage('engine.call', {
          feature: 'media-download',
          method: 'history.get',
          args: q,
        })) as HistoryResult | undefined;
        return res ?? empty;
      } catch {
        return empty;
      }
    },
  },
};

export default mediaDownloadService;
