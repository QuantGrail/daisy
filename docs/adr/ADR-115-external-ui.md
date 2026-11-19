# ADR-115：让外部界面连进来——客户端同时连多个 Daisy、服务端进程与浏览器两种接入规则

- 日期：2026-11-17
- 状态：**已实施（P2-04）；阶段 2 关口已由维护者审批（2026-11-17：保留浏览器接入、名单只在对外面生效、网页设置页加名单界面，见末节），并入 `daisy-next`**
- 工作包：P2-04（让外部界面连进来）
- 相关：设计要求——本机接口也给嵌入它的别的界面用；外部界面从连一个中心服务端改成连每个人的 Daisy。`docs/contracts/token.md`；ADR-101（两个入口面）、ADR-107（定义表、`DaisyClient.call`）、ADR-110（集中检查、防跨站、实时通道第一帧）、ADR-113（`external-owner` / `visitor`、通道 `issuer`、两个面都认外部签发方令牌）

## 背景

一个组织内部系统的界面原来连一个中心服务端。改造后每个人的东西在自己的 Daisy 上（可能不止一台：笔记本、台式机、服务器），界面要连到这个人的每一台 Daisy。ADR-113 已经让 Daisy 认外部签发方签给主人的令牌（`external-owner`，通道 `issuer`，两个面都认）。还缺三样：

1. 客户端包只会连一个 Daisy，凭据是构造时给的一个固定字符串；令牌过期就只能整个重建。
2. 实时通道对 `issuer` 通道的连接有一个实际的毛病：`events.ts` 每次推送前用 `identifyOwner`（只认网页会话和本机凭据）重查，外部签发方的令牌查不出来，于是**第一次有变化就以 1008 关掉**。（P2-01 的安全审查 M-1 同时修了这一条；本包 merge 后采用那边的判断，再加上下面第 2 节的两点。）
3. 跨站检查（ADR-110 第 3 节第 2 步）只放行本面自己的源。服务端进程里的界面后端会怎样？浏览器里的外部界面又怎样？没有写清。

## 决定

### 1. 客户端：每个连接一个 `DaisyClient`，凭据可插拔；`DaisyConnections` 管一组

- `new DaisyClient(baseUrl, token = "", opts?)`（P6-05 起的名字，见 ADR-155）。前两个参数不变（网页照旧用），第三个参数 `DaisyClientOptions` 全部可选：
  - `credentials({ refresh, baseUrl, id })`：返回 Bearer 凭据（外部签发方给主人的令牌、网页会话、本机凭据都行）。第一次请求、第一次订阅前问一次（`refresh: false`），之后沿用；**收到集中检查的 401（`WWW-Authenticate: Bearer error="invalid_token"`）时问一次 `refresh: true`，拿到不同的凭据就把这个请求再发一次**；实时通道被以 1008 关闭时，下一次连接前同样问 `refresh: true`。多个请求同时被拒只问一次（共用一个进行中的调用；别的请求已经换到新凭据就直接用）。403 不换（凭据有效但无权，换了也一样）。
  - **401 之后重发改动是安全的**：401 只来自集中检查，它在 `onRequest` 里、任何处理函数之前；被拒的请求什么也没做。测试核对“第一次带过期令牌建会话 → 换令牌重发 → 只建了一个会话”。
  - `fetch`、`WebSocket`：这个连接用的实现（服务端进程信任 Daisy 的自签名证书、走代理时用）。默认用全局的（Node 22+ 自带两者）。
  - `id`：连接的名字，传给 `credentials`；`onReachability(reachable, error)`：每个请求之后告诉调用方这个 Daisy 有没有回答。
- 有 `credentials` 时，ETag 缓存（JSON GET 的 ETag / 304，旧版就有）按“地址 + 这是同一个提供者”分，换新令牌不清缓存；固定令牌照旧按“地址 + 令牌”。
- `client.followNotifications(handlers, { after, pollMs, … })`：从这个连接自己的游标读会话通知（`GET /api/notifications?after=`），有新的就交给 `items(items, cursor)`；失败退避、游标不动；`cursor()` 让调用方持久化，下次从那里接着读。事件出口用同形的 `client.followEvents(handlers, { after, waitS, … })`（阶段 2 整合加上）：没给 `after` 先取快照，再按序号长轮询（`waitS` ≤ 10，客户端请求 15 秒超时），410 `cursor_reset` 时自动重取快照再接着读，失败退避、游标不动。
- `DaisyConnections`（一组）：`new DaisyConnections(defaults)`（比如一个共用的 `credentials`）→ `add({ id, baseUrl, …每个连接自己的选项 })` 返回那个连接的 `DaisyClient`；`get(id)`、`ids()`、`each(fn)`（每个连接同时跑、**各自结束**，结果是 `{ id, ok, value | error }` 的数组——一个 Daisy 不在线不会拖住或弄坏别的）、`state(id)` / `states()`（`reachable`、`lastOk`、`lastError`）、`watchSession(id, …)`、`followNotifications(id, …)`（随 `remove(id)` / `close()` 一起关掉）。每个连接各自的实时通道、各自的会话游标、各自的通知游标——都在各自的 `DaisyClient` 里，互不共享。

**一张令牌连几台 Daisy。** 令牌的 `aud` 可以是数组（token.md 第 2 节），Daisy 只要求其中有自己的受众（ADR-113 第 1 节）。所以签发方可以签一张 `aud: [每台 Daisy 的受众…]` 的令牌给界面后端，一组连接共用一个 `credentials`；也可以按 `baseUrl` / `id` 给每台各签一张（RFC 8707 资源指示的做法）——`credentials` 收到的参数就是为这个准备的。每台 Daisy 的受众默认是它的 URN，也就是它身份公钥的 JWK 指纹（主人配置签发方时在签发方那里登记的就是这把公钥，签发方能自己算出来）；主人也可以在 `PUT /api/access/issuer` 里给每台设一个 `audience`。

### 2. Daisy 这一侧：实时通道认外部签发方的令牌，到期即断

- 推送前的重查（`events.ts` 的 `stillValid`，P2-01 审查 M-1）：网页会话 / 本机凭据仍按 `identifyOwner`；`external-owner` 看三件事：令牌的 `exp` 还没到（**不加** HTTP 检查允许的 60 秒误差）、配置的签发方还是验证它时那一个、主人主体没变。P2-04 加一条：从“允许的外部界面来源”连上的通道，那个来源还在名单里。
- 用外部签发方令牌订阅时，在 `exp` 那一刻以 **1008 `Login expired`** 关掉通道（与网页会话失效同一个关闭码）；客户端随即问 `credentials({ refresh: true })` 再订阅。订阅时令牌已经到了 `exp`（在误差之内、HTTP 还会放行的那几十秒）就不收，免得刚连上就断、反复重连。
- 主人删除或更换签发方、清掉某个界面来源：已连上的通道在**下一次有变化时**断开（与网页会话注销同一个时机）；新的请求立刻被拒。JWKS 去掉了某把钥匙：用它签的令牌在 HTTP 上立刻无效；已连上的通道最迟在令牌到期时断开（令牌本来就短）。

### 3. 接入规则一：服务端进程里的界面后端（推荐）

- **不需要任何来源设置。** 集中检查第 2 步只拒绝“带着别的源的 `Origin`”或“`Sec-Fetch-Site` 不是 `same-origin` / `none`”的请求；Node 的 `fetch` 和 `WebSocket` 两者都不带（实测 Node 24：只带 `sec-fetch-mode`），`ws`、`curl` 也不带。这不放宽什么：**浏览器发出的跨源请求只要带 `Authorization` 头就一定带 `Origin`**（CORS 模式，还要先预检），不带 `Authorization` 的请求在第 5 步就被拒——不带 `Origin` 的请求不可能是别的网页借浏览器发的、还带着主人的凭据。
- 如果服务端进程自己加了 `Origin`（有的 HTTP 库或网关会），它就得是本面自己的源或名单里的来源，否则照样 403 `cross_site`。接入文档写明“不要加”。
- 连哪个地址：同一台机器上用本机面 `http://127.0.0.1:<端口>`（ADR-113 决定 2：本机面也认外部签发方令牌）；别的机器上用对外面（主人开启、要 PIN），地址见 `GET /api/access` 的 `external.url`。`Host` 必须是这个地址本身（防 DNS 重绑定，ADR-110），经反向代理改了 `Host` 的会被拒。
- 对外面默认 TLS、自签名证书（CA 证书是阶段 5，ADR-100）：界面后端要信任这张证书——从主人那里拿 `keys/tls-cert.pem`，用连接的 `fetch` / `WebSocket` 选项传进去（测试里用 `node:https` + `ws` 的 `ca`），或在进程上设 `NODE_EXTRA_CA_CERTS`。组网 / 内网地址上主人也可以选明文。

### 4. 接入规则二：浏览器里的外部界面（可选，要主人加白名单）

- 新设置“**允许的外部界面来源**”（`uiOrigins`，存 `config.json`，0600），三条新接口进定义表“设置”组：
  - `GET /api/access/ui-origins`（`daisy:manage`）
  - `PUT /api/access/ui-origins {origins}`（**`daisy:grant` + PIN**，整份替换；AI 不能做）——列进来的网页可以带着外部签发方给主人的令牌在浏览器里以主人身份操作，属于“放别人进来”
  - `DELETE /api/access/ui-origins`（`daisy:manage`，不要 PIN：收窄，同关闭对外面、删除签发方的先例）
  - 命令 `daisy access ui-origins show|set|clear`
- 来源的写法：`https://主机[:端口]`，按浏览器发 `Origin` 的样子规范化（小写、去掉默认端口、去掉结尾斜杠）后逐字节比较；`http://` 只许本机回环（`localhost`、`127.0.0.1`、`[::1]`，开发用）；不接受 `*`、`null`、通配主机、用户名密码、路径、查询串、片段；最多 16 个。手改的 `config.json` 里不合规的条目一律忽略（只认“保存时会写成的那样”）。
- 从名单里的来源来的请求：
  - 第 2 步放行（`Sec-Fetch-Site: cross-site` 也放行），回答带 `Access-Control-Allow-Origin: <那个来源>`、`Vary: Origin`、`Access-Control-Expose-Headers: www-authenticate, retry-after, etag`——**被拒的回答也带**，界面要读到 401 才知道去换令牌。
  - 预检（`OPTIONS` + `Access-Control-Request-Method`，对外面上）在集中检查里直接回 204：方法 `GET, POST, PUT, PATCH, DELETE`，请求头 `authorization, content-type, if-none-match, daisy-pin-grant`，缓存 600 秒；Chrome 的 Private Network Access 预检（`Access-Control-Request-Private-Network: true`）回 `Access-Control-Allow-Private-Network: true`。不发 `Allow-Credentials`——不用 Cookie。
  - **只认外部签发方给主人的令牌**（通道 `issuer`）。网页会话、本机凭据从别的来源出现，只能是有人把我们的凭据带到了别的网站：403 `cross_site`。来访者照样 403 `a2a_only`。
  - 实时通道：升级请求的 `Origin` 同样按名单放行，第一帧同样只认 `issuer`；来源被移出名单后，下一次有变化时断开。
- ~~名单两个面都生效~~ → **名单只在对外面生效**（阶段 2 关口决定）：本机面上任何别的来源（名单里的也一样）都 403 `cross_site`，预检同样 403、不回 CORS 头、不回 Private Network Access。外部签发方令牌本身两个面都认（ADR-113 决定 2），只是浏览器里的外部界面要经对外面连入。
- **重置 PIN 时清空名单**（与 P2-01 审查 H-1 的“重置 PIN 撤回外部签发方”同一个挂点 `PinService.onReset`；设计要求重置 PIN 撤回所有放别人进来的信任）。

### 5. 接入的一方要做什么（摘要）

- **主人在每台 Daisy 上做一次（要 PIN）**：配置外部签发方 `daisy access issuer set --issuer <签发方标识> --owner-subject <主人在签发方那里的 sub>`（或 `PUT /api/access/issuer`，ADR-113）；`daisy access issuer show` 打出这台 Daisy 的公钥 JWK 和受众，交给签发方登记（默认受众是 URN，签发方拿公钥就能算出来；也可以用 `--audience` 起一个名字）。界面后端不在这台机器上时，开启对外面 `daisy access external on --host <组网地址>`，地址看 `daisy access show` 的 `external.url`。只有浏览器里的界面才需要再加来源：`daisy access ui-origins set --origins <来源>`，或网页“设置 › 入口面与口令 › 允许的外部界面来源”。
- **令牌**：签发方签给主人的访问令牌（RFC 9068 `at+jwt`）。`iss` 与配置的签发方完全相同；`sub` 是配置的主人主体（别人的 `sub` 是来访者，403 `a2a_only`）；`aud` 含这台 Daisy 的受众，可以是数组；**不带 `act`**（带了也当来访者）；`scope` 取 `daisy:session:read daisy:session:write daisy:manage daisy:grant` 里要用的（Daisy 取交集；读事件出口另要 `daisy:events:read`）；**必须有 `iat`，`exp - iat` 最长 24 小时**，建议几分钟到 1 小时，到期由客户端自动换；签名 EdDSA（Ed25519）、ES256 或 RS256。细则见 ADR-113 与 `docs/contracts/token.md`。
- **两条限制**：回答 AI 的工具授权和提问不对这张令牌开放（403 `channel_not_allowed`），界面可以列出待处理的卡片，回答要引导主人去 Daisy 的网页；主人配置签发方时存在 Daisy 上的主人令牌（`ownerToken`）不能拿来当 Bearer 连接（401），界面后端要用签发方另签给它的令牌。
- **“放别人进来”的操作**（开对外面、配置签发方、改来源名单）：先 `POST /api/pin/grant {pin}` 换授权（绑定在这张令牌上），再放进请求头 `daisy-pin-grant`。
- **浏览器里的令牌**：放内存，不放 `localStorage`、URL。
- **常见错误码**：401 `invalid_token`（客户端自动换一次，还不行查令牌的 `iss` / `aud` / `sub`）；403 `a2a_only`（不是主人本人的令牌）、`insufficient_scope`（scope 不够）、`pin_required`、`external_off`（对外面上终端 / 执行命令 / 浏览目录没开）、`cross_site`（带了不在名单里的 `Origin`，或在本机面上带了别的来源，或从名单里的来源带了非签发方的凭据）、`host_not_allowed`（`Host` 不是这个面的地址，别经改 `Host` 的代理）。

## 测试（`tests/external-ui.test.ts`，10 条；真实的监听器、真实的 fetch / WebSocket）

- **两个 Daisy、一个界面后端**：P2-01 的假签发方签一张 `aud` 含两台的主人令牌；A 经本机面、B 经对外面（明文回环），`DaisyConnections` 共用一个 `credentials`。`/api/me` 两边都是通道 `issuer`、面分别是 `local` / `external`；各建会话、各发消息；两个实时通道都 `live`，A 上的新消息只到 A 的通道；经定义表读会话事件；两边的通知各自从自己的游标读到、再往后只读到新的；整个过程 `credentials` 每台只问了一次、从没要求换（**这一条在修正 `events.ts` 之前失败**：第一次推送就 1008，客户端去换了令牌）。
- **令牌过期**：A 的第一张令牌已过期 → 建会话 401 → `credentials({refresh: true})` → 重发成功，只建了一个会话；B 不受影响。实时通道：一张 3 秒后到期的令牌，到期时 Daisy 以 1008 关闭，客户端问了一次 `refresh: true`、重新 `live`。
- **一台停掉**：两边都 `live` 后关掉 B；`each` 里 A 成功、B 失败，`state("b").reachable === false`；A 发消息，A 的实时通道照常收到、保持 `live`。
- **来访者**：别人的令牌、主人带 `act` 的令牌，两台都 403 `a2a_only`，`credentials` 没被要求换；实时通道第一帧 1008。
- **服务端进程 / 浏览器规则**：不带 `Origin` 直接通过；名单之外的来源 403（含预检）；设置要 PIN（命令行、外部签发方主人令牌不带授权都 `pin_required`），八种坏来源 400 `ui_origin_invalid`，规范化与去重，落盘；预检 204 与各个头（含 Private Network Access，不含 Allow-Credentials）；名单里的来源 + 主人令牌 200 带 CORS 头；401 也带 CORS 头和 Expose；本机凭据、网页会话从那个来源 403 `cross_site`；来访者 `a2a_only`；别的来源仍 403；实时通道（名单外 HTTP 403、本机凭据 1008、主人令牌 ready）；清空名单不要 PIN，已连的通道在下一次变化时 1008，新请求 403；重置 PIN 后名单为空。
- **删除签发方**：用主人令牌连上的实时通道在下一次变化时 1008。
- **对外面 TLS**：自签名证书；不信任它的默认 `fetch` 连不上（TLS 拒绝）；用连接的 `fetch`（`node:https` + `ca`）和 `WebSocket`（`ws` + `ca`）选项钉住这张证书后，`/api/me`、建会话、实时通道都通。
- 只有集中检查的 401 才换凭据：一次性口令换会话的 401（处理函数自己回的）不让 `credentials` 换。
- 规则单测：来源规范化；`config.json` 里手改的坏条目被忽略。
- 表驱动权限测试（`tests/access.test.ts`）加一行 `settings.uiOriginsSet` = “放别人进来”；`api-defs.test.ts` 核对它要 PIN。

## 后果

- 一个界面后端可以用一张令牌同时操作主人的几台 Daisy；令牌短期、到期自动换，实时通道跟着换，不需要界面那一侧写重连逻辑。
- 浏览器接入是一个主人显式打开的口子：列进来的网页上的 XSS 就能拿着主人令牌操作这台 Daisy（令牌本来就在那个网页里，Daisy 只是不再拒绝它的源）。所以要 PIN、只认 `issuer` 通道，并推荐服务端进程的接法。
- 对外面的自签名证书要界面后端自己去信任，没有自动的办法（阶段 5 的 CA 证书之前）。
- 已连上的实时通道在签发方被删除、来源被移出名单后，要等下一次有变化或令牌到期才断（与网页会话注销同一个时机，ADR-110）。

## 偏离与待维护者在阶段关口确认的点（已答复：见末节）

1. **新增设置“允许的外部界面来源”与三条接口**（定义表“设置”组，`PUT` 要 PIN、`DELETE` 不要）：设计的接口“设置”分组和权限表里原本没有这一项。推荐保留；如果阶段 2 只做服务端进程的接法，可以整项去掉。
2. **名单两个面都生效，并回答 Chrome 的 Private Network Access 预检**：等于允许一个公网网页（名单里的）调用本机回环上的 Daisy。可以改成只在对外面生效。
3. **服务端进程不带 `Origin` 就不做来源检查**：这是 ADR-110 第 3 节第 2 步原本的行为（命令行也是这样过的），这里只是写明并用于界面后端；没有新增“服务端客户端白名单”。
4. **实时通道按令牌的 `exp` 断开、不加 60 秒误差**，到期前后那几十秒的令牌不能用于新订阅（HTTP 上仍可用）。
5. **清空来源、删除签发方后，已连上的实时通道要等下一次变化才断**，没有立即扫一遍——与网页会话注销一致；要立即断可以在两个接口里各加一次扫描。
6. **401 后自动重发改动**：只对集中检查的 401（带 `WWW-Authenticate: Bearer error="invalid_token"`）重发——它在任何处理函数之前；处理函数自己回的 401（比如一次性口令不对）不带这个头，不重发。以后若有处理函数也加这个头，要注意这一条。
7. **主人的 Web 设置页还没有“允许的外部界面来源”的界面**（只有接口和命令）：P2-04 只做 Daisy 这一侧；要不要加进 P1-08 的设置页，阶段关口定。
8. 外部界面这一项，Daisy 这一侧到此为止；**令牌的 `aud` 写一台还是几台、受众用 URN 还是主人设的名字、证书怎么交给界面后端**，要和界面、签发方那一侧一起定（第 1 节末段：两种都能用）。

## 留给后面的工作包

- **P2-03 合并后**（阶段 2 整合已做）：`followEvents` 跟随器；`tests/external-ui.test.ts` 的两 Daisy 测试加了事件出口一段（两边各自按序号读、收件人是主人在签发方的 `sub`），另加一条“B 停掉 A 照常、B 重启后从保存的序号接着读”。
- **阶段 5（ADR-100）**：对外面换 CA 签的证书后，界面后端不再需要钉证书。
- **界面一侧**（不在本仓库）：登录后从签发方拿主人令牌，按第 5 节连每台 Daisy。

## 阶段 2 关口决定（2026-11-17，维护者）

1. **保留浏览器里的外部界面接入**（偏离第 1 条）：来源名单与三条接口照旧，`PUT` 要 PIN、`DELETE` 不要。组织内部的界面以后可能用。
2. **名单只在对外面生效**（偏离第 2 条，按推荐改）：`guard.ts` 的 `uiOriginAllowed(origin, face)` 只在 `face === "external"` 时看名单；本机面照 ADR-110 第 3 节第 2 步只认自己的源。实时通道的复查（`events.ts` 的 `stillValid`）同样带上面。理由：本机面在回环上，名单若在那里也生效，名单里的公网网页就能借主人的浏览器（Chrome 的 Private Network Access 预检也被放行）调用本机回环上的 Daisy；浏览器里的界面本来就要从别处连，走对外面没有损失。
3. **网页设置页加名单界面**（偏离第 7 条）：`packages/ui/src/access-settings.tsx` 的 `UiOriginsSettings`，放在“设置 › 入口面与口令”卡片里“对外面”之后——列出名单、加一个（整份 `PUT`，弹 PIN，与开启对外面、改口令同一个 `usePin()`）、去掉一个（还剩别的：整份 `PUT`，要 PIN；去掉的是最后一个：`DELETE`，不要 PIN）、两个以上时“全部清空”（`DELETE`，不要 PIN）；说明文字写明只在对外面生效、对外面关着时名单用不上。客户端加了 `uiOrigins()`、`setUiOrigins(origins, pinGrant)`、`clearUiOrigins()`。
   - 说明：只有“整份替换”的 `PUT`，所以“去掉一个但还剩别的”也要 PIN（虽然它只收窄）。要做到“收窄都不要 PIN”，需要一条“去掉一个”的新接口或让 `PUT` 在只收窄时免 PIN，这次没做，接口数不变（112 条）。
4. 测试：`tests/external-ui.test.ts` 的浏览器规则一条改为经真实的对外面监听器（明文回环）做全部浏览器侧检查，并新增本机面的反例——名单里的来源在本机面上：请求 403 `cross_site`、预检 403 且没有 CORS 和 Private Network Access 头、实时通道升级 403；对外面上照旧：预检 204、主人令牌 200 带 CORS 头、401 带 CORS 头、对外面的网页会话从该来源 403 `cross_site`、来访者 `a2a_only`、别的来源 `cross_site`、实时通道（名单外 403、网页会话 1008、主人令牌 ready、清空名单后下一次变化 1008）、重置 PIN 清空名单。去掉“只看对外面”这一条判断，这条测试即失败（已核对）。
5. 文档：本 ADR 第 4、5 节；定义表里两条接口的说明（`docs/api/` 已重新生成）。
