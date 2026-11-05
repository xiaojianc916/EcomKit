# EcomKit 开发约定

> 完整设计见 `项目架构设计方案.md`（下称「方案」）。本文只列**已经定稿的契约**和**分工边界**，两者冲突时以本文为准并同步修订方案。

## 分层（方案 §4.1，由 dependency-cruiser 强制）

```
entrypoints → features → platforms → kernel
```

- `src/kernel/*` 只能依赖第三方库，**不得** import `platforms` / `features` / `shell` / `entrypoints`
- `src/platforms/<p>/*` 只能依赖 `kernel` 和 `platforms/shared`，不得跨平台、不得碰 features/shell
- `src/features/<f>/*` 只能依赖 `kernel` 和 `platforms/registry`（汇总接口），不得依赖具体平台、不得依赖其他功能
- `*.service.ts` / `*.engine.ts` / `entrypoints/background.ts` / `entrypoints/offscreen/**` **不得** import react、`kernel/ui-kit`、`shell`

## 已经定稿的契约（不要改，改了要通知 Lead）

| 文件 | 作用 |
| --- | --- |
| `src/kernel/model/asset.ts` `product.ts` `capability.ts` | 数据模型：`Asset` `ProductSnapshot` `ProductDraft` `Capability` `capabilitiesOf()` |
| `src/kernel/errors/codes.ts` `ec-error.ts` `messages.ts` | `EcError` + 错误码表 + 文案查表 |
| `src/kernel/messaging/protocol.ts` | `ProtocolMap`（@webext-core/messaging）、`DirState`、`TabState`、`PortMessage` |
| `src/kernel/jobs/types.ts` | `JobTypeDef` `WorkItem` `ItemResult` `JobRecord` `RunContext` `PlanContext` |
| `src/kernel/fs/types.ts` | `FsSink` `FsGateway` `DirState` `WriteResult` |
| `src/kernel/net/types.ts` | `Fetcher` `FetchOpts` `SniffResult` |
| `src/kernel/storage/keys.ts` | 全部持久化 key |
| `src/platforms/types.ts` | `PlatformManifest`（**纯数据**）`PlatformResolver` `DataSource` `ResolveContext` `CaptureRule` |
| `src/platforms/registry.ts` | `findPageKind()` `isAllowedCdnUrl()` `normalizeProductUrl()` `PLATFORM_MATCHES` `CDN_HOSTS` |
| `src/features/types.ts` | `FeatureManifest` `PageFeature` `PageApi` `PanelProps` `ServiceFeature` `EngineFeature` |
| `src/generated/build-manifest.json` | `node scripts/gen-registries.ts` 生成，**不要手改** |

**重要**：`src/platforms/*/manifest.ts` 和 `src/features/*/manifest.ts` 必须是**纯数据模块**——只能 `import type`，不能有运行时 import，否则构建期的 Node 脚本加载不了。

## 代码风格

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`（可选属性用 `?:` 时**不要赋 undefined**，要么就别写这个 key）
- 单引号、分号、2 空格、行宽 100（Biome）
- 注释和用户可见文案用中文；标识符用英文
- 用户可见文案遵守方案 §10.7：动词开头、带数量、不用「一键 / 智能 / AI」和感叹号
- 错误一律 `new EcError(code)`，UI 文案只能从 `errorMessage(code)` 取，**任何地方都不显示异常的 message**
