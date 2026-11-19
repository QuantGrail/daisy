# ADR-143：中转程序 `@daisy-ai/relay`——按 SNI 透传、身份密钥登记、不在线握手拒绝

- 日期：2026-11-18
- 状态：**已实施（P5-01，分支 `p5-01`，基于 `daisy-next`；未合入 `daisy-next`；包没有发布）**
- 工作包：P5-01（中转程序）
- 相关：P5-02（Daisy 一侧）；维护者的决定（中转只做转发：不保存、不穿透、内容端到端加密；不在线在握手阶段拒绝（D1）；ADR-100-1/3/5 与 ADR-103-3 按推荐；先用假域名和本地证书机构开发测试）；质量要求（不在线判定 5 秒、中转重启后 30 秒内重连）；安全工作包，需独立审查；ADR-099（身份密钥）、ADR-100（中转协议与端到端加密，本 ADR 落实它）、ADR-101（中转进来的只到对外面，P5-02 落实）、ADR-103（`packages/relay`，单独发布，不依赖 Daisy）、ADR-120 / identity-card.md（身份编号）

## 背景

ADR-100 定了做法，维护者确认：A1 中转按 SNI 透传 TLS、不终止；中转只为自己的域名终止 TLS（控制连接、数据连接、在线查询）；子域名取身份公钥指纹前 160 位的小写 base32，只分给能用对应私钥签挑战的 Daisy；C1 一条控制 WebSocket + 每个外来连接反连一条数据 WebSocket；协议带版本号、写成短规范随中转发布；D1 不在线在握手阶段拒绝，另给在线查询接口。本包把它做成一个独立的小程序。

## 决定

### 1. 包与边界

- `packages/relay`（`@daisy-ai/relay`，命令 `daisy-relay`，新常量 `RELAY_COMMAND_NAME`，`RELAY_NAME` 已有）。`build.mjs` 用 esbuild 打成一个文件 `dist/daisy-relay.mjs`（带 shebang），只允许打进 `packages/relay/src`、`packages/a2a-client/src/identity.ts`（及其 `constants.ts`）和 `packages/contracts/src/names.ts`；`ws`、`jose` 留作 import，必须在 `dependencies`（精确版本 8.22.0、6.2.12，与仓库锁文件相同，没有新版本进来）。`npm pack` 只带 bundle、`PROTOCOL.md`、`README.md`、`relay.example.json`、`LICENSE`、`package.json`。`private: true`，不发布。
- 中转不依赖 Daisy（ADR-103）：测试逐文件检查 `src` 的 import 只有 `node:*`、`ws`、`jose`、身份编号代码和名字常量；`src/protocol.ts` 不 import 任何东西，P5-02 可以按路径直接引用。
- `scripts/check-core-names.mjs` 的扫描范围加 `packages/relay`（单独发布、服务任何 Daisy 的程序不应提到插件）。

### 2. 登记：身份密钥签挑战

- 控制连接 `wss://<域名>/v1/control`。中转先发 `{"t":"challenge","v":1,"nonce","aud"}`（32 字节随机 nonce，`aud` = 中转域名）；Daisy 回一条 `{"t":"hello","v":1,"proof"}`，`proof` 是 Ed25519 身份私钥签的 JWS，头**恰好** `{"alg":"EdDSA","typ":"daisy-relay-proof+jwt"}`，载荷 `{v:1, aud, nonce, key:{kty,crv,x}}`。`typ` 与名片、访问令牌都不同，三种签名不能互相顶替。
- 中转逐项检查（每项单独被拒绝的测试）：JWS 形状；头只有 `alg`、`typ` 两个成员（`jwk`、`kid`、`crit` 等一律拒绝）；`v`；`aud` 是自己；`nonce` 是本连接发的（截获的证明换连接就没用）；`key` 只有 `crv,kty,x`、`x` 是 32 字节规范 base64url（带 `d` 拒绝）；签名在 `key` 下成立（`jose.compactVerify`，算法白名单 EdDSA）。失败关闭码 4401，日志记原因词。
- 子域名 = `base32(SHA-256(RFC 7638 JWK))` 的前 20 字节 = **身份编号的前 32 个字符**（160 位正好 32 个 base32 字符）。用的是 P4-01 的 `thumbprintBytes` / `base32`，所以与名片的身份编号同源。客户端消息里多带的 `subdomain` 之类字段一律忽略，子域名只从密钥算。
- 同一把钥匙再次登记成功：**新连接取代旧连接**（旧的收到 4409）。理由：只有私钥持有者做得到，所以不是抢占；一条悄悄断掉的旧连接不必等心跳超时，Daisy 重连立即生效。不同钥匙得到不同子域名，碰不到别人。（见“待维护者确认”①）

### 3. 分流（公网端口）

- 一个 `net.Server`，对每个连接读 TLS ClientHello（`src/sni.ts`：纯函数，记录类型必须是 handshake、版本 3.x、单个记录 1–16384 字节、可跨记录重组、总长有上限；SNI 只取一个 `host_name`，ASCII 字母数字点连字符、不带结尾点、标签不超过 63；重复扩展、畸形长度一律 `bad`），只读到 ClientHello 为止，**绝对时限**内收不全就关（防一字节一字节的慢速攻击）。
- SNI 等于中转域名：`socket.unshift(已读字节)` 后交给中转自己的 `https.Server`（`emit("connection")`）。这是唯一终止的 TLS。
- `<32 字符>.<域名>` 且在线、未超上限：生成一次性 `claim`（32 字节随机），在控制连接上发 `open`，暂停调用方的套接字（ClientHello 留在内存，计入 `heldBytes`）；Daisy 在 `claimTimeoutMs` 内开 `wss://<域名>/v1/data` 发 `claim`，中转从表里**先删掉**这条凭据再对接：先把 ClientHello 作为二进制帧发出，然后双向原样搬字节。之后数据连接上只允许二进制帧。
- 不在线、其他名字、没有 SNI：回一条明文 TLS 警报 `unrecognized_name`（112）并关闭（D1）；超上限、Daisy 拒绝（`reject`）、认领超时：`internal_error`（80）。不认识的名字不写日志。Daisy 掉线时它还没被认领的调用方立即被拒绝。
- 在线查询 `GET https://<域名>/v1/presence/<子域名>` → `{v, subdomain, online}`；`GET /v1/info` → 协议版本。中转自己的 HTTPS 每个连接只处理一个请求（`connection: close`），只接受 GET/HEAD。

### 4. 心跳与重启

中转每 `pingIntervalMs` 发 WebSocket ping，到下一次还没 pong 就断开、视为离线。停止时向所有控制连接发 **1012**（服务重启），然后关闭一切。Daisy 侧退避：`基数 × 2^次数`、有上限、乘 0.5–1 的随机因子（这个形式保证相邻两次的间隔不减），登记成功清零。PROTOCOL.md 第 6 节写给 P5-02。

### 5. 上限集中成配置

`src/config.ts` 的 `DEFAULT_LIMITS` 是全部上限，配置文件 `limits` 可改（不认识的键、非正整数、`maxPendingPerDaisy > maxStreamsPerDaisy` 拒绝启动）：

| 组 | 上限（默认） |
| --- | --- |
| 公网端口 | 总连接 10000；每地址（IPv6 按 /64）连接 512、新建 20/秒（突发 100）；ClientHello 绝对时限 10 秒、最大 16 KiB |
| 中转自己的域名 | TLS 握手 10 秒；请求头**绝对**时限 10 秒（Node 的 `headersTimeout` 只对自己 `listen` 的服务器生效，这里是被递套接字，所以自己计时）；头 8 KiB；每地址 20 请求/秒（突发 100） |
| Daisy | 在线 1000；未登记的控制连接 256；hello 时限 10 秒；控制消息 8 KiB、20 条/秒（突发 100）；ping 20 秒 |
| 流 | 每个 Daisy 64 条（等待认领的 16 条）；未认领的数据连接 1024；新流 20/秒（突发 60）；认领时限 5 秒；数据帧 1 MiB；每条流 256 MiB（“单个请求的大小上限”在透传下的等价物）、空闲 5 分钟、最长 1 小时；每个 Daisy 16 MiB/秒（所有流、两个方向合计，按队列定时放行，不只是暂停读） |
| 记账 | 记住的地址最多 100000 个（空闲的先忘） |

每地址连接数默认放得较宽（512）：同一个出口地址后面可能有几十个 Daisy，每个 Daisy 自己的数据连接也算在内；单个 Daisy 被打的程度由“每个 Daisy 的流数和新流速率”管。

### 6. 日志

每行一个 JSON（标准输出）。`src/log.ts` 只放行白名单字段（`ip`、`sub`、`n`、`code`、`reason`、字节数、时长、计数、监听信息），别的字段丢弃并计数，测试断言为 0；字符串截到 120。永远不记：载荷字节、`claim`、`nonce`、`proof`、中转不服务的 SNI。流水号 `n` 用于两边对照。

### 7. 命令

`daisy-relay [--config <文件>]`、`--check`（检查配置和证书：证书必须覆盖中转域名，**覆盖 `<32 字符>.<域名>` 的通配证书拒绝启动**——中转若持有它就能解密）、`--version`、`--help`。环境变量 `DAISY_RELAY_*` 覆盖文件。`SIGHUP` 重读证书，`SIGTERM` / `SIGINT` 停止。

### 8. 不做的（写进 PROTOCOL.md 第 10 节）

- **HTTP-01 的 80 端口明文转发**：要在 `open` 里区分明文和 TLS，Daisy 一侧也要分开处理，不算便宜；版本 1 不监听 80，留给以后的次版本（ADR-100 里它本来就是 TLS-ALPN-01 失败时的第二选择）。
- 多路复用、好记的别名、CT 监看。

### 9. 安全审查第一轮的修订（2026-11-18；没有 High，3 个 Medium、3 个 Low，全部修了）

PROTOCOL.md 修订 1.1（协议版本仍是 1，没有发布过；改动见其文末“修订记录”）。

| 编号 | 问题 | 修法 |
| --- | --- | --- |
| M1 | 全局池子没有按来源分份：两个地址就能占满 256 个未登记控制连接（hello 10 秒）、1024 个未认领数据连接；新钥匙登记不花成本；升级不看 `Origin` | 未登记控制连接每来源 `maxUnauthControlsPerIp`（8，超出 429）；在线 Daisy 每来源 `maxDaisysPerIp`（128，超出 4503；同一把钥匙重连不占新份额）；hello 时限 3 秒；**认领凭据移到升级请求头 `daisy-relay-claim`，升级前检查**，不对就 HTTP 404，未认领数据连接这个池子不再存在（`maxUnclaimedData` 删去）；带 `Origin` 的升级一律 403；可选的运营方允许名单 `allowIdentities`（名单外 4403） |
| M2 | 缓冲没有上限：每方向 1 MiB 窗口、1 MiB 帧，`Paced` 不看套接字背压，没有全局预算；正在关闭的流离开计数却还占着缓冲最多 30 秒 | 每条流每方向窗口 `streamWindowBytes`（256 KiB）；`Paced` 在目标 `writableNeedDrain` / `bufferedAmount` 超窗口时停下等排空，排队超窗口或全局预算用完时停止读来源；全局预算 `maxBufferedBytes`（128 MiB，含等待认领的 ClientHello），超出时新流以 `internal_error` 拒绝；`maxDataFrameBytes` 改 64 KiB；关闭中的流在彻底拆掉前仍算在 Daisy 的流数里，宽限 `streamCloseGraceMs`（5 秒） |
| M3 | 同一出口地址后面的几个 Daisy 互相拖累：数据连接升级花地址的请求额度、占地址的连接数，而这些是调用方驱动的 | 带有效凭据的数据连接不花地址的请求额度，并把它在地址上的连接名额和新建连接令牌退回——它算在自己的 Daisy 名下（`maxStreamsPerDaisy`）。凭据不对的升级照样花额度（猜凭据有成本） |
| L1 | `--check` / 启动时只试了一个标签，`z*.relay.test`、某个 Daisy 的子域名、别的域名都能混过去 | 逐个检查证书的每个 SAN（没有 SAN 时看 CN），除了恰好中转自己的域名，带任何别的名字都拒绝 |
| L2 | 每地址只按 /64 计；地址表满时淘汰会把别人的桶重置 | IPv6 按 /64、/56（× `source56Factor`=4）、/48（× `source48Factor`=16）三级同时计数和限速；只忘记“什么都没计、桶是满的”条目，所以忘记不会重置任何东西；表满且都在用时，新来源被拒绝（宁可拒绝，不给新桶） |
| L3 | 未登记的一方能让中转写 info 日志，内容里还有对方挑的标签 | 未登记一方能触发的拒绝（握手、离线目标、登记失败、升级失败、限频……）只写 debug，并按原因计数，每 `refusalLogIntervalMs`（60 秒）写一行 info 合计；`state().refusals` 可查 |
| 探针 B | 中转自己的域名上逐字节拖 TLS 握手 | 实测 Node 的 `handshakeTimeout` 本身就是绝对的；中转另加一道从递交起算的绝对时限，握手完成后请求头再一个绝对时限 |

测试：`relay-review.test.ts` 每个问题一条（先写被拒绝的），在修好的代码上通过；把对应的修法单独撤掉，那条测试就失败（14 处逐一核对过；“退回新建连接令牌”第一轮没被抓到，补了一条专门的测试）。探针 B 例外：Node 的 `handshakeTimeout` 本身就是绝对时限，中转自己的截止时间是第二道保险，测试只钉住行为。原来的测试按新的数据连接握手改了（`relay-login` 的重用 / 猜测 / 没带 / 格式不对的凭据都是升级前 404；`relay-limits` 的帧上限改用直接发一个超限的帧）。

## 测试（`packages/relay/tests`，CI 的 `scripts/ci-test.mjs` 自动包含 `packages/*/tests`）

全部在本机回环上，假域名 `relay.test`，测试 CA 用 node-forge 现做（维护者的决定：先用假域名和本地证书机构开发测试——没有真域名、没有 ACME、不出本机）。测试里的 Daisy 一侧（`tests/helpers/daisy-side.ts`）就是 PROTOCOL.md 的最小实现：Ed25519 身份、签挑战、认领、把字节流交给持有 `<子域名>.relay.test` 证书的 HTTPS 服务端、退避重连。

| 要求 / 规则 | 测试 |
| --- | --- |
| **中转上看不到明文** | `relay-acceptance`：一个 TCP 窃听器挡在公网端口前，记下所有连接（调用方、Daisy 的控制和数据连接）的每个字节；测试 Daisy 记下中转交给它的每一帧；再加全部日志。三次真实 HTTPS 调用（带令牌、路径、请求体，一次 200 KB）端到端经过中转。断言：调用方看到的是 Daisy 的证书（SPKI）而不是中转的；每条调用方连接两个方向都恰好是一串 TLS 记录，ClientHello 之后只有密文记录（TLS 1.3 下连 Daisy 的证书 DER 都不出现）；交给 Daisy 的字节与调用方发出的逐字节相同（只可能缺最后一条关闭警报），反向同理——中转没加、没改任何东西；任何地方（线路、帧、日志）都找不到请求、令牌、路径、回答；日志里没有 claim、nonce，没有被丢弃的字段；之后中转不持有任何字节。唯一可读的是 SNI |
| **目标不在线** | `relay-acceptance`：在线查询答 false；带请求体和令牌的真实 HTTPS 调用在握手阶段收到 `unrecognized_name`，耗时远低于 5 秒；线路上调用方只发出了握手记录（请求和令牌根本没发出），回来的恰好是 7 字节的警报；中转没有这个名字的记录、没有等待的流、没有持有字节；目标随后上线，**什么都没有补投**，查询答 true、调用成功；再下线又立即拒绝。另一条：在线但不认领 → 认领时限到即 `internal_error`；Daisy 掉线 → 等待中的调用方立即被拒 |
| **中转重启** | `relay-acceptance`：中转关闭，Daisy 收到 1012；1.5 秒后同一端口起新中转；Daisy 在 30 秒（质量要求）内、实测约 2 秒回来，期间多次重试且间隔不减；同一子域名，调用恢复 |
| ADR-100 作恶中转模拟 | `relay-acceptance`：模拟运营者用同一 CA 为子域名签证书、在中间终止 TLS：普通 WebPKI 客户端被骗、请求和令牌被读到（维护者接受并写明的限度：作恶的中转运营者可对第三方客户端冒签证书）；但它出示的 SPKI 不是 Daisy 的——Daisy 调用方按 TLS 绑定声明先比对 SPKI 再发令牌就会停下（P5-02 落实）；诚实中转交给调用方的是 Daisy 自己的 SPKI |
| 登记先写被拒绝的 | `relay-login`：流还开着时第二个连接用同一 claim 认领被拒、拿不到字节；用攻击者的钥匙签受害者的公钥、重放受害者的旧证明、给别的中转的证明、名片 / 访问令牌 / 无 `typ`、头里带 `jwk` / `kid` / `crit`、带私钥的 `key`、别的曲线、坏 `x`、`v:2`、缺 nonce、`alg:none`、HS256、别的 Ed25519 钥匙——全部 4401，受害者的子域名从未上线；非 hello、二进制、两条 hello、超时；第二个 Daisy 点名要受害者的子域名仍拿到自己的、看不到受害者的 `open`，受害者照常收调用；用过的、猜的 claim 升级前 404；同一把钥匙取代旧连接；`maxDaisys`、未登记连接上限；Daisy `reject` |
| 上限先写被拒绝的 | `relay-limits`：一字节一字节的 ClientHello 和不说话的连接在绝对时限被关；明文 HTTP、超长记录、声称 1 MB 的 ClientHello、非 ClientHello、空记录、跨记录无限增长都不回一个字节就关；每地址连接数、新建速率、总连接数；每个 Daisy 等待中 / 总流数、新流速率；流字节上限、空闲、最长时长；带宽（300 KB 在 100 KB/秒下约 2 秒）；控制消息太多 / 太大 / 二进制；不回 pong 的 Daisy 被判离线；数据帧超限、认领后发文本帧；中转自己 HTTPS 的慢速请求头（包括一字节一字节）、超大请求头、限频 429、404 / 405 / 400、半截 TLS 握手 |
| ClientHello 解析 | `relay-sni`：Node 真实的 TLS 1.3 / 1.2 ClientHello 整个、每个前缀、拆成 1 / 7 / 100 字节的记录；没有 SNI；畸形 SNI 与 ClientHello 各种；随机与变异输入 6000 次不抛异常、不编出名字 |
| 包 | `relay-package`：配置（文件、环境变量、各种错误）；`--check` 拒绝通配证书和别的域名；打出的 bundle 真的跑起来（Daisy 登记、调用、SIGTERM 后 Daisy 收到 1012、退出码 0）；`npm pack` 文件清单；不依赖 Daisy；PROTOCOL.md 与代码的常量一致；日志白名单；IPv6 /64 |

变异核对（改坏一处、对应测试必须失败，全部做过一遍）：去掉 nonce / aud / 头 / 签名检查各一处；claim 用后不删；把子域名当成中转自己的域名终止；ClientHello 时限不关连接；Daisy 掉线不拒绝等待的调用方；去掉新流速率、文本帧、`maxDaisys` 检查；不在线时直接断开而不回警报；日志白名单失效——13 处。第一轮“claim 用后不删”没被抓到：原来的重放测试在调用方断开之后才重放，那时等待表已被调用方断开清掉；补了“流还开着时第二个连接用同一 claim 认领 → 4404、拿不到一个字节、原来的流照常”之后也被抓到。中转另加了一道防护：认领时 ClientHello 已不在就当作不认识。

## 待维护者确认

1. **同一把钥匙再次登记时新连接取代旧连接**（而不是在旧连接还在时拒绝新的）。好处是重连立即生效；代价是同一把钥匙同时在两台机器上用时会互相顶掉（本来就不该这样）。
2. **子域名长度**：按 ADR-100 推荐 3 取 160 位 / 32 字符。identity-card.md 第 3 节写的是“52 个字符的身份编号可以直接当子域名”，两者不一致；本包按 ADR-100（维护者确认的就是它），子域名恰好是身份编号的前 32 个字符。建议把 identity-card.md 那一句改成“身份编号的前 32 个字符”，由调度或 P5-02 改契约。
3. 默认上限的数值（第 5 节的表）没有实测依据，是起点；部署前按团队规模调。
4. HTTP-01 的 80 端口转发不做（第 8 节）。
5. 在线查询对任何人开放（只答在不在线），按地址限频。若不希望陌生人探测谁在线，可以以后改成要 Daisy 签名的查询。

## 对 P5-02 的交代

见 PROTOCOL.md（规范）与 `tests/helpers/daisy-side.ts`（最小实现）。要点：用 `protocol.ts` 的 `proofPayload` 拼载荷，用身份私钥按头 `{"alg":"EdDSA","typ":"daisy-relay-proof+jwt"}` 签（`SelfIssuer` 要加一个签这种 JWS 的方法）；核对 `welcome.id` 等于自己；每个 `open` 新开数据连接、**认领凭据放在升级请求头 `daisy-relay-claim`**（不带 `Origin`；被拒是 HTTP 404），之后把二进制帧当字节流交给**对外面**的 TLS 服务端（`server.emit("connection", createWebSocketStream(ws))`，ADR-101）；`claim` 不写日志；发出的每一帧不超过 welcome 里的 `maxDataFrameBytes`（默认 64 KiB，大的写要拆开）；没有 ping 超过 2.5 倍间隔就自行重连；1012 时从基数退避；地址 `https://<子域名>.<中转域名>` 写进名片 `addrs`（`kind: "relay"`），调用方可以用 `subdomainOfIdentityId` 核对地址和编号一致。TLS-ALPN-01（`acme-tls/1`）的质询连接经中转照常透传，中转不需要任何 ACME 代码。
