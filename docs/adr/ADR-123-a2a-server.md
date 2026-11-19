# ADR-123：A2A 服务端重建——建在调用授权之上，两种传输，三个编号，阻塞照规范，执行交给执行方

- 日期：2026-11-17
- 状态：**已实施，安全审查一轮已修（P4-04，分支 `p4-04`，基于 `p4-03`（含 `p4-01`、`p4-02`），已 merge `p4-01` 和 `p4-03` 的审查修订（ADR-122 第 8 节的最终接口）；待独立安全审查；未合入 `daisy-next`）**
- 工作包：P4-04（A2A 服务端重建）
- 相关：契约 `a2a-usage.md`、`token.md` 4.1、`trace.md`、`limits.md` 第 2 节；ADR-120（联系人、来访者）、ADR-122（调用授权，第 8 节给本包的接口）

## 背景

旧服务端的 `a2a.ts` 建在群聊上：contextId 是群的话题编号，谁在群里谁能用；把自定义扩展标成必需；默认等 25 秒后回协议之外的 504；只有 HTTP+JSON。P1-01 拿走群聊后它被移进 `_phase4/`、不编译。新设计列了要改正的五处（必需扩展改成可选；“需要输入”改为等调用方补充；阻塞照规范、不设人为上限；contextId 只给拿到它的调用方用；验证与独立 A2A 客户端的互通），并定了 HTTP+JSON 和 JSON-RPC 两种传输都提供。P4-03 已经把“谁能调用哪个 agent”重建成 `invoke/`，给本包留了 `check` / `wait` / `begin` / `canSee`（审查后的最终接口见 ADR-122 第 8 节）。

## 决定

### 1. 模块与入口

| 文件 | 内容 |
| --- | --- |
| `packages/contracts/src/a2a.ts` | A2A 1.0.1 的线上形状（ProtoJSON）：消息、部件、发送配置、任务、错误表、状态、原因、扩展 URI。P4-08 / P4-09 的客户端用同一份 |
| `packages/contracts/src/api/a2a.ts` | 定义表的新分组 `a2a`（13 条）：目录 `GET /a2a`、名片、JSON-RPC 端点、发消息、列 / 查 / 取消任务，以及按规范回“不支持”的流式、订阅、推送通知四条、扩展名片 |
| `packages/daisy/src/a2a/server.ts` | `A2AServer`：来访对话、任务、历史、`messageId`、阻塞等待、取消、过期回收、重启处理 |
| `packages/daisy/src/a2a/routes.ts` | 两种传输的外壳：HTTP+JSON（`google.rpc.Status`）和 JSON-RPC 2.0；`A2A-Version` 检查 |
| `packages/daisy/src/a2a/executors.ts` | 执行方的接口（第 5 节） |
| `packages/daisy/src/a2a/errors.ts` | 两种错误外壳 |

旧的 `_phase4/a2a.ts` 删除（基线标签上还有）。结构第 8 步：`a2a_contexts`、`a2a_tasks`、`a2a_messages`、`a2a_message_ids`，和第 3 节的 `seen_token_ids`。

**地址**：每个 agent 一个根地址 `<根>/a2a/<agentId>`（a2a-usage.md 第 2 节），名片 `…/.well-known/agent-card.json`，JSON-RPC `…/jsonrpc`，HTTP+JSON 在规范路径。`<根>` 取请求到达时的 `Host`（集中检查已按这个入口面的名字核过），所以经哪个地址来、名片上就写哪个地址；中转的地址等 P5 再接。站点根上的名片 404（没有“默认的 agent”）。路由库里字面冒号写作 `::`（`message::send`），`pathParams` / `fillPath` / 文档按字面冒号处理。取消和订阅共用 `POST …/tasks/:op`（`<taskId>:cancel` / `:subscribe`），因为路由库分不开同一参数后的两个后缀。

### 2. 只有来访者能进来

定义表加 `visitors: true`：这 13 条只对来访者（联系人的跨 Daisy 令牌、外部签发方签给别人的令牌）开放，scope `daisy:invoke`，`channels: []`。集中检查：`visitors` 的接口上主人的四个通道和 AI 一律 403 `visitors_only`，来访者没有 `daisy:invoke` 是 403 `insufficient_scope`；其余接口照旧对来访者 403 `a2a_only`。外部签发方给别人的令牌原来 scope 一律清空，现在保留 `daisy:invoke`（只这一个）。A2A 入口上的拒绝（401 / 403）按它的传输回 A2A 的错误外壳（JSON-RPC `-31401` / `-31403`），集中检查自己的 `code` 放在 `ErrorInfo.metadata.code` 里，审计照旧。表驱动的权限矩阵加了 `a2a` 一行和第 17 种身份（外部签发方给别人的、带 `daisy:invoke` 的令牌）。

认人和认范围之后，这个调用方能不能看到这个 agent 在处理函数里判断（`invoke.canSee`）：私人、不存在、不在开放范围内，一律 404，像不存在一样，不生成卡片、不留任务。查任务、列任务、取消、以及不支持的那些操作：看不到这个 agent、在它上面也没有自己的任务的，同样 404；已经有任务的（比如之后被移出了名单）还能查和取消自己的任务（设计允许调用方查询、取消自己发起的任务）。

### 3. P4-01 审查留下的两条（令牌）

- **跨 Daisy 令牌只能用一次**：联系人签的令牌，验过之后把 `jti` 按联系人记进 `seen_token_ids`，保留到 `exp` + 时钟误差（过了这个时间令牌本来就过期）；同一个再来一律 401（审计里 `invalid_token/replayed`）。记在数据库里，重启不会重新打开窗口；每分钟顺手删过期的。token.md 第 5 节本来就是“每次请求现签一张”。
- **`aud` 必须正好是这个 Daisy**：`client_id=a2a` 的令牌，`aud` 只能是这个 Daisy 的 URN 一个值，列了别人的数组一律 401。
- 两条只管联系人签的令牌；外部签发方的令牌照 P2-01（重放在那边由 5 分钟以内的有效期和签发方负责，见“留下的问题”）。现有测试里重复使用同一张联系人令牌的地方改成每次现签。

### 4. 三个编号与状态（a2a-usage.md 第 7、10 节）

- **调用方**是 `contact:<身份编号>`，或外部签发方的人——签发方加完整 `sub` 的摘要（`issuerPersonKey`，和 P4-03 审查后授权用的人的键相同）；对话和任务都属于发起的调用方，别人拿去当作不存在。
- contextId、taskId 都由 Daisy 生成（UUID）。各种情况按契约第 7 节的表：别人的、过期回收的、编造的 contextId 回同一个 `CONTEXT_NOT_FOUND`，**不替它新生成**；taskId 与 contextId 对不上回 `CONTEXT_MISMATCH`（只要 taskId 是自己的，不管 contextId 存不存在）；没发过的 taskId、别人的任务、引用不存在的任务回 `TaskNotFoundError`；向终态任务发消息回 `UnsupportedOperationError`，说明怎么接着问；向还在跑的任务追加同样回它（只有“需要输入”接受补充）。
- **重发**：`messageId` 按调用方 × agent 记，带规范化 JSON 的摘要（`parts`、`contextId`、`taskId`、`referenceTaskIds`、`metadata`；发送配置不算）。相同的返回原任务当前的样子（阻塞的照样等），不重复执行；不同的回 `MESSAGE_ID_CONFLICT`，说明里写“冲突”。记录保留到对话回收。
- 状态对应契约第 10 节。卡片待批准 = `AUTH_REQUIRED`；执行方说排队 = `SUBMITTED`；开始执行 = `WORKING`；执行方要补充 = `INPUT_REQUIRED`（问题在 `status.message`，也进 `history`，角色 `ROLE_AGENT`）；结束带原因（`status.message` 一个文本、一个 `{"data":{"reason":…}}`）。
- **结果**：`artifacts` 里 `answer`（回答，注明的事作为后面的文本部件）和 `file-<n>`；单个超过 12 MB 或合计超过 32 MB 的文件不返回，在回答里注明（limits.md 第 2 节）。思考过程和工具调用不返回。
- **历史**：任务的 `history` 是调用方的消息和 AI 的提问，`historyLength` 照规范（不给最多 100，0 不返回）。执行方拿到这段对话之前的请求和回答（最多 100 个任务）、被引用任务的请求和回答、这个任务自己的往来。
- **对话过期**：空闲 7 天（`A2A_LIMITS.contextIdleMs`）且没有未结束的任务（含等批准、等补充）就回收：删对话、任务、历史、`messageId` 记录，审计 `a2a.reclaim`。检查在每次请求时（每分钟最多一次）和 createApp 的 5 秒定时器里。

### 5. 执行交给执行方（P4-05 / P4-07 的接口）

服务端只管协议；“这个请求在这个 agent 上怎么跑”交给执行方：`ctx.a2a.executors.add((agent) => A2AExecutor | null)`，后登记的先问。`run(job)` 拿到：agent、taskId、contextId、调用方（键、人、实际操作的 AI）、`mode`（`act` 只在请求头启用了“办”扩展、且 `metadata` 里 `mode` 是 `act` 时才是，其余一律 `ask`，a2a-usage.md 8.1）、这条消息的文本和文件、`continuing`、这个任务的往来、对话历史、引用的任务、链路（trace id、深度）、`signal`（取消、撤销、重启时中止）、`queued()` / `working()`。回 `completed`（回答、注明、文件、metadata）/ `input-required`（问题）/ `rejected`（原因）/ `failed`。执行方抛错 → 失败 `EXECUTION_ERROR`，不把错误原文给调用方。

**没有执行方时**，被放行的调用置为已拒绝 `AGENT_UNAVAILABLE`。本包**不**提供默认的“在会话上跑一轮”的执行方：问与办（只读支线、主线排队、只读回落、`ACT_DISABLED`、`ASK_NOT_SUPPORTED`）是 P4-05 的，常驻 agent 的专属会话与并发是 P4-07 的；在它们之前给一个默认执行方，就等于让外来消息进主线按自动模式跑，和“不带标记一律按问”的安全默认冲突。P4-06 之前所有会话都是私人 agent，本来也调用不到。agent 目录（`GET /a2a`）的编号来自 `ctx.a2a.directory.add(() => ids)`（P4-06 / P4-07 登记），每个只列给 `canSee` 的人。

### 6. 调用授权接在哪里（ADR-122 第 8 节）

新任务：先查链路（深度超过 8 → 已拒绝 `TRACE_DEPTH_EXCEEDED`；同一链路号在这里超过 64 次 → `TRACE_CALLS_EXCEEDED`；深度和链路号取 `metadata` 里链路扩展的，没有就用请求的 `traceparent`、深度 1），再按 ADR-122 第 8 节的最终接口：

- `d = invoke.check(p, agentId)`（同步）。拒绝 → 已拒绝，原因和说明：`rejected_recently` → `OWNER_REJECTED`；`too_many_waiting`（这个人等批准的调用太多）、`too_many_requests`（这个 agent 待批准的卡片太多）→ `QUOTA_EXCEEDED`；`not_recognised` / `agent_unknown` / `not_listed`（`canSee` 刚放行过，只能是竞态）→ `AGENT_UNAVAILABLE`。
- 待批准 → `AUTH_REQUIRED`，阻塞的发消息在这里返回；`await invoke.wait(d, signal)`（传整个 `d`，要它的 `ticket`）：批准 → 开始执行；拒绝 `OWNER_REJECTED`、过期 `APPROVAL_EXPIRED`、作废 `APPROVAL_CANCELED`（本包加的原因：卡片因对方移出范围、重置 PIN 等作废）。“仅本次”只放行发起卡片的那一次调用，别的调用由 P4-03 挪到新卡片上继续等，任务保持 `AUTH_REQUIRED`。调用方取消时这次调用离开卡片（`inv.withdraw`），卡片上没有别的调用在等就关掉（审查 L-4）；重启或连接断开只是放弃等待，卡片留给主人。
- 放行（直接放行，或 `wait` 放行之后）→ **开始执行的那一刻**是一次同步的 `invoke.begin(p, agentId, { ticket?, stop })`：它在一个事务里重新核对“现在能不能开始”并登记这次调用，前后不跨 await，本包也不自己保存“已放行”；它拒绝（`InvokeError` 403 `not_admitted`，许可在决定和开始之间被收回）→ 已拒绝 `GRANT_REVOKED`，执行方不会被调用。`via` 由它自己判断，本包从登记处读来记在任务上。
- `stop(why)`（撤销授权、收窄范围、移出白名单、移除联系人、签发方变了、agent 没了、重置 PIN）→ 中止执行方、任务置为已拒绝 `GRANT_REVOKED`，说明里带 `why.message`。登记一直保持到任务结束——“需要输入”期间也算进行中的调用，撤销同样停掉它。

撤销的 `stop` 是在别人的事务里同步调用的：本包当场中止执行方，任务的写入挪到事务之后（`setImmediate`），不和那个事务一起回滚。

### 7. 等不等（照规范阻塞）与重启（不重放）

- 不带 `returnImmediately: true`：扣着连接，等到终态或中断态（需要输入、需要认证）再回，**不设时间上限**；调用方断开只是不再等，任务照常。连接数有上限（审查 M-2）：每个调用方 × 任务一个、每个调用方 8 个。带了就立即回任务。等待是按任务的状态变化通知，不轮询。
- 进程要关闭（重启、更新、`app.close`）：在跑的、排队的、等批准的任务置为失败 `INTERRUPTED`，扣着的连接带着它返回，不再接新请求（503 `UNAVAILABLE`）。
- 启动时：上一个进程留下的排队、在跑、等批准的任务置为失败 `INTERRUPTED`（`wait` 在内存里，卡片照旧留给主人）。**等调用方补充的任务不受影响**：调用方之后回复时，因为登记已经不在，重新过一次调用授权（白名单 / 授权直接继续；原来靠“仅本次”进来的要重新批准）。

### 8. 传输与版本（a2a-usage.md 第 3、9 节）

- 名片 `supportedInterfaces`：JSON-RPC 在前、HTTP+JSON 在后；`capabilities.streaming` / `pushNotifications` / `extendedAgentCard` 都是 false；两个扩展都 `required: false`；认证 `bearer`（`httpAuthSecurityScheme`），名片本身也要令牌。“办”扩展的 `params`（是否接受办、只读强度）由 P4-05 / P4-06 按 agent 填，本包不写。
- 除了名片和目录，每个操作都要 `A2A-Version: 1.0`（或 `1.0.x`）；没带或别的版本回 `VersionNotSupportedError`（契约的选择）。官方 JS SDK 1.3.0 默认带这个头（互通测试证实）。
- 请求体在这个分组里一律按文本收，自己解析：不是 JSON 是 `-32700`，JSON-RPC 外壳不对（含批量）是 `-32600`，方法不存在 `-32601`。**JSON-RPC 的错误用 HTTP 200 回**（JSON-RPC over HTTP 的惯例，官方 SDK 两种都认），例外：认证、无权（集中检查，401 / 403）、看不到的 agent（404，不进 JSON-RPC 处理）、关闭中（503）、内部错误（500）。契约第 9.1 节的“HTTP 状态”一列按 HTTP+JSON 读。
- 流式、订阅 → `UnsupportedOperationError`；推送通知四个操作和发送配置里的 `taskPushNotificationConfig` → `PushNotificationNotSupportedError`；扩展名片 → `ExtendedAgentCardNotConfiguredError`；`acceptedOutputModes` 里没有 `text/plain`（或 `text/*`、`*/*`）→ `ContentTypeNotSupportedError`；`url` 部件、部件太多、`messageId` 长度不对等 → 参数无效，`google.rpc.BadRequest` 指出字段。

## 安全审查（一轮，没有 High）修订

| 编号 | 问题 | 修法 |
| --- | --- | --- |
| M-1 | 看得到 agent 的来访者能把磁盘写满：任务、整条消息（含 metadata 和文件字节）、`messageId` 在授权之前就存下 | `metadata`（消息的、每个部件的）转成 JSON 最多 16 KB；调用开始（`begin` 成功）之前只存存根（2000 字文本、文件名和大小，不存字节和 metadata），整条消息放在内存里，开始时才写进库；任何写入之前先查每个调用方的上限：一个 agent 上没结束的任务 16、对话 50、存放的字节 64 MB（库里加内存里等着的）、每分钟 60 条，超过回新错误 `RESOURCE_EXHAUSTED`（429，JSON-RPC `-31429`，带 `Retry-After`），什么都不存 |
| M-2 | 阻塞发消息不限连接：同一 `messageId` 重发 41 次就扣 41 个连接；`notify` 每个等待者都重查一次 | 每个调用方 × 任务只扣一个连接（新的接替，旧的立即带当前状态返回）；每个调用方最多同时扣 8 个，再多回 `UNAVAILABLE`（503 + `Retry-After`）、新任务不建——选了拒绝而不是悄悄当作立即返回，因为规范对不带 `returnImmediately` 的请求要求阻塞；等待者按 `setState` 刚写的状态判断，不再查库；对外面的监听 `maxConnections` 1024、每个连接 TCP keep-alive 60 秒（`FACE_LIMITS`） |
| L-1 | 外部签发方给主人自己的 `sub` 带 `act` 的令牌成了来访者、保留了 `daisy:invoke` | 这种令牌在 A2A 入口上 scope 为空（403）：替主人干活的 AI 不是主人 agent 的调用方，和 AI 工作凭据得到 `visitors_only` 一致（token.md 4.2 第 5 步） |
| L-2 | “需要输入”的任务永不过期；“仅本次”放行后可以无限续写 | 空闲 24 小时置为失败 `INPUT_EXPIRED`、调用结束；一个任务里调用方的消息最多 16 条（超过 429）；靠“仅本次”进来的调用，续写时重新过 `check`（通常是一张新卡片） |
| L-3 | 撤销和续写赛跑：`stopped()` 把已拒绝推迟到 `setImmediate`，其间到达的续写会在被撤销的调用上执行 | 续写时调用已在停止中就拒绝（`UnsupportedOperationError`）；`finish()` 在执行方或等待还在进行时中止它们 |
| L-4 | 取消等批准的任务没有从卡片上撤下 | P4-03 模块加最小接口 `inv.withdraw(ticket)`：离开卡片，没有别的调用在等就关掉卡片（`canceled`，通知和事件随之了结）；重启或连接断开放弃等待时卡片照旧留给主人 |
| L-5 | 很深的 JSON → 500 | `metadata`、`data` 嵌套最多 32 层（迭代计算，不递归）；`RangeError` 也映射为参数无效 |
| L-6 | 请求体上限和文件上限对不上，超限是本机接口的 413 | A2A 路由自己的请求体上限 16 MB + 64 KB（一个 12 MB 文件按 base64 正好放得下，全部文件合计受它约束），超过回 A2A 外壳的 413 `PAYLOAD_TOO_LARGE`（JSON-RPC `-31413`） |
| L-7 | 准备任务出错时把 `e.message` 给了调用方 | 只给通用说明，细节进日志 |
| L-8 | 链路深度和链路号由调用方自报 | 写明是守约的机制、不是防线；次数按调用方 × 链路号数（trace.md 第 7 节） |

每一条都有在不修时会失败的测试（做过逐条变异验证）。接口变化：`A2AJob`、`A2AExecutor`、`executors` / `directory` 不变；`A2A_LIMITS` 加项、新 `FACE_LIMITS`；任务原因加 `INPUT_EXPIRED`；协议错误加 `RESOURCE_EXHAUSTED`、`PAYLOAD_TOO_LARGE`；`InvokeAccess.withdraw(ticket)`（新）；`Faces.externalServer`（测试用）。

## 测试

- `tests/a2a-server.test.ts`（30 条，含审查修订的 9 条，真实监听，两种传输，先写被拒绝的）：没令牌 / 陌生人 / 重放的令牌 / `aud` 列了别人 → 401，没 `daisy:invoke` → 403，主人的命令行、网页、AI → 403 `visitors_only`，来访者到本机接口 → `a2a_only`，什么都没留下；T-3：私人、只对指定人、不存在的 agent 在每个操作上都 404，目录只列看得到的；名片；`A2A-Version`；**A-14**（别人的、编造的、回收的 contextId，不生成新的；有未结束任务的对话不回收）；**A-15**；**A-16**（含运行中重发、按调用方区分）；**A-6**（含历史和引用交给执行方）；**A-5**（两种传输）；阻塞不返回（照规范）、立即返回、取消、不可取消、别人取消不了、列任务分页；T-1 经 A2A（`AUTH_REQUIRED`、永久通过后完成、拒绝、冷却、等批准时取消）；**T-5 经 A2A**；P4-03 最终接口经 A2A（“仅本次”只放行发起的那次、另一次留在新卡片上 `AUTH_REQUIRED`；等批准太多 → `QUOTA_EXCEEDED`；`begin` 拒绝 → 已拒绝、执行方没被调用）；重启（扣着的连接拿到 `INTERRUPTED`；崩溃留下的 `AUTH_REQUIRED` 下次启动置为失败；“需要输入”的任务重启后继续完成）；不支持的操作和坏请求的错误码；办的判定、文件进出、执行方出错不泄露、链路深度；没有执行方；定义表；外部签发方给别人的令牌；**官方 `@a2a-js/sdk` 1.3.0 客户端**（不是我们写的）经 JSON-RPC 和 HTTP+JSON 各跑一遍：读名片、发消息（阻塞）、查、列、需要输入后续写、立即返回后取消、`TaskNotFoundError`。
- 表驱动权限矩阵：140 条接口 + 7 个探针 × 17 种身份；`api-defs`：`/a2a` 路径、只有 `a2a` 分组是 `visitors`、注册核对含 `/a2a`；`contacts.test.ts` 加重放和 `aud` 数组两条；`invoke-access.test.ts`、`contacts.test.ts` 里重复用同一张联系人令牌的地方改成每次现签。

## 待维护者确认（先照推荐做）

1. **没有 `A2A-Version` 回 `VersionNotSupportedError`**（契约的选择，不兼容 0.3）。官方 JS SDK 默认带；Python SDK 没实测（仓库里没有 Python 依赖）。
2. **JSON-RPC 的错误用 HTTP 200**（第 8 节），契约 9.1 的 HTTP 状态一列按 HTTP+JSON 读。
3. **加了一个原因 `APPROVAL_CANCELED`**（卡片作废）。
4. **名片地址取请求的 `Host`**，不取身份名片的 `addrs`（中转在 P5 接）。官方 JS SDK 解析名片地址时要给根地址**加结尾的 `/`**（`new URL(".well-known/…", base)`），契约第 2 节“传 `<base>` 即可”要补这一句。
5. **对话过期 7 天暂无配置项**（limits.md 写“可调”）。

## 留下的问题

- P4-05：登记公开 agent 的执行方（问 / 办、`ACT_DISABLED`、`ASK_NOT_SUPPORTED`、只读回落的注明和结果 `metadata`），给名片的“办”扩展填 `params`。
- P4-06：公开会话的 agent 解析器（`invoke.agents.add`）和目录（`a2a.directory.add`）；外来任务标明来源用 `job.caller` / `job.taskId`，工具动作的审计用 `job.trace` 和 taskId。
- P4-07：常驻 agent 的解析器、目录、执行方（每个 contextId 一个会话；超过并发 `job.queued()`；暂停 `AGENT_PAUSED`）；对话回收时关专属会话需要一个回收钩子（本包回收时只删自己的表，P4-07 要的话加 `onReclaim`）。
- P4-08：作为调用方的那一半；“本机发出的”调用也要计入同一链路号的 64 次（本包只数收到的）。契约类型在 `contracts/src/a2a.ts`。
- 外部签发方令牌的重放没有本机缓存。每个调用方的上限（审查 M-1）还没有配置项。
- 数据库第 8 步与并行的包可能撞号，合并时顺延。只在 macOS 本机验证。
