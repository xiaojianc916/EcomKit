# Phase 0 验证记录（进行中）

> 采样脚本：`scripts/phase0/sample.mjs`（真机 Playwright + 系统 Chrome）、`scripts/phase0/extract-ssr.mjs`（绕过渲染直取 SSR）
> 原始产物：`.phase0-raw/`（已 gitignore）。本文件只记录**结论**。

采样时间：2026-11-05，环境 Windows / Chrome 131 / 中国时区直连。

## 1. 阻断行为实测（§7.5、§7.6、§17-3、§17-4）

### 拼多多商品页

| 观测 | 结果 |
| --- | --- |
| `https://mobile.yangkeduo.com/goods.html?goods_id=…` 服务端返回 | HTTP 200，约 64 KB HTML |
| HTML 里是否有 SSR 数据 | 有 `window.rawData`，但 `rawData.store.initDataObj = { needLogin: true }` |
| 桌面 UA + 真实浏览器 | 客户端 JS 立刻跳转 `/login.html`，页面只有登录框 |
| 手机 UA + 移动视口 | 同样跳转登录页 |
| 页面元素 | 0 张商品图、0 个 video |

**结论**：桌面浏览器打开拼多多商品页，**未登录时必然被登录墙拦下**，且 SSR 默认只给 `needLogin`。
→ 实现上必须把 `LOGIN_REQUIRED` 当作**高频主路径**而不是异常分支：
- `detectBlocker` 判定顺序：`location` 跳到 `/login.html` → `LOGIN_REQUIRED`；`rawData.store.initDataObj.needLogin === true` → `LOGIN_REQUIRED`；页面出现登录弹层 + 无商品数据 → `LOGIN_REQUIRED`。
- UI 按 §10.4 阻断态显示：「需要先登录拼多多 / 登录后刷新页面，就能识别商品 / [刷新页面]」。
- **登录后** `rawData.store.initDataObj` 才会带 `goods`，此时走 SSR 源。

### 抖音 haohuo 商品页

| 观测 | 结果 |
| --- | --- |
| `https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=…` | HTTP 200，约 12 KB |
| 页面文案 | 「请使用抖音APP扫码或 点此进入抖音查看商品信息」「检测到当前环境存在安全风险，请进入抖音查看商品详情」 |
| 桌面 UA | 无商品数据，只有二维码 |
| 手机 UA（Pixel 7 + Android 14，移动视口 + 触摸） | **同样是扫码页**，改 UA 不生效 |
| 加载的接口 | `/ecom/product/detail/qr_code/`、`/ecom/product/detail/h5/sc/`、`/aweme/v2/shop/promotion/pack/h5/`、`/ai/getGptGeneratedProductDesc` |
| 是否有 SSR 全局 | 无（`__INITIAL_STATE__` 等全部 undefined） |

**结论**：抖音 C 端详情页在**任何桌面/手机浏览器 UA 下都只给扫码页**，这是平台侧强制风控，不是 UA 能绕过的。
→ §17-4 的「改 UA 能否加载」**验证为否**。
→ 按方案 §17-4 的「不通过时」分支：**去掉「以手机模式重新打开」**（保留 DNR UA 能力但默认不启用，`supportsMobileMode: false`），APP_ONLY 只提示「请在手机上打开」。
→ 抖音的平台适配器依然要写完整（resolver 三源 + 视频选择 + 富文本详情 + 链接过期），因为**用户自己已登录的浏览器里**页面能正常加载；我们只是无法在无人值守环境采样。fixtures 用结构等价样本。

## 1.5 CDN 与图片规则实测（§17-6、§17-7）

### Referer 是否需要

| 平台 / 域名 | 不带 Referer | 带 Referer | 结论 |
| --- | --- | --- | --- |
| 抖音 `p11.douyinpic.com` | 200，49 KB webp | 200，完全相同 | **不需要 Referer** |
| 拼多多 `funimg.pddpic.com` | 200，20 KB jpg | 200，完全相同 | **不需要 Referer** |

**结论**：v1 **不启用 DNR Referer 规则**。`manifest.referer` 两个平台都不填，bg 不装动态规则。
（如果后续遇到 403 的 CDN，再按 §9.7 打开，规则条件限定 `initiatorDomains: [扩展 ID]`。）

### 原图规则（真实像素尺寸实测）

**拼多多**：

| 地址 | 字节 | 结论 |
| --- | --- | --- |
| `…/logo.jpg` | 20202 | 原图 |
| `…/logo.jpg?imageView2/2/w/200/q/80` | 8945 | 缩略图 |

→ 去掉 `?imageMogr2/…`、`?imageView2/…` 等查询参数得到原图。**规则成立**，与方案 §7.5 一致。

**抖音**（同一张图，读 WebP VP8X / PNG IHDR 得到真实尺寸）：

| 地址 | 状态 | 字节 | 真实尺寸 | 结论 |
| --- | --- | --- | --- | --- |
| `…x~c5_720x720.webp?from=…`（页面原始） | 200 | 49740 | 720×720 | 缩略图 |
| `…x~c5_2000x2000.webp` | 200 | 77022 | **1093×1093** | 上限就是源图尺寸 |
| `…x~tplv-obj:720:720.webp` | 200 | 74552 | 1093×1093 | 后缀里的尺寸不生效 |
| `…x~tplv-obj.image` | 200 | **680030** | **1093×1093** | **PNG 原图** |
| `…x`（完全去掉 `~` 后缀） | **400** | 46 | — | **不可行** |

**结论（重要修正）**：方案 §7.6.2 说的「去掉 `~` 及其后面的部分」**行不通**，会返回 400 `fail to handle request`。
正确规则是：

1. 候选 ①：把 `~` 之后的全部替换成 `~tplv-obj.image`（拿到 PNG 原图，尺寸和字节数都最大）
2. 候选 ②：页面原始 URL（灰度兜底）

另外：`~tplv-…` 后缀里的尺寸参数**不生效**，服务端始终返回源图尺寸；所以缩略图必须直接用页面原始 URL，不能靠改后缀生成小图。


## 1.6 FSA + Offscreen 全链路实测（§17-1、§17-2）

用真实扩展环境跑（`scripts/phase0/fsa-probe/` 探针扩展 + `scripts/phase0/run-fsa-probe.mjs`），
Playwright 自带 Chromium 156 headful 加载。

| # | 验证点 | 结果 |
| --- | --- | --- |
| 1 | 扩展页面 `isSecureContext` | ✅ true |
| 2 | `window.showDirectoryPicker` 存在 | ✅ function |
| 3 | 目录句柄 `queryPermission({mode:'readwrite'})` | ✅ 返回 `granted` |
| 4 | 句柄存进 IndexedDB 再读回 | ✅ 读回 `kind: 'directory'`，`name` 正确 |
| 5 | 用读回的句柄 `createWritable()` 写文件 | ✅ 写入成功，`getFile()` 读回内容一致 |
| 6 | 目录里有没有残留 `.crswap` | ✅ 没有，`close()` 后干净落盘 |
| 7 | `requestPermission()` 存在且可调用 | ✅ 返回 `granted` |
| 8 | `chrome.offscreen.createDocument()` | ✅ 创建成功 |
| 9 | **Offscreen 能否读回另一个上下文存的句柄** | ✅ **能**，`queryPermission` 返回 `granted` |
| 10 | **Offscreen 能否用该句柄写文件** | ✅ **能**，写完 `dirEntries` 里能看到两个文件 |

**结论**：ADR-1（下载和写入放 Offscreen）**成立**。
grant 小窗拿的授权 → 存 IndexedDB → Offscreen 读回 → 写入，整条链路在真实扩展里跑通。
所有扩展页面同源共享 IndexedDB 这一点得到确认。

**没能自动验证的部分**（需要人工，已写进验收清单）：
- `showDirectoryPicker` 的用户手势 + 系统目录选择对话框（Playwright 点不了系统对话框）
- 浏览器重启后 Chrome 是否给出「仅这次允许 / 每次访问时允许 / 不允许」三选项（§9.4 的核心假设）
- Edge 的同等行为

本次探针用 OPFS 目录（`navigator.storage.getDirectory()`）代替用户真实选择的目录，
验证的是「句柄跨上下文 + 跨写」这唯一无法人工确认的技术点；
用户授权流程本身按 §9.4 实现，由人工验收清单第 3、9 条覆盖。


## 2. 对实现的直接影响

| # | 结论 | 落到代码 |
| --- | --- | --- |
| 1 | 拼多多登录墙是主路径 | `platforms/pinduoduo/resolver.ts` 的 `detectBlocker` 覆盖三种信号；`POLICY` 里把登录提示做成一级 UI 状态 |
| 2 | 抖音 APP_ONLY 是**必然**而非偶发 | `platforms/douyin/manifest.ts` 设 `supportsMobileMode: false`；UI 只给「在手机上打开」提示 |
| 3 | 两个平台都无法在无人值守环境拿到完整商品数据 | fixtures 用**结构等价样本**（字段名和层级严格按平台真实 HTML/接口结构），并在文件头注明来源与采样日期 |
| 4 | 抓包规则仍需真机验证 | bridge 的 capture 规则写成**宽匹配 + 精确过滤**两层：MAIN 侧按 `urlPattern` 粗筛，ISOLATED 侧再用 Zod 结构和商品 ID 校验 |
| 5 | CDN 白名单可静态确定 | 拼多多 `*.pddpic.com` `*.yangkeduo.com`；抖音 `*.ecombdimg.com` `*.byteimg.com` `*.douyinpic.com` `*.douyinvod.com` `*.bytecdn.cn` `*.ibyteimg.com` |

## 3. 待补（需要用户已登录的真实样本）

- [ ] 拼多多：登录后 `rawData.store.initDataObj.goods` 的完整结构（标题/主图/详情图/SKU/视频/店铺字段路径）
- [ ] 抖音：登录后 `/aweme/v2/shop/promotion/pack/h5/` 响应结构；详情富文本字段；视频字段（编码、过期参数）
- [ ] 各 CDN 无 Referer 时的状态码
- [ ] 原图规则实测（去掉 `imageMogr2` / `~tplv-…` 后尺寸是否更大）

用户回传方式：把 `.phase0-raw/*.json` 放进 `fixtures-inbox/` 目录，我写 `scripts/phase0/import-fixtures.ts` 自动生成 `__fixtures__`。