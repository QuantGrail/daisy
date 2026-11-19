# 时限与上限

版本：0.1　状态：草稿，待维护者评审
修订：0.1（2026-11-16）初稿。0.1.1（2026-11-17）第 5 节补外部签发方 JWKS 缓存的细则和代领令牌的两项，数值在 `packages/contracts/src/limits.ts` 的 `TOKEN_LIMITS`。0.1.1（2026-11-17，P1-12 修复包）第 1 节工具授权 / 提问卡片的 24 小时落到代码（`CARD_LIMITS`），写明怎么调。0.1.2（2026-11-17，阶段 2 关口，维护者的决定）第 5 节加外部主人令牌的有效期上限 24 小时（`TOKEN_LIMITS.externalOwnerMaxS`）。0.1.3（2026-11-17）第 5 节跨 Daisy 访问令牌落到代码（`TOKEN_LIMITS.a2aMaxS`）；第 8 节补名片的地址个数、地址长度、导入文本大小、`iat` 在将来的上限四项（建议），数值在 `IDENTITY_CARD_LIMITS`。0.1.4（2026-11-17）第 2 节的数值落到代码 `A2A_LIMITS`（含链路的 8 层 / 64 次）。0.1.5（2026-11-17，P4-04 安全审查）第 2 节加每个调用方的上限、请求体、存根、等补充的期限、对外面的连接数。 0.1.6（2026-11-17，ADR-127）第 2 节 Daisy 作为调用方的各项落到代码 `A2A_CLIENT_LIMITS`。

依据：设计建议（所有时限和上限集中成一处配置）。

所有时限和上限只在这里列一次。别的契约文档引用这里，不另写数值。代码里对应一个常量模块（建议放 `packages/contracts/src/limits.ts`，导出 `LIMITS`），服务端、命令行、界面都从它取；可以由主人改的项目再从配置文件覆盖。不允许在别处写死这些数。

“出处”一栏：

- **设计**：产品设计已经写定的数值。
- **代码**：现有代码里的数值（以本契约初稿时的代码为准），路径相对仓库根。
- **建议**：本契约提议的数值，设计和代码里都没有，等维护者评审。

---

## 1. 卡片与授权

| 项 | 默认值 | 可调 | 出处 |
| --- | --- | --- | --- |
| 调用授权卡片（有人想调用，待批准）过期 | 7 天 | 否 | 设计。代码 `packages/contracts/src/limits.ts` `CARD_LIMITS.callCardTtlMs`（P4-03，ADR-122；旧代码的 24 小时不再用）。到期等着的调用被拒，卡片显示已过期 |
| 工具授权和提问卡片（AI 请求主人）过期 | 24 小时 | 是：环境变量 `DAISY_CARD_TTL_HOURS`（小时，可带小数） | 代码 `packages/contracts/src/limits.ts` `CARD_LIMITS.toolCardTtlMs`（`packages/daisy/src/approvals/approvals.ts` 的 `OWNER_APPROVAL_TTL` 取它）。从卡片出现时算起；到期这一轮按“执行被打断”收尾：标为中断、不自动重放，卡片显示已过期、再回答被拒，会话回到可用（P1-12）。不受单轮上限影响：默认没有单轮上限也照样到期 |
| 被拒绝后同一调用者再调用同一 agent 的冷却 | 10 分钟 | 是（还没有配置项） | 代码 `CARD_LIMITS.callCooldownMs`（P4-03，ADR-122；旧实现的冷却按群计，现按 agent × 人计）。冷却期内的调用直接拒绝、不生成卡片 |
| 一张调用授权卡片上同时等着的调用 | 16 | 否 | 建议（P4-03 安全审查 M-3）。代码 `CARD_LIMITS.callCardMaxWaiting`。同一个人对同一个 agent 的调用在等主人时并入同一张卡片，超过就直接拒绝、不生成卡片 |
| 待批准的调用授权卡片：总数 / 同一外部签发方的人合计 | 200 / 50 | 否 | 建议（P4-03 安全审查 L-2）。代码 `CARD_LIMITS.callCardsPendingMax`、`callCardsPendingPerIssuer`。超过就直接拒绝、不生成卡片，免得刷出来的卡片把真的挤出审批列表（列表显示最新的 200 张，待批准的排前面） |

## 2. A2A 对话

| 项 | 默认值 | 可调 | 出处 |
| --- | --- | --- | --- |
| 来访对话空闲多久回收 | 7 天 | 是（P4-04 暂无配置项） | 设计（建议 7 天）。代码 `A2A_LIMITS.contextIdleMs` |
| `messageId` 记录保留 | 到所在对话被回收 | 否 | 本契约（a2a-usage.md 第 7 节） |
| 阻塞的 `SendMessage` 最长等多久 | 不设上限 | 否 | 维护者的决定：照 A2A 规范等到结束，不设人为上限。原代码的 25 秒已删除（P4-04 重建，`packages/daisy/src/a2a/`） |
| 每条消息的部件数 | 16 | 否 | 代码 `A2A_LIMITS.partsMax` |
| 单个文本部件 | 50 000 字符（`data` 部件转成 JSON 同样） | 否 | 代码 `A2A_LIMITS.textMax` |
| 单个文件部件 | 12 MB | 否 | 代码 `A2A_LIMITS.fileMax` |
| 每条消息的文件数 | 8 | 否 | 代码 `A2A_LIMITS.filesMax` |
| 结果里内联返回的文件：单个 / 合计 | 12 MB / 32 MB；超出的不返回，在回答里注明 | 否 | 建议。代码 `A2A_LIMITS.resultFileMax` / `resultFilesMax` |
| `messageId` 长度 | 8–100 字符 | 否 | 代码 `A2A_LIMITS.messageIdMin` / `messageIdMax` |
| 任务 `history` 默认 / 最多 | 全部，最多 100 条 / 1000 | 否 | 代码 `A2A_LIMITS.historyDefault` / `historyMax` |
| 列任务每页默认 / 最多 | 50 / 100 | 否 | 代码 `A2A_LIMITS.pageDefault` / `pageMax` |
| `metadata`（消息的、每个部件的）转成 JSON | 16 KB；`metadata` / `data` 嵌套最多 32 层 | 否 | P4-04 审查 M-1 / L-5。`A2A_LIMITS.metadataMax` / `jsonDepthMax` |
| 请求体 | 16 MB + 64 KB（一个 12 MB 的文件按 base64 正好放得下；全部文件合计受它约束），超过回 413 | 否 | P4-04 审查 L-6。`A2A_LIMITS.bodyMax` |
| 调用开始前（被拒、等主人批准）存下的消息 | 只存 2000 字的文本和文件名、大小；不存文件字节、不存 metadata；开始执行时才存整条 | 否 | P4-04 审查 M-1。`A2A_LIMITS.stubTextMax` |
| 一个调用方在一个 agent 上没结束的任务 | 16，超过回 429、什么都不存 | 否 | P4-04 审查 M-1。`A2A_LIMITS.openTasksPerAgent` |
| 一个调用方在这里的对话（全部 agent） | 50，超过回 429 | 否 | 同上。`contextsPerCaller` |
| 一个调用方存放的消息（库里加内存里等着的） | 64 MB，超过回 429 | 否 | 同上。`storedBytesPerCaller` |
| 一个调用方每分钟发消息（含重发） | 60，超过回 429 + `Retry-After` | 否 | 同上。`sendsPerMinute` |
| 一个调用方同时扣着的阻塞发消息 | 8，超过回 503 + `Retry-After`（新任务不建）；同一任务再阻塞重发时接替旧的连接，旧的立即带当前状态返回 | 否 | P4-04 审查 M-2。`heldPerCaller` |
| 等调用方补充（需要输入）的任务空闲多久结束 | 24 小时，置为失败 `INPUT_EXPIRED` | 否 | P4-04 审查 L-2。`inputIdleMs` |
| 一个任务里调用方的消息（含第一条） | 16，超过回 429 | 否 | 同上。`messagesPerTask` |
| 对外面的连接数 / TCP keep-alive | 1024 / 60 秒 | 否 | P4-04 审查 M-2。`FACE_LIMITS` |
| Daisy 作为调用方轮询查任务的间隔 | 从 2 秒起，每次乘 1.5，最长 30 秒；等对方主人批准时最长 5 分钟 | 否 | 建议。代码 `A2A_CLIENT_LIMITS.pollFirstMs` / `pollFactor` / `pollMaxMs` / `pollAuthMaxMs`（P4-08） |
| Daisy 作为调用方：出站令牌有效期 | 120 秒，每个请求一张 | 否 | 建议（P4-08）。`A2A_CLIENT_LIMITS.tokenTtlS`；契约上限 5 分钟（第 5 节） |
| Daisy 作为调用方：一个请求的时限 / 发现时每位联系人 / 工具当场等第一次回答 | 10 秒 / 5 秒 / 6 秒 | 否 | 建议（P4-08）。`requestTimeoutMs` / `discoverTimeoutMs` / `inlineWaitMs` |
| Daisy 作为调用方：读回答的上限 | 目录、名片 256 KB；任务 48 MB | 否 | 建议（P4-08）。`cardMaxBytes` / `taskMaxBytes` |
| Daisy 作为调用方：网络失败或对方忙时重发 / 轮询连续失败 / 一次调用最长等 | 5 次 / 40 次 / 8 天 | 否 | 建议（P4-08）。`sendAttempts` / `pollFailuresMax` / `callMaxMs`；对方的 `Retry-After` 最多照等 10 分钟（`retryAfterMaxMs`） |
| Daisy 作为调用方：一个 AI 同时进行中的调用 / 发现时最多问几位联系人 | 32 / 16 | 否 | 建议（P4-08）。`openPerSession` / `discoverContactsMax` |

## 3. 链路

| 项 | 默认值 | 可调 | 出处 |
| --- | --- | --- | --- |
| 调用深度上限 | 8 | 否 | 旧实现（已删除）的聊天模块里 `depth > 8` 拒绝；设计：“沿用现有聊天模块里的数值” |
| 同一链路号的调用次数上限（每个系统各自计） | 64 | 否 | 旧版代码 `collaboration.ts:651–658`、`7587–7593`；同上 |

## 4. 并发与用量

| 项 | 默认值 | 可调 | 出处 |
| --- | --- | --- | --- |
| 同时运行的轮次（整个 Daisy） | 8 | 是 | 代码 `packages/daisy/src/turns/worker.ts:1508`（1 到 8 之间）、`packages/daisy/src/app.ts:1260` |
| 每个常驻 agent 同时进行的来访对话 | 4 | 是（按 agent，1 到 32） | 建议。超出的停在“已提交”排队。代码 `packages/contracts/src/api/residents.ts` `RESIDENT_AGENT_LIMITS.concurrency`（P4-07） |
| 常驻 agent 每日轮次 | 不限（主人可设，最多 1000） | 是 | 代码 `packages/contracts/src/api/residents.ts` `RESIDENT_AGENT_LIMITS.dailyTurnsMax`（P4-07；到了上限的调用 `QUOTA_EXCEEDED`） |
| 常驻 agent 单轮最长 | 不限 | 否（P4-07 没有做这一项） | 旧「任务常驻 Agent」的 `packages/contracts/src/scheduler.ts` `RESIDENT_LIMITS.maxTurnMinutes` 不用于 P4-07 的常驻 agent（ADR-126“留下的问题”）；单轮仍受整个 Daisy 的轮次时限约束 |
| 每个公开 agent 同时进行的“问” | 2 | 是 | 代码 `packages/contracts/src/ask-sidecar.ts:14` `ASK_SIDECAR.concurrent`，环境变量 `DAISY_ASK_SIDECAR_CONCURRENT` |
| 每个公开 agent 每 24 小时的“问” | 30 | 是 | 代码 `ask-sidecar.ts:16` `ASK_SIDECAR.daily`。是否放宽待定 |
| 支线空闲多久关闭 | 24 小时 | 是 | 代码 `ask-sidecar.ts:18` `ASK_SIDECAR.idleMs` |
| “问”的摘要没送进主线前保留 | 7 天 | 否 | 代码 `ask-sidecar.ts:27` `ASK_SIDECAR.keepMs` |

## 5. 令牌与凭据

| 项 | 默认值 | 上限 | 出处 |
| --- | --- | --- | --- |
| 跨 Daisy 访问令牌 | 5 分钟 | 5 分钟 | 设计“有效期几分钟”；取值是建议。P4-01 验联系人签的令牌时按它（`TOKEN_LIMITS.a2aMaxS`，`exp - iat` 超过即拒绝） |
| AI 工作凭据 | 到这一轮结束 | 1 小时 | 设计（AI 令牌有效期不超过 1 小时） |
| 替 AI 代领的令牌 | 1 小时 | 1 小时 | 设计、P2-02 |
| `daisy token` | 7 天 | 90 天（最短 1 分钟） | 建议；P4-12 实现（`TOKEN_LIMITS.visitorDefaultS` / `visitorMaxS` / `visitorMinS`） |
| 同时有效的 `daisy token` | — | 200 张（再签回 409 `too_many_tokens`） | P4-12（ADR-132）；`TOKEN_LIMITS.visitorActiveMax` |
| `daisy token` 的签发记录 | 过期或吊销后保留 30 天（`list --state all` 看得到），之后清掉 | — | P4-12（ADR-132） |
| 验令牌时允许的时钟误差 | 60 秒 | — | 建议 |
| 外部签发方签给主人的令牌（`sub` 是主人）的有效期 `exp - iat` | 由签发方定 | 24 小时（正好 24 小时可以，多 1 秒拒绝；不加时钟误差；没有 `iat` 拒绝） | 维护者的决定（阶段 2 关口）；`TOKEN_LIMITS.externalOwnerMaxS`；来访者的令牌不受限 |
| 外部签发方 JWKS 缓存 | 按响应的 `Cache-Control: max-age`，没有就 1 小时；收在 5 分钟到 24 小时之间（`no-store` / `no-cache` 按 5 分钟） | — | 建议；P2-01 实现（`TOKEN_LIMITS.jwks*`） |
| JWKS 缓存过期后 | 后台重新取，这一次验证照用缓存；取不到继续用缓存（本机优先），在 `daisy access issuer show` 标“过期” | — | P2-01（ADR-113） |
| 找不到 `kid` 时重新取 JWKS（缓存过期后的重新取同样计） | 每分钟最多一次 | — | 建议；P2-01 实现 |
| JWKS 缓存过期后最多再用多久（签发方一直取不到） | 24 小时；之后一律拒绝，直到重新取到（状态显示“已失效”） | — | P2-01 审查 M-2；**数值待维护者在阶段关口定**（`TOKEN_LIMITS.jwksMaxStaleMs`） |
| 向外部签发方的一次请求（元数据、JWKS、令牌交换） | 5 秒超时，回答最大 256 KB，不跟随重定向 | — | P2-01（ADR-113） |
| 一份 JWKS 最多保留的钥匙 | 64 把；RSA 至少 2048 位 | — | P2-01（ADR-113） |
| 替 AI 代领的令牌提前重新领 | 剩不到 5 分钟时 | — | P2-02（ADR-113） |
| 每个会话保留的代领令牌 / 每分钟新领 | 16 张（先丢最早到期的）/ 10 次，超过回 429 | — | P2-02 审查 L-3 |
| 令牌交换里 Daisy 自签的 actor token、客户端断言（RFC 7523） | 5 分钟 | 5 分钟 | P2-02（ADR-113） |
| 本机接口幂等键保留 | 24 小时 | — | 建议 |

## 6. PIN、口令、配对

| 项 | 默认值 | 出处 |
| --- | --- | --- |
| PIN 最短长度 | 6 位，可以是纯数字 | 维护者的决定；接受“同账户的 AI 读得到校验值、可离线猜”的风险并写明（ADR-099） |
| 输入一次后有效 | 5 分钟，只对换它的那个网页会话或设备有效 | 设计“短时间”；取值是建议 |
| 连续输错锁定 | 连错 5 次锁 15 分钟；解锁后再连错 5 次锁 1 小时；之后每轮翻倍，最长 24 小时。输对一次清零 | 设计“会锁定一段时间”；取值是建议 |
| PIN 校验值的 scrypt 参数 | N = 2^17，r = 8，p = 1，盐 16 字节 | 依 ADR-099（提议中）；参数取 OWASP 对 scrypt 的建议值 |
| `daisy open` 打印的一次性口令 | 5 分钟内、只能用一次 | 建议 |
| 网页登录（口令换来的 Cookie）有效 | 30 天，空闲 7 天失效 | 建议 |
| 配对码 | 10 分钟内、只能用一次；不论来自哪个地址，累计输错 5 次就作废全部没用掉的码并锁定配对 15 分钟；同时最多 5 个没用掉的码；每个地址每分钟最多试 10 次 | 建议；P5-03 实施（`DEVICE_LIMITS`，ADR-142） |
| 配对设备的设备凭据 | 不过期，直到吊销、重置 PIN，或 30 天没用过；只用来换设备会话 | P5-03（ADR-142）；待主人确认 |
| 配对设备的设备会话（每次请求带的那一张） | 12 小时，每台设备最多 4 张；到期由网页用设备凭据换新的 | P5-03（ADR-142），在主人令牌 24 小时的上限之内 |
| 配对过的设备 | 同时最多 20 台有效的；吊销和失效的记录保留 30 天 | P5-03（ADR-142） |

## 7. 事件与读取

| 项 | 默认值 | 出处 |
| --- | --- | --- |
| 事件保留 | 30 天；没了结的卡片对应的事件了结前不清理 | 建议 |
| 事件每页最多 | 200 | 旧版代码 `collaboration.ts:4389`（通知流 `LIMIT 200`） |
| 长轮询最长等待 | 30 秒 | 建议 |
| 同时等待的长轮询 | 64 个；再多的立即回空页 | 建议（P2-03） |
| 会话事件每页 | 500 | 代码 `packages/daisy/src/app.ts:2395` |
| 事件标题长度 | 200 字 | 建议 |

## 8. 身份名片

| 项 | 默认值 | 出处 |
| --- | --- | --- |
| 显示名 | 1–64 字 | 建议 |
| 备注 | 200 字 | 建议 |
| 当面核对编号至少核对 | 前 16 个字符 | 建议 |
| 一张名片的地址 | 最多 8 个；每个最长 2048 字符 | 建议（P4-01） |
| 导入时给的名片文本 | 最多 16 KiB | 建议（P4-01；一张名片约 600 字符） |
| 名片的生成时间 `iat` 最多在将来 | 1 天（时钟误差；更远的拒绝，否则这个人以后的名片都会被当成“更旧”） | 建议（P4-01 安全审查 L-1） |
