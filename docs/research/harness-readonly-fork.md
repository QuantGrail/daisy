# 各家 harness 的只读模式、旁问、会话分叉

核实日期：2026-11-16（P0-03 第 5 项）

“只读模式”指能在启动或会话中把这一轮限制为不改文件、不执行有副作用的命令。“旁问”指借主线上下文回答、不打断主线、不进主线历史。“分叉”指从现有会话复制出一支新会话。

## 结论

| harness | 只读模式 | 旁问 | 分叉 | Daisy 能不能拿来做“问” |
| --- | --- | --- | --- | --- |
| Claude Code | **有，强**。仓库现有旁路：`--restricted --tools Read,Grep,Glob`、空 MCP 配置、`--permission-mode dontAsk`，再加读取拒绝规则；有 Bubblewrap 时再套只读文件系统（旧版的「只问」做法：从主线分出只读支线回答；实测 2.1.316）。另有官方的 `plan` 权限模式 | **有，原生**。流式输入下的 `side_question` 控制请求：不带工具、不打断正在跑的一轮、不进历史（`claude-native.ts`，旧版定下的做法：Claude 在线时「只问」走它自己的 `side_question`；实测 2.1.316）；对应终端里的 `/btw`（官方文档：无工具、可在工作中使用、不进历史） | 有：`--resume <主线> --fork-session --session-id <新>` | 能。在线时用旁问；不在线时分叉 + 只读 |
| Codex | **有，强（依赖沙箱）**。`sandbox: "read-only"`、`approvalPolicy: "never"`，关 MCP、关 apps、关网页搜索（`CODEX_SIDECAR`，实测 0.157.1）；命令行 `--sandbox read-only` | 终端里有 `/side`、`/btw`（“开一个临时的旁支对话”）；app-server 协议里没有单独的旁问方法 | 有：app-server `thread/fork`，可 `ephemeral: true`（每问一次的临时分叉）；命令行 `codex fork`、`codex exec fork` | 能。每问一次做一个只读临时分叉（仓库现状） |
| Kimi Code CLI | **有，但不是硬只读**：ACP 模式 `plan`，描述为“只读规划，不执行工具”；但用户文档说 Plan 模式是“先出计划、等批准后才改文件”，且 Plan 模式下的 Bash 仍按普通规则判断。是否真的拦住所有写操作，未能核实 | 终端里有 `/btw`（在分叉出的子 agent 里开旁支对话，不影响主线这一轮）；**ACP 下没有** | 有：ACP `session/fork`（不稳定方法，已声明）；终端 `/fork` | 能做“分叉 + plan 模式”，但只读强度要标为“弱”，最好叠加 Daisy 自己的只读手段（Linux 上 Bubblewrap） |
| OpenCode 2 | **部分**：内置 `plan` 代理“不改普通项目文件，shell 命令仍受权限控制”；可以通过配置定义一个自定义代理，对 `edit`、`shell` 等动作设 `deny`，做成真正的只读代理，再用 ACP 的 `mode` 配置项选它 | 未能核实（文档未见类似 `/btw` 的功能） | 有：ACP `session/fork`（已声明），要求 `cwd` 与原会话一致 | 能做“分叉 + 只读代理”。需要一个只读代理的配置。OpenCode 2 文档列出的配置位置是全局目录、项目里的 `opencode.json(c)` 或 `.opencode/`、系统和受管配置；OpenCode 1 的 `OPENCODE_CONFIG_CONTENT` 环境变量在 OpenCode 2 文档里没再出现。Daisy 能否不改用户文件、按次注入这个代理，未能核实 |
| Antigravity CLI | **没有专门的只读模式**。`plan` 模式只是给提示词加 `/plan` 前缀；执行模式 `default`、`accept-edits`、`auto`、`plan` 都不是只读。只能靠权限规则：`write_file(*)`、`command(*)` 设为 Deny（Deny 优先级最高）。ACP 下没有 `--mode` 参数 | 终端和 App 有 `/btw`：从当前对话分支、无工具、不进历史、可在工作中提问；**ACP 文档没有提到** | 终端有 `/fork`（别名 `/branch`）；**ACP 文档没有提到 `session/fork`** | 经 ACP 做不了支线；要“问”只能回落主线排队，并且只读要靠 Deny 规则配置，Daisy 能否按次注入这些规则未能核实 |
| DeepSeek Harness | 有 `read-only` 权限预设（headless `--permission-mode`），**ACP 不暴露模式** | 未能核实 | ACP 明确不支持分叉 | 不能接受“问”（经 ACP 无只读、无分叉） |

## 出处

- Claude Code：仓库 `packages/daisy/src/turns/sidecar.ts`、`packages/daisy/src/harness/claude-native.ts`、`claude.ts`；官方 `/btw` 说明 https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw
- Codex：仓库 `packages/daisy/src/turns/sidecar.ts`（`CODEX_SIDECAR`、`codexSidecarFork`）、`packages/daisy/src/harness/codex.ts`（`thread/fork`）；官方命令参考 https://learn.chatgpt.com/docs/developer-commands?surface=cli （`/fork`、`/side`、`/btw`、`codex fork`、`--sandbox`）
- Kimi Code：https://github.com/MoonshotAI/kimi-code （https://github.com/MoonshotAI/kimi-code/blob/HEAD/packages/acp-server/src/modes.ts 、https://github.com/MoonshotAI/kimi-code/blob/HEAD/docs/en/reference/kimi-acp.md 、https://github.com/MoonshotAI/kimi-code/blob/HEAD/docs/en/reference/slash-commands.md 、https://github.com/MoonshotAI/kimi-code/blob/HEAD/docs/en/guides/interaction.md ）
- OpenCode：https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/agents.mdx ，`permissions.mdx`，`cli/acp.mdx`
- Antigravity：https://antigravity.google/docs/cli/modes ，https://antigravity.google/docs/cli/commands/btw ，https://antigravity.google/docs/permissions ，https://antigravity.google/docs/cli/reference ，https://antigravity.google/docs/ide/extensions/acp
- DeepSeek Harness：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md ，https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md

## 对当时设计的影响

1. 设计稿“问与办”一节“各家 harness 的支持”里 Claude Code 和 Codex 的写法与现状一致，成立。
2. **Kimi 的条目要改**：Kimi Code 经 ACP 支持分叉，“问”可以走支线，不必回落主线排队。但它的 `plan` 模式不是硬只读，按“连只读模式都没有的 harness 不能接受问”的规则，要先定：`plan` 算不算“只读模式”。**建议人来定**：在没有 Bubblewrap 的系统（macOS、Windows）上，Kimi Code 和 OpenCode 的“问”是否允许。（已答复：允许，如实写明是弱只读，见 [a2a-usage.md](../contracts/a2a-usage.md) 第 13 节。）
3. **Antigravity 动摇了接入表里“二线、同上”的承诺**：它经 ACP 既没有只读模式也没有分叉（至少文档未提），按上面那条规则它默认不能接受“问”，接它的 agent 只有在主人允许“办”时才能公开。这不是推翻设计（规则本身就覆盖了这种情况），但设计里应明确写出这个结果。
4. 设计的统一能力清单里“权限模式：‘问’至少需要只读这一档”在 ACP 下没有统一的“只读”标识：各家的 `mode` 取值是自定义字符串（Kimi `plan`，OpenCode `plan` 或自定义代理）。通用 ACP 适配器的配置里除了启动命令，还要写“哪个模式值算只读”，或者明确“这家没有”。所以“接入一个新的 ACP harness 只需要一条配置：启动命令加参数”要改成“启动命令加参数，外加只读模式的取值（可空）”。
5. 旁问（不带工具、不进历史）只有 Claude Code 经程序接口提供；其他家要么只在终端里有（Codex、Kimi Code、Antigravity 的 `/btw`），要么没有。通用 ACP 适配器的“问”只能用“分叉 + 只读”，这与设计一致。
