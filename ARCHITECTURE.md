# EcomKit 架构速览

完整设计：[`项目架构设计方案.md`](./项目架构设计方案.md)。这里是实现状态与目录对照。

## 四层

| 层 | 目录 | 职责 |
| --- | --- | --- |
| 入口层 | `src/entrypoints/` | 只做装配，不写业务 |
| 功能层 | `src/features/` | 可插拔功能，按运行上下文拆 manifest/page/service/engine |
| 平台层 | `src/platforms/` | 把平台页面翻译成 `ProductSnapshot` |
| 内核层 | `src/kernel/` | 和业务无关的基础设施 |

## 运行时

```
网页 MAIN world  bridge.content.ts ──CustomEvent──┐
                                                  ▼
网页 ISOLATED     page.content/  PageController · Resolver · FeatureHost · Shell
                                                  │ runtime 消息 + Port
                                       background.ts (SW)
                                                  │
                              offscreen/ (任务真相源 · FsGateway · Fetcher)
                                                  │
                        grant/ (唯一能弹目录选择器的地方)
```

## 关键决策

见方案 §4.4（ADR-1 ~ ADR-8）。
