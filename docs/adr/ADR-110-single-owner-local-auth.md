# ADR-110：单主人与本机认证——三种身份、一处检查、两个入口面

- 日期：2026-11-17
- 状态：**已实施（P1-03）；安全审查修订已做（2026-11-17，见末节）**
- 工作包：P1-03（为 P1-07 命令行、P1-08 网页铺路）
- 相关：ADR-099（密钥与加密）、ADR-101（两个入口面）、ADR-102（数据目录与端口）、ADR-106（一个进程）、ADR-107（接口定义）；契约草稿 `docs/contracts/token.md`、`scopes.md`、`local-api.md`

## 背景

P1-03 之前，Daisy 沿用旧版的多账号模型：`users` / `tokens` 表、账号密码登录、管理员、宿主网关（`X-Auth-User` + 网关密钥）、执行节点的归属与吊销、按组网地址准入（`network.ts`）。P1-06 把每条接口的 scope、通道、`aiSelf`、PIN 标进了定义表，但没有人检查。设计要的是：一个 Daisy 一位主人，就是运行它的系统账户（维护者的决定）；本机有三种身份（主人本人、命令行、AI 工作凭据）；凡是能被拒绝的地方，在一处、按定义表拒绝。

## 决定

### 1. 主人与删除的东西

- 主人是一个固定的主体：`OWNER_ID = "owner"`，用户名取系统账户名（`access/owner.ts`）。所有行的 `owner_id` 都是它；处理函数里的 `user(req)` 只在请求已经过检查（带着 `daisyPrincipal`）时返回主人，否则 401——失败要关闭。
- 删除：多账号与管理员（`/api/users`、`role`、`adminPrivate`、管理员越权）、账号密码登录与令牌（`/api/login`、`/api/logout`、`/api/password`、`ACCESS.md`、`scripts/admin.ts`）、宿主网关与令牌交换（`/api/host/token`、`HARBOR_GATEWAY_SECRET_FILE`、`X-Auth-User`、`trustProxy`）、机器管理（`/api/nodes*`、节点归属、吊销、运行用户检查、`/api/network/devices`）、按内网地址准入（`network.ts`、`HARBOR_NETWORK_SNAPSHOT`）、身份档转给别的成员（`/api/profiles/:id/assign`）。定义表里标 `removal: P1-03` 的 11 条全部删除（P1-06 当时说“10 条”，没算 `account.hostToken`），豁免随之消失。
- 留下的：`nodes` 表只剩“本机 Runner 的记录”（能力上报、在线），节点 id 继续挂在工作区、身份档、任务上；整套 `node_id` 管道的去留交给存储重建（P1-04 之后），不在这一次。
- `users`、`tokens` 两张表和 `nodes.network_device` 列不再存在：合入 P1-04 后，P1-03 **直接修改了 `store/schema.ts` 的第 1 步**（P1-04 刚并入、还没有任何库用它建过，所以不是“改已冻结的结构”；`tests/schema-compat.test.ts` 的 `V1_SHA256` 随之更新）。P1-03 早先追加的“第 13 步删表”随 P1-04 的结构重建一起消失。单主人下，所有按人存的东西（`owner_id`、`user_prompt_prefs` / `notification_preferences` / `notification_events` 的 `user_id`）都由代码写成主人的 id（`owner`），测试核对。旧版的库不导入，P1-04 会拒绝它。`tests/compat-previous.test.ts`（上一版在新库上写）保留，上一版早于 P1-03 时跳过并写明原因。

### 2. 三种身份与凭据

| 身份 | 凭据 | 形式 | 在哪个面有效 | 认证结果（token.md 第 3 节） |
| --- | --- | --- | --- | --- |
| 命令行 | `keys/cli-credential`（0600），`dcli_` + 256 位随机 | 不透明串，进程里只存 SHA-256，定长比较 | 只本机面 | 主人、通道 `cli`、scope 为主人的四个 |
| 主人本人（网页） | 网页会话，`dweb_` + 256 位随机 | 不透明串，`keys/web-sessions.json`（0600）只存 SHA-256；本机面 30 天、对外面 7 天 | 只签发它的那个面 | 主人、通道 `web` |
| AI 工作凭据 | 每轮一张 JWT | RFC 9068 访问令牌，Ed25519 签名（`jose`），`typ: at+jwt`，`kid` = 身份密钥的 JWK 指纹 | 只本机面 | AI、通道 `ai`、`daisy:tools daisy:session:read`、会话 = `client_id` 里的那个 |

**为什么本机凭据和网页会话不用签名令牌。** ADR-099 推荐 4 已经这样定：它们从不离开这台机器，签名带来的“离线验证”用不上；不透明串可以立即作废（轮换、注销、关闭对外面），而 JWT 要另建吊销表才能做到。AI 工作凭据用 JWT，是因为它将来要交给 harness 里的 MCP 服务、阶段 2 的代领令牌（P2-02）同一套格式，且签名里带着会话和这一轮，验证不必查别的表就能拒绝大多数伪造。

**AI 工作凭据的细节**（`access/ai-credential.ts`）：

- 身份密钥 `keys/identity-key.json`（Ed25519 私钥 JWK，0600，首次启动生成）。`iss` = `sub` = `aud` = `urn:ietf:params:oauth:jwk-thumbprint:sha-256:<kid>`；`client_id = ai:<会话>`；`act = {sub: agent:<会话>}`；私有声明 `daisy_turn = <任务 id>`；有效期 ≤ 1 小时。
- 验证：只认 `EdDSA` / `Ed25519`，`typ` 必须是 `at+jwt`，`kid`、签发方、受众、主体、所有声明都核对，`exp - iat` 超过 1 小时拒绝，scope 必须恰好是那两个；然后查这一轮仍在运行、属于这个会话（token.md 4.1 第 8 步）。一轮结束，凭据立即无效。
- 交付：每轮开始（认领任务时）写进 `run/ai/<会话>`（0600，目录 0700），任务载荷带 `aiCredential: {file, url}`，Runner 给 harness 的环境变量是 `DAISY_AI_CREDENTIAL_FILE` 和 `DAISY_URL`。不直接放令牌本身：在线进程（旧版的约定：agent 进程常驻）跨很多轮，环境变量里的旧令牌下一轮就失效了。每 5 秒的清扫删除已结束那一轮的文件，快到期（剩 10 分钟）时换新。
- AI 自用工具（`daisy:tools`：定时、后台命令、主动发言）仍走进程内的 MCP 通道（Runner 直接服务 harness 的工具调用，只作用于当前任务的会话），不经本机接口，所以不需要也不接受这张凭据；本机接口里 AI 能用的只有写了 `aiSelf` 的 8 条只读接口。

**网页会话为什么用 Bearer 而不是 Cookie**（偏离 ADR-101“网页的 Cookie 用 SameSite=Strict”）：Cookie 按主机共享、不分端口——同一台机器上另一个 Daisy（另一个系统账户的，127.0.0.1 的另一个端口）或任何本机开发服务器的页面发起的请求都会带上它，`SameSite` 也把同主机不同端口算作同站。Bearer 存在页面自己的 `sessionStorage`（按源隔离，含端口），别的页面拿不到也发不出，跨站伪造请求在结构上不存在。防跨站检查照样始终开启（第 3 节），这是第二层。

**一次性口令**：128 位随机，10 分钟，用一次，只对签发它的面有效，只在内存里存 SHA-256。`daisy open`（P1-07）凭本机凭据调 `POST /api/web/open-code`（本机面，`daisy:manage`）或 `POST /api/web/open-code/external`（对外面，`daisy:grant` + PIN——拿到它的人能从网络上以主人身份打开网页），打印 `http://127.0.0.1:<端口>/#code=<口令>`；口令在 `#` 后面，不进请求行和日志。网页用 `POST /api/web/session {code}` 换会话。

**口令可选**：`config.json` 的 `passcode`：`auto`（默认）、`on`、`off`；改它要 PIN（`PUT /api/access/passcode`）。生效条件：设为 `on`；或对外面开着；或 `auto` 且这台机器是多人共用的。口令不生效时，本机面上**同源网页**可以不带口令换一张会话，条件是：带自己的 `Origin`（没有 `Origin` 的脚本不行），**并且连接另一端的进程属于主人的系统账户**（`access/peer.ts`，审查 H-1）——Linux 在 `/proc/net/tcp`（及 `tcp6`）里找客户端那一端（本地 `127.0.0.1:<客户端端口>`、对端 `127.0.0.1:<本机面端口>`）的 uid；macOS 用 `lsof` 查这个客户端端口是否由本账户、本进程以外的进程持有；别的系统、出错、超时一律当作不是（要口令）。这些会话标记为“无口令”；一旦口令生效，它们不再算数。多人共用的判断（`access/shared-host.ts`）：Linux 看 `getent passwd`（取不到读 `/etc/passwd`）里有没有别的、uid ≥ UID_MIN、有登录 shell 的账户，再看 `/proc` 里有没有别的这类 uid 的进程（目录服务的账户不一定能枚举）；macOS 看 `dscl` 里 uid ≥ 501、名字不以 `_` 开头的别的账户；别的系统、或者取不到答案，一律算多人共用（失败要关闭）。

### 3. 集中检查（`access/guard.ts`）

一个 `onRequest` 钩子，装在所有别的钩子（限流、路由）之前。按顺序：

1. `Host` 只能是这个面自己的名字（本机面 `127.0.0.1:<端口>`、`localhost:<端口>`；对外面是主人设的地址，`0.0.0.0` 时是本机各网卡地址和主机名）——防 DNS 重绑定。
2. `/api` 下：带 `Origin` 的必须是这个面自己的源（端口不同就是别的源）；带 `Sec-Fetch-Site` 的只能是 `same-origin` 或 `none`。不再注册 CORS：没有任何别的源会被告知可以读回答；`HARBOR_ORIGINS` 只剩链接和 CSP 的 `frame-ancestors`，不再让别的源的请求通过。WebSocket 的升级请求同样检查。
3. 定义表里没有的 `/api` 路由一律拒绝（`route_not_defined`）；路径根本不存在的照常 404。`/api` 之外（网页静态文件、`/terminal-assets`）只做第 1 步。
4. `scope: null` 的只有健康检查和 `POST /api/web/session`（它自己核对口令）。实时通道（`socket-first-frame`）在第一帧用同一套 `identify` / `authorize`。
5. 识别凭据（`Authorization: Bearer`）：本机凭据只在本机面，网页会话只在签发它的面，AI 凭据只在本机面且这一轮在运行。认不出 → 401，`WWW-Authenticate: Bearer error="invalid_token"`，不说是哪一条不对。
6. 按定义授权：对外面的开关（`external`：终端 / 执行命令 / 浏览目录，默认关）→ 通道（`channels`，命令行不能回答 AI 的工具授权和提问）→ AI 只限 `aiSelf` 指向自己的会话 → scope → PIN（`pin: true` 时 `PinService.check(请求头 daisy-pin-grant, 持有者)`；没有 PinService 一律拒绝）。

接口定义新增一个字段 `external?: "terminal" | "shell" | "browse"`，标在 9 条接口上（`session.shellRun` / `shellStatus`、`session.terminalList` / `terminalOutput` / `terminalInput` / `terminalOpen`、`session.harnessConfig`、`workspace.browse` / `browseResult`），文档里写明“对外面上默认关闭”。打开终端原来是 `session.operation` 的一个子操作，审查 M-1 把它拆成 `POST /api/sessions/:id/operations/terminal`（`session.terminalOpen`，`external: "terminal"`）；改 harness 配置（`mcp.add` 原样写命令行、`config.write` 能写 hooks，都会在以后执行命令）标 `external: "shell"`。客户端 `operation()` 按名字选路径。

定义表外的路由（审查 L-3）：只放行路径根本不存在的（404）、`/terminal-assets/:name`、网页静态文件（`/*`、`/`）的 GET / HEAD；别的——包括插件经 `EventHost.app` 自己注册的——一律 `route_not_defined`。

面的判断（审查 L-2）：连接被哪个监听器接受就打哪个标记（本机面在 `createApp` 里给 Fastify 的服务器打）；没有标记的真实套接字一律当对外面（不会比对外面更受信任），只有进程内的请求（`app.inject`，不是 `net.Socket`）算本机面。

PIN（P1-05 的 `packages/daisy/src/access/pin.ts`，`createApp` 里创建；测试可经 `opts.pin` 换替身，`null` 表示没有 PIN 服务——一律拒绝）。P1-05 的 PIN 路由用这里的 `holderOf(principal)` 绑定授权、用主体的通道记 `pin@<通道>`；`pinReset` 不再自己拒绝，由集中检查只放行命令行通道（命令行凭据只在本机面有效）。PIN 授权绑定持有者（local-api.md 6.3）：持有者是 `web:<网页会话的 SHA-256>`，或 `cli`。P1-05 的 `grant(pin, holder)` / `check(grant, holder)` 按这个值绑定。命令行的持有者是一个固定名字，所有命令行进程（主人的终端、AI 的 shell）共用，所以审查 M-3 把它改成**一次有效**：检查通过后立即 `PinService.consume(grant, "cli")` 用掉；PinService 没有 `consume` 时，命令行的 PIN 操作一律拒绝（`pin-seam.ts` 注释写明）。网页会话的授权在它的几分钟里可以多次用。

### 4. 两个入口面

- **本机面**：Fastify 自己的服务器，只监听 `127.0.0.1`（不监听 `::1`：浏览器的 `localhost` 会退回 IPv4；`HOST` 不是 127.0.0.1 时拒绝启动并说明“请开启对外面”）。
- **对外面**：默认关。`PUT /api/access/external`（`daisy:grant` + PIN）开启或改动：监听地址、端口、TLS（默认开，自签名证书，见下）、终端 / 执行命令 / 浏览目录三个开关（默认关）。明文只允许组网或内网地址（10/8、172.16/12、192.168/16、100.64/10、127/8、fc00::/7）。`DELETE /api/access/external`（`daisy:manage`，收窄不要 PIN）关闭，对外面的网页会话一并作废。开启后口令自动生效，本机“无口令”的会话随即作废。
- **面怎么定**：同一个进程、同一个路由器，两个监听器；每个连接在被接受时按监听器打上面的标记，检查只读这个标记，从不看来源地址或请求头。这是对 ADR-101 方案 A1（两个 Fastify 实例、各注册自己的路由）的偏离：阶段 1 两个面上的路由完全相同（对外面只是少认几种凭据、多三个开关），两套实例等于把全部路由注册两遍；A1 要防的“按地址区分”（A2）在这里不存在。阶段 4 的 A2A、阶段 5 的中转注入需要“只在一个面上存在”的路由时，再按 A1 拆出第二个实例。
- **TLS**：首次开启时生成自签名证书（RSA-2048 密钥由 `node:crypto` 生成，X.509 由 `node-forge` 写——`node:crypto` 不能生成证书），证书覆盖主人设的地址和 127.0.0.1，`keys/tls-key.pem`、`tls-cert.pem` 都是 0600；地址变了、快过期了就重新生成。CA 证书是阶段 5（ADR-100）。
- 阶段 1 的对外面只承载主人接口（凭对外面的网页会话），没有配对（P5-03）、没有 A2A（阶段 4）。

### 5. 端口（`access/ports.ts`）

首选端口 = 本机面 29200 + (uid mod 390)、对外面 29600 + (uid mod 390)。主人指定的（`DAISY_PORT`，对外面的 `port`）照用，被占就拒绝启动、不悄悄换；否则先用记住的（`config.json` 的 `ports`），没有就用首选的；被占就在本段 390 个端口里往后找（绕回开头），首次启动找到的记住，之后的只用于这一次（来源 `moved`）。实际端口写进 `runtimeFile(dataDir)`（`runtime.json`，0600）：进程号、版本、启动时间、数据目录、两个面的地址与端口和来源、本机凭据文件的路径（不含凭据本身）；对外面开关时重写，退出时删除。Windows 的 RID 取法留给 P5-05（现在取不到 uid 时按 0）。

### 6. 审计

每个**通过检查的改动**（定义表内、非 GET、有主体）在回答后记一条 `api.<接口 id>`：`user_id` 是谁，`target` 是 `{face, channel, status}`，不记查询串和请求体（审查 M-2）；网页会话签发、一次性口令签发、对外面开关、口令设置这几条也带面和通道。每个被拒绝的请求记一条 `access.denied`：`user_id` 是谁（`anonymous`、`cli`、`web`、`ai:<会话>`），`target` 是 `{face, channel, target: "<接口 id> <方法> <路径>", why: <错误码>}`。不记查询串、请求头、请求体、凭据、PIN、授权、口令。每分钟最多写 300 条，超出的计数，下一分钟记一条 `access.denied.suppressed`。网页会话的签发、一次性口令的签发、对外面的开关、口令设置也各记一条。

### 7. P1-06 审查留下的两条

- `GET /api/sessions/:id/queue` 先跑 `tidyAppends`（会写库）。AI 凭据读取时**跳过**：AI 只有读权限，它的读不应该改任何东西；整理在主人下一次读或这一轮自己结束时照样发生。
- `session.operation` 里改 harness 配置的子操作（`config.write`、`mcp.add` / `mcp.remove`、`plugin.install` / `plugin.uninstall`、`skill.write`）**拆成独立接口** `POST /api/sessions/:id/operations/harness`（`daisy:manage`，命令 `daisy session operation harness`）；原接口的 `name` 不再接受这几个。没有选“按请求体字段定 scope”：那样检查就得在请求体解析之后、按处理函数的知识做，不再是“只读定义”的一处检查。客户端 `operation()` 按名字自动选路径，界面不用改。

## 后果

- 只能由主人的系统账户拿到的两样东西决定谁进得来：本机凭据文件（0600）和一次性口令（要么用本机凭据换；要么在口令不生效时由同源网页直接换，而这要求连接另一端的进程属于主人的系统账户）。同一主机的别的系统账户——包括“多人共用”判断不计入的服务账户（没有登录 shell、uid 低于 UID_MIN 的那些）——读不到前者，也过不了后者的对端检查。审查 H-1 之前，后一条只看 `Origin`，可被伪造。
- 已知的、设计上接受的限制：AI 以主人的系统账户运行，读得到本机凭据文件，所以经命令行能做的它都能做，还能用它换一次性口令、冒充网页去回答工具授权——设计里写明这在个人电脑上“只是约定”。这条路会在审计里留下记录：`web.code`（主体 `cli`、通道 `cli`）、随后的 `web.session.open`（通道 `web`），之后的回答是 `api.approval.respond`（通道 `web`）。PIN 保护的那一类仍然挡住（AI 不知道 PIN，ADR-099 已写明它能离线猜校验值的风险）。口令关闭时，本机任何能伪造 `Origin` 的进程都能换到网页会话；所以口令的 `auto` 在任何不确定的情况下都按多人共用处理。
- 浏览器端到端脚本（`scripts/e2e*.cjs`）原来读 `ACCESS.md` 用账号密码登录，现在跑不通，交给 P1-08 按新方式重写（`scripts/local-daisy.ts` 已提供“读运行时文件和本机凭据、换一次性口令、换网页会话”的做法）。
- 开发时从别的源（例如 `expo start` 的 8081 端口）调本机接口会被拒；开发用 `build:web` 后由 Daisy 自己提供的网页。

## 留给后面的工作包

- **P1-07 命令行**：读 `runtimeFile(dataDir())` 得到本机面地址和本机凭据文件路径（`cliCredentialFile(dataDir)`），`Authorization: Bearer <文件内容>`；`daisy open` 调 `POST /api/web/open-code`（加 `--external` 调 `/open-code/external`，带 PIN 授权）然后打开 / 打印回答里的 `url`；`daisy access show|external on|external off|passcode` 是表里的命令；要 PIN 的命令先向 P1-05 的接口换授权，放在 `daisy-pin-grant` 请求头。
- **P1-08 网页**：登录页已改成“一次性口令”，启动时先认 `#code=`、再试已存的会话、再试无口令换会话；设置页还没有“两个入口面与口令”的界面（接口是 `GET /api/access`、`PUT/DELETE /api/access/external`、`PUT /api/access/passcode`）；节点表只剩本机一张卡片，整体改造照 P1-08；浏览器 e2e 脚本重写；对外面明文 / 自签名下浏览器功能的清单（明文下浏览器不把它当安全来源，一部分功能不可用，要逐个确认）。
- **P1-04 存储**：已按约定处理（第 1 节）；`config.json` 归属与写法如有统一的设置存储，可以并过去。`nodes` 的 `owner_id`、`revoked_at`、`runner_user`、`runner_uid`、`kind` 和整条 `node_id` 管道还留着（只表示本机 Runner），要去掉得追加带 `breaking` 的步骤。
- **P5-05**：Windows 上 `keys/` 的 ACL 与 RID；`access/peer.ts` 在 Windows 上一律返回“不是主人”（口令关闭时也要口令），届时用 `GetExtendedTcpTable` 取对端进程。
- **阶段 4**：`packages/daisy/src/_phase4/` 里还有几处查 `users` 表（`resident.ts:173`、`invoke-access.ts:768`、`:794`、`:926`），重建时改成主人或来访者的身份，不能照搬。

## 安全审查修订（2026-11-17）

| 条目 | 改了什么 |
| --- | --- |
| H-1 | 免口令换会话加 `peerIsOwner(req)`（`access/peer.ts`），对端不是主人的系统账户就 401 `passcode_required`；`createApp` 可注入（测试） |
| M-1 | `session.harnessConfig` 标 `external: "shell"`；打开终端拆成 `session.terminalOpen`（`external: "terminal"`） |
| M-2 | 通过检查的改动在 `onResponse` 记 `api.<id>`（面、通道、状态码）；`access/routes.ts` 的审计记真正的主体和面、通道 |
| M-3 | PIN 授权按持有者绑定并测试；命令行的授权用一次即作废（`consume`），没有 `consume` 时命令行一律拒绝 |
| L-1 | 对外面的地址 / 明文校验抽成 `validateExternal`，每次启动对外面都先校验 |
| L-2 | 没有面标记的真实套接字当对外面；本机面的标记在 `createApp` 里打 |
| L-3 | 定义表外的非 /api 路由只放行 404、`/terminal-assets/:name`、静态文件 |
| L-4 | 对外面的说明与 `privateAddress` 一致（回环允许，127/8、::1、fc00::/7） |
| L-5 | 启动时清掉 `run/ai/` 里上一次留下的 AI 凭据文件 |
| L-6 | 合入 P1-04 后没有迁移步骤可改：第 1 步结构里这些表照旧，单主人下代码写入的 `user_id` 都是 `owner`（`tests/schema-compat.test.ts` 核对 `user_prompt_prefs`、`notification_preferences`） |
| L-7 | 会话交换的限流按“地址 + 带不带口令”分桶（被检查拒绝的请求到不了这一步）；会话表满时先挤掉无口令的 |
| L-8 | 见上一节“阶段 4” |
