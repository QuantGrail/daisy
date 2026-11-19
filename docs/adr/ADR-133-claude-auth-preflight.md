# ADR-133：Claude 订阅登录检查说清是哪里不对（真机检查发现的问题）

- 日期：2026-11-17
- 状态：**已实施（分支 `c1-fixes-3`，待合入 `daisy-next`）**
- 来源：一线 harness 的真机检查中发现的问题（维护者的 Mac，Daisy 0.1.0，Claude Code 2.1.326）
- 相关：旧版的约定（身份的 CLI 目录）、ADR-111（脱敏、日志）、ADR-112（`daisy doctor`）

## 背景

Daisy 断网时重启、网络恢复后，Daisy 托管的 Claude 订阅身份每一轮都在启动前失败：「Claude 订阅身份未登录或登录已过期。请打开设置 → 连接你的 Agent 账号完成授权。」而维护者随后在自己的终端里 `CLAUDE_CONFIG_DIR=<该身份目录> claude auth status --json` 得到 `loggedIn: true`（claude.ai、firstParty、max）——凭据本身没问题。

一轮开始前的检查（`harness/claude.ts` `start`）用 `agentEnv(job)` 跑 `claude auth status --json`、10 秒超时，**任何**失败（超时、非零退出、不是 JSON、钥匙串读不到、程序起不来）都变成同一句“未登录或已过期”，真正的原因丢了。

根因（推断，真机上无法再现当时的进程环境）：当时的 Daisy 由一个自动化工具启动（可能在受限的 shell 里）。macOS 上 Claude Code 的订阅凭据在登录钥匙串里；受限（沙箱）环境里启动的进程及其子进程访问不了钥匙串服务，`claude auth status` 于是读不到凭据——要么报告 `loggedIn: false`（并以非零码退出，`promisify(execFile)` 把它当成异常），要么等钥匙串等到超时，要么在 stderr 里报 `security` / `User interaction is not allowed`。三种在旧代码里都落进同一个 catch。断网本身不影响 `auth status`（它不联网），只是与那次重启同时发生。

## 决定

1. **分类**（`harness/claude-auth.ts` `classifyClaudeAuth`）：
   - 输出是带 `loggedIn` 的 JSON → 以它为准，不看退出码：`false` → 原来的“未登录或已过期”；但在 macOS 上，若这个托管身份目录的 `.claude.json` 记着登录过的账号（`oauthAccount`，只看有没有）或 stderr 提到钥匙串 → 「Claude 报告未登录，但这个身份之前登录过：多半是 Daisy 进程读不到钥匙串…在你自己的终端里运行 daisy stop && daisy start 再试；仍不行再到设置 → 连接你的 Agent 账号重新授权」。API key / 其他供应商 → 原来的“此身份要求 Claude 订阅登录”。
   - 超时 → 「检查 Claude 登录超时（网络或钥匙串没有响应）」。
   - 程序起不来（ENOENT / EACCES）→ 找不到或不能运行 claude。
   - 非零退出且输出提到钥匙串 / `security` 错误 → 「读取钥匙串失败：Daisy 进程可能没有访问钥匙串的权限（例如在受限的终端里启动）。在你自己的终端里运行 daisy stop && daisy start 再试」。
   - 其它 → 「检查 Claude 登录失败（退出码 N：<摘录>）」，摘录 ≤ 160 字，先过集中脱敏（ADR-111），再把 e-mail 地址遮掉。
2. **日志**：每次失败在守护进程日志写一行：哪个身份、第几次、分类、退出码、是否超时被终止、完整 stderr（脱敏 + 遮 e-mail，最多 4000 字）。
3. **重试、不缓存**：超时、钥匙串、未分类的失败等 2 秒再问一次，仍失败才让这一轮失败；“未登录”“不是订阅”“程序不存在”是确定的回答，不重试。结果不记：每次启动 CLI 都重新检查（启动失败的在线进程照旧被丢弃，下一轮新起）。
4. **同一套用在**：一轮的启动检查、完整 CLI 终端（`turns/terminal.ts`）、`daisy doctor`。
5. **`daisy doctor` 也查 Daisy 托管的 Claude 身份**：读 `runner.json` 的 `nodeId`（与 `identityRoot`，默认 `<数据目录>/runner`），对 `<identityRoot>/<nodeId>/<身份 id>` 里有 `.claude.json` 的目录各跑一次 `claude auth status --json`（`CLAUDE_CONFIG_DIR` 指向它，不继承本机的 `ANTHROPIC_API_KEY` 等），每个一行「Claude 独立登录 <id 前 8 位>：已登录（订阅）/ <分类的说法>」，级别 ✓ 或 !；不打印账号信息。本机登录那一行也改用同一分类。

## 后果

- 主人看得出是登录过期、钥匙串读不到，还是超时；日志里有可查的退出码和 stderr。
- 受限环境里启动的 Daisy 会得到“在你自己的终端里 daisy stop && daisy start”的指引；`daisy doctor` 在自己的终端里能确认托管身份的凭据是好的。
- 一轮最坏多等 10 + 2 + 10 秒才失败（两次都超时）。
- 测试：`tests/claude-auth.test.ts`（分类与文案、macOS 的钥匙串推断、重试与不缓存、假 CLI 超时 / 钥匙串 / 未登录 / 其它（stderr 带令牌与 e-mail）各自的报错与日志、先钥匙串后成功的一轮照常进行、`daisy doctor` 查托管身份）。假 CLI 新增 `HARBOR_FIXTURE_AUTH_STATUS`。

## 留给真机

- 在受限 shell 里 `daisy start`、再发一轮，确认得到钥匙串那条说法（或超时那条），日志里有 stderr；在自己的终端里 `daisy stop && daisy start` 后恢复。
- `daisy doctor` 列出托管的 Claude 身份并显示已登录。
