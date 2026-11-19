# 更新记录 / Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.1.0] — 2026-11-19

第一个公开版本。Daisy 装在你自己的系统账户下：一个进程、一个数据目录、一条 `daisy` 命令。它把 Claude Code、Codex 等 harness 包成你的 AI，你在本地网页、手机浏览器和命令行里使用它；别的智能体经 A2A 协议调用它，它也能去调用别人。一台机器上每位主人一个 Daisy，没有中心服务器。

The first public release. Daisy runs under your own OS account — one process, one data directory, one `daisy` command. It wraps harnesses such as Claude Code and Codex as your AI, used from a local web page, a phone browser and the command line; other agents call it over A2A, and it can call them. One Daisy per owner per machine, no central server.

### 使用 / Using Daisy

- 会话：对话、流式输出、工具授权和 AI 提问的卡片、定时唤醒、附件、终端窗口（“打开完整 CLI”）、在主线之外“只问”一句。被打断的一轮不会重放。
  Sessions: chat, streaming, approval and question cards, schedules, attachments, a terminal on the same session, side questions. An interrupted turn is never replayed.
- 身份档：每家 harness 可以用本机已有的登录，或在 Daisy 里另建一个独立登录的身份（不动本机原有的凭据）；模型、推理强度、权限模式按身份设置。
  Identities: use a harness's existing login on the machine, or a separate login managed by Daisy; model, effort and permission mode per identity.
- 工作区：会话只在你允许的目录里工作。
  Workspaces: sessions work only in directories you allow.
- 本地网页：由 Daisy 自己提供；`daisy open` 打印带一次性口令的链接；监听范围超出本机时自动要求口令。
  The local web page is served by Daisy itself; `daisy open` prints a one-time link; a passcode is required whenever it listens beyond this machine.
- 命令行：网页上能做的事都有对应的命令（回答 AI 的授权和提问除外）；`daisy start | stop | status | open | doctor | update | autostart | uninstall`，以及 `session`、`profile`、`login`、`contact`、`agent`、`request`、`grant`、`relay`、`pair`、`device`、`token`、`events`、`audit` 等。每条命令有帮助，每条错误说明怎么解决。
  The command line covers everything the web page does (except answering approvals and questions), with help on every command and a fix in every error.
- PIN：凡是“放别人进来”的操作（导入名片、开放 agent、配对设备、选中转、信任外部签发方……）都要 PIN；重置 PIN 时吊销全部对外授权、名片和设备。
  A PIN guards everything that lets someone in (contacts, public agents, devices, relay, external issuers); resetting it revokes all of them.

### Harness

- 原生支持 Claude Code 和 Codex。
  Native adapters for Claude Code and Codex.
- 一个通用的 ACP 适配器：Kimi Code CLI、OpenCode、Antigravity CLI（二线），DeepSeek Harness（实验档）。会说 ACP 的其他命令行可以用 `DAISY_ACP_HARNESSES` 指向的 JSON 文件接入，不改代码（见 `examples/acp-harness/`）。
  One generic ACP adapter: Kimi Code CLI, OpenCode, Antigravity CLI, and DeepSeek Harness (experimental); add any other ACP harness with a JSON entry in `DAISY_ACP_HARNESSES`, no code.
- 每家 harness 声明自己支持哪些能力；界面和命令行按声明显示功能，不支持的明确说“不支持”，不模拟。
  Each harness declares its capabilities; the UI and CLI follow the declaration and say "not supported" rather than simulate.

### 互认与 A2A / Contacts and A2A

- 身份：每个 Daisy 首次启动时生成一把 Ed25519 身份密钥；身份名片是一段可以复制的签名文本。双方各导入一次对方的名片就互相认得，名片本身不带任何权限。
  Identity: an Ed25519 key made on first start; identity cards are signed text. Importing each other's card is mutual recognition and grants nothing by itself.
- 调用授权：每个 agent 对每个人单独授权；开放范围（所有互认的人，或指定的人）；第一次调用弹出待批准的卡片（永久通过、仅本次、拒绝）；白名单；撤销立即生效并停下进行中的调用。
  Per-agent, per-person grants; audience; an approval card on the first call; a whitelist; revocation stops calls in flight.
- A2A 1.0 服务端：JSON-RPC 和 HTTP+JSON 两种传输，发消息、查任务、列任务、取消任务；三个编号（contextId、taskId、messageId）的规则；不需要任何必需扩展，官方 A2A SDK 能直接调用。
  An A2A 1.0 server (JSON-RPC and HTTP+JSON): send, get, list, cancel; no required extensions — the official A2A SDK works as is.
- “问”与“办”：别人的调用默认是“问”（只读回答）；带“办”标记才进主线动手，每个 agent 可以设置是否允许办、办的时候用什么权限模式。
  Ask and act: calls are read-only "ask" by default; "act" works on the main line only where the owner allows it.
- 三种 agent：私人 agent（只有主人用）、公开 agent（把一个会话开放给别人）、常驻 agent（一份配置，每段来访对话一个独立会话，有并发和用量上限，可暂停）。
  Three kinds of agent: private, public (a session opened to others) and resident (a configured service, one isolated session per conversation, with limits).
- AI 也能调用别人：发现智能体、调用智能体、查询调用结果三个工具；答复作为参考资料交还给 AI；每条调用链有深度上限。
  Your AI can call others (discover, call, result); answers come back as reference material; call chains are depth-limited.
- `daisy-mcp`（`@daisy-ai/a2a-mcp`）：给不装 Daisy 的 harness 用的独立 A2A 客户端，作为 MCP 服务运行，有自己的身份和通讯录，只做客户端（见 `examples/daisy-mcp/`）。
  `daisy-mcp`: a standalone A2A client as an MCP server for harnesses without Daisy — its own identity and address book, client only.

### 走出内网 / Beyond the local network

- `daisy-relay`（`@daisy-ai/relay`）：给路由器后面的 Daisy 一个固定的对外地址，按 SNI 原样转发 TLS，不解密、不保存、不判断谁能调用谁（见 `examples/relay/`）。
  `daisy-relay`: a fixed public address for a Daisy behind a router; passes TLS through by SNI — no decryption, no storage, no access decisions.
- Daisy 主动连上中转并保持，断了自动重连；经中转进来的请求只能到对外的入口；为自己的中转地址自动申请证书（ACME TLS-ALPN-01）；Daisy 之间经中转调用时先核对对方用身份密钥签的 TLS 绑定声明，中转运营者无法冒充。
  Daisy keeps an outbound connection to the relay, gets a certificate for its relay address (ACME TLS-ALPN-01), and Daisy-to-Daisy calls check a TLS binding claim signed by the identity key, so the relay operator cannot impersonate it.
- 配对：`daisy pair` 生成一次性配对码，另一台设备（比如手机浏览器）输入后以主人身份连进来，直连或经中转；设备可以单独吊销。
  Pairing: `daisy pair` gives a one-time code for another device (e.g. a phone browser), directly or through the relay; each device can be revoked.

### 接入外部系统 / Integration

- 外部令牌签发方：可以信任一个外部签发方（离线验证它的公钥），只有指定的主体得到主人身份；Daisy 也替 AI 向它换取短期令牌。
  An external token issuer can be trusted (verified offline); only the configured subject is the owner; Daisy obtains short-lived tokens for its AI.
- 事件出口：AI 请求授权、AI 提问、有人想调用待批准，按序号增量读取（`daisy events`、`daisy watch`）。
  An event outlet for approvals, questions and pending calls, read incrementally.
- 插件接口：`@daisy-ai/daisy/plugin`，两个挂点（会话启动时注入提示词和环境变量、订阅外部事件唤醒会话），默认不启用（见 `examples/plugin-hello/`）。
  A plugin seam, `@daisy-ai/daisy/plugin`, with two hooks; off by default.

### 系统与安装 / Platforms and installation

- Linux、macOS、Windows 原生支持（Windows 不需要 WSL）；开机自启分别用 systemd 用户单元、launchd 登录项、当前用户的启动项，都不需要 root 或管理员。
  Native on Linux, macOS and Windows (no WSL); autostart via a systemd user unit, a launchd agent or the user's Run entry — no root or admin.
- 用 npm 安装，三个系统上安装、更新、卸载的命令相同。更新等到空闲再换，换之前备份数据库，新版本起不来就自动退回。
  Installed with npm, the same commands on all three systems; updates wait for idle, back up the database first and roll back if the new version does not start.
- 每个动作记一条审计（谁、经什么入口、对什么、哪条调用链）；日志和错误信息里不出现凭据、令牌、PIN。
  Every action is audited; logs and errors never contain credentials, tokens or PINs.

### 已知的限制 / Known limitations

- A2A 的流式返回和推送通知还没有做，名片上如实声明不支持。
  A2A streaming and push notifications are not implemented (declared as unsupported on the agent card).
- 不同 harness、不同系统上能做到的不一样（只读的强弱、插话、额度等），以各家的能力声明为准。
  What works differs per harness and per OS (read-only strength, steering, quota …); each harness's declaration is authoritative.

[0.1.0]: https://github.com/QuantGrail/daisy/releases/tag/v0.1.0
