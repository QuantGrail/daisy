# ACP 当前版本，以及 Kimi、OpenCode、Antigravity 的 ACP 启动方式和能力

核实日期：2026-11-16（P0-03 第 2 项）

## 结论

**ACP 本身**

- 协议版本号（`initialize` 里协商的整数）仍是 **1**。稳定 schema 最新是 **v1.32.0**（2026-11-14），Rust crate v1.18.0，TypeScript SDK `@agentclientprotocol/sdk` 2.7.0。v2 还在 alpha（`schema-v2.0.0-alpha.16`），不用管。
- **稳定的**方法：`initialize`、`authenticate`、`logout`、`session/new`、`session/load`、`session/prompt`、`session/cancel`、`session/set_mode`、`session/set_config_option`、`session/list`、`session/delete`、`session/resume`、`session/close`，还有 `$/cancel_request`。客户端侧：`session/update`、`session/request_permission`、`fs/*`、`terminal/*`、`elicitation/*`。
- **不稳定的**：`session/fork`、`session/archive`、`session/status`、`session/options`、`session/set_title`、`providers/*` 等。能力声明在 `agentCapabilities.sessionCapabilities` 下（`list`、`delete`、`resume`、`close`、`additionalDirectories`、`systemPrompt`，不稳定的还有 `fork` 等）。
- **`session/set_model` 已经从协议里删掉**（2026-06-01，它从没稳定过）。切模型、思考强度、模式统一走 `session/set_config_option`，按 `category` 识别：`model`、`thought_level`、`mode`（还有 `model_config`，不稳定的 `speed`）。
- 官方 ACP 注册表（`agentclientprotocol/registry`）列出每家 agent 的启动命令；另有官方 `acp-tck`。

**Kimi**

- **原来的 Kimi CLI（Python）已于 2026-09 归档**，仓库标注“Legacy … no longer maintained. Please use Kimi Code CLI”。ACP 注册表里它叫 “Kimi CLI (Legacy)”，最后版本 1.52.0。
- 接替它的是 **Kimi Code CLI**（`MoonshotAI/kimi-code`，TypeScript，npm `@moonshot-ai/kimi-code`，当前 2.6.2）。**命令名仍是 `kimi`，ACP 启动命令仍是 `kimi acp`**，数据目录换成 `~/.kimi-code`。
- Kimi Code 在 `initialize` 里声明：`loadSession: true`；`sessionCapabilities` 有 `list`、`resume`、`close`、`delete`、`fork`、`additionalDirectories`；图片、内嵌资源；HTTP 和 SSE 的 MCP。
- 模式（`session/set_mode`，也作为 `mode` 配置项）：`default`（逐个批准）、`plan`、`auto`、`yolo`。配置项：`model`、`thinking`（类别 `thought_level`，只在模型支持时出现）、`mode`。另外保留 `session/set_model` 作为扩展方法。
- 取消：`session/cancel` 和 `$/cancel_request` 都支持。
- `elicitation/create`（表单提问）支持。没有声明运行中插话。

**OpenCode**

- 仓库已从 `sst/opencode` 迁到 **`anomalyco/opencode`**，现在是 OpenCode 2（npm `@opencode/cli`，2.3.0）。启动命令 **`opencode acp`**；排错时用 `opencode --print-logs acp`；终端登录用 `opencode acp --login`。
- 一个进程可以服务多个 ACP 会话，自己起一个私有服务端，不开网络端口。
- 声明：`loadSession: true`；`sessionCapabilities` 有 `additionalDirectories`、`close`、`delete`、`fork`、`list`、`resume`；图片、内嵌资源；HTTP MCP（不支持 SSE MCP）。
- 配置项：`model`（`provider/model`）、`effort`（类别 `thought_level`）、`mode`（= OpenCode 的主代理，如 `build`、`plan`）；`session/set_mode` 也能切代理。
- 取消：`session/cancel` 和 `$/cancel_request`。一个会话同时只跑一个 prompt，第二个会报错。
- 扩展：`_session/steering`（运行中插话，过渡方案）；子会话更新带 `_meta["opencode/child-session"]`；用量走 `usage_update`。
- `session/load`、`session/resume`、`session/fork` 都要求 `cwd` 与原会话一致，否则参数无效。

**Antigravity**

- **`agy acp` 核实无误。** 官方文档写的就是 `agy` 加一个参数 `acp`，协议版本 1，stdio，服务名 “Antigravity ACP Server”；文档让用户先 `agy acp --help` 确认所装版本支持。哪个版本开始支持，官方文档没写；第三方发布记录汇总站（havoptic.com）记为 v1.5.0（2026-11-04），仅供参考。
- 可加的参数：`--add-dir`、`--agent`、`--sandbox`、`--dangerously-skip-permissions`、`--process-per-session`（编辑器给的 HTTP MCP 需要它）、`--ide-mcp-port`、`--login`、`--log-file`、`--disable-telemetry`。**没有 `--mode` 参数**（终端模式有 `--mode`）。
- 注意：ACP 注册表里的 “Google Antigravity” 条目用的是另一个包（`agy-acp-server-1.5.0`，命令 `./agy_acp_server.par` / `.exe`），属于 IDE 扩展的发行方式。Daisy 用 `agy acp` 即可。
- 文档列出的能力：会话加载、恢复（不重放历史）、列出、关闭；配置项 Model 和 Thinking level（Low 到 Max）；取消；权限请求；表单提问；运行中再发 prompt 会“插话”到当前一轮；图片和内嵌资源；多根目录。
- **文档没有提到 ACP 下的 `session/fork` 和模式切换。** 这两项未能核实，按“不支持”处理，接入时以 `initialize` 返回为准。
- 没有凭据时请求报 `Authentication required`（`-32000`）。

## 出处

- ACP 仓库与 schema：https://github.com/agentclientprotocol/agent-client-protocol （该仓库的 `schema/v1/meta.json`、`meta.unstable.json`、`schema/v1/CHANGELOG.md`；https://github.com/agentclientprotocol/agent-client-protocol/blob/HEAD/docs/rfds/updates.mdx 、https://github.com/agentclientprotocol/agent-client-protocol/blob/HEAD/docs/rfds/session-fork.mdx ）
- ACP 注册表：https://github.com/agentclientprotocol/registry （`kimi/`、`kimi-code/`、`opencode/`、`antigravity-acp/`）
- Kimi CLI 归档：https://github.com/MoonshotAI/kimi-cli ；Kimi Code：https://github.com/MoonshotAI/kimi-code （https://github.com/MoonshotAI/kimi-code/blob/HEAD/docs/en/reference/kimi-acp.md 、https://github.com/MoonshotAI/kimi-code/blob/HEAD/packages/acp-server/src/modes.ts ），文档 https://moonshotai.github.io/kimi-code/en/
- OpenCode ACP 文档：https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/cli/acp.mdx ；实现 https://github.com/anomalyco/opencode/blob/dev/packages/cli/src/acp/service.ts
- Antigravity：https://antigravity.google/docs/ide/extensions/acp ，https://antigravity.google/docs/cli/acp

## 对当时设计的影响

1. **harness 接入表要改名**：二线的 “Kimi CLI” 应改成 “Kimi Code CLI”。启动命令不变（`kimi acp`），但现有适配器默认找 `kimi`，用户机器上装的可能是旧的归档版本，也可能是新版本，两者数据目录不同（旧版 `~/.kimi/`，新版 `~/.kimi-code`）。Kimi Code 首次运行时会提示把旧版的配置、MCP 和会话历史迁移过来（官方迁移指南 https://github.com/MoonshotAI/kimi-code/blob/HEAD/docs/en/guides/migration.md ）；迁移后旧会话编号能否原样 `session/load`，未能核实。建议在能力探测时读 `initialize` 返回的 `agentInfo` 区分。
2. **通用 ACP 适配器不要再用 `session/set_model`**：改为按 `configOptions` 的 `category`（`model`、`thought_level`、`mode`）调用 `session/set_config_option`。现有 `kimi.ts` 用 `session/set_model` 和固定的 `configId: "thinking"`，对 Kimi Code 仍然能用（它把 `set_model` 留作扩展），但对 OpenCode（配置项叫 `effort`）和 Antigravity 不通用。
3. **“旁问或分叉”在 ACP 下有了路径**：Kimi Code 和 OpenCode 都声明了 `session/fork`（不稳定方法）。“问”可以对它们做“分叉 + 只读模式”的支线，不必回落到主线排队。现有 `agent-capabilities.ts` 里 Kimi 写的 `askOnly: { sideQuestion: "none", fork: "none" }` 对 Kimi Code 已经过时。
4. **运行中追加**：OpenCode（`_session/steering`）和 Antigravity（运行中发 prompt 即插话）各有做法，都不是 ACP 标准方法，按“可选能力、各自声明”处理。
5. 设计里 “一条配置：启动命令加参数” 的思路成立：`kimi acp`、`opencode acp`、`agy acp`、`dsh acp` 都是一个命令加一个参数。没有推翻设计。
