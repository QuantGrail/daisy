# 事实核实：各家 harness 与协议（总表）

设计 Daisy 之前，对各家 harness、A2A、ACP、MCP 做的一次事实核实，核实于 2026 年 11 月。第三方工具变化很快，这里的结论可能已经过时，以各家当前的文档为准；Daisy 实际支持什么，见 [harness 支持范围](../guide/zh-CN/harnesses.md)。每一项的详细结论、出处和影响见同目录下的页面：

| 页面 | 内容 |
| --- | --- |
| [a2a-spec.md](a2a-spec.md) | A2A 1.0 设计稿里还没核对的四项；TCK；官方 SDK；第三方客户端默认传输 |
| [acp-harnesses.md](acp-harnesses.md) | ACP 当前版本；Kimi、OpenCode、Antigravity 的 ACP 启动命令和能力 |
| [deepseek-harness.md](deepseek-harness.md) | DeepSeek Harness 是什么、对外协议 |
| [harness-platforms.md](harness-platforms.md) | 各家在 macOS、原生 Windows 上能否用、有什么限制 |
| [harness-readonly-fork.md](harness-readonly-fork.md) | 各家的只读模式、旁问、分叉 |
| [auth-mcp-a2a.md](auth-mcp-a2a.md) | MCP 授权规范要点；A2A 名片的 OAuth2 / Bearer 写法 |

## harness × 能力 × 系统 对照表

“强 / 弱”指只读的保证强度：强 = 工具层面或沙箱层面挡住写操作；弱 = 只是模式或提示词，不能保证不写。“仅终端”指功能只在交互界面里有，程序接口拿不到。

| harness | 接入协议 | 启动命令 | 只读模式 | 旁问 / 分叉 | 会话恢复 | macOS 原生 | Windows 原生 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | 原生：`-p` 流式 JSON 输入输出（另有第三方 ACP 包装 `claude-agent-acp`，Daisy 不用） | `claude -p --input-format stream-json --output-format stream-json …`（仓库 `claude.ts`） | 有，强：`--restricted --tools Read,Grep,Glob` + `--permission-mode dontAsk`（不依赖沙箱）；另有 `plan` 模式 | 旁问：有，`side_question` 控制请求（= `/btw`）。分叉：有，`--resume … --fork-session` | 有，`--resume` | 是（13+） | 是（Win10 1809+）；原生 Windows 无沙箱；Bash 工具要 Git for Windows，否则用 PowerShell |
| Codex | 原生：app-server JSON-RPC（另有 `codex-acp` 包装） | `codex app-server`（仓库 `codex.ts`） | 有，强（靠沙箱）：`sandbox: read-only` + `approvalPolicy: never` | 旁问：仅终端（`/side`、`/btw`）。分叉：有，`thread/fork`（可临时） | 有，`thread/resume` | 是 | 是；沙箱 `mxc` 要 Win11 24H2 新版本，否则 `elevated`（要管理员设置）或 `unelevated`（较弱） |
| Kimi Code CLI（原 Kimi CLI 已归档） | ACP v1 | `kimi acp` | 有，弱：ACP 模式 `plan`（另有 `default`、`auto`、`yolo`） | 旁问：仅终端（`/btw`）。分叉：有，ACP `session/fork`（不稳定方法） | 有，`session/load`、`session/resume` | 是 | 是；必须先装 Git for Windows |
| OpenCode 2 | ACP v1 | `opencode acp` | 部分：`plan` 代理不改项目文件但命令仍按权限；可配自定义 deny 代理做成强只读（能否按次注入未核实） | 旁问：未核实。分叉：有，ACP `session/fork` | 有，`session/load`、`session/resume` | 是 | 是（独立二进制；不支持 Windows 包管理器） |
| Antigravity CLI | ACP v1（CLI 内置；第三方记录为 v1.5.0 起） | `agy acp`（已核实） | 无专门只读模式（`plan` 只加提示词）；只能靠 Deny 权限规则；ACP 下无模式参数 | 旁问：仅终端和 App（`/btw`）。分叉：仅终端（`/fork`）；ACP 未提及 | 有，加载、恢复、列出、关闭 | 是（13+） | 是；沙箱要 Win11 24H2 + 2026-08 更新 |
| DeepSeek Harness（开发者预览） | ACP v1（只面向自动化） | `dsh acp`（= `dsh --profile acp`） | 有 `read-only` 预设，但 ACP 不暴露模式 → 经 ACP 无 | 旁问：未核实。分叉：ACP 明确不支持 | 有，`session/resume`（无 `session/load`） | 部分核实（桌面端、Python SDK 支持） | 部分核实（桌面端、Python SDK 支持；`dsh acp` 未专门说明） |

协议与配套：

| 项 | 现状 |
| --- | --- |
| A2A | 1.0.1 是当前正式版（1.0.0 于 2026-03 发布）；1.1.0-rc 候选中。官方 TCK：`a2aproject/a2a-tck`。官方 SDK：Python、JS、Go、Java、.NET、Rust |
| ACP | 协议版本 1；schema v1.32.0；`session/fork` 仍是不稳定方法；`session/set_model` 已删除 |
| MCP | 2026-07-28 版（无状态，去掉 `initialize`）；stdio 不适用授权规范 |

## 改变或动摇了当时设计的发现

下面几条在核实时改变或动摇了当时的设计，前两条与规范的 MUST 冲突。（引号里的是当时设计稿的原话；后来的决定写在括号里。）

1. **【推翻设计里的一条改正】A2A 默认应该阻塞，不能默认立即返回。** 设计稿“A2A 相对旧代码要改正的五处”第 3 条写“改成立即返回任务”。A2A 1.0 规定 `returnImmediately` 默认 `false`，此时服务端 MUST 等到终态或中断态才返回；官方 TCK 把它列为 MUST，官方 Python SDK 客户端默认就发阻塞请求。应改为：默认阻塞；只有调用方给 `returnImmediately: true` 才立即返回。待定的是：阻塞等多久，等不到时怎么办（规范没有超时错误，当时代码的 504 不合规）。详见 `a2a-spec.md`。（已答复：照规范阻塞，不设人为上限，见 [a2a-usage.md](../contracts/a2a-usage.md) 第 11 节。）
2. **【动摇“只实现 HTTP+JSON”】官方 Python SDK 客户端默认只用 JSON-RPC。** 只实现 HTTP+JSON 的 Daisy，默认配置的 Python 客户端连不上；JS 和 Go SDK 默认两种都支持。要满足“用一个不是我们写的 A2A 客户端验收”，建议把 JSON-RPC 绑定列为必做。另外：没有 `A2A-Version` 头的请求按规范要当 0.3 处理，当时的代码没有处理。（后来两种绑定都实现了。）
3. **【动摇 harness 接入表】Kimi CLI 已归档，换成 Kimi Code CLI。** 命令仍是 `kimi acp`，数据目录不同。Kimi Code 经 ACP 支持分叉，“问”对 Kimi 可以走支线；当时代码里给 Kimi 写的 `fork: "none"` 对 Kimi Code 已过时。
4. **【动摇“接一家 ACP harness 只要一条配置”】ACP 下“只读”没有统一标识。** 各家的模式值是自定义字符串（Kimi `plan`，OpenCode `plan` 或自定义代理），Antigravity 和 DeepSeek Harness 经 ACP 没有只读。通用 ACP 适配器的配置除了启动命令，还要写“哪个模式值算只读（可空）”。另外通用适配器要同时支持 `session/load` 和 `session/resume` 两种恢复（DeepSeek 只有后者），切模型改用 `session/set_config_option`（`session/set_model` 已从协议删除）。
5. **【待定】弱只读算不算只读。** Kimi Code 和 OpenCode 的 `plan` 都不是硬只读。按设计规则“连只读模式都没有的 harness 不能接受问”，要先定在 macOS、Windows（没有 Bubblewrap 兜底）上，这两家的“问”是否允许。按目前文档，Antigravity 和 DeepSeek Harness 经 ACP 没有只读，接它们的 agent 默认不能接受“问”。规则本身覆盖了这种情况，不算推翻，但接入表里“二线：必备能力，加上它自己声明的可选能力”对它们意味着“只能办”，设计里应写明。（已答复：Kimi Code、OpenCode 照常接受“问”，能力声明里如实写明是弱只读，见 [a2a-usage.md](../contracts/a2a-usage.md) 第 13 节。）
6. **【确认，不推翻】** `agy acp` 是对的（官方文档）；DeepSeek Harness 走通用 ACP 适配器（`dsh acp`）；五家都有原生 Windows 版，“Windows 原生支持”的目标可行，但 Windows 上只读的强度普遍更弱（Claude Code 原生 Windows 无沙箱，Codex、Antigravity 的沙箱依赖较新的 Windows 11），能力声明要按系统写；A2A 名片的 Bearer / OAuth2 写法与现有代码一致（`securityRequirements` + `schemes` + `list`）；MCP 授权规范对 stdio 的 MCP 不适用。

## 未能核实的

- A2A 的 Java、.NET、Rust SDK 客户端默认用哪种传输。
- Antigravity 经 ACP 是否支持 `session/fork` 和模式切换（文档未提，按不支持处理，接入时看 `initialize` 返回）。
- OpenCode、DeepSeek Harness 有没有旁问；OpenCode 2 能否不改用户文件、按次注入只读代理。
- Kimi Code 的 `plan` 模式实际能否挡住所有写操作。
- DeepSeek Harness 的 `dsh acp` 在 Windows、macOS 上的实际表现；能否让 ACP 会话默认只读。
- 旧 Kimi CLI 会话迁移到 Kimi Code 之后，原会话编号能否直接 `session/load`。
