import { z } from 'zod';
import { Asset } from './asset';

/** 新增平台时在这里加一项（附录 A） */
export const PlatformId = z.enum(['pinduoduo', 'douyin']);
export type PlatformId = z.infer<typeof PlatformId>;

export const Sku = z.object({
  id: z.string(),
  specs: z.array(z.object({ name: z.string(), value: z.string() })),
  /** 指向 assets 中某个 kind='sku' 的素材 */
  imageKey: z.string().optional(),
  price: z.string().optional(),
  stock: z.number().optional(),
});
export type Sku = z.infer<typeof Sku>;

export const DataSourceId = z.enum(['ssr', 'capture', 'dom']);
export type DataSourceId = z.infer<typeof DataSourceId>;

export const ProductSnapshot = z.object({
  platform: PlatformId,
  /** 'pdd.goods' | 'dy.haohuo' … */
  pageKind: z.string().min(1),
  /** goods_id / id，必须是纯数字 */
  productId: z.string().regex(/^\d{5,25}$/),
  title: z.string().min(1),
  shopName: z.string().optional(),
  /** 规范化后的商品链接（去掉追踪参数） */
  url: z.string().url(),
  price: z.string().optional(),
  skus: z.array(Sku),
  assets: z.array(Asset),
  /** 哪些数据源产出过内容 */
  sources: z.array(DataSourceId),
  /** 是否有某个源超时或失败 */
  completeness: z.enum(['full', 'partial']),
  capturedAt: z.number(),
});
export type ProductSnapshot = z.infer<typeof ProductSnapshot>;

/** 渐进解析过程中的半成品：所有字段都可能缺，merge 之后再经 ProductSnapshot 校验 */
export type ProductDraft = {
  title?: string;
  shopName?: string;
  price?: string;
  url?: string;
  skus?: Sku[];
  assets?: Asset[];
  source: DataSourceId;
};
