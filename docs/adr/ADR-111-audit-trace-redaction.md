# ADR-111：审计、链路号与脱敏——一处记、一个号、一层滤

- 日期：2026-11-17
- 状态：**已实施（P1-11）**
- 工作包：P1-11（审计与日志）
- 相关：设计要求——可追溯（每个动作记下是谁、经什么通道、对什么做的）；日志和错误信息里不出现凭据和令牌；查看日志和审计：主人本人、命令行可以，AI 不行。契约草稿 `docs/contracts/trace.md`；ADR-106（一个进程、`RunnerPort`）、ADR-107（接口定义）、ADR-110（集中检查、拒绝的审计）

## 背景

P1-03 之后，被拒绝的请求在 `guard.ts` 里记一条 `access.denied`；放行的请求只有各处理函数自己零散记的领域审计（`session.create`、`profile.delete`……），记的是 `user_id`、动作、目标三样，不知道经哪个面、哪个通道、哪条接口、结果如何，也没有链路号。日志是散在各处的 `console.*`，Runner 里有一个只认 `sk-…` 和 `Bearer …` 的局部脱敏函数。

## 决定

### 1. 链路号（`packages/daisy/src/observe/trace.ts`）

- 格式照 trace.md 第 2 节：W3C `traceparent`，`00-<32 位小写十六进制>-<16 位>-<2 位>`，全 0 或格式不对当作没有（版本 `00` 必须正好四段，`ff` 无效，更高版本只读前四段），自己新起，日志里记一条警告（每分钟最多 10 条）。
- 进程内用 `AsyncLocalStorage` 携带“这件事”的上下文：链路号、这一跳的编号、深度（阶段 1 恒为 0）、谁（`owner` / `cli` / `ai` / `anonymous` / `system`）、AI 的会话与轮次、入口（`local` / `external` / `internal`）、通道（`web` / `device` / `cli` / `ai` / `system` / `none`）、接口或工具。
- **HTTP 请求**（`observe/request-audit.ts`）：在 guard 之前的 `onRequest` 钩子建立上下文（入站合法的 `traceparent` 沿用其链路号，否则新起），之后的钩子和处理函数都在里面；`preHandler` 再进入一次（读请求体的流事件不带上下文）。guard 认出凭据后填上谁（`bindPrincipal`）；**AI 工作凭据发来的请求沿用它这一轮的链路号**（trace.md 第 3 节“AI 在一轮里……沿用这一轮的”）。
- **一轮**：`jobs` 新增 `trace` 列。8 处新建任务都写 `traceForNewTurn()`：在请求或调用里就是它的链路号，否则（定时器、后台结果、在线进程自己醒来）新起——与 trace.md 第 3 节一致。
- **Runner 的进程内调用**（`RunnerPort`，`observe/runner-trace.ts`）：每次调用都在自己的上下文里跑，从不继承调用方碰巧所在的上下文（在线进程跨很多轮，它的回调挂在第一轮的上下文里）。`/jobs/:id/…` 是 Daisy 替那一轮做事：链路号取那一轮的，谁是 `system`、带会话与轮次；harness 的工具（`/sessions/:sid/schedules…`：wakeup、cron、bash、monitor、schedules、cancel）是那个会话的 AI 在它这一轮里做的：链路号取请求体 `jobId` 指的那一轮（否则该会话正在运行的那一轮），谁是 `ai`；其余（后台命令的结果、同步、登录）新起一个 `system` 链路号。
- 跨 Daisy 传递（A2A metadata、出站 `traceparent` 头）是阶段 4（P4-08），这次不做。

### 2. 审计（`store.audit` + `audit_context`）

- 每条审计除原来的 `user_id`、`action`、`target`、`created` 外，记：链路号、深度、谁、AI 的会话与轮次、入口、通道、接口或工具（`route`）、对象 id（`object`）、结果（`ok` / `denied` / `error`）、原因（错误码或 `http_<状态>`）、HTTP 状态。没给的字段从当前上下文取；不在任何请求或调用里时是 `system` / `internal`，新起链路号。所以处理函数里原有的领域审计（`session.create`、`pin.*`……）不用改一行，自动带上链路号和通道。
- **放在旁表 `audit_context`（以审计行 id 为主键），不是给 `audit` 加列**：已发布的代码按位置插入 `audit`（`tests/schema-compat.test.ts` 的 POSITIONAL），加列会让回滚到的上一版插入失败。两张表在同一个事务里写。另加索引 `audit(created)`、`audit_context(trace_id)`。这是 `store/schema.ts` `MIGRATIONS` 的第 3 步（第 1 步完整结构、第 2 步 PIN 表），只增不删。
- **集中在一处**：`installRequestAudit` 的 `onResponse` 对每个“动作”记一条 `action = "api.<接口 id>"`、`target = {face, channel, status}`（P1-03 审查 M-2 原在 guard 的 `onResponse` 里记的那一条，合并到这里，同一请求只记一条）：定义表新字段 `audit`（默认：除 GET 以外都记；`GET /api/audit`、`GET /api/logs` 标 `true`，读审计本身也留痕；终端按键输入、用 POST 形式的通知查询标 `false` 并写理由）。对象 id 取路径参数；没有路径参数的 POST 取回答里的 `id`（新建的对象）。被 guard 拒绝的请求已由 guard 记了 `access.denied`（现在也带上下文字段），不重复记；处理函数自己拒绝的（如 404、口令不对）按状态码记 `denied` / `error` 和回答里的 `code`。
- harness 的每个工具调用记一条 `tool.<名字>`（谁是 `ai`、会话、轮次、对象是定时器 id、结果）。
- 读（GET）成功不逐条记：网页轮询会把审计淹没，而可追溯要求记的是“动作”。被拒绝的读照样记。

### 3. 脱敏（`observe/redact.ts`）与日志（`observe/log.ts`）

- 一个 `redact(text)`，两层：① **按值**——Daisy 制造或拿到的每个秘密在那一刻登记（本机凭据、网页会话、一次性口令、AI 工作凭据、PIN 授权、存储层加密 / 解密的一切：harness 的 API key、登录时贴的授权码、改 harness 配置的参数），出现在哪里都换成 `[已隐去]`；短于 8 个字符的不登记（会误伤普通词和数字），最多记最近 4096 个。② **按形状**——`Bearer` / `Basic` / `Token` 后的串、JWT、`dcli_` / `dweb_`、`sk-…`、GitHub / Slack / Google / AWS / GitLab 令牌、URL 里的口令、链接里的 `code=` / `token=`、键名像秘密的 `key=value` / `"key": "value"` / `key: 'v'`（`api_key`、`token`、`secret`、`password`、`authorization`、`pin`、`oldPin`、`grant`、`daisy-pin-grant`、`cookie`……；值是 `true` / `false` / `null` 时不动）。宁可多遮。
- 经过它的：每一行日志（`log.info` / `warn` / `error`）、每个错误回答的 `error` 与 `details`、每条审计的 `target` 和 `object`、审计查看接口回给主人的旧记录。
- `packages/` 下 Daisy 自己的代码一律经 `log`（测试检查：除 `claude-session.ts` 写给父进程的协议输出和日志模块本身，没有 `console.*`）；`main.ts` 调 `installConsoleRedaction()`，第三方库自己 `console.*` 打的也经过同一层。日志行带当前链路号（行尾 `trace=<号>`），最近 1000 行留在内存里供 `GET /api/logs` 读。不另写日志文件：服务管理器（journald、launchd）收标准输出。

### 4. 查看日志和审计（主人本人、命令行可以，AI 不行）

- `GET /api/audit`（`system.auditList`，`daisy:manage`，主人的三个通道，命令 `daisy audit list`）：从新到旧，`limit`（≤ 500）+ `before` 游标翻页，按时间（`since` / `until`）、通道、接口或工具、动作、谁、结果、会话、链路号过滤。
- `GET /api/logs`（`system.logs`，同上，命令 `daisy audit logs`）：最近的日志行，按级别、链路号、序号过滤。
- AI 的工作凭据调这两条在 guard 就被拒绝（`channel_not_allowed`），拒绝本身记审计。

## 后果

- 可追溯：任意一个动作，审计里有谁、经什么入口（面 + 通道）、对什么（接口 + 对象）、结果、链路号；它引起的那一轮、那一轮里 AI 的请求和工具动作都是同一个链路号，可以用 `daisy audit list --trace <号>` 一次查全。
- 不泄露秘密：日志、错误回答、审计在写出之前都过同一层；自动测试跑一组会产生大量日志的行为，收集标准输出 / 错误、日志行、审计两张表、错误回答、主人的两个查看接口、数据目录下的 `*.log`，断言查不到任何秘密值，也没有秘密的形状。
- 代价：每个动作多两行写（`audit` + `audit_context`）；按值替换随登记数线性增长（上限 4096 个，只在日志 / 错误 / 审计时做）。
- 已知的限制：① 进程崩溃时 Node 自己打到 stderr 的未捕获异常不经过 `console`，不在这一层里（处理函数里的异常由 Fastify 的错误处理接住，经过了）；② harness 进程自己的输出（会话内容）不是 Daisy 的日志，不过这一层（Runner 已有的局部脱敏照旧）；③ 按形状认不出、又没登记的秘密（例如用户自己在消息里贴的一段随机串）遮不住——这类东西只会出现在会话内容里，而 Daisy 不把会话内容写进日志或审计；④ PIN 本身不按值登记（太短，常是纯数字），靠“请求体从不进日志”和 `pin=` / `"pin":` 形状兜底。

## 留给后面的工作包

- 已随合并完成：结构改为 `MIGRATIONS` 第 3 步；`pin.grant()` 签出授权时 `registerSecret(grant)`（guard 也登记收到的授权头）；P1-05 的 `pin.*` 领域审计（目标 `pin@web` / `pin@cli`）自动带上下文。
- **P4-08**：出站调用带 `traceparent` 头和 A2A metadata 的深度；收到的 A2A 调用沿用调用方的链路号；审计的 `depth` 开始有值；按链路号计数的上限。
- **P1-07**：`daisy audit list|logs` 已由定义表生成；可以在命令出错时打印回答对应的链路号（需要时给回答加一个头）。
