# ADR-157：核心只认外部回调的通用格式，类别和编号的样子归插件（P6-12）

- 日期：2026-11-18
- 状态：**已实施（分支 `p6-12`，基于 `p6-gate`；待合入）**；§ P6-14 见文末（分支 `p6-14`）
- 来源：开源整理时发现核心代码里写着一个私有插件的回调编号格式
- 相关：核心不点名插件的检查（`scripts/check-core-names.mjs`）

## 背景

插件收到外部系统的结果（外部回调）时，经插件挂点 2 拿到的 `scheduler.wake(会话, scheduleId, …)` 唤醒会话。回调的 `scheduleId` 是 `callback[-human]:<类别>:<条目编号>`，排队的任务的 `request_id` 是 `schedule:<scheduleId>:<任务编号>`。核心在三处要认出“这是一个外部回调”：

1. 调度器：还没运行就被停止的回调不丢，存进 `kept_callbacks` 留给下一轮（`keepStopped`）；
2. 运行中追加（`sessions/native-append.ts`）：停止那一刻 AI 其实已经读到的回调，从 `kept_callbacks` 里取回，不再送一次（`unkeep`）；
3. 排队合并（`sessions/queue-merge.ts`）：回调的合并类别（`schedule:callback` / `schedule:callback-human`），以及被停止的合并任务里哪些部分是回调。

三处写法不一：调度器用的是通用格式（类别、编号只限字符和长度）；运行中追加写死了那个私有插件的三种类别和 `<前缀>-<12 位十六进制>` 的编号；排队合并只看前缀。核心的测试也用那个插件的编号。结果：核心认识一个私有插件的编号格式；换一个插件，它的回调在第 1、3 处是回调，在第 2 处不是（读到了还会再送一次）。

## 决定

1. **一个通用格式，一处定义。** `packages/daisy/src/schedule/callback-jobs.ts`：`callbackJob(requestId)` 按 `schedule:(callback|callback-human):<类别>:<条目编号>:` 解析（类别：小写字母开头，小写字母、数字、`_`、`-`，最多 32；条目编号：字母或数字开头，字母、数字、`_`、`.`、`-`，最多 64，不含 `:`），就是调度器原来的格式。调度器、运行中追加、排队合并（两处）都用它。核心里不再有任何插件的类别或编号样子。
2. **插件经公开挂点生成 scheduleId。** `@daisy-ai/daisy/plugin` 新导出 `callbackScheduleId(类别, 条目编号, { human })`，不合格式就抛错（不会悄悄变成一个普通定时唤醒）。类别和编号的具体样子仍由插件自己定义、自己检查（那个私有插件在收数据时已经按自己的格式校验）。插件文档（`examples/plugin-hello/README.md`「外部回调」）写明格式和核心怎么处理回调。
3. **装着那个插件时行为不变。** 它的编号全部落在通用格式里，生成的 scheduleId 逐字节相同；旧数据（`jobs.request_id`、`kept_callbacks.schedule_id`）照常认。插件包自己的测试把旧的写死格式留作参照，逐个比较。
4. **守卫。** 私有导出清单给那个插件加一条禁止规则：核心里不许再出现它的类别 / 编号前缀写成的模式（`scripts/check-core-names.mjs` 检查）。核心测试改用中性的类别和编号（`ping:PING-…`、`review:REV-…`、`owner-approval:card-…`）。

### 没有做的

- **不加“插件声明编号格式”的挂点。** 考虑过让插件声明 `{ 类别: 编号正则 }`，核心只认声明过的。没有采用：通用格式已经能认出所有插件的回调，声明只会多一个公开接口、多一种“没声明就不算回调”的失败方式（第 1 处会退化），而那个插件本来就在入口校验自己的编号。
- 预算计数的 SQL（`overBudget`）仍按前缀 `schedule:callback-human:` 排除，和以前一样。

## 影响

- 不装插件：任何合格式的回调在三处都被一致地当作回调（第 2 处以前只认那一个插件的编号）。
- 前缀是 `schedule:callback` 却不合格式的 `request_id`：以前在排队合并里算回调，现在不算。没有任何代码生成这样的编号。
- 测试：`tests/callback-jobs.test.ts`（格式、生成器、公开导出）、`tests/native-append-rules.test.ts`（任意类别的回调读后取回）、那个插件包自己的测试（旧编号逐个按旧规则认出；收数据生成的编号与以前相同；旧格式的存量任务停止后照常保留）。

## § P6-14：通知种类和常驻提示词也不再带那个插件的概念

- 日期：2026-11-18；分支 `p6-14`，基于 `p6-gate` 78dbbe19（待合入）

### 背景

P6-12 之后核心里还剩那个私有插件的一个概念：通知种类 `sudo`（「sudo 工单」）写在契约的种类表里（`packages/contracts/src/notifications.ts`），界面的通知列表给它配了名字（`packages/ui/src/notifications.tsx`），常驻会话的提示词「审批一次提全」一句写着「一张 sudo 工单」（`packages/contracts/src/resident-prompt.ts`）。核心自己从不产生这种通知，只有那个插件所在的平台推送它；可是不装插件的人在通知设置里（`GET /api/notification-preferences` 的 `kinds` / `matrix`，`daisy notify show`）也看到这个开关，常驻 AI 也被告知有「sudo 工单」。

### 决定

1. **核心只有自己的四种通知**：`approval`、`task`、`ai_private_message`、`ai_failed`（`NOTIFICATION_KINDS`）。
2. **插件经公开挂点声明自己的种类（挂点 3）**：`DaisyServerPlugin.notificationKinds: NotificationKindDecl[]`（`{ id, label, hint?, default? }`，类型从 `@daisy-ai/daisy/plugin` 导出）。编号小写字母开头、只用小写字母 / 数字 / `_`、最多 32 个字符，不能和核心的种类、`retract` 或另一个插件的重名；名字 1–40 个字符；`default` 是两台设备的默认开关（省略为开）。不合格 Daisy 不启动，并说是哪个插件（`loadServerPlugins`）。生效的种类 = 核心的四种 + 各个已启用插件声明的，按顺序排在核心的后面（`notificationKinds()`）。
3. **偏好只对生效的种类起作用，存下的不丢**：设置的读取只看生效的种类；存着的、现在没有插件声明的种类的格子原样留在记录里，不读、不显示、不能改，插件重新启用后照旧生效。写入（PUT / PATCH）一个不生效的种类回 400（说明现有哪些种类）；平台镜像（`PUT …/platform`）只写生效的种类，其余的略过；推送方查询（`POST …/check`）把不生效的种类当作未知种类（照常提醒，过期的不提醒）。接口定义里 `matrix` 的键从固定的几种改成“合格式的编号”，真正的种类在运行时检查（`docs/api` 和 `daisy notify set --matrix` 的帮助里类型写成 `Record<string, object>`）。
4. **那个插件声明 `sudo`**，编号、名字、说明、默认值都和以前核心里的一样，平台的推送类别仍映射到它；装着它时一切照旧，只有 `kinds` 里 `sudo` 从第二位挪到了核心四种之后。
5. **界面**：通知列表的名字表只留核心的种类，别的种类显示它的编号（`sudo` 以前也显示为 `sudo`，没变）。界面里没有通知设置矩阵，种类表由服务端的 `kinds` 给出。
6. **常驻提示词**改成通用的说法：「合并成一张审批单，不要做一步问一步。」那个插件没有贡献提示词片段的挂点（挂点 1 只给组织启动核心文档，它自己的规则在那里），所以不加挂点。固定的旧提示词夹具 `tests/fixtures/prompt-legacy-74a2714.json` 只改了这一句（四个常驻条目里各一处）；`prompt-off-chain-base.json` 不含这句，没动。
7. **守卫**：私有导出清单给那个插件再加一条禁止规则——核心里不许出现「sudo 工单」的说法或带引号的 `sudo` 种类编号（`sudo\s*工单|["'`]sudo["'`]`；机器自己的 `sudo loginctl …` 这类安装提示不受影响）。

### 没有做的

- 不让插件指定自己的种类排在哪里（例如“排在审批后面”）：只影响 `daisy notify show` 的顺序，平台有自己的种类表，不值得多一个接口。
- 「只问」支线提示词里的「不提工单 / 审批」没改：「工单」是通用说法，改它会动另一段固定的提示词。
- 核心里还有组织层的说法（「组织启动核心」「L1 议案」，`packages/contracts/src/guide.ts`、`packages/ui/src/prompt-layers.tsx`）：那是挂点 1 的通用机制，但「L1 议案」是那个插件所在平台的叫法，不装插件的人在提示词设置页也会看到。改它涉及挂点 1 的文案和固定的提示词，不在本包范围，列为后续。

### 影响

- 不装插件：通知设置里只有核心的四种；以前存过的 `sudo` 开关留在数据里不起作用。
- 装着那个插件：和以前一样（种类顺序除外）。
- 测试：`tests/notification-kinds.test.ts`（核心种类不点名插件、声明的校验；存下的不生效种类保留且插件回来后生效；不装插件时 GET / PATCH / 镜像 / 查询；测试插件 `tests/plugins/session-tag` 声明一个默认关的种类，装上后可见、可改、查询照它判断）；那个插件包自己的测试（声明与以前逐字段相同；装上后 GET / PATCH / 镜像 / 查询如前；新的禁止规则抓得到旧写法、放过机器自己的 sudo）。
