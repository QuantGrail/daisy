# ADR-113：令牌验证的两种实现、外部签发方、替 AI 代领令牌

- 日期：2026-11-17
- 状态：**已实施（P2-01、P2-02），安全审查修订已做（2026-11-17，见“安全审查修订”一节）；阶段 2 关口已由维护者审批（2026-11-17：外部主人令牌有效期上限 24 小时，见末节），并入 `daisy-next`**
- 工作包：P2-01（令牌验证的两种实现）、P2-02（替 AI 代领令牌）
- 相关：设计要求——安全与主人主权（放别人进来只认主人本人、要 PIN）、本机优先（核心功能不依赖外部服务）、标准优先（用 OAuth2 的签名令牌格式）、日志和错误信息里不出现凭据和令牌；契约草稿 `docs/contracts/token.md`（第 2–6 节）、`scopes.md`、`limits.md` 第 5 节；ADR-099（Ed25519 + `jose`）、ADR-110（本机认证，集中检查）、ADR-111（审计与脱敏）

## 背景

阶段 1 的 Daisy 只认本机的三种凭据（ADR-110）。阶段 2 要让一个外部签发方（比如一个组织的身份服务）签的令牌也能用：主人带着它从别处连进来得到主人身份，不需要配对；别人的有效令牌不能碰本机接口；坏令牌一律拒绝；Daisy 还要替正在工作的 AI 领一张写明“主人 + 实际操作的 AI”的令牌（范围不超过主人，有效期不超过 1 小时），交给 harness 里需要它的 MCP。契约草稿已经定了格式（RFC 9068 `at+jwt`、RFC 8693 `act` 与令牌交换、JWKS 离线验证），待定事项施工先按推荐做。

## 决定

### 1. 一个接口，两种实现（`packages/daisy/src/access/tokens/`）

- `common.ts`：`TokenVerifier`（`kind`、`issuer`、`verify(token, {audience, maxLifetimeS})`）和两种实现共用的规则，只写一次：`typ` 必须是 `at+jwt`（`application/at+jwt` 同），`alg` 按调用方的白名单（令牌自己说的不信；永远不接受 `none` 和 `HS*`），必有 `iss sub aud exp iat jti client_id scope`，`aud` 精确匹配，`exp` / `iat` 各允许 60 秒误差，`iat` 不在将来，`exp - iat` 不超过调用方给的上限（外部签发方签给主人的令牌另有 24 小时上限，见末节），`act` 若有必须是带 `sub` 的对象。结果是 token.md 第 3 节的“认证结果”，或一个只给审计看的拒绝原因（调用方只得到 401 `invalid_token`，token.md 4.3）。
- `self-issuer.ts`（`SelfIssuer`）：本 Daisy 的 Ed25519 身份密钥（`keys/identity-key.json`，P1-03 起就有）签发和验证；`iss` 是密钥指纹的 URN，`kid` 是指纹；只认 `EdDSA` / `Ed25519`。另有 `signJwt`（`typ: JWT`）签 RFC 8693 的 actor token 和 RFC 7523 的客户端断言——它们不是访问令牌，本 Daisy 的验证方要 `at+jwt`，所以永远不会把它们当凭据。P1-03 的 AI 工作凭据改为经它签发和验证（行为不变，测试不变）。
- `external-issuer.ts`（`ExternalIssuer`）：主人配置的外部签发方。算法 `EdDSA` / `Ed25519`、`ES256`、`RS256`，并且必须与钥匙的类型（和钥匙自己写的 `alg`）相符；RSA 至少 2048 位。

### 2. 外部签发方的配置与 JWKS 缓存

- 接口（定义表 `packages/contracts/src/api/issuer.ts`，都在“设置”组）：
  - `GET /api/access/issuer`（`daisy:manage`）：模式（自签发 / 外部）、本 Daisy 的公钥 JWK（主人拿去在签发方登记，供 private_key_jwt 用）、签发方、主人主体、受众、缓存的钥匙（只有 kid 和算法）、是否过期、最近的错误、主人令牌是否存着及其到期时间。不含任何令牌。
  - `PUT /api/access/issuer`（**`daisy:grant` + PIN**，只有主人的通道，AI 一律不行）：签发方标识、元数据地址 / JWKS 地址 / 令牌端点（可选，默认按 RFC 8414 再按 OIDC Discovery 推）、主人主体 `ownerSubject`、受众（默认本 Daisy 的 URN）、客户端编号（默认同上）、主人令牌 `ownerToken`（可选，P2-02 用）。**先取元数据和 JWKS，取不到或格式不对就不保存**；元数据里的 `issuer` 必须与配置的完全相同（RFC 8414 第 3.3 节）；`ownerToken` 必须是这个签发方签给主人主体、发给本 Daisy、未过期、不带 `act` 的访问令牌。
  - `DELETE /api/access/issuer`（`daisy:manage`，不要 PIN）：收窄谁能进来，照 ADR-110“关闭对外面”的先例不要 PIN；缓存、主人令牌一并删除。
  - `POST /api/access/issuer/refresh`（`daisy:manage`）：立即重取 JWKS。
- 地址：只许 https；**明文 http 只在本机回环地址 `127.0.0.1` / `[::1]`、设置了 `DAISY_ALLOW_HTTP_ISSUER=1`、且这台机器没有别人的账户时允许**（测试的假签发方、同一台机器上的签发方；审查 M-3：多人共用的机器上别的账户能抢占端口冒充签发方），配置时和每次请求前都检查；`localhost` 不算；不带用户名密码、片段，签发方标识不带查询串。不跟随重定向、5 秒超时、回答最多 256 KB。
- 存放：配置在 `config.json` 的 `issuer` 段；JWKS 缓存 `issuer/jwks.json`（目录 0700、文件 0600，只存公钥部分，`d`、`p` 等私有成员一律丢掉）；主人令牌 `keys/issuer-owner-token`（0600）。没有数据库结构变更，所以没有追加 MIGRATIONS。
- 缓存与轮换（limits.md 第 5 节，`TOKEN_LIMITS`）：有效期按 `Cache-Control: max-age`，没有就 1 小时，收在 5 分钟到 24 小时之间（`no-store` / `no-cache` 按 5 分钟）。过期后**后台**重取，这一次验证照用缓存；过期超过 `jwksMaxStaleMs`（默认 24 小时，数值待关口定；审查 M-2）还取不到，就一律拒绝，状态显示“已失效”；遇到不认识的 `kid` 时**等**重取再找；两种重取合计每分钟最多一次。取不到时继续用缓存（本机优先），状态里标“过期”和错误。重取成功就整份替换——签发方去掉的钥匙立即不再被信任。重启后从缓存文件读，签发方不在线也能验证。

### 3. 主体与 scope（接进 ADR-110 的集中检查）

- `guard.ts` 先认本机的不透明凭据；是 JWT 形状的，按未经验证的 `iss` 分流（token.md 第 4 节）：等于配置的外部签发方 → `ExternalIssuer.verify`（受众 = 配置的受众）；等于本 Daisy → AI 工作凭据（只在本机面，这一轮还在跑）；都不是 → 401。
- 新的两种主体：
  - **`external-owner`**：`sub` 等于配置的主人主体且没有 `act`。通道 `issuer`（契约 `Channel` 新增，进主人的默认通道），两个面都认（对外面就是“从别处连入”，不需要配对；对外面上终端 / 执行命令 / 浏览目录的开关照样管它）。scope = 令牌的 scope ∩ 主人的四个（scopes.md 第 1 节规则 2）。**回答 AI 的工具授权和提问：待关口确认，默认不开放**——scopes.md 第 2 节写了“或外部签发方签给主人且没有 act 的令牌”，但设计的权限表和“入口等价”原则只给网页和配对设备；审查后取更安全的默认，`approval.respond`、`session.answerApproval` 的通道仍是 `web`、`device`。PIN 授权绑定到这张令牌的 SHA-256（`issuer:<哈希>`），换一张令牌就不认。存着的主人令牌（交换用）本身**不能**当 Bearer 登录（审查 M-4，401，审计原因 `owner_token_as_bearer`）。实时通道上用它订阅的连接，在令牌到期、签发方换了或删了、主人主体变了之后的下一次推送时关闭（审查 M-1）。
  - **`visitor`**：同一签发方的其他有效令牌——别人的（`sub` 不是主人），或主人的但带 `act`（AI 代主人，本机上不绑定任何一轮，不能当 AI 工作凭据用）。**每一条本机接口都拒绝**：403 `a2a_only`，`WWW-Authenticate: Bearer error="insufficient_scope", scope="<那条接口要的>"`（token.md 4.3 第三行）；阶段 4 的 A2A 入口才对它开放。审计里的谁是 `visitor:<sub>` / `issuer-ai:<act.sub>`，actor 是 `visitor`（P1-11 的审计契约加了这一类和通道 `issuer`）。
- 签名不对、过期、受众或签发方不对、`alg: none`、`HS256`（包括拿 RSA 公钥当密钥的算法混淆）、`typ` 不对、不认识的 `kid`、钥匙与算法不配、缺声明：一律 401，不说是哪一条。

### 4. 替 AI 代领令牌（P2-02）

- 接口 `POST /api/sessions/:id/ai-token`（定义 `packages/contracts/src/api/ai-token.ts`，`session.aiToken`）：`scope: daisy:tools`、`channels: []`、`aiSelf: "id"`——**只有这个会话正在跑的那一轮的 AI 工作凭据**能调；主人、命令行、外部签发方的令牌都 403。请求 `{audience, scope}`，回答 `{token, tokenType: "Bearer", expiresAt, audience, scope, mode}`，`Cache-Control: no-store`。
- **交付方式选“AI 工作凭据文件 + 本机接口”，不选进程内工具。** harness 里需要令牌的 MCP（比如以后接组织内部系统的那个）是 harness 起的子进程，继承环境变量 `DAISY_AI_CREDENTIAL_FILE`、`DAISY_URL`，这次再加 `DAISY_SESSION_ID`；它每次需要时读文件、调这条接口。理由：进程内工具（Daisy 挂给 harness 的进程内 MCP 工具）的结果进的是**模型的上下文和对话记录**，令牌会落进记录、日志、导出，违反“日志和错误信息里不出现凭据和令牌”的安全基线；走文件 + 接口，令牌只在 Daisy 和那个 MCP 进程之间，模型看不到。凭据文件每轮重写，MCP 每次都要重新读，不要缓存凭据。（Codex 默认不把父进程的环境变量传给 MCP 服务，配置时要在 `env_vars` 里列出这三个；这是接入那一侧的事，写进以后的接入文档。）
- 两种模式：
  - **外部模式**：RFC 8693 令牌交换到签发方的令牌端点。`subject_token` 是存着的主人令牌；`actor_token` 是 Daisy 自签的短 JWT（`sub: agent:<会话>`，`aud` = 签发方标识，5 分钟）；`requested_token_type` 访问令牌；`scope`、`audience` 按请求；客户端认证用 private_key_jwt（RFC 7523，身份密钥签，`iss = sub = 客户端编号`，`aud` = **签发方标识**，5 分钟）。
  - **独立模式**：Daisy 自己签：`iss = sub = 本 Daisy`，`act = {sub: agent:<会话>}`，`aud` = 请求的受众，`client_id = ai:<会话>`，1 小时。
- 能要什么：`audience` 不能是本 Daisy 自己（它的 URN 或配置的受众——访问本 Daisy 用 AI 工作凭据）；scope 永远不含 `daisy:grant`；不超过主人的——外部模式是主人令牌的 scope，独立模式是主人本机的 `session:read session:write manage`（去掉 `grant`）。
- **领回来之后再验一遍**（token.md 第 6 节）：签名与签发方、`aud` 是请求的那个、`sub` 是主人、`act.sub` 是这个 AI、scope 不超出请求、`exp - iat ≤ 3600`、`token_type` 是 Bearer、`issued_token_type` 是访问令牌。任何一条不满足：不交给 AI，回 502 `ai_token_unavailable`（只说拿不到、大致为什么），审计记一条 `ai.token.refused`（原因代码）。主人令牌没存或过期：同样 502，提示主人重新配置（要 PIN），这时不向签发方发任何请求。
- 有效期与重用（按推荐做法）：令牌最长 1 小时，在内存里按（会话、模式、签发方、受众、scope）保留，剩 5 分钟以上时同一请求给回同一张（可以跨轮）；不到 5 分钟就重新领；过期的每 5 秒清掉；配置或删除签发方时全部丢弃。**取令牌的接口只在一轮进行中可用**（AI 工作凭据一轮结束即失效）。
- 不出现在日志、审计、错误里：签出的、领回的、存着的主人令牌都在 P1-11 的脱敏层登记（`registerSecret`）；审计只记 `jti`、受众、scope、到期时间、模式；签发方的错误回答只取 `error` 代码（去掉非字母数字），不转述回答体。

### 5. 测试（先写被拒绝的）

- 假签发方 `tests/fixtures/fake-issuer.ts`：本机回环上的 HTTP 服务，RFC 8414 元数据、JWKS（一把 Ed25519、一把 RSA-2048，缓存头可调，可下线，可轮换）、RFC 8693 令牌端点（验客户端断言、主体令牌、actor token，签带 `act` 的令牌；`misbehave` 让它故意违反第 6 节的某一条）。不依赖任何真实的签发方。
- `tests/issuer.test.ts`：配置要 `daisy:grant` + PIN、AI 不行、别人的 PIN 授权不行、地址与元数据校验、取不到不保存、主人令牌校验；坏令牌（20 种，含算法混淆、`alg: none`、异钥同 kid，实时通道第一帧同样拒绝）；主人从别处连入（Ed25519 和 RS256、scope 取交集、PIN 授权绑定令牌、经真实的对外面监听器）；别人的令牌（四种来访令牌 × 全部本机接口，含实时通道）；JWKS 缓存（文件权限、离线、重启后、过期标记、轮换、每分钟一次、手动刷新）；规则单测。
- `tests/ai-token.test.ts`：只有本轮 AI 能领、别的会话 / 主人 / 命令行 / 轮次结束都拒；代领令牌的独立模式与外部模式（交换参数逐项核对、令牌逐项核对、重用、续领）；九种签发方作恶全部不交给 AI；没有 / 过期的主人令牌。
- 表驱动权限测试（`tests/access.test.ts`）加四种身份：外部签发方的主人令牌、带 PIN 授权的同上、别人的令牌、主人带 `act` 的令牌；新增一行“AI 自用”（`session.aiToken`）。并入 `daisy-next` 后为 107 条接口 × 12 种身份 = 1284 次。
- `tests/s1-redaction.test.ts`（P1-11）加一段：配置外部签发方、主人令牌、来访令牌、过期令牌、AI 的令牌、被拒的交换，全部不出现在输出、日志、审计、错误回答、主人的查看里。

## 后果

- 配置外部签发方之后，谁能签出 `sub` = 主人主体的令牌，谁就是主人（包括 PIN 之外的全部主人操作；“放别人进来”仍要 PIN）。这是“主人用签发方的令牌从别处连入得到主人身份”的本意，也意味着签发方的安全就是这个 Daisy 的安全——配置要 PIN 的原因。
- 主人令牌放在只有主人可读的文件里，同账户的 AI 读得到（同 ADR-099、token.md 第 8 节的已知限制）；它能拿去以主人身份直接访问签发方信任的系统。给 AI 收窄 scope 在本机上只是约定。
- 主人令牌通常是短期的访问令牌；过期后替 AI 领令牌就失败，直到主人重新配置。长期的做法（刷新令牌，或签发方给 Daisy 一个“代主人换令牌”的授权）要和外部签发方一侧一起定，见下面的问题。

## 偏离与待维护者在阶段关口确认的点（已答复：见末两节）

1. **新增通道 `issuer`**（契约 `Channel`、`PIN_VIA`、`Me.channel`、审计的 channel / actor 加 `visitor`）：token.md 第 3 节的通道表只列了自签发的通道；外部签发方签给主人的令牌在本机检查里需要一个名字。推荐保留；P2-04 的外部界面就以它连入。**它能不能回答 AI 的工具授权和提问**（scopes.md 第 2 节说能，设计的权限表和“入口等价”原则只列网页和配对设备）：审查后默认**不能**，请在关口定；要开放只需在两条定义的 `channels` 加 `issuer`。
2. **外部签发方的令牌在本机面也认**（不只对外面）：同一台机器上的界面后端（P2-04）也可能这样连。签名验证是同一套，风险相同。可以改成只认对外面。
3. **主人的令牌带 `act` 在本机一律当来访者**：token.md 4.2 写“权限按 AI 工作凭据”，但它不绑定会话和一轮，按 AI 工作凭据就什么也做不了，干脆拒绝。
4. **删除外部签发方不要 PIN**（`daisy:manage`）：照 ADR-110 关闭对外面的先例（收窄不要 PIN）。scopes.md 第 2 节把“配置外部签发方”整体写在 `grant` 下；如果要求删除也要 PIN，改一个字段即可。
5. **回环上允许 http 的签发方地址**：只在 `DAISY_ALLOW_HTTP_ISSUER=1` 且机器不是多人共用时（审查 M-3）；其余一律 https。另：**JWKS 取不到时缓存最多再用多久**，现在 24 小时（审查 M-2），请定数值。
6. **private_key_jwt 的 `aud` 用签发方标识**而不是令牌端点地址（RFC 7523 两者都允许，近年的安全建议偏向签发方标识）。要和外部签发方一侧对齐。客户端编号默认是 `<本 Daisy 的 URN>#client`（审查：不用 URN 本身，免得 Daisy 签给 AI 的令牌（`iss = sub = URN`）兼作客户端断言）。
7. **主人令牌怎么来、过期怎么办**（token.md 第 6 节只说“主人登录一次留下的”）：现在是主人在配置时贴上（`ownerToken`，要 PIN），过期了重新配置。要不要支持刷新令牌，或签发方给 Daisy 一个长期的“代主人”授权，需要和外部签发方一侧一起定。
8. **独立模式下 AI 令牌能带的 scope 上限**取主人本机的三个（去掉 `grant`）；外部模式取主人令牌的 scope（可以是别的系统的 scope，去掉 `daisy:grant`）。
9. **`daisy:events:read`**（契约草稿的推荐）这次没有加进 scope 名单：它属于 P2-03；加上后外部主人令牌的交集上限要随之加一项。（阶段 2 整合：P2-03 已把它加进 `OWNER_SCOPES`，外部主人令牌的 scope 与之取交集即带上它；令牌没写它就读不了事件出口，见 `tests/access.test.ts`。）
10. 契约草稿里的三项待决——自签发只用 EdDSA；代领令牌跨轮、取令牌接口只在一轮内；用 RFC 8693——都按推荐实施。

## 留给后面的工作包

- **P2-04**：外部界面带着签发方令牌经对外面连入已经可行（主人从别处连入的测试即此路径）；客户端包同时连多个 Daisy、界面的登录流程是 P2-04 的事。
- **阶段 4（A2A）**：`visitor` 主体是 A2A 入口要用的身份（`sub` 即来访者），本机接口对它的拒绝保持不变。
- **P5-05**：`issuer/`、`keys/issuer-owner-token` 在 Windows 上的 ACL。
- **接入文档**：MCP 怎么用 `DAISY_AI_CREDENTIAL_FILE` / `DAISY_URL` / `DAISY_SESSION_ID` 领令牌，Codex 的 `env_vars`。

## 安全审查修订（2026-11-17，按施工流程的约定只审一轮，“修完再合并”；修完仍不合入，等关口审批）

| 条目 | 改了什么 | 测试（`tests/issuer-review.test.ts`，另见各处） |
| --- | --- | --- |
| H-1【高】 | PIN 重置撤销外部签发方：`setupAccess` 在 `PinService.onReset` 上挂钩（在重置的事务里，抛错整体回滚；先清内存里的签发方和代领令牌，最后删 `config.json` 的 `issuer` 段、`issuer/`、`keys/issuer-owner-token`，可以重复执行）；`pinReset` 的说明补上 | 真 PinService：网页设 PIN、配置签发方、命令行重置 → `issuer.get()` 为 null、配置段与文件都没了、原主人令牌访问 `/api/me` 和 `POST /api/pin` 都 401、再重置一次无害；替身 PinService 同样 |
| M-1【中】 | 实时通道复查：`issuer` 通道的连接按订阅时记下的 `exp`、签发方、主人主体判断，到期、签发方删了或换了、主人主体变了就在下一次推送时关（1008）；其余照旧 | 真 WebSocket：签发方主人订阅 → 改标题收到 `changed` 且不断开；2 秒令牌到期后下一次推送被关；删除签发方后另一条连接下一次推送被关 |
| M-2【中】 | `TOKEN_LIMITS.jwksMaxStaleMs`（默认 24 小时，待关口定）：缓存过期超过它还取不到就一律 `unknown_key`，状态 `expired: true`（已失效）；limits.md 同步 | 签发方下线、缓存过期但未超限 → 200；超限 → 401（审计 `invalid_token/unknown_key`）、`expired`；签发方恢复 → 200 |
| M-3【中】 | 回环 http 只在 `DAISY_ALLOW_HTTP_ISSUER=1` 且 `sharedHost()` 为假时允许（否则 400 `issuer_invalid`），配置时和每次请求（JWKS、令牌交换）前都查；去掉 `localhost`，只留 `127.0.0.1`、`[::1]`；夹具设这个开关 | 多人共用 → 400（说明原因）；开关没开 → 400；`localhost` → 400；配置后变成多人共用 → 刷新 400、新 kid 不再去取；规则单测 |
| M-4【中】 | 存着的主人令牌记 SHA-256，guard 遇到相同的 Bearer 返回 401，审计原因 `owner_token_as_bearer`；契约说明“只用于替 AI 换令牌，不能用来登录” | 存着的那张 401（重新加载后仍然），另一张主人令牌 200 |
| 设计点 1 | `issuer` 通道默认不能回答工具授权和提问（两条定义的 `channels` 去掉 `issuer`），待关口确认 | 表驱动期望改为只有网页；`api-defs`、`cli-principle6` 的清单；直接调用两条接口都 403 `channel_not_allowed` |
| L-1 | `identify` 带回原因，审计写 `invalid_token/<原因>`（用斜杠：`token:<x>` 这种写法会被 P1-11 的脱敏层当成秘密遮掉），回答不变 | 过期、别的受众、不认识的 kid 各一条 |
| L-2 | 读回答体整段 try/catch，断开、超时统一 `issuer_unreachable` | （经已有的下线测试） |
| L-3 | 每个会话最多保留 16 张代领令牌（先丢最早到期的）、每分钟最多新领 10 次（签发或交换，不论成败），超过 429 `ai_token_rate_limited` | 第 11 次新领 429、重用不算；保留数封顶 16 |
| L-4 | 重新配置时受众或客户端编号变了，也删旧的主人令牌 | 同样的配置保留；换客户端、换受众各删一次 |
| L-5 | `stale` 只要过期就标，另加 `refreshing` | 过期但还没重取时 `stale: true`、`lastError: null` |
| 客户端编号 | 默认改为 `<URN>#client` | 状态里的 `clientId` |

## 阶段 2 关口决定（2026-11-17，维护者）

**外部签发方签给主人的令牌，有效期上限 24 小时。** 审查曾建议加，关口定为“加”。

- 规则：令牌的 `sub` 等于配置的主人主体（**不论有没有 `act`**），且 `exp - iat` 大于 `TOKEN_LIMITS.externalOwnerMaxS`（24 × 3600 秒）→ 拒绝，审计原因 `invalid_token/too_long`，调用方只得到 401 `invalid_token`（token.md 4.3）。正好 24 小时接受，多 1 秒拒绝。
- **没有 `iat` 一律拒绝**（不是“当成没超”）：`iat` 本来就是每张访问令牌必有的声明（第 1 节），缺了在签名验证那一步就拒，审计原因 `invalid_token/bad_claims`（原来 jose 把“缺声明”报成 `not_yet_valid`，这次一并改正为 `bad_claims`）。所以主人令牌不可能因为“看不出寿命”而绕过上限。
- 时钟误差：上限比的是令牌自己的两个声明之差，与本机时钟无关，所以**不加** 60 秒误差（与 `maxLifetimeS` 的既有做法一致）；`exp` / `iat` 对本机时钟的 60 秒误差照旧。
- 位置：只在 `ExternalIssuer.verify` 里写一次（`packages/daisy/src/access/tokens/external-issuer.ts`），所以几处用法一致：集中检查（HTTP，两个面）、实时通道第一帧、配置时校验存起来的主人令牌（超过 24 小时 → 400 `owner_token_invalid`，不保存）、P2-02 交换前复查存着的主人令牌。
- 不受影响：别人的令牌（来访者，`sub` 不是主人）不受这条上限，照旧 403 `a2a_only`；替 AI 代领的令牌（P2-02）本来 ≤ 1 小时，远在其内；本 Daisy 自签的令牌不经 `ExternalIssuer`。
- 带 `act` 的主人主体令牌（AI 代主人）在本机原本就是来访者、一律拒绝；超过 24 小时的现在在签名验证那一步就 401（不再走到 403 `a2a_only`）。
- 测试：`tests/issuer.test.ts` 里 24 小时上限的那一条——正好 24 小时（EdDSA、RS256，HTTP 与实时通道第一帧）通过；24 小时 + 1 秒、30 天、没有 `iat`（HTTP 与第一帧）拒绝，审计原因分别是 `too_long`、`bad_claims`；超过 24 小时的带 `act` 主人令牌 401；48 小时的来访者令牌仍是 403 `a2a_only`；配置存主人令牌：24 小时 + 1 秒、没有 `iat` → 400 `owner_token_invalid`，正好 24 小时 → 保存。
- 契约同步：token.md 4.2 第 3 步与第 5 节、limits.md 第 5 节。

其余“偏离与待确认的点”关口都按推荐确认，即上文现在的做法。

## 阶段 4 关口决定

阶段 4 关口（2026-11-17，维护者决定身份号统一 base32）：**本 Daisy 自签的令牌，`kid` 改成 base32 身份编号。** `SelfIssuer`（`packages/daisy/src/access/tokens/self-issuer.ts`）原来的 `kid` 是 base64url 指纹，现在：

- `kid` = 身份编号（base32 小写，52 字符）；新增只读的 `thumbprint`（base64url，43 字符），只用来拼 URN（`iss` = `urn:ietf:params:oauth:jwk-thumbprint:sha-256:<thumbprint>`，RFC 9278 不变）。
- 由它签的全部令牌一起改：AI 工作凭据（P1-03）、没有外部签发方时替 AI 代领的令牌（P2-02）、RFC 8693 交换里的两张短 JWT、跨 Daisy 出站令牌（P4-08）、`daisy token`（P4-12）。独立的 A2A MCP 用的 `signA2AToken`（`packages/a2a-client/src/token.ts`）同样改。
- `SelfIssuer.verify` 只认 base32 的 `kid`。升级时不需要同时认两种：AI 工作凭据随进程结束（`AiCredentials.open` 启动时清掉上次留下的），已签出的 `daisy token` 只在阶段 4 的未发布版本里出现过。
- 外部签发方（本 ADR 的主体）不受影响：它的 `kid` 是它 JWKS 里的名字，照旧按名字找钥匙。
- 测试：`tests/access.test.ts`（自己的钥匙、base64url `kid` → 401）、`tests/contacts.test.ts`（联系人的 base64url `kid` → 401，审计 `invalid_token/unknown_key`）、`tests/a2a-mcp.test.ts`（MCP 签的 `kid` 是 52 位 base32）。
