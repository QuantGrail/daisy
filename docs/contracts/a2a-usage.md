# A2A 用法契约

版本：0.1　状态：草稿，待维护者评审
修订：0.1（2026-11-16）初稿。 0.1.1（2026-11-17，ADR-123）按实现补几处：第 2 节官方 JS SDK 解析名片时根地址要带结尾的 `/`，名片地址取请求到达的地址；第 9.1 节 HTTP 状态一列按 HTTP+JSON 读，JSON-RPC 的错误用 HTTP 200（认证、无权、看不到的 agent、关闭中、内部错误除外），A2A 入口上集中检查的拒绝也是 A2A 的错误外壳；第 9.2 节加原因 `APPROVAL_CANCELED`（卡片作废）。 0.1.2（2026-11-17，P4-04 安全审查）第 5 节取消等批准的任务撤回卡片；第 9 节加 `RESOURCE_EXHAUSTED`（429）、`PAYLOAD_TOO_LARGE`（413）、`INPUT_EXPIRED`；第 11 节扣着的连接的上限；第 12 节等补充的期限。 0.1.3（2026-11-17，ADR-127）第 15 节按实现补：三个工具的名字、令牌 120 秒、名片接口必须与联系人地址同源、出站连接的规则（SSRF）、自签证书首次信任、`Retry-After` 的处理、唤醒的链路与深度。 0.1.4（2026-11-17，ADR-128）第 15 节补独立 A2A MCP 作为调用方的不同之处。 0.1.5（2026-11-18，P5-02，ADR-144）加第 15.1 节 TLS 绑定声明（ADR-100：路径、字段、校验顺序；经中转调用时 Daisy 客户端在发令牌之前必须核对）；第 2 节中转地址。

依据：A2A 1.0.1 规范（数据定义以 `a2a.proto` 为准）；维护者的决定（三种 agent；别人调用公开 agent 默认“问”、带标记才“办”；contextId、taskId、messageId 各只有一个意思；被调用时 Daisy 是 A2A 服务端，调用别人时 harness 经 Daisy 提供的 MCP 工具作为客户端；照规范阻塞等结果；两种传输都提供；弱只读也接受“问”并如实写明）；设计里的三种 agent、互认与调用授权、问与办、A2A 的任务、细分权限；P4-04 到 P4-09；`docs/research/a2a-spec.md`、`docs/research/auth-mcp-a2a.md`。
读者：实现 Daisy A2A 服务端和客户端的人；要照着接 Daisy 的外部“任务与聊天”系统；任何第三方 A2A 客户端。第 16 节是给任务与聊天的接入步骤。

规范没有写死、本文自己做了选择的地方，都标了“【本契约的选择】”并写了理由。

---

## 1. 一句话

每个可被调用的 agent（公开 agent、常驻 agent）是一个独立的 A2A 服务端，有自己的地址和 agent 名片。支持发消息、查任务、列任务、取消任务四个操作，两种传输都提供。不带“办”标记的调用一律按“问”处理。

## 2. 地址

| 东西 | 地址 |
| --- | --- |
| agent 的根地址 `<base>` | `<Daisy 根地址>/a2a/<agentId>`。Daisy 根地址取自身份名片的 `addrs`（直连或中转；中转地址是 `https://<身份编号前 32 个字符>.<中转域名>[:端口]`，经它进来的请求只进对外面，P5-02） |
| agent 名片 | `GET <base>/.well-known/agent-card.json` |
| JSON-RPC 端点 | `POST <base>/jsonrpc` |
| HTTP+JSON 端点 | `<base>` 下的规范路径（第 5 节） |
| Daisy 的 agent 目录（不是 A2A 的一部分） | `GET <Daisy 根地址>/a2a`，返回调用方能看到的 agent 名片地址列表：`{"agents":[{"agentId":…,"name":…,"card":"<名片地址>"}]}` |

- `agentId` 是不透明字符串，公开 agent 用会话编号，常驻 agent 用它的配置编号。重启不变。
- `<Daisy 根地址>/.well-known/agent-card.json`（站点根上的名片）返回 404：一个 Daisy 上可能有很多 agent，没有“默认的那一个”。官方 SDK 的名片解析器都接受一个根地址参数，传 `<base>` 即可。
- 名片上的地址取请求到达时的地址（`Host`）。官方 JS SDK 的名片解析器按 `new URL(".well-known/agent-card.json", base)` 拼地址，所以传 `<base>/`（带结尾的斜杠）（P4-04 实测）。
- 目录是给 Daisy 自己的“发现智能体”工具用的。第三方客户端不需要它，拿到某个 agent 的 `<base>` 就能用。
- 这些地址都在“对外面”上（两个入口面的划分依 P0-05 第 3 项）。

## 3. 传输与版本

**两种传输都提供，名片里都声明：**

```json
"supportedInterfaces": [
  { "url": "<base>/jsonrpc", "protocolBinding": "JSONRPC",   "protocolVersion": "1.0" },
  { "url": "<base>",         "protocolBinding": "HTTP+JSON", "protocolVersion": "1.0" }
]
```

- 【本契约的选择】JSON-RPC 排第一。理由：官方 Python SDK 客户端默认只说 JSON-RPC，JS、Go SDK 按名片顺序取第一个双方都支持的；排第一能让最多的客户端开箱即用（research/a2a-spec.md）。
- JSON-RPC：`Content-Type: application/json`，方法名 `SendMessage`、`GetTask`、`ListTasks`、`CancelTask`（1.0 的写法，不是 0.3 的 `message/send`）。
- HTTP+JSON：请求和响应用 `application/a2a+json`（1.0.1 的 SHOULD），请求也接受 `application/json`。错误体是 `google.rpc.Status`（第 9 节）。
- 两种传输行为完全一样，只有外壳不同。下文说到“返回某某错误”时，两种写法见第 9 节的表。

**`A2A-Version` 请求头**

- 只支持 A2A **1.0**。只比较“主.次”，忽略修订号（规范 3.6.2）。
- `A2A-Version: 1.0` 或 `1.0.x`：正常处理。
- **没带这个头或为空**：规范要求按 0.3 处理（MUST）。【本契约的选择】Daisy 不实现 0.3，所以回 `VersionNotSupportedError`，说明里写“这个 agent 只支持 A2A 1.0：请在请求头里带 `A2A-Version: 1.0`，或升级客户端”。理由：规范同时要求客户端每个请求都带这个头（MUST），而 0.3 的方法名、字段名、状态名与 1.0 不同，“猜它其实是 1.0”会在边角上出错。这一条依赖“官方 SDK 默认会带这个头”，P4-04 用官方 Python SDK 实测；维护者已确认这样做（只支持 1.0，没带这个头回不支持）。
- `A2A-Version: 0.3` 或别的版本：同样回 `VersionNotSupportedError`。
- 读名片（`GET …/agent-card.json`）不是操作，不检查这个头。

**`A2A-Extensions` 请求头**：客户端列出它启用的扩展 URI，逗号分隔（第 8 节）。Daisy 在响应里用同名响应头回显实际生效的扩展（规范没强制，方便客户端确认）。

## 4. 认证：名片里的 `securitySchemes`

每个请求都要带 `Authorization: Bearer <令牌>`，包括读名片。令牌格式见 token.md。按 proto 的写法（`securitySchemes` + `securityRequirements`，每项 `schemes` 下用 `list`）：

**只有独立模式（默认）**

```json
"securitySchemes": {
  "bearer": {
    "httpAuthSecurityScheme": {
      "scheme": "Bearer",
      "bearerFormat": "JWT",
      "description": "互认过的 Daisy 自动签发；第三方客户端请让这个 agent 的主人用 `daisy token issue` 为你签一张。"
    }
  }
},
"securityRequirements": [ { "schemes": { "bearer": { "list": [] } } } ]
```

**配置了外部签发方时，再加一种，两者任选其一**

```json
"securitySchemes": {
  "bearer": { "httpAuthSecurityScheme": { "scheme": "Bearer", "bearerFormat": "JWT", "description": "…" } },
  "issuer": {
    "oauth2SecurityScheme": {
      "oauth2MetadataUrl": "<外部签发方的 RFC 8414 元数据地址>",
      "flows": { "clientCredentials": { "tokenUrl": "<令牌端点>", "scopes": { "daisy:invoke": "调用这个 agent" } } }
    }
  }
},
"securityRequirements": [
  { "schemes": { "bearer": { "list": [] } } },
  { "schemes": { "issuer": { "list": ["daisy:invoke"] } } }
]
```

`securityRequirements` 多项之间是“或”（沿用 OpenAPI 的语义，规范未明写）。

**名片本身也要认证。** 只有互认过、并在这个 agent 开放范围内的人能读到名片，其他人一律 404，不透露这个 agent 存在。第三方客户端取名片时也要带令牌（官方 SDK 的名片解析器都能配置请求头）。规范没有禁止名片要认证，但这一点影响第三方客户端的“发现”。

## 5. 操作

| 操作 | JSON-RPC 方法 | HTTP+JSON | 支持 |
| --- | --- | --- | --- |
| 发消息 | `SendMessage` | `POST <base>/message:send` | 是 |
| 查任务 | `GetTask` | `GET <base>/tasks/{id}` | 是 |
| 列任务 | `ListTasks` | `GET <base>/tasks` | 是 |
| 取消任务 | `CancelTask` | `POST <base>/tasks/{id}:cancel` | 是 |
| 流式发消息 | `SendStreamingMessage` | `POST <base>/message:stream` | 否，回 `UnsupportedOperationError`（规范 3.3.4 的 MUST） |
| 订阅任务 | `SubscribeToTask` | `POST <base>/tasks/{id}:subscribe` | 否，同上 |
| 推送通知配置（四个） | `…TaskPushNotificationConfig…` | `<base>/tasks/{id}/pushNotificationConfigs…` | 否，回 `PushNotificationNotSupportedError` |
| 扩展名片 | `GetExtendedAgentCard` | `GET <base>/extendedAgentCard` | 否，回 `ExtendedAgentCardNotConfiguredError` |

名片里如实声明：`"capabilities": { "streaming": false, "pushNotifications": false, "extendedAgentCard": false, … }`。

【本契约的选择】不提供扩展名片。理由：普通名片本来就只给认证过的人看，扩展名片没有可以多放的东西。

**列任务**：只列这个调用方在这个 agent 上发起的任务。支持 `contextId`、`status`、`pageSize`（默认 50，最多 100）、`pageToken`（不透明字符串）、`historyLength`、`statusTimestampAfter`、`includeArtifacts`（默认 false）。

**取消任务**：只能取消自己发起的。还在排队的直接撤掉；正在跑的停下；等主人批准的（需要认证）撤回卡片（这次调用离开卡片，卡片上没有别的调用在等了就关掉，`invoke.withdraw`）；需要输入的直接取消。已经产生的副作用不回滚。终态任务回 `TaskNotCancelableError`。

## 6. 消息、结果、历史

**调用方发来的消息**

| 字段 | 规则 |
| --- | --- |
| `messageId` | 必填，8–100 字符，调用方生成，在这个调用方和这个 agent 之间唯一 |
| `role` | `ROLE_USER` |
| `parts` | 1–16 个。接受 `text`、`data`（JSON，交给 AI 时转成文本）、`raw`（文件字节，附 `filename`、`mediaType`）。**不接受 `url`**：Daisy 不替调用方去取网络上的东西，回参数无效 |
| `contextId`、`taskId`、`referenceTaskIds` | 见第 7 节 |
| `metadata` | 可以带“办”和链路两个扩展的数据（第 8 节）；别的键忽略 |
| `extensions` | 消息用到的扩展 URI 列表，与 `metadata` 里的键对应 |

大小上限见 limits.md。

**发送配置**：`returnImmediately` 见第 11 节；`historyLength` 照规范；`acceptedOutputModes` 里没有 `text/plain` 时回 `ContentTypeNotSupportedError`（回答总是文本）；带 `taskPushNotificationConfig` 时回 `PushNotificationNotSupportedError`。

**结果（任务的 `artifacts`）**：只返回这一轮的最终回答和它产出的文件，不返回思考过程和工具调用。

| 产出物 | `artifactId` | `parts` |
| --- | --- | --- |
| 回答 | `answer` | 一个 `text`。需要注明的事（比如“问”回落到主线排队）作为第二个 `text` |
| 每个文件 | `file-<序号>` | 一个 `raw`，带 `filename`、`mediaType` |

**任务的 `history`**：这个任务里来往的消息：调用方发的消息、AI 要求补充信息时问的话（角色 `ROLE_AGENT`）。最终回答在 `artifacts` 里，不在 `history` 里（规范 3.7：结果用产出物返回）。不传 `historyLength` 时返回这个任务的全部消息，最多 100 条。

**任务的 `status.message`**：需要输入时是 AI 的问题；已拒绝、失败时是原因（第 9.2 节）。

## 7. 三个编号

| 编号 | 意思 | 谁生成 |
| --- | --- | --- |
| `contextId` | 一段来访对话：**一个调用方**和**一个 agent** 之间的一段连续往来 | Daisy，第一条不带 `contextId` 的消息到达时 |
| `taskId` | 这段对话里一次请求的执行，就是一轮 | Daisy，每个新任务一个 |
| `messageId` | 调用方给这条消息起的编号，用来识别重发 | 调用方 |

**“调用方”是谁。** 令牌的签发方加主体，即 `(iss, sub)`：一个人（token.md）。同一个人名下不同的 AI 是同一个调用方；实际操作的 AI（`act.sub`）记进审计，不参与编号的归属判断。`contextId` 和 `taskId` 都属于发起它的那个调用方，别人拿去用一律当作不存在。

**全部场景**

| 场景 | 调用方发什么 | Daisy 做什么 | 出错时回 |
| --- | --- | --- | --- |
| 开始一段新对话 | 不带 `contextId`，不带 `taskId` | 生成新的 `contextId` 和 `taskId`，都放在返回的任务里 | — |
| 同一段对话里再提一个请求 | 带 `contextId`，不带 `taskId` | 生成新的 `taskId`。执行时带上这段对话之前的历史（调用方发来的消息和 agent 的回答） | `contextId` 不认得：`CONTEXT_NOT_FOUND`（见下） |
| 提到之前的某个任务 | 同上，`referenceTaskIds` 里写那个 `taskId` | 把被引用任务的请求和回答一并交给 AI | 引用的任务不存在或不属于这个调用方：`TaskNotFoundError` |
| AI 要调用方补充信息 | Daisy 先把任务置为“需要输入”，问题在 `status.message`。调用方带同一个 `taskId`（和 `contextId`）回一条消息 | 同一个任务继续执行，`taskId` 不变 | — |
| 向已经结束的任务发消息 | 带一个已完成、失败、已取消或已拒绝的 `taskId` | 不执行 | `UnsupportedOperationError`（规范 3.1.1 明文）。说明里写“任务已结束；要接着问，请不带 taskId、带同一个 contextId 另发” |
| 向还在跑的任务追加 | 带一个已提交、工作中或需要认证状态的 `taskId` | 不执行 | 【本契约的选择】`UnsupportedOperationError`，说明“任务还在执行，只有进入‘需要输入’时才接受补充”。理由：设计只定义了“需要输入”时的续写；运行中追加要打断 harness，不在这一版 |
| 为新任务自带 `taskId` | 带一个 Daisy 没发过的 `taskId` | 不执行 | `TaskNotFoundError`（规范 3.4.2） |
| 两个编号对不上 | `taskId` 不属于这个 `contextId` | 不执行 | `CONTEXT_MISMATCH`（见下） |
| 用别人的或过期的 `contextId` | `contextId` 不是发给这个调用方的、已被回收的、或从没存在过 | 不执行，**不替它新生成一个**（规范 3.4.1） | `CONTEXT_NOT_FOUND`（见下）。三种情况回同一个错误 |
| 只带 `taskId` | 带 `taskId`，不带 `contextId` | 从任务推出它所属的 `contextId` | 同上面各行 |
| 重发 | 同一个 `messageId`、同样的内容 | 返回原来那个任务的当前状态，不重复执行。任务在什么状态都一样 | — |
| `messageId` 撞了 | 同一个 `messageId`、不同的内容 | 不执行 | `MESSAGE_ID_CONFLICT`（见下） |
| 查询和取消 | 按 `taskId` | 只能操作自己发起的任务 | 别人的任务：`TaskNotFoundError`（规范 3.3.2：不区分“不存在”和“无权”） |
| 对话过期 | — | 空闲超过 7 天回收（第 12 节） | 之后再用：`CONTEXT_NOT_FOUND` |

**“同样的内容”怎么判断。** 只比较消息本身：`parts`、`contextId`、`taskId`、`referenceTaskIds`、`metadata`（按规范化的 JSON 算摘要）。发送配置（`returnImmediately`、`historyLength`）不算：重发时从阻塞换成立即返回是正常的。`messageId` 的记录保存到它所在的对话被回收为止。

**规范没指定错误的三种情况【本契约的选择】**

| 情况 | 选择 | 理由 |
| --- | --- | --- |
| `taskId` 与 `contextId` 对不上 | 参数无效：JSON-RPC `-32602`，HTTP 400，`google.rpc.BadRequest` 指出 `message.contextId`，`ErrorInfo.reason` 为 `CONTEXT_MISMATCH` | 规范只说必须拒绝；官方 Python SDK 就用参数无效；TCK 只要求“返回一个错误”。只要 `taskId` 是这个调用方的，不管给的 `contextId` 是否存在都回这个，不泄露别人的对话 |
| 未知、过期、别人的 `contextId` | 参数无效：`-32602`，HTTP 400，`reason` 为 `CONTEXT_NOT_FOUND` | 规范没有“对话不存在”错误。不用 `TaskNotFoundError`，因为它说的是任务，调用方会误以为 `taskId` 错了。三种情况回同一个，满足规范 3.3.2 不泄露存在性 |
| 同一 `messageId` 内容不同 | 参数无效：`-32602`，HTTP 400，`reason` 为 `MESSAGE_ID_CONFLICT` | 规范没有冲突错误；1.1-rc 的 409 专用于另一件事。HTTP 409 在 JSON-RPC 里没有对应，两种传输就会不一致。`reason` 里写明“冲突”，满足设计里“内容不同则报冲突” |

## 8. 扩展：“办”和链路

两个扩展都是**可选**的（`required: false`），不认识它们的客户端照常使用（设计要求：对 A2A 只用可选扩展，不设必需扩展）。扩展的数据放在消息 `metadata` 里，以扩展 URI 为键；消息的 `extensions` 列出用到的 URI；请求头 `A2A-Extensions` 列出启用的 URI（规范的写法）。

URI 如下（维护者的决定：继续用 `quantgrail.github.io`，组织级的 Pages 地址，不随仓库改名变；不带产品名，带版本号；改成不兼容时换新 URI，规范的 MUST）：

| 扩展 | URI |
| --- | --- |
| 办 | `https://quantgrail.github.io/a2a-ext/act/v1` |
| 链路 | `https://quantgrail.github.io/a2a-ext/trace/v1`（字段见 trace.md 第 4 节） |

### 8.1 “办”

**请求里**

```json
"message": {
  "messageId": "…",
  "role": "ROLE_USER",
  "parts": [ { "text": "把 README 里的安装步骤更新一下" } ],
  "extensions": [ "https://quantgrail.github.io/a2a-ext/act/v1" ],
  "metadata": {
    "https://quantgrail.github.io/a2a-ext/act/v1": { "mode": "act" }
  }
}
```

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `mode` | `"act"` 或 `"ask"` | `act` 是办，`ask` 是问。只有这一个字段 |

**判定规则**

- 只有同时满足两条才算“办”：`A2A-Extensions` 请求头里有这个 URI；`metadata` 里这个键的 `mode` 是 `"act"`。其余一切情况（不带、带了但没在请求头启用、`mode` 是别的值）都按“问”（设计要求：不带标记的一律是问，这是安全的默认）。
- 这个 agent 关掉了“办”，或它是常驻 agent（常驻 agent 不分问和办）：
  - 公开 agent 关了办：带办标记的调用置为已拒绝，原因 `ACT_DISABLED`。问仍然可用。
  - 常驻 agent：忽略这个标记，按它自己的配置执行。
- 同一个 `contextId` 里可以先问后办，`contextId` 不变。

**结果里**：任务的 `metadata` 用同一个键回报这一轮实际怎么跑的（第三方客户端可以不看）：

```json
"metadata": {
  "https://quantgrail.github.io/a2a-ext/act/v1": {
    "mode": "ask",
    "readOnly": "weak",
    "ranOn": "main-queue"
  }
}
```

| 字段 | 取值 |
| --- | --- |
| `mode` | 实际按什么执行：`ask`、`act`、`resident`（常驻 agent） |
| `readOnly` | 只在 `mode` 为 `ask` 时有：`strong`（工具层或沙箱层挡住写操作）、`weak`（只靠 harness 的 plan 一类模式，第 13 节） |
| `ranOn` | 只在 `mode` 为 `ask` 时有：`branch`（只读支线）、`main-queue`（harness 不支持旁问和分叉，回落到主线排队） |

**名片里**

```json
{
  "uri": "https://quantgrail.github.io/a2a-ext/act/v1",
  "required": false,
  "description": "可选。消息 metadata 里以本 URI 为键写 {\"mode\":\"act\"}，并在 A2A-Extensions 请求头里启用，表示请这个 AI 在主线上动手办事；不带时一律只读地回答（问）。",
  "params": { "act": true, "readOnly": "weak" }
}
```

`params.act`：这个 agent 现在是否接受办。`params.readOnly`：“问”的只读强度，`strong`、`weak`，或 `none`（这个 agent 不接受问，只能办）。

### 8.2 链路

见 trace.md。名片里同样声明为 `required: false`，`params` 写上限：`{ "maxDepth": 8 }`。

## 9. 错误

### 9.1 协议错误（请求被拒，不产生任务）

`ErrorInfo` 的 `domain`：A2A 规范定义的错误写 `a2a-protocol.org`；本契约自己定义的 `reason` 写扩展的主机名 `quantgrail.github.io`（随第 8 节的 URI 一起定）。

| 情况 | JSON-RPC `error.code` | HTTP 状态 | `reason` |
| --- | --- | --- | --- |
| 没带令牌、令牌无效、过期、不是发给我的、签发方不认得（含陌生人） | 【本契约的选择】`-31401`（随 HTTP 401） | 401，带 `WWW-Authenticate: Bearer error="invalid_token"` | `UNAUTHENTICATED` |
| 令牌有效但 scope 没有 `daisy:invoke` | 【本契约的选择】`-31403`（随 HTTP 403） | 403，带 `error="insufficient_scope", scope="daisy:invoke"` | `PERMISSION_DENIED` |
| agent 不存在、已删除、是私人 agent、调用方不在开放范围内 | 不进入 JSON-RPC 处理 | 404 | — |
| 请求体不是合法 JSON | `-32700` | 400 | — |
| JSON-RPC 请求格式不对 | `-32600` | 400 | — |
| 方法不存在 | `-32601` | 404（HTTP+JSON 是路径不存在） | — |
| 没带 `A2A-Version`，或版本不是 1.0 | `-32009` `VersionNotSupportedError` | 400 | `VERSION_NOT_SUPPORTED` |
| 流式发消息、订阅任务、运行中追加、向终态任务发消息 | `-32004` `UnsupportedOperationError` | 400 | `UNSUPPORTED_OPERATION` |
| 推送通知相关 | `-32003` `PushNotificationNotSupportedError` | 400 | `PUSH_NOTIFICATION_NOT_SUPPORTED` |
| 扩展名片 | `-32007` `ExtendedAgentCardNotConfiguredError` | 400 | `EXTENDED_AGENT_CARD_NOT_CONFIGURED` |
| `acceptedOutputModes` 不含 `text/plain` | `-32005` `ContentTypeNotSupportedError` | 400 | `CONTENT_TYPE_NOT_SUPPORTED` |
| 任务不存在、不是自己的、自带新 `taskId` | `-32001` `TaskNotFoundError` | 404 | `TASK_NOT_FOUND` |
| 取消一个已结束的任务 | `-32002` `TaskNotCancelableError` | 400 | `TASK_NOT_CANCELABLE` |
| 两个编号对不上 | `-32602` 参数无效 | 400 | `CONTEXT_MISMATCH` |
| `contextId` 未知、过期、别人的 | `-32602` | 400 | `CONTEXT_NOT_FOUND` |
| `messageId` 相同内容不同 | `-32602` | 400 | `MESSAGE_ID_CONFLICT` |
| 消息字段不合规（`url` 部件、部件太多、太大、`messageId` 长度不对…） | `-32602` | 400，带 `google.rpc.BadRequest` 指出字段 | `INVALID_ARGUMENT` |
| Daisy 正在关闭，不接新请求；这个调用方扣着的阻塞请求已经 8 个 | `-32603` | 503，带 `Retry-After` | `UNAVAILABLE` |
| 超过每个调用方的上限（limits.md 第 2 节：没结束的任务、对话、存放的字节、每分钟的消息、一个任务里的消息），什么都没存 | `-31429` | 429，带 `Retry-After` | `RESOURCE_EXHAUSTED` |
| 请求体超过 16 MB + 64 KB | `-31413` | 413 | `PAYLOAD_TOO_LARGE` |
| 内部错误 | `-32603` | 500 | — |

- 上表“HTTP 状态”一列是 HTTP+JSON 的。JSON-RPC 的错误放在 HTTP 200 的响应体里（JSON-RPC over HTTP 的惯例），例外是认证、无权（401 / 403，集中检查，响应体仍是 JSON-RPC 错误）、看不到的 agent（404，不进 JSON-RPC 处理，响应体是 `google.rpc.Status`）、关闭中（503）、内部错误（500）（P4-04，ADR-123）。
- 认证失败的 JSON-RPC 错误码：规范只说“用自定义错误”，没给码（`-32000` 到 `-32099` 是 JSON-RPC 保留给服务端实现的、A2A 又占了其中 `-32001` 起的一段）。【本契约的选择】用保留区之外的 `-31401`、`-31403`，与 HTTP 状态一一对应，便于记忆。客户端主要看 HTTP 状态。
- 错误信息用中文写清“出了什么事、怎么办”，不出现令牌。

### 9.2 调用被拒或失败（产生任务，置为终态）

认人、认范围之后，凡是“这一次不执行”的情况，都**返回一个任务**并置为已拒绝或失败，而不是返回错误。理由：调用方能用同一个 `taskId` 查到原因；重发同一个 `messageId` 得到同样的结果；这也是规范给“已拒绝”状态的用途。

原因写在 `status.message` 里：一个 `text` 部件（中文说明，含怎么办），一个 `data` 部件 `{"reason": "<下表的值>"}`。

| 情况 | 状态 | `reason` |
| --- | --- | --- |
| 主人拒绝了这次调用 | 已拒绝 | `OWNER_REJECTED` |
| 待批准的卡片 7 天没人处理（过期） | 已拒绝 | `APPROVAL_EXPIRED` |
| 公开 agent 关掉了“办”，而这次是办 | 已拒绝 | `ACT_DISABLED` |
| 这个 agent 不接受“问”（harness 没有只读模式）而这次是问 | 已拒绝 | `ASK_NOT_SUPPORTED` |
| 常驻 agent 暂停中 | 已拒绝 | `AGENT_PAUSED` |
| agent 暂时不可用（会话出错、harness 未登录） | 已拒绝 | `AGENT_UNAVAILABLE` |
| 链路深度超过 8 | 已拒绝 | `TRACE_DEPTH_EXCEEDED` |
| 同一链路号在本机的调用超过 64 次 | 已拒绝 | `TRACE_CALLS_EXCEEDED` |
| 用量上限（常驻 agent 的每日上限、“问”的每日次数） | 已拒绝 | `QUOTA_EXCEEDED` |
| 等的那张卡片作废了（对方被移出范围、agent 收回私有、重置 PIN） | 已拒绝 | `APPROVAL_CANCELED`（P4-04 加） |
| 执行中主人撤销了授权 | 已拒绝 | `GRANT_REVOKED` |
| 等调用方补充超过 24 小时 | 失败 | `INPUT_EXPIRED`（P4-04 审查 L-2） |
| 执行出错 | 失败 | `EXECUTION_ERROR` |
| 被打断（进程重启、harness 崩溃），不重放 | 失败 | `INTERRUPTED` |

超过常驻 agent 的并发上限**不是**拒绝：任务停在“已提交”排队。

## 10. 状态对应

| A2A 状态 | 在 Daisy 里 | 阻塞的 `SendMessage` 在这里返回吗 |
| --- | --- | --- |
| `TASK_STATE_SUBMITTED` | 收到了，在排队：排在主人当前这一轮后面（办），或等并发名额（常驻） | 不返回，继续等 |
| `TASK_STATE_WORKING` | 这一轮正在跑。公开 agent 办事时等主人确认某个操作，也算这里 | 不返回，继续等 |
| `TASK_STATE_INPUT_REQUIRED` | AI 在等调用方补充信息 | **返回**（中断态） |
| `TASK_STATE_AUTH_REQUIRED` | 等主人批准这次调用（卡片已生成） | **返回**（中断态） |
| `TASK_STATE_COMPLETED` | 这一轮正常结束，结果在 `artifacts` | 返回（终态） |
| `TASK_STATE_FAILED` | 出错，或被打断 | 返回（终态） |
| `TASK_STATE_CANCELED` | 调用方取消了 | 返回（终态） |
| `TASK_STATE_REJECTED` | 不执行（第 9.2 节） | 返回（终态） |

需要认证之后：主人批准，任务转为已提交或工作中；主人拒绝或卡片过期，转为已拒绝。调用方用查任务看后续。

## 11. 等不等结果

- **调用方不带 `returnImmediately`，或为 `false`**：Daisy 扣着连接，一直等到任务进入终态，或进入需要输入、需要认证，才返回任务。**不设人为上限**，不再有现在代码里的 25 秒超时和 504。排队的时间也算在等待里。
- **带 `returnImmediately: true`**：建好任务（已提交）就立即返回，调用方之后用查任务轮询。
- 阻塞等的是调用方，Daisy 只是扣着连接继续执行。**连接中途断了，执行不受影响**。调用方用同一个 `messageId`、同样的内容重发，拿到的是原来那个任务（第 7 节“重发”），可以再阻塞等一次，也可以带 `returnImmediately: true` 只取状态。
- 令牌只在请求到达时验一次（5 分钟有效期不影响长时间等待）。
- 每个调用方同一个任务只扣一个连接：再用同一 `messageId` 阻塞重发时，新的接替，旧的立即带当前状态返回；一个调用方同时最多扣 8 个，再多回 `UNAVAILABLE`（503 + `Retry-After`），新任务不建——想多发就带 `returnImmediately: true` 再轮询（P4-04 审查 M-2）。
- Daisy 要重启时（主人强制更新，P1-02）：正在跑的这一轮被打断，任务置为失败（`INTERRUPTED`）；还扣着的连接尽量带着这个失败的任务返回；来不及的，调用方重发同一个 `messageId` 取到它。
- 经中转时（阶段 5），中转可能有自己的连接时长限制。调用方遇到连接被断，按上面重发即可。

## 12. 对话过期

- 一段来访对话**空闲超过 7 天**就回收（默认值，见 limits.md）。“空闲”从这段对话里最后一次有消息到达或任务状态变化算起。
- 对话里还有未结束的任务（含等批准、等补充信息的）时不回收。等补充信息的任务空闲 24 小时就置为失败（`INPUT_EXPIRED`），调用随之结束，对话再按 7 天回收（P4-04 审查 L-2）。
- 回收时删除这段对话的历史、它的任务、`messageId` 记录。常驻 agent 为它拉起的专属会话随之关闭并删除（P4-07 定，ADR-126 第 5 节；A2A 服务端的 `onReclaim` 钩子）。公开 agent 主线里已经留下的内容（办的一问一答、问的摘要）属于主线，不随之删除。
- 回收之后：用这个 `contextId` 回 `CONTEXT_NOT_FOUND`，查其中的任务回 `TaskNotFoundError`。

## 13. 弱只读的声明

只读只是 plan 一类模式、挡不住全部写操作的 harness（按 P0-03：Kimi Code、OpenCode），在没有内核级只读兜底的系统上（macOS、Windows；Linux 上没有 Bubblewrap 时同样），照常接受“问”，但要如实写明。写在三处：

1. **agent 名片的 `description`** 末尾加一句：“只读保证：弱。这个 AI 回答‘问’时使用 harness 的规划模式，不能保证完全不改文件。”
2. **“办”扩展的 `params.readOnly`**：`"weak"`（第 8.1 节）。
3. **每个“问”任务的结果 `metadata`**：`readOnly: "weak"`。

同一个 harness 在 Linux 上有 Bubblewrap 兜底时是 `strong`，所以这个值按“harness × 系统”算，来自能力声明（`agent-capabilities.ts`，P4-11）。没有只读模式的 harness（Antigravity、DeepSeek Harness 经 ACP）：`params.readOnly` 为 `"none"`，问一律 `ASK_NOT_SUPPORTED`；这样的 agent 只有在允许办时才能公开。

## 14. 完整的 agent 名片示例

```json
{
  "name": "研究助手",
  "description": "张三的研究助手，擅长查资料和读代码。只读保证：弱。这个 AI 回答‘问’时使用 harness 的规划模式，不能保证完全不改文件。",
  "version": "1.0.0",
  "supportedInterfaces": [
    { "url": "https://zhangsan.example/a2a/s_7f3a/jsonrpc", "protocolBinding": "JSONRPC",   "protocolVersion": "1.0" },
    { "url": "https://zhangsan.example/a2a/s_7f3a",         "protocolBinding": "HTTP+JSON", "protocolVersion": "1.0" }
  ],
  "capabilities": {
    "streaming": false,
    "pushNotifications": false,
    "extendedAgentCard": false,
    "extensions": [
      { "uri": "https://quantgrail.github.io/a2a-ext/act/v1", "required": false, "description": "…", "params": { "act": true, "readOnly": "weak" } },
      { "uri": "https://quantgrail.github.io/a2a-ext/trace/v1", "required": false, "description": "可选。metadata 里带链路号和深度，超过深度上限的调用会被拒绝。", "params": { "maxDepth": 8 } }
    ]
  },
  "securitySchemes": { "bearer": { "httpAuthSecurityScheme": { "scheme": "Bearer", "bearerFormat": "JWT", "description": "…" } } },
  "securityRequirements": [ { "schemes": { "bearer": { "list": [] } } } ],
  "defaultInputModes": [ "text/plain", "application/json", "application/octet-stream" ],
  "defaultOutputModes": [ "text/plain", "application/octet-stream" ],
  "skills": [
    { "id": "general", "name": "提问与委托", "description": "直接提问会得到只读的回答；启用“办”扩展可以请它动手。", "tags": [ "question", "task" ] }
  ]
}
```

`version` 是 Daisy 的版本号。名片可以带 `signatures`（用身份密钥签），这一版不要求。

## 15. Daisy 作为调用方

- harness 经 Daisy 提供的 MCP 工具（发现智能体、调用智能体、查询调用结果，P4-08）发起调用。Daisy 以这个 AI 的身份现签一张访问令牌（token.md 第 3 节，`client_id` 为 `a2a`，`act` 为这个 AI）。
- 传输：优先 JSON-RPC，对方名片里只有 HTTP+JSON 时用它。总带 `A2A-Version: 1.0`。
- 第一次调用不带 `contextId`；记下对方返回的 `contextId` 和 `taskId`（按“这个 AI × 对方 agent”记）。AI 说“接着上次那段”时带上记下的 `contextId`，换话题就不带。对方的编号当作不透明字符串，不编造、不猜。
- 等不等（规范允许调用方按需要选）：【本契约的选择】调用工具默认带 `returnImmediately: true`，然后按退避间隔轮询查任务（limits.md），答复回来后作为参考材料交还 AI 并唤醒它一次。理由：AI 的这一轮不该被一个可能很长的调用卡住。只在 AI 明确要求“等结果再继续”且预计很快时用阻塞。
- 对方进入需要输入：把问题交给 AI，AI 用同一个 `taskId` 回复。
- 带“办”时在请求头和消息里都写上扩展（第 8.1 节）；带链路扩展（trace.md）。
- 网络失败重发时用同一个 `messageId`。
- **按实现补（P4-08，ADR-127）**：
  - 三个工具：`agents`（发现智能体，问联系人的目录）、`call_agent`（调用智能体；`mode` 默认 `ask`，`continue` 接着上次那段，`replyTo` 回答对方的提问）、`call_result`（查询调用结果）。Claude Code 是 `mcp__daisy__<名字>`，Codex 是 `daisy_<名字>`（ADR-154；在那之前开始的原生对话沿用旧名 `mcp__harbor__<名字>` / `harbor_<名字>`）。
  - 令牌：每个请求（目录、名片、发送、每次查任务）现签一张，`aud` 正好是对方，有效期 120 秒（`A2A_CLIENT_LIMITS.tokenTtlS`），不保存。
  - 先读 agent 名片选接口；名片上的接口地址必须和联系人名片里的地址**同源**，否则不连（令牌只给那个 Daisy）。
  - 出站连接：先解析，回环、未指定、链路本地、云元数据、组播、保留地址一律不连，中转地址还不连内网；连的就是检查过的那个 IP（不再解析）；明文 http 只连内网；不跟随跳转；回答有字节和时间上限。对方的自签证书按“联系人 × 地址源”首次信任并钉住，变了就拒绝，直到导入对方更新的名片。
  - 对方回 429 `RESOURCE_EXHAUSTED` 或 503 `UNAVAILABLE`：按 `Retry-After` 等（最多 10 分钟）再以同一条消息重发或再查，次数有限；413 不再重发。
  - 答复唤醒的那一轮沿用调用的链路号，深度是发起调用那一轮的（trace.md 第 3 节）；AI 已经从工具的回答或查询里看到过这个结果就不再唤醒。
- **独立的 A2A MCP（P4-09，ADR-128）**：同样的三个工具、同样的令牌规则（`act` 为 `agent:daisy-mcp`）、同样的出站连接与重发规则（代码共用）。不同处：没有唤醒——`call_agent` 在工具里等一小会儿（6 秒），之后由 AI 用 `call_result` 查（那时再向对方查一次、或重发没送到的消息）；它只会是调用链的起点，每次新调用一个新链路号、深度 1，`replyTo` 沿用原调用的；编号记在它自己的目录里，`continue` 按“联系人 × agent”取最近的 `contextId`。

### 15.1 TLS 绑定声明（P5-02，ADR-100、ADR-144）

中转运营者控制中转域名的 DNS 和 443 端口，能为任何 Daisy 的子域名申请一张受信任的证书，在中间解密（维护者决定接受并写明的限度）。单靠 WebPKI 挡不住它；身份密钥挡得住——中转没有它。所以每个 Daisy 用身份密钥签一份“这几把 TLS 密钥是我的”，Daisy 客户端经中转调用时先核对，再发令牌。这是 Daisy 客户端的行为（Daisy 和独立 A2A MCP，代码在 `packages/a2a-client/src/binding.ts`），不是对第三方客户端的要求。

**路径**：`GET <Daisy 根地址>/.well-known/daisy-tls-binding`。公开，不要令牌（两个面都有）；回答 `200`，`content-type: application/jwt`，内容是一个 JWS 紧凑序列化；Daisy 还没有 TLS 密钥时 `404`。

**JWS**：

- 头**恰好**是 `{"alg":"EdDSA","typ":"daisy-tls-binding+jwt"}`，没有别的成员（不认 `jwk`、`kid`、`crit` 等）。`typ` 与身份名片（`daisy-card+jwt`）、访问令牌（`at+jwt`）、中转登记证明（`daisy-relay-proof+jwt`）都不同，彼此不能顶替。
- 用身份私钥（Ed25519）签。
- 载荷：

| 字段 | 说明 |
| --- | --- |
| `v` | `1` |
| `id` | 签发者的身份编号（52 字符） |
| `spki` | 这个 Daisy 的 TLS 密钥：每把是证书 SubjectPublicKeyInfo（DER）的 SHA-256，base64url 不带填充（43 字符）；1–8 把。现在是中转地址用的 ECDSA P-256 密钥，和对外面直连监听用的密钥（有的话）。证书续期时密钥不变，所以声明不随续期变化 |
| `iat` / `exp` | 秒。Daisy 每小时重签一次，有效期一天；客户端接受的有效期最长 7 天，`iat` 允许 60 秒误差 |

**校验顺序**（客户端，对 `relay` 地址的每一条要带令牌的连接）：

1. 建立 TLS（证书是不是受信任的 CA 签的**不算数**），取这条连接上对方证书公钥的 SPKI SHA-256。**在这一步之前和整个校验过程中，这条连接上一个字节都不写。**
2. 缓存里有这位联系人在这个地址源上、未过期、包含这个 SPKI 的声明：通过，转第 6 步。
3. 否则另开一条连接取声明：`GET <源>/.well-known/daisy-tls-binding`，**不带任何令牌**；这条连接接受任何证书（它不带我们的任何东西，证明靠签名）；回答不超过 4 KiB、5 秒。
4. 验证：头恰好两个成员；用**通讯录里这位联系人的公钥**验签（从不用声明或连接给的钥匙）；`v` 是 1；`id` 等于联系人的身份编号；`spki` 格式对；`exp` 未到、`iat` 不在将来、`exp - iat` 不超过 7 天。
5. 第 1 步的 SPKI 在 `spki` 里：通过并缓存到 `exp`。不在（`mismatch`）、取不到、验不过：**关掉这条连接，什么都不发**，这次调用以“拒绝”结束（不自动重试），告诉 AI 原因，并记审计 `a2a.tls.binding_refused`（`reason`：`tls_binding_mismatch` 或 `tls_binding_invalid`）。
6. 在这条连接上发请求（带令牌）。

没有对方公钥的客户端不连 `relay` 地址（失败即拒绝）。限度：Daisy 的 TLS 密钥被手工换掉后，列着旧密钥的旧声明在 `exp` 之前仍然有效（Daisy 签的最多一天，客户端最多接受 7 天）；若换密钥是因为旧钥泄露，要等旧声明过期。`direct` 地址照旧（第 15 节：CA 证书，或自签证书首次信任并钉住）。

自签名证书（证书机构申请不到时的退路）经同样的校验，安全性与 CA 证书相同：经中转 Daisy 之间照常能用；第三方客户端和浏览器会报证书不受信任。

## 16. 给“任务与聊天”的接入步骤

1. **拿令牌。** 以 @ 那个 AI 的人的身份，从外部签发方拿一张 `aud` 为目标 Daisy、scope 含 `daisy:invoke` 的令牌（token.md 4.2）。目标 Daisy 的主人必须已经给这个人调用授权，否则任务会进入需要认证、等主人批准。
2. **找地址。** 目标 agent 的 `<base>` 来自它的 agent 名片地址；可以用 Daisy 的目录 `GET <根地址>/a2a` 列出这个人能看到的 agent。
3. **记编号。** 每个话题对每个 AI 记一个 `contextId`。第一次 @ 不带 `contextId`，记下返回的；以后带上。`contextId` 属于发起它的那个人：同一话题里几个人 @ 同一个 AI 时，按“话题 × AI × 人”各记一个，需要的话题上下文放进消息里。
4. **每次 @ 发一条消息。** 新的 `messageId`（重试时用同一个）；`parts` 里放这次的问题，以及需要的话题上下文；要它动手时带“办”扩展；带链路扩展（AI 互相 @ 时把深度往下传）。
5. **投递状态就是任务状态。** 带 `returnImmediately: true` 发送，用查任务轮询；已完成时 `artifacts` 里的 `answer` 就是回复；需要输入时 `status.message` 是 AI 的问题，把它显示在话题里，用户的回复带同一个 `taskId` 发回去；已拒绝、失败时把 `status.message` 的说明显示给用户。
6. **对方不在线**：连接失败或 503。是否重试、何时重试由任务与聊天自己决定（Daisy 不再做对方不在线时的重试）。
7. **话题过期**：超过 7 天没动的话题，再 @ 可能收到 `CONTEXT_NOT_FOUND`。这时不带 `contextId` 重发，开一段新对话，并把需要的上下文放进消息里。
