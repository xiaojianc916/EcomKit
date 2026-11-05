# 审计 C：功能层 + 面板 UI + 文档承诺（task-3）

- 审计对象：`D:\EcomKit`（WXT + React 19 + Chrome MV3 扩展「电商素材工具箱」）
- 范围：`src/features/**`（media-download 的 page / engine / service / planner / UI、registry.*、types）、`src/shell/*` 与功能面板的交界处、`docs/ACCEPTANCE.md`、`docs/INSTALL.md`、`README.md` 里**用户能感知的承诺**
- 方式：**只读**。未修改任何 `src/` 文件，未运行 `pnpm build`，未触碰 `D:\Tools\EcBox` 与 `.output/`。唯一写入的文件是本文件。临时 vitest 探针用完即删（见文末附表）。
- 所有结论都给出 `文件:行号` + 代码证据，不做猜测。

---

## 重要：行号基线说明

审计从 01:28 开始，工作树当时干净，HEAD = `f22bc77`。**审计期间 Lead 在并发修复同一批文件**：01:58 起 `payload.ts` 新增，`engine.ts` / `page.tsx` / `background.ts` / `offscreen/main.ts` / `port.ts` / `Shell.tsx` / `runner.ts` / `OptionsApp.tsx` 持续被改；到 02:30 工作区已有 20+ 文件被修改，行号仍在漂移。

因此本文采用**双基线**，保证读完不会失效：

- **`[HEAD f22bc77]`** —— 用户报告故障时的代码，行号**永久稳定**（`git show HEAD:<file>` 可复现）。**所有结论的主基线**。
- **`[WIP 02:30]`** —— 我核验时的工作区状态，只用来标注「修没修」，**不引用具体行号**（会漂）。

每条都带**当前状态**：`✅ 已修` / `❌ 仍存在`（核验时刻 **02:35**）。状态判定方法见 §8 的复核命令——**你复核时请重新跑一遍**，WIP 可能已继续推进。

---

## 0. 结论速览

| # | 严重度 | 一句话 | HEAD 行号 | 02:30 状态 |
| --- | --- | --- | --- | --- |
| C1 | 阻断 | 提交失败对用户完全不可见（Toast 从未挂载 + 面板无错误位） | `page.tsx:207-232`、`page-api.ts:108-111,131`、`Shell.tsx`（HEAD 无 ToastViewport） | ✅ 已修 |
| C2 | 阻断 | 重试任务的 dedupeKey 加了后缀，`watchJobs` 过滤后进度推不回来 | `runner.ts:495`、`page-api.ts:37` | ✅ 已修 |
| C3 | 严重 | 主按钮三个分支写死 `null/0/false`，永远不出现（含「授权等待中」态） | `page.tsx:182,183,188` | ❌ 仍存在 |
| C4 | 严重 | 「已保存 N 个」只数 done，跳过的不算 → 重复下载显示「已保存 0 个」 | `primary-action-model.ts:297` | ✅ 已修 |
| C5 | 严重 | 进度态按钮体积拼两遍（探针实证） | `primary-action-model.ts:278` + `PrimaryAction.tsx:55` | ✅ 已修 |
| C6 | 严重 | 「下载 N 个文件」的 N 来自快照总数，不是计划条数（探针实证 3 vs 2） | `page.tsx:114`（`countByKind`） | ✅ 已修 |
| C7 | 严重 | 历史「补全 N 个文件」永久误报（期望用了全部快照 key，探针实证） | `page.tsx:163`、`engine.ts`（HEAD 无 historyGet） | ✅ 已修 |
| C8 | 严重 | 7 个媒体设置项在 UI 上**没有入口** | `OptionsApp.tsx:144-154`、`page.tsx:391,503` | ✅ 已修 |
| C9 | 一般 | popup 勾选框纯装饰，主按钮永远按「全选」下发 | `PopupApp.tsx:26,101,182` | ✅ 02:35 已修（`download([kind])` 已带 kinds） |
| C10 | 一般 | 「重试失败项」在 runner 拒绝时静默退化成整单重提 | **WIP 新引入**（HEAD 无 `retryOrResubmit`） | ❌ 仍存在 |
| C11 | 一般 | 取消后「继续下载」产生 `01 (2).webp` 副本 | `runner.ts:374`（`if (!wasCanceled && job.def.finalize)`） | ✅ 已修 |
| C12 | 一般 | 「跳过 N 个 / 已存在」永远不显示：`skippedByKind` 从未传入 | `AssetList.tsx:27,89` | ✅ 已修 |
| C13 | 一般 | SPA 切商品后仍显示上一个商品的进度/失败 | `controller.ts:81,191-200` | ✅ 02:35 已修（重置块加了 `job = null`） |
| C14 | 一般 | 失败列表逐项「重试」与「重试全部」行为完全相同 | `FailureList.tsx:99`、`page.tsx:331-336` | ❌ 仍存在 |
| C15 | 一般 | 复制完整路径依赖 `rootPath`，为空时无任何引导 | `SaveBar.tsx:35-39` | ❌ 仍存在 |
| C16 | 轻微 | `<li>` 嵌套 `<li>` | `AssetList.tsx:78` → `AssetRow.tsx:94` | ✅ 已修 |
| C17 | 轻微 | `onConflict` 设置项无读取点 | `settings.ts:33` | ❌ 仍存在 |
| C18 | 轻微 | `settings.debug` / `platforms.enabled` 无读取点 | `OptionsApp.tsx:218` | ❌ 仍存在 |
| C19 | 轻微 | 死接口（`enterPicking`/`clearKindSelection`/`isPicking`/`planCounts`/`failuresByKind`/`brokenManifestName`） | 见 §3 | ❌ 仍存在 |
| C20 | 轻微 | `prefs` 只存内存，刷新即丢（跨会话「记住勾选」不成立） | `page-api.ts:26,117-127` | ❌ 仍存在 |
| C21 | 轻微 | 挑选模式下无文案说明「只下选中的、忽略勾选类别」 | `primary-action-model.ts:427-438` | ❌ 仍存在 |

**关键判断**：用户报告的「点『下载 24 个文件』完全没反应」，在 `[HEAD]` 上由**四条独立链路**同时断裂造成：

1. payload 缺 `platformDisplayName` → 引擎在 plan 之前整单拒收（Lead 已确认）；
2. 页面把异常吞进一个**从未渲染**的 Toast（C1）；
3. `JobRecord` 没有 `tabId` → bg 的 `handleEngineEvent` 直接丢弃进度事件（`background.ts:214,224`）；
4. 双 Port 互相覆盖（审计 A）+ 重试 dedupeKey 不匹配（C2）。

①②③④ 现在都已修。但有两点必须提醒：

- **C3 会让修复效果打折**：授权等待期间主按钮仍可点、文案不变，用户会以为卡住；
- **C10 是这轮 WIP 新引入的回归**（HEAD 上不存在），建议在合并前修掉，否则等于用一个新 bug 换旧 bug。

---

## 1. 阻断（C1/C2 均已在工作区修复；保留作为根因记录 + 回归清单）

### C1【阻断｜已修】提交失败对用户完全不可见

**HEAD 行号**：`page.tsx:207-232`（submit）、`page-api.ts:108-111`（toast）、`page-api.ts:131`（setter）、`Toast.tsx:42`（组件）、`Shell.tsx`

**原症状**：点主按钮后只要 `submitJob` 抛错，页面**一个像素都不变**。

**原证据 1 —— toast 落到空指针**：

```ts
// HEAD src/entrypoints/page.content/page-api.ts:108-111
toast(msg, opts) {
  if (toastHandler) toastHandler(msg, opts);
  else log.info('toast', { msg });   // ← 没有 handler 时只写日志，用户看不到
},
// HEAD :131  handler 只能由外部注入
Object.defineProperty(api, '__setToastHandler', { value: (h) => { toastHandler = h; } });
```

而 HEAD 上**没有任何地方调用** `__setToastHandler`：

```powershell
git grep -n '__setToastHandler' HEAD -- src
# HEAD:src/entrypoints/page.content/page-api.ts:131   ← 只有定义，零调用
```

**原证据 2 —— `ToastViewport` 从未渲染**：

```powershell
git grep -n 'ToastViewport' HEAD -- src
# HEAD:src/kernel/ui-kit/Toast.tsx:29   （注释）
# HEAD:src/kernel/ui-kit/Toast.tsx:42   （定义）
# HEAD:src/kernel/ui-kit/index.ts:24    （再导出）
# → Shell.tsx 里没有，等于没有落点
```

**原证据 3 —— 面板没有错误位**：`PrimaryActionModel`（`primary-action-model.ts:47-62`）**没有 error 字段**，`PrimaryAction.tsx` 也没有 error 分支。面板结构上无法显示「为什么没开始」。

**原证据 4 —— 提交路径本身也不传 tabId**：`page-api.ts:51-56` 只发 `type/payload/dedupeKey/label`，没有 `tabId`。

**修复现状**：`index.tsx` 注入 `__setToastHandler` → `showToast`；`Shell.tsx` 渲染 `<ToastViewport />`；`page.tsx` 新增 `submitting` / `submitError`，catch 里同时写状态与 toast；`PrimaryAction.tsx` 新增 `role="alert"` 错误行。
**回归建议**：给 `MediaDownloadPanel` 加组件测试——`submitJob` reject，断言面板出现 alert 文案（现有 `page.test.tsx` 未覆盖失败路径）。

### C2【阻断｜已修】重试任务的 dedupeKey 变了，进度推不回来

**HEAD 行号**：`page-api.ts:37`（过滤）、`runner.ts:495`（重试换 key）、`page.tsx:147`（订阅）

```ts
// HEAD page-api.ts:35-38  —— 严格相等过滤
for (const w of watchers) {
  if (msg.job.type !== w.filter.type) continue;
  if (w.filter.dedupeKey && msg.job.dedupeKey !== w.filter.dedupeKey) continue;

// HEAD page.tsx:147  —— 订阅用 "pinduoduo:4823…"
const dedupeKey = `${snapshot.platform}:${snapshot.productId}`;

// HEAD runner.ts:495  —— 重试却拼了后缀
dedupeKey: record.dedupeKey + '#retry-' + now(),
```

重试任务永远匹配不上订阅，`continue` 跳过所有 watcher。
**修复现状**：`runner.ts` 的重试改为沿用 `record.dedupeKey`（原值）。

---

## 1.5 payload 逐字段对照（检查点 1，HEAD 基线）

任务描述点名要求「把两边的字段表列出来做对照」。HEAD 上共有 **3 个**页面侧构造点，只有 1 个传了 `settings`，**0 个**传了 `platformDisplayName`。

### 引擎侧 schema（唯一的权威定义）

```ts
// HEAD src/features/media-download/engine.ts:25-33
const PayloadSchema = z.object({
  snapshot: z.unknown(),                        // ① 必填
  selection: z.object({                         // ② 必填
    kinds: z.array(z.enum(['main', 'sku', 'detail', 'video'])),
    keys: z.array(z.string()).optional(),
  }),
  settings: z.unknown(),                        // ③ 必填（z.unknown() 意味着**不校验内容**，只需存在）
  platformDisplayName: z.string(),              // ④ 必填
});
```

### 三个构造点 vs schema

| 字段 | schema 要求 | ① 主按钮 `submit()`<br>`page.tsx:210-218` | ② 快捷操作"全部"<br>`page.tsx:373` | ③ 快捷操作"单类"<br>`page.tsx:384` |
| --- | --- | --- | --- | --- |
| `snapshot` | 必填 | ✅ `snapshot` | ✅ `snap` | ✅ `snap` |
| `selection.kinds` | 必填 | ✅ `[...kinds]` | ✅ `kinds` | ✅ `[kind]` |
| `selection.keys` | 可选 | ✅ 条件展开 | ❌ 未传（可接受） | ❌ 未传（可接受） |
| `settings` | **必填** | ✅ `settings` | ❌ **缺失** | ❌ **缺失** |
| `platformDisplayName` | **必填** | ❌ **缺失** | ❌ **缺失** | ❌ **缺失** |

### 后果

`runner.ts` 在 plan 之前先 `def.payload.parse(payload)`，失败就抛 `EcError('INTERNAL', {reason:'payload-invalid'})`：

```ts
// HEAD src/kernel/jobs/runner.ts:410-417（parse 在 :413，throw 在 :416）
let parsed: unknown;
try {
  parsed = def.payload.parse(payload);          // :413
} catch {
  log.warn('任务参数不合法，拒绝提交', { type: record.type });
  throw new EcError('INTERNAL', { reason: 'payload-invalid' });   // :416
}
```

于是：

- **主按钮 / 行内下载**（走 ①）→ 缺 `platformDisplayName` → **整单拒收**（Lead 已确认，这是用户报告的主症状）；
- **快捷操作**（走 ②③）→ 同时缺 `settings` 和 `platformDisplayName` → **两处都拒收**，且它们连 `dedupeKey`/`label` 都没传——`page-api.ts:49-50` 会用 `controller.current()` 兜底 dedupeKey（`const dedupeKey = opts?.dedupeKey ?? (current ? current.platform + ':' + current.productId : '')`），但 **payload 缺的字段不会因此补上**。

**修复现状（02:35）**：新增 `payload.ts` 作为**页面与引擎共用的唯一 schema**，`buildMediaDownloadPayload()` 在页面侧 `parse` 一次（字段缺失当场抛错）、引擎入口再 `parse` 一次。三个构造点全部改用它。

---

## 2. 严重

### C3【严重｜仍存在】主按钮三个分支写死成常量，永远不会出现

**HEAD 行号**：`src/features/media-download/page.tsx:175-190`（组装 `actionState`）

```ts
// HEAD src/features/media-download/page.tsx:176-190
const actionState: PrimaryActionState = {
  status: status === 'resolving' ? 'resolving' : 'ready',
  dir: dir.status,
  counts,
  selectedKinds: [...sync.checkedKinds],
  selectedKeys: [...sync.selectedKeys],
  job: sync.job,
  otherTabJob: null,        // :182  ← 永远 null
  queuedAhead: 0,           // :183  ← 永远 0
  history: ...,
  grantPending: false,      // :188  ← 永远 false
  now,
};
```

对应死分支：

| 分支 | 期望行为 | 实现位置（HEAD 行号稳定） | 实际 |
| --- | --- | --- | --- |
| `grantPending` | 「请在弹出的窗口中选择文件夹」+ 右侧「取消」 | `primary-action-model.ts:244-255` | 恒 false，永不显示 |
| `otherTabJob` | 「正在其他标签页下载 12/48」 | `primary-action-model.ts:258-270` | 恒 null，永不显示 |
| `queuedAhead` | 「排队中 · 前面还有 N 个任务」 | `primary-action-model.ts:283-291` | 恒 0，只显示「排队中」 |

**为什么这是「以为没反应」的一部分**：`grantPending: false` 意味着**用户在授权小窗里操作期间，主按钮仍然可点、文案仍是「选择保存位置并下载」**。用户点一次 → 弹窗 → 面板毫无变化 → 再点 → `openGrant` 又把小窗聚焦一次。用户看到的是「我点了、弹了个窗、面板还让我点」。而 `submit` 拿到 `{waiting:'dir'}` 时是能知道这件事的（`page.tsx:219-223`），只是没记下来。

**修法**：`submit` 的 `waiting === 'dir'` 分支里置 `grantPending = true`，收到 `dir-changed` 或 5 秒超时后置 false。`otherTabJob`/`queuedAhead` 从 `api.call('job.list')` 算——bg 已有 `job.list` handler（`background.ts:63`），**页面侧从未调用过**。

### C4【严重｜已修】「已保存 N 个文件」只数 done，跳过的不算

**HEAD 行号**：`src/features/media-download/primary-action-model.ts:292-308`（尤其 `:297`）、`engine.ts:88-136`（skip 走 `skipped`）

```ts
// HEAD primary-action-model.ts:296-306
return {
  label: `已保存 ${currentJob.done} 个文件`,   // ← 只算 done，不含 skipped
  ...
  meta: [completedMeta(currentJob)],              // :159-165 "跳过 N 个 · 2 MB · 用时 …"
};
```

第二遍下载同一商品（全部命中增量跳过）时，任务状态是 `done`，但主按钮显示「已保存 **0** 个文件」，附加说明却是「跳过 24 个 · 0 B · 用时 …」。同一函数里 `jobCounts`（`:138-141`）明明已经 `const done = j.done + j.skipped`，却没用在完成态文案上——两套算法。
**修复现状**：完成态改为 `const saved = currentJob.done + currentJob.skipped`。

### C5【严重｜已修】进度态按钮文案把体积拼了两遍（探针实证）

**HEAD 行号**：`primary-action-model.ts:278` + `ui/PrimaryAction.tsx:54-55` + `page.tsx:322`

**证据**（临时组件测试实测，探针已删）：

```
PROGRESS TEXT = "下载中 6/24 · 2 MB · 2 MB取消"
```

```ts
// HEAD primary-action-model.ts:277-278  —— label 里已经带了体积
return progressModel(
  `下载中 ${formatCount(c.done, c.total)} · ${formatBytes(currentJob.bytes)}`,

// HEAD ui/PrimaryAction.tsx:54-55  —— 渲染时又拼了一次
{label}
{bytes !== undefined ? ` · ${formatBytes(bytes)}` : ''}

// HEAD page.tsx:322  —— 上层确实传了 bytes
{...(sync.job === null ? {} : { bytes: sync.job.bytes })}
```

**修复现状**：`PrimaryAction.tsx` 改成「只有在 label 里不含该体积时才补」。
**回归提示**：这是**文案契约**变更，`primary-action-model.test.ts` 里对 label 的断言要同步。

### C6【严重｜已修】「下载 N 个文件」的 N ≠ 实际写入数

**HEAD 行号**：`page.tsx:114`（N 的来源）、`planner.ts:89-94,149-200`（计划）

**证据（探针实证，已删）**：

```
BUTTON SAYS = 3 | PLAN ITEMS = 2 | itemKeys = main:m0,detail:d0
```

```ts
// HEAD page.tsx:114  —— N 完全不知道 planner 的规则
const counts = useMemo(() => countByKind(snapshot), [snapshot]);

// HEAD planner.ts:161  —— 详情图按宽度过滤，直接 continue，不进 items
if (!passesDetailFilter(asset, settings.detailMinWidth, kind)) continue;
// planner.ts:143-147 —— 同 itemKey 去重
const push = (item) => { if (seen.has(item.itemKey)) return; ... };
// planner.ts:185-198 —— videoCover 打开时会**多**生成封面条目
```

`planner.ts:209` 的 `planCounts(plan)` 早已导出，但生产零调用。
**修复现状**：`counts` 改为对 `planDownload(...).items` 按 group 计数。

### C7【严重｜已修】历史「补全 N 个文件」永久误报

**HEAD 行号**：`page.tsx:163`（期望）、`service.ts:30-48`（转发）、`engine.ts`（HEAD 无 `historyGet`）

**证据（探针实证，已删）**：完全下载成功后 `MISSING = ["detail:d1"]`（被 `detailMinWidth` 过滤掉的那张永远算缺失），于是面板长期显示「补全 1 个文件」，点下载也清不掉——死循环。

```ts
// HEAD page.tsx:163  —— 只传 productId，引擎拿不到期望集合
const raw = await api.call('history.get', { productId: snapshot.productId });
```

且 HEAD 上这条链路**根本走不通**：`service.ts` 的实现（`:27-49`）会 `sendMessage('engine.call')`，但 HEAD 的 `engine.ts` **没有 `methods` 字段**（`export default { jobTypes }`），且 `registry.service` 从未被 bg import → 必抛 `no engine method`，被 `page.tsx:165-168` 静默吞掉。
**修复现状**：页面改为传 `planned.items.map(i => i.itemKey)`；engine 新增 `historyGet` 并用 `findProductFolder` 定位目录。

### C8【严重｜已修】7 个媒体设置项在 UI 上没有入口

**HEAD 行号**：`OptionsApp.tsx:144-154`（假的「素材」分组）、`page.tsx:391-493`（`MediaDownloadSettingsSection` 定义）、`page.tsx:503`（挂到 manifest）

`settings.ts:27-44` 定义 9 个设置项，其中 7 个（`byPlatform`/`folderTemplate`/`dirNames`/`toJpeg`/`infoTxt`/`videoCover`/`detailMinWidth`）在 HEAD 上无法修改：

```powershell
git grep -n 'SettingsSection' HEAD -- src ':!*.test.*'
# HEAD:src/features/types.ts:67                      （声明）
# HEAD:src/features/media-download/page.tsx:391      （定义）
# HEAD:src/features/media-download/page.tsx:503      （挂到 manifest）
# → 没有第四处：设置页不读它
```

```tsx
// HEAD src/entrypoints/options/OptionsApp.tsx:144-154
function MediaSection() {
  return (<>
    <h1 className="opt__h">素材</h1>
    <p className="opt__desc">这些设置针对「素材下载」功能，保存在该功能自己的配置里。</p>
    <p className="opt__hint">可配置项：WebP / AVIF 转成 JPG、生成商品信息.txt、……</p>
  </>);
}
```

同页 `NamingSection`（HEAD `:113-142`）也是假的：`:116` `useState('{title:30}_{id}')`，`:128` 只改本地 state，**不写 storage**。
落库函数 `readFeatureSettings`/`writeFeatureSettings`（`kernel/settings/store.ts:270-280`）在 HEAD 上生产零调用。

**修复现状**：`OptionsApp.tsx` 现在会懒加载 `feature.page` 并渲染 `mod.default.SettingsSection`。

### C9【一般｜已修（02:35）】popup 勾选框纯装饰

**HEAD 行号**：`src/entrypoints/popup/PopupApp.tsx:26,101,182`

```tsx
const [checked, setChecked] = useState<Set<AssetKind>>(new Set(KIND_ORDER));   // :26 默认全选
const total = KIND_ORDER.reduce((sum, k) => sum + (checked.has(k) ? counts[k] : 0), 0); // :101 数字会变
onClick={() => void download()}                                               // :147 不带勾选
// :182
command: only ? `download-${only}` : 'download-checked',
```

**两个基线下都是坏的，但坏法不同：**

- `[HEAD f22bc77]`：popup 发 `ecbox:command`，而内容脚本侧**根本没有监听器**（`git grep -n 'ecbox:command' HEAD -- src` 只命中 `background.ts:116` 和 `PopupApp.tsx:181` 两个发送方；`git grep -n 'handleCommand' HEAD -- src` **零命中**）。点下去**什么都不会发生**——这是审计 A 的阻断项 B1，本文不重复派活。
- `[WIP 02:30]`：监听器补上了，但 `download-checked` 与 `download-all` 都映射到 `media-download.all`，于是**勾选框变成了纯装饰**：取消勾选「视频」后按钮显示「下载 26 个文件」，点下去仍然下全部。**数字是骗人的**。

**修法**：`download()` 带 `kinds` 参数并新增命令分支；或去掉 popup 的勾选框只留单类下载（更诚实）。

**修复现状（02:35）**：`download([kind])` 已带 kinds，popup 勾选框不再是装饰。

### C10【一般｜WIP 新引入的回归，非 HEAD 问题】「重试失败项」在 runner 拒绝时静默退化成整单重提

**注意**：这条**不是** `HEAD f22bc77` 的问题——HEAD 上 `git grep -n 'retryOrResubmit' HEAD -- src` **零命中**，重试是直接调 `api.retryJob`。它是 02:30 的工作区在修「重试点了没反应」时**新引入**的：

```ts
// [WIP] page.tsx —— 新增的 fallback
const retryOrResubmit = (jobId, fallback) => { void (async () => {
  try { const res = await api.retryJob(jobId, 'failed'); if (res === undefined || res === null) fallback(); }
  catch { fallback(); }
})(); };
```

而 runner 在「没有失败记录」或「任务还在跑」时返回 `null`（`runner.ts:510-511`，HEAD 与 WIP 一致：`if (!hasFailures) return null; if (record.status === 'running' || record.status === 'queued') return null;`）。

于是三处调用（`retry-failed` 主按钮、失败列表的 `onRetry`/`onRetryAll`、行内「重试」）在「部分失败」态连点两次时：第一次清空了 `failed`，第二次 `retryJob` 返回 null → `fallback()` → 把**整个商品**重下一遍（有增量跳过时全 skip，但会刷出新任务、面板被打回进度态，看起来像「点了重试，整个重来」）。

**修法**：fallback 前判 `sync.job.failed.length > 0`；为 0 就不发命令，改 `api.toast('没有需要重试的文件')`。**这条建议在合并 WIP 前修掉**，否则等于用一个新 bug 换了旧 bug。

### C11【一般｜已修】取消后「继续下载」产生 `01 (2).webp` 副本

**HEAD 行号**：`runner.ts:374`（`if (!wasCanceled && job.def.finalize)`）、`engine.ts:138-176`（finalize）、`page.tsx:243-246`（resume）

**证据**：

```ts
// HEAD runner.ts:374  —— 取消的任务不执行 finalize
if (!wasCanceled && job.def.finalize) { ... }

// HEAD page.tsx:243-246  —— 但「继续下载」只是重新提交
case 'resume':
case 'retry-failed':
  if (sync.job !== null) void api.retryJob(sync.job.id, 'failed');
```

取消时已落盘的文件没进 `.ecbox.json` → 再提交时增量判断查不到记录 → 重下 → `resolveName` 撞名 → `01 (2).webp`。（与审计 B 的 B3 同源，此处补充**面板侧的后果**。）
**修复现状**：`finalize` 改成无条件执行（只记录 `status==='ok'` 的结果，取消时只补记真正写完的那些）。

### C12【一般｜已修】「✓ N · 已存在」永远不显示：`skippedByKind` 从未传入

**HEAD 行号**：`ui/AssetList.tsx:27,49,89`、`page.tsx:286-310`

`AssetList` 声明了 `skippedByKind?: Partial<Record<AssetKind, number>>`（`:27`），传给 `AssetRow` 的 `skippedCount`（`:89`）；`AssetRow` 用它在完成态区分 `✓ 26 · 已存在`（`asset-row-model.ts:117-124`）。但 HEAD `page.tsx:286-310` 的 `<AssetList ...>` 没有这个 prop：

```powershell
git show HEAD:src/features/media-download/page.tsx | Select-String 'skippedByKind'   # 期望：无输出
```

**影响**：重复下载时每行只显示「✓ 26」，不显示「已存在」，用户无法区分「这次下的」和「上次就在的」。
**修复现状**：`page.tsx` 从 `sync.job.byGroup[kind]?.skipped` 算出来传入。

---

### C13【一般｜已修（02:35）】SPA 切商品后仍显示上一个商品的进度/失败

**HEAD 行号**：`controller.ts:81`（`let job`）、`:191-200`（切商品重置块）

```ts
// HEAD src/entrypoints/page.content/controller.ts:191-200
// 新商品：丢弃上一轮会话（§7.2 第 1 点）
abort?.abort();
bridge?.dispose();
abort = new AbortController();
match = { platform: hit.platform.id, pageKind: hit.kind, productId: hit.productId };
manifest = hit.platform;
snapshot = null;
blocker = null;
completeness = 'full';
status = 'detecting';
// ← 没有 job = null；let job 定义在 :81
```

`shellProps` 把 `job` 原样下传 → `page.tsx:142-144` 的 effect 只在新值 `!== undefined` 时 `setJob`。切到商品 B 后，面板要等下一条 Port 事件才会变。
**修法**：重置块里加 `job = null`；effect 改成无条件 `setJob(jobFromShell ?? null)`。

**修复现状（02:35）**：重置块已加 `job = null`。

### C14【一般｜仍存在】失败列表逐项「重试」与「重试全部」行为完全相同

**HEAD 行号**：`FailureList.tsx:99`、`page.tsx:326-338`

```tsx
// HEAD FailureList.tsx:99  —— 传了 itemKey
<Button variant="link" onClick={() => onRetry(item.itemKey)}>重试</Button>

// HEAD page.tsx:331-336  —— 两个回调逐字相同，itemKey 被丢弃
onRetry={() => {
  if (sync.job !== null) void api.retryJob(sync.job.id, 'failed');
}}
onRetryAll={() => {
  if (sync.job !== null) void api.retryJob(sync.job.id, 'failed');
}}
```

runner 的 `retry(jobId,'failed')` 本来也只支持「全部失败项」（HEAD `runner.ts:484-503`）。UI 承诺了做不到的粒度。
**修法**：去掉逐项按钮，或 disabled + tooltip「暂只支持全部重试」。

### C15【一般｜仍存在】复制完整路径依赖 `rootPath`，为空时无任何引导

**HEAD 行号**：`SaveBar.tsx:35-39,46,66`

```ts
// HEAD src/features/media-download/ui/SaveBar.tsx:35-39
export function fullPathFor(rootPath: string | undefined, relativePath: string): string {
  if (rootPath === undefined || rootPath.trim() === '') return relativePath;  // ← 静默退化成相对路径
  const root = rootPath.trim().replace(/[\\/]+$/, '');
  return `${root}\\${relativePath}`;
}
```

`rootPath` 默认空（`schema.ts:25`），只有 `INSTALL.md:98` 提到要填。用户点「复制保存路径」拿到 `拼多多\商品_4823…`，粘到资源管理器打不开。
**修法**：`rootPath` 为空时 tooltip 改成「在设置里填根目录绝对路径可复制完整路径」，点击直接 `shell.openOptions`。

---

## 3. 轻微

### C16【轻微｜已修】`<li>` 嵌套 `<li>`
- HEAD：`AssetList.tsx:78` 外层 `<li>` → `AssetRow.tsx:94` 内层 `<li>`。探针运行时 React 报 `<li> cannot contain a nested <li>.`。

### C17【轻微｜仍存在】`onConflict` 设置项没有读取点
- HEAD `settings.ts:33` 定义 `onConflict`（`rename|overwrite|skip`），但 `git grep -n onConflict HEAD -- src` 只命中定义处；行为写死在 `fsa.ts:87-96`（永远 `rename`）。`overwrite`/`skip` 选了也没用。

### C18【轻微｜仍存在】两个全局设置项没有读取点
- HEAD `OptionsApp.tsx:218` 的「调试模式」→ `settings.debug`，生产零读取；`schema.ts:36-38` 的 `platforms.enabled` 只出现在 `migrations.test.ts:19`。

### C19【轻微｜仍存在】死接口
- `media-store.ts:57` `clearKindSelection`、`:63` `enterPicking`、`:171` `isPicking` —— 生产零调用（只有 `media-store.test.ts`）。
- `planner.ts:209` `planCounts` —— 只有测试调用。
- `ui/asset-row-model.ts:180` `failuresByKind` —— 只有测试调用。
- `folder-manifest.ts:66` `brokenManifestName` —— 只有测试调用；**损坏的 `.ecbox.json` 因此永远不会改名保留**（`parseFolderManifest` 的 `broken` 分支只被当作「没有记录」），与 `folder-manifest.ts:9-11` 注释承诺的 §9.11「改名保留现场」相反。

### C20【轻微｜仍存在】`prefs` 只存内存，刷新即丢
- HEAD `page-api.ts:26` `const prefsStore = new Map<...>()`，`:117-127` 只读写这个 Map。`media-store.ts:28,74-88` 用它持久化「勾选类别」，于是 §10.3 承诺的「勾选状态是全局偏好，以后所有商品都按这个默认勾选」**只在当前页面会话内成立**；刷新即回默认值。
- **修法**：改用 `kernel/settings/store.ts:215` 的 `patchUiPrefs`（已是现成的）。

### C21【轻微｜仍存在】挑选模式下无文案说明「只下选中的、忽略勾选类别」
- HEAD `primary-action-model.ts:427-438` 把按钮改成「下载所选 N 个」，但没告诉用户**勾选类别被忽略了**。
- **修法**：该分支加 `meta: ['只下载选中的素材']`。

---

## 4. PageApi 方法 × 对端实现 对照表（用户点名要求）

行号均为 **HEAD f22bc77**。

| PageApi 方法 | 页面调用点 | bg handler | 对端实现 | HEAD 结论 | 02:30 |
| --- | --- | --- | --- | --- | --- |
| `submitJob` | `page.tsx:210,373,384` | `background.ts:53` `job.submit` | `engine.enqueue` → `runner.enqueue` | 消息通；**payload 缺 `platformDisplayName` 被引擎 schema 拒收**（Lead 已确认） | ✅ |
| `cancelJob` | `page.tsx:255` | `background.ts:59` `job.cancel` | `engine.cancel` → `runner.cancel` | 通 | ✅ |
| `retryJob` | `page.tsx:245,299,332,335` | — | — | **bg 没有 `job.retry` handler**（`git grep -n "onMessage('job.retry'" HEAD -- src` 零命中）→ 点击抛 "Could not establish connection" | ✅ |
| `watchJobs` | `page.tsx:149` | —（Port） | `port.ts` | `[HEAD]` 双 Port 互相覆盖（审计 A）+ dedupeKey 不匹配（C2） | ✅ |
| `call('history.get')` | `page.tsx:163` | `background.ts:65` `feature.call` | `engine.call` → `engineFeatures[].engine.methods` | **HEAD 必抛 `no engine method`**：engine 无 `methods` 字段，且 `registry.service` 从未被 bg import → 异常被 `page.tsx:165-168` 静默吞掉 | ✅ |
| `toast` | `page.tsx:222,226` | — | `ToastViewport` | **HEAD 断（C1）** | ✅ |
| `copy` | `page.tsx:316`、`controller.ts:447` | — | `navigator.clipboard` | 通；但 `page-api.ts:113-115` **没有 catch**，无权限时 unhandled rejection | 仍存在 |
| `prefs.get/set` | `media-store.ts:75,88` | — | `page-api.ts:26,117-127` **内存 Map** | **不通**（C20） | 仍存在 |
| `dir.status()` | 未调用 | `background.ts:34` `fs.status` | `engine.fsStatus` | 通（面板用 `PanelProps.dir`） | ✅ |
| `dir.openGrant()` | `page.tsx:193-197` | `background.ts:40` `fs.openGrant` | `openGrantWindow` | 通 | ✅ |

### 补充：`dir` 状态在 downloads 模式下恒为 ready

`kernel/fs/sinks/downloads.ts:134-141` 用 `alwaysReadyProbe()`。切到「浏览器下载目录」后，面板保存位置栏显示「保存到 <相对路径>」，实际落点是浏览器下载目录——用户会以为文件进了自选文件夹。`SaveBar.tsx:64-108` 只看 `dir.status`，没有模式提示。
**修法**：`DirState` 加 `mode?: 'fsa' | 'downloads'`，downloads 模式文案改成「保存到浏览器的下载目录」。

---

## 5. UI 误判「没反应」的其它细节（用户点名的检查项）

行号为 **HEAD f22bc77**。

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 按钮 disabled 无提示 | **部分**。原因写在按钮文案里（`请先勾选要下载的素材` / `正在识别商品…`），但没有 tooltip / `aria-describedby` | `primary-action-model.ts:230-241,343-354`；`PrimaryAction.tsx:69-78` |
| 任务已提交但没有进度 | **HEAD 是**，四条原因：Port 双连接（审计 A）、dedupeKey 不匹配（C2）、tabId 缺失、`handleEngineEvent` 直接丢弃 | `background.ts:200,214,224` |
| tabId 缺失导致事件推不回 | **HEAD 是**：`buildJobRecord(p)` 不收 tabId（`background.ts:200`），`:214` 只在 `p.tabId` 存在时才写入；而 `page-api.submitJob`（`page-api.ts:51-56`）从不传 `tabId` → `handleEngineEvent` 的 `if (typeof e.job.tabId === 'number')`（`:224`）不成立 → 事件丢弃 | 同左（02:30 已修） |
| toast 没有渲染出来 | **HEAD 是**（C1） | `Shell.tsx`（HEAD 无 ToastViewport） |
| 面板里 dir 状态永远 ready | **downloads 模式是**（§4 补充）；FSA 模式状态机本身正确 | `dir-status.ts:45-76` |
| 完成后 3 秒回落 | 实现存在（`page.tsx:130-139` tick + `primary-action-model.ts:292-308` TTL）；C4 已修 | 同左 |
| 挑选模式提示 | **缺**（C21） | `primary-action-model.ts:427-438` |
| `watchJobs` 回放隐患 | HEAD `page-api.ts:68-77` 的 `for...break` 只回放**第一条**匹配 job；多任务并存时可能回放到旧的那条（**02:30 仍在**） | `page-api.ts:68-77` |
| 识别中的骨架屏 | 理论存在但走不到：`FeatureSlot.tsx:112` 在 `!snapshot` 时 `return null`，而 snapshot 出现时 status 已 ≥ ready。不是缺陷，记录以免误判 | `FeatureSlot.tsx:112` |

---

## 6. 文档承诺 vs 代码（逐条核对，HEAD 基线）

| 承诺（出处） | 核对结果 | 证据 |
| --- | --- | --- |
| 「一次点击把素材按 `根目录/平台/商品/{主图,SKU图,详情图,视频}` 归档」（`README.md:7`） | **HEAD 不成立**：`engine.ts:120` `const targetDir = dir.slice(0, -1)` 把 `plan.folder` 拼进去的那层子目录名砍掉，图片写进商品根目录。Lead 已确认，02:30 已修 | `engine.ts:120` |
| 「同一商品重复下载只补缺失文件」（`README.md:8`） | **HEAD 不成立**：`engine.ts` 只在 finalize 写清单（`:138-176`），`run`（`:88-136`）**从不读清单**，所以没有「按清单跳过」。02:30 已补 `run` 的增量跳过 | `engine.ts:88-136` |
| 「商家改了标题也不会另建文件夹」（`README.md:8` / `ACCEPTANCE.md:24` A11） | **HEAD 不成立**：`fs-gateway.ts:88` 的 `resolveProductFolder` 生产零调用（审计 B B5）。02:30 已接 | `fs-gateway.ts:88` |
| 「WebP、AVIF 转成 JPG」（`settings.ts:37`，默认**开**） | **仍不成立**（跨层契约不一致）：引擎改用嗅探（02:30），但 `toJpeg` 内部又用 `blob.type` 判一次（`convert.ts:90`），CDN 回 `application/octet-stream` 时直接早退。探针实证：`sniffed convertible = true | blob.type = application/octet-stream` → 原样返回 | `convert.ts:90` |
| 「生成 商品信息.txt」（`settings.ts:39`，默认开） | **成立**（`engine.ts:163-174`）；但价格在拼多多真实数据上是 `¥0.00`（审计 B B8） | `info-txt.ts:44` |
| 「同时下载视频封面」（`settings.ts:41`，默认关） | **HEAD 实现存在但开关够不着**（C8）；`planner.ts:185-198` 已实现 | `planner.ts:185-198` |
| 「按平台分文件夹」（`settings.ts:29`，默认开） | **HEAD 实现存在但开关够不着**（C8）；另注意 `byPlatform=false` 时 02:30 的 `engine.ts` 用 `resolved.dir.slice(1)` 去掉平台层，需和 planner 的 `folder` 做一致性回归 | `planner.ts:134-137` |
| `ACCEPTANCE.md` A1–A17 | 除 A3/A6/A16 标 ✅ 外**全部 ⏳ 未验证**；C3/C9/C13 都落在这些未验证项覆盖范围内 | `docs/ACCEPTANCE.md:14-30` |
| `INSTALL.md:98`「填了根目录绝对路径才能复制完整路径」 | 成立，但面板无引导（C15） | `SaveBar.tsx:35-39` |

---

## 7. 必须修清单

**02:35 复核后仍存在、建议立刻派活：**

1. **C3（严重）** 把 `otherTabJob` / `queuedAhead` / `grantPending` 接上真实数据。`grantPending` 尤其重要：它决定「授权期间用户是否以为卡住」，直接关系到用户会不会再报一次同一个 bug。HEAD 行号 `page.tsx:182,183,188`。
2. **C10（一般，但属 WIP 回归）** 重试 fallback 加前置判断，避免整单重提。**HEAD 上没有这段代码**，是本轮修复引入的，合并前务必处理。
3. **C14（一般）** 失败列表逐项「重试」要么实现按 itemKey 重试，要么去掉按钮。`FailureList.tsx:99`。
4. **C15（一般）** `rootPath` 为空时给引导，否则「复制保存路径」粘不进资源管理器。`SaveBar.tsx:35-39`。
5. **C17 / C18（轻微）** `onConflict`、`settings.debug`、`platforms.enabled` 三个设置了没反应——删掉或接上。
6. **C20（轻微，但影响 §10.3 承诺）** `prefs` 改走 `patchUiPrefs`，让「记住勾选类别」跨会话生效。
7. **C21（轻微）** 挑选模式补一句「只下载选中的素材」。

**已在工作区修复（02:35 复核），请重点回归、不要重复派活：**

C1（Toast 挂载 + 面板错误行）、C2（重试 dedupeKey）、C4（已保存计数）、C5（体积重复）、C6（计数改用计划）、C7（历史期望改用计划）、C8（设置页渲染 SettingsSection）、C9（popup 带 kinds）、C11（取消也写清单）、C12（skippedByKind 已传）、C13（切商品清 job）、C16（li 嵌套）。

**回归测试建议（按收益排序）：**

| 断言 | 覆盖的问题 | 怎么测 |
| --- | --- | --- |
| `submitJob` reject → 面板出现 `role="alert"` 文案 | C1 | 组件测试，`page.test.tsx` 目前**没有**失败路径用例 |
| `waiting:'dir'` → 主按钮变成「请在弹出的窗口中选择文件夹」且禁用 | C3（修完后） | 组件测试 |
| 重复下载（全部 skip）→ 主按钮写「已保存 24 个文件」而不是 0 | C4 | 用 `status:'done', done:0, skipped:24` 的 JobRecord 渲染 |
| 进度态按钮文案里「MB」只出现一次 | C5 | 组件测试（本文探针就是这个） |
| 按钮数字 == `planDownload().items.length` | C6 | 用含窄详情图的快照 + `detailMinWidth=200` |
| 全量下载成功后 history.missing 为空 | C7 | 计划 key 与清单 key 对齐 |
| 设置页能改 `toJpeg` 并落库 | C8 | 改完刷新仍生效 |

**跨审计重叠（不重复派活，仅记录）：** `convert.ts:90` 的 `blob.type` 早退 = 审计 B 的 B1；双 Port 覆盖 = 审计 A。

---

## 8. 如何复核本文断言（不需要跑全量测试）

```powershell
# C1：HEAD 上 toast 通道是断的
git grep -n '__setToastHandler|ToastViewport' HEAD -- src

# C2 / retryJob：HEAD 上 bg 无 job.retry handler，且重试会换 dedupeKey
git grep -n "onMessage('job.retry'" HEAD -- src         # 期望：无输出
git show HEAD:src/kernel/jobs/runner.ts | Select-String 'dedupeKey: record'   # 期望命中 :495

# C8：HEAD 上 SettingsSection 无人消费
git grep -n 'SettingsSection' HEAD -- src ':!*.test.*'

# C3 / C14：HEAD 上写死的常量与重复回调
git show HEAD:src/features/media-download/page.tsx | Select-String 'otherTabJob: null|queuedAhead: 0|grantPending: false'
git show HEAD:src/features/media-download/page.tsx | Select-String 'onRetryAll'

# C13：切商品时不重置 job
#   HEAD 全文只有一处含 "job = null"：:81 的 let 定义。evaluate 的两个重置块（:168-184、:191-200）里 0 处。
git show HEAD:src/entrypoints/page.content/controller.ts | Select-String 'let job: JobRecord'

# C16：HEAD 上 <li> 嵌套（AssetList 的 li 内是 AssetRow 的 li）
git show HEAD:src/features/media-download/ui/AssetRow.tsx | Select-String '<li'

# C17/C19：死接口与未读取的设置项（每条都只命中定义处，无生产调用）
git grep -n "onConflict" HEAD -- src ':!*.test.*'
git grep -n "enterPicking" HEAD -- src ':!*.test.*'
git grep -n "clearKindSelection" HEAD -- src ':!*.test.*'
git grep -n "failuresByKind" HEAD -- src ':!*.test.*'
git grep -n "brokenManifestName" HEAD -- src ':!*.test.*'

# C10：HEAD 上没有 retryOrResubmit（它是 02:30 的 WIP 新引入的回归）
git grep -n "retryOrResubmit" HEAD -- src     # 期望：无输出
```

**当前状态复核（02:30 的 WIP 是否已修）：** 直接对工作区跑同样几条 `Select-String` / `git grep`，把 `HEAD:` 前缀去掉即可。

---

## 附：临时验证探针（均已删除，未进版本库）

| 探针 | 验证的结论 | 关键输出 |
| --- | --- | --- |
| `__tmp-audit.test.ts` | HEAD payload 契约 + `run` 目录裁剪 | 引擎在 plan 前拒收无 `platformDisplayName` 的 payload；`01.jpg` 落在商品根目录而非 `主图/` |
| `__tmp-audit2.test.tsx` | HEAD `history.get` 用空 title 反推文件夹名不成立 | `GUESS= "_482319937501" REAL= "夏季新款…_482319937501"` |
| `__tmp-audit3.test.ts` | `toJpeg` 的 `blob.type` 早退 | `sniffed convertible = true | blob.type = application/octet-stream` → 未转码 |
| `__tmp-audit4.test.ts` | 计数 / 计划 / 历史三者不一致（C6、C7） | `BUTTON SAYS = 3 | PLAN ITEMS = 2`；`MISSING AFTER FULL DOWNLOAD = ["detail:d1"]` |
| `__tmp-audit5.test.tsx` | 进度文案体积重复（C5） | `PROGRESS TEXT = "下载中 6/24 · 2 MB · 2 MB取消"` |

清理：`Remove-Item -Force src/features/media-download/__tmp-audit*.test.t*`（已执行，`Test-Path` 返回 `False`）。

**审计期间跑过的命令**

- `pnpm vitest run src/features/media-download` —— 11 文件 / **196 用例全绿**（WIP 状态，01:50）。
- `npx tsc --noEmit` —— 02:14 时有 4 处类型错误（`background.ts:282`、`offscreen/main.ts:160,195`、`engine.ts:234`）。这些是并发修复过程中的中间态（新代码引用了尚未定义的 `errorText` 等），**不作为审计结论**；合并前请重跑一次 `pnpm compile`。

**审计边界**：本次只覆盖 `src/features/**` 与功能面板 UI，以及文档承诺。入口层/SW/shell 见 `docs/audit-a-entrypoints.md`，内核/平台适配器见 `docs/audit-b-kernel-platforms.md`。两份报告之间重复的项（如双 Port 覆盖、`toJpeg` 判定）本文只引用不展开。