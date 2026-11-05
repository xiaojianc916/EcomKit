import { PLATFORM_MANIFESTS } from './registry';
import type { PlatformResolver } from './types';

/**
 * 平台 resolver 的汇总入口。
 *
 * 为什么不和 registry.ts 放一起：
 * resolver 里是**函数**（detectBlocker、sources），不能像 manifest 那样序列化成 JSON
 * 让构建期脚本直接读；而且它依赖 DOM，只该在 ISOLATED world 的内容脚本里加载。
 * 如果塞进 registry.ts，offscreen（写文件、发请求）也会把两个平台的解析器拖进去。
 *
 * 分层含义不变：功能层仍然只依赖 `platforms/registry`（纯数据），
 * 这个文件只允许 entrypoints 引用（见 .dependency-cruiser.cjs 的 feature-no-platform-resolver）。
 */
const resolverModules = import.meta.glob<{ default: PlatformResolver }>('./*/resolver.ts', {
  eager: true,
});

const RESOLVERS: Record<string, PlatformResolver> = Object.fromEntries(
  Object.entries(resolverModules).map(([path, mod]) => {
    const id = path.replace(/^\.\//, '').replace(/\/resolver\.ts$/, '');
    return [id, mod.default];
  }),
);

export function getPlatformResolver(platformId: string): PlatformResolver | null {
  return RESOLVERS[platformId] ?? null;
}

/** 启动自检：每个有 manifest 的平台都必须有 resolver，否则是构建错误 */
export function validateResolvers(): void {
  const missing = PLATFORM_MANIFESTS.filter((m) => !RESOLVERS[m.id]).map((m) => m.id);
  if (missing.length > 0) {
    throw new Error(`platforms missing resolver.ts: ${missing.join(', ')}`);
  }
  const orphan = Object.keys(RESOLVERS).filter(
    (id) => !PLATFORM_MANIFESTS.some((m) => m.id === id),
  );
  if (orphan.length > 0) {
    throw new Error(`platforms with resolver but no manifest: ${orphan.join(', ')}`);
  }
}
