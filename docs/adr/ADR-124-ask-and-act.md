# ADR-124：问与办——公开 agent 的执行方：问走只读支线（不行就主线只读排队，再不行就拒绝），办排在主人这一轮后面；是否允许办与办的权限模式

- 日期：2026-11-17
- 状态：**已实施（P4-05，分支 `p4-05`，基于 `p4-04`，已 merge `p4-10`（含 `p4-11`）和 `p4-04` 的审查修订；未合入 `daisy-next`）**
- 工作包：P4-05（问与办）
- 相关：契约 `a2a-usage.md` 8.1、13；旧版的「只问」支线（@ 某个 AI 只问不打断，从主线分出只读支线回答；Claude 在线时用原生旁问，Codex 一次性只读分叉）、旧版的约定（可被调用的 AI 不跑 bypass）、ADR-121（`letsIn` / `commitLetIn`）、ADR-123 第 5 节（执行方接口）、ADR-130（ACP harness 的只读值）、ADR-131（`readOnly`、`askOnly` 声明）

## 背景

P4-04 把“这个请求在这个 agent 上怎么跑”留给执行方（`ctx.a2a.executors.add`），没有执行方时被放行的调用一律 `AGENT_UNAVAILABLE`。设计定了公开 agent 的两种被调用方式：问（默认）在主线的只读支线上立刻回答，主线下一轮只收到一句摘要；办（`A2A-Extensions` 启用了办扩展、`metadata` 里 `mode` 是 `act`，P4-04 已判定为 `job.mode`）进主线、排在主人当前这一轮后面。harness 不支持旁问和分叉时问回落到主线排队、仍然只读、结果里注明；没有只读模式的 harness 不接受问。旧版的「只问」支线在 P1-01 拿走群聊后只剩存储、限额、摘要和 Runner 端的只读启动，路由没有了。

P4-04 的分支上还没有 P4-11 的能力声明（`readOnly` 强弱、`askOnly`）和 P4-10 的 ACP harness 表，所以本包先 merge 了 `origin/p4-10`（它已含 `p4-11`）。

## 决定

### 1. 执行方与它管哪些 agent

`packages/daisy/src/a2a/ask-act.ts` 的 `AskAct`，createApp 里 `a2a.executors.add((agent) => askAct.handles(agent) ? askAct.executor : null)`：只管 `kind: "public"`、背后有会话（`sessionId`）的 agent。P4-06 之前所有会话都是私人 agent，本包的测试用一个夹具解析器把几个会话说成公开的。常驻 agent（`kind: "resident"`）不归它管（P4-07 登记自己的，常驻不分问和办）。

`run(job)` 先查会话还在、没归档、主人设了 PIN（没设 PIN 时不启动任何 AI 轮次）、设备没停用，否则已拒绝 `AGENT_UNAVAILABLE`。一个任务的续写（需要输入之后）在第一轮跑的那条线上接着跑（`a2a_turns` 记着第一轮的种类）。

### 2. 问在哪里跑：按能力声明，三种结果

`askRoute(会话)` 读节点报告里这个 harness 的声明（`featuresFor` + `agentFeatures[agent].readOnly.opts`），得到只读强度（契约 8.1 的 `readOnly`）和在哪里跑（`ranOn`）：

| 情况 | `readOnly` | `ranOn` | 怎么跑 |
| --- | --- | --- | --- |
| 声明了只读（`readOnly` 非 none）且有旁问或分叉（`askOnly` 非 none），节点的 Runner 跑支线（`askSidecar`），主人没关支线 | 声明的强度（Claude Code、Codex：strong） | `branch` | 第 3 节 |
| 有只读、但没有旁问和分叉（Kimi Code、OpenCode：`askOnly` none），或 Runner 不跑支线、主人关了支线 | Kimi Code / OpenCode：weak（弱只读也接受问，如实声明）；Claude Code 的 plan：weak | `main-queue` | 第 4 节 |
| 没有只读（Antigravity、DeepSeek Harness 经 ACP），或主线上没有能逐轮切换的只读模式（Codex 的只读是启动时的沙箱，只有支线能用） | `none` | — | 已拒绝 `ASK_NOT_SUPPORTED`，说明里提示主人允许时可以办 |

主线上的只读模式：声明里的 `readOnly.opts.mode`（ACP 条目的 `plan`），没有就 Claude Code 的 `plan`。Claude Code 的 plan 只靠 harness 自己遵守，所以在主线上按 weak 报。

### 3. 只读支线

沿用旧版「只问」支线的机制，不另起一套：每段来访对话（contextId）一条支线 `sidecarFor(主线, "a2a:<contextId>", …)`，它是主线的隐藏会话；Runner 端照旧——Claude Code 主线进程在线时用原生旁问（`side_question`，借主线此刻的上下文、没有工具、不进主线历史、不打断主线），否则 `--resume <主线> --fork-session` 分叉出一个只有 Read / Grep / Glob、`--permission-mode dontAsk`、没有 MCP 的进程；Codex 每问一次只读沙箱的临时分叉（`ephemeral`）。支线的任何审批请求 Runner 自己拒绝，不发给主人。限额照 `ASK_SIDECAR`：每条主线同时 2 个、每 24 小时 30 次；超过同时数时任务停在“已提交”等前面的结束（同一段对话的支线已经在跑时直接排在它后面），超过每日次数已拒绝 `QUOTA_EXCEEDED`。

支线这一轮最后的回答就是任务结果。提示词要它在回答后另起一行写 `===给主线的摘要===`，下面一句话；Daisy 把这一句（没写就机械节选问和答）按 `sidecars.keep` 留给主线，主线下一轮由原来的 `carry` 带上（引作外部资料，只带一次，失败了下次再带）。主线里因此只多这一句。问答也记进支线的 `history`（旧版就有），给之后的临时分叉补上下文。

### 4. 回落到主线排队，仍然只读

和办一样进主线、排在主人当前这一轮后面（第 5 节），区别是这一轮的权限模式换成第 2 节的只读模式，提示词写明只读。结果里：`notes` 一句“这个 AI（…）不支持旁问和分叉：这次‘问’回落到主线上排队执行，仍然是只读的（弱只读，靠 harness 的规划模式）”，`metadata` `{mode: "ask", readOnly, ranOn: "main-queue"}`。完整的一问一答留在主线里（这是回落的代价，设计本来就这么写）。

**每一轮的权限模式**：新表 `a2a_turns`（结构第 9 步）记外来任务起的每一轮（job → 任务、agent、主线、种类、权限模式）。`jobPayload` 发给 Runner 时用它覆盖身份档的 `permissionMode`；覆盖之后如果是跳过所有确认的模式，换成这个 harness 的默认模式（旧版的约定：外来任务永远不跑 bypass；`bypass.forLaunch` 本来也会因为请求号带前缀而去掉，这里再兜一次）。权限模式不同，ACP harness 的进程按启动键重开（模式是启动键的一部分），Claude Code / Codex 在线切换。顺带修了 `harness/acp.ts` 的一个洞：前一轮设了模式（`plan`）、这一轮身份档没写模式时，原来什么都不发，会停在 `plan`；现在回到 harness 的默认模式。

### 5. 办

办进主线：主线有正在跑或已排队的轮次时，这一轮以 `pending` 进队列、任务回到“已提交”（`job.queued()`），主人这一轮照常跑完、不被打断；轮到它、Runner 认领时任务回到“工作中”（`job.working()`）。办这一轮的权限模式取主人的设置（第 6 节），默认 `auto`（设计：跟随会话的权限模式，默认自动）。结果 `metadata` `{mode: "act"}`。整个一问一答留在主线里。

外来的轮次在主线里有自己的标记：`jobs.origin = "a2a"`、请求号 `a2a:<taskId>:<n>`、用户气泡带 `origin`（`place` 写“A2A · 办”或“A2A · 问（只读）”）。所以它们不会被当成 Daisy 的唤醒自动追加进主人正在跑的这一轮（`daisyWake` 只认 schedule / collab），不会和主人的消息合并（`mergeKind` 见到 `origin` 就不合并），失败时也不暂停主人的队列（`othersJob`）。每条主线最多排 20 条（和主人自己发的一样），满了已拒绝 `QUOTA_EXCEEDED`。

同一段对话先问后办：contextId 不变；办这一轮的提示词带上这段对话之前的请求和回答（P4-04 给的 `job.history`，引作外部资料），问留下的那一句摘要也正好随这一轮带进主线。

### 6. 两项设置：是否允许办、办的权限模式

结构第 9 步 `agent_act(agent_id, act, permission_mode, updated_at)`。没有记录就是默认：允许办，权限模式 `auto`（harness 有这一档时；OpenCode 这类没有的跟随会话）。`permission_mode` 为 NULL 表示跟随会话（身份档）的。

接口在“调用授权”分组（`api/invoke.ts`），位置是 P4-02 留给 agent 的 `/api/agents…`：

- `GET /api/agents/:aid/act`（`daisy agent act show`）：`daisy:grant` + PIN（这一组读也要 PIN，ADR-122 的规矩）。回答两项设置、可选的模式（去掉 bypass 的那一档）、问现在怎么跑（`readOnly`、`ranOn`、为什么）。
- `PUT /api/agents/:aid/act`（`daisy agent act set <aid> --act false --permission-mode auto|session|…`）：**`letsIn: "agent-exposure"`**。ADR-121 第 1 节的表把“设置是否允许办”明确放在 `agent-exposure` 一行（和“把会话设为公开”同一种），不是 `agent-audience`：开放范围管“谁能调用”，这一项管“调用进来的人能做什么”——允许办就是让别人按这个权限模式在主线上动手，和公开一个会话一样是扩大别人能做的事。关掉办和改模式也走同一条接口、同样要 PIN（设计的权限表那一行没有分开；ADR-121 第 3 节“留出的位置上的收窄按字面要 PIN”）。处理函数同步、在 `commitLetIn` 里写（ADR-121 第 4a 节），记审计 `a2a.act.set`。重置 PIN 不收回它（ADR-121 第 5 节：`agent-exposure` 没有对应的吊销——名片、授权都没了，没人调得进来）。
- 跳过所有确认的模式（Claude `bypassPermissions`、Kimi `yolo` 等）400 `mode_not_allowed`；不认识的模式同样 400，说明里列出可选的。
- 关掉办：还在排队、没开始的办一并撤掉（任务已拒绝 `ACT_DISABLED`，回答里 `withdrawn` 是个数）；已经在跑的照常跑完（副作用已经开始，停下也不回滚）。之后带办标记的调用当场已拒绝 `ACT_DISABLED`，问照常可用，主人自己的轮次不受影响。

### 7. 名片的“办”扩展（契约 8.1、13）

执行方接口加一个可选的 `describe(agent)`，A2A 服务端生成名片时问它：`params: { act, readOnly }`——`act` 是现在是否允许办，`readOnly` 是第 2 节的强度。`weak` 时名片 `description` 末尾加契约第 13 节那句“只读保证：弱。……”（`WEAK_READ_ONLY_NOTE`，在 `contracts/src/a2a.ts`）；`none` 时描述改成“它不能只读地回答‘问’，只接受‘办’（如果它允许）”。扩展仍然 `required: false`。

### 8. 需要输入、取消、结果

- **需要输入**：提示词告诉 AI，不先向对方确认就没法回答或继续时，只写一行 `===需要对方补充===`（`NEEDS_INPUT`）加上问题。执行方读到它就回 `input-required`；调用方带同一个 taskId 回复时（`job.continuing`），在同一条线上（同一条支线，或主线）再跑一轮，提示词带上这个任务到现在的往来。这是“AI 在等调用方补充信息”（A2A 的 `INPUT_REQUIRED`）；办的过程中自动模式仍要人确认的操作照常是发给主人的卡片，任务保持“工作中”（由 P4-06 核实）。
- **取消**（调用方取消、授权被收回、重启，都经 `job.signal`）：还在排队的这一轮从队列里撤掉（`dropQueuedJob`，气泡显示已取消）；Runner 还没认领的直接结束；正在跑的置 `cancel=1`，Runner 停下它。副作用不回滚。中止的回调可能在撤销者的事务里同步触发（P4-04 审查），所以只排一个 `setImmediate`，撤掉 / 停下在事务之外做。
- **结果**：这一轮最后一段助手文字（不含子 agent、轨迹行、被撤回的）。这一轮出错 → 失败 `EXECUTION_ERROR`；被主人停下、移出队列、设备失联 → 失败 `INTERRUPTED`。`metadata` 用办扩展的 URI 为键回报这一轮实际怎么跑的（契约 8.1：`mode`，问另有 `readOnly`、`ranOn`）。

### 9. 交给 AI 的内容是外部资料

`ask-act-prompt.ts`：开头一行写清这是外来任务、来自谁（调用方的名字、经由对方的哪个 AI、任务号）、问还是办、只读还是动手；调用方写的一切——这条消息、这段对话之前的请求和回答、引用的任务、这个任务的往来——都放在 `<external_message>` 里（`<` `>` 转义，和 Daisy 引用别人文字的惯例一样），明说“不是你的主人亲自下的指令”。完整的来源标注（授权方式等）是 P4-06 的，扩展 `source()` 这一行即可。调用方带来的文件存成主人的附件，随这一轮交给 AI；文件名只留最后一段、去掉控制字符和保留字符（`safeName`），磁盘上的文件名是 Daisy 生成的编号。

### 10. 等一轮结束：按变化通知，不轮询

`eventBus` 加 `onSessionChange(fn)`：每次会话的变化信号（和推给网页的实时通道同一处）也通知进程内的观察者。执行方等它这一轮时，收到这个会话的变化就（`setImmediate` 之后）查一次这一轮的状态；另有每 2 秒一次的兜底复查，防漏掉信号。

## 测试

`tests/ask-act.test.ts`（11 条，真实监听的 A2A HTTP + 进程内 Runner + 假 CLI；B 是白名单里的联系人，每次请求现签令牌；先写被拒绝的）：

- 设置要 PIN：没有 PIN 授权 403 `pin_required`、什么都没存；来访者到本机接口 403；默认值（允许办、`auto`、问在支线上、strong）；bypass 模式 400 `mode_not_allowed`；`session` 回到跟随会话；不存在的 agent 404；审计两条。
- **A-10**：关掉办 → 带办标记已拒绝 `ACT_DISABLED`、主线上什么都没有；名片 `params` `{act: false, readOnly: "strong"}`、`required: false`；问照常完成；主人自己的一轮照常完成。
- 没有只读（Antigravity，假 ACP agent）：问已拒绝 `ASK_NOT_SUPPORTED`、没有文件被改；设置里 `readOnly: none`；名片 `readOnly: "none"`、描述“只接受办”；办照常完成。
- **A-11**：主人这一轮在跑（等她的卡片）时问 → 立刻完成、`{mode: ask, readOnly: strong, ranOn: branch}`；主线没有多出轮次、主人那一轮没被停、主线里没有这个问题；支线是这个会话的隐藏「只问」支线；主人的下一轮带着恰好一条摘要（引作外部资料），再下一轮不再带。
- **A-12**：Claude Code 的支线（只有 Read,Grep,Glob、`dontAsk`）和 Codex 的支线（只读沙箱）里要求改文件 → 没有文件被改；同一个 Codex 会话主人自己的一轮能写（证明假 CLI 只按沙箱拒绝）。
- **A-17**：Kimi Code（假 ACP agent，没有旁问和分叉）：设置里 `main-queue`、`weak`；名片描述以弱只读那句结尾、`readOnly: "weak"`；主人这一轮在跑时问 → “已提交”、主人那一轮照常；她结束后问在主线上跑、结果注明回落、`{mode: ask, readOnly: weak, ranOn: main-queue}`、文件没被改；记录里先 `session/set_mode plan` 再这一轮的 prompt（同一进程），主人的下一轮不在 plan（换了进程或设回 default）且能写文件。
- 需要输入：支线反问 → `INPUT_REQUIRED`、问题在 `status.message`；调用方带同一 taskId 回复 → 同一条支线上完成，第二轮提示词带着往来。
- **A-8**：主人这一轮在跑时办 → “已提交”、排在后面（`pending`）、主人那一轮没被停；她结束后办跑完、`{mode: act}`、两轮都正常完成、主人那一轮没有中断的说明；办这一轮用 `auto`（启动参数或在线切换里看得到）；主线里有“A2A · 办”的气泡。
- **A-13**：同一 contextId 先问后办 → 办在主线上、contextId 不变、任务号不同；办这一轮的提示词里有之前的问和答，问的那一句摘要随这一轮带进主线。
- 取消：排队中的办被取消 → 已取消、这一轮被撤出队列、主人那一轮照常；另一个排队中的办在主人关掉办时被撤掉 → 已拒绝 `ACT_DISABLED`（`withdrawn: 1`）。
- `safeName`：`../../etc/passwd`、反斜杠路径、全点、控制字符。

假 CLI 加了三处（只在测试里）：Claude Code 的 `FX_WRITE` / `FX_SAY`（只有读工具或 plan 模式时不写，旁问也认 `FX_SAY`）；Codex 按线程记沙箱，只读沙箱里 `FX_*` 文件改动一律拒绝；ACP agent 记每个会话的模式，plan 时 `FX_WRITE` 不写，新进程从默认模式开始。

跟着改的：表驱动权限矩阵加 `grant.actShow`、`grant.actSet`；`api-defs` 的 PIN 清单加这两条；`let-in` 的 `ROUTES_OF["agent-exposure"]` 填上 `grant.actSet`；`invoke-access` 的分组路由数 7 → 9、`letsIn` 表、“什么都没改”加 `agent_act`。`docs/api` 重新生成。

## 待维护者确认（先照推荐做）

1. **办默认允许，默认 `auto`**。设计写的是“主人可以按 agent 关掉办”“默认自动”，契约名片示例 `act: true`，所以默认开；公开一个会话本身要 PIN（P4-06），那时界面要讲清楚“公开了别人就能办”。如果要默认关，改 `AskAct.settings` 的一行。
2. **设置用 `letsIn: "agent-exposure"`，关掉办也要 PIN**（ADR-121 第 1、3 节的字面）。读也要 PIN（这一组的规矩）。
3. **没有支线时，Claude Code 在主线上用 plan 模式回答问，按弱只读报**；**Codex 没有支线时不接受问**（它的只读是启动时的沙箱，主线上不能逐轮切）。这两种只在 Runner 太旧或主人关了支线时出现。
4. **主线收到的“一句摘要”仍走旧版「只问」的带入块**（一个固定的抬头加引起来的一句），不是光秃秃的一句话。
5. **关掉办只撤掉还没开始的办**，正在跑的跑完。
6. **需要输入用文字标记 `===需要对方补充===`**（和 `===给主线的摘要===` 同一个办法），不是 harness 的“提问”卡片——那是问主人的。
7. **Kimi Code / OpenCode 的问回落到主线**：它们经 ACP 声明了 `session/fork`，可以做“分叉 + plan”的只读支线（ADR-130 留给本包），但那要改 Runner 端的 ACP 适配器（分叉出来的会话怎么起、怎么关、`askOnly` 声明怎么改），本包没有做，测试 A-17 正是用它们验证的回落路径。

## 留下的问题

- **P4-06（公开 agent）**：登记真正的解析器（`invoke.agents.add` 回 `kind: "public"`、`sessionId`），执行方自动接上（`handles`）；目录 `a2a.directory.add`。`bypassPolicy` 的 `isPrivate` 对公开会话要回 false（现在一律 true；外来轮次已经在 `jobPayload` 里另行挡住 bypass）。公开时如果 `GET /api/agents/:aid/act` 的 `ask.readOnly` 是 `none` 而办没开，拒绝公开（设计要求：没有只读模式的 agent 只有在主人允许办时才能公开）。完整的来源标注扩展 `ask-act-prompt.ts` 的 `source()`；外来任务的工具审计用 `a2a_turns`（job → taskId）。办在自动模式下要确认的操作照常是主人的卡片，任务保持“工作中”（本包没把它映射成 `AUTH_REQUIRED`）。收回公开 / 删会话时 `invoke.forgetAgent` 并删 `agent_act` 那一行（本包没做清理）。**已由 P4-06 做完，见 ADR-125**；P4-06 另把执行方的一轮补写了 `jobs.depth`（P4-08 的调用链深度保护）。
- **P4-07（常驻 agent）**：`handles` 对 `kind: "resident"` 回 false，登记自己的执行方；可以复用 `askActPrompt` / `readAnswer` / `NEEDS_INPUT` 和 `ctx.onSessionChange`（等一轮的写法见 `AskAct.wait`）。
- ACP harness 的分叉只读支线（上面第 7 条）。
- 支线的限额是每条主线共享的（`ASK_SIDECAR`），没有按调用方分；P4-04 正在加按调用方的任务 / 对话上限。
- 合并时：结构第 9 步可能与并行的包撞号，顺延；`api/invoke.ts` 分组多了两条。只在 macOS 本机验证。

## 关口决定

阶段 4 关口（2026-11-17，维护者的决定）：`GET /api/agents/:aid/act`（`daisy agent act show`）**网页等不要 PIN、命令行仍要**（`PIN_ON_CLI`），仍是 `daisy:grant`，AI 读不到；设置（`PUT …/act`）照旧 `letsIn: "agent-exposure"` + PIN。其余待确认各条按推荐。

## 补记 P4N-4（2026-11-18，阶段 4 真机检查，只调查）

**现象**：第一次向 Codex 公开 agent「问」列工作目录，只读支线答“这条支线要求只读，但当前环境未提供可用的文件读取工具”；同样的第二、三次都列出来了。

**查到的**：Codex 的「问」每次都是同一条路——主线线程的一次性只读分叉（`thread/fork`，`ephemeral`，`CODEX_SIDECAR`：`sandbox: read-only`、`approvalPolicy: never`、不挂 MCP、关网页搜索），第一次和之后没有配置差别；沙箱允许读，Codex 自己的 shell 命令能列目录。提示词也没有说不能读（`askActPrompt` 写的是“只能读文件、查已有的内容、回答”）。差别在于：分叉出来的线程**仍然列着主线的 Daisy 工具**（`harbor_bash` 等，ADR-154 之前开始的线程里的旧名，随线程保存，旧版就已知），支线调用时 Runner 回的是一句“只问支线是只读的、不能使用这些工具”。模型如果先去调 `harbor_bash` 列目录，拿到的就是这句——和它的回答几乎一字不差（“只读” + “没有可用的工具”），它据此以为什么都不能读。之后两次它直接用了自己的命令。主人的数据没有读，所以“第一次调了 `harbor_bash`”是推断，不是核实；模型每次选不选这个工具本来就不固定。

**改了什么**：只改那句拒绝的话（`SIDECAR_TOOL_REFUSAL`，`turns/sidecar.ts`）：“这是 Daisy 的工具（daisy_*，较早开始的对话里叫 harbor_*），只问支线里不能用。只读不等于不能读：读文件、列目录、搜索请直接用你自己的命令（这条支线的沙箱允许读、不允许写）。”支线说明本身（`SIDECAR_GUIDE`）没动：它和旧版原文逐字对照、钉在快照里。测试：`tests/ask-act.test.ts` “P4N-4” 一条（主线有工具后经 A2A 问、支线调 Daisy 的 bash 工具 → 被拒、新措辞、分叉是只读沙箱、Daisy 没有替它跑任何东西）。

**没做的**：在分叉时把 Daisy 工具从线程里去掉——Codex 的 `thread/fork` 不收 `dynamicTools`，做不到。
