# ADR-130：通用 ACP 适配器——接入一个会说 ACP 的 harness 等于加一条配置

- 日期：2026-11-17
- 状态：**已实施（P4-10，分支 `p4-10`，已把 `p4-11` 合并进来；未合入 `daisy-next`，等阶段 4 关口）**
- 工作包：P4-10（通用 ACP 适配器）
- 相关：设计要求——接入 harness 分三层（统一能力清单、通用 ACP 适配器、原生适配器），二线与实验档，配置项；“问”要只读档；维护者的决定：只读挡不住全部写操作的 harness 也接受“问”，如实写明是弱只读。P0-03 的 `docs/research/acp-harnesses.md`、`deepseek-harness.md`；旧版的约定（能力声明 + 回退；一会话一进程）；ADR-131（P4-11 能力声明贯通）

## 背景

设计把二线和实验档的 harness 都放在 ACP 上：Kimi Code CLI（`kimi acp`）、OpenCode（`opencode acp`）、Antigravity（`agy acp`）、DeepSeek Harness（`dsh acp`，开发者预览）。原来只有一个写死给 Kimi 的 `harness/kimi.ts`，外面还有二十来处 `agent === "kimi"`：身份档的权限模式、登录命令和授权页地址、CLI 目录变量、配置文件位置、额度说明、压缩阈值说明、界面的名字 / 颜色 / 头像字母、选择列表、Runner 的版本探测、`daisy doctor`……P0-03 还发现三处协议差异：`session/set_model` 已从 ACP 删除（切模型改走 `session/set_config_option` 按 `category`）、DeepSeek Harness 只有 `session/resume` 没有 `session/load`、`session/fork` 仍是不稳定方法。

## 决定

### 1. 一张表：`packages/contracts/src/acp-harnesses.ts`

每个 ACP harness 一条 `AcpHarnessConfig`，写：

| 字段 | 含义 |
| --- | --- |
| `id` | Daisy 里的 agent 值（会话、身份档、`--agent`） |
| `name` / `short` / `letter` / `color` / `description` | 设置页和 doctor 的名字、句子里的名字、头像字母、颜色、首页一句话 |
| `tier` | `second`（二线：必备能力 + 自己声明的可选能力）/ `experimental`（实验档：能跑通基本对话，不承诺稳定） |
| `launch` | 启动命令和参数（`kimi acp` …），命令可用 `HARBOR_<ID>_BIN` 替换（Kimi 的 `HARBOR_KIMI_BIN` 照旧） |
| `versionArgs` | 版本探测（Runner 检测、doctor） |
| `install` / `binDirs` | 怎么装、装在哪些用户目录（加进 Runner 的 PATH） |
| `configDir` | CLI 目录的环境变量和默认位置（独立登录的身份要它）；没有 = 不能建独立登录身份 |
| `nativeConfig` | Daisy 能读写的配置文件（config.read、MCP 管理）；没有 = 不支持 |
| `login` / `loginHint` | 在 Daisy 里登录的命令、只认的授权页地址、提示；没有 = 只能在本机终端登录，`loginHint` 说怎么做 |
| `modes` | 权限模式、默认值、**哪个值算只读（可空）和强弱**、哪个值跳过所有确认 |
| `efforts` | 会话没列出推理强度时的候选（空 = 只用会话列出的） |
| `resume` | 期望的恢复路径（`load` / `resume`），实际按 `initialize` 的声明选 |
| `legacy` | 还认的旧协议（Kimi：`session/set_model`、`thinking` 配置项） |
| `terminal` | “打开完整 CLI”的参数模板；没有 = 不支持 |
| `quota` / `thresholdReason` | 额度卡和上下文圆环“为什么没有”的说明 |
| `capabilities` | 旧版能力声明（`AgentCapabilities`）形状的声明块（`input`、`settings`、`approvals`、`background`、`askOnly`、`rewind`、`title`、`modelSwitch`） |
| `features` | ADR-131 的统一能力清单键（`fork`、`compact`、`usage`、`terminal`、`permissionMode` …）；必备四项恒为 native |
| `stop` | 停止范围（旧版定下的 `stop` 声明：停止时是否连带子 Agent 与命令） |

`AgentSchema` = `["claude", "codex", ...表里的 id]`；`AGENT_CAPABILITIES`、`AGENT_STOP`、`LEGACY_SETTINGS`、`contextUsageCapability`、模型选项的回退表、品牌色的 schema、`bypassMode`、身份档允许的权限模式、Runner 的检测和 `agentFeatures`、`live.ts` 的适配器表、bootstrap 的本机身份、doctor 的 harness 列表、登录授权页白名单、只读启动的状态目录、旁问 sidecar 的密钥目录、界面的选择列表 / 名字 / 颜色 / 字母 / 权限模式选项，**全部从这张表生成**。表外不再有按某一家 ACP harness 名字的分支（剩下的 `isAcpAgent` 是“ACP 本身没有”的事：系统层通道、运行中追加的旧接口说明、文件回退说明）。

### 2. 不改代码再加一家：`$DAISY_ACP_HARNESSES`

除了源码里的表，Daisy 启动时读环境变量 `DAISY_ACP_HARNESSES` 指向的 JSON 文件（数组，每项同样的形状，缺的字段取通用默认）。`id` 不能和内置的、Claude / Codex、Runner 的其他能力键重名；文件坏了就启动失败并说明原因，不悄悄跳过。（ADR-156 起：文件也可以用 `runner.json` 的 `acpHarnesses` 指定，开机自启时也生效；坏的文件或条目不再让 Daisy 和命令行起不来，只跳过并在日志、`daisy status`、`daisy doctor` 里一行说明。）

JSON 条目**不能**声明适配器没有代码的可选能力（设计要求：harness 没有的能力不模拟）：`capabilities` 一律取通用默认（Daisy 排队、设置靠重启、无原生追加 / 回退 / 标题），`features` 只接受 `fork`、`compact`、`usage` 三个由适配器按对方回答去做的键（分叉仍对照 `initialize` 的声明，压缩仍对照会话的 `available_commands`）。没写 `modes.values` 时权限模式为 none。

这就是设计要求的“接入一个新的 ACP harness 只加一条配置，不改代码”：真机上把一个新 harness 写成一项放进文件、设好变量、重启 Daisy。

### 3. 通用适配器：`packages/daisy/src/harness/acp.ts`

由 `kimi.ts` 改来，行为对 Kimi 不变（`kimi.ts` 只剩 `kimiAgent = acpAgentFor("kimi")` 等别名），差别全按对方的回答：

- **恢复**：`initialize` 声明 `loadSession` → `session/load`；否则声明 `sessionCapabilities.resume` → `session/resume`（DeepSeek Harness）；都没有 → “此版本 X 的 ACP 不支持恢复会话”。管理操作（`operations.ts`）同一个函数。
- **切模型 / 推理强度 / 模式**：会话（`session/new`、`load`、`resume` 的回答，以及 `config_option_update`）列出的 `configOptions` 按 `category`（`model`、`thought_level`、`mode`）找配置项，用 `session/set_config_option`；会话列出 `modes` 的用 `session/set_mode`。会话没列 `model` 项时只有声明了 `legacy.setModel` 的（Kimi）才发 `session/set_model`；没列 `thought_level` 时只有 Kimi 用旧的 `thinking`。其余明确报“不支持”，不猜。
- **分叉**：`session/fork` 只在 `initialize` 声明了 `sessionCapabilities.fork` 时发。
- **压缩**：`/compact` 只在会话的 `available_commands` 列了 `compact`（或没收到命令列表）时交给对方，列了但没有就报“不支持压缩上下文”。
- 名字、错误信息、图片附件名都用表里的 `short` / `id`。

### 4. 四家的配置（按 P0-03 的核实）

| | Kimi Code CLI | OpenCode | Antigravity CLI | DeepSeek Harness |
| --- | --- | --- | --- | --- |
| 档 | 二线 | 二线 | 二线 | 实验 |
| 启动 | `kimi acp` | `opencode acp` | `agy acp` | `dsh acp` |
| 恢复 | load（也声明 resume） | load / resume | load / resume | **只有 resume** |
| 权限模式 | default / plan / auto / yolo | build / plan | 无（ACP 下没有） | 无 |
| 只读 | `plan`，弱（弱只读也接受“问”） | `plan`，弱（同左） | 无 → 不能接受“问” | 无 → 不能接受“问” |
| 跳过确认 | yolo | — | — | — |
| fork / compact / usage / terminal | native / native / native / native | native / none / native / none | none / none / none / none | none / none / none / none |
| 独立登录身份 | 有（`KIMI_CODE_HOME`，`kimi login`） | 无（只用本机登录） | 无 | 无（ACP 不需要认证） |

“none”的项多数是 P0-03 没核实到（OpenCode 经 ACP 的 `/compact`、Antigravity 的分叉、各家能否换 CLI 目录和设备码登录），按“不模拟”的规则先不声明，真机核实后改表即可。

### 5. 和 P4-11 的衔接

P4-11（ADR-131）给出的挂接点是 `declareCapabilities`。本包没有用它生成 ACP 条目的报告，而是在 `AGENT_CAPABILITIES` 里把每一条配置的 `capabilities`（旧版声明块）、`features`（统一清单键）、由 `modes.readOnly` 生成的 `readOnly` 合在一起——原因是配置里的块比 `declareCapabilities` 的输入更细（例如 Kimi 的 `rewind.history` 是 native、`files` 是 none），而且 Runner 已经按 `capabilitiesFor` 对所有 agent 报告，不需要第二条路径。`agent-features.ts` 的“认识哪些 agent”和 `harnessName` 改为读这张表，`featuresFor(null, "opencode")` 之类在没有 Runner 报告时也有答案。合并时冲突的三处（追加的拦截、追加说明、界面的追加判断）取 P4-11 的按声明判断。

### 6. 其他

- bootstrap 首次启动为每个 agent（含四家 ACP）各建一个“主机登录”身份（原来是三个）；已有的数据目录不补建，要用就 `daisy profile create --agent opencode --auth-mode subscription …`。
- doctor 列出全部 harness，实验档注明“实验档，不承诺稳定”，没有 Daisy 内登录的写 `loginHint`。
- 名字：Kimi 的显示名改为“Kimi Code CLI”（句子里“Kimi Code”），旧“Kimi CLI”已归档。

## 测试

- 假 ACP agent `tests/fixtures/acp-agent.cjs`：按配置条目分档（kimi / opencode / antigravity / deepseek / minimal），`initialize` 只声明那家真有的（DeepSeek 不声明 `loadSession`；Antigravity、DeepSeek 没有模式；Kimi 还认 `session/set_model`），没声明的方法回 -32601；会话的标记跨进程保存，能证明恢复后接得上。原来 `agent.cjs` 里的 Kimi 假体不动，老测试照旧。
- `tests/acp-harnesses.test.ts`：表的形状、Kimi 回归、只读强弱（弱只读也接受“问”）、坏配置被拒、不支持的独立身份 / 登录 / 模式被拒、按 `category` 切设置、能力声明与 `/compact` 判断；**二线 harness 的必备能力**：四家各跑一遍整套 Daisy（本地 API + 进程内 Runner + 通用适配器）——开会话、流式（卡片还在等时思考和工具调用已经到了）、授权（允许和拒绝）、取消（进程留着，下一轮同一进程）、恢复（重启 Runner 后新进程按声明用 `session/load` 或 `session/resume`，同一个原生会话，记得之前的内容）；**只加一条配置接入新 harness**：子进程里只有 `$DAISY_ACP_HARNESSES` 的一条配置（命令指向假 agent 的 `minimal` 档），同样五项全过，Runner 用它自己的版本探测检测到它并报告声明。
- 这两项按设计要在真机上验证。自动测试证明的是 Daisy 一侧；真机上还要用真 CLI 跑一遍。本机没有装任何一家，没有运行过真 CLI。

## 留下的问题

- `askOnly`（“问”的支线）对 ACP 仍是普通 @：Kimi Code、OpenCode 声明了 `session/fork`，可以做“分叉 + plan 模式”的只读支线，归“问与办”的 P4-05。
- OpenCode 的 `_session/steering`、Antigravity 运行中再发 prompt 即插话：都不是 ACP 标准方法，没做（`steer` none）。
- 表里未核实的：OpenCode / Antigravity / DeepSeek 的 CLI 目录变量和设备码登录、OpenCode 的 `/compact`、Antigravity 的 `session/fork` 与模式、Kimi Code 的 `/compact` 在 ACP 下的实际效果。
- 弱只读不分系统（Linux 有 Bubblewrap 时其实更强），留给“问与办”的工作。
- `elicitation/create`（表单提问）仍回“不支持”，和改造前一样。
