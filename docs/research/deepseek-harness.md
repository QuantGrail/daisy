# DeepSeek Harness 是什么，对外提供什么协议

核实日期：2026-11-16（P0-03 第 3 项）

## 结论

- **是什么**：DeepSeek 开源的 agent harness（简称 dsh），MIT 许可，TypeScript，基于 Cordis 插件框架，口号是 “Everything is a Plugin”：模型、工具、技能、会话、沙箱、存储、调度、界面都是可替换的插件。2026-08 进入开发者预览。仓库 `deepseek-ai/deepseek-harness`；最新是 `dsh-v0.2.2-rc.3`（2026-11-13），npm `@deepseek-ai/dsh` 最新 `0.2.2-rc.1`，要求 Node ≥ 24.9。README 明确写着“THERE WILL BE COMPATIBILITY-BREAKING CHANGES”。
- **形态**：通过“profile”启动不同前端：`dsh web`（本地网页，`npx @deepseek-ai/dsh web` 是官方推荐的起步方式）、`dsh tui`、`dsh headless "任务"`，另有桌面端和 Python SDK。
- **对外协议：标准 ACP v1。** 包 `@deepseek-ai/dsh-acp`，启动命令 **`dsh acp`**（等同 `dsh --profile acp`），stdio JSON-RPC。官方把它定位成“只给自动化用的 ACP”：面向脚本、测试、另一个 harness 的外部子代理，刻意不提供界面类功能。它自己的 `dsh-subagent-acp` 就是用这个协议驱动另一个 dsh。
- **ACP 能力（dsh 仓库里的握手快照 `snapshots/acp/handshake` 与包文档一致）**：
  - 有：`session/new`、`session/list`、`session/resume`（不重放历史）、`session/close`、`session/prompt`、`session/cancel` 和 `$/cancel_request`、`session/set_config_option`（`model` 和 `reasoning_effort`）、`session/update`、`session/request_permission`、Streamable HTTP 和 stdio 的 MCP。一个连接可以并行多个会话。`authenticate` 直接成功（不需要认证）。
  - 没有：`session/load`（`loadSession` 未声明）、删除、**分叉**、附加目录、SSE MCP、**模式**、命令、计划、终端、客户端文件系统、表单提问。
- **自有协议**：除 ACP 外，`dsh web` 有自己的网页服务接口，headless 有 `--json` 事件流。这些不是对外的标准协议，Daisy 不应依赖。
- **只读**：dsh 有 `read-only` 权限预设（headless 用 `--permission-mode <preset>` 选；文件沙箱默认模式也是 `read-only`），但 **ACP 不暴露模式**，经 ACP 没法在会话里切到只读。能否通过自定义 profile 让 ACP 会话默认只读，未能核实。

## 出处

- 仓库与 README：https://github.com/deepseek-ai/deepseek-harness
- ACP 包文档：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md
- 命令行帮助：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md （`dsh acp` 一节）
- 官网（开发者预览页）：https://deepseek.com/harness/en/
- npm：https://www.npmjs.com/package/@deepseek-ai/dsh

## 对当时设计的影响

1. 设计稿 harness 接入表里“实验 · DeepSeek Harness · 【待核实】它对外提供什么协议”可以落定：**走通用 ACP 适配器**，启动命令 `dsh acp`，不需要单写原生适配器。
2. 它没有 `session/load`，只有 `session/resume`。通用适配器“开会话与恢复”这项必备能力要同时支持 load 和 resume 两种路径（按 `initialize` 返回选用），否则恢复会失败。现有 `kimi.ts` 只认 `loadSession`。
3. 它经 ACP 没有只读模式、没有分叉。按“连只读模式都没有的 harness 不能接受问”的规则，接它的 agent **不能接受“问”**，只有主人允许“办”时才能公开。这和设计的规则一致，不推翻设计，只是要在能力声明里如实写“不支持”。
4. “工具授权与提问”这项必备能力只部分满足：权限请求有，表单提问没有（ACP 下不支持 elicitation）。它的提问会怎样到达客户端，未能核实。
5. 预览期不兼容变更多，设计里写的“能跑通基本对话，不承诺稳定”是合适的定位。
