# 端到端测试

用 Playwright 的 `launchPersistentContext` 加载构建产物，用 `context.route` 把商品页 URL
替换成本地 fixture 页面（方案 §15）。

系统目录选择器无法自动化，所以 E2E 构建（`ECBOX_E2E`）下把根目录换成 OPFS
（`navigator.storage.getDirectory()`），测试结束后校验生成的目录树。

```bash
pnpm build          # 先构建
pnpm test:e2e
```
