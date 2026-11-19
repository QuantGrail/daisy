# 事件出口契约

版本：0.2　状态：草稿，待维护者评审
修订：0.1（2026-11-16）初稿。0.2（2026-11-17）采纳当时待决的两点：读事件用新 scope `daisy:events:read`；要“了结”类；接不上的序号改为回 410（第 4 节）；写明长轮询、快照与保留的实现约定。实现见 ADR-114。
共用范围：几家共用。一个组织的私有插件里的通知中心按这一份订阅；外部的任务与聊天系统要发同类事件时也照它。

依据：设计要求的事件出口格式（八个字段，没人订阅时不影响使用）；沿用旧实现里通知分页的做法（游标 `after`、`cursor`、`hasMore`、`reset`，另有一个快照接口）。

---

## 1. 格式：CloudEvents 1.0

每条事件是一条 CloudEvents 1.0 事件，JSON 结构化写法。CloudEvents 是 CNCF 的通用事件格式，订阅方用现成的库就能解析（标准优先）。设计要求的八个字段全部对应上：

| 设计要求的字段 | CloudEvents 属性 | 类型 | 说明 |
| --- | --- | --- | --- |
| （事件编号） | `id` | 字符串 | 全局唯一。订阅方靠它去重 |
| （格式版本） | `specversion` | `"1.0"` | |
| （谁发的） | `source` | URI 引用 | 发出方的标识。Daisy 填自己的身份 URN（token.md 第 3 节） |
| 序号 | `seq` | 整数（扩展属性） | 这个发出方内严格递增，可能有空号。增量读取靠它 |
| 类型 | `type` | 字符串 | 见第 2 节 |
| 给谁 | `data.recipient` | 字符串 | 收件人的主体标识。独立模式下是主人的 URN；配置了外部签发方时是主人在签发方那里的 `sub`。订阅方据此决定送给谁 |
| 标题 | `data.title` | 字符串，≤200 字 | 给人看的一句话 |
| 点开去哪 | `data.link` | 相对路径 | 相对于发出方本地网页的路径，比如 `/sessions/<id>?card=<cardId>`。订阅方拼上自己知道的地址 |
| 关联对象 | `subject` | 字符串 | 这张卡片的编号。同一张卡片的“出现”和“了结”两条事件 `subject` 相同 |
| 发生时间 | `time` | RFC 3339 时间 | |
| 链路号 | `traceparent` | W3C Trace Context 写法（CloudEvents 分布式追踪扩展） | 引起这件事的那次用户动作的链路号，见 trace.md |
| — | `datacontenttype` | `application/json` | |

`data` 里另外可以有：

| 字段 | 说明 |
| --- | --- |
| `actionRequired` | 布尔。“出现”类事件为 `true` |
| `expiresAt` | 卡片过期时间（RFC 3339）。过了这个时间不用再提醒 |
| `context` | 可选的显示用信息：`{ "agentName": …, "callerName": … }`。不放对话内容 |
| `state` | 只在“了结”类事件里：`handled`、`expired`、`canceled` |

**不放进事件的**：对话记录、工具参数的全文、文件内容、任何凭据。标题本身可能带出一点内容（比如“想运行 npm publish”），所以读事件需要 scope（第 4 节）。

## 2. 事件类型

三类事件，每类两种：卡片出现、卡片了结。

| 类 | 出现 | 了结 | 什么时候发 |
| --- | --- | --- | --- |
| AI 请求授权 | `agent.permission.requested` | `agent.permission.resolved` | AI 要用需要授权的工具，生成审批卡片时 |
| AI 提问 | `agent.question.asked` | `agent.question.resolved` | AI 要问主人一个问题，生成提问卡片时 |
| 有人想调用，待批准 | `agent.invocation.requested` | `agent.invocation.resolved` | 一位互认过但未授权的调用者来调用，生成待批准卡片时 |

- 类型名不带产品名，任何“会生成需要人处理的卡片的 AI 宿主”都能用。
- “了结”类在设计里没有写，是本文的【建议】：订阅方（比如手机推送）要知道什么时候撤回提醒。不要它的话，订阅方只能自己轮询卡片状态。0.2 起采纳。
- 一张卡片开着时只有一条“出现”；同一张卡片再被报一次不再发。了结之后同一 `subject` 再出现，算新的一次。
- 以后加类型只出现在次版本；订阅方遇到不认识的 `type` 必须忽略，不能报错。

示例：

```json
{
  "specversion": "1.0",
  "id": "evt_8c1f…",
  "source": "urn:ietf:params:oauth:jwk-thumbprint:sha-256:NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
  "type": "agent.invocation.requested",
  "subject": "card_31d9…",
  "time": "2026-11-16T09:12:03Z",
  "seq": 1042,
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
  "datacontenttype": "application/json",
  "data": {
    "recipient": "urn:ietf:params:oauth:jwk-thumbprint:sha-256:NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
    "title": "李四的「代码助手」想调用你的「研究助手」",
    "link": "/approvals?card=card_31d9…",
    "actionRequired": true,
    "expiresAt": "2026-11-23T09:12:03Z",
    "context": { "agentName": "研究助手", "callerName": "李四" }
  }
}
```

## 3. 增量读取

```
GET /api/events?after=<seq>&limit=<n>&wait=<秒>
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `after` | `0` | 只返回 `seq` 大于它的事件 |
| `limit` | `200` | 最多 200 |
| `wait` | `0` | 长轮询：没有新事件时最多等这么多秒再回，最多 30。有新事件立即回 |

返回：

```json
{ "events": [ … ], "cursor": 1042, "hasMore": false }
```

- `events` 按 `seq` 从小到大。
- `cursor` 是这一页最后一条的 `seq`；这一页为空时等于请求的 `after`。下一次用它做 `after`。
- `hasMore` 为 `true` 时立即接着读，不要等。

**快照**

```
GET /api/events/snapshot
```

返回现在所有还没了结的“出现”类事件（每张卡片一条），加上可以接着读的 `cursor`（发出方写过的最大 `seq`；从它接着读，不会漏掉取快照之后的事件）：

```json
{ "events": [ … ], "cursor": 1042, "snapshot": true }
```

## 4. 断线续读

- 订阅方自己保存 `cursor`。**处理完一页再保存**。重启后用保存的 `cursor` 接着读。
- 处理完、还没来得及保存就崩溃，会再读到同一批事件。订阅方按 `id` 去重。这样做到不丢不重。
- 下面两种情况，发出方回 HTTP **410**，正文 `{ "error": "…", "code": "cursor_reset", "events": [], "cursor": 0, "hasMore": false, "reset": true }`，订阅方必须先取一次快照，再从快照给的 `cursor` 接着读（0.1 写的是 200 加同样的字段；0.2 改成明确的错误，正文字段不变）：
  - `after` 比发出方现有的最大 `seq` 还大（发出方的数据被重建过）。
  - `after` 早于保留期内最老的事件（太久没读，旧事件已清理）。
- 保留期见 limits.md。没了结的卡片对应的事件，在了结之前不清理。
- 没人订阅时什么也不发生：事件照样写进待发表，到保留期清理，主人在本地网页里看到这些卡片。

## 5. 谁能读

- 需要 `daisy:events:read`（scopes.md 第 1、3 节；0.1 写的是 `daisy:session:read`，0.2 改成它）。这个 scope 只能读事件出口，读不到对话。主人本人的凭据（网页、配对设备、命令行）都带它；外部签发方签给主人的令牌写了它才有（与主人上限取交集，scopes.md 规则 2）；AI 的工作凭据不能读；来访者不能读。
- 只返回给这个 Daisy 主人的事件。一个订阅方要订阅好几个人，就分别拿每个人的令牌去读每个人的 Daisy（上面那个私有插件里的通知中心就是这样）。
- 这个接口在本机面和对外面都有（两个入口面的划分依 P0-05 第 3 项，见 ADR-101）。

## 6. 给别的项目

- 不依赖 Daisy 的任何内部概念：只有“一张需要人处理的卡片出现了 / 了结了”。
- 发出方是谁靠 `source`；同一个订阅方看到的 `seq` 只在同一个 `source` 内可比。
- 推送（webhook）不在这一版。以后要加，也只是同样的事件换一种送法。
