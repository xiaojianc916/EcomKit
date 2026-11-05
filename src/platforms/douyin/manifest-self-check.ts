import { findPageKind } from '../registry';
import type { PageKindDef, PlatformManifest } from '../types';
import manifest from './manifest';

/**
 * manifest 自检工具（抖音）。
 *
 * 平台层不能 import 别的平台，但**可以**用 registry 的纯函数验一遍自己的清单：
 * 生成 build-manifest.json 之后，如果 match pattern 写错，页面根本不会被注入。
 *
 * 注意：registry 读的是 src/generated/build-manifest.json，
 * 所以跑测试前需要先执行 `node scripts/gen-registries.ts`（wxt build 会自动跑）。
 */
export const DyManifestSelfCheck = {
  assertValid(): PlatformManifest {
    if (!manifest.id) throw new Error('manifest.id 不能为空');
    if (manifest.pageKinds.length === 0) throw new Error('manifest.pageKinds 不能为空');
    if (manifest.cdnHosts.length === 0) throw new Error('manifest.cdnHosts 不能为空');
    for (const [i, kind] of manifest.pageKinds.entries()) assertPageKind(kind, i);
    for (const rule of manifest.capture) assertCaptureRule(rule);
    return manifest;
  },

  findPageKind(rawUrl: string): { kind: string; productId: string } | null {
    const hit = findPageKind(new URL(rawUrl));
    if (!hit) return null;
    return { kind: hit.kind, productId: hit.productId };
  },
};

function assertPageKind(kind: PageKindDef, index: number): void {
  if (!kind.kind) throw new Error(`pageKinds[${index}].kind 不能为空`);
  if (kind.matches.length === 0) throw new Error(`pageKinds[${index}].matches 不能为空`);
  if (!kind.productIdParam) throw new Error(`pageKinds[${index}].productIdParam 不能为空`);
  for (const pattern of kind.matches) {
    if (!/^https?:\/\//.test(pattern) && !pattern.startsWith('*://')) {
      throw new Error(`pageKinds[${index}] 的 match pattern 不合法：${pattern}`);
    }
  }
}

function assertCaptureRule(rule: PlatformManifest['capture'][number]): void {
  if (!rule.id) throw new Error('capture.id 不能为空');
  if (rule.pageKinds.length === 0) throw new Error(`capture ${rule.id} 的 pageKinds 不能为空`);
  if (!rule.urlPattern) throw new Error(`capture ${rule.id} 的 urlPattern 不能为空`);
  try {
    new RegExp(rule.urlPattern);
  } catch {
    throw new Error(`capture ${rule.id} 的 urlPattern 不是合法正则`);
  }
}
