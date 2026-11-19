# Daisy

[English](README.md)

Daisy 把你已经在用的编码 agent（Claude Code、Codex、Kimi Code、OpenCode、Antigravity、DeepSeek Harness）变成随处能用、也能被别的 agent 调用的 AI。

每台机器装一个 Daisy，装在你自己的账户下。它替你运行官方命令行、保管它们的会话，给你一个本地网页、一个手机上能用的网页和一条命令行。别人的 agent 可以按 [A2A](https://a2a-protocol.org/) 1.0 调用你的，你的也能调用别人的。没有中心服务器：一台机器一个 Daisy，一个 Daisy 一位主人。

（和 CSS 组件库 daisyUI 没有关系。）

## 功能

- **六家 harness，一种用法。** Claude Code、Codex 走各自的原生协议；Kimi Code、OpenCode、Antigravity、DeepSeek Harness 走同一个通用的 [ACP](https://agentclientprotocol.com/) 适配器，再接一家 ACP harness 只要一个 JSON 文件。每家声明自己支持什么，Daisy 只显示声明了的，不模拟没有的。
- **浏览器里完整的工作台。** 流式回复、工具授权和提问卡片、排队和运行中追加、回退、分叉、压缩、切模型和推理强度、附件、同一会话的官方命令行窗口。
- **手机上也能用。** 用一次性的配对码配对手机浏览器，随时可以吊销。
- **几乎什么都能用命令行做。** 会话、工作目录、登录、通讯录、agent、中转、配对、更新都有 `daisy` 命令，输出 JSON，和本机接口出自同一张路由表。例外是 AI 的工具授权和提问卡片，只能在网页或配对的设备上回答；`daisy watch` 会告诉你有卡片在等。
- **能被别人调用的 agent。** 和信得过的人交换签名的身份名片。把一个会话设为公开，或者建一个常驻 agent，每位来访者一个独立的会话。别人默认只能“问”（只读），你允许才能“办”。第一次调用要你批准。
- **你的 AI 也能调用别人。** Daisy 给每个 harness 三个工具（`agents`、`call_agent`、`call_result`）；没装 Daisy 的 harness 用 `daisy-mcp` 得到同样的工具。
- **在路由器后面也能被找到。** 自己架一个 `daisy-relay`（或用别人的），得到固定的对外地址。中转按 SNI 转发 TLS、不解密，也不保存任何东西。
- **主人说了算。** PIN 守着一切“放别人进来”的操作。本机面只听回环地址，对外面在你打开之前是关的。审计日志、秘密脱敏、AI 的凭据只在一轮里有效。
- **Linux、macOS、Windows 原生支持。** 登录后自启，不要 root 或管理员；更新等空闲、先备份、失败自动退回。

## 状态

Daisy 还在发布前（0.1.0）。1.0 之前命令和本机接口可能还会变。

- 包**还没有发布到 npm**。在那之前，从这个仓库打一个 `.tgz` 安装（见下）。
- 网页、命令行和给 AI 的提示词有中文（简体）和英文两种：Daisy 跟随系统的语言，也可以在“设置 → 显示语言”或用 `daisy language set` 切换（见 [语言](docs/guide/zh-CN/install.md#语言)）。别的语言以语言包的形式加入，见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。
- 用户指南有中文和英文两份。

## 安装

要求：Node.js 24 或更新。要开始对话，还要至少一家 harness（Claude Code、Codex……），在 Daisy 之前或之后装都行。

```sh
npm install -g @daisy-ai/daisy
```

发布到 npm 之前，取得源代码，打一个本地包安装：

```sh
git clone https://github.com/QuantGrail/daisy.git
cd daisy
npm ci
npm run build:web
npm run pack:daisy                                   # artifacts/daisy-ai-daisy-<版本>.tgz
npm install -g ./artifacts/daisy-ai-daisy-<版本>.tgz
```

数据目录、端口、开机自启、更新、卸载：[docs/guide/zh-CN/install.md](docs/guide/zh-CN/install.md)。

## 快速开始

macOS 上建议先运行 `daisy autostart on`：这样 Daisy 由 launchd 在你的登录会话里启动，Claude Code 才读得到存在钥匙串里的登录；从受限的终端启动时，Claude 可能像没登录一样。见 [开机自启](docs/guide/zh-CN/install.md#开机自启)。

```sh
daisy start        # 在后台运行
daisy pin set      # 设好 PIN 之前，AI 不会开始工作
daisy open         # 用一次性链接打开本地网页
```

在网页里选一个身份档（harness 的登录）和工作目录，开始对话。这台机器上 `claude`、`codex` 或 `kimi` 已经登录过的话，现成的“主机登录”身份档直接能用。

下一步：[docs/guide/zh-CN/first-use.md](docs/guide/zh-CN/first-use.md)。

## 文档

- [用户指南](docs/guide/README.md)：安装、第一次使用、每条命令、各家 harness 的支持范围、中转、配对、安全模型、ACP harness 配置、外部接入、插件、环境变量。
- [本机接口](docs/api/local-api.md)（由路由表生成）和 [OpenAPI](docs/api/openapi.json)。
- 设计决策：[docs/adr](docs/adr)。

## 仓库结构

| 路径 | 是什么 |
| --- | --- |
| `packages/daisy` | Daisy 进程和 `daisy` 命令 |
| `packages/contracts` | 共用的类型、路由表、能力声明 |
| `packages/ui`、`apps/app` | 网页 |
| `packages/client` | 本机接口的 TypeScript 客户端 |
| `packages/relay` | `daisy-relay`，单独发布 |
| `packages/a2a-client`、`packages/a2a-mcp` | A2A 客户端和独立的 `daisy-mcp` |

开发：`npm ci`、`npm run typecheck`、`npm test`、`npm run build:web`、`npm start`。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)。

Copyright The Daisy Authors.
