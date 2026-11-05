/**
 * 内容脚本（ISOLATED world，方案 §4.2、§7.2、§10.10）。
 *
 * 它只做**装配**，业务都在别的文件里：
 *   1. PageController：URL → 平台/页面类型 → 适配器；监听 SPA 路由
 *   2. Resolver：并行跑多个数据源 → 渐进合并 → ProductSnapshot
 *   3. FeatureHost：按能力挂载功能模块的 page 部分
 *   4. Shell：Shadow DOM 里的 React 工具箱
 *
 * 它**不**直接下载文件：内容脚本处于网页源，写不了扩展源的目录（ADR-1）。
 */

import { createElement, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
// 面板样式：cssInjectionMode 'ui' 会把这里 import 的 CSS 注入到 Shadow Root 里。
// 旧实现一个 CSS 都没引入 → var(--ec-*) 全部未定义，把手/面板透明、无边框，几乎看不见。
// 只引令牌 + 组件类，不引 tailwind.css（那份带 preflight，见 ui-kit/tailwind.css 注释）。
import '../../kernel/ui-kit/tokens.css';
import '../../kernel/ui-kit/ui-kit.css';
import type { PageApi } from '../../features/types';
import { createLogger } from '../../kernel/log/logger';
import { showToast } from '../../kernel/ui-kit';
import { PortalRoot } from '../../kernel/ui-kit/PortalRoot';
import { PLATFORM_MATCHES } from '../../platforms/registry';
import { Shell } from '../../shell/Shell';
import { createPageController, type PageController } from './controller';
import { createPageApi } from './page-api';

const log = createLogger('page');

/**
 * 订阅 controller 的状态版本号，每次 notify 都用最新状态重算 props。
 * 旧实现 `root.render(createElement(Shell, controller.shellProps(api)))` 只执行一次，
 * status / snapshot / dir / job 被冻结在挂载那一刻（永远是「识别中」）。
 */
function ConnectedShell({ controller, api }: { controller: PageController; api: PageApi }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion, controller.getVersion);
  return createElement(Shell, controller.shellProps(api));
}

export default defineContentScript({
  // 注入范围由平台层生成（方案 §12）：各平台 manifest.ts 的 matches 汇总
  matches: PLATFORM_MATCHES,
  runAt: 'document_idle',
  cssInjectionMode: 'ui',
  allFrames: false,

  async main(ctx) {
    const controller = createPageController(ctx);
    const api = createPageApi(controller);
    // PageApi.toast 的落点：没有这一行，页面侧所有"告诉用户发生了什么"的提示都只是内存里的一句话
    type ToastHandler = (msg: string, opts?: { action?: { label: string; run(): void } }) => void;
    (api as unknown as { __setToastHandler(h: ToastHandler): void }).__setToastHandler(
      (msg, opts) => showToast(msg, opts?.action),
    );

    // 快捷键 / popup / 工具栏命令（bg 和 popup 都用 chrome.tabs.sendMessage 发这个）。
    // 旧实现完全没监听：Alt+Shift+D 和 popup 的「下载」都是死键。
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type !== 'ecbox:command') return false;
      const id = typeof msg.command === 'string' ? msg.command : '';
      void controller
        .handleCommand(id, api)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true; // 异步应答
    });

    let ui: Awaited<ReturnType<typeof createShadowRootUi>> | null = null;
    let root: Root | null = null;

    const mount = async () => {
      if (ui) return;
      ui = await createShadowRootUi(ctx, {
        name: 'ecbox-root',
        // 挂在 html 下而不是 body 下：body 有 transform/filter 时 position:fixed 会失效（§10.10）
        position: 'inline',
        anchor: 'html',
        append: 'last',
        // 阻止键盘和滚轮冒泡到页面（§10.10）
        isolateEvents: ['keydown', 'keyup', 'keypress', 'wheel'],
        onMount(container, shadow) {
          root = createRoot(container);
          root.render(
            createElement(
              PortalRoot,
              { value: shadow },
              createElement(ConnectedShell, { controller, api }),
            ),
          );
          return root;
        },
        onRemove(r) {
          r?.unmount();
          root = null;
        },
      });
      ui.mount();
      log.info('shell mounted');
    };

    // 离开商品页（SPA）只卸 UI；controller 还要继续监听路由，回到商品页时重新识别。
    // 旧实现在这里 dispose 了 controller，SPA 回到商品页后什么都不会发生。
    const unmount = () => {
      ui?.remove();
      ui = null;
    };
    ctx.onInvalidated(() => controller.dispose());

    controller.onMatched(() => {
      void mount();
    });
    controller.onUnmatched(unmount);

    controller.start();
  },
});