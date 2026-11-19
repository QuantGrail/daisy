# 各家 harness 在 macOS 和 Windows（原生）上能不能用

核实日期：2026-11-16（P0-03 第 4 项）。“原生 Windows”指不经 WSL，直接在 PowerShell 或 CMD 里运行。

## 结论

| harness | macOS | 原生 Windows | 限制 |
| --- | --- | --- | --- |
| Claude Code | 支持，macOS 13+ | 支持，Windows 10 1809+ / Server 2019+，x64 和 ARM64；PowerShell、CMD、WinGet 都能装 | 原生 Windows **不支持沙箱**（只有 WSL 2 支持）。装了 Git for Windows 时 Bash 工具用 Git Bash，没装时改用 PowerShell 工具；Monitor 工具需要 Git Bash |
| Codex | 支持 | 支持（CLI、桌面端、IDE 扩展都能在 PowerShell 里原生跑） | 沙箱三种：`mxc`（推荐，要 Windows 11 24H2 build 26100.9278 / 25H2 build 26200.9278 并有 MXC 能力，微软还在推送）、`elevated`（要管理员做一次设置）、`unelevated`（旧的兜底，网络隔离弱，不支持禁止读取的路径）。MXC 一键测试要 CLI 0.162.0+ |
| Kimi Code CLI（取代已归档的 Kimi CLI） | 支持（`install.sh`） | 支持（`install.ps1`），数据在 `C:\Users\<name>\.kimi-code` | **首次启动前必须装 Git for Windows**，它用 Git Bash 当 shell；装在别处要设 `KIMI_SHELL_PATH`。旧的 Kimi CLI 也有 Windows 构建，但已不维护 |
| OpenCode 2 | 支持（Apple 芯片、Intel） | 支持，有 x64、ARM64 独立二进制 | 官方写明“不支持 Windows 包管理器”（要用 npm、curl 脚本或手动下载）。OpenCode 1 的文档建议 Windows 上用 WSL 以获得最好体验；OpenCode 2 文档没有再这样写 |
| Antigravity CLI（`agy`） | 支持，macOS 13+（文档对 App 写的要求；CLI 一节没单列） | 支持，PowerShell 或 CMD 安装，装到 `%LOCALAPPDATA%\agy\bin` | 终端沙箱在 Windows 上要 **Windows 11 24H2 且装了 2026 年 8 月更新**，否则沙箱不可用；`auto` 模式依赖沙箱（Windows 上 v1.4.4+）；Windows 沙箱里用户目录以外的文件夹可读不可写。ACP 注册表的 IDE 扩展版也有 Windows 构建 |
| DeepSeek Harness（`dsh`） | 部分核实：桌面端支持 macOS；Python SDK 要 macOS 14+ arm64 | 部分核实：桌面端支持 Windows 11；Python SDK 支持 Windows x64；配置文档提到“Windows 进程隔离会忽略这些路径设置” | npm 包要 Node ≥ 24.9，未标平台限制。**`dsh acp` 在 Windows 上是否正常，官方没有专门说明，未能核实** |

## 出处

- Claude Code 系统要求与 Windows 安装：https://code.claude.com/docs/en/setup
- Codex Windows：https://learn.chatgpt.com/docs/windows/windows-sandbox （原 https://developers.openai.com/codex/windows 已 308 跳转到这里）
- Kimi Code：https://github.com/MoonshotAI/kimi-code （README 安装一节、https://github.com/MoonshotAI/kimi-code/blob/HEAD/docs/en/configuration/env-vars.md 、https://github.com/MoonshotAI/kimi-code/blob/HEAD/docs/en/configuration/data-locations.md ）；Kimi CLI 归档：https://github.com/MoonshotAI/kimi-cli
- OpenCode 2 安装：https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/index.mdx ；OpenCode 1 的 WSL 建议：https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/v1/content/windows-wsl.mdx
- Antigravity：https://antigravity.google/docs/getting-started （安装命令与 App 系统要求），https://antigravity.google/docs/sandbox （各系统沙箱机制），https://antigravity.google/docs/cli/reference
- DeepSeek Harness：https://github.com/deepseek-ai/deepseek-harness （https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.md 、https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/desktop-uninstall-cleanup.md 、https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md ）

## 对当时设计的影响

1. 设计目标“Windows 原生支持”**可以做到**：五家主要 harness 都有原生 Windows 版本，没有一家只能经 WSL。
2. 但**只读的强度在 Windows 上普遍更弱**，印证设计里“Windows 上只读较弱”的判断：
   - Claude Code 原生 Windows 没有沙箱。好在现有旁路的只读靠的是工具层面的限制（`--restricted --tools Read,Grep,Glob`、`--permission-mode dontAsk`，见 `harness-readonly-fork.md`），不依赖沙箱，在 Windows 上同样生效。
   - Codex 的只读靠沙箱，Windows 上取决于系统版本和管理员设置；`unelevated` 下不支持禁止读取的路径。
   - Antigravity 在 Windows 10 和较早的 Windows 11 上没有沙箱。
   能力声明要按“系统 + harness 版本”分别写只读的强度，不能一刀切。
3. Windows 上的安装检查要多一步：Kimi Code 必须有 Git for Windows；Claude Code 建议有。Daisy 的安装或体检命令应检查 Git Bash 是否存在。
4. 自动测试矩阵（P0-01）里，Windows 的 harness 真实验证要注意系统版本：Codex 的 MXC 沙箱和 Antigravity 的沙箱都要 Windows 11 24H2 以上。
5. 没有推翻设计。
