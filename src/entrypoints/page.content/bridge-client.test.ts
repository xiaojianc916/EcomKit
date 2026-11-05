import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_CHANNEL_ATTR, bridgeEvent, publishBridgePrefix } from '../../kernel/messaging/page-bridge';
import type { PlatformManifest } from '../../platforms/types';

const manifest = {
  id: 'pinduoduo',
  capture: [{ id: 'pdd.goods-detail', pageKinds: ['pdd.goods'], urlPattern: '/proxy/api/' }],
} as unknown as PlatformManifest;

async function freshClient() {
  vi.resetModules();
  return import('./bridge-client');
}

afterEach(() => document.documentElement.removeAttribute(BRIDGE_CHANNEL_ATTR));

describe('page bridge 握手（MAIN 先发布前缀，ISOLATED 后读取）', () => {
  it('MAIN 没就位时直接返回 null，不再每次空等超时', async () => {
    const { createPageBridge } = await freshClient();
    expect(createPageBridge(manifest, 'pdd.goods')).toBeNull();
  });

  it('读取 MAIN 发布的前缀后立即删除属性，hello 时收到 MAIN 回放的抓包', async () => {
    const prefix = publishBridgePrefix(document); // 模拟 document_start 的 MAIN
    // 模拟 MAIN：收到 hello 就同步回放一条缓冲的抓包
    document.addEventListener(bridgeEvent.hello(prefix), () => {
      document.dispatchEvent(
        new CustomEvent(bridgeEvent.capture(prefix), {
          detail: JSON.stringify({
            ruleId: 'pdd.goods-detail',
            url: '/proxy/api/x',
            json: JSON.stringify({ goods: { goodsName: 't' } }),
            at: 1,
          }),
        }),
      );
    });
    const { createPageBridge } = await freshClient();
    const bridge = createPageBridge(manifest, 'pdd.goods');
    expect(bridge).not.toBeNull();
    expect(document.documentElement.hasAttribute(BRIDGE_CHANNEL_ATTR)).toBe(false);

    const ac = new AbortController();
    const got: unknown[] = [];
    const loop = (async () => {
      for await (const p of bridge!.captures('pdd.goods-detail', ac.signal)) got.push(p.json);
    })();
    await Promise.resolve();
    ac.abort();
    await loop; // 中止后迭代器必须结束（旧实现是无限 while(true)）
    expect(got).toEqual([{ goods: { goodsName: 't' } }]);
    bridge!.dispose();
  });
});
