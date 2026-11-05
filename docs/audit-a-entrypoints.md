# 审计 A：入口层 / 后台 SW / shell 外形（task-1）

审计对象：`D:\EcomKit`（WXT + React 19 + Chrome MV3）。
审计方式：只读。所有结论都能在下面指到的 `文件:行号` 上复核。未修改任何源码。

> **快照说明（重要）**
> 审计期间工作树里有未提交的修复（`git diff --stat`：background.ts / offscreen/main.ts / engine.ts /
> page.tsx / service.ts / ui/PrimaryAction.tsx，另加新文件 `features/media-download/payload.ts`）。
> 下文所有行号以**当前工作树**为准。已经在下游修掉的项单列在「附 A. 工作树里已修的」，避免重复派活。

---

## 0. 结论速览

| 严重度 | 条数 | 关键词 |
| --- | --- | --- |
| 阻断 | 2 | popup 下载按钮、Alt+Shift+D 快捷键：发了消息没人接 |
| 严重 | 8 | Toast 通道不存在、双 Port 互相覆盖、崩溃恢复不通知 UI、导出诊断无分支、弹层掉出 shadow、站点偏好不落盘、rootPath 不下传、入口鉴权只覆盖 6 个方法 |
| 一般 | 8 | popup 早开误报、下载后未关窗、设置页两组不落库、切保存方式不刷新面板、读屏器播报从未触发 等 |
| 轻微 | 5 | 协议返回类型漂移、面板 top 计算、死接口 等 |

ProtocolMap 共 24 个方法，**handler 覆盖是完整的**（没有「声明了但 bg/offscreen 没注册」的方法）；
真正的问题在**发送侧没人收**（阻断 1/2）、**鉴权只做了 6 个方法**、以及**反馈通道（Toast/诊断）没接上**。

---

## 1. 阻断

### B1. popup 的「下载 N 个文件」/ 单类「下载」点了完全没反应（消息发出去没人监听）

- **文件:行号**：`src/entrypoints/popup/PopupApp.tsx:176-185`（发送方）、`src/entrypoints/page.content/controller.ts:362-377`（唯一的 runtime 监听器）
- **现象**：在商品页点工具栏 popup 里的「下载 24 个文件」，弹窗直接关掉，页面上什么都没发生——没有进度、没有提示、没有报错。
- **证据**：

```ts
// src/entrypoints/popup/PopupApp.tsx:176-185
async function download(only?: AssetKind): Promise<void> {
  // popup 不自己拼计划，交给页面（它知道当前快照和勾选状态）
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, {
    type: 'ecbox:command',
    command: only ? `download-${only}` : 'download-checked',
  });
  window.close();
}
```

内容脚本侧**只有一个** `chrome.runtime.onMessage` 监听器，它只认 `ecbox:getTabState`，其余一律 `return false`：

```ts
// src/entrypoints/page.content/controller.ts:362-377
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ecbox:getTabState') {
    sendResponse({ ... });
    return true;
  }
  return false;          // ← ecbox:command 到这里就被丢掉，且不报错
});
```

全仓库 `ecbox:command` 只有两处出现（发送方 popup:181、bg:148），**没有任何接收方**：

```
$ grep -rn "ecbox:command" src
src/entrypoints/background.ts:148:  await chrome.tabs.sendMessage(tab.id, { type: 'ecbox:command', command });
src/entrypoints/popup/PopupApp.tsx:181:    type: 'ecbox:command',
```

同时 `PageFeature.onCommand?`（`src/features/types.ts:66`）这个「功能自己处理命令」的插槽**从未被调用**，
page.tsx 里也没有实现它——所以即使补上监听器，也还没有实现体可以转过去。

- **影响**：popup 是「面板被遮挡 / 用户把面板设成不显示」时唯一的备用入口（见 PopupApp.tsx:10 注释），
  它整块下载功能不可用。且因为 `window.close()` 在 await 之后执行，用户连「弹窗为什么关了」都看不出来。
- **建议修法**：在 controller.start() 的 onMessage 里加 `msg?.type === 'ecbox:command'` 分支，
  查 `pageFeatures` 找到实现了 `onCommand` 的 feature 并调用；page.tsx 补
  `onCommand(id, api)`（`download-checked` → 走已有的 `submit([...checkedKinds])`，
  `download-main` / `sku` / `detail` / `video` → `submit([kind])`）。命令无法处理时至少回一句可见反馈。

### B2. 快捷键 Alt+Shift+D（下载勾选的素材）完全无反应

- **文件:行号**：`src/entrypoints/background.ts:145-152`、`src/features/media-download/manifest.ts:22-25`、`src/entrypoints/options/OptionsApp.tsx:238`
- **现象**：设置页明确写了「Alt+Shift+D 下载勾选的素材」，按下后什么都不发生。
- **证据**：

```ts
// src/entrypoints/background.ts:145-152
} else if (command === 'download-checked') {
  // 功能命令交给页面自己处理：它知道当前快照和勾选状态
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'ecbox:command', command });
  } catch {
    /* 页面没注入（不是商品页），忽略 */
  }
}
```

与 B1 是同一个死消息类型；命令本身注册进了 manifest（`src/generated/build-manifest.json:100-106`），
所以浏览器里快捷键**显示可用**，按下去却被静默吞掉。对照 `toggle-toolbox`（Alt+Shift+E）
走的是 Port，能正常工作（background.ts:143-144 → controller.ts:351-354），所以只有下载这个键坏。

- **影响**：设置页承诺的快捷方式完全不可用，且是静默失败。
- **建议修法**：同 B1；另外 bg 侧 catch 里应区分「页面没注入」（合理忽略）与「页面收到但没处理」
  （应回明确结果，必要时用 `chrome.action.setBadgeText` 提示）。

---

## 2. 严重

### S1. 页面开了两条 Job Port，bg 按 tabId 只留最后一条 —— `api.watchJobs` 永远收不到事件

- **文件:行号**：`src/kernel/messaging/port.ts:26-38`、`src/entrypoints/page.content/page-api.ts:31-45`、`src/entrypoints/page.content/controller.ts:338-359`
- **现象**：进度尚能显示（靠 controller → Shell props 那条链），但任何只订阅 `PageApi.watchJobs` 的逻辑收不到一条事件；
  而且「哪条 port 胜出」取决于连接顺序，SW 回收后两条 port 各自指数退避重连，顺序可能反转，连进度都会静默消失。
- **证据**：Port 服务端用 `Map<tabId, Port>`，后连的直接覆盖前一条：

```ts
// src/kernel/messaging/port.ts:29-39
const onConnect = (port: chrome.runtime.Port) => {
  if (port.name !== PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  if (typeof tabId !== 'number') return;
  ports.set(tabId, port);          // ← 同 tab 的第二条连接覆盖第一条
  port.onDisconnect.addListener(() => {
    if (ports.get(tabId) === port) ports.delete(tabId);
  });
};
```

而同一个页面里 `connectJobPort` 被调用了**两次**：

```ts
// src/entrypoints/page.content/page-api.ts:31  （createPageApi 在 index.tsx:49 执行）
const disconnect = connectJobPort({ onMessage(msg: PortMessage) { ... watchers ... } });

// src/entrypoints/page.content/controller.ts:338 （controller.start() 在 index.tsx:96 执行，晚于上面）
disconnectPort = connectJobPort({ onMessage: (msg: PortMessage) => { job = msg.job; notify(); ... } });
```

结果：bg 的 `ports.get(tabId)` 恒等于 controller 那条；page-api 的 watcher 集合
（`page-api.ts:21-45, 68-81`）**永远不触发**。

- **影响**：任务事件订阅语义不可靠；任何新东西只要用 `watchJobs` 就是死代码。
- **建议修法**：Port 服务端改成 `Map<tabId, Set<Port>>`（同 tab 的每条连接都推），
  或页面侧只保留**一条** port，由 page-api 收到后回调给 controller（controller 不再自己 connect）。

### S2. 入口鉴权只覆盖 6 个方法；`validatePayload` / `guardedHandler` 是死代码

- **文件:行号**：`src/entrypoints/background.ts:61-137`（无鉴权的一批）、`src/kernel/messaging/runtime.ts:164-219`（写了没人用）
- **现象**：设计约定（runtime.ts:14-18 注释）说「bg 每个 handler 入口都要 guardSender + Zod」。
  bg 在 `background.ts` 里注册了 **20 个** `onMessage` handler（`grep -c "^\s*onMessage('"` = 20），
  其中只有 6 个手写了 `guardSender`（:31 getTabState / :37 fs.status / :43 fs.openGrant /
  :56 job.submit / :72 job.retry / :78 feature.call），**其余 14 个一条都没调**。
- **证据**：

```ts
// src/entrypoints/background.ts:61-65 —— 没有 guardSender
onMessage('job.cancel', async ({ data }) => {
  await engineCall('engine.cancel', { jobId: data.jobId });
});
onMessage('job.list', async ({ data }) => listJobs(data.tabId));
```
```ts
// src/entrypoints/background.ts:87-107 —— shell.togglePanel / mobileMode / diagnostics 同样无鉴权
onMessage('shell.diagnostics', async () => buildDiagnosticsPackage());
```
```ts
// src/entrypoints/background.ts:123-137 —— grant.* 无鉴权
onMessage('grant.getInit', async () => readGrantInit());
onMessage('grant.close', async () => { await clearPendingIntent(); });
```

而 runtime.ts 里现成的包装器**零调用点**：

```
$ grep -rn "guardedHandler|guardedVoidHandler|validatePayload" src
src/kernel/messaging/runtime.ts:164:  export function validatePayload(...)
src/kernel/messaging/runtime.ts:188:  export function guardedHandler(...)
src/kernel/messaging/runtime.ts:207:  export function guardedVoidHandler(...)
src/kernel/messaging/runtime.test.ts:...   （只有测试）
```

即 `PAYLOAD_SCHEMAS`（runtime.ts:149-162）在产品代码里**从未生效**：
`job.submit` 的内容脚本 payload 不做结构校验就直接进 `buildJobRecord`。

- **影响**：内容脚本（跑在网页源里，可被页面脚本影响）能调用 `grant.*`、`job.list`、`shell.diagnostics`、
  `shell.togglePanel`、`fs.changed`；被篡改的 payload 不经校验直达 kernel。
  也是「错误被静默吞掉」的一类来源：非法 payload 不会在入口被拒并回明确错误。
- **建议修法**：bg 的 14 个未鉴权 handler 全部换成 `guardedHandler` / `guardedVoidHandler`（现成且有测试），
  删掉手写的那 6 份 guardSender；同时给 `job.cancel` / `job.list` / `fs.changed` / `grant.*` 补白名单条目。

### S3. SW 重启后的崩溃恢复只改镜像，从不通知页面 —— 「下载中断 · 继续」永远不会出现

- **文件:行号**：`src/entrypoints/background.ts:416-439`（只改镜像）、`src/entrypoints/page.content/controller.ts:356-359`（onConnect 只刷目录）
- **现象**：下载中途 SW 被回收，页面进度条停在原地；面板不会变成
  `primary-action-model.ts:323-333` 定义的「继续下载 · 上次下载中断了」。
- **证据**：恢复逻辑只写 storage.session：

```ts
// src/entrypoints/background.ts:426-435
for (const job of Object.values(mirror)) {
  if (job.status === 'running' || job.status === 'queued') {
    job.status = 'interrupted';
    changed = true;
  }
}
if (changed) {
  await chrome.storage.session.set({ [STORAGE_KEYS.jobMirror]: mirror });
  log.info('marked interrupted jobs after restart');   // ← 只写库，没有 ports.broadcast
}
```

页面侧重连后只做一件事：

```ts
// src/entrypoints/page.content/controller.ts:356-359
onConnect() {
  void refreshDir();      // 只刷目录，不拉任务
},
```

`job.list` 虽然有 handler（background.ts:65），但**全仓库没有任何调用点**：

```
$ grep -rn "'job.list'" src
src/kernel/messaging/protocol.ts:57
src/kernel/messaging/runtime.ts:38
src/kernel/messaging/runtime.test.ts:43
```

- **影响**：这是「进度不更新」在 SW 被回收后的典型形态：任务其实已中断，UI 停在旧进度，
  用户没有任何「继续下载」入口，`recoverAfterRestart` 的成果被完全浪费。
- **建议修法**：`recoverAfterRestart()` 后除了广播目录，再给受影响 tab 推一条 `{type:'job-done', job}`
  （`PortMessage` 已有该类型）；更稳的是 controller 的 `onConnect` 里补一次 `sendMessage('job.list', { tabId })` 对账。

### S4. 「导出诊断」按钮点了没反应（PARSE_EMPTY 的主按钮）

- **文件:行号**：`src/entrypoints/page.content/controller.ts:450-455`、`src/shell/BlockerNotice.tsx:35-44, 86-90`、`src/kernel/errors/messages.ts:32-36`
- **现象**：识别不到素材时面板给出阻断块，主按钮是「导出诊断」；用户点下去毫无反应。
- **证据**：`PARSE_EMPTY` 的 preset 主 action 是 `diagnostics`：

```ts
// src/kernel/errors/messages.ts:32-36
PARSE_EMPTY: {
  title: '没有在这个页面找到素材',
  hint: '页面可能还没加载完，或者平台改版了',
  action: 'diagnostics',
},
```

但 controller 的动作分发只认 4 个 id：

```ts
// src/entrypoints/page.content/controller.ts:450-455
onBlockerAction(action) {
  if (action === 'refresh') location.reload();
  else if (action === 'grant') void sendMessage('fs.openGrant', { reason: 'unset' });
  else if (action === 'reset-grant') void sendMessage('fs.openGrant', { reason: 'gone' });
  else if (action === 'retry') void evaluate();
},
```

`diagnostics` / `settings` / `mobile-mode` 全部落到「什么都不做」。
`BlockerNotice` 明知这个按钮存在（还专门为 PARSE_EMPTY 补了一个「导出诊断」副按钮，
`BlockerNotice.tsx:86-90`），但两个入口都通向同一个空实现。
bg 侧的 `shell.diagnostics` handler（background.ts:107）因此也**没有任何调用方**。

- **影响**：拼多多真实页面最常见的失败态（识别不到素材）时**唯一**提供的动作点了没反馈，
  用户也没法把现场交出来排查。
- **建议修法**：controller.onBlockerAction 补 `diagnostics` 分支：`sendMessage('shell.diagnostics')`
  → 生成 `{json}` → 用 Blob + `URL.createObjectURL` 触发下载（或复制到剪贴板并在面板内反馈）；
  `settings` → `sendMessage('shell.openOptions')`；`mobile-mode` → `sendMessage('shell.mobileMode', { tabId })`。

### S5. 弹层（Tooltip / Toast）掉出 Shadow Root：`Shell` 用一个空 PortalRoot 覆盖了外层容器

- **文件:行号**：`src/shell/Shell.tsx:149`、`src/entrypoints/page.content/index.tsx:66-71`、`src/entrypoints/page.content/controller.ts:417-473`
- **现象**：`.ec-tooltip` / `.ec-toast` 挂到 `document.body`，拿不到 shadow root 内的
  `tokens.css` / `ui-kit.css`（`index.tsx:18-19` 用 `cssInjectionMode:'ui'` 注入 shadow 内），
  于是提示气泡是裸文本、位置错乱；面板的悬停提示（保存路径全文、按钮说明）等于残废。
- **证据**：外层确实传了 shadow root：

```tsx
// src/entrypoints/page.content/index.tsx:66-71
root.render(
  createElement(PortalRoot, {
    value: shadow,                                   // ← 正确的容器
    children: createElement(ConnectedShell, { controller, api }),
  }),
);
```

但 `Shell` 内部又渲染了一层 `PortalRoot`，而 `portalContainer` 永远拿不到值
（`controller.shellProps()` 的返回对象里没有这个字段）：

```tsx
// src/shell/Shell.tsx:148-150
return (
  <PortalRoot {...(portalContainer === undefined ? {} : { value: portalContainer })}>
```
```
$ grep -rn "portalContainer" src
src/shell/Shell.tsx:38:  portalContainer?: HTMLElement | ShadowRoot;   ← 只有声明
src/shell/Shell.tsx:84:    portalContainer,                            ← 只有解构
src/shell/Shell.tsx:149: <PortalRoot {...(portalContainer === undefined ? {} : ...)}>
```

内层 `PortalRoot` 以 `value=undefined` 覆盖 context（`PortalRoot.tsx:21-27`），
`usePortalTarget()` 返回 `undefined`（`PortalRoot.tsx:39-43`），Radix 退回 `document.body`。

- **影响**：面板里所有 Tooltip 无样式；一旦修好 S6，Toast 同样不可用。
- **建议修法**：`shellProps()` 里加 `portalContainer`（index.tsx 把 shadow 传给 controller），
  或直接删掉 `Shell` 内层那层 `PortalRoot`，只保留 index.tsx 外层那一个。

### S6. PageApi.toast 没有实现注入，ToastViewport 也没挂载 —— 所有「提示」都被吞掉

- **文件:行号**：`src/entrypoints/page.content/page-api.ts:108-111, 130-136`、`src/kernel/ui-kit/Toast.tsx:31-42`、`src/kernel/ui-kit/index.ts:24`
- **现象**：`api.toast(...)` 一律只写 console，用户什么也看不到。
- **证据**：

```ts
// src/entrypoints/page.content/page-api.ts:108-111
toast(msg, opts) {
  if (toastHandler) toastHandler(msg, opts);
  else log.info('toast', { msg });     // ← 默认走这里
},
```
```ts
// src/entrypoints/page.content/page-api.ts:131-135
Object.defineProperty(api, '__setToastHandler', {   // 注入点
  value: (h) => { toastHandler = h; },
});
```
```
$ grep -rn "__setToastHandler" src
src/entrypoints/page.content/page-api.ts:131:  Object.defineProperty(api, '__setToastHandler', {   ← 只有定义，没有调用
$ grep -rn "ToastViewport" src
src/kernel/ui-kit/Toast.tsx:29,42   src/kernel/ui-kit/index.ts:24         ← 从未被渲染
$ grep -rn "showToast" src
src/kernel/ui-kit/Toast.tsx:31      src/kernel/ui-kit/index.ts:24         ← 从未被调用
```

- **影响**：这是「静默吞掉错误」最核心的一条。例如 page.tsx 的提交失败兜底
  （`page.tsx:215-216, 222-224`：`api.toast('请在弹出的小窗中选择保存位置')`、
  `api.toast('提交下载失败，请重试', { action: ... })`）在修好 S6 之前等于没写。
  （工作树里 page.tsx 已补了内联 `submitError`，面板上还能看到一行字；但 popup 等入口没有。）
- **建议修法**：在 `Shell` 里挂 `<ToastViewport/>`（放在 `PortalRoot` 内），
  并在 `page.content/index.tsx` 挂载时调 `api.__setToastHandler((msg, opts) => showToast(msg, opts?.action))`。
  更干净的是让 `PageApi.toast` 直接用 ui-kit 的 `showToast`，删掉这层注入。

### S7. 站点偏好（形态 / 把手位置 / 勾选类别）永不落盘 —— 刷新后回到默认

- **文件:行号**：`src/entrypoints/page.content/controller.ts:96-108, 440-443`、`src/kernel/settings/store.ts:203-262`、`src/shell/store.ts:207-241`
- **现象**：用户把面板收成把手、把把手拖到别处，换页面/刷新后全部复位。方案 §10.2「按站点记住」未生效。
- **证据**：controller 注入给 shell 的 PrefsPort 只写内存：

```ts
// src/entrypoints/page.content/controller.ts:102-107
set<T>(key: string, value: T): void {
  const v = value as { form?: 'hidden' | 'handle' | 'panel'; handleY?: number };
  if (v.form) uiPrefs = { ...uiPrefs, [key]: v.form };
  if (typeof v.handleY === 'number') handleYPrefs = { ...handleYPrefs, [key]: v.handleY };
  // 站点偏好落盘由 shell 的 onFormChange 触发，这里只保内存，避免每次拖动都写 storage
},
```
```ts
// src/entrypoints/page.content/controller.ts:440-443
onFormChange(form) {
  const key = siteKeyOf(location.hostname);
  uiPrefs = { ...uiPrefs, [key]: form };     // ← 仍然只是内存
},
```

而真正落盘的 `patchUiPrefs` / `readUiPrefs`（`kernel/settings/store.ts:203-239`）在入口层**零调用**：

```
$ grep -rn "readUiPrefs|patchUiPrefs|watchUiPrefs" src/entrypoints
（无输出）
```

- **影响**：`shell/store.ts:207-241` 里精心写的「只持久化用户主动选择」逻辑全部空转。
- **建议修法**：controller 的 PrefsPort 直接用 `readUiPrefs`/`patchUiPrefs`（start() 里先 await 灌内存，
  set 时异步 patch），或简单点：`onFormChange` 与 onDragEnd 里 `void patchUiPrefs({ formByPlatform: { [host]: form } })`。

### S8. 设置里的「根目录绝对路径」永远不生效 —— SaveBar 从不收到 rootPath

- **文件:行号**：`src/features/media-download/page.tsx:309-314`、`src/features/media-download/ui/SaveBar.tsx:41-66`、`src/entrypoints/options/OptionsApp.tsx:97-108`
- **现象**：用户在设置页填了 `D:\\电商素材`，点保存栏的「复制路径」，复制到的仍然只有相对路径
  （`拼多多\\xxx_482319937501`），不能直接粘到资源管理器。
- **证据**：SaveBar 支持 `rootPath`，但调用点没传：

```tsx
// src/features/media-download/page.tsx:309-314
<SaveBar
  dir={dir}
  relativePath={folderPreview}
  onOpenGrant={openGrant}
  onCopy={(text) => void api.copy(text)}
/>                                   // ← 没有 rootPath
```
```ts
// src/features/media-download/ui/SaveBar.tsx:35-39
export function fullPathFor(rootPath: string | undefined, relativePath: string): string {
  if (rootPath === undefined || rootPath.trim() === '') return relativePath;   // ← 总是走这条
  ...
}
```

`settings.save.rootPath` 只在设置页读写（OptionsApp.tsx:102-103），运行期没有任何读取方。

- **影响**：设置项形同虚设（§10.5「复制路径」承诺的是可直接粘贴的完整路径）。
- **建议修法**：把 `rootPath` 经 ShellProps（或 page.tsx 读一次全局设置）传到 SaveBar；
  或在 PageApi 上暴露一个 `readGlobalSettings()`。

---

## 3. 一般

### G1. popup 打开太早会永久误报「当前页面不是商品详情页」

- `src/entrypoints/popup/PopupApp.tsx:44-50, 80-99`
- 证据：只有 `s.matched && 正在识别` 才继续轮询——
  `const pending = s.matched && (s.status === 'detecting' || s.status === 'resolving');`（:44）。
  内容脚本还没注入完时 `getTabState` 走 bg 的 catch 分支返回 `matched:false`（`background.ts:448-455`），
  popup 立刻停止轮询并渲染「当前页面不是商品详情页」。
- 修法：把「`matched:false` 且 url 为空/未知」也纳入重试（最多约 12 秒），或让 bg 在 catch 里
  区分「未注入」与「非商品页」。

### G2. popup 的 download() 没有 try/catch，且 window.close() 在 await 之后

- `src/entrypoints/popup/PopupApp.tsx:176-185`
- `chrome.tabs.sendMessage` 在页面没注入/无监听时会 reject，未捕获 → popup 停在原地，
  用户看不到任何原因；`window.close()` 也永远不执行。
- 修法：`try { await ... } catch { /* 显示原因 */ } finally { window.close(); }`。

### G3. 设置页「文件命名」「素材」两组完全不落库

- `src/entrypoints/options/OptionsApp.tsx:113-142`（NamingSection 用本地 `useState`，没有 `setSettings`）、
  `src/entrypoints/options/OptionsApp.tsx:144-154`（MediaSection 纯文案，没有任何控件）
- 证据：`const [template, setTemplate] = useState('{title:30}_{id}');`（:116）——初始值是硬编码字符串，
  不读 `feature:media-download`，改完也不写回。
- 修法：接 `createFeatureSettings({featureId:'media-download', schema: MediaDownloadSettings, defaults})`
  的 get/set；素材组直接把现成的 `MediaDownloadSettingsSection`（page.tsx:391-493）挂进去。
  接上之前应显式标注「暂未生效」，而不是让用户以为改了。

### G4. 设置页的「调试模式」没有任何效果

- `src/entrypoints/options/OptionsApp.tsx:215-222` 写入 `settings.debug`；
  全仓库除 schema 与该控件外无读取方（`grep -rn "debug" src` 的命中都在 logger/平台层，与此设置无关）。
- 修法：要么在 logger / 面板「数据来源」处读它，要么先移除这个开关。

### G5. 切换保存方式后，页面里的面板仍显示旧目录状态

- `src/entrypoints/background.ts:48-53`（只有 `fs.changed` 才广播 `dir-changed`）、
  `src/entrypoints/page.content/controller.ts:379-382`（watchSettings 只处理 autoOpen/theme）
- 现象：设置里从「自选文件夹」切到「浏览器下载目录」后回到商品页（不刷新），保存位置栏仍显示
  「还没有选择保存位置」。offscreen 侧其实已经自动换 sink（`offscreen/main.ts:72-74, 95-112`）。
- 修法：controller 的 watchSettings 回调里比较 `save.mode`，变化时 `void refreshDir()`；
  或 bg 在 storage 变更时广播。

### G6. 读屏器播报从未触发（LiveRegion 没有调用方）

- `src/shell/LiveRegion.tsx:46-57`（`useAnnounce` / `useLiveMessage`）
- `grep -rn "useAnnounce|useLiveMessage" src` 只有定义，没有任何组件使用；Shell 挂了 Provider 但没有消费者。
- 影响：§10.5「下载完成不弹 Toast 也不发系统通知」的读屏器补偿路径不存在；与 S6 叠加后两条反馈通道全断。
- 修法：在 page.tsx 用 `useLiveMessage(...)` 播报「开始下载 / 已保存 N 个文件 / 有 M 个失败」。

### G7. `shell.mobileMode` 的返回类型与协议不一致

- `src/kernel/messaging/protocol.ts:61` 声明 `: void`，`src/entrypoints/background.ts:101-104` 返回
  `{ supported: false }`。运行时无害，但类型契约已漂移，且 UI 没有调用方
  （BlockerNotice 的 mobile-mode 按钮在抖音上被 `supportsMobileMode=false` 屏蔽）。
- 修法：协议改成 `(): { supported: boolean }`，并把 BlockerNotice 的 mobile-mode 分支接上。

### G8. `shell.pushTabState` 的语义与协议不符

- `src/kernel/messaging/protocol.ts:50` 声明收 `TabState`，`src/entrypoints/background.ts:96-98` 却只取
  `data.dir` 再广播成 `dir-changed`。名字说「推 Tab 状态」，实际只做目录广播，且没有调用方。
- 修法：改名（`shell.pushDir`）或实现它该做的事；没有调用方就删掉，避免下一个人误以为它可用。

---

## 4. 轻微

| # | 位置 | 问题 | 修法 |
| --- | --- | --- | --- |
| T1 | `kernel/messaging/runtime.ts:136,176-180`；`entrypoints/background.ts:65` | `JobListSchema` 允许无参，但 bg handler 直接 `data.tabId`；若调用方不带 payload，`data` 为 undefined 会抛 TypeError（目前无调用方，补 S3 时会踩到） | `listJobs(validateJobList(data).tabId)` |
| T2 | `shell/Panel.tsx:104-108` | `top: Math.max(PANEL_GAP, Math.min(top, 24))` 把面板恒定压到 24px，与「顶部和把手对齐」（注释 §10.2）自相矛盾 | 用 `clamp(top, PANEL_GAP, 视口高 - 面板最小高度)` |
| T3 | `shell/FeatureTabs.tsx:20-22` vs `76-82` | 渲染用 `features.length <= 1`，而 `shouldRenderTabs`/`panelFeatures` 用「有 panel 的功能数」；两个判定源，将来多一个纯后台功能就会错位 | 统一走 `panelFeatures(features).length` |
| T4 | `entrypoints/background.ts:225-240` | `ensureOffscreen` 把一切异常都当「已在创建中」`log.debug` 吞掉；真正的创建失败（无 offscreen 支持等）不上报，上层只会拿到后续 Could not establish connection | 区分「已在创建」（可忽略）与其他错误（记录并让 UI 可见） |
| T5 | `shell/Handle.tsx:123-161` | 把手根元素没有 `data-ecbox-handle` 之类稳定钩子，而 `docs/ACCEPTANCE.md:14` 的 A1 用例按 `[data-ecbox-handle]` 断言（全仓库无此属性） | 给把手/面板加 `data-ecbox-handle` / `data-ecbox-panel` |

---

## 5. 必须修（阻断 / 严重）精简清单

1. **B1** `popup/PopupApp.tsx:176-185` + `controller.ts:362-377` — 补 `ecbox:command` 接收端，接上 `PageFeature.onCommand`。
2. **B2** `background.ts:145-152` — 同 B1，Alt+Shift+D 才有意义。
3. **S6** `page-api.ts:108-111` + `Toast.tsx` — 挂 `<ToastViewport/>` 并注入 toast handler，否则所有错误提示仍是静默的。
4. **S5** `Shell.tsx:149` — 把 shadow root 传到 Shell（或删掉内层 PortalRoot），否则弹层无样式。
5. **S2** `background.ts:61-137` — 14 个未鉴权 handler 统一换成现成的 `guardedHandler`；否则 `validatePayload` 永远不生效。
6. **S1** `port.ts:26-38` + 两处 `connectJobPort` — Port 必须按 tab 支持多条，或页面只留一条。
7. **S3** `background.ts:416-439` + `controller.ts:356-359` — 恢复后要 push 给 tab；`onConnect` 补 `job.list` 对账。
8. **S4** `controller.ts:450-455` — `diagnostics` / `settings` / `mobile-mode` 三个动作补实现。
9. **S7** `controller.ts:96-108` — 站点偏好接 `patchUiPrefs`，否则「按站点记住」是假的。
10. **S8** `page.tsx:309-314` — 把 `settings.save.rootPath` 传到 SaveBar。

---

## 附 A. 工作树里已修的（不重复计入清单，仅备忘）

以下问题在**当前工作树（未提交）**里已有对应改动，我按 `git diff` 确认过，供 Lead 判断是否已覆盖：

| 项 | HEAD 状态 | 工作树现状 |
| --- | --- | --- |
| `job.retry` 无 handler（点「重试 N 个失败项」报 Could not establish connection） | 无该 handler | `background.ts:67-75` 已注册并转发到 offscreen 的 `__runtime__.retry` |
| offscreen 的 engine.* 完全不鉴权 | 全裸 | `offscreen/main.ts:157-166` 的 `assertTrusted` |
| `tabId` 没写进 JobRecord → 进度推不回页面 | `buildJobRecord` 只读 `p.tabId` | `background.ts:250-306` 用 `p.tabId ?? sender.tab?.id` |
| offscreen 先 await 初始化才注册 handler → 抢跑报错 | 顺序错 | `offscreen/main.ts:40-122, 143-207` 改为先注册、memo 初始化 |
| engine `run` 里 `dir.slice(0,-1)` 算错落盘目录 | 有 | `engine.ts:66-68, 107-159` 已改 `itemTargetDir` |
| 页面 payload 缺 `platformDisplayName` | 缺 | `features/media-download/payload.ts` 单一 schema + `page.tsx:200-211` 用它构造 |
| 引擎启动后不再响应保存方式切换 | 只读一次设置 | `offscreen/main.ts:72-74, 95-112` 加了 `watchSettings` |

## 附 B. ProtocolMap × handler × 鉴权 对照表

| 方法 | handler | 位置 | 入口鉴权 | payload 校验 |
| --- | --- | --- | --- | --- |
| shell.getTabState | ✅ | background.ts:30 | ✅ guardSender | ❌（validatePayload 未生效） |
| shell.pushTabState | ✅ | background.ts:96 | ❌ | ❌ |
| fs.status | ✅ | background.ts:36 | ✅ | — |
| fs.openGrant | ✅ | background.ts:42 | ✅ | ❌ |
| fs.changed | ✅ | background.ts:48 | ❌ | ❌ |
| job.submit | ✅ | background.ts:55 | ✅ | ❌ |
| job.cancel | ✅ | background.ts:61 | ❌ | ❌ |
| job.retry | ✅（工作树新增） | background.ts:71 | ✅ | ❌ |
| job.list | ✅ | background.ts:65 | ❌ | ❌（且无调用方） |
| feature.call | ✅ | background.ts:77 | ✅ | ❌ |
| shell.togglePanel | ✅ | background.ts:87 | ❌ | ❌ |
| shell.openOptions | ✅ | background.ts:91 | ❌ | — |
| shell.mobileMode | ✅ | background.ts:101 | ❌ | ❌（返回值类型与协议不符） |
| shell.diagnostics | ✅ | background.ts:107 | ❌ | — |
| grant.getInit / persisted / close | ✅✅✅ | background.ts:123-137 | ❌❌❌ | ❌ |
| engine.enqueue / cancel / call / fsStatus / fsChanged | ✅✅✅✅✅ | offscreen/main.ts:143-207 | ✅ assertTrusted（工作树） | — |
| engine.event / engine.ready | ✅✅ | background.ts:109, 119 | ✅（手写 url 判定） | — |

**没有任何方法「声明了却无人注册」**；问题集中在鉴权覆盖面与发送侧无接收方。

## 附 C. 审计边界

- 未修改 `src/`、未运行 `pnpm build`、未触碰 `D:\Tools\EcBox` 与 `.output/`；唯一写入的文件是本文件。
- 只做过验证性读操作：`pnpm compile`（确认工作树类型状态，报错点全在 `test/__audit_probe*.test.ts`
  这类会话临时文件里，与 `src/` 无关）与 `pnpm vitest run src/kernel/messaging/runtime.test.ts`（22 passed）。
- 功能层 / 内核层 / 平台适配器的结论不在此文范围（见 task-2 / task-3）。
