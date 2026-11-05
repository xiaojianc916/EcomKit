import type { Plugin } from 'postcss';

/**
 * Shadow DOM 兼容插件（§10.10）：
 * 1. rem → px（1rem = 16px）：移动版页面会改 html { font-size }，rem 会跟着失控
 * 2. @property --tw-x { initial-value: v } → :host { --tw-x: v }
 *    Tailwind v4 依赖 @property 注册变量，在 shadow root 里不生效
 */
export function shadowCompat(opts: { rootFontSize?: number } = {}): Plugin {
  const base = opts.rootFontSize ?? 16;
  return {
    postcssPlugin: 'ecbox-shadow-compat',
    Once(root) {
      root.walkDecls((decl) => {
        if (decl.value?.includes('rem')) {
          decl.value = decl.value.replace(/(-?\d*\.?\d+)rem/g, (_m, num: string) =>
            String(Math.round(Number.parseFloat(num) * base * 1000) / 1000),
          );
        }
      });

      const properties: { prop: string; value: string }[] = [];
      root.walkAtRules('property', (atRule) => {
        const prop = atRule.params.trim();
        let value: string | undefined;
        atRule.walkDecls('initial-value', (d) => {
          value = d.value;
        });
        if (value !== undefined) properties.push({ prop, value });
        atRule.remove();
      });

      if (properties.length > 0) {
        const hostRule = root.first;
        const decls = properties.map((p) => `${p.prop}: ${p.value};`).join('\n  ');
        root.prepend(`:host {\n  ${decls}\n}`);
        void hostRule;
      }
    },
  };
}

export default shadowCompat;
