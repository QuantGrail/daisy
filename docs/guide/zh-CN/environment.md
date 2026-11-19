# 环境变量

[English](../en/environment.md)

大多数人不需要设任何环境变量。下面是对用户有意义的几个。

注意：`daisy start` 起的后台进程继承你终端里的环境变量；开着开机自启时，Daisy 由 systemd、launchd 或 Windows 的启动项启动，只带 `PATH` 和显式指定的 `DAISY_DATA`，你终端里的其他变量到不了它。所以端口、额外的 ACP harness、harness 的命令这几项也可以写在数据目录的 `runner.json` 里（见下面的 [写在 runner.json 里](#写在-runnerjson-里)），开机自启时照样生效。

## Daisy 和 `daisy` 命令

| 变量 | 作用 | 同义的设置 |
| --- | --- | --- |
| `DAISY_DATA` | 数据目录。不设按系统惯例（见 [安装 › 数据目录](install.md#数据目录)） | `--data-dir <目录>` |
| `DAISY_LANG` | 显示语言（`zh-CN`、`en`，或数据目录 `locales/` 里另放的语言）。对命令行它优先于设置里选的语言；对 Daisy 进程它只顶替系统的语言，设置里选了就以设置为准。都没有时按系统的语言（不是中文就用英文） | `--lang <语言>`；网页的“设置 → 显示语言”或 `daisy language set <语言>` |
| `DAISY_PORT` | 本机面的端口，1024–65535 之间的整数（不在这个范围时 Daisy 拒绝启动并说明）。被占用时启动失败，不悄悄换。没设时也认 `PORT` | `daisy start --port <端口>`；`runner.json` 的 `port` |
| `DAISY_UPDATE_SOURCE` | 更新来源：放 `.tgz` 的目录、一个 `.tgz`、`npm:@daisy-ai/daisy@latest` 或 `off` | `daisy update --source`（要 PIN，存在 `runner.json` 的 `updateSource`，优先于环境变量） |
| `DAISY_ACP_HARNESSES` | 额外的 ACP harness 配置文件（JSON 数组）。Daisy 和 `daisy` 命令都读 | `runner.json` 的 `acpHarnesses`；见 [写一个 ACP harness 配置](acp-harness.md) |
| `DAISY_CLAUDE_BIN` | Claude Code 的命令，默认 `claude` | `runner.json` 的 `agentBins.claude` |
| `DAISY_CODEX_BIN` | Codex 的命令，默认 `codex` | `runner.json` 的 `agentBins.codex` |
| `DAISY_<ID>_BIN` | ACP harness 的命令（ID 大写，`-` 换成 `_`），例如 `DAISY_KIMI_BIN`、`DAISY_OPENCODE_BIN`、`DAISY_ANTIGRAVITY_BIN`、`DAISY_DEEPSEEK_BIN` | `runner.json` 的 `agentBins.<id>` |
| `DAISY_CARD_TTL_HOURS` | AI 的工具授权和提问卡片等你回答多久（小时） | 默认 24 |
| `DAISY_PLUGINS` | 启用哪些插件，逗号分隔的插件名。默认一个也不启用（见 [插件](plugins.md)） | `runner.json` 的 `plugins`（写了就以它为准，不再看环境变量） |
| `DAISY_ALLOW_HTTP_ISSUER` | 设为 `1` 时，外部签发方可以用本机回环地址上的明文 http（只在这台机器没有别人的账户时；供测试和本机部署） | — |
| `DAISY_WIN_JOB_BREAKAWAY` | 仅 Windows。设为 `1` 时允许 harness 起脱离 Daisy 作业对象的子进程（某家 harness 的沙箱需要时）。脱离的进程在 Daisy 被强行结束时可能留下 | 默认关 |
| `DAISY_ORIGINS` | 嵌入 Daisy 的宿主页面所在的其他来源（逗号分隔，如 `https://team.example.com`）：只用于允许它们以 iframe 嵌入 Daisy、让页面里的链接打开到那里，从不放宽 API 的来源检查 | — |
| `DAISY_BRANDING`、`DAISY_BRANDING_FILE` | 嵌入宿主时网页的外观（颜色、字体、措辞等，JSON；后者是 JSON 文件路径）。只影响外观 | — |
| `DAISY_RATE_LIMIT` | 每个调用方每分钟最多多少个请求（网页的每个登录、命令行、AI 的每一轮各算一个；认不出身份的按来源地址算），超出回 429。默认 6000 | — |
| `DAISY_RUNNER_SELF_RESTART` | 更新和重启时 Daisy 要退出、由别人再把它拉起来。systemd、launchd、Windows 的启动项和 `daisy start` 起的后台进程都会自动识别，不用设。用别的服务管理器跑 `daisy start --foreground` 时设为 `1`（退出后由那个管理器拉起）；设为 `0` 关掉自行重启（更新只在你手动重启时生效） | `runner.json` 的 `selfRestart: false` 同 `0` |

构建网页时（`npm run build:web`）还认一个：`DAISY_BASE_PATH`，例如 `/daisy`，把网页构建成放在一个子路径下（嵌进别的站点时用）；不设就是根路径。

其他 `DAISY_*` 变量是内部调优和测试用的（超时、缓存大小、轮询间隔等），不保证在版本之间保持不变，一般不要设。

### 写在 runner.json 里

数据目录里的 `runner.json`（Daisy 第一次启动时写的；`daisy status` 的“数据目录”一行写着位置）可以加这几项，开机自启的 Daisy 也读得到：

```json
{
  "nodeId": "…（已有的项不要动）",
  "port": 29420,
  "acpHarnesses": "acp-harnesses.json",
  "agentBins": { "claude": "/opt/claude/bin/claude", "kimi": "/home/me/.kimi-code/bin/kimi" }
}
```

| 项 | 等于 | 说明 |
| --- | --- | --- |
| `port` | `DAISY_PORT` | 1024–65535 之间的整数（`DAISY_PORT`、`daisy start --port` 也是同样的范围）。被占用时启动失败，不悄悄换 |
| `acpHarnesses` | `DAISY_ACP_HARNESSES` | 额外的 ACP harness 文件的路径；相对路径按数据目录算 |
| `agentBins` | `DAISY_<ID>_BIN` | 每家 harness 的命令，键是 agent 的 id（`claude`、`codex`、`kimi`、`opencode`……，或额外 harness 文件里的 id；别的键不采用）。值是绝对路径或命令名（在 PATH 里找）；相对路径不采用——harness 在会话的工作目录里启动，相对路径会指到那里的文件 |

- 环境变量优先：同一项设了环境变量（`port` 是 `DAISY_PORT` 或 `PORT`；`agentBins` 也认旧的 `HARBOR_<ID>_BIN`），就不看 `runner.json` 里的；都没有，用默认值。
- 只在启动时读。改了要重启 Daisy（`daisy stop && daisy start`）。`daisy` 命令每次运行都读同一个数据目录的 `runner.json`，所以命令行认的 harness 和 Daisy 一致。
- 写错的项（例如 `port` 不是整数）不采用，Daisy 照常启动，`daisy doctor` 和 `daisy status` 会说是哪一项。
- `runner.json`（和 `acpHarnesses` 指的文件）不属于你的账户，或者别的账户能写它时，这几项（`port`、`acpHarnesses`、`agentBins`）都不采用并说明原因：它们决定 Daisy 执行哪个程序。Daisy 进程本身这时不启动（这个文件还决定插件、更新、身份目录和工作区，见 [插件](plugins.md)）。`runner.json` 不是合法 JSON 时，Daisy 不启动，并说是哪一行哪一列。
- 这几项决定 Daisy 执行哪个程序、监听哪个端口，只能直接编辑文件，没有命令或接口能写。`runner.json` 只有你的账户能读写。

### 旧名字

Daisy 早先的版本里，一部分变量以 `HARBOR_` 开头（例如 `HARBOR_CLAUDE_BIN`、`HARBOR_KIMI_BIN`、`HARBOR_ORIGINS`）。旧名字已弃用，但还能读：同一个设置只设了旧名字时照样生效，Daisy 在日志里提醒一次改用 `DAISY_` 开头的新名字；两个都设时以新名字为准。`HARBOR_DATA` 例外：它从来不被 Daisy 采用，数据目录只看 `DAISY_DATA`。

## Daisy 设给 harness 的

Daisy 起 harness 时设这些，供它的工具使用。不要自己设。

| 变量 | 是什么 |
| --- | --- |
| `DAISY_URL` | 本机面的地址 |
| `DAISY_AI_CREDENTIAL_FILE` | 这一轮的 AI 工作凭据所在的文件（只有主人可读，这一轮结束即失效） |
| `DAISY_SESSION_ID` | 当前会话的编号 |

## daisy-relay

见 [中转](relay.md)。

| 变量 | 作用 |
| --- | --- |
| `DAISY_RELAY_CONFIG` | 配置文件路径（同 `--config`） |
| `DAISY_RELAY_DOMAIN` | 中转自己的域名 |
| `DAISY_RELAY_HOST`、`DAISY_RELAY_PORT` | 监听地址和端口，默认 `0.0.0.0:443` |
| `DAISY_RELAY_TLS_CERT`、`DAISY_RELAY_TLS_KEY` | 中转自己域名的证书和私钥（PEM 文件；不能是通配证书） |
| `DAISY_RELAY_LOG_LEVEL` | `debug`、`info`、`warn`、`error` |

## daisy-mcp

| 变量 | 作用 |
| --- | --- |
| `DAISY_MCP_HOME` | 密钥和通讯录放在哪里（同 `--home`） |
