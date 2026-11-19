# 各家 harness 的支持范围与已知限制

[English](../en/harnesses.md)

Daisy 不重造 harness。它驱动你装好的官方命令行，按一份统一的能力清单办事：每家 harness 声明自己支持哪些能力；界面只显示声明了的；命令行调用没声明的能力时明确回答“不支持”；harness 没有的能力，Daisy 不模拟。

这一页的表来自代码里的能力声明（`packages/contracts/src/agent-capabilities.ts`、`acp-harnesses.ts`、`agent-stop.ts`）。运行中的 Daisy 按它检测到的 CLI 版本再降级一次；某个会话实际有哪些能力，看 `daisy session show <id>` 回答里的 `features`。

## 六家 harness

| harness | 接入方式 | 档次 | 启动命令 | 怎么安装 | 怎么登录 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | 原生协议（双向 stream-json） | 一线 | `claude` | 按 Anthropic 官方说明 | Daisy 网页里登录（订阅或 API key），或沿用本机 `claude` 的登录 |
| Codex | 原生协议（Codex App Server） | 一线 | `codex` | `npm install -g @openai/codex` 或官方说明 | Daisy 网页里登录，或沿用本机 `codex` 的登录 |
| Kimi Code CLI | ACP | 二线 | `kimi acp` | 按 Kimi 官方说明（装到 `~/.kimi-code/bin`） | Daisy 网页里登录，或本机终端 `kimi login` |
| OpenCode | ACP | 二线 | `opencode acp` | 按 OpenCode 官方说明 | 本机终端 `opencode auth login` |
| Antigravity CLI | ACP | 二线 | `agy acp` | 按 Antigravity 官方说明，用 `agy acp --help` 确认支持 ACP | 本机终端运行 `agy` 登录一次 |
| DeepSeek Harness | ACP | 实验 | `dsh acp` | `npm install -g @deepseek-ai/dsh`（要 Node 24.9 或更新；开发者预览） | 不需要登录；模型密钥按 dsh 的文档配置 |

- 原来的 Kimi CLI 已归档，请装 Kimi Code CLI。
- “实验”档只承诺基本对话。
- 换一家 harness 的命令（例如装在不在 PATH 上的位置）：数据目录的 `runner.json` 里写 `"agentBins": { "claude": "<命令>", "kimi": "<命令>" }`（开机自启时也生效），或者环境变量 `DAISY_CLAUDE_BIN`、`DAISY_CODEX_BIN`，ACP harness 是 `DAISY_<ID>_BIN`（ID 大写，`-` 换成 `_`，例如 `DAISY_KIMI_BIN`；环境变量优先）。见 [环境变量 › 写在 runner.json 里](environment.md#写在-runnerjson-里)。
- 想接一家这里没有的 ACP harness：见 [写一个 ACP harness 配置](acp-harness.md)。
- `daisy doctor` 列出每家是否安装；Claude Code、Codex 还查是否登录（ACP 各家没有只读的查法，用的时候才知道）。

## 能力表

图例：**✓** harness 自己做；**◐** Daisy 用 harness 自己的办法替它做（例如重启进程接着原会话、Daisy 自己的文件快照、Daisy 的排队）；**—** 不支持（界面不显示，命令行回答“不支持”）。

必备的四项（开会话与恢复、发消息并流式返回、取消、工具授权与提问）六家都支持。

| 能力 | Claude Code | Codex | Kimi Code | OpenCode | Antigravity | DeepSeek |
| --- | --- | --- | --- | --- | --- | --- |
| 运行中追加（立即追加） | ✓ | ✓ | — | — | — | — |
| 撤回已追加的消息 | ✓ | — | — | — | — | — |
| 回退 | ✓ | ✓ | ✓（`/undo`） | — | — | — |
| 回退时同时撤销文件 | ✓ | ◐（Daisy 的快照） | — | — | — | — |
| 分叉 | ✓ | ✓ | ✓ | ✓ | — | — |
| 压缩上下文 | ✓ | ✓ | ✓ | — | — | — |
| 切模型 | ✓ | ✓ | ◐（重启进程） | ◐ | ◐ | ◐ |
| 切推理强度 | ✓ | ✓ | ◐ | ◐ | ◐ | ◐ |
| 权限模式 | ✓ | ✓ | ◐ | ◐ | — | — |
| 只读档（“问”要用） | ✓ 强 | ✓ 强 | ✓ 弱（`plan`） | ✓ 弱（`plan`） | — | — |
| 旁问或分叉（“问”走支线） | ✓ 旁问 | ✓ 临时分叉 | — | — | — | — |
| 上下文用量 | ✓ | ✓ | ✓ | ✓ | — | — |
| 套餐余量 | ✓ | ✓ | — | — | — | — |
| 后台任务列表 | ✓ | ✓ | — | — | — | — |
| 官方命令行窗口 | ✓ | ✓ | ✓ | — | — | — |

**按 CLI 版本降级。** 上表 Claude Code 是 2.1.316 及以上、Codex 是 0.157 及以上的样子（Codex 的后台任务列表要 0.157.1）。更老的版本（或 Daisy 还没检测到版本时）：运行中追加改成 Daisy 把纯文字送进本轮（◐）；没有撤回；Claude Code 的切推理强度、权限模式和 Codex 的切模型、权限模式改成重启进程（◐）；Claude Code 的回退由 Daisy 代做（◐）；回退时都不能撤销文件；“问”改成 Daisy 开的只读分叉（◐）。

**ACP 的共同限制。** 通用 ACP 适配器没有办法把消息送进正在运行的一轮（ACP 没有定义），所以追加的消息都在本轮结束后排队发送；切模型、推理强度、权限模式要重启 harness 进程再接着原会话；没有文件回退；没有套餐余量；压缩阈值不报告。

## 停止一轮时停掉什么

统一的意思是“停下这一轮和它在前台起的一切”。你特意放到后台的东西照常运行。

| harness | 子 agent | 正在跑的命令 | 照常运行的 |
| --- | --- | --- | --- |
| Claude Code | 一起停（harness 自己） | 一起停（前台的 Bash） | 放到后台的 Bash / Agent、Daisy 的后台任务 |
| Codex | 一起停（Daisy 逐个中断子线程） | 一起停（Daisy 结束这一轮的命令） | 之前几轮留下的终端、Daisy 的后台任务 |
| ACP 各家 | 没有这个概念 | 一起停（harness 自己） | Daisy 的后台任务 |

5 秒后还没停下，Daisy 结束 harness 进程；会话之后从原来的线程接着。被打断的一轮标为中断，**不会重放**。

## 问与办

别人经 A2A 调用你公开的 agent 时，默认是“问”：只读地回答。带“办”的标记才动手（你可以关掉“办”）。“问”在哪里跑取决于上面两行（只读档、旁问或分叉）：

| harness | “问”怎么跑 | 只读强度 |
| --- | --- | --- |
| Claude Code | 主线进程在线时用原生旁问（不带工具、不进主线历史、不打断主线）；否则分叉出一个只能读（Read / Grep / Glob）、没有 MCP 的进程 | 强（工具层限制，不靠沙箱） |
| Codex | 每问一次开一个只读沙箱的临时分叉 | 强；Windows 上弱 |
| Kimi Code、OpenCode | 没有支线：在主线上排在你这一轮后面，这一轮切到 `plan` 模式，完整的一问一答留在主线里 | 弱：`plan` 只是 harness 自己遵守的模式，不是硬限制 |
| Antigravity、DeepSeek | 经 ACP 没有只读档：拒绝“问”。只有你允许“办”时才能公开 | — |

支线有上限：每条主线同时 2 个、每 24 小时 30 次。名片上会如实写只读强度：弱只读的 agent 名片描述里有一句说明。

“办”进主线，排在你当前这一轮后面，不打断你；权限模式默认自动（harness 有 `auto` 模式时；没有时用会话自己的模式），可以在 `daisy agent act set` 里改，永远不会用跳过所有确认的模式。

## 工作目录的四种方式

新建会话时 `--workspace-mode`（网页里新建的会话是共享编辑）：

| 方式 | 取值 | 文件 | 说明 |
| --- | --- | --- | --- |
| 共享编辑 | `shared`（默认） | 所选目录的当前文件 | 会话可以同时运行，避免同时改同一个文件 |
| 只读分析 | `read-only` | 所选目录的当前文件 | Daisy 强制只读：只在 Linux 上、要 `/usr/bin/bwrap`（Bubblewrap）。做不到时拒绝，不降级成可写 |
| 独立开发 | `isolated` | 独立的 Git worktree 和分支 | 从已提交的 HEAD 开始，不带未提交的修改；Daisy 不自动合并或删除 |
| 版本审查 | `snapshot` | 固定在一个提交上的只读 worktree | 不受原目录之后的编辑影响。和只读分析一样由 Daisy 强制只读：只在 Linux 上、要 Bubblewrap |

Daisy 不替你串行化：同一个目录里的几个会话可以同时改文件，冲突由你分工避免。

## 各系统上的差异

各家都能在 Linux、macOS、原生 Windows 上运行，没有一家只能经 WSL。差异：

| 项 | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Daisy 自己的强制只读（`read-only`、`snapshot` 会话） | Bubblewrap | 没有 | 没有 |
| Claude Code 的“问” | 强 | 强 | 强（工具层限制；Claude Code 在原生 Windows 上没有沙箱） |
| Codex 的“问” | 强（只读沙箱） | 强 | 弱（Codex 的 Windows 沙箱取决于系统版本和管理员设置） |
| 停止时收走整棵进程树 | 进程组 | 进程组 | 作业对象（要 Daisy 的 Windows 辅助程序） |
| 官方命令行窗口 | 要 `python3` | 要 `python3` | ConPTY，要辅助程序；没有时不提供 |
| “在终端执行”和后台命令的 shell | bash / sh | bash / sh | Git Bash，没有就 PowerShell（写法不同） |
| 停止一个 harness | 先 SIGTERM，1.5 秒后强制结束 | 同 Linux | 立即结束 |

Windows 上：

- **Kimi Code 首次启动前必须装 Git for Windows**（它用 Git Bash 当 shell）；Claude Code 建议装。`daisy doctor` 会检查。
- Antigravity 的沙箱要 Windows 11 24H2 并装了 2026 年 8 月的更新。
- npm 装的 `.cmd` 启动脚本，Daisy 直接用 node 跑它的脚本，不经 cmd.exe；别的批处理文件会被拒绝。
- Daisy 只在 PATH 里找 harness 的命令，不找当前目录（工作区里放一个 `claude.cmd` 不会被执行）。
- 某家 harness 的沙箱需要让子进程脱离 Daisy 的作业对象时，可以设 `DAISY_WIN_JOB_BREAKAWAY=1`（默认关）。这样脱离的进程在 Daisy 被强行结束时可能留下。

## 还没核实的

下面这些在调研时没能核实，代码里按“不支持”处理，以后核实了再放开：

- Antigravity 经 ACP 是否支持分叉和模式。
- OpenCode 和 DeepSeek Harness 有没有旁问；OpenCode 经 ACP 的 `/compact` 和同一会话的命令行窗口。
- Kimi Code 的 `plan` 模式能不能真正挡住所有写操作（所以按弱只读算）。
- `dsh acp` 在 Windows 上的实际表现。
- `codex sandbox`（Codex 的后台命令沙箱）在 Windows 上的行为。
