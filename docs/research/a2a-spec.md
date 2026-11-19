# A2A 1.0 规范：设计稿里未核对的项、兼容性测试套件、官方 SDK、传输绑定

核实日期：2026-11-16（P0-03 第 1 项）

## 版本现状

- 正式版：**1.0.0**（2026-03-12 发布），**1.0.1**（2026-05-28，修订版：HTTP 绑定改为优先用 `application/a2a+json`、错误细节改为 `google.rpc` 结构、状态名统一写成 `TASK_STATE_*`）。网站 `/latest/specification/` 页头仍写“1.0.0”。
- 另有 `v1.1.0-rc` 标签（候选版，未发布）：新增 `TaskGenerationMismatchError`（`-32010` / HTTP 409，乐观并发用），修正了样例名片的认证写法。下文以 1.0.1 为准，1.1 的变化单独注明。

## 结论：设计稿 A2A 速查里“还没核对的”四项

**1. 发送配置里“立即返回 / 等结果”的字段**

- 字段名：`SendMessageConfiguration.return_immediately`（JSON 写作 `returnImmediately`），布尔。
- **默认 `false`，即默认阻塞**：服务端 MUST 等到任务进入终态（已完成、失败、已取消、已拒绝）或中断态（需要输入、需要认证）才返回，返回里带最新状态和全部产出物。
- `true` 时 MUST 创建任务后立即返回，调用方之后用 GetTask 轮询、SubscribeToTask 订阅或推送通知。
- 这个字段对直接返回 Message、流式操作、推送配置不起作用。
- 注意：规范 3.1.1 节“行为”一段写着“The operation MUST return immediately”，与 3.2.2 节和 proto 注释矛盾。proto、3.2.2 节和官方 TCK（`CORE-EXECUTION-MODE-001`，MUST 级）都按“默认阻塞”执行，以它们为准。
- 官方 Python SDK 客户端默认 `polling=False`，即默认发 `returnImmediately=false`，等最终结果。

**2. 几种错误情况各返回什么**

| 情况 | 规范要求 | 错误 |
| --- | --- | --- |
| 向终态任务发消息 | 3.1.1 / 3.1.2 明文 | `UnsupportedOperationError`（JSON-RPC `-32004`，HTTP 400） |
| 带一个不存在的 taskId | 3.4.2：MUST 返回 | `TaskNotFoundError`（`-32001`，HTTP 404）；客户端自带 taskId 新建任务“不支持” |
| taskId 与 contextId 对不上 | 3.4.3：Agents MUST reject，**没有指定错误名** | 规范未定；官方 Python SDK 用 `InvalidParamsError`（`-32602`，HTTP 400）；TCK `CORE-MULTI-006` 只要求“返回一个错误” |
| 未知或不接受的 contextId | 3.4.1：不能接受客户端给的 contextId 时 MUST 报错，且 MUST NOT 替它新生成 | 规范未定错误名，也没有“对话不存在”错误 |
| 别人的任务或对话 | 3.3.2：MUST NOT 透露未授权资源是否存在；不应区分“不存在”和“无权” | 与“不存在”用同一个错误 |
| 同一 messageId 内容不同 | 3.3.1 只说“MAY 用 messageId 去重” | 规范没有“冲突”错误；1.1-rc 的 409 只用于 generation 不匹配，不是这个 |

**3. 历史长度与产出物**

- `historyLength`（GetTask、ListTasks、发送配置里都有）：不传 = 不限制，服务端返回默认数量（实现自定，可以是全部）；`0` = 不返回，`history` 字段 SHOULD 省略；`>0` = 最多返回最近这么多条，服务端 MAY 再压低。
- 任务历史里存哪些消息由服务端决定；建任务前的消息、临时状态消息可以不存。规范要求结果用 Artifact 返回，Message SHOULD NOT 用来交付输出（3.7 节）。
- `Artifact`：`artifactId`（必填，任务内唯一）、`name`、`description`、`parts`（必填，至少一个）、`metadata`、`extensions`。
- 流式的 `TaskArtifactUpdateEvent`：`append`（追加到同 ID 的产出物）、`lastChunk`（最后一块）。只在流式下有意义。

**4. JSON-RPC 绑定下的错误码**

- 标准码：`-32700` 解析错误，`-32600` 请求无效，`-32601` 方法不存在，`-32602` 参数无效，`-32603` 内部错误。
- A2A 专用：`-32001` TaskNotFound，`-32002` TaskNotCancelable，`-32003` PushNotificationNotSupported，`-32004` UnsupportedOperation，`-32005` ContentTypeNotSupported，`-32006` InvalidAgentResponse，`-32007` ExtendedAgentCardNotConfigured，`-32008` ExtensionSupportRequired，`-32009` VersionNotSupported（1.1-rc 加 `-32010` TaskGenerationMismatch）。
- `error.data` 是对象数组，每个对象带 `@type`（ProtoJSON `Any`），建议用 `google.rpc.ErrorInfo` / `google.rpc.BadRequest`。
- JSON-RPC 方法名用 PascalCase：`SendMessage`、`GetTask`、`ListTasks`、`CancelTask` 等（不再是 0.3 的 `message/send`）。
- HTTP+JSON 绑定的错误体是 `google.rpc.Status`，A2A 专用错误 MUST 在 `details` 里带 `ErrorInfo`，`reason` 写 `TASK_NOT_FOUND` 这种格式，`domain` 写 `a2a-protocol.org`。

## 另外查到的

- **版本请求头**：`A2A-Version` 为空时，服务端 MUST 当作 **0.3** 处理（规范 3.6.2 节）。只支持 1.0 的服务端遇到不带这个头的请求，应返回 `VersionNotSupportedError`，或者兼容 0.3。现有 `a2a.ts` 没有处理这个头。
- **兼容性测试套件（TCK）**：有，官方仓库 `a2aproject/a2a-tck`（Python，`./run_tck.py --sut-host URL`）。从名片的 `supportedInterfaces` 读出声明的绑定，三种绑定（gRPC、JSON-RPC、HTTP+JSON）都测，按 MUST / SHOULD / MAY 分级出报告。**限制**：被测方要按 Gherkin 场景实现脚本化行为（按 messageId 前缀如 `tck-complete-task` 决定怎么回），也就是说 Daisy 要做一个测试用的执行器才能跑通，不能直接拿接了真 AI 的 agent 去测。另有 `a2a-itk`（SDK 互通测试）、`a2a-inspector`（检查工具）、官方命令行客户端 `a2a-cli`（支持 JSON-RPC、REST、gRPC）。
- **官方 SDK**：Python（`a2a-sdk`，1.3.0）、JavaScript/TypeScript（`@a2a-js/sdk`，1.3.0，实现规范 1.0，可选兼容 0.3）、Go（`a2a-go`）、Java（`a2a-java`）、.NET（NuGet `A2A`）、Rust（`a2a-rs`，crate `a2a-lf`）。都在 `a2aproject` 组织下，A2A 主仓库 README 列出。
- **第三方客户端默认用哪种传输**：

| 客户端 | 默认 | 出处 |
| --- | --- | --- |
| 官方 Python SDK `ClientFactory` | **只用 JSON-RPC**（`supported_protocol_bindings` 为空时“implies JSONRPC only”）；按服务端名片顺序选 | `a2a-python/src/a2a/client/client.py`、`client_factory.py` |
| 官方 JS SDK | JSON-RPC 和 REST 都注册，按名片 `supportedInterfaces` 的顺序选第一个双方都支持的 | `a2a-js/src/client/factory.ts` |
| 官方 Go SDK | 默认注册 JSON-RPC 和 REST | `a2a-go/a2aclient/factory.go` |
| Java、.NET、Rust SDK | 未能核实 | — |

  所以**只实现 HTTP+JSON 的服务端，默认配置的 Python SDK 客户端连不上**（报 “no compatible transports found”）。0.3 时代的名片默认传输也是 JSON-RPC。
- **名片认证写法**：见 `auth-mcp-a2a.md`。

## 出处

- 规范 1.0.1：https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md ；网页版 https://a2a-protocol.org/latest/specification/
- proto（数据定义的权威来源）：https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto
- 发布记录：https://github.com/a2aproject/A2A/releases
- TCK：https://github.com/a2aproject/a2a-tck （`tck/requirements/core_operations.py`、`scenarios/core_operations.feature`）
- Python SDK：https://github.com/a2aproject/a2a-python ；JS SDK：https://github.com/a2aproject/a2a-js ；Go SDK：https://github.com/a2aproject/a2a-go
- 官方命令行客户端：https://github.com/a2aproject/a2a-cli

## 对当时设计的影响

1. **动摇设计稿“A2A 相对旧代码要改正的五处”第 3 条。** 设计稿写的是“改成立即返回任务”。规范默认是阻塞（MUST 等到终态或中断态），TCK 把它列为 MUST。正确做法：不带 `returnImmediately` 或为 `false` 时阻塞等待；只有调用方明确给 `true` 才立即返回。设计稿里“时间长的任务：立即返回一个任务，调用方之后查询”也要改成“调用方用 `returnImmediately: true` 时立即返回”。阻塞期间没有规范定义的超时错误，不能再回 504；长时间不结束只能保持连接（或者由调用方自己用 `returnImmediately`）。**需要人决定**阻塞的上限和到上限后怎么办。（已答复：不设人为上限，见 [a2a-usage.md](../contracts/a2a-usage.md) 第 11 节。）
2. **动摇“只实现 HTTP+JSON”。** 官方 Python SDK 客户端默认只说 JSON-RPC。要让“不是我们自己写的 A2A 客户端”（设计要求用它验收常驻 agent）开箱就能调用，建议 P0-04 把 **JSON-RPC 绑定也列为必做**，并把它排在名片 `supportedInterfaces` 的第一位或第二位。
3. 设计里的错误表可以落定：终态任务 → `UnsupportedOperationError`；不存在的 taskId → `TaskNotFoundError`；两个编号对不上、未知或过期或别人的 contextId → 参数无效（JSON-RPC `-32602`，HTTP 400，带 `google.rpc.BadRequest`）。三种 contextId 情况返回同一个错误，避免泄露对话是否存在。messageId 相同而内容不同，规范没有冲突错误，也建议用参数无效。
4. 要补一条：没有 `A2A-Version` 头的请求按 0.3 处理（P0-04 决定是兼容 0.3 还是返回 `VersionNotSupportedError`）。
5. 互通性验收可以用官方 TCK，但要配一个脚本化的测试执行器；另外再用一个官方 SDK 客户端（默认配置）实际调用一次。
6. 设计稿 A2A 速查里的任务状态、操作路径、错误名、扩展的启用方式与 1.0.1 一致，不用改。
