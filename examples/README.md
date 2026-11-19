# 示例 / Examples

每个目录一个能直接拿去用的例子，都由 `tests/examples.test.ts` 在不联网的情况下用 Daisy 自己的代码检查过。

Each directory is a ready-to-use example; `tests/examples.test.ts` checks every one against Daisy's own code, without network.

每个目录的 `README.zh-CN.md` 是中文说明，`README.md` 是英文说明。In each directory, `README.md` is in English and `README.zh-CN.md` in Chinese.

| 目录 / Directory | 内容 / What |
| --- | --- |
| [`acp-harness/`](acp-harness/) | 不改代码接入一个会说 ACP 的 harness（`runner.json` 的 `acpHarnesses`）/ add an ACP harness without code |
| [`relay/`](relay/) | 自己架 `daisy-relay`：配置和 systemd 单元 / run your own relay: config + systemd unit |
| [`a2a-client/`](a2a-client/) | 从程序里经 A2A 调用 Daisy 的智能体（`@daisy-ai/a2a-client`、官方 A2A SDK）/ call a Daisy agent over A2A from code |
| [`daisy-mcp/`](daisy-mcp/) | 在 Claude Code、Codex 等 MCP 客户端里配置 `daisy-mcp` / configure `daisy-mcp` in an MCP client |
| [`plugin-hello/`](plugin-hello/) | 一个最小的插件（`@daisy-ai/daisy/plugin`）/ a minimal plugin |

例子里的域名一律是 `example.com` / `example.net`，地址是文档用的 `203.0.113.0/24`。
Domains in the examples are `example.com` / `example.net`; addresses are documentation ranges.
