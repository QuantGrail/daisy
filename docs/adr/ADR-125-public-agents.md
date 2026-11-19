# ADR-125：公开 agent——把会话设为公开或收回（PIN，讲清会串话）；外来任务标明来源；每个工具动作记下是哪次外来任务引起的

- 日期：2026-11-17
- 状态：**已实施（P4-06，分支 `p4-06`，基于 `p4-05`，已 merge `p4-08`；未合入 `daisy-next`）**
- 工作包：P4-06（公开 agent）
- 相关：旧版的约定（可被调用的 AI 不跑 bypass）、ADR-111（审计上下文）、ADR-121（`letsIn` / `commitLetIn`、重置 PIN 的吊销表）、ADR-122（调用授权、`forgetAgent`、`recheck`）、ADR-123（A2A 服务端）、ADR-124“留下的问题”（本包的接口）、ADR-127（链路深度）

## 背景

P4-03 / P4-04 / P4-05 把调用授权、A2A 服务端、问与办都做好了，但所有会话都是私人的（createApp 登记的解析器一律回 `kind: "private"`），`bypassPolicy` 的 `isPrivate` 一律为真，测试用夹具解析器把会话说成公开。ADR-124 列了本包要接的口：真正的解析器和目录、`isPrivate`、只能办的 agent 公开前要允许办、`source()` 的完整来源、外来任务的工具审计、收回 / 删除时的清理。另外 P4-08 报告：执行方为外来任务开的一轮没有写 `jobs.depth`，调用链的深度保护在真实执行方上断开（本包按调度要求 merge 了 `p4-08` 并补上）。

## 决定

### 1. 存哪里、谁是公开的

结构第 11 步（合并 P4-08 后：P4-05 第 9 步、P4-08 第 10 步）`public_agents(session_id, since, by)`：有一行就是公开，没有就是私有。不放进会话的 JSON：会话记录整条读改写，放在旁表免得别的写入把它冲掉；删除、收回只删一行。

`a2a/public-agents.ts` 的 `PublicAgents`：

- `resolve`（登记在 `invoke.agents.add`，比私有的兜底解析器先问）：有行、会话还在（没在删除）→ `{ kind: "public", name: 会话标题, sessionId }`。归档的会话仍解析为公开，执行方照 P4-05 回 `AGENT_UNAVAILABLE`。P4-05 的执行方（`handles`）自动接上。
- 目录 `a2a.directory.add(() => ids())`：每一项照旧只给 `canSee` 放行的调用方看。
- `bypassPolicy` 的 `isPrivate(s) = !isPublic(s.id)`：公开会话的身份不能存成跳过所有确认的模式（409）、换身份时同样检查、启动时 `migrate` 降级、`forLaunch` 去掉 bypass（旧版原有的机制，现在真的生效）。

### 2. 接口

- `GET /api/sessions/:id/public`（会话分组，`daisy:session:read`，不要 PIN；`daisy agent public show <id>`）：`SessionPublic`——是否公开、何时起、是否允许办、问怎么跑、`blocked`（现在为什么不能设为公开）、`crossTalk`（`CROSS_TALK_NOTE`：会串话那段话）。读自己的会话状态不算放人进来；“调用授权”分组整组 `daisy:grant` + PIN，所以读放在会话分组。
- `PUT /api/sessions/:id/public`（“调用授权”分组，`letsIn: "agent-exposure"` → `daisy:grant` + PIN，AI 不能做；`daisy agent public set <id> on|off`）：body `{ public: boolean }`。处理函数同步、在 `commitLetIn` 里写（ADR-121 第 4a 节）。已经是这个状态时什么都不改。位置是 ADR-121 留给 `agent-exposure` 的 `/api/sessions/:id/public`。
- 拒绝（409，先写的测试）：已归档 `session_archived`；「只问」支线或常驻 agent 的会话 `not_publishable`；身份跳过所有确认 `bypass_not_private`；没有只读模式（P4-05 `askRoute` 为 `none`）而办关着 `act_required`（设计要求：没有只读模式的 agent 只有允许办时才能公开）。
- 反过来，公开着的、没有只读模式的 agent 不能关掉办：`PUT /api/agents/:aid/act` `{act: false}` 回 409 `act_required`（关掉它就什么都答不了），先收回私有。
- 审计 `agent.public` / `agent.private`（种类和编号，没有 PIN）。

### 3. 会串话：界面和接口都先讲清

`CROSS_TALK_NOTE`（契约 `api/invoke.ts`）一处定义，接口说明、`GET`/`PUT` 的回答、网页共用：来访者读得到主线的上下文、回答里可能带出主人自己的工作；带办标记的请求进主线、按自动模式动手、一问一答留在主线里（ADR-124 待定第 1 条：“公开了别人就能办”）；要互不干扰用常驻 agent。

网页（会话设置，`PublicAgentSection`，最小实现）：显示公开 / 私有；“设为公开…”先展开这段话（红色竖线），按“我明白会串话，设为公开”才要 PIN；`blocked` 时按钮不可用并写明原因；“收回私有”同样要 PIN，回报停下了几个调用。开放范围、问与办的设置页、待批准的调用归 P4-12。

### 4. 收回私有、删除会话

收回（同步，在 `commitLetIn` 里）：删行 → `invoke.recheck({agentId}, {code: "agent_private", …})`（进行中的调用以“主人把这个 agent 收回了私有”停下，等批准的卡片作废）→ `invoke.forgetAgent(id)`（授权、开放范围、卡片）。

`InvokeAccess` 加 `onAgentGone(fn)`：`forgetAgent` 做完后同步通知每个登记者，各自清自己的：

- `AskAct`：删 `agent_act` 那一行（再公开时从默认开始）；
- `A2AServer.closeAgent`：这个 agent 所有没结束的任务以 `GRANT_REVOKED`（说明原因）结束——在跑的经 `job.signal` 让执行方撤掉排队的轮次、停下在跑的（P4-05 的取消路径，副作用不回滚）；等调用方补充的（包括重启前留下、没有登记调用的）和等主人批准的当场结束；
- `PublicAgents`：删 `public_agents` 那一行（删除会话的路径原来就调 `forgetAgent`，所以不用改 `sessions.ts`）。

P4-07 关闭常驻 agent 时调 `forgetAgent` 即可得到同样的清理。

### 5. 外来任务标明来源

`ask-act-prompt.ts` 的 `source()` 扩成完整一行：`来自 B（你的主人互认的联系人 / 外部签发方认证的人），经由对方的 AI「…」（或“对方没有说明经由哪个 AI”），经 A2A 调用你这个公开 agent「…」（常驻 agent 同样适用）；放行方式（白名单 / 指定人名单 / 永久通过的授权 / 主人这次批准）；任务 …，链路 … 第 n 层`。放行方式来自 A2A 服务端在 `begin` 时记下的 `a2a_tasks.via`，经 `A2AJob.via`（新的可选字段）交给执行方。别人写的短字段一律 `line()` 压平（开不了新段落），请求正文照旧在 `<external_message>` 里。

### 6. 每个工具动作记下是哪次外来任务引起的

`a2a/tool-audit.ts`：

- harness 自己的工具动作（Claude Code 的 Read / Bash / Edit…、Codex 的命令和补丁、ACP 的工具调用、子 agent、harness 自己拦下的操作）：Runner 第一次报告这个条目时（`/jobs/:id/events`，按条目编号判断“第一次”，更新不重复记），条目所属的一轮（条目编号的前缀）在 `a2a_turns` 里有记录，就记一条审计 `a2a.tool`：`object` `task:<taskId>`（和任务自己的审计同一个键）、`job_id`、会话、任务的链路号和深度、`route` `tool.<工具名>`、`target` `{task, agent, turn, tool, item}`；被拦下的 `outcome: denied`。不拷贝工具的输入（对话记录里有）。主人自己的轮次不记（设计只要求外来任务那一轮）。
- Daisy 自己的工具（`tool.wakeup`、`tool.call_agent`…，`observe/runner-trace.ts`）：照旧一条，外来任务那一轮的 `target` 加上 `{task, agent}`。

查法：`SELECT … FROM audit a JOIN audit_context c ON c.audit_id=a.id WHERE c.object='task:<taskId>'`，或按链路号。这不拦任何操作。

### 7. 办的过程中要确认的操作

不新增机制，核实端到端：办这一轮用 `auto`（P4-05），自动模式自己放行的工具不打扰主人；自动模式仍要确认的操作照常是 harness 的授权请求 → 主人「审批」里的卡片（旧版的审批机制）；任务在这期间保持 `TASK_STATE_WORKING`（不映射成 `AUTH_REQUIRED`——那是“等主人批准这次调用”；也不是 `INPUT_REQUIRED`——那是等调用方）；主人答复后这一轮接着跑完，任务完成。

### 8. 链路深度（P4-08 报告的缺口）

P4-05 的执行方插入 `jobs` 时写 `trace` 和 `depth`（任务的链路号和深度），于是这一轮 AI 自己的 `call_agent` 以深度 + 1 发出，到上限（8）在发出前拒绝。

### 9. 重置 PIN

照 ADR-121 现在的表：`agent-exposure` 的 `revokes` 是 null，**重置 PIN 不把公开 agent 收回私有**（维护者对 P4-02 待确认第 2 条的答复是“不收回公开 agent”；P4-02 审查 H-1 只把对外面改成了要收回）。重置吊销全部名片、调用授权、签发方、设备，公开 agent 没有人进得来；重新设好 PIN、重新加了联系人之后，它们仍按开放范围（默认第一次调用要批准）对外。没有登记吊销钩子，`PENDING_REVOCATIONS` 不变。

## 测试

`tests/public-agent.test.ts`（8 条；真实 A2A HTTP + 进程内 Runner + 假 Claude Code / Codex / ACP；B 是白名单里的联系人；用真实接口设为公开，没有夹具解析器；先写被拒绝的）：

- 要 PIN：没有 PIN 授权 403 `pin_required`、什么都没存；来访者 403；私有会话没有名片、调用 404、目录为空；`GET` 不要 PIN，`crossTalk` 是会串话那段话；归档 409 `session_archived`；不存在 404。
- 不跑 bypass：Codex 身份在 never + danger-full-access 时 409 `bypass_not_private`；改回默认后公开；公开期间把身份存成 bypass 409；收回后可以。
- 只能办的 agent：Antigravity（没有只读）办关着时公开 409 `act_required`、`blocked` 写明；允许办后公开；公开期间关办 409；问 `ASK_NOT_SUPPORTED`、办完成。
- 公开：解析为 `public`、目录列出、名片可读、问完成；再设一次什么都不改；审计一条、没有 PIN。
- **A-9**：办的提示词里有完整来源（联系人、经 A2A、公开 agent 名、白名单放行、任务号、链路号和层数、“不是你的主人亲自下的指令”）；这一轮 `jobs.trace` / `depth` 是任务的；三个工具动作各一条 `a2a.tool`，`object` 是任务、`job_id` 是这一轮、链路号和深度是任务的；主人自己的一轮不记。
- **A-4**：办里两个工具自动放行、没有卡片，第三个（`rm -rf build`）是一张给主人的卡片，在「审批」列表里；调用方看到 `WORKING`，过一会儿仍是；这一轮 `auto`、没有 bypass；主人批准后完成、答案返回，确认过的那个操作也审计在任务下。
- 收回私有：等调用方补充的问、排在主人这一轮后面的办都以“收回了私有”被拒；排队的办没跑（`interrupted`），主人那一轮照常、没被停；开放范围和办的设置清掉；名片 404、调用 404、目录里没有；再公开时办的设置回到默认。
- 删除公开会话：行、办的设置、等补充的任务都清掉，解析不到。

`tests/a2a-client.test.ts` 加一条（P4-08 的缺口）：B 的会话用真实接口公开、由 P4-05 的执行方跑办；A 在深度 6 请 B 办 → B 的任务和这一轮在 7，B 的 AI 回调 A 以 8 发出、A 收到 8；A 在深度 7 → B 的一轮在 8，B 的 AI 回调在发出前被拒（“调用链已达 8 层上限”），什么都没发。去掉 `depth` 那一列时这条失败（已核对）；把 `isPrivate` 改回一律真、去掉工具审计的挂接时不跑 bypass 和 A-9 两条失败（已核对）。

假 CLI（Claude Code）加 `FX_TOOL <名字> <命令>`（自动放行的工具动作）和 `FX_CONFIRM <命令>`（自动模式仍要确认的一个 Bash 授权请求，主人答复后结束这一轮）。

跟着改的：权限矩阵、`api-defs` 的 PIN 清单、`let-in` 的 `ROUTES_OF["agent-exposure"]` 加 `grant.publicSet`；`invoke-access` 的分组路由数；`docs/api` 重新生成。

## 待维护者确认（先照推荐做）

1. **重置 PIN 不收回公开 agent**（ADR-121 表、P4-02 第 2 条的既定答复）。如果要收回：把 `LET_IN["agent-exposure"].revokes` 指向一个新种类、在 `PublicAgents` 登记钩子删全部行即可。
2. **读“是否公开”不要 PIN**（会话分组），改是 `daisy:grant` + PIN。与“调用授权”分组“读也要 PIN”的规矩不同，因为这是主人自己会话的状态，网页每次打开设置都要 PIN 太烦。
3. **收回私有时，授权、开放范围、问与办的设置全部清掉**（调度的要求：收回即 `forgetAgent` + 删 `agent_act`），再公开从默认开始（对所有互认的人、第一次调用要批准、允许办、auto）。也可以保留到再公开时沿用——推荐清掉（收回是“不再对外”，留着的授权容易被忘）。
4. **公开着的、没有只读模式的 agent 不能关办**（409，先收回）。另一种做法是关办时自动收回私有；推荐拒绝（不替主人做第二件事）。
5. **归档的公开会话仍是公开的**（名片可见、调用回 `AGENT_UNAVAILABLE`），恢复后照常可调；不能把已归档的会话设为公开。
6. **工具审计只记外来任务那一轮的工具动作**，主人自己的轮次不进审计（对话记录里有）。

## 留下的问题

- 运行中能力变化：一个已公开的 agent 后来变成没有只读（主人关了支线、Runner 降级），而办关着时，它什么都答不了；不自动收回，`GET` 的 `ask.readOnly` 会显示 `none`。
- 界面只做了会话设置里的开关；开放范围、问与办的设置、待批准调用的页面归 P4-12。
- 结构第 11 步可能与并行的 P4-07 撞号，合并时顺延。只在 macOS 本机验证。
