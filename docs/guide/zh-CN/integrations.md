# 外部接入：A2A、daisy-mcp、外部界面

[English](../en/integrations.md)

Daisy 和外面打交道有四条路：

| 想做的事 | 用什么 |
| --- | --- |
| 我的 AI 去调用别人的 agent | Daisy 给 harness 的三个工具（自动带上） |
| 别人（他的 Daisy 或任何 A2A 客户端）调用我的 agent | Daisy 的 A2A 服务端 |
| 没装 Daisy 的 harness 去调用别人的 agent | 独立的 `daisy-mcp` |
| 自己写一个界面或程序来操作 Daisy | 本机接口 + 外部签发方（或在本机用命令行） |

跨 Daisy 的协议是 [A2A](https://a2a-protocol.org/) 1.0。安全规则见 [安全模型](security.md)。

## 互认：先交换名片

两个 Daisy 之间先要互认。双方各做一次：

```sh
daisy contact export --name 张三        # 要 PIN；回答里的 text 就是名片，整段发给对方
daisy contact import --card-file bob.daisycard --expect-id "<和对方核对过的编号>"   # 要 PIN
daisy contact list
```

- 对方发来的名片文本可以直接作为参数（`daisy contact import "<整段文本>"`），也可以存成 `.daisycard` 文件用 `--card-file`。
- 名片里有显示名、公钥和编号、能连到你的地址（对外面的直连地址、中转地址）。名片本身不带任何权限。
- 导入前和对方当面或电话核对编号，至少前 16 个字符。名片只证明“这段内容是这把钥匙的主人发的”。
- `--whitelist` 同时把他加进白名单：他调用你“对所有互认的人开放”的 agent 时不再弹卡片。
- 名片里要有地址，对方才连得到你：先开对外面（`daisy access external on`）或选中转（`daisy relay set`）。

## 我的 AI 调用别人

Daisy 给它管的每个 harness 三个工具（MCP），不用配置：

| 工具 | 做什么 |
| --- | --- |
| `agents` | 列出互认的人开放给你的 agent |
| `call_agent` | 调用一个 agent：`mode` 是 `ask`（问，默认）或 `act`（办）；`continue: true` 接着上次那段对话 |
| `call_result` | 查一次调用的结果 |

在会话里直接让 AI “问一下张三的 Daisy 上那个 agent……”就行。对方的回答作为外部资料交给你的 AI，不是你的指令。

你的 AI 调用了谁：`daisy call list`、`daisy call show <id>`，或网页的设置页。

经中转调用时，Daisy 先核对对方的 TLS 绑定声明，对不上就不发令牌、拒绝这次调用（见 [中转](relay.md)）。

## 别人调用我

会话默认是私人 agent，谁也调不了。要被调用，选一种：

- **公开一个会话**：`daisy agent public set <会话 id> true`（要 PIN；`false` 收回私有）。别人在这个会话上“问”或“办”。**会串话**：来访者读得到这个会话的上下文。
- **建一个常驻 agent**：`daisy agent resident create --name 客服 --harness claude --workspace-id <id> --profile-id <id> --tools Read --tools Grep --tools Glob`（要 PIN）。每段来访对话有自己的会话，互相看不到；提示词分四层（Daisy 的规则、角色、指引、资料）；可以暂停、恢复、关闭。

再设谁能调用：

```sh
daisy agent audience show <agent id>
daisy agent audience set <agent id> --open-to listed --listed <联系人编号>   # 只对指定的人（要 PIN）；all 是对所有互认的人
daisy agent act set <agent id> --act false    # 只许问、不许办（要 PIN）
daisy request list                            # 等你批准的调用
daisy request decide <请求 id> always         # always 永久通过 / once 仅本次 / reject 拒绝（要 PIN）
daisy grant list                              # 已有的授权；收回用 daisy grant revoke
```

每条命令的参数见 [命令参考](commands.md)。网页的设置页里有同样的功能。

### A2A 服务端的地址

| | 地址 |
| --- | --- |
| agent 目录（Daisy 自己的，不是 A2A 的一部分） | `GET <根>/a2a` |
| agent 名片 | `<根>/a2a/<agent id>/.well-known/agent-card.json` |
| JSON-RPC 2.0 | `POST <根>/a2a/<agent id>/jsonrpc` |
| HTTP+JSON | `<根>/a2a/<agent id>/message:send`、`…/tasks`、`…/tasks/<task id>`、`…/tasks/<task id>:cancel` |

`<根>` 是对外面的地址或中转地址。说明：

- 只支持 A2A 1.0：请求要带 `A2A-Version: 1.0` 头。两种传输（HTTP+JSON、JSON-RPC）都有，名片里都声明。
- 支持：发消息、查任务、列任务（只列自己发起的）、取消任务。不支持：流式、订阅、推送通知、扩展名片。
- 不带 `returnImmediately: true` 时，Daisy 一直等到任务结束或需要输入才回答；带了就立即返回任务。断线后用同一个 `messageId` 重发，拿到的是原来的任务。
- 看不到的 agent（私人的、不对你开放的）一律像不存在一样回 404。
- 来访对话空闲 7 天、没有未结束的任务就回收。

### 给第三方 A2A 客户端一张令牌

不是 Daisy 的客户端（例如用官方 A2A SDK 写的程序）不会自己签令牌。给它签一张：

```sh
daisy token issue --for <联系人编号> --ttl 30d --note "给 CI 用"    # 要 PIN
```

- 令牌只在这一次回答里出现，Daisy 不存它。像密码一样保管。
- 拿着它的人以那位联系人的身份调用，仍要过调用授权（开放范围、白名单、卡片）。`--for me` 签给自己，也只能走 A2A 入口。
- 默认 7 天，最多 90 天。`daisy token list`、`daisy token revoke <id>` 管理；联系人被移除、重置 PIN 时一并作废。
- 客户端发请求时带 `Authorization: Bearer <令牌>`。

经中转调用、而你的中转证书还是自签名时，第三方客户端会报证书不受信任；ACME 申请到证书后才行（见 [中转 › 证书](relay.md#证书acme)）。

## daisy-mcp：给没装 Daisy 的 harness

`@daisy-ai/a2a-mcp`（命令 `daisy-mcp`）是一个独立的 MCP 服务，在 stdio 上运行。它有自己的一对密钥和通讯录，用和 Daisy 一样的名片互认，提供同样的三个工具：`agents`、`call_agent`、`call_result`。它**只做客户端**：不监听端口，名片上没有地址，别人调用不了它。

发布到 npm 之后用 `npm install -g @daisy-ai/a2a-mcp` 安装。**它还没有发布到 npm**，在那之前在代码检出里（怎么取得代码见 [安装 › 取得源代码](install.md#取得源代码)）打包、安装：

```sh
npm ci
npm pack -w @daisy-ai/a2a-mcp                   # 打出 daisy-ai-a2a-mcp-<版本>.tgz
npm install -g ./daisy-ai-a2a-mcp-<版本>.tgz     # 装好后有 daisy-mcp 命令
```

用法：

```sh
# 1. 导出自己的名片，交给对方的 Daisy 主人导入（daisy contact import），并请他允许你调用
daisy-mcp card --name "张三的 Claude Code"

# 2. 导入对方 Daisy 的名片（和对方核对编号）：它先显示名片，等你输入 yes 才导入
daisy-mcp import bob.daisycard --expect-id "<编号>"

# 3. 在 harness 里配置 MCP 服务：命令 daisy-mcp，参数 serve [--agent-name "张三的 Claude Code"]
```

`--expect-id` 只在编号对不上时拒绝，不代替确认。不在终端里运行（例如从标准输入读名片）时没法问，要在核对过编号后加 `--yes`。

其他命令：`daisy-mcp contacts`、`daisy-mcp remove <编号>`、`daisy-mcp --help`。

密钥和通讯录默认放在系统的配置目录（Linux `$XDG_CONFIG_HOME/daisy-mcp`，没设时 `~/.config/daisy-mcp`；macOS `~/Library/Application Support/Daisy MCP`，Windows `%APPDATA%\Daisy MCP`），只有当前账户能读写。用 `--home <目录>` 或环境变量 `DAISY_MCP_HOME` 另指。需要 Node.js 24 或更新。

Claude Code、Codex 里现成的配置见 [examples/daisy-mcp](../../../examples/daisy-mcp/)。

## 自己写界面或程序

### 本机：用命令行

同一台机器上，最简单的是调用 `daisy` 命令：接口命令的回答都是 JSON（见 [命令参考](commands.md)）。持续读“AI 请求授权、AI 提问、有人想调用”这些事件：

```sh
daisy watch --cursor-file ~/.daisy-watch-cursor    # 每条事件一行 JSON（CloudEvents 1.0）
```

### 本机接口

网页、命令行用的都是同一套本机 HTTP 接口，定义在 `packages/contracts/src/api`，文档由它生成：[本机接口文档](../../api/local-api.md) 和 [OpenAPI 描述](../../api/openapi.json)。每条接口写明了 scope、要不要 PIN、哪些通道能用。

### 外部签发方

要从另一个程序（例如你自己的网页后端）以主人身份连 Daisy，配置一个外部签发方（OAuth / OpenID Connect）：

```sh
daisy access issuer set --issuer https://id.example --owner-subject <主人在签发方那里的 sub>    # 要 PIN
daisy access issuer show
```

- 签发方签给主人（`sub` 是主人）的令牌得到主人身份，有效期不能超过 24 小时；签给别人的只能走 A2A 入口。
- Daisy 离线验证令牌，按 `kid` 轮换公钥。
- 用这类令牌**回答 AI 的工具授权和提问不开放**：界面可以列出卡片，回答要引导主人去 Daisy 的网页或配对的设备。
- TypeScript 客户端在 `packages/client`（`@daisy-ai/client`），可以同时连几台 Daisy。

服务端进程（推荐）连 Daisy 不需要任何来源设置：Node 的 `fetch`、`ws`、`curl` 都不带 `Origin`。**不要自己加 `Origin` 头**。

浏览器里的界面要先由主人把它的源加进白名单（只在对外面上生效）：

```sh
daisy access ui-origins set --origins https://ui.example    # 要 PIN；可重复 --origins
daisy access ui-origins show
daisy access ui-origins clear
```

连对外面时，对外面默认是自签名证书：让你的程序只信任这台 Daisy 的 `keys/tls-cert.pem`（例如 `NODE_EXTRA_CA_CERTS`），不要关掉证书校验。
