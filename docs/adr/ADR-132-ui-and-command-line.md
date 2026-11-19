# ADR-132：界面与命令行——设置 › 对外、工作台的待批准调用、`daisy token`、“我的 agent”与“我的 AI 调用了谁”、网页与命令行一一对应的检查

- 日期：2026-11-17
- 状态：**已实施（P4-12，分支 `p4-12`，基于阶段 4 集成分支 `p4-gate`；未合入 `daisy-next`）**
- 工作包：P4-12（界面与命令行）；完成标志：设计的命令表里的命令全部可用，每个网页上的操作都有对应的命令（两类例外除外）
- 相关：设计要求——三种 agent；第三方 A2A 客户端；命令表、本地网页、本机接口分组；细分权限。契约 `token.md` 第 3、4.1、5、7 节，`scopes.md` 第 2 节，`limits.md` 第 5 节；ADR-107（定义表生成命令）、ADR-120（名片）、ADR-121（`letsIn`、`commitLetIn`、吊销登记处、`PENDING_REVOCATIONS`）、ADR-122（调用授权，读也要 PIN）、ADR-124（问与办）、ADR-125（公开 agent，`PublicAgentSection`）、ADR-126（常驻 agent，第 8 条隔离边界）、ADR-127（`a2a_calls`，“没有给主人看的页面和命令”）

## 背景

阶段 4 的前几个包把调用授权、名片、问与办、公开和常驻 agent、A2A 客户端的接口都做了，命令行由定义表自动生成，所以 `daisy contact / request / grant / agent` 大多已经有了；但本地网页几乎没有这些页面（只有 P4-06 在会话设置里放的公开开关），设计里补上的 `daisy token` 没有人做（P4-02 给它留了种类 `visitor-token` 和吊销种类 `visitor-tokens`，`PENDING_REVOCATIONS` 里还挂着），P4-08 说主人看不到“我的 AI 调用过谁”。

## 决定

### 1. `daisy token`（token.md 第 7 节）

| 接口 | 命令 | 权限 |
| --- | --- | --- |
| `POST /api/tokens` | `daisy token issue --for <联系人|me> [--ttl 7d] [--note …]` | `letsIn: "visitor-token"`（`daisy:grant` + PIN，`commitLetIn`） |
| `GET /api/tokens` | `daisy token list [--state all]` | `daisy:grant` + PIN（这一组读也要 PIN，ADR-122） |
| `DELETE /api/tokens/:jti` | `daisy token revoke <jti>` | `letsIn: "visitor-token"`（scopes.md“签发、吊销 daisy token”要 PIN） |

- **签出的令牌**完全照契约：`iss` = `aud` = 本 Daisy 的 URN；`sub` 是那位联系人的 URN（`me` 是自己的）；`scope` 只有 `daisy:invoke`；`client_id` 是 `token:<jti>`（`SelfIssuer.sign` 加了可选的 `jti`，先定 jti 再签）；没有 `act`；有效期默认 7 天、最长 90 天、最短 1 分钟（`TOKEN_LIMITS.visitor*`）。
- **只存记录**：结构第 13 步 `visitor_tokens`（jti、`subject`、`contact_id`、名字、备注、签发和到期时间、谁签的、吊销时间和原因、最近一次使用），不存令牌本身。令牌只出现在签发那一次的回答里；命令把它单独印在标准输出上（方便 `> 文件`），说明和“像密码一样保管”的提醒印在标准错误上；网页上显示一次，红框提醒，按“我已保存好”收起。审计只记 jti（`visitor-token.issue / revoke`）。
- **验证**（`access/visitor-tokens.ts`）：守卫按 `iss` 分流时，`iss` 是自己且 `client_id` 以 `token:` 开头的交给它（别的照旧当 AI 工作凭据）——本机的签名（`SelfIssuer.verify`，`maxLifetimeS` 90 天），然后核对：`aud` 只有一个、`scope` 恰好是 `daisy:invoke`、没有 `act`、`client_id` 正是 `token:<jti>`；再查记录（第 4.1 节第 7 步）：有、没吊销、`sub` 和到期时间与记录一致；是联系人的，联系人还在且 URN 一致。不合格一律 401 `invalid_token`，原因只进审计。两张面都收（A2A 入口在两张面上都有）。
- **身份**：来访者（`kind: "visitor"`、通道 `a2a`、标签 `daisy-token/<jti>`），只走 A2A 入口，本机接口一律 403 `a2a_only`。联系人的令牌就是那位联系人（`contactId`），调用授权、白名单、开放范围、卡片都和他自己签的令牌一样。`--for me`：`selfToken`——**主人以来访者身份**，不是主人：调用授权里是一个单独的人（键 `self`，显示“我自己（daisy token）”），开放给所有互认的人的 agent 第一次调用照样弹卡片、可以永久通过，只对指定人开放的 agent 调不到（指定人名单里只能放联系人）。- **任务归谁（审查 M-1）**：A2A 服务端里任务、对话的归属，列任务、查任务、接着对话，以及按调用方算的配额、频率和链路次数，一律按**这一张令牌**（调用方键 `token:<jti>`），不按人：同一个人的两张令牌互相看不到、接不上对方的任务；替联系人 X 签的令牌和 X 自己的 Daisy（键 `contact:<X>`）互相看不到；A 被吊销后，B 照样碰不到 A 的任务。调用授权里的“人”不变（联系人 X 或 `self`）：卡片、永久授权、白名单照旧按人，两张令牌在同一张卡片上等。执行方要显示调用方时，按 jti 查签发记录取名字。
- **结束**：主人吊销（立即，下一次请求 401；记录上的到期时间按本机时钟判断、不加时钟误差，过了就 401——签名检查允许的 60 秒误差不再让刚过期的令牌多用一分钟，审查 L-1；已经开始的任务不受影响——要停就撤销授权或收回 agent）；联系人被移除时他的令牌一并作废（在移除的同一个事务里，原因 `contact_removed`）；重置 PIN 时全部作废（吊销登记处的 `visitor-tokens` 钩子，在 `contacts` 之前登记，否则联系人的令牌会先被“移除联系人”带走、计数为 0；原因 `pin_reset`；没吊销的全部作废，包括刚过期的，审查 L-1），`PENDING_REVOCATIONS` 只剩 `devices`。同时有效的令牌最多 200 张（409 `too_many_tokens`）；过期或吊销 30 天后的记录在列出时清掉。
- P4-02 为它留的探针 `POST /api/tokens` 和真接口重了，删掉；`let-in.test.ts` 里借用它的四处改用 `allowlistAdd` 探针。

### 2. “我的 agent”：`GET /api/agents`（`daisy agent list`）

“调用授权”分组，`daisy:grant` + PIN（读也要，ADR-122），在 `commitLetIn` 里回答。列出别人能调用的 agent：公开 agent（P4-06 的 `public_agents`，按设为公开的先后）和常驻 agent（P4-07，所有状态，关闭的也列到删除为止），每个带开放范围（P4-03）、是否允许办（公开 agent；常驻的由它自己的配置决定，回 null）、等批准的卡片数、永久授权数。私人 agent 是其余所有会话，不列。网页的“三种 agent 与开放范围”就是这张表。

### 3. “我的 AI 调用了谁”：`GET /api/calls`、`GET /api/calls/:cid`（`daisy call list / show`）

P4-08 留下的。数据是 `a2a_calls`：我的哪个 AI（会话）、调用了哪位联系人的哪个 agent、问还是办、发了什么（最后一条消息的文本）、对方的状态（`STATE_LABEL` 的说法，P4-08 的表导出共用）、原因、答复（列表里截到 2000 字，`show` 全文）、对方附带的文件名、对方的 contextId / taskId、链路号和深度、轮询状态。

放在“会话”分组：它是主人读自己 AI 的记录，和读对话一样 `daisy:session:read`、不要 PIN、不审计；AI 的工作凭据调不到（它有自己的 `call_result`）。路径 `/api/calls…` 里没有 let-in 的保留词，而且是 GET：按 P4-02 的位置规则本来就不算“放别人进来”，不用写 `notLetIn`。

### 4. 本地网页

- **设置 › 对外**（`packages/ui/src/sharing.tsx`，放在“工作目录”之后）：一张总卡片说明这一组读和改都要 PIN，按“输入 PIN 查看”走现有的 `usePin()` 对话框（输一次，几分钟内的操作不再问；拿着的授权过期或被拒（`pin_required` / `pin_changed`）就忘掉，下一步重新问）。展开后：
  - **待批准的调用**：每张卡片写谁（`callerLine`：互认的联系人 / 外部签发方担保的人，标明签发方 / 自己的 daisy token）想调用哪个 agent，**在等几次调用、来自几个 AI 和是哪些 AI**（`waitingLine`，P4-03 审查 M-3），什么时候过期；三个按钮永久通过 / 仅本次 / 拒绝（PIN），可写附言；可切到“已处理的”。
  - **三种 agent 与开放范围**：先一句话讲清私人、公开、常驻；列出 `GET /api/agents`；点开一个：开放范围（所有互认的人 / 只对指定的人，勾联系人）、问与办（公开 agent：问在支线还是主线、强弱只读；允许办的开关和办的权限模式）、公开 agent 直接嵌 P4-06 的 `PublicAgentSection`（会串话的说明、收回私有）、常驻 agent 的编辑器。“把一个会话设为公开…”选一个会话，同样嵌 `PublicAgentSection`；“新建常驻 agent…”（名字、说明、harness、工作区、身份档、角色）。
  - **常驻 agent 编辑器**：状态与用量、A2A 地址；暂停（不要 PIN）、恢复（PIN）、关闭和删除（先确认，说明关闭是终结的）；分层提示词按 AI 收到的顺序列出，第一层 Daisy 的规则只读，后三层可改；权限模式、要确认的操作、并发、每日轮次、可用工具和目录（写明只有 Claude Code 能设）；来访对话列表。**允许 Bash 时**（工具没限制、`*`、或写了 `Bash…`）显示 ADR-126 第 8 条的隔离缺口（红色竖线）：共用工作区、别的对话的记录靠禁读规则和 auto 模式挡、建议只读工具或单独的工作区和身份档。
  - **永久授权**：谁 → 哪个 agent、外部签发方担保的人标出签发方；撤销（PIN），回报停下了几个调用。
  - **互认的名片与白名单**：导出我的名片（可填名字），可复制；**加名片先看**：贴进对方的名片 → “先看看是谁的”（`POST /api/contacts/inspect`，服务端验签名、算编号）→ 显示名字和**四个一组的完整编号**、核对说明 → 勾“我已经和对方当面或电话核对过这个编号”才能“加入通讯录”（带 `expectId` = 刚看到的编号，名片在这之间被换就对不上）；可同时加白名单；已在通讯录里的人提示用新名片替换（`update`）。列表：名字、编号、地址、白名单标记，加进 / 移出白名单、移除（先确认，说明他的授权、令牌和进行中的调用一并作废）。
  - **给第三方客户端的令牌**：给谁（我自己 / 各位联系人）、有效期（1 / 7 / 30 / 90 天）、备注，签发后显示一次；列表（有效的 / 全部）、吊销。
  - **我的 AI 调用了谁**（不要 PIN，总在页面底部）：每条写我的哪个 AI → 谁的哪个 agent、问 / 办和状态、链路号和深度、发了什么；点开取全文答复和对方的状态说明、文件名。
- **工作台**：有等批准的调用卡片时，左侧导航多一个“☎ 待批准的调用（n）”（数目来自 `GET /api/approvals` 里 `kind: "call"` 的待处理卡片，不要 PIN，15 秒刷新一次），点开是同一个卡片列表（要 PIN）。
- 手机宽度：所有行 `flexWrap`、最小宽度、没有固定宽的表格；浏览器测试在 390 px 宽下跑，页面不横向溢出。
- 文案都是中文。`packages/ui/src/sharing-view.ts` 放纯文字的部分（三种 agent、等待的说法、调用方的说法、三个选择、隔离缺口、令牌状态），测试直接用。
- P1-01 留给阶段 4 参考的旧界面 `packages/ui/src/_phase4/`（按群写的白名单、调用卡片、范围选择、旧“任务常驻 Agent”的向导）和它们的旧测试（`tests/_phase4/invoke-card-ui.test.ts`、`resident-lifecycle-ui.test.ts`、`e2e-resident.cjs`）删除；旧的服务端对话视图和它的两个参考测试（`resident-visible-paging`、`resident-and-reach-cases`）不在界面范围内，留到开源整理（ADR-126“没有动”的一节）。

### 5. 命令行与“一一对应”的检查

命令仍由定义表生成：本包新加的 `token issue / list / revoke`、`agent list`、`call list / show` 都是这样来的。`daisy token issue` 在 `cli/table.ts` 的 `EXTRAS` 里加了 `render`：令牌单独上标准输出，说明上标准错误（不重复令牌）。

`tests/p4-12-surface.test.ts` 把完成标志写成测试：

1. **设计的命令表**：从施工计划里命令表那一节本身读出 `daisy xxx`（表里的和“补上”的两条；计划不在公开仓库，没有它时这条测试跳过），每一个都必须是 `daisy` 的本地命令或定义表命令；`relay`（P5-02）、`pair`（P5-03）是阶段 5 的，**必须还不存在**——它们一出现测试就提醒把它们从待做名单里去掉。表一变（加删命令），测试要求同步。
2. **网页能调用的每条接口都有命令**：网页通道能调用、却没有命令的接口恰好是一张钉死的清单，每一项写明是哪一类——设计里的例外（回答自己 AI 的工具授权和提问：`approval.respond`、`session.answerApproval`，通道只有网页和配对设备）；由本地命令做（`autostart`、`open`、`status`）；不是主人的操作（网页自己的会话和注销、换 PIN 授权、实时通道、同一操作的另一种写法、给嵌入平台和推送发送方的接口）。新加一条网页接口而没有命令，测试失败。
3. **网页自己的代码**：扫 `packages/ui/src`、`packages/client/src` 里的每个 `api.<文件>.<接口>`，每一条都要在表里、有命令或在上面的清单里；并核对 P4-12 的页面确实用到了名片、调用请求、授权、agent、开放范围、问与办、公开、常驻、令牌、调用记录这些接口。

（P1-07 的 `tests/cli-principle6.test.ts` 按豁免理由的文字检查；新测试按接口编号钉死，两者并存。）

## 测试

- `tests/visitor-tokens.test.ts` 8 条（先写被拒绝的）：三个接口无凭据 401、命令行和网页没 PIN `pin_required`、AI `channel_not_allowed`、陌生 Daisy 的令牌 401；联系人的和 `me` 的令牌在本机接口上都是 `a2a_only`（包括换 PIN 授权）；伪造：没有记录、换了人、换了到期时间、多了 scope、带 `act`、`client_id` 不是自己的 jti、超过 90 天、别的钥匙签的、改了一个字节——每种单独成立（记录的到期时间对齐到伪造的那张），都 401、不说原因；同样写法签的“正常”令牌能过（证明是上面那些检查在拒绝）；签发时 91 天、30 秒、查无此人。令牌的声明逐项对照契约，令牌和签名不出现在数据库、审计和列表里。**第三方 A2A 客户端的路**：照第三方客户端那样（`fetch`、Bearer、不带扩展头）拿联系人 B 的令牌读名片、调用公开 agent，白名单直接完成，审计记 `daisy-token/<jti>`；`me` 的令牌弹卡片（“我自己（daisy token）”，不是联系人也不是外部签发方），仅本次后任务完成、没有永久授权。吊销、联系人被移除、上限 200。**重置 PIN**：真的 PIN 服务，重置后令牌 401，记录写 `pin_reset`，重置的汇总里 `visitor-tokens: 1`、不再是 pending。`daisy token issue / list / revoke` 经真实监听的 Daisy 和真 PIN。
- 安全审查（没有 High）的修订：`tests/visitor-tokens.test.ts` 加两条——**M-1** 两张 `me` 令牌各自只看得到、列得出自己的任务，接不上对方的任务，仍在同一张卡片上等（`waiting: 2`）；A 吊销后 B 仍碰不到 A 的任务；替 B 签的令牌和 B 自己的 Daisy 互相看不到任务。**L-1** 签名还在 60 秒误差内、记录已到期的令牌被拒；`revokeAll` 连刚过期的也作废。去掉对应修订，这两条都失败。**L-2** 权限矩阵（`tests/access.test.ts`）加两种身份：替联系人签的和 `me` 的 daisy token，按细分权限只能走 A2A 入口——整张表的每条接口（含实时通道的第一帧）都试，变成 158 条接口 + 4 个探针 × 19 种身份 = 3078 次；把 `me` 的令牌改成主人身份时矩阵失败（已核对）。
- `tests/p4-12-surface.test.ts` 7 条：上面三条检查；`GET /api/calls`（无凭据 401、AI `channel_not_allowed`；新的在前、按状态和联系人过滤、列表截断答复、`show` 全文、没有这次调用 404、不审计）；`GET /api/agents`（没 PIN 拒绝；公开 agent 带指定人范围和“不允许办”、常驻 agent 带一张等批准的卡片；私人会话不列；关闭的常驻 agent 列为已关闭）；页面文字（等待几次 / 几个 AI、外部签发方的标注、Bash 时的隔离缺口）。
- 改动的测试：`tests/let-in.test.ts`（`ROUTES_OF["visitor-token"]` 填上两条、“不输 PIN 放别人进来逐种被拒”的用例给 `tokenIssue` 的请求体 `{ for: "me" }`、`PENDING_REVOCATIONS` 只剩 `devices`、重置汇总的期望加 `visitor-tokens: 0`、借用探针的四处改用 `allowlistAdd`）；`tests/fixtures/let-in-probes.ts` 删掉令牌探针；`tests/access.test.ts` 的细分权限表加 `grant.tokenIssue / tokenList / tokenRevoke / agentList`（`grant` 行），`session.outgoing*` 按默认的主人行；`tests/api-defs.test.ts` 的 PIN 清单加四条。
- 浏览器：`scripts/e2e-sharing.cjs`（`npm run test:e2e:sharing`），390 × 844 的手机视口，夹具后端 `FIXTURE_SHARING=1`（PIN 已设、一个假 CLI 上的公开 agent、另一个 Daisy “B”有自己的钥匙和名片，驱动方要它调用时它的 AI 经 A2A 调用）：设置 › 对外 → PIN → 贴 B 的名片、先看（名字、四个一组的编号与 B 的编号一致，没勾核对时“加入”不可用）→ 勾上 → 加入；B 调用 → 卡片写着“在等 1 次调用，来自 1 个 AI：agent:b-research”和“互认的联系人” → 仅本次（PIN 还在，不再弹框）→ 没有永久授权；再调用 → 新卡片 → 永久通过 → 永久授权里有“B → 研究助手”，agent 那一行写“1 条永久授权”；页面没有横向溢出，没有页面错误。没有模型参与。
- 变异核对：去掉“已吊销就拒绝”“只能有一个 scope”“不能有 act”“client_id 是自己的 jti”“到期时间与记录一致”、去掉重置钩子、`me` 不标 `selfToken`、去掉上限，对应的测试都失败（“换了人”同时被“联系人 URN 一致”挡住，单去掉记录的 `sub` 比较不失败，两道检查重叠）。

## 待维护者决定的问题（第 2、6、7 条已答复，见“阶段 4 关口的决定”）

1. **`--for me` 的令牌**：做成“主人以来访者身份”（调用授权里一个单独的人 `self`，照常弹卡片、可以永久通过，指定人名单放不进去）。另一种做法是不支持 `me`（契约第 7 节写了 `me`，所以按契约做了）。
2. **令牌列表要 PIN**：与 P4-01 第 1 条、P4-03 第 1 条同一个问题（scopes.md 写读不要 PIN，这一组的规矩是读也要）；契约冻结前一起定。
3. **吊销令牌不停已经开始的任务**：只拒绝下一次请求。要停正在进行的，撤销授权或收回 agent（那两条会停）。
4. **数值**：默认 7 天、最长 90 天（契约的建议值）、最短 1 分钟、同时有效最多 200 张、结束 30 天后清记录（后三个是本包定的，写进了 limits.md）。
5. **联系人被移除时他的令牌一并作废**（记录留着，原因 `contact_removed`）；再加回来也不复活，要重新签。
6. **“我的 AI 调用了谁”不要 PIN**（按读会话记录对待，放“会话”分组）；`GET /api/agents` 要 PIN（“调用授权”分组）。
7. **网页上看名片的编号要先输 PIN**：网页靠服务端 `inspect` 验签名，而这一组都要 PIN，所以顺序是“输 PIN 打开这一组 → 贴名片 → 看编号、核对 → 加入”；命令行在本地验名片，编号在 PIN 之前就显示（P4-01 审查 M-1）。两边都是“加入之前先看到完整编号”。
8. **工作台的入口**：只有在有等批准的卡片时才出现“待批准的调用（n）”；卡片没有并进现有的“审批”面板（那里是替 AI 点头，不要 PIN、命令行做不了，两类东西分开放）。

## 留下的问题

- 命令表里的 `daisy relay`、`daisy pair` 是阶段 5（P5-02、P5-03）的；测试钉着它们“还没有”，到时候从待做名单里去掉。
- 以插件接入的组织内部界面要自己接调用卡片：按 `respondVia` 走 `/api/requests/:rid/decision`（带 PIN），本包的组件 `CallRequestList`、`SharingSettings` 从 `@daisy-ai/ui` 导出，可以直接嵌。
- 旧“任务常驻 Agent”在服务端的残留（`Session.kind === "resident"`、对话视图等）和两个参考测试，留到开源整理。
- 只在 macOS 本机验证；浏览器测试用系统的 Chrome。

## 阶段 4 关口的决定

阶段 4 关口（2026-11-17）维护者答复上面“待维护者决定的问题”第 2、6、7 条：**网页免 PIN，命令行仍要**（网页等主人入口读不要 PIN；本机命令行读仍要，命令行凭据可能是主人的 AI；写都要 PIN）。

- `GET /api/tokens`、`GET /api/agents` 改为 `PIN_ON_CLI`（只在命令行要 PIN），仍是 `daisy:grant`，AI 和来访者读不到。
- 网页设置 › 对外：去掉“输入 PIN 查看”这一步，打开就列出待批准的调用、agent、永久授权、联系人、令牌（`packages/ui/src/sharing.tsx`）；PIN 只在动手时要（批准 / 拒绝、改开放范围、问与办、公开、常驻 agent 的创建 / 修改 / 恢复、导入 / 移除名片、白名单、撤销授权、签发 / 吊销令牌），输一次几分钟内不再问。
- 第 7 条改了：**网页上先看名片、后输 PIN**——贴名片 → “先看看是谁的”（`inspect`，不要 PIN）→ 看名字和四个一组的编号、勾“已核对” → “加入通讯录”时才要 PIN。和命令行（本地验名片、PIN 之前显示编号）一致。
- 命令行：读照旧问 PIN（`daisy contact export|inspect|list|show`、`daisy request list|show`、`daisy grant list`、`daisy agent list`、`daisy agent audience|act show`、`daisy agent resident list|show`、`daisy token list`）——命令行按 `pinFor(def, "cli")` 决定问不问。
- 浏览器测试 `scripts/e2e-sharing.cjs` 改为：打开就看到空的联系人、agent、请求、授权，没有 PIN 框；贴名片、先看，仍没有 PIN 框；点“加入”才弹 PIN。
