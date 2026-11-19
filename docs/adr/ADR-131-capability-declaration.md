# ADR-131：能力声明贯通——统一能力清单按 harness、按 CLI 版本声明，服务端、界面、命令行按声明办事

- 日期：2026-11-17
- 状态：**已实施（P4-11，分支 `p4-11`，未合入 `daisy-next`，等阶段 4 关口）**
- 工作包：P4-11（能力声明贯通）
- 相关：设计要求——统一的能力清单与规则；“问”要只读档、旁问或分叉。旧版的约定：`agent-capabilities.ts` 的来历与 `input.*`（插队进 harness 自己的输入队列，统一能力声明 + 兜底）、`stop`（停止连带本轮子 Agent 与命令）、`settings`（改模型 / 推理强度 / 权限模式不重启进程）、`approvals` 与 `background`（自动审查拒绝也出拦截卡、列出全部后台任务）、`askOnly` 与 `rewind`（只问与回退走 harness 自己的能力）、`title`（标题走 harness 自己的能力）、`rewind.files` 的 `harbor`（Daisy 按轮做文件快照）、`modelSwitch`（能力层收尾）；P4-10（通用 ACP 适配器，ADR-130）

## 背景

设计规定一份统一的能力清单：四项必备（开会话与恢复、发消息并流式返回、取消、工具授权与提问），八行可选（运行中追加、回退、分叉与压缩、切模型与推理强度、权限模式、旁问或分叉、用量与额度、后台任务与终端窗口）。规则是：每个适配器声明自己支持哪些可选能力；界面只显示声明了的功能；命令行调用未声明的能力时明确回答“不支持”；harness 没有的能力不模拟；不另起一套，扩 `agent-capabilities.ts`。

旧版起的 `AgentCapabilities` 已经按 harness、按 CLI 版本（`capabilitiesFor`）声明了一部分（`input`、`settings`、`approvals`、`background`、`askOnly`、`rewind`、`title`、`modelSwitch`），由 Runner 每次心跳放在 `capabilities.agentFeatures[agent]` 里报告。缺的是：分叉、压缩、用量、额度、终端窗口、只读档、必备四项没有声明；界面和服务端很多地方按 `agent === "kimi"` 之类的名字判断；命令行没有统一的“不支持”回答。

## 决定

### 1. 清单：一项一个键，挂在原来的声明上

`agent-capabilities.ts` 加 `REQUIRED_FEATURES`（`session`、`stream`、`cancel`、`approvals`）和 `OPTIONAL_FEATURES`（`steer`、`withdraw`、`rewind`、`rewindFiles`、`fork`、`compact`、`model`、`effort`、`permissionMode`、`readOnly`、`askOnly`、`usage`、`quota`、`background`、`terminal`）。清单的一行可能拆成两个键（“分叉与压缩”→ `fork` + `compact`；“运行中追加”→ `steer` + `withdraw`；“用量与额度”→ `usage` + `quota`；“后台任务与终端窗口”→ `background` + `terminal`；“权限模式”另有 `readOnly`，因为“问”只看只读档），因为界面和命令行是按单项开关的。

值沿用旧版的 `native | harbor | none`：`native` harness 自己做；`harbor` Daisy 用 harness 自己的办法替它做（切设置 = 重启进程接着原会话；文件回退 = Daisy 每轮的快照；“问” = 只读支线；`steer` = 适配器把纯文字送进本轮）；`none` 不提供。（命名决定：能力取值 `harbor` 改为 `fallback`，见 ADR-152；本包当时不动名字。）

`AgentCapabilities` 加两个可选字段：

- `features?: FeatureDeclaration`——上面那些块表达不了的项（必备四项、`fork`、`compact`、`usage`、`quota`、`terminal`，以及 `steer` 在原生追加之外的退路）。
- `readOnly?: Cap<{ strength: "strong" | "weak"; mode?: string }>`——只读档，`weak` 就是“弱只读”（维护者的决定：只读挡不住全部写操作的 harness 也接受“问”，如实写明是弱只读）。

`agent` 的类型放宽成 `"claude" | "codex" | "kimi" | (string & {})`，好让配置里的 ACP harness 用自己的编号。

本版本三家的声明（`AGENT_CAPABILITIES`，Runner 按检测到的 CLI 版本经 `capabilitiesFor` 降级）：

| 键 | Claude Code | Codex | Kimi Code |
| --- | --- | --- | --- |
| steer | 2.1.316 起 native，以下 harbor（纯文字） | 0.157 起 native，以下 harbor | none |
| withdraw | 2.1.316 起 native | none | none |
| rewind / rewindFiles | native / native（在线；2.1.316 以下 harbor / none，老 Runner 仍按旧版约定算 native） | native / harbor（关掉快照则 none） | native（`/undo`）/ none |
| fork / compact | native / native | native / native | native（ACP `session/fork`，不稳定）/ native（`/compact`，沿用原行为） |
| model / effort / permissionMode | native（以下：model native，其余 harbor） | native（以下：effort native，其余 harbor） | harbor（重启） |
| readOnly | native，强 | native，强 | native，弱（`plan`） |
| askOnly | native（旁问） | native（临时分叉） | none（见“留下的问题”） |
| usage / quota | native / native | native / native | native / none |
| background / terminal | native / native | native / native | harbor / native |

### 2. 拍平：`featuresFor(nodeCaps, agent)`

新文件 `contracts/src/agent-features.ts`（从 `@daisy-ai/contracts` 导出）。`featuresFor` 读节点报告里这个 agent 的声明，拍成 `Record<AgentFeature, Support>`：

- `features` 里写 `none` 的，一律 none（显式不支持优先）。
- 否则以测过、按版本降级过的块为准（`input.steer` 原生、`rewind.*`、`settings.*`（`restart` → `harbor`）、`readOnly`、`askOnly`、`background.list`），没有块的用 `features` 的值，都没有就是 none。
- 没有报告（老 Runner、还没见过的节点）：三家按本版本的表、CLI 版本未知计算；别的 harness 什么都没有。报告里没有 `features`（P4-11 之前的 Runner）：用本版本表里的 `features`。`rewindFiles` 仍走旧版的 `rewindFilesRoute`（老 Runner 的 Claude Code 算 native）。

同一文件给出人看的名字（`FEATURE_TITLES`）、一句话的不支持说明 `unsupportedMessage(agent, key)`（“这个 AI（Codex）不支持「分叉」：它的能力声明里没有这一项，Daisy 不模拟”）、`unsupportedFix(key, map)`（怎么办，按项给：追加 → 改用排队发送；回退时撤销文件 → 不带 files 再回退一次；切模型 → 改身份档默认值……只在终端窗口已声明时才建议用它）。

### 3. 服务端：快照带声明，未声明就拒

- 会话快照（`GET /api/sessions/:id`，两种视图）多一项 `features`，`rewindFiles` 保留给老界面。节点报告按原文缓存解析（`sessions/features.ts`）。
- 未声明就拒：409，`code: "capability_unsupported"`，`error` 是那句不支持说明，`fix` 是怎么办（错误处理器新透传 `fix`，过脱敏）。挡在这些地方：
  - `POST /api/sessions/:id/operations`：`fork`、`compact`、`rewind`（带 `files: true` 还要 `rewindFiles`）——在幂等重放之后、排队检查之前，被拒的不建任何 job；
  - `POST …/operations/terminal`：`terminal`；
  - `POST …/steer`、`POST …/queue/merge-steer`：`steer`；
  - `PATCH /api/sessions/:id` 给会话单独设模型 / 推理强度：`model` / `effort`（设回空串“用身份档的”总可以）。
- 路由定义的 `errors` 加上 `capability_unsupported`，`docs/api` 重新生成。路由本身没增没减，权限矩阵不变。

**带 `files: true` 的回退改为整个拒绝。** 以前声明了不能撤销文件（低版本 Claude Code、关了快照的 Codex、Kimi）时，服务端照样排队，回退只做对话、结果里写“文件未回退”。现在按“未声明就明确回答不支持”当场拒绝、什么也不做，人再选“只回退对话”。这和旧版约定“为免只撤销一部分会整个拒绝”一致。运行中才发现做不到的（Claude Code 进程不在线等）仍按原样在结果里说明。

### 4. 界面：按声明显示

- 斜杠菜单 / 命令中心（`commandList(agent, discovered, features)`）：`/compact`、`/fork`、`/rewind`、`/model`（模型和推理强度都不能切才隐藏）、`/permissions`、`/terminal` 按声明出现；harness 自己报的同名提示词命令也一并隐藏。对应关系在 `COMMAND_FEATURES`。手敲一个被隐藏的命令，提示那句“不支持”，而不是“未知命令”。
- 「立即追加」、合并追加（`canSteer`、`steerBlockReason`、`queueBulk`）：看 `features.steer`，原来是 `agent !== "kimi"`。说明改成“Kimi Code 不支持追加到本轮”（名字来自 `harnessName`）。
- 编辑并重发（它是一次回退）：未声明 `rewind` 时不出“编辑”。
- 模型标签（点开是 /model）：模型和推理强度都不能切时不显示。
- 「同时撤销文件」：原来就看快照的 `rewindFiles`；老服务端没给时的退路从 `agent === "claude"` 改为 `featuresFor(null, agent)`。
- 快照里的 `features` 变了（Runner 升级了 CLI）界面会重画。
- 老服务端（快照没有 `features`）：菜单照旧全出，追加按本版本表（Kimi 不出）。

### 5. 命令行

命令行没有自己的判断：服务端拒了，`apiError` 优先用回答里的 `fix` 做“怎么办”，没有才查本地的 `FIXES`（新增 `capability_unsupported` 的通用说法）。409 退出码 1，与现有错误一致：

```
✗ 这个 AI（Codex）不支持「分叉」：它的能力声明里没有这一项，Daisy 不模拟
  怎么办：换一个声明了「分叉」的 AI 新建会话（daisy workspace catalog 看有哪些身份档）
```

### 6. 换掉的按名字判断

| 位置 | 原来 | 现在 |
| --- | --- | --- |
| `sessions/commands.ts` 立即追加 | `s.agent === "kimi"` → 409 | `requireFeatures(…, "steer")` |
| `sessions/commands.ts` 合并追加 | `s.agent === "kimi"` → 409 | `requireFeatures(…, "steer")` |
| `sessions/commands.ts` 队列行 `steerIn` | `s.agent !== "kimi"` | `features.steer !== "none"` |
| `sessions/commands.ts` 插队时老 Runner 的纯文字追加 | `s.agent !== "kimi"` | `features.steer !== "none"` |
| `sessions/native-append.ts` `daisySteer` | `s.agent === "kimi"` | `features.steer === "none"` |
| `sessions/native-append.ts` `appendBlocker` 说明 | `s.agent === "kimi"` | `features.steer === "none"`（名字用 `harnessName`） |
| `ui/queue-jump.ts` `canSteer` / `steerBlockReason` / `queueBulk` | `agent !== "kimi"` | `steerDeclared`（快照 `features.steer`，退路本版本表） |
| `ui/rewind-copy.ts` 老服务端的退路 | `agent === "claude"` | `featuresFor(null, agent).rewindFiles` |
| `contracts/commands.ts` 菜单 | 不分 | `commandOffered(name, features)` |

没有换、因为不是在挡清单里的某项能力：回退结果的措辞（`rewindNotice` 里“Codex 不支持撤销文件改动”）、各家原生协议的参数（Codex 的 `turnId`、Claude 的 `uuid`）、身份档（`identity`、API key、模型槽位只有 Claude）、Codex 专有的服务档位和沙箱选项、`/review`（Codex 专有命令）、斜杠前缀 `$` / `/`、用量和额度界面的措辞（`present.ts`）、标题（旧版已按声明）、Runner 内各适配器自己的实现。

### 7. 给 P4-10 的接口：配置里声明能力

```ts
import { declareCapabilities } from "@daisy-ai/contracts"; // contracts/src/agent-features.ts
const report = declareCapabilities(entry.id, {
  features: { fork: "native", rewind: "native", model: "native", effort: "native", askOnly: "native", usage: "native" },
  readOnlyMode: "plan",          // 哪个模式值算只读，可为 null
  readOnlyStrength: "weak",      // 弱只读；默认 weak
}, cliVersion);
```

它按声明生成完整的 `AgentCapabilities`（`input`、`settings`、`rewind`、`askOnly`、`background`、`title`、`features`、`readOnly`），没写的可选项都是 none，必备四项总是 native。挂接点是 Runner 的 `capabilities()`（`turns/worker.ts`）：现在对 `["claude", "codex", "kimi"]` 逐个 `capabilitiesFor` 写进 `results.agentFeatures`；P4-10 对每个配置条目加一行 `results.agentFeatures[entry.id] = declareCapabilities(entry.id, entry.capabilities, version)`（也可以在 `initialize` 返回后用 harness 实际声明的 `sessionCapabilities` 收窄）。之后服务端、界面、命令行不用改。会话的 `agent` 目前还是 `AgentSchema` 的三选一；P4-10 若放开它，`featuresFor` 已经按任意编号工作。

## 测试

`tests/agent-features.test.ts`（6 条）：清单完整、必备四项总在；三家按 CLI 版本的声明；不支持的能力在界面上（假 harness 只声明 `rewind`、`usage`：菜单里没有 fork / compact / model / permissions / terminal，「立即追加」不出、给出说明，「同时撤销文件」不出）；在服务端（快照的 `features`；fork、compact、带文件的回退、终端、立即追加、合并追加、设模型、设推理强度都是 409 `capability_unsupported` + `fix`，被拒的不建 job；换成完整声明后同样的调用过了声明这一关）；在命令行（真服务端 + 运行时文件，`daisy session operation run <id> fork` 和 `daisy session steer` 退出码 1，打印“✗ 这个 AI（Codex）不支持「分叉」…”和“怎么办：…”，输出里没有凭据）；Runner 的 `capabilities()` 报告里带声明、按 CLI 版本降级。

跟着改的旧测试：`native-append-rules`（说明里的名字是 Kimi Code）；`rewind-native`「review L4」与 `rewind-files-fallback`「turned off on the node」（带文件的回退现在当场拒绝，只回退对话仍可以）。

## 留下的问题

- Kimi 的 `askOnly.fork` 仍是 `none`。P0-03 说 Kimi Code 经 ACP 能分叉，但“问”的只读支线要适配器真的做（分叉 + 切到只读模式）；归 P4-10 / “问”的工作包，改声明时一起改。
- Kimi 的 `compact` 沿用原来的“发 `/compact` 提示词”，P0-03 没核实 Kimi Code 经 ACP 认这条命令；P4-10 可以按 `available_commands_update` 里有没有 `compact` 来声明。
- 只读的强弱按系统不同（Windows 上 Claude Code 没有沙箱等，research README 第 6 条），现在的声明只有一个值；做 Windows（P5-05）时按系统写。
- 用量与额度、后台任务的界面没有按声明隐藏：它们已经在显示“这个 AI 不报告…”的说明，隐藏反而少了信息。
