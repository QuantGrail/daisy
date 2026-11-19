# ADR-122：调用授权独立——开放范围、每个 agent 乘每个人的授权、调用请求卡片、撤销即停

- 日期：2026-11-17
- 状态：**已实施（P4-03，分支 `p4-03`，基于 `p4-01`（含 `p4-02`），已 merge 两者的审查修订；待独立安全审查；未合入 `daisy-next`）**
- 工作包：P4-03（调用授权独立）
- 相关：ADR-120（通讯录、`admit`）、ADR-121（`letsIn`、`commitLetIn`、吊销登记处）、P2-03（事件出口）；契约 limits.md 第 1 节、scopes.md 第 2 节

## 背景

旧服务端的 `invoke-access.ts`（约 2000 行）把开放范围、调用卡片、白名单都建在群上：一张卡片对应“调用者 × AI × 群”，五个选项（仅这一次、此人本群、本群所有人、加白名单、拒绝），授权按群记，接口挂在 `/api/communication/`。P1-01 拿走群聊后它被移进 `_phase4/`、不编译。设计要求“开放范围、卡片、白名单的逻辑留下，和群有关的部分去掉，接口移出 `/api/communication/`”，并定了新规则：每个 agent 乘每个人一条授权、三个选择、七天过期、撤销即停。

## 决定

### 1. 模块：`packages/daisy/src/invoke/`

| 文件 | 内容 |
| --- | --- |
| `invoke-access.ts` | `InvokeAccess`：开放范围、检查（含生成卡片）、等待决定、主人决定、授权、撤销、重新核对进行中的调用、重置 PIN 的吊销、过期 |
| `calls.ts` | `Calls`：进行中的调用登记处（只在内存；重启即中断，不重放副作用） |
| `routes.ts` | 本机接口（`packages/contracts/src/api/invoke.ts`） |

`setupAccess` 里紧跟通讯录建它（`access.invoke`），它订阅 P4-01 的两个钩子：`onRemoved`（删这个人的授权、指定人名单里的位置、作废他待批准的卡片、停他的调用——都在移除的同一个事务里）和本包加的 `onWhitelistChanged`（移出白名单时重新核对他的调用）。旧的 `_phase4/invoke-access.ts` 和三个按群写的服务端测试删除（基线标签上还有）；界面部分（`packages/ui/src/_phase4/invoke-approvals.tsx` 等）留给 P4-12。

### 2. 判断顺序

| 情况 | 结果 |
| --- | --- |
| 没有有效令牌、陌生人、已移除的联系人 | 拒绝 `not_recognised`，**不生成卡片** |
| 没有这个 agent | 拒绝 `agent_unknown`（先认人：陌生人只得到 `not_recognised`，问不出有哪些 agent） |
| 私人 agent | 拒绝，对调用方也是 `agent_unknown`（审查 L-6），不生成卡片 |
| 只对指定人开放：在名单里 / 不在 | 放行 `listed` / 拒绝 `not_listed`，不生成卡片。授权、白名单对它都不起作用 |
| 对所有互认的人开放：在白名单里 | 放行 `whitelist`（添加名片时可以顺手加进白名单） |
| 同上：有这个 agent × 这个人的授权 | 放行 `grant`（第二次调用起） |
| 同上：主人 10 分钟内拒绝过他调用这个 agent | 拒绝 `rejected_recently`，不生成卡片（limits.md 第 1 节冷却；设计要求被拒的调用不会重试） |
| 同上：已有一张待批准的卡片 | 这次调用也等这张卡片（`raised: false`，卡片上 `calls` 加一） |
| 同上：其余 | 生成卡片 `call:<uuid>`，`pending` |

前四行是 P4-01 的 `admit`，本包只在它回答 `ask_owner` 时接着查。每次都读库。外部签发方的来访者同样走到这里：人是 `sub:<subject>`，名单只收联系人。

### 3. 卡片

- 每个 agent 乘每个人最多一张待批准的（数据库部分唯一索引）。三个选择：**永久通过**（`always`：写一条授权，正在等这张卡片的调用放行）、**仅本次**（`once`：只放行发起这张卡片的那一次调用，并且只开始一次；并入的其它调用转到一张新卡片上（审查 M-3）；不写授权，下次再问）、**拒绝**（`reject`：等着的调用被拒，之后 10 分钟内同一个人调用同一个 agent 直接拒绝）。
- 七天没人处理过期（`CARD_LIMITS.callCardTtlMs`；limits.md 原来写“现有代码 24 小时”，现在代码就是 7 天）：等着的调用被拒，卡片显示已过期，再决定回 409 `request_closed`。过期由检查、列出、等待时顺手扫，另有 createApp 每 5 秒的定时器。
- 主人决定时情况已经变了（对方被移出通讯录、agent 收回私有或不再对他开放）：批准回 409 `request_stale`，卡片作废；拒绝照常。收窄开放范围、移出白名单等变化发生时，也顺手作废这类卡片（`recheck`）。
- 卡片上的显示名、调用方 AI（`act.sub`）是对方能控制的文本：去掉控制、改变方向、零宽字符，名字截到 64 字符、AI 截到 200（`shown`，第二道防线；P4-01 审查 M-2 已在令牌上拒绝这些字符）。

**出现在哪里。** 卡片是审批列表（`GET /api/approvals`）里已经留好的 `kind: "call"`（契约 `DaisyCallApproval`），编号 `call:<uuid>`，这个前缀 P2-03 的事件出口已经认作“有人想调用”。卡片出现、了结时：主人的通知（`approvalNotices`，网页的通知列表）和一条事件（`outlet.opened`，带 7 天的 `expiresAt` 和显示名），和卡片的变化在同一个事务里。

**怎么决定。** 设计的权限表：“批准或拒绝别人的调用请求”主人本人 ✓、命令行 ✓、**要 PIN**。审批页回答自己 AI 的卡片的接口（`POST /api/approvals/:id/respond`）只在网页和配对设备、不要 PIN（权限表里“替 AI 点头”那一类），所以调用卡片**不经它**：它对 `call:` 回 403 `request_needs_pin`，说明去哪里；卡片上带 `respondVia: { method: "POST", path: "/api/requests/<id>/decision", pin: true }`。决定接口是 `letsIn: "invoke-request"`，网页和命令行（`daisy request decide`）都要 PIN。

**对私有插件读的契约（向后兼容）。** `DaisyCallApproval` 只**加**了可选字段 `caller`（含 `issuer`）、`agent`、`calls`、`waiting`、`actors`、`respondVia`，`title` 带等待的次数；原有的 `callerUser`（`{id: 人的键, username: 显示名}`）、`callerSession`（null）、`session`（被调用的 agent）照旧。变的是：选项的键是 `always` / `once` / `reject`（标签“永久通过 / 仅本次 / 拒绝”），`expiresAt` 是 7 天；对调用卡片调 `/api/approvals/:id/respond` 不再能决定（403 `request_needs_pin`，P1-01 起本来就是 404）。界面现有的审批面板（`approval-inbox.tsx`）只显示 permission / interception / owner，不受影响；调用卡片的界面是 P4-12。审批讨论串（旧版功能：每张审批一条讨论串）暂不支持调用卡片（`parties` 照旧回 null → 404）。

### 4. 开放范围

- 两选一：`all`（对所有互认的人开放，第一次调用弹卡片，白名单直接通过）或 `listed`（只对指定人开放，名单里的直接通过，别人一律拒绝、不弹卡片）。表 `invoke_audiences`、`invoke_audience_members`；**没设过就是 `all`**（见“待维护者确认”第 2 条）。切回 `all` 时名单保留不用。
- agent 能不能被调用（私人、公开、常驻）不在这里改，那是 P4-06 / P4-07（`agent-exposure`）。本包用“agent 解析器”（`invoke.agents.add(fn)`，后登记的先问）知道一个编号是不是自己的 agent、是哪一种；createApp 登记兜底的一个：**每个会话都是一个 agent 编号，一律私人**（P4-06 之前什么都不能被调用），所以现在就能给会话预先设开放范围。
- 指定人按联系人的编号（或 ≥ 8 字符的唯一开头）给；写错一个整次不改。

### 5. 撤销即停

调用真正开始执行时，执行它的一方（P4-04）经 `invoke.begin(principal, agentId, { ticket?, stop })` 登记（它先在同一个事务里重新判断能不能开始，审查 M-1）：agent、人、怎么进来的（`whitelist` / `listed` / `grant` / `once`，由它判断）、一个 `stop(why)`。任何收回许可的变化之后，`recheck(filter)` 对每个匹配的进行中调用重新问一遍“现在不弹卡片还进得来吗”：进不来就调它的 `stop` 并移出登记处。规则：被直接拒绝（不认得、私人、不在名单）→ 停；直接放行 → 不停；要问主人 → 有授权或是“仅本次”进来的就不停，否则停（“仅本次”只放行那一次调用，它不靠任何授权，撤销别的东西不该停它）。

| 变化 | 停谁 | `why.code` |
| --- | --- | --- |
| 撤销授权（`DELETE /api/grants/:gid`） | 这个人对这个 agent 的、靠授权进来的 | `grant_revoked` |
| 改开放范围（收窄） | 这个 agent 上不再在范围内的 | `not_admitted` |
| 移出白名单（P4-01 的接口） | 这个人靠白名单进来的 | `not_admitted` |
| 移除联系人 | 这个人的全部（在移除的事务里） | `contact_removed` |
| 把 agent 收回私有 / 暂停（P4-06 / P4-07 调 `recheck({ agentId })`） | 这个 agent 上的全部 | `not_admitted` |
| 重置 PIN | 全部 | `reset`（或 `contact_removed`，看哪个钩子先到） |

停调用是内存里的副作用，不随事务回滚：如果之后同一事务里别的监听者抛错、移除被撤销，已经停的调用不会恢复（偏安全的一边）。

### 6. 接口与命令（`packages/contracts/src/api/invoke.ts`，分组“调用授权”）

| 接口 | 命令 | 种类 |
| --- | --- | --- |
| `GET /api/requests` | `daisy request list [--status pending\|decided\|all]` | 读（要 PIN） |
| `GET /api/requests/:rid` | `daisy request show <rid>` | 读（要 PIN） |
| `POST /api/requests/:rid/decision` | `daisy request decide <rid> always\|once\|reject [--note]` | `letsIn: invoke-request` |
| `GET /api/grants` | `daisy grant list [--agent] [--contact]` | 读（要 PIN） |
| `DELETE /api/grants/:gid` | `daisy grant revoke <gid>` | `letsIn: invoke-grant` |
| `GET /api/agents/:aid/audience` | `daisy agent audience show <aid>` | 读（要 PIN） |
| `PUT /api/agents/:aid/audience` | `daisy agent audience set <aid> --open-to all\|listed [--listed …]` | `letsIn: agent-audience` |

全部 `daisy:grant` + PIN，主人的四个通道，AI 一律 `channel_not_allowed`，来访者一律 `a2a_only`。全部在 P4-02 留出的位置上（`request`、`grant`、`agent` / `audience` 这些词）。处理函数都是同步的，在 `commitLetIn` 里读写并回答（P4-02 审查 M-1；读也要经它，`serve` 要求）。白名单仍是联系人上的标记，用 P4-01 的 `PUT/DELETE /api/contacts/:id/whitelist`（`letsIn: contact`），本包不另开 `/api/allowlist`（P4-02 那个探针保留）。`daisy request` 的命令由定义表生成，所以设计里的 `daisy request` 命令在本包已经可用；P4-12 只需补界面和别的命令。

### 7. 重置 PIN（授权部分）

在 P4-02 的登记处登记两个 `invoke-grants` 钩子：**数据库钩子**（在重置的事务里）删全部授权、全部指定人名单、清全部白名单标记、作废全部待批准的卡片，返回个数之和；**外部钩子**（`outside: true`）停全部进行中的调用、通知等卡片的调用“已作废”，返回 0。数据库钩子登记在 `contacts` 之前（否则移除联系人会先把授权带走、计数为 0）。开放范围本身（`all` / `listed`）不动：名单空了的 `listed` 就是谁都不行。`PENDING_REVOCATIONS` 去掉 `invoke-grants`。

### 8. 给 P4-04 的接口（安全审查后的最终版）

```ts
const inv = ctx.access.invoke;               // 或路由模块里的 access.invoke
const d = inv.check(principal, agentId);     // 同步；可能生成卡片或并入已有的卡片
// d.outcome === "refused": { reason, message } → TASK_STATE_REJECTED；没有卡片
//   reason: not_recognised | agent_unknown（私人 agent 也是它）| not_listed | rejected_recently
//           | too_many_waiting | too_many_requests
// d.outcome === "allowed": { via: "whitelist"|"listed"|"grant", person, agent }
// d.outcome === "pending": { requestId: "call:…", ticket, raised, person, agent } → TASK_STATE_AUTH_REQUIRED，然后
const s = await inv.wait(d, signal);         // 传整个 d（要它的 ticket）；signal 放弃等待时这次调用离开卡片
// s.outcome === "allowed": { via: "grant"|"once"|"whitelist"|"listed" }
// s.outcome === "refused": { reason: "rejected"|"expired"|"canceled", message } → TASK_STATE_REJECTED
// 真正开始执行（allowed，或 wait 放行之后）：
const h = inv.begin(principal, agentId, { ticket: d.ticket /* pending 时才有 */, stop: (why) => {
  /* 取消这一轮、任务置为失败或取消，告诉调用方 why.message（why.code: grant_revoked | not_admitted
     | contact_removed | issuer_changed | agent_gone | reset） */ } });
// begin 在同一个事务里重新判断“现在能不能开始”：不能就抛 InvokeError（status 403，code "not_admitted"）。
// 仅本次的卡片只让发起它的那一次调用（它的 ticket）开始一次。
// … 执行结束：h.end()
inv.canSee(principal, agentId);              // 能不能读 agent 名片（不生成卡片）
inv.agents.add((id) => AgentInfo | null);   // P4-06 公开会话、P4-07 常驻 agent 各登记一个
inv.recheck({ agentId });                   // 收回私有、暂停之后
inv.forgetAgent(agentId);                   // agent 没了（删除会话已经调；P4-06 / P4-07 删除时也调）
inv.calls.list({ agentId?, person? }); inv.calls.size;   // 只读
inv.withdraw(ticket);                       // P4-04 审查 L-4：调用方取消等批准的调用——离开卡片，没人等了就关掉卡片（canceled）
```

和第一版相比（审查 M-1、M-3）：`wait` 收 `d`（有 `ticket`）而不是 `requestId`；`inv.calls.begin(...)` 没有了，换成 `inv.begin(principal, agentId, { ticket?, stop })`，`via` 由它自己判断。`wait` 是内存里的等待；Daisy 重启后正在等的任务按不重放的原则由 P4-04 标为失败，卡片还在。`requestId`、`ticket` 只在服务端内部用，不交给调用方。

## 测试

- `tests/invoke-access.test.ts`（17 条，先写被拒绝的；审查后加的 4 条见“安全审查修改”）：七个接口 × 没凭据 / 命令行和网页不带 PIN / 网页的授权给命令行 / AI 带授权 / 调用方自己的令牌全拒且什么都没变，审批页的回答接口不能决定调用卡片（403 `request_needs_pin`）；**T-2 / T-3**（陌生人、私人、不存在、不在名单、名单外即使有旧授权或白名单、主人自己的 AI——都拒绝，卡片 / 通知 / 事件一行都没有；名片可见性）；**T-4**（有授权的 B 用自己的令牌读会话、条目、事件、目录、审批、授权、联系人、开放范围，全部 403 `a2a_only`；授权行只有 agent × 人；授权不跨 agent）；**T-1**（一张卡片、第二次调用并入、7 天、三个选择、在审批列表里且带 `respondVia`、一条通知一条事件；永久通过后两个等待都放行，再调用直接通过、没有新卡片；重复决定、换决定 409；审计）；仅本次与拒绝、10 分钟冷却；七天过期；白名单与作废的卡片（`request_stale`）；**T-5**（撤销授权停掉 B 靠它进来的调用、告诉原因，B 的“仅本次”调用和 D 的调用不受影响，之后 B 再调用重新要卡片）；移出白名单、收窄范围、移除联系人（同一事务，监听者抛错时授权也回来）、收回私有都停对应的调用；开放范围的两种、默认、名单写错整次不改、会话默认私人；重置 PIN 吊销授权 / 名单 / 白名单 / 卡片并停调用（审计计数）；外部签发方的人；显示文本去控制字符；`daisy request` / `grant` / `agent audience` 经真实监听的 Daisy 和真实 PIN。
- 表驱动权限测试（`tests/access.test.ts`）加七个接口（`grant` 行）；`api-defs` 的 PIN 清单加七个；`let-in.test.ts` 的 `ROUTES_OF` 填上三种（`invoke-request`、`invoke-grant`、`agent-audience`），P4-02 为它们留的三个探针（同路径）删掉，`PENDING_REVOCATIONS` 去掉 `invoke-grants`，重置汇总的期望加 `"invoke-grants": 0`，L-1 的“已经收回的外部种类”加 `invoke-grants`（停掉的调用不能撤销）。
- 关键检查做过变异验证：去掉授权查询（T-1 等 4 条失败）、撤销后不停调用（T-5 失败）、“仅本次”不豁免（T-5 失败）、去掉冷却、去掉 `onRemoved` 订阅，各自有测试失败。

## 待维护者确认（先照推荐做）

1. **读也要 PIN**：本包七个接口的三个读（列请求、列授权、看开放范围）也要 PIN，跟 P4-01 的联系人一致、跟表上“`daisy:grant` 必带 PIN”的规矩一致；scopes.md 写的是“读不要 PIN”。调用卡片在审批列表里（`session:read`）不要 PIN 就能看到。推荐：维持，和 ADR-120 第 7 节第 1 条一起在关口定。
2. **开放范围默认“对所有互认的人”**：一个 agent 变成公开时，白名单里的人立刻能直接调用，其余人第一次调用弹卡片。另一种是默认“只对指定人、名单为空”（谁都进不来，要主人再开）。推荐前者（设计里的例子和白名单的定义都按它写；变公开本身要 PIN）；P4-06 也可以在设为公开时一并要求选范围。
3. **“仅本次”只放行发起卡片的那一次调用**（安全审查 M-3 后改，按设计的字面）：等待期间并入同一张卡片的其它调用转到一张新卡片上，主人再决定一次。另一种做法是让原卡片继续为它们等着；选了新卡片，因为一张卡片只对应一个决定，审批列表和事件出口里的状态都清楚。
4. **授权不随开放范围变化删除**：从“对所有人”收窄到“指定人”时，名单外的人的授权保留但不起作用，改回“对所有人”时又生效。推荐维持（主人改回来时不必重新批准）；也可以收窄时一并删除。
5. **被拒后的 10 分钟冷却**照 limits.md 第 1 节实施（可调写的是“是”，本包没有做配置项）。

## 安全审查修改（唯一一轮，没有 High）

| 条 | 问题 | 修改 | 测试（去掉修改就失败） |
| --- | --- | --- | --- |
| M-1 | 调用开始时不再核对：`calls.begin` 直接登记；`wait` 对已决定的卡片回答当时的结果。撤销授权后照样能开始、永远进行 | `begin(principal, agentId, { ticket, stop })` 在一个事务里重新判断（认得、在范围内、直接放行 / 有授权 / 自己那张“仅本次”且还没用过），不行就 403 `not_admitted`；“仅本次”记 `used_at`，只开始一次；`wait` 对已决定的卡片按现在的情况回答（授权被撤销、对方被移除 → `canceled`） | `review M-1`（3 处变异各自失败） |
| M-2 | 外部签发方的人只按 `sub` 记，签发方被移除或换成另一个时，授权留着并转到新签发方同名的人 | 人的键是 `sub:` + 签发方与完整 `sub` 的哈希，卡片、授权、调用都记签发方；集中检查给这类来访者带上 `issuer`、`subjectHash`；换或移除签发方（`access.issuer.set`）时删掉别的签发方的人的授权、作废卡片、停调用（`issuer_changed`）；判断时签发方不是当前配置的就不认得 | `review M-2 / L-1 / L-3` |
| M-3 | “仅本次”放行并入的全部调用，主人看不到有几次 | 只放行发起卡片的那一次；其余转到新卡片；卡片、列表、通知标题显示等待的次数和不同 AI 的个数（`calls`、`waiting`、`actors`）；一张卡片上最多等 `CARD_LIMITS.callCardMaxWaiting`（16）次，多了直接拒绝 `too_many_waiting` | `review M-3 / L-2` |
| L-1 | 长 `sub` 被截到 200 字符后撞键 | 键用完整 `sub` 的哈希 | 同 M-2 |
| L-2 | 卡片可以被刷满，挤掉真的卡片 | 待批准的卡片总数 ≤ 200、同一外部签发方的人合计 ≤ 50（`callCardsPendingMax`、`callCardsPendingPerIssuer`，limits.md 第 1 节），多了直接拒绝 `too_many_requests`；列表里待批准的排在前面 | `review M-3 / L-2` |
| L-3 | 卡片上分不出联系人和外部签发方的人 | 外部签发方的人的显示名带“（外部签发方）” | 同 M-2 |
| L-4 | agent 没了，授权、范围、卡片还在 | `forgetAgent(id)`：删授权、范围、作废卡片、停调用（`agent_gone`）；删除会话时调用；兜底解析器不再把正在删除的会话当 agent | `review L-4 / L-5` |
| L-5 | 卡片等着时对方被加进白名单或名单，卡片还挂着 | 重新核对时，现在可以直接调用的人的卡片作废并以“放行”告诉等着的调用（`via: whitelist / listed / grant`） | `review L-4 / L-5` |
| L-6 | 私人 agent 回 `agent_private`，调用方能分辨它存在 | 对调用方一律 `agent_unknown` | T-2 / T-3 |
| L-7 | 等着的调用可能在一个随后回滚的变化里被告知“已作废” | 写进模块头注释和这里：调用方再调一次就得到新的回答 | —（文档） |

第 5 节“撤销即停”的表加两行：换或移除外部签发方（这个签发方的人的全部调用，`issuer_changed`），删除 agent（`agent_gone`）。数据库第 7 步还没合入任何地方，就地改了（加 `issuer`、`used_at` 列和 `invoke_request_calls` 表），没有另加一步。

## 留下的问题

- P4-04：按第 8 节接；名片只给 `canSee` 为真的人；`TASK_STATE_AUTH_REQUIRED` 期间调用方能取消（取消时 `wait` 的 signal 放弃等待，卡片照旧留给主人）。
- P4-06 / P4-07：登记 agent 解析器；收回私有、暂停之后调 `recheck({ agentId })`；“把会话设为公开”的接口是 `agent-exposure`，不在本包。
- P4-12：调用卡片的界面（审批页按 `respondVia` 带 PIN 决定）、开放范围与授权的设置页；审批讨论串是否支持调用卡片。
- 数据库第 7 步与并行的包可能撞号，合并时顺延。

## 关口决定

阶段 4 关口（2026-11-17）维护者答复“待维护者确认”第 1 条：**网页等读不要 PIN，命令行读仍要**。`GET /api/requests`、`GET /api/requests/:rid`、`GET /api/grants`、`GET /api/agents/:aid/audience` 改为 `PIN_ON_CLI`（网页、配对设备、外部签发方给主人的令牌不要；本机命令行仍要，命令行凭据可能是主人的 AI——`PIN_ON_CLI`，见 ADR-121 关口决定），处理函数不进 `commitLetIn`（`routes.ts` 的 `read`）；仍是 `daisy:grant`、主人的四个通道，AI 和来访者读不到。决定、撤销、改开放范围照旧 `letsIn` + PIN。命令行 `daisy request list|show`、`daisy grant list`、`daisy agent audience show` 照旧问 PIN。其余各条按推荐。
