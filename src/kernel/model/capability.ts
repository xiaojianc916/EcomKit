import type { ProductSnapshot } from './product';

/** 快照“能提供什么”，功能模块据此决定是否出现（§8.4） */
export type Capability =
  | 'product.basic'
  | 'assets.main'
  | 'assets.sku'
  | 'assets.detail'
  | 'assets.video'
  | 'skus.specs'
  | 'price';

export const ALL_CAPABILITIES: readonly Capability[] = [
  'product.basic',
  'assets.main',
  'assets.sku',
  'assets.detail',
  'assets.video',
  'skus.specs',
  'price',
];

export function capabilitiesOf(snapshot: ProductSnapshot): Set<Capability> {
  const caps = new Set<Capability>();
  if (snapshot.title && snapshot.productId) caps.add('product.basic');
  for (const asset of snapshot.assets) {
    if (asset.kind === 'main') caps.add('assets.main');
    else if (asset.kind === 'sku') caps.add('assets.sku');
    else if (asset.kind === 'detail') caps.add('assets.detail');
    else if (asset.kind === 'video') caps.add('assets.video');
  }
  if (snapshot.skus.some((s) => s.specs.length > 0)) caps.add('skus.specs');
  if (snapshot.price) caps.add('price');
  return caps;
}

export function hasCapabilities(
  snapshot: ProductSnapshot,
  required: readonly Capability[],
): boolean {
  const caps = capabilitiesOf(snapshot);
  return required.every((c) => caps.has(c));
}
