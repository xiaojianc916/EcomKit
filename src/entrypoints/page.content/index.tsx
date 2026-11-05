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
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { createPageController } from './controller';
import { createPageApi } from './page-api';
import { Shell } from '../../shell/Shell';
import { PortalRoot } from '../../kernel/ui-kit/PortalRoot';
import { createLogger } from '../../kernel/log/logger';
import { PLATFORM_MATCHES } from '../../platforms/registry';

const log = createLogger('page');

export default defineContentScript({
  // 注入范围由平台层生成（方案 §12）：各平台 manifest.ts 的 matches 汇总
  matches: PLATFORM_MATCHES,
  runAt: 'document_idle',
  cssInjectionMode: 'ui',
  allFrames: false,

  async main(ctx) {
    const controller = createPageController(ctx);
    const api = createPageApi(controller);

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
            createElement(PortalRoot, {
              value: shadow,
              children: createElement(Shell, controller.shellProps(api)),
            }),
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

    const unmount = () => {
      ui?.remove();
      ui = null;
      controller.dispose();
    };

    controller.onMatched(() => {
      void mount();
    });
    controller.onUnmatched(unmount);

    controller.start();
  },
});