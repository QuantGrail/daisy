# ADR-114：事件出口——同一事务写待发表，按序号读

- 日期：2026-11-17
- 状态：**已实施（P2-03）**
- 工作包：P2-03（事件出口）
- 相关：设计要求——通知在本地网页里显示，对外发事件；事件格式是几家共用的契约；待定事项先按推荐做。契约草稿 `docs/contracts/events.md`、`scopes.md`、`trace.md`、`limits.md` 第 7 节；ADR-107（接口定义表）、ADR-110（集中检查）、ADR-111（链路号、脱敏）

## 背景

阶段 1 结束时，审批卡片在本地网页里有通知（P1-08 的 `notification_events` 与 `GET /api/notifications`），但没有给外部系统订阅的出口。设计要求：AI 请求授权、AI 提问、有人想调用待批准时各发一条事件，字段为序号、类型、给谁、标题、点开去哪、关联对象、发生时间、链路号；订阅方按序号增量读取，断线后从上次的序号接着读；没人订阅时什么都不发生。事件格式是外部的通知中心、任务与聊天系统也要照着用的契约。

## 决定

### 1. 一张单独的待发表 `event_outbox`，不复用 `notification_events`

- `notification_events` 是本地网页的通知：按“条目 + 修订”组织，混着一轮结束、出错等不属于事件出口的种类，问题卡片（在对话里回答）也不在里面，序号还跟着这些种类走。事件出口要的是 CloudEvents 形状、只有三类卡片、自己的保留规则和自己的序号。
- 结构变更是 `store/schema.ts` `MIGRATIONS` 第 4 步（只增不删）：`event_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, id UNIQUE, type, subject, recipient, session_id, time, traceparent, data, open)` 和 `event_outbox_state(pruned_through)`。
- `seq` 用 `AUTOINCREMENT`：删除之后也不复用，`sqlite_sequence` 记着写过的最大序号。这样订阅方存的游标永远有意义，也能判断“比这里写过的最大序号还大”（数据重建过）。
- `open = 1`：“出现”事件，卡片还没了结。了结时清掉，同时写“了结”事件。

### 2. 写入点：挂在审批卡片的通知上，同一事务

- `app.ts` 把 `approvalNotices`（P1-08 的通知）包成 `approvalEvent`：先写通知，再按卡片编号的前缀写事件（`event-outlet.ts` `card()`）。所以 `approvals.ts` 里原有的每一个卡片出现 / 了结的点（Runner 报来的工具授权、自动模式拦截、AI 提给主人的审批、分类器持续不可用、过期、处理），以及阶段 4 的调用卡片，都不用各自再写一遍。
- 前缀到类型：`perm:`（harness 的权限请求）、`block:`（自动模式拦截，主人可放行）、`ask:`（AI 提给主人的审批）→ AI 请求授权；`question:`（harness 的提问，在对话里回答）→ AI 提问；`call:`、`wake:` → 有人想调用（阶段 4）。别的前缀不是事件出口的卡片。
- harness 的提问原来不发通知（它在对话里回答，网页会话里看得到），所以另给 `daisyApprovals` 一个只写事件的钩子 `cardEvent`，在 `nativeOpened` / `nativeClosed` 里对提问调用（“只问”支线不发）。
- “同一个事务”：卡片的状态变化和事件在同一个 `store.atomic` 里。原来 Runner 报来权限请求时（`runner-api.ts`）是先 `publish` 再写通知，两步各自提交；回答对话里的提问（`messages.ts` `answerNative`）也一样；自动模式拦截（`approvals.ts` `intercepted`）先插卡片再写通知。这三处改成在一个事务里写卡片、通知和事件，提交之后再推送给实时通道。处理、过期、轮次结束时的失效本来就在事务里。
- 阶段 4 的调用卡片没有接线（代码在 `_phase4/`），写入点先定义好：`createApp(...).events.opened({ kind: "invocation", … })` / `.resolved(…)`，测试直接调用它。阶段 4 接线时调用卡片的编号用 `call:` 前缀（或直接调这两个函数）。
- 一张卡片开着时只有一条“出现”：同一张卡片再报一次（例如 Runner 重发、审批讨论里对方回复让卡片重新浮上来）不再写。了结之后同一编号再出现，算新的一次。

### 3. 字段

CloudEvents 1.0 结构化 JSON，照 events.md 第 1 节：`specversion`、`id`（`evt_<UUID>`）、`source`（这个 Daisy 的身份 URN，`access.ai.urn`）、`type`、`subject`（卡片编号，出现和了结相同）、`time`（RFC 3339）、扩展属性 `seq` 和 `traceparent`、`datacontenttype`；`data` 里 `recipient`（独立模式下是同一个 URN，读的时候填；P2-01 的外部签发方换成主人在签发方的 `sub`）、`title`（≤ 200 字）、`link`（工具授权和调用请求是 `/approvals?card=<编号>`，提问是 `/sessions/<会话>?card=<编号>`）、`actionRequired`、`expiresAt`（有期限的卡片）、`context.agentName` / `callerName`（只放名字）、了结事件的 `state`（`handled` / `expired` / `canceled`）。

- 链路号：写事件时所在上下文的链路号（ADR-111）。Runner 报来的卡片在那一轮的上下文里，所以是排进那一轮的那次主人动作的链路号；主人处理卡片时是那次请求的链路号；没有上下文时新起。`parent-id` 每条事件新起一个。
- 不放对话、工具参数、文件内容。标题和名字经 P1-11 的脱敏层（`redact`）：登记过的秘密和常见格式的令牌换成 `[已隐去]`。

### 4. 读取：增量 + 长轮询 + 快照，序号接不上回 410

- `GET /api/events?after=&limit=&wait=`（`events.list`）：`seq > after` 的事件，从小到大，最多 200；`cursor` 是最后一条的 `seq`（空页等于 `after`），`hasMore` 表示马上接着读。`wait`（0–30 秒）：没有新事件就等，有新事件立即回答。等待的实现：写入在事务里同步执行，`setImmediate` 时已提交，那时叫醒等待者重读；另外每秒重读一次（同一数据上另一个进程写的——旧版发布时新旧进程交接的情形——叫不醒这里）；请求断开、服务关闭（`preClose`、`lifecycle.onDrain`）立即回答；同时等待的最多 64 个，再多的立即回空页。
- `GET /api/events/snapshot`（`events.snapshot`）：所有 `open = 1` 的“出现”事件，加上 `cursor = 写过的最大序号`。同步读，两次查询之间不会插进写入，从这个 `cursor` 接着读不会漏。
- 序号接不上——`after` 小于清理掉的最大序号（`event_outbox_state.pruned_through`），或大于写过的最大序号——回 **410**，`code: "cursor_reset"`，正文同时带契约的 `{ events: [], cursor: 0, hasMore: false, reset: true }`。契约草稿原写的是 200 加 `reset: true`；这里按任务要求“返回明确错误要求先取快照”，契约已同步改写（见“偏离”）。
- 保留：`limits.ts` `EVENT_LIMITS`（集中配置，limits.md 第 7 节）：30 天、每页 200、长轮询 30 秒、标题 200 字、同时等待 64 个；清理在原有的 5 秒定时器里、每小时最多一次。`open = 1` 的不清理。没人订阅时什么都不发生：照写、照清理。

### 5. 谁能读：新 scope `daisy:events:read`

- 按契约草稿待决事项的推荐（待定事项先按推荐做）：第七个 scope `daisy:events:read`，只能读事件出口。契约的 `SCOPES` 列表和 `Scope` 类型加上它；主人的凭据（网页、配对设备、命令行，`guard.ts` `OWNER_SCOPES`）都带它。
- 两条接口的 scope 都是它，通道是主人的三个；没有 `aiSelf`，所以 AI 的工作凭据被 guard 以 `channel_not_allowed` 拒绝。只带这一个 scope 的凭据（P2-01 之后外部签发方可以签这种令牌）只能过这两条，别的接口一律 `insufficient_scope`——它看得到“有张卡片要处理”和标题，看不到对话。
- 令牌验证不在这个包里改：外部签发方的令牌如何映射成 `Principal` 由 P2-01 做，guard 照 scope 判断即可。

### 6. 命令行

- 定义表自动生成 `daisy events list [--after] [--limit] [--wait]`、`daisy events snapshot`。
- 持续读取是本地命令 `daisy watch`（登记进 `LOCAL_COMMANDS`）：先取快照（除非给了 `--after` 或游标文件），再循环长轮询；每条事件一行 JSON 到标准输出，提示到标准错误；`--cursor-file` 每处理完一页存一次游标；`cursor_reset` 自动重新取快照；Daisy 重启或连不上时退避重试，从同一序号接着读；`--max` 打印够条数就退出。它不能叫 `daisy events watch`：本地命令和定义表命令的第一个词不能重（`tests/cli-principle6.test.ts`）。

## 后果

- 订阅方（比如外部的通知中心）只要一个 `daisy:events:read` 的令牌，就能按序号读、断线续读、不丢不重（按 `id` 去重）。
- 本地网页的通知（`notification_events`）不变；两张表各写各的，在同一事务里。
- 网页现在不认 `/approvals?card=…`、`/sessions/<id>?card=…` 这样的地址（打开后落在首页）；网页按路径跳到卡片是之后的界面工作。
- 阶段 4 接调用卡片时只需按前缀或直接调写入点。

## 没有选的做法

- 从 `notification_events` 推导事件：省一张表，但要过滤种类、补上问题卡片、序号里夹着别的种类，保留规则也不同。
- 订阅方自己轮询卡片状态（不要“了结”事件，契约草稿待决事项里的另一种做法）：订阅方要能读卡片，scope 更大，撤回提醒有延迟。
- 推送（webhook）：契约这一版不要；以后加也只是同样的事件换一种送法。
- 200 加 `reset: true`（契约草稿原文）：任务要求明确的错误；410 的正文仍带这几个字段，照草稿写的订阅方看正文也能处理。
