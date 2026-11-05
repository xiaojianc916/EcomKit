/**
 * 分层依赖强制检查（方案 §4.1、§8.8）。
 * `pnpm depcruise` / `pnpm check` 失败即构建失败。
 */
module.exports = {
  forbidden: [
    {
      name: 'kernel-is-pure',
      comment: '内核层不得依赖平台层、功能层、外壳层、入口层',
      severity: 'error',
      from: { path: '^src/kernel' },
      to: { path: '^src/(platforms|features|shell|entrypoints|generated)' },
    },
    {
      name: 'kernel-no-dom-ui',
      comment: '内核层不得依赖 shell 的 store / 组件',
      severity: 'error',
      from: { path: '^src/kernel/(?!ui-kit)' },
      to: { path: '^src/(shell|features)' },
    },
    {
      name: 'platform-isolated',
      comment: '平台之间不能互相依赖（只能依赖 shared 和 types）',
      severity: 'error',
      from: { path: '^src/platforms/([^/]+)/' },
      to: { path: '^src/platforms/(?!shared|types|registry)', pathNot: '^src/platforms/$1/' },
    },
    {
      name: 'platform-no-feature',
      comment: '平台层不得依赖功能层和外壳',
      severity: 'error',
      from: { path: '^src/platforms' },
      to: { path: '^src/(features|shell)' },
    },
    {
      name: 'feature-isolated',
      comment: '功能之间不能互相依赖',
      severity: 'error',
      from: { path: '^src/features/([^/]+)/' },
      to: { path: '^src/features/(?!types)', pathNot: '^src/features/$1/' },
    },
    {
      name: 'feature-no-platform-resolver',
      comment: '功能层不能加载平台 resolver（那是内容脚本用的，会拖进 DOM 依赖）',
      severity: 'error',
      from: { path: '^src/(kernel|features|shell)' },
      to: { path: '^src/platforms/registry\\\\.resolver' },
    },
    {
      name: 'feature-no-concrete-platform',
      comment: '功能层只能依赖平台层的汇总注册表，不能依赖具体平台',
      severity: 'error',
      from: { path: '^src/features' },
      to: { path: '^src/platforms/(?!registry|types)' },
    },
    {
      name: 'no-react-in-workers',
      comment: 'Service Worker 和 Offscreen 里不能有 React（方案 ADR-3）',
      severity: 'error',
      from: {
        path: '(service|engine)\\.(ts|tsx)$|^src/entrypoints/(background\\.ts|offscreen/)',
      },
      to: { path: 'node_modules/(react|react-dom)|^src/(kernel/ui-kit|shell)|^src/features/[^/]+/(page|ui)' },
    },
    {
      name: 'no-orphan-generated',
      comment: 'generated 是构建产物，只允许 runtime registry 读',
      severity: 'warn',
      from: { pathNot: '^src/(platforms/registry|features/registry)' },
      to: { path: '^src/generated/build-manifest\\.json' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(node_modules|\\.output|\\.wxt|__fixtures__|\\.test\\.(ts|tsx)$)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};