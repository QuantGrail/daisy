# ADR-154：模型读到的名字从 Harbor 改成 Daisy（P6-04）——提示词与标记、工具名 `daisy`、本机时区；写新读旧，旧对话照旧能用工具

- 日期：2026-11-18
- 状态：**已实施（分支 `p6-04`，基于 `p6-gate`，待合入）**
- 来源：维护者的决定（开源整理：中文名就叫 Daisy；改名兼容旧名；写死的北京时间改为本机时区；组织启动核心依赖的注入标记先不改写法，读取端兼容新旧两种）
- 相关：旧版的几条约定（Daisy 的工具与调度器；常驻 Agent 的提示词、cron 人话；只问支线；Claude 副本的标题标记；分层提示词、注入标记）、ADR-127 补记 P4N-3（Codex 线程记下开始时带的工具）、ADR-152、ADR-153

## 背景

模型读到的文字（系统层说明、工具说明、唤醒标题、合并 / 携带的标签、只问的旁路提问、工具错误、后台输出文件里的截断提示）还在说 “Harbor”；Daisy 自己的工具以 Claude Code 的进程内 MCP 服务器 `harbor`（`mcp__harbor__*`）和 Codex 的动态工具 `harbor_*` 出现。还有几样“标记”既写进存下的数据、又被 Daisy 拿来比对：补送唤醒的开头、Claude 副本的标题、审批事件的发送者、只问的“需要读文件”回答、注入标记。时间按写死的北京时间（UTC+8）写给模型和主人看。

难点是工具名：Codex 只在 `thread/start` 接收动态工具，一个线程一直用开始时的那套名字；Claude Code 每次启动重新列工具，但续上的对话一直沿用引擎第一次请求时记下的系统提示（旧版分层提示词时实测），历史里的工具调用也是旧名字。直接换名字，旧对话里的模型会去调不存在的工具。

## 决定

### 1. 新旧对照

| 旧 | 新 | 读的一方 |
| --- | --- | --- |
| 模型读到的 “Harbor”（定时与后台说明、常驻 Agent 的角色与时间段、只问支线说明与旁路提问、系统层更新 / 只问支线的开头、工具说明与结果、定时器 / 定时任务 / 后台命令 / 监视的唤醒标题、补送与暂停期间的标题、携带 / 追加的标签、合并分隔线、分类器重试事件、Codex 自动审查转交、只问摘要携带、工具错误 “Harbor 工具不可用” / “No active Harbor turn” / “Harbor does not support …”、后台输出文件的 “[Harbor：输出超过 …]”、组织插件回调的 “由 Harbor 转达”） | “Daisy”（契约包里取 `PRODUCT_NAME`） | 只写，不比对 |
| 补送唤醒开头 `【Harbor 补送后台回报】` / `【Harbor 补送外部回调】` | `【Daisy 补送…】` | `isRedeliveryWake` 两种都认（排队中的旧任务） |
| 只问的回答标记 `[[HARBOR_NEEDS_FILES]]` | `[[DAISY_NEEDS_FILES]]`（`ASK_NEEDS_FILES`） | `sideQuestionNeedsFiles` 两种都认（旧值 `ASK_NEEDS_FILES_LEGACY`） |
| Claude 副本标题标记 `Harbor fork` / `Harbor rewind` | `Daisy fork` / `Daisy rewind`（`HARBOR_FORK_TITLES`） | `isHarborForkTitle` 两种都认（`LEGACY_FORK_TITLES`） |
| 审批事件发送者 `Harbor 系统` | `Daisy 系统`（`SYSTEM_SENDER`） | `isSystemSender` 两种都认（界面 `present.ts`） |
| 注入标记 `Harbor 注入`（`INJECT_MARK`） | **照旧写 `Harbor 注入`**（维护者的决定） | `coreKnowsInjection` 认 `Harbor 注入` 和 `Daisy 注入`（`INJECT_MARKS`） |
| MCP 服务器 `harbor`、`mcp__harbor__<名字>` | `daisy`、`mcp__daisy__<名字>` | 见第 2 节 |
| Codex 动态工具 `harbor_<名字>` | `daisy_<名字>` | 执行端收调用时两种都认（`bareToolName`） |
| `RunnerJob.harborTools: { version: 1 }` | `RunnerJob.daisyTools: { version: 2, legacyNames? }` | 执行端先读 `daisyTools`，没有再读 `harborTools`（旧控制面 → 旧名字） |
| 分层提示词输入 `harborTools` | `daisyTools` + `toolNames` | 进程内 |
| 启动审计条目字段 `harborTools` | `daisyTools`（加 `toolNames`） | 只写（证据） |
| 执行端能力声明 | 新增 `daisyTools: { version: 2 }` | 控制面据此决定发哪个字段、文字用哪套名字 |
| 会话记录 `nativeTools.version` 1 | 2 = 这段原生对话用新名字；Claude Code 新对话也记 `{ thread, version }`（不记名字） | `sessionToolNames` |
| 北京时间（`BEIJING_OFFSET`、`bothTimes`、`cronText`、模板换算、中途追加的时间行、常驻 Agent 的时间段、来源提示里本人原话的时间） | 本机时区（`Intl` 解出的时区），文字里写出时区名；`BEIJING_OFFSET` 删除 | — |

工具集版本 `DAISY_TOOLSET_VERSION` = 2（之前隐含为 1）。

### 2. 工具名的兼容：按原生对话开始时的名字服务

规则（`packages/contracts/src/native-tools.ts` `sessionToolNames`）：

- 还没有原生对话：新名字（新对话开始时就拿到新名字）。
- Codex：看这个线程的记录。`version` 2 → 新名字；1 → 旧名字（线程开始时登记的就是 `harbor_*`，之后也加不进新的）；这个线程没有记录 → 它根本没有 Daisy 的工具，按新名字写“缺少的工具”那一行。
- Claude Code：会话记录过 `version` 2（不论记在哪个原生 id 上：回退会换原生 id，但还是同一段对话）→ 新名字；没有记录或记录是 1 → 旧名字。没有记录 = 本 ADR 之前开始的对话（以前 Claude 不记）。

控制面按这个规则决定**一次**，同时用在两处：组提示词（分层提示词的定时与后台段、缺少工具段、常驻 Agent 的各段）和发给执行端的 `daisyTools.legacyNames`。执行端按 `legacyNames` 选服务器名 / 工具前缀（Claude `sdkMcpServers`、`--allowedTools`、MCP `serverInfo`；Codex 新线程的 `dynamicTools`），没有分层提示词时自己拼的说明也用同一套名字。所以文字里写的名字和实际能调的名字总是一致。新开始的对话由执行端报告 `nativeTools`（Codex `version` 2 + 名字；Claude `version` 2，在它宣布会话 id 时报一次），之后续上仍是新名字；续上的旧对话不报，记录不变。

执行端还有两道兜底：收到 Codex `item/tool/call` 时 `daisy_` / `harbor_` 前缀都去掉（`bareToolName`，工具宿主 `call` 也去一次），Claude 的 MCP 请求只答自己登记的那个服务器名。

**新旧版本混用**：执行端声明 `daisyTools.version >= 2` 才发 `daisyTools`；没声明的旧执行端照旧收到 `harborTools: { version: 1 }`，它只会用旧名字服务，所以控制面给它组的文字也用旧名字（`toolNamesFor`）。新执行端连旧控制面：只有 `harborTools`，按旧名字服务（旧控制面的文字就是旧名字）；新开的对话记 `version` 1，以后升级控制面后这段对话继续用旧名字。

不选的做法：

- 全部直接换新名字：旧 Codex 线程从此没有可用的 Daisy 工具（P4N-3 的“缺少工具”提示会出现，但功能丢了）；旧 Claude 对话的系统提示说 `mcp__harbor__wakeup`、实际只有 `mcp__daisy__wakeup`。
- 新旧两套名字同时登记：Codex 线程的工具在开始时就定了，加不进；Claude 两套工具会让模型看到重复的工具，说明里的名字也会对不上其中一套。
- 迁移存下的会话：原生对话的历史在引擎那边，Daisy 改不了。

已知的小遗留：用 /fork 从 Claude 对话分出的**新会话**没有记录，按旧名字服务（分出的历史里两种名字都可能有）；能用，只是名字旧。主人自己在 Claude Code 设置里写的 `mcp__harbor__*` 允许规则不会自动改名（Daisy 自己的允许列表随服务器名走）。

### 3. 注入标记

组织启动核心（由组织插件在本仓库之外维护）按 “Harbor 注入” 这几个字判断会话是不是经产品注入的，所以 `INJECT_MARK` 继续写 `Harbor 注入`（组织层第一行、系统层更新和只问支线的开头里）。读的一方（`coreKnowsInjection`：核心是不是认识注入）两种写法都认，这样核心那边改成 “Daisy 注入” 时 Daisy 不用同时发版。**后续工作**（给核心的维护者）：启动核心文档把判断改成同时认 “Daisy 注入”；之后 Daisy 才能把写法改成 `Daisy 注入`（改 `INJECT_MARK` 一处）。

### 4. 本机时区

维护者的决定：写死的北京时间改为本机时区。

- `localTimeZone()`（已有）给 `{ name, offsetMinutes }`；新 `zoneName()` 给名字（IANA 名，取不到时 `UTC±hh:mm`）。
- 定时器的“人话”模板（每天 / 工作日 / 每周几的几点、每 N 小时）现在就是控制面所在时区的时间，和 cron 的时区相同，不再换算；`templateCron` / `cronTemplateOf` 的时区参数保留但不再影响结果。`cronText` 写 「每天 09:00（Asia/Shanghai）· UTC 01:00」，时区是 UTC 时只写一次；`bothTimes` 同理。
- 中途追加的时间行：「（主人在你工作中途追加，发出于 10:05，追加于 10:20，时区 Asia/Shanghai；…）」。
- 来源提示里本人原话的时间：「2026-10-31 14:02 Asia/Shanghai」。
- 常驻 Agent 的“怎么安排时间”：「（周期，按服务器所在时区 Asia/Shanghai）」（原来说主人在设置里看到北京时间和 UTC，界面早就不这样显示了）。执行端自己拼这一段时（分层提示词关着），用控制面随任务带来的时区名（任务里会话副本的 `resident.timeZone`，不存库），所以执行端在别的机器上也写对时区。

界面没有用这些函数（它从 `GET …/schedules` 拿 `timeZone`），不受影响。

## 测试

- 新 `tests/model-names.test.ts`：各标记新写法写出、新旧都认；注入标记照旧写、两种都认；工具名的规则表（新对话、Codex 记录 1 / 2 / 无、Claude 有无记录、旧执行端）与任务字段；端到端（假 CLI）——Codex 新线程拿到 `daisy_*` 并记 `version` 2，同一线程记录改成 1 后续上：说明写 `harbor_*`、模型按 `harbor_wakeup` 调用成功、不出“缺少工具”、记录不被改写；Claude 新会话服务器 `daisy`、续上仍是 `daisy`，去掉记录（本 ADR 之前的对话）后续上：服务器 `harbor`、允许列表和说明都是 `mcp__harbor__*`、调用成功、不补记录；时区在 UTC、America/New_York、Asia/Kolkata 下的 `bothTimes`、`cronText`、中途追加行、`when`、常驻 Agent 时间段、模板。
- `tests/fixtures/prompt-off-chain-base.json`：手工改，只改计时说明里的产品名和工具名（`mcp__daisy__*`、`daisy_*`、服务器 `daisy`）；本机重新生成的结果与改后的文件在非只读条目上完全相同，逐词对比只有这些词变了（测试文件头注明）。
- `tests/fixtures/prompt-legacy-74a2714.json` 不动：测试里用一个写明的替换表（产品名、时区一句）对照，旧控制面的任务仍是旧工具名；进程键里的哈希先核对等于旧文字的哈希，再换成改名后文字的哈希。
- 改了期望的：`codex-thread-tools`（新线程 `daisy_*`、`version` 2；记录 1 的线程仍是 `harbor_*`）、`scheduler`、`prompt-layers`、`prompt-layers-runner`、`prompt-layers-e2e`、`native-append-rules`、`context`、`review-background`、`title-sync`（新旧标记都被拒为改名）、`source-prompt`（时区相关的断言按本机时区算，任意 TZ 都过）、私有组织插件包的回调测试。假 CLI（`tests/fixtures/agent.cjs`）按它拿到的服务器名（`daisy` 或 `harbor`）发 MCP 请求。

## 没改的

- 环境变量、磁盘名（ADR-153）；导出的 TS 名字（`HarborToolHost`、`HARBOR_FORK_TITLES`、`isHarborForkTitle`、`HarborSchedule` 等，P6-05）；注释（P6-06）；A2A 标识（保留）。
- 私有组织插件包（不公开）里给它自己的服务端看的标识（`harbor-<agent>`、`harbor-runner`、回调来源 `/^harbor-/`）：那个服务端在本仓库之外按它们匹配，改要两边一起（后续工作）。
- 界面里说明注入标记的文字照旧写「Harbor 注入」，因为那就是写进去的标记。
- 测试夹具协议行 `HARBOR_TOOL`、记录里的 `harbor-tool` / `harbor-tools-list`（测试内部）。

## 回滚

还原本次提交即可：新写的标记旧代码不认（补送唤醒、副本标题、发送者、只问标记——只影响显示或多一次只问支线）。本版本开始的 Codex 线程登记的是 `daisy_*`，旧代码只去掉 `harbor_` 前缀，这些线程里的工具调用会失败，直到开新对话；本版本开始的 Claude 对话在旧代码里重新拿到服务器 `harbor`，系统提示要到压缩后才换回旧名字。
