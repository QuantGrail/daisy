# ADR-153：环境变量和磁盘 / 运行时名字从 harbor 改成 daisy，旧名字照样能用（P6-03）

- 日期：2026-11-18
- 状态：**已实施（分支 `p6-03`，基于 `p6-gate`；待合入）**
- 来源：维护者的决定（开源整理：改名保持兼容——先读新名字，没有再读旧名字并提醒一次；已有数据和工作区照常可用；环境变量 `HARBOR_X` → `DAISY_X`）
- 相关：ADR-102（数据目录，`HARBOR_DATA` 不采用）、ADR-152（契约值改名，P6-02）、ADR-154（给模型看的文字和工具名，P6-04）、ADR-155（导出的标识符和注释，P6-05/06）

## 背景

Daisy 由一个更早的实现改造而来。产品名、命令名已经改了，但用户能设、能看到的运行时名字还带着 harbor：约 50 个 `HARBOR_*` 环境变量、git 隔离工作区目录和分支、身份配置备份目录、附件目录、只读沙箱的私有临时目录、Runner 的默认状态目录 `~/.local/share/agent-harbor`、浏览器存储键 `harbor.*`、发给 Codex / ACP 的 `clientInfo`、只问支线的读取禁止名单。这些名字一旦公开就很难再改，所以开源前改，并保证已经在用的机器不受影响。

## 决定

### 1. 环境变量：一个读取口，新名字优先，旧名字提醒一次

`packages/contracts/src/env.ts` 的 `daisyEnv("DAISY_X", env?)` 是唯一的读取口：`DAISY_X` 有值（包括设成空串）就用它；否则读 `HARBOR_X`，每个旧名字在每个进程里只提醒一次：

> `HARBOR_X is deprecated, use DAISY_X（环境变量 HARBOR_X 已改名为 DAISY_X，请改用新名字）`

提醒只写两个名字，不写值。放在 contracts 而不是 daisy 的 platform 里，因为 `agentBinEnv` / `agentCommand`（`DAISY_<ID>_BIN`）在 contracts。`RENAMED_ENV` 列出全部改名的变量，测试逐个确认两个名字都能用、旧名字会提醒、代码里确实读它，并且发布的代码里没有再直接读 `HARBOR_` 名字的地方。

例外：
- `HARBOR_DATA`：Daisy 从来不采用它（ADR-102，旧启动器会把它指向旧系统的数据库），照旧只警告、不读。
- `DAISY_BASE_PATH`：网页构建（`apps/app/app.config.js`，纯 JS 的 Expo 配置）自己读两个名字，规则和提醒文字一样。
- 不进公开仓库的私有插件自己读的变量不在本包范围。

**子进程**：Daisy 自己不给子进程设任何 `HARBOR_` / 改名后的 `DAISY_` 变量（harness 继承 Runner 的环境，设的是 `DAISY_URL`、`DAISY_SESSION_ID`、`DAISY_AI_CREDENTIAL_FILE`，没变）。`daisy start` 起后台进程时去掉自重启开关，现在两个名字都去掉。后台命令（`turns/shell.ts`）原来去掉所有 `HARBOR_*`；现在改为 `isDaisySetting`：所有 `HARBOR_*`、`RENAMED_ENV` 里的名字和 `DAISY_<ID>_BIN` 都去掉（否则改名后 Daisy 的设置会漏进后台命令）；`DAISY_DATA`、`DAISY_SESSION_ID` 等原有的不受影响。没有外部程序需要旧名字，所以不给子进程同时设两个名字。

**测试用的**：`HARBOR_FIXTURE_*` → `DAISY_FIXTURE_*`，`HARBOR_E2E_WEB_DIR`、`HARBOR_COMPAT_BASE`、`HARBOR_WRITE_SNAPSHOT` → `DAISY_*`，只在测试和测试脚本里，不留兼容。

#### 改名表

| 旧名字 | 新名字 | 作用 |
| --- | --- | --- |
| `HARBOR_CLAUDE_BIN` | `DAISY_CLAUDE_BIN` | Claude Code 命令 |
| `HARBOR_CODEX_BIN` | `DAISY_CODEX_BIN` | Codex 命令 |
| `HARBOR_<ID>_BIN`（`HARBOR_KIMI_BIN`、`HARBOR_OPENCODE_BIN`、`HARBOR_ANTIGRAVITY_BIN`、`HARBOR_DEEPSEEK_BIN`……） | `DAISY_<ID>_BIN` | ACP harness 命令（`agentBinEnv`） |
| `HARBOR_ORIGINS` | `DAISY_ORIGINS` | 嵌入宿主的其他来源（只用于嵌入和链接） |
| `HARBOR_BRANDING` | `DAISY_BRANDING` | 嵌入宿主的外观 JSON |
| `HARBOR_BRANDING_FILE` | `DAISY_BRANDING_FILE` | 同上，文件路径 |
| `HARBOR_BASE_PATH` | `DAISY_BASE_PATH` | 网页构建的子路径（构建时） |
| `HARBOR_SERVER_URL` | `DAISY_SERVER_URL` | `scripts/doctor.ts` 探测的地址 |
| `HARBOR_LOCAL_RUNNER` | `DAISY_LOCAL_RUNNER` | `0`：不启动本机 Runner |
| `HARBOR_BOOTSTRAP_LOCAL` | `DAISY_BOOTSTRAP_LOCAL` | `0`：不自动建本机节点 |
| `HARBOR_RATE_LIMIT` | `DAISY_RATE_LIMIT` | 每用户请求限额 |
| `HARBOR_DRAIN_MS` / `HARBOR_DRAIN_GRACE_MS` | `DAISY_DRAIN_MS` / `DAISY_DRAIN_GRACE_MS` | 退出时 HTTP 排空 |
| `HARBOR_RUNNER_SELF_RESTART` | `DAISY_RUNNER_SELF_RESTART` | 自重启开关（`0` / `1`） |
| `HARBOR_RUNNER_RESTART_WAIT_MS` | `DAISY_RUNNER_RESTART_WAIT_MS` | 重启前等空闲的上限 |
| `HARBOR_RUNNER_BACKGROUND_LIMIT` | `DAISY_RUNNER_BACKGROUND_LIMIT` | 节点后台任务上限 |
| `HARBOR_LIVE` / `HARBOR_LIVE_IDLE_MS` | `DAISY_LIVE` / `DAISY_LIVE_IDLE_MS` | 在线会话开关 / 空闲时长 |
| `HARBOR_BG_KEEPALIVE_MS` | `DAISY_BG_KEEPALIVE_MS` | 有后台任务时进程保活 |
| `HARBOR_PROMPT_PILOT_MAX` | `DAISY_PROMPT_PILOT_MAX` | 提示层试点会话数 |
| `HARBOR_NODE_CONFIG` | `DAISY_NODE_CONFIG` | 只问支线额外禁止读取的节点配置文件 |
| `HARBOR_SIDE_QUESTION_MS` | `DAISY_SIDE_QUESTION_MS` | 旁路提问时限 |
| `HARBOR_SIDECAR_BWRAP` | `DAISY_SIDECAR_BWRAP` | `0`：只问支线不套 Bubblewrap |
| `HARBOR_ASK_SIDECAR_CONCURRENT` / `_DAILY` / `_IDLE_MS` | `DAISY_ASK_SIDECAR_CONCURRENT` / `_DAILY` / `_IDLE_MS` | 「只问」限额 |
| `HARBOR_BACKGROUND_PER_SESSION` / `HARBOR_BACKGROUND_PER_NODE` | `DAISY_BACKGROUND_PER_SESSION` / `DAISY_BACKGROUND_PER_NODE` | 定时与后台上限 |
| `HARBOR_MONITOR_MIN_INTERVAL_S` | `DAISY_MONITOR_MIN_INTERVAL_S` | 监视唤醒最小间隔 |
| `HARBOR_TITLE_CODEX_MODEL` / `HARBOR_TITLE_BUDGET_MS` | `DAISY_TITLE_CODEX_MODEL` / `DAISY_TITLE_BUDGET_MS` | 会话标题生成 |
| `HARBOR_AGENT_FRAME_MAX_MIB` | `DAISY_AGENT_FRAME_MAX_MIB` | harness 单帧上限 |
| `HARBOR_CLAUDE_FILE_CHECKPOINTS` | `DAISY_CLAUDE_FILE_CHECKPOINTS` | `0`：不开 Claude 文件检查点 |
| `HARBOR_CLAUDE_FOLLOWUP_MS` / `HARBOR_CLAUDE_STEER_ACK_MS` / `HARBOR_CLAUDE_STEER_IDLE_MS` | `DAISY_CLAUDE_FOLLOWUP_MS` / `DAISY_CLAUDE_STEER_ACK_MS` / `DAISY_CLAUDE_STEER_IDLE_MS` | Claude 插队时限 |
| `HARBOR_CODEX_QUIET_MS` / `_STALL_MS` / `_COMPACT_CHECK_MS` / `_COMPACT_MAX_MS` / `_POLL_MS` / `_STEER_STALL_MS` / `_STOP_KILL_MS` | `DAISY_CODEX_…` 同后缀 | Codex 时限 |
| `HARBOR_CODEX_FILE_CHECKPOINTS` | `DAISY_CODEX_FILE_CHECKPOINTS` | `0`：不做 Codex 文件检查点 |
| `HARBOR_CODEX_CHECKPOINT_MB` / `_FILE_MB` / `_SNAPSHOT_MB` / `_TURNS` / `_FILES` / `_MS` / `_TOTAL_MB` / `_TTL_DAYS` | `DAISY_CODEX_CHECKPOINT_…` 同后缀 | Codex 文件检查点限额 |
| `HARBOR_DATA` | （不改，见上） | 从不采用，只警告 |

### 2. 磁盘上的名字：新建用新名字，旧的照样找到

| 旧 | 新 | 兼容 |
| --- | --- | --- |
| `<git 目录>/harbor-worktrees/<会话>`，分支 `harbor/<会话>` | `<git 目录>/daisy-worktrees/<会话>`，分支 `daisy/<会话>` | 新位置没有、旧位置有：用旧的目录和旧分支（只问支线读主线的工作区也一样）；两个根目录都不许是符号链接 |
| Runner 默认状态目录 `~/.local/share/agent-harbor`（结果日志、托管身份、运行时附件；只在没给 `identityRoot` 时用——Daisy 本身总是给 `<数据目录>/runner`） | `~/.local/share/daisy-runner`（`platform/paths.ts` 的 `defaultStateRoot`） | 新的不存在、旧的存在：继续用旧的（`renamedPath`）。故意不用数据目录：测试会走这个默认值，不能碰主人的真数据 |
| 身份配置备份 `<配置目录>/.harbor-backups`、写入临时文件 `<文件>.harbor-<uuid>` | `.daisy-backups`、`<文件>.daisy-<uuid>` | 旧备份留在原处不动（备份只写不读） |
| 附件 `<目录>/.harbor-attachments/<任务>` | `.daisy-attachments/<任务>` | 旧附件留在原处，历史消息里的路径照样能读（附件只写不查找） |
| 回退还原的临时名 `.<文件>.harbor-restore-<hex>` | `.daisy-restore-<hex>` | 临时文件，用完即删 |
| 只读沙箱私有临时目录 `/tmp/harbor-private-<uid>` | `/tmp/daisy-private-<uid>` | 临时目录，不需要找旧的 |
| 标题生成临时目录 `harbor-title-*` | `daisy-title-*` | 同上 |
| `harbor.sqlite` | 不改 | 那是识别旧系统数据库的检测（旧版已停用，旧数据库不导入），保留 |

没有用 harbor 命名的锁、pid、socket 文件（数据锁、`runtime.json` 早已是 Daisy 的名字）。

### 3. 浏览器存储键：读时迁移

`packages/ui/src/storage-keys.ts` 的 `readMigrated(store, key, legacy?)`：读新键；没有就读旧键，有值则写到新键、删旧键；存储拒绝（隐私窗口、配额、没有 `window`）一律当作“没存”，写不进时旧键留着下次再读。

| 旧键 | 新键 |
| --- | --- |
| `harbor.auth.v1`（sessionStorage，apps/app） | `daisy.auth.v1` |
| `harbor.draft.v1:<会话>`（sessionStorage） | `daisy.draft.v1:<会话>` |
| `harbor.composer.height.v1` | `daisy.composer.height.v1` |
| `harbor.chat.width` | `daisy.chat.width` |
| `harbor.newSession.v1` | `daisy.newSession.v1` |
| `harbor.queueJump.confirmed.v1` | `daisy.queueJump.confirmed.v1` |
| `daisy.sidebar.harbor`（侧栏折叠，前缀可由宿主改） | `<前缀>sessions`，从 `<前缀>harbor` 迁移 |

不是存储、只在页面之间用的名字也改了：标签页之间的 `BroadcastChannel("harbor-session-cache")` → `daisy-session-cache`（新旧版本的标签页之间只是不再互相通知）；终端 iframe 握手 `harbor-terminal-ready` / `-token` → `daisy-terminal-*`，两边都认旧名字（终端页两种 ready 都发、两种 token 都收；界面用对方说的名字回答），这样嵌入了旧版 `@daisy-ai/ui` 的宿主和新 Daisy 也能接上。

### 4. clientInfo

发给 Codex app-server（会话、操作、登录三处）和 ACP harness 的 `clientInfo.name` 从 `agent_harbor` / `agent_harbor_login` / `agent-harbor` 改为 `daisy`。Daisy 只从 Codex 回的 `userAgent` 里取版本号，不看前面的名字，所以不影响版本判断。

### 5. 只问支线的读取禁止名单

去掉旧系统的 Runner 配置目录（Daisy 不用）和一个组织自己的 CLI 配置目录（不属于 Daisy）。加上 Daisy 自己的：各系统惯例的数据目录（`~/.local/share/daisy/**`、`~/Library/Application Support/Daisy/**`、`~/AppData/Local/Daisy/**`）、实际在用的数据目录（`dataDir()`，即 `DAISY_DATA` 指的地方）、Runner 默认状态目录 `~/.local/share/daisy-runner/**`；`~/.local/share/agent-harbor/**` 保留（它仍可能被当作旧状态目录使用，里面可能有身份凭据）。其余凭据路径不变。

### 6. 用户看得到的其他文字

日志、错误和设置提示里写的环境变量名都换成新名字（如“请检查 DAISY_CLAUDE_BIN”“DAISY_BRANDING 不是合法 JSON”“DAISY_LOCAL_RUNNER=0: Runner not started.”）；导出会话的文件名 `harbor-<会话>.json` → `daisy-<会话>.json`，原生分享的临时文件名同样改。`docs/guide/zh-CN/environment.md` 加上 `DAISY_ORIGINS`、`DAISY_BRANDING(_FILE)` 和一段“旧名字”说明；`docs/contracts/limits.md` 的变量名改了。

## 不在本包（与其他包耦合，原样留着）

- 契约值 `harbor`（`support`、`source`、`via`、`rewind.files`、`harbor:<id>`、`harbor_bash` / `harbor_monitor`）：P6-02。
- 给模型看的文字（「Harbor 定时器到点」、工具说明、`Harbor 注入`、`[[HARBOR_NEEDS_FILES]]`、`Harbor fork` / `Harbor rewind` 标题、发给 harness 的工具错误如“Harbor 工具不可用”“No active Harbor turn”“Harbor does not support …”、后台输出文件里的“[Harbor：输出超过 …]”）、MCP 服务器名 `harbor` 与 `mcp__harbor__*`、Codex `harbor_*` 工具、审批卡片发送者“Harbor 系统”：P6-04。
- 导出的标识符（`HarborClient`、`HarborToolHost`、`harborTools`、`HARBOR_FORK_TITLES` 等）、CSS 类名与 `data-harbor-*` 属性、testID：P6-05。注释：P6-06。
- 根 `package.json` 的名字 `agent-harbor`；测试里的临时目录前缀 `harbor-*`、测试夹具协议行 `HARBOR_TOOL`；私有仓库里的探针脚本（不公开）的回复暗号 `HARBOR_OK`。

## 后果

- 已经在用旧变量名的机器照常工作，日志里每个旧名字提醒一次；两个都设时以新名字为准。
- 已有的隔离工作区、分支、身份目录、浏览器里的登录和草稿都还在；新建的一律用新名字。旧名字的兼容不设期限，删掉它要另开 ADR。
- 只问支线现在也读不到 Daisy 的数据目录（包括数据库）；之前只挡了旧系统的目录。
