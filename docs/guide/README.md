# Daisy 用户指南 / Daisy user guide

## 中文

| 文档 | 内容 |
| --- | --- |
| [安装、更新与卸载](zh-CN/install.md) | 要求、npm 安装、数据目录、端口、开机自启、语言、更新、卸载、出问题时 |
| [第一次使用](zh-CN/first-use.md) | 启动、设 PIN、打开网页、登录 harness、第一轮对话 |
| [命令参考](zh-CN/commands.md) | 每一条 `daisy` 命令（由命令表生成） |
| [harness 支持范围](zh-CN/harnesses.md) | 六家 harness 各自支持什么、问与办、各系统的差异、已知限制 |
| [中转](zh-CN/relay.md) | 自己架 `daisy-relay`，把 Daisy 连上去，证书，用别人的中转要信任什么 |
| [配对](zh-CN/pairing.md) | 用手机或另一台电脑的浏览器打开 Daisy |
| [安全模型](zh-CN/security.md) | 两个入口面、PIN、凭据、调用授权、审计与脱敏、已知限制 |
| [写一个 ACP harness 配置](zh-CN/acp-harness.md) | 额外 ACP harness 文件的格式和例子；用 `runner.json` 的 `acpHarnesses`（或 `DAISY_ACP_HARNESSES`）指给 Daisy |
| [外部接入](zh-CN/integrations.md) | 互认、A2A、`daisy-mcp`、外部界面与本机接口 |
| [插件](zh-CN/plugins.md) | 插件是什么、插件名的规则、用 `runner.json` 的 `plugins`（或 `DAISY_PLUGINS`）启用、最小的例子 |
| [环境变量](zh-CN/environment.md) | Daisy、`daisy-relay`、`daisy-mcp` 认的环境变量；开机自启时也生效的 `runner.json` 设置 |

本机 HTTP 接口：[docs/api/local-api.md](../api/local-api.md)。

## English

| Document | What is in it |
| --- | --- |
| [Install, update and uninstall](en/install.md) | Requirements, npm install, data directory, ports, start at boot, language, updates, uninstall, troubleshooting |
| [First use](en/first-use.md) | Start, set a PIN, open the web page, log in to a harness, first conversation |
| [Command reference](en/commands.md) | Every `daisy` command (generated from the command table) |
| [What each harness supports](en/harnesses.md) | What each of the six harnesses supports, ask and act, differences between systems, known limits |
| [Relay](en/relay.md) | Run your own `daisy-relay`, connect Daisy to it, certificates, what you trust when using someone else's relay |
| [Pairing](en/pairing.md) | Open Daisy from a phone or another computer's browser |
| [Security model](en/security.md) | The two faces, the PIN, credentials, call authorization, audit and redaction, known limits |
| [Writing an ACP harness config](en/acp-harness.md) | Format and example of an extra ACP harness file; point Daisy to it with `acpHarnesses` in `runner.json` (or `DAISY_ACP_HARNESSES`) |
| [Integrations](en/integrations.md) | Exchanging cards, A2A, `daisy-mcp`, external UIs and the local API |
| [Plugins](en/plugins.md) | What a plugin is, naming rules, enabling with `plugins` in `runner.json` (or `DAISY_PLUGINS`), a minimal example |
| [Environment variables](en/environment.md) | Variables recognized by Daisy, `daisy-relay` and `daisy-mcp`; `runner.json` settings that also apply at boot |

Local HTTP API: [docs/api/local-api.md](../api/local-api.md).

## 维护 / Maintenance

`zh-CN/commands.md` and `en/commands.md` are generated from the command table. After changing a command, run:

```sh
node scripts/gen-cli-docs.mjs            # rewrite
node scripts/gen-cli-docs.mjs --check    # exit 1 when stale
```

`zh-CN/` and `en/` hold the same pages under the same file names, with the same sections; `tests/guide-pages.test.ts` checks that every page has its counterpart. When you change one language, change the other in the same commit.

The English pages quote the English text Daisy shows on screen; the Chinese pages quote the Chinese text. When a change alters text users see, update the quote in both languages.
