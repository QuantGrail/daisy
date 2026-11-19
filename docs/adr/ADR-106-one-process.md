# ADR-106：合并成一个进程——Runner 的调用改为进程内接口，更新与重启等空闲

- 日期：2026-11-17
- 状态：**已实施（P1-02），待审查**；其中沿用的 ADR-103、ADR-104 草稿部分仍待维护者确认
- 工作包：P1-02
- 相关：草稿 ADR-103（原地合并，之后纯搬家 P1-02b）、ADR-104（更新等空闲）

## 背景

改造前是一个控制面进程加若干 Runner 进程（常在别的机器上）。Runner 经 `POST /api/runner/<路径>` 调控制面，带节点令牌，任务相关的调用带 `X-Lease`：认领、续租（pulse）、事件、完成、恢复、追加输入、标题、定时、登录、终端、文件夹浏览、在线进程上报等约 35 个调用，外加心跳（能力上报、存活、重启请求、版本广播）。控制面另有零停机发布（待命进程、领导权租约、`supervisor.mjs`）和节点表「重启」（旧版的约定：在界面重启 Runner，只有节点主人能点）。

维护者的决定：两者合成一个程序、之间的内部接口全部删除。设计建议：不重写适配器、不重写队列，换成进程内接口、形状尽量保持。

## 决定

下文的路径按后来搬家（P1-02b，ADR-103）之后的位置写；P1-02 时它们还在旧的 `services/` 目录下。

### 1. 进程内接口 `RunnerPort`（`packages/daisy/src/app/runner-port.ts`）

- 原来每个 `app.post("/api/runner/<路径>", handler)` 原样改成 `runner.post("/<路径>", handler)`：同样的路径、请求体、回答、错误（状态码 + 消息）。处理函数体不动，读的还是 `req.params`、`req.body`、`req.headers["x-lease"]`。
- Runner 侧唯一的接缝是 `nodeApi(config, path, body, lease)`，签名不变，函数体从 `fetch` 改成 `config.api(path, body, lease)`；`config.api` 是 `createApp(...).runnerApi(nodeId)` 给的、绑定到本节点的调用。拒绝时抛 `RunnerCallError`（`ApiError` 即它），`status` 与原来 HTTP 的一致，所以 Runner 里按状态码分支的逻辑（4xx 不重试、409 租约失效、401 吊销）都不变。
- 请求体和回答按 JSON 各复制一次，与过线时一样：处理函数改写事件（审批）不会改到 Runner 手里的那份，回答也不和数据库层共享对象。204 回答为 `null`；未知异常回 500「服务内部错误」，细节只进日志。
- 节点：不再有节点令牌。`node(req)` 按端口给的节点编号取节点，已吊销的回 401；不再做按网络地址的检查（调用不来自网络）。插件的服务端半边经 `EventHost.runner` 注册自己的调用（例如私有插件的 `/callbacks`）。
- **`/api/runner/*` 在 HTTP 上一个都不存在**（`tests/runner-port.test.ts` 逐个检查），限速里的节点令牌分桶随之删除。
- 认领与续租保留为**进程内方法**（`/claim`、`/jobs/:id/pulse`）：这是队列的形状，按上面的建议不重写。删掉的是跨进程的那一层：HTTP、节点令牌、运行用户的请求头、维护排空（`runner-maintenance.ts`）。租约仍是任务的归属凭证，结果日志和恢复按它对账。
- 心跳删除。剩下的改名为 `/sync`（每 10 秒一次进程内调用）：能力上报（CLI、适配器能力、运行用户）、服务端下发的退役身份、插件状态（组织层文档）。没有存活判定以外的东西：没有重启请求、没有版本广播、没有心跳计数。插件钩子 `heartbeat` 相应改名 `sync`。

### 2. 一个启动命令，一个进程（`packages/daisy/src/main.ts`）

`npm start` 起一个进程：`createApp` 之后在同一进程里 `runNode(config, signal, restart)`；不再 spawn Runner 子进程，没有 supervisor、待命进程和领导权租约。`runner.json` 留作进程内 Runner 的设置（没有 `serverUrl` / `token`）；插件选择只有一处（runner.json `plugins`，否则 `DAISY_PLUGINS`），两端半边用同一份。

退出：SIGTERM / SIGINT → Runner 先收尾（进行中的一轮标为中断并上报）→ `lifecycle` 排空（实时连接 1012、等进行中的请求）→ 退出 0。重启 → 同样排空 → 退出 75 由服务管理器拉起。`lifecycle.ts` 只留“排空再退出”：`draining`、`onDrain`、`trackHttp`，`leading()` 改为“没在排空”。

### 3. 更新与重启等空闲（`update/restart.ts`，`app/update.ts`）

合并后一重启，harness 进程也结束，那一轮就被打断；被打断的不重放。所以：

| 来源 | 什么时候执行 |
| --- | --- |
| 已安装的新版本（`.release` 变了，upgrade.ts） | 完全空闲连续 60 秒 |
| 自动更新构建好的版本（autoupdate.ts） | 同上；目标不再由控制面广播，改为每 30 分钟经同一套来源校验取 GitHub main（`latestMain`） |
| 主人 `POST /api/update/restart {mode:"idle"}` | 完全空闲连续 5 秒 |
| 主人 `{mode:"now"}` | 有东西在运行时先 409，`interrupts` 列出会打断的会话，`confirm` 是只对应这份列表的凭据；带回它才执行，期间又有新工作开始（列表之外的）就再 409、给新列表；挂着期间不认领任何新工作，执行那一刻若有列表之外的工作就取消；已构建好的更新一并切换 |

“空闲”沿用 Runner 原来的定义：没有正在执行的一轮（等卡片回答的也算在执行）、登录、终端命令、标题调用、恢复传输，在线 AI 手上没有工作；后台命令 / 监视按旧版的约定（后台任务不再无限挡住重启）最多再等 30 分钟，之后停掉并报告。有会话在运行就一直等，不设上限。`GET /api/update` 显示待做的更新、主人的请求和正在挡着的东西（会话名、类别）。阶段 1 管理员能用，P1-03 改为主人；请求记审计（`now` 记下被打断的会话）。不是常驻服务（终端里 `npm start`）时重启请求回 409（退出只会让它停下）。

被打断的一轮（立即重启、停止、强杀、崩溃）标为中断、留一条说明（都写“没有重放”）、不重放：立即重启和停止（SIGTERM）时 Runner 以 `RestartAbort` / `StopAbort` 结束它们；强杀 / 崩溃后，新进程的 Runner 从结果日志里找到没结束的一轮，经 `/jobs/:id/recover` 补上已产生的输出并标为中断。进程停了超过租约（30 秒）才起来时，控制面先按租约过期把它标为中断，结果日志里的输出作为“找回的执行证据”留一条说明——同样不重放。

### 3.1 审查后补的（2026-11-17）

- 自动更新只在经启动器运行时生效：检出目录且没有经 `launch.sh`（`current` 指向它）运行时判为不支持，不看 GitHub、不构建、不进待切换、不写 `pending.json`（之前会构建、拦后台任务，最后在切换时报错）。
- 数据目录不在发布目录里：`launch.sh` 导出 `HARBOR_DATA`（默认启动器旁的 `data/`）；从有 `.release` 的发布目录启动又没设 `HARBOR_DATA` 时拒绝启动。整进程的自动更新端到端测试（GitHub 替身、切换、确认、npm ci 失败、起不来回滚、不确认回滚）恢复，macOS 也能跑；它查出 `gcReleases` 在家目录经软链接时会删掉上一版，已修。
- “关闭后不留进程”覆盖强杀和停止：每个独立进程组的子进程（harness、后台命令、终端命令、命令行终端）记在数据目录的 `process-groups.json`（进程组号 + 启动时间），下一次启动在 Runner 开工前结束上一个进程留下的；只结束组长仍是记录里那个进程的组。
- 清扫的判定（后续加固）：Linux 读 `/proc/<pid>/stat` 第 22 字段，别处 `ps` 固定 `LC_ALL=C TZ=UTC`；记录进程组号、组长启动时间和命令行，组长还在时三者都要对上；从不碰自己、自己的组和任何祖先的 pid / 组；组长已退出时只结束组里启动时间不早于组长的成员。已知的边界：组长退出后组号被另一个组长也已退出的无关会话复用，这一种分辨不出来（要求两次启动之间组号转一圈）。
- 监听非本机地址时必须有组网快照（检查请求来源），没有就拒绝启动。
- 旧 runner.json（有 `serverUrl`）的本地状态（结果日志、插件的 `<键>.json`）在启动时一次性搬到新键下，不覆盖已有的。
- 进程内调用加 8 秒超时（原来 fetch 的超时）：超时抛 `RunnerCallTimeout`（不带状态码，Runner 按网络错误重试），不让挂住的处理函数卡死 Runner 主循环。

### 4. 删除

`leadership.ts`、`runner-maintenance.ts`、`node-restart.ts`（节点表重启）、服务端的 `supervisor.mjs`、独立 Runner 的入口 `main.ts`、节点登记（`POST /api/nodes`、`/api/nodes/self`，签发节点令牌）、`scripts/install-runner.sh`、`scripts/pair-device.mjs`、`scripts/e2e-zero-downtime.mjs`、旧版 Runner 的 systemd 单元和生产部署目录。

## 没有照原计划做的地方

- **`turns/transport.ts` 没删**。原计划把它写成“和服务端之间的传输”，实际它是 `JsonProcess`——Runner 和 harness 子进程之间的换行 JSON 传输，五个适配器都用它。删它就要改适配器，违背“适配器一行不改”。和服务端之间的传输其实是 `worker.ts` 里的 `nodeApi`（已改）。
- **`scripts/runner-launch.sh`、`scripts/runner-guard.mjs` 没删**（原计划列为删）。它们是旧版自动更新的启动器和回退守卫，改为拉起整个进程；ADR-104 草稿沿用这套“旁建、切换、回退”。名字留给 P1-02b / P1-09。
- **目录没搬**（ADR-103 草稿：P1-02 原地做，纯搬家另做 P1-02b）。

## 后果

- 适配器（`adapters/*`）没有改动（`transport.ts` 只加了进程组登记两行）；队列（认领、租约、结算、插队、追加）没有改动；原来用假 Runner 写的测试只换了“怎么发调用”（`tests/fixtures/runner-calls.ts`）。
- 多节点的数据结构（`nodes` 表、会话的 `nodeId`、节点归属、主机模式的运行用户检查）原样留着，只是除了本机节点，没有别的节点能有 Runner。P1-03 删多账号与机器管理时一并处理。
- 一台机器上进程内的调用比 HTTP 快得多。测试里因此暴露了一个按毫秒做键的通知去重（`prompt-org-mismatch:<ms>`），已记为待处理。
