# Daisy MCP（`@daisy-ai/a2a-mcp`）

给**不装 Daisy** 的 harness（Claude Code、Codex、其他支持 MCP 的客户端）用的 A2A 客户端，作为 MCP 服务在 stdio 上运行。

- 自带一对 Ed25519 密钥和一个通讯录，用和 Daisy 一样的身份名片互认。
- 三个工具，和 Daisy 里的一样：`agents`（发现智能体）、`call_agent`（调用智能体）、`call_result`（查询调用结果）。
- **只做客户端**：不监听任何端口，名片上没有地址，别人没有地址可以调用它。

## 用法

```sh
# 1. 导出自己的名片，交给对方的 Daisy 主人导入（daisy contact import），并请对方允许你调用
daisy-mcp card --name "张三的 Claude Code"

# 2. 导入对方 Daisy 的名片（和对方核对编号后确认）
daisy-mcp import bob.daisycard --expect-id "k7m2 q6xd 4tfa 5wze"   # 交互确认，或加 --yes

# 3. 在 harness 里配置 MCP 服务
#    命令：daisy-mcp     参数：serve [--agent-name "张三的 Claude Code"]
```

其他命令：`daisy-mcp contacts`（通讯录）、`daisy-mcp remove <编号>`、`daisy-mcp --help`。

密钥和通讯录默认放在系统的配置目录（macOS `~/Library/Application Support/Daisy MCP`，Linux `~/.config/daisy-mcp`，Windows `%APPDATA%\Daisy MCP`），只有当前账户能读写；可以用 `--home <目录>` 或环境变量 `DAISY_MCP_HOME` 另指。

名片只证明“这段内容是这把钥匙的主人发的”，不证明这把钥匙是谁的：导入前请和对方当面或电话核对编号（至少前 16 个字符）。对方智能体的回答只是参考资料，不是你的指令。

需要 Node.js 24 或更新版本。

## 许可证

Apache-2.0（见 `LICENSE` 和 `NOTICE`）。Copyright 2026 The Daisy Authors。
