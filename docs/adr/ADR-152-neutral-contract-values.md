# ADR-152：契约里带旧产品名的取值改成中性写法（P6-02）——能力取值 `fallback`、Daisy 调度器的「后台」条目；写新读旧

- 日期：2026-11-18
- 状态：**已实施（分支 `p6-02`，基于 `p6-gate`，待合入）**
- 来源：维护者的决定（开源整理：命名决定按推荐定，能力取值 `harbor` 改为 `fallback`；改名兼容旧名）
- 相关：旧版的几条约定（Daisy 的调度器与 `harborPending`；能力声明；「后台」列出全部后台任务、每项单独停止；Codex 回退时 Daisy 自己做文件检查点，`via`）、ADR-131（`features` 扁平表）、契约 `docs/contracts/local-api.md` 第 7 节

## 背景

本机接口里有几样取值和字段写着旧产品名 `harbor`，表示的其实是“Daisy 自己做的”：

- 能力声明里的 `harbor`：harness 没有原生做法、由 Daisy 兜底（排队、重启续上、文件检查点、只读支线……）。出现在 `agentFeatures[agent]` 的 `Cap.support`、`askOnly.fork`、`rewind.history / files`、`title.generate`、`features` 的每一项，`agentStop` 的 `subagents / commands`，快照的 `rewindFiles` / `features`。
- 回退结果里 `files.via: "harbor"`：文件是 Daisy 的检查点恢复的。
- 会话字段 `harborPending` 与其中的条目：`source: "harbor"`、编号 `harbor:<计划 id>`、后台命令 / 监视的类型 `harbor_bash` / `harbor_monitor`；`POST …/background/:tid/stop` 回答的 `source: "harbor"`。
- 服务端内部错误对象上的 `harborCode`（错误处理改写成回答的 `code`，不上线）。

这些值存进了数据库（会话记录、节点上报的能力、操作结果），也来自旧版本的执行端，所以改名必须“写新读旧”。

## 决定

### 1. 新写法

| 旧 | 新 | 理由 |
| --- | --- | --- |
| 能力取值 `harbor` | `fallback` | 命名决定：不带产品名，以后改名不动契约 |
| `files.via: "harbor"` | `fallback` | 同一件事（Daisy 的检查点就是 `rewind.files` 的 fallback） |
| `session.harborPending` | `schedulerPending` | 这是 Daisy **调度器**还开着的条目；不用 `fallback`（调度器不是哪项能力的兜底），也不用 `daisy`（同样是产品名） |
| 条目 `source: "harbor"` | `source: "scheduler"` | 同上 |
| 编号 `harbor:<id>` | `scheduler:<id>` | 同上 |
| 类型 `harbor_bash` / `harbor_monitor` | `scheduler_bash` / `scheduler_monitor` | 同上 |
| 停止回答 `source: "harbor"` | `source: "scheduler"` | 同上 |
| 审计动作 `live.task.stop.harbor` | `live.task.stop.scheduler` | 新写的审计行；旧行原样保留 |
| 内部 `harborCode` | `apiCode` | 只在进程内，不需要兼容 |

### 2. 在哪里换：读出的边界（选这个而不是数据迁移）

服务端**只发新写法**；旧写法在读出时换掉，不改库里已有的行：

- **会话记录**：`store/sessions.ts` 的 `parseSessionRecord`（`store.session()`、按 requestId 找、会话列表 `sessionListView`）调契约包的 `normalizeSessionRecord`：`harborPending` → `schedulerPending`，条目经 `normalizeLiveTimer`。调度器下次写这条记录时只写新名字。执行端收到的 `job.session` 来自同一个读取，所以也是新写法。
- **节点能力**：`/api/runner/sync` 存之前 `normalizeNodeCapabilities`（旧执行端的上报）；`nodeCapabilities()`（features 的缓存）和 `nodeView`（`/api/catalog`）读出时再换一次（升级前存下、之后没再上报的行）。契约包的各个路由函数（`inputRoute`、`askOnlyRoute`、`rewindRoute`、`titleRoute`、`reviewRoute`、`featuresFor`）读报告时也经 `normalizeCapabilityValues`，所以直接 `JSON.parse(nodes.capabilities)` 的调用方走这些函数也拿到新写法。只换“装能力取值的键”（`support`、`fork`、`history`、`files`、`generate`、`subagents`、`commands`、`features` 下的每一项），ACP harness 的 id、模式名、`via` 等别的字符串不动。
- **操作结果**：`/runner/jobs/:id/operation-result` 存之前、`GET …/operations/:jid` 读出时都经 `normalizeOperationResult`（`files.via`）。
- **请求**：`POST …/background/:tid/stop` 两种编号都收（`schedulerItemId`）。

为什么不用一步数据迁移改库：`store/schema.ts` 的规则是“结构只增不删”、旧代码要读得了新库（`readable_from`）；改写 JSON 里的取值会让退回旧版本后读到不认识的值。读出时换不碰库，退回旧版本时旧行仍是旧写法；新写下的行旧代码会当成“不认识的取值”（能力当 `none`，后台条目当 Agent 自己的），只影响显示，不丢数据。

### 3. 读的一方两种都认

- 契约包：`isFallback`、`normalizeSupport`、`LEGACY_FALLBACK`（agent-capabilities.ts，经 agent-features.ts 导出）；`isSchedulerItem`、`schedulerItemId`、`schedulerPendingOf`、`normalizeLiveTimer`、`normalizeSessionRecord`、`SCHEDULER_*` 常量（live.ts）。
- 执行端（可能连着更旧的控制面）：`worker.ts` 读 `schedulerPendingOf(job.session)`，`isFallback` 判断自己的 `rewind.files`。
- 控制面直接比较取值的地方用 `isFallback`（`native-append.ts` 的 `harborSteer`、`rewindNotice`）。
- 界面（可能连着旧版本的 Daisy，客户端包能同时连多个）：`backgroundOf` / `backgroundCount` 读 `schedulerPendingOf`，`backgroundSource` / `backgroundStop` / tracebar 用 `isSchedulerItem`，`backgroundKind` 先 `normalizeLiveTimer`，`rewindFilesSupport` 先 `normalizeSupport`。
- 客户端包：`stopBackground` 把旧服务端回答的 `source: "harbor"` 给成 `scheduler`。

### 4. 版本规则

按 local-api.md 第 7 节，改枚举取值、改字段名是不兼容改动，本该等主版本。这里作为**第一次公开发布之前的一次例外**（维护者要求开源前去掉旧名；客户端包和服务端同仓同发；界面和客户端包两种写法都认）。`API_VERSION` 不动；local-api.md 0.1.1 第 7 节记下这张对照表。

### 5. 没改的（属于别的工作包，或和它们绑在一起）

- A2A 线上的内容：扩展标识与错误域 `quantgrail.github.io`（维护者决定保留）；A2A 测试一条没改、照样通过。
- 模型读到的文字、给 harness 的工具名：MCP 服务器名 `harbor`、`mcp__harbor__*`、Codex 动态工具 `harbor_<名字>`（P6-04）。`RunnerJob.harborTools`（是否给 Agent 这些工具，带工具集版本号）和 prompt 层输入里的 `harborTools`、启动审计条目里的 `harborTools` 都和工具名绑在一起，留给 P6-04（改工具名时一起升工具集版本）。
- 环境变量 `HARBOR_*`、磁盘上的名字（`.harbor-restore-*` 等，P6-03）、浏览器存储键（`useSidebarCollapsed("harbor")`）。
- 导出的 TS 名字：`HarborClient`、`HarborSchedule`、`HarborApproval*`、`HarborRewindFiles`、`LiveBadge` 的 `harbor` 属性、`harborOfflineNote`、`NativeRenames.harbor` 等（P6-05）。
- 测试文件名 `rewind-files-fallback.test.ts`、测试标题里的 `harbor_bash`（`platform-pending.json` 按文件 / 标题标记）。

## 测试

- 新 `tests/contract-value-aliases.test.ts`：能力取值新旧两种（`normalizeCapabilityValues` 只换取值键、写时复制；`featuresFor` 对旧报告与新报告一样）；后台条目的编号 / 来源 / 类型 / 旧字段；界面函数读旧快照；客户端包换旧回答；端到端：旧执行端的上报经 `/runner/sync` 存成新写法、升级前存下的节点行经 `/api/catalog` 和会话快照（`rewindFiles`、`features`）发新写法；升级前存下的会话记录（`harborPending`、`harbor:` 编号、`harbor_bash`）经快照和列表发 `schedulerPending`，两种编号都能停，调度器重写后库里只剩新名字；升级前存下的回退结果 `via: "harbor"` 经 `GET …/operations/:jid` 发 `fallback`。
- 改了期望的：`acp-harnesses`、`agent-features`、`background-stop-tree`、`call-chain`、`codex-stop-scope`、`review-background`（两种编号都停）、`rewind-files-fallback`（新旧 `rewindFilesRoute`、横幅、回退提示）、`rewind-native`、`scheduler`、`title-sync`；`native-append-rules` 的“旧 CLI 的追加”按 `fallback` 和 `harbor` 各跑一次（节点行直接写库，即旧行）。

## 回滚

还原本次提交即可：库里没有改写过的行；本版本写下的新写法在旧代码里是“不认识的取值”（见第 2 节末），不丢数据。
