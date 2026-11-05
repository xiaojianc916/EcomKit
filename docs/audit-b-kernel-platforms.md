# 审计 B：内核与平台层（只读）

- 审计对象：`src/kernel/*`、`src/platforms/*`，以及它们与 `features/media-download` 的落盘契约
- 基线：HEAD `f22bc77`（2026-11-06 01:09）+ 审计期间工作区里**并发进行**的未提交改动
- 审计方式：静态读码 + 用真实抓包数据复现 + 临时 vitest 探针（探针文件已删除，未改动 `src/`）
- 允许写的文件：仅本文档（`docs/audit-b-kernel-platforms.md`）

**如何复核本文断言**（大部分可以用一条命令验证，不需要跑全量测试）：

```powershell
# B5：定位链路是死代码
git grep -n 'resolveProductFolder\|ensurePlatformDir\|ensureSubdir' HEAD -- src | Select-String -NotMatch '\.test\.'
# B4：downloadHls 只有测试引用
git grep -n 'downloadHls' HEAD -- src
# B10：真实抓包入库
git ls-files .tmp-rawdata.json .tmp-oak-render.json 05-pdd-real-data.patch src/platforms/pinduoduo/__scratch-real.test.ts
```

> **重要前提（请先读）**
> 审计过程中 Lead 正在并行修改同一批文件（审计开始 01:28 时 `git status` 干净，01:58 时已有 16 个文件被改 + 新增 `payload.ts`）。本文的 B1/B3/B4/B5 结论我在 01:59 用 `git grep` 在**当前工作区**重新核对过，仍然成立。
> 因此本文每条结论都标注了**针对哪个版本**：
> - `[HEAD f22bc77]` —— 用户报告故障时的代码，也是本审计的**主要结论**；
> - `[工作区 WIP]` —— 审计期间被改过的现状，用于说明「改了之后还剩什么问题」。
> 凡是标 `[工作区 WIP]` 的条目，都可能在你读到本文时已经继续变化，请以最终 diff 为准复核。

---

## 0. 结论速览

| # | 严重度 | 一句话 | 位置 |
|---|---|---|---|
| B1 | 严重 | `toJpeg` 只按 `blob.type` 判断，而该 Blob 的类型来自响应头 content-type；CDN 回 `application/octet-stream` 时转码**不会触发**，WebP/AVIF 原样落盘（设置里的「转 JPG」形同虚设） | `kernel/media/convert.ts:80,90` |
| B2 | 严重 | downloads 兜底模式下 `.ecbox.json` 读不回来：`readText` 只查内存副本，重启/换上下文后恒为 `null` → 增量下载与「补全 N 个」永久失效（该模式下 IDB 兜底也未接线） | `fs/sinks/downloads.ts:213-219` |
| B3 | 严重 | 取消/中断的任务**不执行 finalize**，本次已落盘的文件永远不进 `.ecbox.json`；再点「继续下载」会生成 `01 (2).webp` 之类副本 | `jobs/runner.ts:369-381` + `engine.ts:170` |
| B4 | 一般 | 引擎不认识 HLS：上游把 m3u8 标成 mp4 时（无后缀直链默认标 mp4）会落盘几十字节的播放列表文本且状态 `done`；`hls.ts` 的 `downloadHls` 从未被生产代码调用 | `media-download/engine.ts:105-168`、`kernel/media/hls.ts:143`、`pinduoduo/media.ts:113-115` |
| B5 | 严重 | 商品文件夹定位整条是死代码：`resolveProductFolder`/`ensurePlatformDir`/`ensureSubdir` 生产零调用 → 索引永不写入、`_ID` 后缀扫描从不执行；商家改标题就新建文件夹（实测两个文件夹）；且模板超长时 `_商品ID` 后缀还会被截断 | `fs/fs-gateway.ts:88,157,163`、`planner.ts:123-137`、`template.ts:130` |
| B6 | 严重 | `planner` 读的 `dirNames` 允许重复：用户把主图和详情图设成同名，两类的 `01.webp` 会互相 `(2)` 覆盖 | `media-download/planner.ts:153`、`settings.ts:15-20` |
| B7 | 一般 | `detailMinWidth` 过滤后序号不连续，且过滤发生在「计数」之后：主按钮写的「下载 N 个」与真实写入数不一致 | `planner.ts:157-161` |
| B8 | 一般 | 拼多多真实抓包里价格字段全部为字符串 `"0"`，解析出 `¥0.00` 并被写进 `商品信息.txt` | `pinduoduo/resolver.ts:526-529` |
| B9 | 一般 | 真实 `initDataObj.goods` 无 `topGallery` 时，`deep-scan` 把 19 张**详情图**全部归成主图（主图/详情图分类颠倒） | `pinduoduo/resolver.ts:532-550` |
| B10 | 一般 | `.tmp-rawdata.json` / `.tmp-oak-render.json` / `05-pdd-real-data.patch` / `__scratch-real.test.ts` 已被 git 跟踪，且 scratch 测试会读取真实商品数据 | 仓库根、`pinduoduo/__scratch-real.test.ts:7` |
| B11 | 轻微 | `settings.migrations` 是空表且 `migrateSettings` 无调用点；`CURRENT_SETTINGS_VERSION=1` 与 IDB `dbVersion=1` 都没有升级路径 | `settings/migrations.ts:73-80`、`storage/keys.ts:17` |
| B12 | 轻微 | IDB `logs` 表（设计上 FIFO 2000 条）从未被写入，诊断包只带内存 `LogBuffer`（重启即丢） | `storage/idb.ts:16`、`log/logger.ts:36` |

---

## 1. 下载主链路：fetch → blob → sniff → toJpeg → 落盘

### B1【严重】`toJpeg` 的转码判定用错了输入，WebP/AVIF 在常见情况下不会被转

**现象**：设置里 `toJpeg`（默认 `true`）宣称「WebP / AVIF 转 JPG（§9.8）」，但真实条件下几乎不生效，用户拿到的仍是 `.webp`。

**证据**

`src/kernel/media/convert.ts:79-90`：

```ts
async shouldConvert(blob: Blob): Promise<boolean> {
  if (!isConvertibleMime(blob.type)) return false;   // ← 只看 blob.type
  return true;
},
async toJpeg(blob: Blob): Promise<Blob> {
  if (!isConvertibleMime(blob.type)) return blob;     // ← 同上
  ...
}
```

`isConvertibleMime`（`convert.ts:32-37`）只认 MIME 里含 `webp`/`avif`。

而 `engine.ts` 传给它的 Blob 来自 `await res.blob()`（`engine.ts:132`），该 `Response` 的 content-type 直接沿用 CDN 响应头（`fetcher.ts:116-120` 重建 Response 时原样复制 `headers`）。电商 CDN 对图片回 `application/octet-stream` 很常见，此时 `blob.type` 不含 `webp`，转码被直接跳过。

**复现**（临时探针，已删）：WebP 字节 + `content-type: application/octet-stream` 走完整任务链路，落盘为 `主图/01.webp`，`status=done` 且无任何告警。

**触发条件**：只有当 CDN 恰好在响应头写了 `image/webp` 时才会转；回 `application/octet-stream` 或 `image/*` 以外的类型时一律跳过。而代码里已经**有**可靠的判定依据没有用上 —— `engine.ts:135-137` 的同一次响应里已经嗅探出正确类型：

```ts
const sniffed = sniff(head);
let finalExt = MIME_EXT[sniffed.mime] ?? sniffed.ext ?? 'bin';
```

**建议修法**：把转码判定改成基于嗅探结果而不是 `blob.type`。最小改动是在 `engine.ts` 里判断 `sniffed.ext`：

```ts
// engine.ts run()
if (wantsJpeg && item.expect === 'image' && (sniffed.ext === 'webp' || sniffed.ext === 'avif')) {
  const converted = await ctx.media.toJpeg(blob);
  ...
}
```

同时给 `toJpeg` 加一个显式的 `sourceMime`/`ext` 参数，别让内核去猜 `blob.type`。这样 `convert.ts` 的 `hasTransparency` 逻辑仍然有效（PNG 透明跳过那条注释目前在 webp/avif 分组里，需要一并复核语义）。

> **附带的第二问（用户点名要求核查）**：`toJpeg` **并不是**无条件把所有图片转成 JPG。`convert.ts:90` 先做 `isConvertibleMime` 早退，PNG/GIF/JPEG 原样返回；`convert.ts:107` 还有「带透明通道不转」。所以「png/webp 全变 jpg」这个担心在当前实现里不成立 —— 真正的问题是**反过来**：该转的没转。

---

### B4【一般】引擎不认识 HLS：m3u8 会被当普通视频文件落盘，`downloadHls` 是死代码

**现象**：当上游把一个 m3u8 播放列表当成 mp4 传给引擎时，引擎会把几十字节的播放列表文本写成 `视频/xxx.m3u8`，任务状态却是 `done`（假成功）。

**可达路径（重要，决定了严重度）**：解析器默认会拦掉 hls —— `shared/video.ts:37-39` 的 `selectVideo` 只保留 `container === 'mp4'`。但 `pinduoduo/media.ts:113-115` 把「猜不出的容器」**强制标成 mp4**：

```ts
// 待验证：拼多多 videoGallery 里给的是 mp4 直链，地址上不一定带 .mp4 后缀
container: guessed === 'unknown' ? 'mp4' : guessed,
```

即：CDN 直链**不带扩展名**（或带 `.m3u8` 以外的签名后缀）而实际是 HLS 时，会被标记成 mp4 通过 `selectVideo`，然后到引擎才被发现是 m3u8 —— 此时引擎已经不会再拦。

**证据**

`engine.ts:105-168` 的 `run()` 只做：`fetchWithFallback` → `res.blob()` → `sniff` → `writeFile`。没有任何「嗅探到 hls 就走分片下载」的分支。

嗅探确实能识别 HLS（`kernel/net/sniff.ts:69-71`，返回 `container:'hls'`），但结果只被用来决定扩展名（`engine.ts:137`）。

内核里完整实现了 `downloadHls`（`kernel/media/hls.ts:143-185`，含变体优选、分片顺序追加、加密检测），但全仓库**只有测试文件引用它**：

```
$ grep -rn "downloadHls" src
src/kernel/media/media.test.ts:10,153,166,...   ← 仅测试
src/kernel/media/hls.ts:143                      ← 定义
```

**复现**：构造一条 `kind:'video'`、`candidates:['https://v.pddpic.com/a.m3u8']` 的素材，`content-type: application/vnd.apple.mpegurl` + `#EXTM3U` 字节走真实任务链路 →

```
W1 slurp sniff = {"ext":"m3u8","container":"hls","isVideo":true}
W1 status = done  done = 1  failed = []
W1 TREE = [.../视频/主图视频.m3u8, .../.ecbox.json, .../商品信息.txt]
```

用户拿到一个无法播放的文件，且被记进 `.ecbox.json`（下次重下会被"跳过"）。

**建议修法**：`engine.run()` 在嗅探出 `sniffed.container === 'hls'` 时改走 `downloadHls`，把分片写进同一个文件（`hls.ts` 的 `write` 回调可以直接接到 `ctx.fs.sink.writeFile` 的流上，或先写临时文件再 rename）。若本期不做，至少显式失败成 `UNSUPPORTED_STREAM`（错误码和文案都已存在：`errors/codes.ts:17`、`errors/messages.ts:51`），而不是给用户一个假成功的坏文件。

---

### 一处「看着像 bug 其实没问题」的结论（避免误伤）

- **`slice(0,-1)` 目录错误**：用户在报告里提到的引擎落盘目录错（`dir.slice(0,-1)` 把「主图」这层砍掉），在 `[HEAD f22bc77]` 的 `engine.ts` 里确实存在；`[工作区 WIP]` 已改为 `itemTargetDir(item) = [...item.dir]`（`engine.ts:64-66`）。我用探针在 WIP 上验证，目录已正确：`拼多多/标题A_547575437012/主图/01.png`、`.../详情图/01.png`。**此条已修复，不再列为问题。**
- **payload 缺字段被 Zod 拒绝**：`[HEAD]` 的 `engine.ts:25-33` `PayloadSchema` 里 `settings: z.unknown()` 本身不校验；真正的缺字段问题已由 `[工作区 WIP]` 新增的 `payload.ts` 统一 schema 解决（页面侧 `buildMediaDownloadPayload` 先 parse 一次）。我验证了 WIP 下完整 payload 能过 `MediaDownloadPayloadSchema.parse`。

---

## 2. 文件落盘契约（FsSink / FsGateway）

### B5【严重】商品文件夹定位机制整条是**死代码**：每次下载都按模板新建目录，索引/后缀扫描从未生效

> 这条比原先设想的「后缀被截断」更根本。先说结论：`FsGateway.resolveProductFolder()` / `ensurePlatformDir()` / `ensureSubdir()` 在**生产代码里没有任何调用点**（HEAD 与工作区 WIP 都是）。

**证据（生产调用点）**

```
$ grep -rn 'resolveProductFolder\|ensurePlatformDir\|ensureSubdir' src  | 排除 *.test.*
fs-gateway.ts:88,157,163      ← 定义
fs/types.ts:78,91,92          ← 接口声明
（无任何调用）
```

唯一被生产代码调用的是 `findProductFolder`（`engine.ts:239`，只用于 `history.get`，只查不建）。

**真正决定目录名的路径**是 planner：

- `planner.ts:123-137` 用模板现算 `folder`（`{title:30}_{id}` + `byPlatform` 拼平台名）；
- `engine.ts:99-102` 把它拼进每个 `item.dir`；
- `engine.ts:155` `ensureDir(dir)` —— FSA 的 `getDir(path, true)` 带 `create:true`（`fsa.ts:45`），**目录不存在就新建**。

后果：

1. **索引（`folders` 表）永远是空的** —— `index.set()` 只在 `resolveProductFolder` 内被调用（`fs-gateway.ts:102,116,123`），而它没人调；
2. **「按 `_商品ID` 后缀扫描」这条规则从未执行**；
3. **商家改标题 → 模板输出变了 → 新建一个文件夹**。我实测：同 productId 先跑「标题A」再跑「标题B」→

```
V4 TREE = [.../拼多多/标题A_547575437012/..., .../拼多多/标题B_547575437012/...]   ← 两个文件夹
```

增量下载因此形同虚设（新目录里没有 `.ecbox.json`，全部重下），用户会攒出一堆重复文件夹。

**第二个触发点：`_商品ID` 后缀会被截断**（即使将来接上 `scanByIdSuffix`，这条也会让定位失败）。

`renderProductFolderName` 先渲染模板、再整体截断到 50 字素（`kernel/naming/template.ts:126-131`），截断从**尾部**砍，而 `_ID` 恰好在尾部：

```ts
const rendered = renderTemplate(template, vars, opts);
return sanitizeName(rendered, { maxLength: opts.maxLength ?? NAME_LIMITS.folder }); // folder=50
```

而定位第二步完全依赖这个后缀（`fs-gateway.ts:52-65`）：

```ts
const suffix = `_${productId.toLowerCase()}`;
const matches = entries.filter((e) => e.kind === 'directory' && nameKey(e.name).endsWith(suffix));
```

**复现**：模板 `{title:50}_{id}` + 50 字中文标题 →

```
LONG TEMPLATE folder = "一二三四…（50字）"                endsWith id? false
DEFAULT folder       = "一二三四…（30字）_547575437012"  endsWith id? true
```

默认模板 `{title:30}_{id}` 勉强安全（30 + 1 + 12 = 43 ≤ 50），但设置页允许自由改模板（`OptionsApp.tsx:128`），`{title:50}` 或 `{shop}_{title:30}_{id}` 就会翻车。

**建议修法**：① 让 engine 走 `gateway.resolveProductFolder()`（索引 → 后缀扫描 → 新建），这是 ADR-6 原本的设计；② 截断只作用于 `{title}` 这类可选变量，`{id}` 不参与截断，并在截断后断言 `endsWith(id)`。最小修法：

```ts
// template.ts
const rendered = renderTemplate(...);
const name = sanitizeName(rendered);
if (name.length > NAME_LIMITS.folder) {
  // 保留 _id 后缀，只截前面
  const suffix = `_${vars.id}`;
  if (name.endsWith(suffix)) {
    const headMax = NAME_LIMITS.folder - suffix.length;
    return truncateGraphemes(name.slice(0, -suffix.length), headMax) + suffix;
  }
  return truncateGraphemes(name, NAME_LIMITS.folder);
}
return name;
```

### B6【严重】`dirNames` 允许重复，两个类别会写进同一目录并互相 `(2)`

**现象**：`dirNames` 的 schema 只校验每个值是 `z.string().min(1)`，不校验四个值互不相同。用户把「主图」和「详情图」都填成「图片」，两类素材就落进同一个目录，同序号文件名互相触发 `(2)` 改名。

**证据**

`features/media-download/settings.ts:15-20`（无唯一性约束）：

```ts
export const DirNames = z.object({
  main: z.string().min(1).default('主图'),
  sku: z.string().min(1).default('SKU图'),
  detail: z.string().min(1).default('详情图'),
  video: z.string().min(1).default('视频'),
});
```

`features/media-download/planner.ts:153` 每类独立取目录名：

```ts
const dir = [subdirName(settings.dirNames[kind])];
```

**复现**：`dirNames: { main:'图片', detail:'图片', ... }` →

```
items = [{k:'main:main-a',  dir:['图片'], stem:'01'},
         {k:'main:main-b',  dir:['图片'], stem:'02'},
         {k:'detail:detail-a', dir:['图片'], stem:'01'}]   ← 两个 01
```

**建议修法**：在 `DirNames` 上加 `superRefine` 校验四项去重（清洗后比较，因为 `subdirName` 还会 `sanitizeName`），设置页保存时给出内联错误；或者在 `planner` 里对重复目录名自动加类别后缀。

### B3【严重】取消/中断后不写 `.ecbox.json`，续下会产出 `(2)` 副本

**现象**：任务被取消（或 SW 重启标成 `interrupted`）时，本次已经成功写入磁盘的文件**不会**记进 `.ecbox.json`。用户点「继续下载」，engine 的增量判断查不到记录，于是重新下载并因为 `resolveName` 撞名而生成 `01 (2).webp`。

**证据**

`kernel/jobs/runner.ts:369-381`：

```ts
async function finalizeJob(job: RunningJob): Promise<void> {
  const wasCanceled = job.controller.signal.aborted;
  let record = job.record;
  record = markEnded(record, wasCanceled ? 'canceled' : computeFinalStatus(record), now());

  if (!wasCanceled && job.def.finalize) {      // ← 取消时整段跳过
    ...
    await job.def.finalize(job.payload, results, { ...runContextFor(job), record });
  }
```

而 `.ecbox.json` 只在 `finalize` 里写（`engine.ts:170-194`）。

**复现**（真实任务链路，concurrency=1，中途 `runner.cancel`）：

```
V3 status = canceled  done = 2
V3 TREE after cancel = [.../主图/01.png, .../主图/02.png]     ← 没有 .ecbox.json
V3 redo status = done  done = 4  skipped = 0
V3 TREE after redo   = [.../主图/01.png, .../主图/02.png,
                        .../主图/01 (2).png, .../主图/02 (2).png, ...]  ← 副本
```

**建议修法**：取消时也要走一次「尽力而为」的清单写入，只记录 `status==='ok'` 的项：

```ts
// runner.ts finalizeJob()
if (job.def.finalize) {
  const results = [...job.results.values()];
  try {
    await job.def.finalize(job.payload, results, { ...runContextFor(job), record });
  } catch { /* ... */ }
}
```

`engine.finalize` 本来就已经只挑 `r.status === 'ok' || 'skipped'`（`engine.ts:173`），取消场景下写清单是安全的。注意要避免 `商品信息.txt` 在取消时也被写（可在 finalize 里判断 `ctx.signal.aborted` 只写 json）。

### `resolveName` / `ensureDir` / 写文件：这几条已核对，不是问题

- **`ensureDir` 逐级建目录**：`fsa.ts:74-81` → `getDir(path, true)` 循环 `getDirectoryHandle(..., {create:true})`，正确。
- **原子写**：`fsa.ts:113-135` `createWritable` + `close`，失败 `abort()`，符合 §9.10。
- **重名判定**：`resolveName` 先列目录再 `uniqueFileName`（`fsa.ts:87-96`），大小写不敏感走 `nameKey`，正确。
- **plan 阶段的 folder 前缀**：`[工作区 WIP]` `engine.ts:94-103` 把 `plan.folder` 拼进每个 `item.dir`，`run` 直接用 `[...item.dir]`，语义自洽，已用探针验证落盘路径正确。

---

## 3. 增量下载 / FSA vs downloads 能力差异

### B2【严重】downloads 模式下 `.ecbox.json` 读不回来

**现象**：设置里把保存方式切到「浏览器下载目录」（`save.mode='downloads'`）后，增量下载、「上次下载于…」「补全 N 个文件」全部退化。引擎每次启动看到的都是「没有记录」，于是全部重下 —— 而且 downloads sink 的 `resolveName` 会把它们全变成 `(2)`、`(3)`。

**证据**

`kernel/fs/sinks/downloads.ts:213-219`：

```ts
async readText(dir: RelPath, name: string): Promise<string | null> {
  const key = pathKey(downloadPathName(rootName, dir, name));
  const text = texts.get(key);
  if (text !== undefined) return text;
  // 没写过就读不到（§9.13 的已知限制），返回 null 让调用方按「没有记录」处理
  return null;
}
```

`texts` 是**进程内**的 `Map`（`downloads.ts:101`），offscreen 文档一销毁就清空。`engine.extra()`（`engine.ts:81-92`）读不到清单 → `manifest = null` → 全部重下。

更关键的是：头注释（`downloads.ts:19-21`）自己写了「增量判断改为依靠 IndexedDB 记录 + chrome.downloads.search」，但 `DownloadsSinkOptions.persist`/`initialFiles`（`downloads.ts:36-38`）**没有任何生产代码传入**：

```
$ grep -rn "createDownloadsSink" src
src/entrypoints/offscreen/main.ts:50,173   ← 都不传 initialFiles/persist
src/kernel/fs/sinks/downloads.test.ts     ← 仅测试
```

也就是说 §9.13 承诺的 IndexedDB 兜底根本没接上。

**复现**（模拟「重启后 search 也拿不到」）：写入一次 → 新建 sink 实例 →
`exists()` 返回 `34`（内存树有），但 `readText('.ecbox.json')` 只有内存副本；换实例后 `readText` 恒 `null`。

**建议修法**：在 offscreen 启动时把 `persist`/`initialFiles` 接到 IDB `downloads` 表（`storage/idb.ts:16` 的第四个 store 已经建好但**全仓库无任何读写**）：

```ts
const sink = createDownloadsSink({
  initialFiles: await loadDownloadRecords(),          // kvList('downloads')
  persist: (files) => kvSet('downloads', 'files', files),
  log,
});
```

并且 `readText` 需要能从 `chrome.downloads.search` 或 IDB 里恢复清单文本（或干脆把清单也存进 IDB）。

### downloads 模式的其他能力差异（已核对，风险较低但应记录）

- `listDir`（`downloads.ts:233-255`）只能从内存树推断，**新会话里返回空数组** → `fs-gateway.scanByIdSuffix` 的「扫 `_ID` 后缀」在这一模式下等于不可用，商品文件夹定位只能靠 IndexedDB 索引。这与 B2 是同一个根因的两个面。
- `removeFile`/`rename`（`downloads.ts:258-279`）只改内存，磁盘不变 —— `.ecbox.broken-*.json` 的「改名保留现场」在 downloads 模式下退化（代码注释已声明，可接受）。
- `pathKey` 统一小写（`downloads.ts:90-92`），但 `files.set(pathKey(finalPath))` 存的是 `chrome.downloads` 返回的**绝对路径**（`downloads.ts:200-203`），而 `resolveName` 匹配用的是相对前缀（`downloads.ts:157`）。两者永远对不上，所以 `resolveName` 只能依赖内存里那份「相对路径」记录。实测：第二次 `resolveName` 返回 `01 (2).jpg` 是**对的**，但依赖的是同进程内存，重启后失效。

---

## 4. 调度 / 进度一致性

### B7【一般】`detailMinWidth` 过滤让「计划数」与「实际写入数」分叉，序号还出现空洞

**证据** `planner.ts:149-172`：

```ts
let ordinal = 0;
for (const asset of all) {
  ordinal += 1;                                    // ← 先自增
  if (!selected) continue;
  if (!passesDetailFilter(asset, settings.detailMinWidth, kind)) continue;  // ← 后被过滤
  const serial = padNumber(ordinal, width);        // ← 序号已跳号
```

以及主按钮文案用的是 `counts`（来自快照全量，未过滤）：

- `page.tsx:70-74` `countByKind` 直接数 `snapshot.assets`，不走 `passesDetailFilter`；
- `primary-action-model.ts:441-451` 用 `selectedTotal` 拼「下载 N 个文件」。

**复现**：详情图宽度 `[800, 100]` + `detailMinWidth: 200` → plan 只有 1 项（`stem='01'`），但面板显示「下载 2 个」。

**建议修法**：把 `passesDetailFilter` 提到计数侧（`countByKind`/`planCounts` 共用），或者让主按钮直接读 `planCounts(plan)`。序号跳号问题按 §9.5「以整个类别为基准编号」其实是**设计意图**（补全序号不错乱），文档里应写明，不要当 bug 修。

### runner 调度：已核对为**正确**的几处（避免误报）

- **任务间轮转**：`runner.ts:206-228` `roundRobin % active.length`，符合 §6.4。
- **视频独立并发池 2**：`runner.ts:122` `createConcurrencyPool(VIDEO_CONCURRENCY)`，`dispatch` 按 `item.expect` 分流（`runner.ts:233`）。
- **并发上限 1–8**：`clampConcurrency`（`runner.ts:136-139`）。
- **progress 节流 200ms + 终态立即推**：`runner.ts:166-193`。
- **失败项重跑清计数**：`clearFailure`（`progress.ts:148-163`）。
- **`requiresDir` 兜底**：`[工作区 WIP]` `runner.ts:419-427` 新增了「目录不可用直接整单失败」，之前 `requiresDir` 声明了但没人读。

### 进度计数一致性：两个真问题

1. **`byGroup.total` 在取消后被重置为 0**：`markStarted`（`progress.ts:80-92`）重设 `byGroup: initByGroup(items)`；若任务被取消后复用同一 record（当前 `retry` 是新建 record，所以暂时不触发），但 `cancelInternal`（`runner.ts:387-401`）走 `markEnded` 不改 `byGroup`，UI 上「主图 2/8」会停在取消瞬间 —— 可接受，记录在案。
2. **`ItemResult.bytes` 与 `size` 双字段**：`progress.ts:114` 用 `result.bytes ?? result.size ?? 0`，而 `types.ts:32-40` 两个字段都声明为可选。`engine.run` 只填 `bytes`（`engine.ts:162`），`skipped` 分支也填 `bytes`（`engine.ts:119`）。目前一致，但两套字段名是隐患，建议统一。

---

## 5. 平台解析：用真实抓包核对

数据来源：仓库根 `.tmp-rawdata.json`（拼多多 `window.rawData` 真实样本，goodsID `547575437012`）、`.tmp-oak-render.json`（`/proxy/api/api/oak/integration/render` 真实响应）。

### B8【一般】真实抓包的价格全是字符串 `"0"`，解析出 `¥0.00` 并写进 `商品信息.txt`

**证据** `.tmp-rawdata.json` 与 `PDD_PRICE_PATHS`（`pinduoduo/schema.ts:143-151`）的实际取值：

| 字段 | 真实值 |
|---|---|
| `minGroupPrice` | `"0"` (string) |
| `minNormalPrice` | `"0"` |
| `maxOnSaleGroupPrice` | `"0"` |
| `linePrice` | `"0"` |
| `localGroups` | `[]` |

`readNumber`（`read-path.ts:75-83`）会把 `"0"` 转成 `0`，`resolver.ts:526-529` 于是写入 `draft.price = '¥0.00'`：

```ts
const priceFen = readNumber(goods, PDD_PRICE_PATHS);
if (priceFen !== undefined && Number.isFinite(priceFen)) {
  draft.price = `¥${(priceFen / 100).toFixed(2)}`;
}
```

**复现**：真实 rawData → `REAL price = ¥0.00`，随后 `buildInfoTxt`（`info-txt.ts:44`）把 `价格：¥0.00` 写进用户的 `商品信息.txt`。

**影响**：价格是没有意义的 `¥0.00`，比不显示更误导用户。

**建议修法**：价格为 0 时当作「未知」不写（真实商品不可能 0 元）：

```ts
if (priceFen !== undefined && Number.isFinite(priceFen) && priceFen > 0) { ... }
```

另外应把真实数据里**存在的** `skus[].groupPrice`（同样是 `"0"` 字符串）一并核对 —— `normalizeSkuLike`（`schema.ts:343-344`）用同一个 `firstNumber`，同样会得到 `¥0.00`。

### B9【一般】无 `topGallery` 时 19 张详情图全被归成主图

**证据** `resolver.ts:532-550`：

```ts
let mainImages = normalizeImageList(readArray(goods, PDD_MAIN_IMAGE_PATHS));
if (mainImages.length === 0 && scanRoot) mainImages = deep().main;      // ← 深度扫描兜底
...
let detailImages = normalizeImageList(readArray(goods, PDD_DETAIL_IMAGE_PATHS));
if (detailImages.length === 0 && scanRoot) detailImages = deep().detail;
```

`deep-scan.ts:128` 的兜底规则是「主图类路径没有就退到『未分类』里最多的一组」，而真实数据的 `detailGallery` 有 19 项、没有 `topGallery` 时，`detailGallery` 会被当作「未分类」候选。

**复现**（删掉真实数据里的 `topGallery`）：

```
原数据：  counts = {"main":1,"detail":19}     ← main 来自 viewImageData/hdThumbUrl 兜底
删 topGallery 后：counts = {"main":19}        ← 19 张详情图全变主图，detail=0
```

**影响**：落盘时 19 张详情图被写进 `主图/` 目录、按主图序号命名，用户分类全乱。

**建议修法**：`deep().main` 兜底时应排除已经在 `detailImages` 里的路径，或要求路径命中 `MAIN_RE` 才允许当主图（当前 `pickLargest(otherHits)` 的兜底太宽）。最小修法是给 `deepScanPdd` 增加一个 `excludePaths` 参数，把已识别的详情路径排除掉。

### 素材分类/去重/顺序：真实数据核对为**正确**的部分

用 `.tmp-rawdata.json` 真实样本跑 `draftFromPayload`（`source='ssr'`）：

| 核对项 | 结果 |
|---|---|
| 标题 | `无印良品洗脸巾悬挂式绵柔巾大包一次性擦脸巾加厚加大洁面巾毛巾` ✅ 与 `goods.goodsName` 一致 |
| 商品 ID | `547575437012` ✅ 与 `goods.goodsID` 一致 |
| 主图 | 1 张（真实数据 `topGallery` 只有 1 项 ✅） |
| 详情图 | 19 张（真实 `detailGallery` 长度 19 ✅，顺序与数组一致） |
| SKU 去重 | 4 个 SKU、`thumbUrl` 全为 `""` → 只产出 4 条 `Sku` 记录、0 个 SKU 素材 ✅（合理：没有图就不该有素材） |
| 候选地址白名单 | 全部在 `*.pddpic.com` ✅ |
| 查询参数剥离 | `?imageMogr2/...` 被 `stripProcessingParams` 去掉，原图优先 ✅ |
| 视频 | 真实 `videoGallery: []` → 0 个视频 ✅ |

**SKU 规格**：真实数据 `skus[0]` 只有 `skuId/quantity/isOnsale/skuID/thumbUrl/normalPrice/groupPrice/normalSavePrice/skuExpansionPrice`，**没有 `specs`**，`skuProperty: []`。所以真实场景下 SKU 无规格标签 —— 与 `fixtures.test.ts` 里「spec_key/spec_value」的假设不同。这不是代码 bug，但说明 `src/platforms/pinduoduo/__fixtures__/*` 是**虚构数据**（fixture 文件头注释已承认），不能当作「真实抓包核对通过」的证据。

### `.tmp-oak-render.json`：抓包源无法解析（预期内，但值得记录）

```
OAK capture draft = null
OAK ssr draft     = null
```

真实 `/proxy/api/api/oak/integration/render` 响应结构是：

```
{ server_time, goods: { service_promise_version: int },
  price: {}, promotion: {}, ui: {}, control: {}, transmission: {},
  encrypt_status, encrypt_info: "<114KB 密文>" }
```

商品数据全部在 `encrypt_info` 里（加密），明文只有 `service_promise_version`。所以：

- `findPddRoots` 找不到 goods/mall（`schema.ts:380-396`）→ `draftFromPayload` 返回 `null`；
- `capture` 源对这条响应**永远拿不到数据**。

**这不是 bug，但 manifest 的说明与实际不符**：`pinduoduo/manifest.ts:32-33` 注释写「商品页前端渲染时数据来自 /proxy/api/api/oak/integration/render（第三方实测），一并覆盖」，实际上这条接口回的是加密载荷，覆盖它没有任何收益，反而每帧都在做一次无用的 `JSON.parse` + 深度匹配。建议：要么去掉这条 `urlPattern`，要么在注释里注明「返回加密载荷，仅保留用于将来解密」。

---

## 6. 设置 schema / 迁移 / IndexedDB

### B11【轻微】迁移框架是空壳，且没有任何调用点

**证据**

- `settings/migrations.ts:73-80`：`CURRENT_SETTINGS_VERSION = 1`，`SETTINGS_MIGRATIONS = {}`（只有注释掉的示例）。
- `migrateSettings`（`migrations.ts:85-87`）在全仓库**只有测试文件调用**：

```
$ grep -rn "migrateSettings" src
src/kernel/settings/migrations.ts:85
src/kernel/settings/migrations.test.ts:4,90
```

- IDB 侧：`DB_VERSION = STORAGE_KEYS.dbVersion`（`idb.ts:26`），`dbVersion: 1`（`keys.ts:17`），`upgrade()` 只 `createObjectStore` 四个表。

**现状风险评估**：因为 `getSettings` 每次读取都 `GlobalSettings.safeParse` 并回落默认值（`store.ts:56-61`），**新增字段确实不需要迁移**（这条注释是成立的）。真正危险的是**改结构**：一旦把 `shell.autoOpen` 改名，旧用户的数据会整份 `safeParse` 失败 → **静默重置为全部默认值**（`store.ts:57-60` 只打一条 warn），用户设的目录模式、并发数、模板全部丢失。

**建议修法**：`getSettings` 失败时先跑一次 `migrateSettings(raw, 0)` 再 parse；把 `SETTINGS_MIGRATIONS` 里补上 `migrateV1ToV2`（函数已经写好了，`migrations.ts:59-70`，只是没接进表）。

### `DEFAULT_GLOBAL_SETTINGS` 与功能层读取：已核对一致

- `jobs.concurrency` 默认 6（`schema.ts:41`）↔ `offscreen/main.ts:57` `concurrency: settings.jobs.concurrency` ✅
- `save.mode` 默认 `'fsa'`（`schema.ts:23`）↔ `offscreen/main.ts:48-50` 三选一 ✅
- `shell.autoOpen` 默认 `'panel'`（`schema.ts:30`）↔ `controller.ts` `uiSettings` ✅
- 功能设置 `MediaDownloadSettings`（`media-download/settings.ts:27-44`）默认值与 `DEFAULT_MEDIA_DOWNLOAD_SETTINGS` 一致 ✅

**一处不一致**：`settings.platforms.enabled`（`schema.ts:34-38`，默认 `[]`）**没有任何生产代码读取**（只有 `migrations.test.ts:19` 断言默认值）。设置页也没有对应 UI。属于「声明了但没实现」，建议删掉或补上。

### IDB 表结构

四个 store 都由 `idb.ts:27,40-42` 建出：`handles` / `folders` / `logs` / `downloads`。

但：

- `downloads` 表 **零读写**（见 B2）；
- `logs` 表 **零读写**（见 B12）；
- `folders` 表只被 `folder-index.ts` 用 ✅；
- `handles` 表只被 `handle-store.ts` 用 ✅。

### B12【轻微】IDB `logs` 表从未写入，诊断包只有内存日志

`log/logger.ts:36` 的 `logBuffer = new LogBuffer()` 是**内存**环形缓冲（500 条），`logger.ts:43-53` 只 `push` 到内存 + `console.*`。

`storage/idb.ts:12` 注释写「logs —— 诊断用的历史日志（FIFO 2000 条，§6.5）」，`log/diagnostics.ts:261` 还导出了 `DIAGNOSTICS_STORE = STORAGE_KEYS.stores.logs`，但**没有任何代码往里写**。

后果：SW 一重启（30 秒空闲就会被回收）日志全丢，而诊断包正是要在「出问题之后」导出 —— 用户点「导出诊断包」时 `logBuffer` 里通常只剩背景重启后的几行。

**建议修法**：在 `emit()` 里异步写 IDB（批量/节流），或者诊断包只承诺「本次会话日志」并在注释里改掉 2000 条的说法。

---

## 7. 残留垃圾文件是否进入构建 / 测试

### B10【一般】真实商品数据与临时文件已入库，且 scratch 测试会读它

```
$ git ls-files --error-unmatch .tmp-rawdata.json .tmp-oak-render.json 05-pdd-real-data.patch src/platforms/pinduoduo/__scratch-real.test.ts
.tmp-oak-render.json
.tmp-rawdata.json
05-pdd-real-data.patch
src/platforms/pinduoduo/__scratch-real.test.ts
```

- **`.tmp-rawdata.json`（20KB）/ `.tmp-oak-render.json`（115KB）**：真实商品页抓包，含真实商品 ID `547575437012`、真实标题、真实 CDN 地址。已提交进 git。
- **`05-pdd-real-data.patch`（35KB）**：一份未合并的补丁，同样入库。
- **`src/platforms/pinduoduo/__scratch-real.test.ts`**：会被 vitest 跑（`vitest.config.ts:14` `include: ['src/**/*.test.{ts,tsx}']`），我在 `pnpm vitest run` 的输出里确实看到它执行并通过。

它还会**读取绝对路径**：

```ts
// __scratch-real.test.ts:7
const raw = JSON.parse(readFileSync('D:/EcomKit/.tmp-rawdata.json', 'utf8'));
```

换机器 / CI 上直接 `ENOENT` 挂掉。它现在还恰好「通过」纯粹是因为这份文件在本机存在。

**建议修法**（按优先级）：

1. 把四个文件从 git 移除：`git rm --cached` 三个数据/补丁文件 + scratch 测试；
2. 在 `.gitignore` 里补上 `.tmp-*`、`*.patch`、`**/__scratch-*`；
3. 如果这些真实数据有价值，脱敏后移进 `src/platforms/pinduoduo/__fixtures__/real/`，并用 `import.meta.url` 相对路径读取；
4. `package.json` 的 `test` 脚本排除 scratch 文件（或直接删）。

> 注意：`__scratch-real.test.ts` 已被 `tsconfig.json:27` 的 `exclude` 排除吗？—— **没有**。`exclude` 只排 `src/**/__fixtures__/**`，`.test.ts` 仍在 `include` 里，所以它同时影响 `pnpm compile` 和 `pnpm test`。

---

## 8. 必须修清单（按顺序）

| 优先级 | 条目 | 一句话动作 |
|---|---|---|
| P0 | **B5** | 让 engine 走 `gateway.resolveProductFolder()` 定位目录（现在直接按模板新建）；并保护 `_id` 后缀不被截断 |
| P0 | **B2** | downloads sink 接上 IDB（`initialFiles`/`persist`），否则该模式形同虚设 |
| P0 | **B1** | `engine.run` 改用 `sniffed.ext` 判定转码，别再信 `blob.type` |
| P1 | **B3** | 取消也写一次 `.ecbox.json`（只记 ok 项），消除 `(2)` 副本 |
| P1 | **B6** | `dirNames` 加去重校验 |
| P2 | **B4** | m3u8 走 `downloadHls`，或显式失败成 `UNSUPPORTED_STREAM` |
| P2 | **B9** | `deep-scan` 兜底不要把详情图当主图 |
| P2 | **B8** | 价格 0 视为未知，不写 `¥0.00` |
| P2 | **B7** | 主按钮计数与 planner 过滤口径统一 |
| P2 | **B10** | 清掉入库的真实抓包与 scratch 测试 |
| P3 | **B11 / B12** | 迁移框架接线；或明确降级文档承诺 |

---

## 8.5 一个必须知道的背景：876 个测试全绿，但上面 12 条问题一条都测不出来

审计收尾时跑了一次全量测试：

```
 Test Files  56 passed (56)
      Tests  876 passed (876)
   Duration  11.26s
```

原因是**测试覆盖的边界刚好绕开了所有问题**：

| 缺口 | 证据 |
|---|---|
| 没有 engine 的测试文件 | `src/features/media-download/` 下 8 个 `.test.ts`，没有 `engine.test.ts` / `payload.test.ts` |
| runner 的「取消」测试只断言状态 | `runner.test.ts:156-169` 只 `expect(status).toBe('canceled')`，**没有**断言 finalize 是否被调用 |
| runner 的 finalize 测试只测正常完成 | `runner.test.ts:213-220` `expect(finalize).toHaveBeenCalledOnce()`，没有取消场景 |
| `resolveProductFolder` 有 7 个测试 | `fs-gateway.test.ts:11-83`，但**生产代码从不调用它** —— 测了个死函数 |
| 真实抓包只用于「证明能跑通」 | `__scratch-real.test.ts` 只 `expect(draft).toBeTruthy()`，不断言价格/分类正确性 |

**建议**：P0 的三条（B5/B2/B1）各自补一个**端到端**测试（真跑 `mediaDownloadJobType` 的 plan→run→finalize，断言目录树 + `.ecbox.json` 内容），而不是只测纯函数。我这次的探针（见附录）可以直接改造成回归测试。

---

## 9. 本次审计**未能**验证的部分（需要真机）

以下结论全部基于 unit 层 + happy-dom，**没有**在真实 Chrome 扩展环境跑过，请勿当作已验证：

1. **`OffscreenCanvas` / `createImageBitmap` 在 offscreen 文档里是否可用**：happy-dom 里两者都存在（我确认过 `typeof OffscreenCanvas === 'function'`），但那是 vitest 的 polyfill，不代表 Chrome offscreen 文档的真实能力。B1 的修法（转码）必须在真机确认。
2. **`chrome.downloads.download` 的 `filename` 语义**：我用假 API 验证了 `downloads.ts` 的路径拼接逻辑，没有验证 Chrome 是否会按 `电商素材/拼多多/...` 建子目录。
3. **FSA `createWritable` 在 offscreen 文档里的权限**：代码假设可以（`fsa.ts:113`），没有真机验证。
4. **`.ecbox.json` 在 downloads 模式下是否真的能被 `chrome.downloads.search` 找回**：见 B2，目前代码里没有任何实现。

---

## 附录：审计期间用过的临时探针

全部写在 `test/__audit_probe*.test.ts`，**已 `Remove-Item` 删除**，`git status` 确认 `test/` 已不在工作区。

覆盖的验证点（供复核）：

| 探针 | 验证内容 |
|---|---|
| A | plan 拼接 folder 后的真实落盘路径 |
| B | 同商品重复下载是否产生 `(2)` |
| C | PNG/JPEG/WebP 的扩展名与转码行为 |
| D | `.tmp-oak-render.json` 抓包是否能解析 |
| E | `.tmp-rawdata.json` 的真实素材数与价格 |
| F | 长模板是否丢 `_id` 后缀 |
| G | `dirNames` 重名是否撞目录 |
| I | `def.dedupeKey` 是否被 runner 调用（**未被调用**，见下） |
| J | 取消后是否执行 finalize |
| K | `detailMinWidth` 过滤后的计划数 |
| V1–V9 | 工作区 WIP 版本的端到端目录树/清单/增量 |
| W1–W4 | HLS、octet-stream、未知 mime 的落盘行为 |
| X1–X3 | webp 字节 + jpeg 头、downloads sink、history.get |
| Y1–Y3 | history.get 全链路 |

### 顺带发现：`JobTypeDef.dedupeKey` 声明了但没人调用

`kernel/jobs/types.ts:85` 声明了 `dedupeKey?(p: P): string`，`engine.ts:73` 也实现了它。但 runner 的 `enqueueInternal`（`runner.ts:403-459`）**从不调用** `def.dedupeKey` —— 去重完全依赖 bg 传来的 `record.dedupeKey`（`page.tsx` 自己拼的 `${platform}:${productId}`）。

我用探针确认：注册一个带 `dedupeKey()` 的类型后跑完整任务，`dedupeKey` **一次都没被调用**。

这不算 bug（两处拼出来的 key 恰好一致），但意味着「同商品同时间去重」的正确性依赖页面侧，任何绕过 `page-api` 的提交路径都能绕过它。建议 runner 在 `scheduler.submit` 前用 `def.dedupeKey?.(parsed) ?? record.dedupeKey` 覆盖。
