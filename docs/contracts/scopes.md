# scope 契约

版本：0.2　状态：草稿，待维护者评审
修订：0.1（2026-11-16）初稿。0.2（2026-11-17）采纳当时待决的一点：新增第七个 scope `daisy:events:read`，专门读事件。0.2.1（2026-11-17，阶段 4 关口，维护者的决定）“调用授权”一节：读在网页、配对设备、外部签发方给主人的令牌上不要 PIN，在本机命令行上仍要 PIN（命令行凭据可能是主人的 AI）；写明读仍要 `daisy:grant`、AI 和来访者读不到，只看一张名片（`POST /api/contacts/inspect`，什么也不写）算读。
共用范围：几家共用。外部签发方给 Daisy 签令牌时用这里的名字；名单也交给以插件接入的组织内部集成。

依据：设计里本机接口的分组、细分权限（六个 scope 和权限表）、P4-02。令牌格式见 token.md。

---

## 1. 七个 scope

| scope | 一句话 | 谁的令牌会有 |
| --- | --- | --- |
| `daisy:session:read` | 读会话、对话记录、事件 | 主人本人、命令行；AI 工作凭据只限自己那个会话 |
| `daisy:session:write` | 对会话动手：发消息、取消、分叉、换设置 | 主人本人、命令行 |
| `daisy:tools` | AI 自用的那组工具 | 只有 AI 工作凭据 |
| `daisy:invoke` | 以 A2A 调用这个 Daisy 上的 agent，仍要过调用授权 | 来访者（跨 Daisy 访问令牌、`daisy token`、外部签发方签给别人的令牌） |
| `daisy:manage` | 身份档、工作目录、自启动、更新、日志与审计 | 主人本人、命令行 |
| `daisy:grant` | “放别人进来”那一类。有这个 scope 还不够，写操作还要 PIN | 主人本人、命令行 |
| `daisy:events:read` | 只读事件出口（events.md），读不到对话（0.2 新增） | 主人本人、命令行；外部签发方签给订阅方（如通知中心）的只读事件令牌 |

**三条通用规则**

1. scope 只到类别，不到具体对象。“能不能碰这个会话、这个 agent”另由身份和授权判断。scope 只能收窄，不能放宽：令牌写了 `daisy:grant`，来访者也照样不能进本机接口。
2. 外部签发方签的令牌，Daisy 把它的 scope 与这个身份能有的上限取交集。主人上限是五个：`session:read`、`session:write`、`manage`、`grant`、`events:read`；AI 是 `tools` 加自己会话的 `session:read`；别人只有 `invoke`。
3. 缺 scope 回 403，`WWW-Authenticate` 里写 `error="insufficient_scope"` 和需要的 scope（token.md 4.3）。

## 2. 按本机接口分组

“通道限制”指除 scope 之外还要看通道（token.md 第 3 节的 `client_id`）。“PIN”指还要带 PIN 授权（local-api.md 第 6 节）。路径写的是现有代码的路径或将来的路径，以 local-api 的定义表为准；这里定的是**每类操作归哪个 scope**。

### 会话

| 操作 | 现有路径举例 | scope | 通道限制 | PIN |
| --- | --- | --- | --- | --- |
| 列出、读取会话 | `GET /api/sessions`、`GET /api/sessions/:id` | `session:read` | | |
| 读对话条目、事件、恢复记录、队列、实时状态 | `…/items`、`…/events`、`…/recoveries`、`…/queue`、`…/live/activity` | `session:read` | AI 只能读自己的会话 | |
| 新建会话 | `POST /api/sessions` | `session:write` | | |
| 发消息、追加、排队、插队、合并 | `…/messages`、`…/steer`、`…/queue/*` | `session:write` | | |
| 取消、分叉、回退、压缩 | `…/cancel`、`…/operations` | `session:write` | | |
| 归档、删除 | `PATCH`、`DELETE /api/sessions/:id` | `session:write` | | |
| 切模型、推理强度、权限模式 | `PATCH /api/sessions/:id` | `session:write` | | |
| 换身份档 | `…/identity` | `session:write` | | |
| 定时（主人看和改） | `…/schedules` | 读 `session:read`，改 `session:write` | | |
| 看我的 AI 调用别人的 agent 的记录（P4-12） | `GET /api/calls`、`GET /api/calls/:cid` | `session:read` | AI 不行（它用自己的 `call_result`） | |
| 常驻 agent 的运行控制：暂停、关闭、删除（只收回） | `POST /api/residents/:aid/pause`、`…/close`、`DELETE /api/residents/:aid` | `grant`（P4-07 定，ADR-126 第 6 节：比 `session:write` 严） | AI 不行 | 不要（`notLetIn`） |
| 常驻 agent 的恢复（重新让别人调用） | `POST /api/residents/:aid/resume` | `grant` | AI 不行 | 要（`agent-exposure`） |
| 打开终端、执行命令 | `…/terminal`、`…/shell` | `session:write` | | |

### 审批

| 操作 | 路径举例 | scope | 通道限制 | PIN |
| --- | --- | --- | --- | --- |
| 列出待处理的卡片 | `GET /api/approvals` | `session:read` | | |
| 回答工具授权、回答 AI 的提问 | `POST /api/approvals/:aid/respond` | `session:write` | **只限主人本人**（`web`、`device:*`，或外部签发方签给主人且没有 `act` 的令牌）。命令行和 AI 一律拒绝（设计要求：AI 不能替自己点头） | |

### 身份档

| 操作 | 路径举例 | scope |
| --- | --- | --- |
| 新建、修改、删除、登录 harness | `/api/profiles*`、`/api/logins*` | `manage` |
| 读模型列表、自动压缩设置 | `…/models`、`…/auto-compact` | `manage` |

分配给会话属于“换身份”，见会话组。

### 工作区

| 操作 | 路径举例 | scope |
| --- | --- | --- |
| 登记目录、浏览本机目录 | `POST /api/workspaces`、`GET /api/filesystem/:id` | `manage` |

### 调用授权

整组用 `daisy:grant`。改要 PIN。读：网页、配对设备、外部签发方给主人的令牌不要 PIN，本机命令行要 PIN（维护者的决定：命令行凭据可能是主人的 AI 经 Bash 在用）。读仍要 `daisy:grant`：AI 的工作凭据没有它，来访者只能走 A2A，所以都读不到。（P4-02 起由定义表强制：这一组和“设置”里中转、配对、令牌的接口位置上的改动，定义里必须写 `letsIn`，见 `packages/contracts/src/api/let-in.ts`、ADR-121。）

| 操作 | scope | PIN |
| --- | --- | --- |
| 列出 agent 的种类与开放范围、问与办的设置、常驻 agent、白名单、联系人、待批准的调用、永久授权、已签的 `daisy token`；导出自己的名片；只看一张名片是谁的（不写入） | `grant` | 网页等不要，命令行要 |
| 把会话设为公开或收回；设置是否允许办、办的权限模式；创建、修改常驻 agent | `grant` | 要 |
| 改开放范围、指定人名单 | `grant` | 要 |
| 管理白名单、撤销授权 | `grant` | 要 |
| 添加、移除联系人（身份名片） | `grant` | 要 |
| 批准或拒绝调用请求 | `grant` | 要 |
| 签发、吊销 `daisy token` | `grant` | 要 |

### 设置

| 操作 | scope | PIN |
| --- | --- | --- |
| 读设置、读状态 | `manage` | |
| 自启动、更新 | `manage` | |
| 选择中转、停用中转（P5-02：停用只收窄，按设计仍要 PIN；看中转状态是“读状态”，`manage`） | `grant` | 要 |
| 生成配对码、吊销设备（P5-03：`POST /api/devices/pair`、`DELETE /api/devices/:id`） | `grant` | 要 |
| 列出配对过的设备（`GET /api/devices`） | `grant` | 只在本机命令行要 |
| 另一台设备输入配对码、配对过的设备换新会话（`POST /api/devices/redeem`、`/session`） | 不要令牌：凭配对码 / 设备凭据，只在对外面（P5-03，ADR-142） | — |
| 配对过的设备取消自己的配对（`DELETE /api/devices/self`） | `session:read`，只有配对设备自己 | — |
| 配置外部签发方 | `grant` | 要 |
| 改监听范围（P1-03 的建议） | `grant` | 要 |
| 设置、修改 PIN | `manage` | 改时要旧 PIN |
| 重置 PIN | 只在本机命令行，不经 scope 判断（需要本机凭据，并吊销全部对外授权、联系人、设备） | — |

### 附件

| 操作 | 路径举例 | scope |
| --- | --- | --- |
| 上传 | `POST /api/attachments` | `session:write` |
| 下载 | `GET /api/attachments/:id` | `session:read` |

### 系统

| 操作 | scope |
| --- | --- |
| 查看日志和审计 | `manage` |
| 启动、停止（经本机接口时） | `manage` |
| 健康检查 `GET /api/health`、版本 `GET /api/version` | 不要令牌 |

## 3. 本机接口之外

| 入口 | 操作 | scope | 说明 |
| --- | --- | --- | --- |
| 事件出口 | 增量读取、快照 | `events:read` | 见 events.md。0.1 写的是 `session:read`；0.2 起另设只读事件的 scope |
| 给 harness 的工具（MCP） | 定时唤醒、周期任务、后台命令、监视输出、取消、主动发言 | `tools` | 只能作用于自己这个会话 |
| 同上 | 发现智能体、调用智能体、查询调用结果 | `tools` | Daisy 以这个 AI 的身份另签一张跨 Daisy 访问令牌（`daisy:invoke`）去调用对方 |
| A2A 服务端 | 读 agent 名片、发消息、列任务、查任务、取消任务 | `invoke` | 见 a2a-usage.md。还要过互认、开放范围、调用授权 |
| Daisy 自己的 agent 目录 `GET /a2a` | 列出调用方能看到的 agent 名片地址 | `invoke` | 见 a2a-usage.md 第 2 节 |

## 4. 各种凭据默认带哪些 scope

| 凭据 | scope |
| --- | --- |
| 本地网页（主人本人） | `session:read session:write manage grant events:read` |
| 配对设备 | 同上 |
| 命令行 | 同上（但“回答工具授权和提问”被通道限制挡住） |
| AI 工作凭据 | `tools session:read`（只限自己的会话） |
| 跨 Daisy 访问令牌 | `invoke` |
| `daisy token` | `invoke` |
| 替 AI 代领的令牌 | 由请求方决定，不超过主人的上限 |

## 5. 给别的项目

- 名字是固定字符串，前缀 `daisy:` 来自 Daisy 的名字常量（P0-06）。别的项目只照抄字符串，不从中推断别的意思。
- 新增 scope 只出现在次版本，且只能把一个现有 scope 拆细（旧 scope 继续代表拆前的全集）；改名或删除只出现在主版本。
