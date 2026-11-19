# 在 MCP 客户端里配置 `daisy-mcp`

[English](README.md)

`daisy-mcp`（包 `@daisy-ai/a2a-mcp`）是一个只做客户端的 A2A MCP 服务：自带一把 Ed25519 身份密钥和一个通讯录，提供 `agents`（发现智能体）、`call_agent`（调用智能体）、`call_result`（查询调用结果）三个工具。它不监听任何端口，名片上没有地址，别人调用不了它。详见 `packages/a2a-mcp/README.md`。

## 1. 安装和互认（在终端里，由你本人做）

需要 Node.js 24 或更新。**`@daisy-ai/a2a-mcp` 还没有发布到 npm**：在那之前，在这个仓库的检出里打包、全局安装（发布之后换成 `npm install -g @daisy-ai/a2a-mcp`）：

```sh
npm ci
npm pack -w @daisy-ai/a2a-mcp                   # 打出 daisy-ai-a2a-mcp-<版本>.tgz
npm install -g ./daisy-ai-a2a-mcp-<版本>.tgz     # 装好后有 daisy-mcp 命令
```

然后互认：

```sh
daisy-mcp card --name "我的 Claude Code" > me.daisycard    # 交给对方的 Daisy 主人导入
daisy-mcp import bob.daisycard --expect-id "<对方编号的前 16 个字符>"   # 导入对方的名片：先显示名片，输入 yes 才导入
daisy-mcp contacts
```

`--expect-id` 只在编号对不上时拒绝，不代替确认；不在终端里运行时，核对过编号后加 `--yes`。AI 不能添加或移除联系人，只有你在终端里能做。

## 2. 配置 MCP 客户端

- Claude Code：[`claude-code.mcp.json`](claude-code.mcp.json) 放到项目根目录、改名为 `.mcp.json`；或者一条命令：`claude mcp add daisy -- daisy-mcp serve --agent-name "我的 Claude Code"`。
- Codex：把 [`codex.config.toml`](codex.config.toml) 里的那张表加到 `~/.codex/config.toml`。
- 其他 MCP 客户端：命令 `daisy-mcp`，参数 `serve`，传输 stdio。

`--agent-name` 是对方主人看到的“谁在调用”（不写时用 `Daisy MCP`）。密钥和通讯录默认在系统的配置目录（macOS `~/Library/Application Support/Daisy MCP`，Linux `$XDG_CONFIG_HOME/daisy-mcp`，没设时 `~/.config/daisy-mcp`；Windows `%APPDATA%\Daisy MCP`）；要另放就在配置里加 `"env": { "DAISY_MCP_HOME": "/path" }`（TOML 里是 `env = { DAISY_MCP_HOME = "/path" }`），或在 `args` 里加 `--home /path`。

对方智能体的回答以 `<external_message>` 包起来交给 AI，标明是参考资料、不是指令。

这两份配置由 `tests/examples.test.ts` 检查：按配置里的参数启动 `daisy-mcp`，用 MCP SDK 的客户端连上，列出三个工具。
