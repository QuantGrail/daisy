# ADR-121：PIN 接到所有“放别人进来”的接口；重置 PIN 时的吊销钩子

- 日期：2026-11-17
- 状态：**已实施（P4-02，分支 `p4-02`）；安全审查一轮已按意见修完（H-1、M-1、M-2、L-1–L-3，见末节“审查修改”），按施工流程的约定不再复核**
- 工作包：P4-02（PIN 接到所有“放别人进来”的接口）
- 相关：设计要求——放别人进来的决定只认主人本人、要输入 PIN，AI 的工作凭据一律无效；入口等价（例外之一就是放别人进来的操作哪个入口都要 PIN）；设计的细分权限表（哪些操作要 PIN）；重置 PIN 时全部对外授权、互认的名片、配对的设备失效并留下记录。`docs/contracts/scopes.md` 第 2 节、`local-api.md` 第 6 节；ADR-107（定义表）、ADR-110（集中检查）、ADR-113（外部签发方、替 AI 代领令牌）、ADR-115（外部界面来源）

## 背景

P1-03 起，集中检查（`access/guard.ts`）按定义表的 `pin` 字段要 PIN 授权、按 `scope` 要 scope；P1-03、P2-01、P2-04 已经把它们那几条“放别人进来”的接口标成了 `daisy:grant` + `pin: true`。但这只是**每条接口自己写对了**：

1. 没有任何东西说明“这一条属于放别人进来”。新加一条接口（P4-01 的名片、P4-03 的授权、P4-06 的公开 agent、P5-03 的配对……）忘了写 `pin: true`，集中检查就不会要 PIN；表上的测试只核对“`daisy:grant` 的一定要 PIN”，忘了写 `daisy:grant` 的照样漏过去。
2. 重置 PIN 要吊销的东西（设计要求：全部对外授权、互认的名片、配对的设备）大部分还不存在。P1-05 给了 `onReset` 钩子，P2-01 / P2-04 各挂了一个，但没有清单说明“哪些种类必须有人吊销”，也没有审计记录说明这次重置收回了什么。

## 决定

### 1. 定义表上写明种类：`letsIn`

`packages/contracts/src/api/let-in.ts` 列出“放别人进来”的种类（`LET_IN`），每种对应设计权限表里的一行，并写明重置 PIN 时由哪一种吊销收回（`revokes`）：

| 种类 | 权限表的行 | 谁来做接口 | 重置时吊销 |
| --- | --- | --- | --- |
| `invoke-request` | 批准或拒绝别人的调用请求 | P4-03 | `invoke-grants` |
| `agent-exposure` | 把会话设为公开；设置是否允许办；创建、修改常驻 agent | P4-05 / P4-06 / P4-07 | —（见第 5 节） |
| `agent-audience` | 改开放范围、指定人名单 | P4-03 / P4-06 | `invoke-grants` |
| `invoke-grant` | 管理白名单、撤销授权 | P4-03 | `invoke-grants` |
| `contact` | 添加、移除互认的名片 | P4-01 | `contacts` |
| `device` | 配对新设备、吊销设备 | P5-03 | `devices` |
| `issuer` | 配置令牌签发方 | P2-01（已有） | `issuer` |
| `relay` | 选择中转 | P5-02 | —（见第 5 节） |
| `visitor-token` | 签发、吊销给第三方 A2A 客户端的令牌（设计建议的 `daisy token`、scopes.md） | P4-12 | `visitor-tokens` |
| `face` | 开启对外面、对外面的一次性口令、本机网页的口令 | P1-03（已有） | `external-face`（审查 H-1） |
| `ui-origin` | 允许的外部界面来源 | P2-04（已有） | `ui-origins` |

路由定义加两个字段（`route.ts`）：

- `letsIn?: LetInKind`：这条接口放别人进来，属于哪一种。`group()` 因此**强制 `pin: true`**；scope 不是 `daisy:grant`、明写 `pin: false`、写了 `aiSelf`、或者放在留给别的种类的位置，定义时就抛错（模块加载即失败，带着这样的定义发不出版本）。
- `notLetIn?: string`：在留给“放别人进来”的位置上、或 scope 是 `daisy:grant` 的改动，却确实不放任何人进来——写明为什么（至少 6 个字，进文档）。现在只有两条：`settings.pinGrant`（输入 PIN 本身）和 `settings.pinReset`（只收回、只在本机命令行）。测试把这张名单钉死，加一条要改测试、过审查。

### 2. 还不存在的接口：先把位置留好

`LET_IN_WORDS` 把各种类将来的接口位置定下来（与 scopes.md 第 2 节一致；审查 M-2 后从固定前缀改成按词匹配）：路径先转小写、去掉参数的正则约束（`:id(^…$)` → `:id`）、跳过参数段，每段再按 `-` `_` `.` 拆成词；**任何位置**的词以下列开头就算留给那些种类：`contact` / `card`（名片），`device` / `pair`（设备），`relay`（中转），`token`（令牌），`grant` / `allowlist` / `whitelist`（授权），`invoke` / `invocation` / `request`（调用请求与授权），`agent` / `resident`、`public` / `visib` / `expos` / `audience` / `share` / `sharing`（公开 / 常驻 agent 与开放范围）；在 `sessions` 之下的 `access` 也算（开放范围）。于是 `/api/settings/contacts`、`/api/a2a/tokens`、`/api/pairing-codes`、`/api/invoke-approvals/:aid/respond`、`/api/sessions/:id/resident/prompt`、`/api/Contacts` 都在里面。另外“调用授权”和“设置”两个分组（`LET_IN_GROUPS`）里的**每一条**改动都必须写明自己是什么。规则（`letInProblems`）：

- 这些位置上的**改动**（不是 GET），以及“调用授权”“设置”分组里的每一条改动，必须写 `letsIn`（于是强制 `daisy:grant` + PIN），或写 `notLetIn` 说明理由；否则定义时抛错。现有的 22 条设置类改动（自启、更新、通知偏好、分层提示词、PIN 设置、网页会话与本机口令、三条收窄、签发方刷新）和 `session.aiToken`（路径里有 `token`）各写了 `notLetIn` 理由，加上两条 PIN 接口，共 24 条，测试钉死这张名单。
- 任何地方 scope 是 `daisy:grant` 的改动，也必须写 `letsIn` 或 `notLetIn`。
- 读（GET）不算放人进来，不要 PIN（权限表只给改动标了“要”）。**实时通道（WebSocket）例外**（审查 L-3）：它总是 GET，但放在留出的位置上也必须写 `letsIn` 或 `notLetIn`；写了 `letsIn` 的通道要 PIN 授权，而第一帧带不了授权，所以一律被拒（宁可关着），等以后有了通道上的 PIN 再说。

三道关，任何一道都单独成立：

1. **定义时**：`group()` 跑 `letInProblems`，不合规就抛错。
2. **注册时**：`serve()` / `serveSocket()` 再查一遍（防有人绕过 `group` 手写定义对象），另外查 `letsIn` 的定义 `pin` 为真、通道里没有 `ai`。
3. **请求时**：集中检查用 `letsSomeoneIn(def)`——写了 `letsIn`，或者是留给这些位置的改动而没写 `notLetIn`——就要求凭据有 `daisy:grant`（否则 403 `insufficient_scope`，`WWW-Authenticate` 写 `scope="daisy:grant"`）并带有效的 PIN 授权（否则 403 `pin_required`），**不管定义本身写了什么**。命令行的授权照旧用一次就作废（P1-03 审查 M-3）。

### 3. 现有接口逐行核对（权限表“要” → 接口 → 之前 / 之后）

| 权限表“要”的行 | 接口 | 之前 | 之后 |
| --- | --- | --- | --- |
| 批准或拒绝别人的调用请求 | 无（P4-03；`_phase4/invoke-access.ts` 没接上） | 没有接口 | 种类 `invoke-request`，位置 `/api/requests…` 等已留；探针接口证明强制 `daisy:grant` + PIN |
| 把会话设为公开；设置是否允许办；创建、修改常驻 agent | 无。`session.create` 的 `visibility` / `visibleTo` 被忽略（ADR-107，一律私有）；常驻会话只能由内部 `createSession(…, { kind: "resident" })` 建，没有接口 | 没有接口 | 种类 `agent-exposure`，位置 `/api/agents…`、`/api/sessions/:id/public…` 已留；探针 |
| 改开放范围、指定人名单 | 无 | 没有接口 | 种类 `agent-audience`；探针 |
| 管理白名单、撤销授权 | 无 | 没有接口 | 种类 `invoke-grant`，位置 `/api/grants…`、`/api/allowlist…`；探针（加白名单、撤销授权各一条） |
| 添加、移除互认的名片 | 无 | 没有接口 | 种类 `contact`，位置 `/api/contacts…`；探针（添加、移除各一条） |
| 配对新设备、吊销设备 | 无（P5-03） | 没有接口 | 种类 `device`，位置 `/api/devices…`、`/api/pair…`；探针（配对、吊销各一条） |
| 配置令牌签发方 | `settings.issuerSet`（`PUT /api/access/issuer`） | `daisy:grant` + `pin: true`（P2-01） | 加 `letsIn: "issuer"`，三道关都强制 |
| 选择中转 | 无（P5-02） | 没有接口 | 种类 `relay`，位置 `/api/relay…`；探针 |
| （设计建议）签发 `daisy token` | 无 | 没有接口 | 种类 `visitor-token`，位置 `/api/tokens…`；探针 |
| （表外，另定）开启对外面 | `settings.externalOn` | `daisy:grant` + PIN（P1-03） | `letsIn: "face"` |
| （表外，另定）对外面的一次性口令 | `settings.openCodeExternal` | 同上 | `letsIn: "face"` |
| （表外，另定）本机网页口令 | `settings.passcode` | 同上 | `letsIn: "face"` |
| （表外，另定）允许的外部界面来源 | `settings.uiOriginsSet` | `daisy:grant` + PIN（P2-04） | `letsIn: "ui-origin"` |

收窄的操作（`settings.externalOff`、`settings.issuerRemove`、`settings.uiOriginsClear`）维持 P1-03 / P2-01 / P2-04 的决定：`daisy:manage`、不要 PIN；它们不在留出的位置上，规则不管。**但留出的位置上的收窄（移除名片、吊销设备、撤销授权、停用中转）按权限表和接口设计的字面要 PIN**——权限表把“添加、移除”“配对、吊销”“管理白名单、撤销授权”写在同一行，接口设计写中转“选择和停用要 PIN”。两种做法并存，列为待维护者确认（第 7 节第 1 条）。

### 4. 重置 PIN：吊销钩子登记处

`packages/daisy/src/access/revocations.ts` 的 `Revocations`，`createApp(...).access.revocations`（路由模块从 `ctx.access.revocations` 拿）：

- `register(kind, name, fn, { outside? })`：`fn()` 收回这一种的全部，返回收回了几个（不知道就不返回）。同一种可以登记多个（比如 `ai-tokens`：P2-02 的代领令牌、P4-08 的跨 Daisy 访问令牌）。
- 重置（`PinService.resetLocal`，只在本机命令行，`POST /api/pin/reset`）在**同一个事务**里：删 PIN 和全部 PIN 授权 → 先跑数据库里的钩子 → 再跑 `outside: true` 的（文件、内存）→ 写一条审计 `pin.reset.revoke`，内容是 `{ revoked: {种类: 个数}, pending: [没人登记的种类] }`。任何一个钩子抛错，重置在库里的部分整个回滚（PIN 还在、授权还在、库里的东西都在），回答 500。**外部的钩子撤不回**（审查 L-1 更正了原来“它们也还没动”的说法）：库里的钩子失败时外部的还没跑，确实没动；但外部的钩子一个接一个跑，后面一个失败时前面几个已经收回了。这时登记处记下已经跑完的外部种类（`failure()`），重置路由在事务回滚之后另写一条审计 `pin.reset.partial`（`{ failed, outsideDone }`），所以“收回了一半”总有记录。外部钩子先删文件、后清内存（签发方的钩子按这个顺序改了），删不掉文件时内存里也还在，进程不会比磁盘更“不信”——反过来也不会更信。钩子必须是同步的，返回 Promise 的钩子被拒绝（审查 L-2）。成功时路由随后再记一条 `pin.reset`。这些审计都带谁、哪个入口（`cli`）、链路号（P1-11）。

**重置之后的第一个 PIN**（审查 H-1）：PIN 处于“在本机重置过、还没重新设置”（`resetAt` 有值、校验值为空）时，`POST /api/pin` 只接受本机面上的命令行凭据；网页、外部签发方的令牌一律 403 `pin_set_local_only`（并记 `pin.set.refused`）。全新安装时（从没重置过）第一个 PIN 照旧可以从任何主人入口设置。

### 4a. 等待中的请求不能写回已经收回的东西（审查 M-1）

集中检查只在请求到达时查一次 PIN 授权。处理函数中途要等（取签发方的公钥、导入名片、连另一个 Daisy）时，PIN 可能已经被重置，它照样写回去，就把重置收回的信任又装了回来。所以：

- PinService 有一个 `epoch()`：每次设置、修改、重置都变（重置一开始就变，回滚了也不复原——只会让正在进行的请求失败）。
- 集中检查在 PIN 授权通过时，把当时的 epoch 封在请求上（`sealLetIn`）。
- **每个“放别人进来”的处理函数都在 `commitLetIn(req, () => …)` 里写入**（`packages/daisy/src/access/let-in-commit.ts`）：先把所有 `await` 做完，再在 `commitLetIn` 里同步地写库、写文件、改内存；epoch 变了就 409 `pin_changed`，什么也不写。给它的函数返回 Promise 会被拒绝。没有 `epoch` 的 PinService 一律不让写（宁可关着）。
- `serve()` 给每条要 PIN 的接口包一层：成功的回答如果没有经过 `commitLetIn`，变成 500——忘了用它的接口在自己的测试里就会失败。
- 现有五条已改：`issuerSet`（取完公钥、验完主人令牌后再提交）、`externalOn`（先开监听，提交失败就关掉）、`openCodeExternal`、`passcode`、`uiOriginsSet`。**P4-01（导入名片也是异步的）、P4-03 等后面的包照此办理。**
- 审计里只有种类和个数，不写令牌、不写 PIN（日志和审计里不出现秘密）。

现在登记的：

| 种类 | 登记者 | 做什么 |
| --- | --- | --- |
| `issuer` | `access/index.ts`（P2-01，原有，改成登记处） | 不再相信外部签发方，删公钥缓存和存着的主人令牌（外部） |
| `ui-origins` | `access/index.ts`（P2-04，原有） | 清空允许的外部界面来源（外部） |
| `ai-tokens` | `access/index.ts`（P2-02，本包新加） | `DelegatedTokens.revokeAll()`：忘掉替 AI 领过的令牌，不再交出去（外部；排在 `issuer` 之前，免得换签发方时先被清空而计不到数） |
| `external-face` | `access/index.ts`（审查 H-1 新加） | 关闭对外面（保存为关闭，监听器立即断开现有连接），作废对外面上的全部网页会话和没用过的一次性口令（外部） |

**还没有人登记、必须由后面的工作包登记的**（测试 `PENDING_REVOCATIONS` 钉死这张名单，登记了就要从里面去掉）：

| 种类 | 由谁登记 | 要收回什么 |
| --- | --- | --- |
| `contacts` | P4-01 | 全部互认的名片（移除后对方立即不被认得） |
| `invoke-grants` | P4-03 | 永久通过的授权、白名单、指定人名单、待批准的调用卡片（进行中的调用按撤销的规则停下） |
| `devices` | P5-03 | 全部配对的设备凭据 |
| `visitor-tokens` | 签发 `daisy token` 的包（P4-12） | 全部签给第三方客户端的令牌 |
| `ai-tokens`（追加） | P4-08 | 以 AI 身份签出的跨 Daisy 访问令牌（若 P4-08 缓存它们） |

还有一条连带的测试：**定义表里一旦出现某种类的接口，而这个种类有 `revokes`，那一种吊销就必须已经有人登记**——P4-01 加了名片接口却忘了登记 `contacts` 的钩子，测试失败。

### 5. 重置不收回的，和收不回的

- `agent-exposure`、`relay` 没有对应的吊销：名片、授权、签发方、设备都没了，公开 agent 没有人能调用（权限表：外面来的陌生人一律拒绝）；中转只是通道。
- `face` 原来也不收回（“对外面上的网页会话是主人自己的”）。审查 H-1 指出这是错的：PIN 没有的那段时间里，对外面上任何一张网页会话（或没用过的一次性口令）都能抢先设一个自己的 PIN。现在重置关闭对外面、作废它的会话和口令；主人重新设好 PIN 后在本机重新开启（要 PIN）。
- 已经交给 AI 的代领令牌，在它们被送去的那个系统上仍然有效，直到过期（≤ 1 小时，ADR-113）。Daisy 没办法让别人的系统拒绝它们；外部模式下可以向签发方调 RFC 7009 撤销，本包没有做（第 7 节第 3 条）。
- 正在跑的 AI 轮次不停（既定行为：PIN 未设置时不开始新的轮次）。

### 6. 测试

- `tests/let-in.test.ts`
  - 表：每个种类要么有接口（`ROUTES_OF` 逐种写明），要么还没有；每条 `letsIn` 接口 `daisy:grant` + PIN、不对 AI 开放、网页 / 配对设备 / 命令行都能调；表里没有“放了人却没写种类”的接口；`notLetIn` 只有两条 PIN 接口；`grant` 分组整组 `daisy:grant`。
  - 先写的拒绝：12 种违规定义（留出的位置不写种类、`grant` 分组的改动、别处的 `daisy:grant` 改动、错 scope、`pin: false`、对 AI 开放、放错位置、理由太短）定义时都抛错；手写的违规定义 `serve` 拒绝注册；绕过两者直接注册的一条（`/api/contacts/import`，`daisy:manage`、`pin: false`），集中检查仍要 PIN、仍要 `daisy:grant`。
  - **不输入 PIN 一律拒绝**：真的 PinService（scrypt、计数、锁定）。5 条现有接口 + 12 条探针（P4-01 / P4-03 / P4-05..07 / P4-12 / P5-02 / P5-03 将来的接口，定义里只写 `letsIn` 和 `daisy:grant`），覆盖全部 11 个种类，每一条：命令行和网页不带授权 → `pin_required`；外部签发方给主人、但不带 `daisy:grant` 的令牌，带着绑定在它身上的有效授权 → `insufficient_scope`；命令行输错 PIN → `pin_wrong` 且计数加一，伪造的授权、别的凭据的授权 → `pin_required`；输对 → 计数清零、操作通过（探针 200，passcode / ui-origins / issuer 实际 200），同一张命令行授权再用 → `pin_required`。然后连续输错 5 次锁定：输对也 423、对所有入口都锁、期间操作被拒；审计有 `pin.grant.wrong`、`pin.locked`，没有 PIN 和授权。
  - **重置 PIN**：登记四个模拟 P4-01 / P4-03 / P5-03 / `daisy token` 存储的钩子（库里的表）；配置外部签发方（带主人令牌）、两个外部界面来源、替 AI 经令牌交换领一张令牌、一张网页 PIN 授权。先让一个库里的钩子抛错：重置 500，PIN、授权、四张表、签发方、来源、代领令牌全都还在。网页带 PIN 也不能重置（`channel_not_allowed`）。本机命令行重置：PIN 和授权没了，四张表清空，签发方和存着的主人令牌没了，来源清空，代领令牌忘掉；之后主人的签发方令牌 401、旧授权 `pin_required`、再领得到的是新令牌；审计有 `pin.reset` 和 `pin.reset.revoke`（谁 `cli`、通道 `cli`，每种个数，`pending` 为空），审计里没有任何秘密；`resetVia` 是 `cli`（持续提示主人用）。
  - 重置 PIN 第二条：默认的 Daisy 里没人登记的种类恰好是 `PENDING_REVOCATIONS`，重置的审计把它们记成 `pending`；定义表里有接口的种类，它的吊销必须已登记。
- `tests/access.test.ts` 的“每条接口 × 每种身份”矩阵：加上 12 条探针（权限表“要”），加第 14 种身份 `issuerNoGrantPin`（外部签发方给主人、不带 `daisy:grant`、带绑定在它身上的 PIN 授权）：除了要 `daisy:grant` 的行，和带 PIN 的主人令牌一样。124 条 × 14 = 1736 次。

## 7. 待维护者确认（先照推荐做）

1. **留出位置上的收窄要不要 PIN**：移除名片、吊销设备、撤销授权、停用中转——照权限表和接口设计的字面要 PIN（已这样做）；而 P1-03 / P2 的关闭对外面、去掉签发方、清空来源不要 PIN。推荐：维持现状（权限表写明的照写，别的收窄不加 PIN），P4-01 / P4-03 / P5 如果要为某个收窄去掉 PIN，用 `notLetIn` 写理由并在审查里过。
2. **重置 PIN 时收回什么之外的东西**：按审查 H-1，**关闭对外面、作废它上面的网页会话和一次性口令**（已做，不再是待定）；停用中转、把公开 agent 收回私有仍推荐不做（名片和签发方没了，外人已经进不来）。
3. **已交出去的 AI 代领令牌**：推荐接受“到期为止（≤ 1 小时）”，写进已知限制；外部模式下向签发方 RFC 7009 撤销留到需要时再做。
4. **常驻 agent 的暂停 / 恢复 / 关闭**：scopes.md 写的是 `daisy:session:write`、不要 PIN，接口设计里 `daisy agent` 写“要 PIN”。P4-07 定；接口如果放在 `/api/agents…` 下又不要 PIN，必须写 `notLetIn`。

## 审查修改（2026-11-17，安全审查一轮）

| 编号 | 问题 | 改法 | 测试（不修就失败，已逐条核对） |
| --- | --- | --- | --- |
| H-1 | 重置后对外面的网页会话和一次性口令还有效，PIN 为空时能抢设 PIN | 新吊销种类 `external-face`：关闭对外面、作废它的会话和口令；重置后第一个 PIN 只能本机命令行设置 | `let-in.test.ts`「review H-1」 |
| M-1 | 等待中的“放别人进来”请求在重置后写回 | PIN epoch + `sealLetIn` / `commitLetIn`，`serve` 检查成功的回答经过了它 | 「review M-1」两条（重置时正在配置签发方 → 409，签发方没写回；不经 `commitLetIn` 的接口 → 500） |
| M-2 | 留出的位置只认固定前缀，16 种写法漏掉 | 按词、任何位置、不分大小写、去掉参数约束；设置和调用授权分组的每条改动必须写明 | 违规定义从 12 种增到 30 种（含审查列出的 16 种） |
| L-1 | 外部钩子不原子，原文说“还没动”不对；签发方先清内存后删文件 | 先删文件后清内存；失败时另记 `pin.reset.partial` | 「review L-1 / L-2」（签发方目录删不掉 → 内存里仍在、`outsideDone: ["ai-tokens"]`；后面的外部钩子失败 → 记下已收回的四种） |
| L-2 | 返回 Promise 的钩子被当成成功 | `runAll` 拒绝 thenable | 同上 |
| L-3 | 实时通道从不算在留出的位置上 | 位置上的通道必须写 `letsIn` / `notLetIn`；写了 `letsIn` 的通道一律被拒 | 违规定义里的“a socket at a kept place” |

## 阶段 4 关口决定

阶段 4 关口（2026-11-17，维护者）：**网页等主人入口读不要 PIN；本机命令行读仍要 PIN（命令行凭据可能是主人的 AI）；写都要 PIN。** 本 ADR 第 1 节原本就写“读（GET）不算放人进来”，但 P4-01 / P4-03 / P4-05 / P4-07 / P4-12 按“`daisy:grant` 必带 PIN”给“调用授权”分组的读也加了 PIN（P4-01 的四个读还写了 `letsIn: "contact"`）。现在：

- **按通道要 PIN**：定义里新加 `pinOn?: OwnerChannel[]`——PIN 只在这些通道上要；不写就是每个通道都要。`route.ts` 的 `PIN_ON_CLI`（`{ pin: true, pinOn: ["cli"] }`）给读用，`pinFor(def, channel)` 是唯一的判断：集中检查（`guard.ts` 的 PIN 一步和封印）、命令行要不要提示（`cli.ts` 的 `pin: pinFor(r, "cli")`）、文档（“只在命令行要”，OpenAPI 的 `x-daisy-pin-on`）都读它，不在单个接口上特判。命令行凭据是“可能是主人，也可能是主人的 AI”（ADR-110），网页会话、配对设备、外部签发方签给主人且没有 `act` 的令牌不可能是 AI，所以只在 `cli` 上要。
- 定义表规则：普通 GET（不是实时通道）写 `letsIn` 定义时就抛错；写了 `letsIn` 的不能写 `pinOn`（放人进来在每个通道都要 PIN）；`pinOn` 要和 `pin: true` 一起写、至少一个通道。
- 13 个读改为 `PIN_ON_CLI`：联系人的导出 / 列出 / 查看 / 只看名片、调用请求的列出 / 查看、永久授权列表、开放范围、问与办、常驻 agent 的列出 / 查看、`daisy token` 列表、`GET /api/agents`。仍是 `daisy:grant`、只对主人的四个通道：AI 的工作凭据 `channel_not_allowed`，来访者 `a2a_only`，没有 `daisy:grant` 的令牌 `insufficient_scope`。
- `POST /api/contacts/inspect` 在留出的位置上又是 POST，所以写 `notLetIn`（“只读：只解析给它的名片文本……”），`notLetIn` 名单多这一条。
- 这些读什么也不写，处理函数不进 `commitLetIn`（网页上没有 PIN 授权就没有封印，进去会 409）。`serve` 的“要 PIN 的接口必须经 `commitLetIn`”检查改为只看 `def.pin && !def.pinOn`，所以命令行带 PIN 读也不会 500。所有写（导入、移除、白名单、批准 / 拒绝、撤销、签发 / 吊销、改开放范围、问与办、公开、常驻 agent 的创建 / 修改 / 恢复）照旧 `letsIn` + PIN + `commitLetIn`。
- 测试：`tests/let-in.test.ts`（`ROUTES_OF.contact` 只剩四个写；表里的 GET 不写 `letsIn`，要 PIN 的只在命令行要；“调用授权”的读仍是 `daisy:grant`、不对 AI 开放；新的违规定义“a GET with letsIn”“letsIn with pinOn”“pinOn without pin”；真实的读网页不带授权 200、命令行不带 `pin_required`、带了 200）；`tests/access.test.ts`（新行 `grantRead`：网页、外部签发方给主人的令牌不带 PIN 通过，命令行只有带 PIN 通过，13 条 × 19 种身份；专门一条关口决定的测试：同上，另加 AI 带不带授权都 `channel_not_allowed`、联系人和外部签发方给别人的令牌 `a2a_only`、没 `daisy:grant` 的 `insufficient_scope`、这一组每个写在网页和命令行不带 PIN 都 `pin_required`）。
