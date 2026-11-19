# ADR-120：身份名片与互认——通讯录、联系人令牌的识别、白名单

- 日期：2026-11-17
- 状态：**已实施（P4-01，分支 `p4-01`，已 merge `p4-02`（ADR-121）；待独立安全审查；未合入 `daisy-next`）**
- 工作包：P4-01（身份密钥与互认）
- 相关：设计要求——两种名片；别人的 Daisy 用公钥互认；白名单；调用授权单向、不传递、可撤销；命令 `daisy contact`；添加、移除互认的名片要 PIN。契约 `docs/contracts/identity-card.md` 0.1、`token.md` 4.1、`scopes.md`、`limits.md` 第 5、8 节；ADR-099（密钥与加密）、ADR-110（集中检查）、ADR-113（`visitor`、`SelfIssuer`）

## 背景

阶段 1 起每个 Daisy 都有一把 Ed25519 身份密钥（`keys/identity-key.json`，0600，首次启动由 `SelfIssuer.open` 生成；P1-03 的 AI 工作凭据、P2-01 / P2-02 的自签令牌都用它）。阶段 4 要让两个 Daisy 认得对方（公钥互认）：交换身份名片，加进通讯录，之后对方签的令牌被认得。互认本身不带权限；调用授权（卡片、每个 agent 乘每个人）是 P4-03，A2A 服务端是 P4-04，A2A 客户端工具（Daisy 替自己的 AI 签跨 Daisy 令牌）是 P4-08。它们都建在本包的通讯录上。

## 决定

### 1. 密钥：沿用，不换

身份密钥就是阶段 1 的那一把，不另生成、不换存放位置、不改 `SelfIssuer` 的签发行为（JWT 头里的 `kid` 照旧是 base64url 指纹，见第 7 节第 3 条）。`SelfIssuer` 只加一个 `signCard(payload)`：头固定为 `{"alg":"EdDSA","typ":"daisy-card+jwt"}`，没有 `iss` / `aud` / `exp`。所有令牌验证都要 `typ: at+jwt`，所以名片永远不会被当成凭据（测试核对：拿名片的 JWS 或整行当 Bearer 都是 401）。换钥匙不支持（契约第 5 节）。

### 2. 名片：照契约 identity-card.md 0.1

- 字段 `v`、`id`、`key`（只有 `kty`、`crv`、`x`）、`name`、`addrs`、`iat`、`note?`；文本是几行人看的加最后一行 `daisy-card:1:<JWS>`；身份编号 = RFC 7638 指纹（SHA-256）的 base32 小写无填充，52 个字符，给人看时四个一组。
- 导入按契约第 4 节逐步验：去空白取机器行、主版本（更高的版本回 `card_version`“需要更新版本的 Daisy”）、头（`alg` 只认 `EdDSA`，`typ`；另外拒绝带 `crit` / `jwk` / `jku` / `x5u` 的头）、用载荷里的 `key` 验签名、重算编号等于 `id`、人看的行（有的那几行）与载荷一致，对不上就说是哪一行；不能加自己。
- 本包补的规则（契约没写，写进 limits.md 第 8 节或这里）：名字、备注不能有换行和控制字符（会破坏文本格式、也防终端转义）、不能前后带空白；地址只能是 `direct` / `relay`，`https`（直连可以 `http`），不带用户名口令、`?`、`#`，每个最长 2048 字符，最多 8 个；导入文本最多 16 KiB；`key` 里带私钥成员 `d` 的拒绝；载荷里不认识的字段忽略（次版本兼容）。
- **人看的行加了一行“备注：…”**（名片有备注时）。契约的示例里没有备注行；备注是载荷字段，显示出来、导入时一并核对，比藏着好。
- **导出**：名字不填用这台机器上主人的账户名；地址不填用对外面正在监听的地址（没开就没有地址，`addrs` 为空数组）；不保存“名片设置”，每次导出现签一张（`iat` 是导出时间）。
- **更新**（契约第 4 节第 6 步、第 5 节）：同一个编号再导入——内容完全一样回 `unchanged`（只可以顺便改白名单）；不一样时要带 `update` 才替换，否则 409 `contact_exists` 并在 `details` 里逐项列出差异；**比通讯录里的更旧（`iat` 更小）的名片一律 409 `card_older`**，免得别人重放一张旧名片把地址改回去。钥匙不变，所以授权、白名单都保留。
- `expectId`（可选）：主人和对方核对过的编号（完整，或至少前 16 个字符），对不上回 `id_mismatch`。

### 3. 通讯录：`packages/daisy/src/contacts/`

| 文件 | 内容 |
| --- | --- |
| `identity.ts` | 编号的三种写法（base32 编号、base64url 指纹、RFC 9278 URN）互转；`keyRefBytes(ref)` 认任何一种 |
| `card.ts` | `makeCard`（导出）、`readCard`（导入的全部验证）、`cardText` |
| `index.ts` | `Contacts`：查找、增删、白名单、`verifyToken`、`onRemoved` |
| `admission.ts` | `admit(principal, agent, contacts)`：互认与白名单这一层的判断（第 5 节） |
| `routes.ts` | 本机接口 |

数据库第 6 步（`MIGRATIONS` 追加）：表 `contacts`（`id` 编号、`thumbprint` 唯一、`x` 公钥、`name`、`note`、`addrs`、`card` 原样的 JWS、`card_iat`、`whitelisted`、`added_at`、`updated_at`、`added_via`）。

给下游的接口（模块头注释里也写了）：`get(id)`、`byKeyRef(编号|指纹|URN)`、`find(人输入的，含 ≥ 8 字符的唯一前缀)`、`list()`、`isWhitelisted(id)`、`verifyToken(token, {audience})`、`onRemoved(fn)`、`put` / `remove` / `removeAll` / `setWhitelist`。

### 4. 认得谁：联系人签的令牌（token.md 4.1）

集中检查（`access/guard.ts`）按 `iss` 分流时加一支：`iss` 不是自己、不是外部签发方，就去通讯录找。`Contacts.verifyToken`：

1. `iss` 是通讯录里某人的 URN（第 2 步；被移除的找不到）；
2. `typ: at+jwt`，`alg` 只认 `EdDSA` / `Ed25519`（第 1 步）；
3. `kid` 是这个人的编号——base32 编号或 base64url 指纹都认（第 3 步，见第 7 节第 3 条）；
4. 用通讯录里这把公钥验签名（第 4 步）；`aud` 里有自己的 URN（第 5 步）；时间和 60 秒误差，**`exp - iat` ≤ 300 秒**（第 6 步，新常量 `TOKEN_LIMITS.a2aMaxS`）；
5. **`sub` 必须等于 `iss`**：一个 Daisy 只替自己的主人说话。B 签一张 `sub` 写 C 的令牌，A 不认（授权“不传递”，测试核对）；
6. **`client_id` 必须是 `a2a`**（token.md 第 3 节的通道表）；
7. 验完签名再查一次通讯录：验的过程中被移除（或换了钥匙）就不认。

认出来的是 `visitor`，新通道 `a2a`（审计的通道清单 `AUDIT_CHANNELS` 加 `a2a`），标签 `contact:<编号>` / `contact-ai:<编号>`，带 `contactId`、`subject`（对方 URN）、`actor`（`act.sub`），scope 只留 `daisy:invoke`。和外部签发方的来访者一样，本机接口对它一律 403 `a2a_only`；它只能走 A2A 入口（P4-04）。外部签发方的来访者也补上了 `subject` / `actor`（P4-03 用）。

### 5. 白名单与 `admit`

白名单是联系人行上的一个标记（添加名片时可以顺手勾上，之后他第一次调用不弹卡片；之后也可以单独加、去）。`admit` 只回答互认和白名单能回答的部分：

| 情况 | 结果 |
| --- | --- |
| 没有有效令牌、陌生人、已移除的联系人 | `refused / not_recognised`，**不生成卡片** |
| 私人 agent | `refused / agent_private` |
| 只对指定人开放：在名单里 / 不在 | `allowed / listed` / `refused / not_listed` |
| 对所有互认的人开放：在白名单里 | `allowed / whitelist`，**不弹卡片** |
| 对所有互认的人开放：不在白名单里（或外部签发方的来访者） | `ask_owner`：这里由 P4-03 先查每个 agent 乘每个人的授权，再生成卡片 |

每次都重新读通讯录，所以移除联系人、移出白名单从下一次调用起生效；请求开始时拿到的 principal 在移除之后也不再被放行。

### 6. 移除、重置 PIN

- 移除立即生效：通讯录不缓存任何信任（只缓存由 `x` 推出的公钥对象，不是信任），每次验证都查库；白名单随行一起没了；重新导入时白名单不会自己回来。
- `onRemoved(fn)` 在移除的同一个事务里通知每个被移除的联系人；监听者抛错就整个撤销（测试核对）。P4-03 在这里删掉这个人的授权、停掉进行中的调用（设计要求“撤销时，对方还在进行中的调用会被停止”）；本包没有进行中的调用可停。
- 重置 PIN 时 `removeAll()`：在 P4-02 的吊销登记处（`access.revocations`，ADR-121）注册为种类 `contacts` 的数据库钩子，在重置的事务里跑，返回移除了几位（白名单是行上的标记，随行一起没了），记进 `pin.reset.revoke` 审计。这就是“重置 PIN 后互认的名片全部失效”；`tests/contacts.test.ts` 用真实的 PIN 和 `/api/pin/reset` 验一遍（导入的联系人从此 401），重置 PIN 的整条检查在 `tests/let-in.test.ts`。

### 7. 接口与权限

`api/contacts.ts`，分组“调用授权”（`grant`）：

| 接口 | 命令 | scope | PIN |
| --- | --- | --- | --- |
| `GET /api/contacts/me`（导出自己的） | `daisy contact export [--name] [--note] [--direct …] [--relay …]` | `grant` | 要 |
| `POST /api/contacts/inspect`（只看） | `daisy contact inspect <card>` | `grant` | 要 |
| `POST /api/contacts`（导入） | `daisy contact import <card>|- [--card-file] [--whitelist] [--update] [--expect-id]` | `grant` | 要 |
| `GET /api/contacts` | `daisy contact list` | `grant` | 要 |
| `GET /api/contacts/:id` | `daisy contact show <id>` | `grant` | 要 |
| `DELETE /api/contacts/:id` | `daisy contact remove <id>` | `grant` | 要 |
| `PUT` / `DELETE /api/contacts/:id/whitelist` | `daisy contact whitelist add|remove <id>` | `grant` | 要 |

八个接口都声明 `letsIn: "contact"`（P4-02 的定义表规则：强制 `daisy:grant` + PIN、不对 AI 开放），都在留给它的位置 `/api/contacts…`。全部只对主人的通道（网页、配对设备、命令行、外部签发方给主人的令牌），AI 工作凭据一律 `channel_not_allowed`，来访者一律 `a2a_only`。`daisy contact export` 直接打印名片的文本（命令行的 `EXTRAS.print`），其余打印 JSON。

1. **全部要 PIN，包括导出、列出、查看。** 工作包 P4-01 的说明写“全部要 PIN”，`api-defs` 测试的规矩是“`daisy:grant` 一律带 PIN”；契约 identity-card.md 第 6 节和 scopes.md 却写“导出名片不需要 PIN”“读不要 PIN”。本包按工作包说明和现有规矩做，**交关口决定**。放宽的代价：local-api.md 把改 PIN 要求算作不兼容改动，要在定稿前决定。
2. **只看（inspect）也要 PIN**：它只解析给它的文本，不读不改通讯录（也不告诉你这个人在不在通讯录里），用途是导入前先把名字和编号给主人看（契约第 4 节第 7 步）。起初给它 `daisy:manage`、不要 PIN；并入 P4-02 后按调度的要求和 ADR-121 的规矩（`/api/contacts…` 上的改动都要 `letsIn`）改成 `letsIn: contact`。网页上输一次 PIN 后短时间内有效；命令行先 inspect 再 import 要输两次。移除联系人（收窄）同样要 PIN（设计的权限表字面如此，ADR-121）。
3. **“身份编号”在 ADR-099 和契约之间不一致**：ADR-099 推荐第 3 条写编号是 base64url 指纹（43 字符）并当 `kid`；identity-card.md 第 3 节写编号是 base32（52 字符），`kid` 也是它。本包按契约：名片、界面、命令行、日志都用 base32；**但 P2-01 签发的令牌 `kid` 照旧是 base64url 指纹**，验证联系人令牌时两种 `kid` 都认（同一 32 字节，都无歧义）。要不要把签发也改成 base32，交关口决定（改了以后，P2-01 的 `SelfIssuer.verify` 要同时认两种，以免升级瞬间的 AI 工作凭据失效）。

### 8. 网页

P4-01 不做界面。设置页的“互认的名片与白名单”归 P4-12；它要的接口（含导入前的 inspect、更新时的差异）本包都已提供。

## 测试

- `tests/contacts.test.ts`（12 条，先写被拒绝的）：八个 `grant` 接口 × 没凭据 / 命令行无 PIN / 网页无 PIN / 网页的授权拿给命令行 / AI 带授权 / 联系人自己的令牌，全部拒绝且不改任何东西，命令行的授权只能用一次；**没有互认就来调用**（C 签的令牌 401、审计记 `invalid_token/unknown_issuer`、`admit` 对三种 agent 都拒绝、B 替 C 签的令牌不认、A 没有任何卡片或事件）；**白名单**（加白名单导入后 B 第一次调用被认出——联系人、AI、只有 `daisy:invoke`——且 `admit` 直接放行、没有卡片；不在白名单的 D 走 `ask_owner`；之后加 / 去白名单立即生效）；移除（下一次请求就 401、之前拿到的 principal 不再放行、白名单去掉、监听者被通知、监听者抛错就撤销、重新导入不带回白名单）；重置 PIN（真实 PIN 服务、`/api/pin/reset`，以及测试用的 PIN 替身）清空通讯录、联系人的令牌 401、审计记 `contacts: 2`；联系人令牌的 11 种坏法（别的受众、超过 5 分钟、`sub` 不是自己、`client_id` 不是 `a2a`、过期、`iat` 在将来、别的 `kid`、`typ: JWT`、缺 `jti`、别的钥匙签、`alg: none`）都 401 且令牌不进回答和审计，base32 编号作 `kid` 也认，多给的 scope 被丢掉；导出的名片逐字段、逐行对照契约（编号 = 指纹的 base32、头、载荷、文本），名片不能当凭据，不能加自己；导入的二十多种坏名片各说清哪里不对，插了空白和换行、只有机器行、文件都能导入；更新、差异、旧名片重放；base32 用 RFC 4648 的测试向量；`daisy contact` 经真实监听的 Daisy 和真实的 PIN 走一遍。
- 表驱动权限测试（`tests/access.test.ts`）加八个接口（`grant` 行）和两种身份（联系人的跨 Daisy 令牌、陌生 Daisy 的同类令牌）；并入 P4-02 后是 **120 条接口 + 10 个探针 × 16 种身份 = 2080 次**。`api-defs` 的 PIN 清单加这八个；`tests/let-in.test.ts` 的 `ROUTES_OF.contact` 列这八个，`PENDING_REVOCATIONS` 去掉 `contacts`；P4-02 为联系人留的两个探针（`POST /api/contacts`、`DELETE /api/contacts/:cid`）和真实接口重了，删掉，用到它们的地方改用 `daisy token` 的探针。
- 关键检查做过变异验证：去掉 `sub = iss` 一条，“没有互认就来调用”和令牌测试失败；去掉 `admit` 里的“已移除就拒绝”，移除测试失败。

## 安全审查修订（唯一一轮，2026-11-17；没有 High）

| 编号 | 问题 | 改法 | 测试（没有改法时失败） |
| --- | --- | --- | --- |
| M-1【中】 | 人看的行用形似的标签就能绕过核对：标签前的 U+200B、`编号∶`（U+2236）、`编号﹕`（U+FE55）、繁体 `編號：`，不认识的行一律忽略，于是可以显示别人的编号 | 每行先按人读的样子规整：NFKC（全角字母、形似的冒号折叠）、去掉零宽与格式字符（U+00AD、U+061C、U+180E、U+200B–U+200F、U+202A–U+202E、U+2060–U+206F、U+FEFF）、`編號` / `名稱` / `備註` 折成简体，`名称` 当 `名字`；冒号认 `:` `∶` `︓` `︰` `﹕` `：`。另外不论标签：人看的部分（去掉空白、小写）里每一串 52 个以上的 base32 字符都必须等于名片的编号，否则拒绝。`daisy contact import` 在要 PIN 之前先在本地验名片，打印名字、完整编号和“请先和对方核对”的提示，并建议 `--expect-id`；名片验不过就在要 PIN 之前停下 | `review M-1`：四种已证实的绕过、BOM、`名稱`、全角编号、没有标签的一串编号、别的标签下的编号都拒绝；本名片的编号怎么写都通过；命令行测试核对提示在读 PIN 之前出现、坏名片不读 PIN；原来的“编号”行测试改为新的说法 |
| M-2【中】 | 对方能控制的文字未经清理就进了来访者的身份：`act.sub` 里的 ESC、改变方向的字符原样保留，外部签发方那条路连长度都不截；名片的名字可以带 RLO 和零宽字符 | `tokens/common.ts` 的 `UNSAFE_TEXT`（C0 / C1 控制字符、U+061C、U+200B–U+200F、U+2028–U+202E、U+2060–U+206F、U+FEFF）：所有令牌（自签、联系人、外部签发方）的 `sub`、`act.sub`、`act.name` 含有这些字符就拒绝（401）；来访者的 `subject` / `actor` 两条路都截到 200 字符（`LABEL_MAX`）。名片的名字、备注、地址用同一组字符检查 | `review M-2`：五种名字、两种备注拒绝；联系人令牌带 ESC、RLO、零宽、BEL 的 `act` 都 401 且审计里没有这些字符；外部签发方的 `act.sub` / `act.name` / `sub` 同样拒绝，过长的截短 |
| L-1【低】 | 名片的 `iat` 没有将来的上限：一张 `iat` 在很远将来的名片会让这个人以后的所有名片都“更旧”而被拒（`card_older`） | `iat` 晚于现在 1 天以上的名片拒绝（`IDENTITY_CARD_LIMITS.iatFutureMaxS`，limits.md 第 8 节），说明可能是对方时钟不对 | `review L-1`：2 天后的拒绝，1 小时后的接受 |

审查记给别的包的：jti 重放缓存与精确的 `aud`、名片地址的 SSRF 过滤（P4-04 / P4-08）；L-5（`kid` 接受 base64url）交关口，即第 7 节第 3 条。

### 并入 P4-02 的审查修订（ADR-121 第 4a 节）

- 八个处理函数都按 `commitLetIn(req, () => …)` 写：先做完所有 `await`（导入时验名片签名，经 `card.ts` 的 `cardReader.read`），再在 `commitLetIn` 里同步地判断、写库、记审计、组织回答。导入在等待验签期间 PIN 被重置，就回 409 `pin_changed`，什么也不写（测试把导入卡在验签里，期间经 `/api/pin/reset` 重置，放开后核对 409、通讯录为空、B 的令牌 401）。只读的四个（导出、只看、列出、查看）也在 `commitLetIn` 里回答：`serve` 要求要 PIN 的接口成功时都经过它。
- 吊销钩子 `contacts` 是同步的数据库钩子（不带 `outside`）。
- P4-02 新加的“没走 `commitLetIn` 就 500”的测试原来借联系人的探针，改用 `daisy token` 的探针（路径 `/api/tokens/forgot`）。


## 阶段 4 关口决定

阶段 4 关口（2026-11-17，维护者）答复了第 7 节交关口的两条：

1. **第 7 节第 1 条（读要不要 PIN）→ 网页等读不要 PIN，命令行读仍要。** 导出自己的名片（`GET /api/contacts/me`）、列出、查看联系人，以及只看一张名片（`POST /api/contacts/inspect`，它只解析给它的文本、什么也不写）不再写 `letsIn`，改为 `PIN_ON_CLI`（网页、配对设备、外部签发方给主人的令牌不要；本机命令行仍要，命令行凭据可能是主人的 AI——`PIN_ON_CLI`，见 ADR-121 关口决定），处理函数不进 `commitLetIn`。仍然只对主人的通道、仍然要 `daisy:grant`：AI 的工作凭据 `channel_not_allowed`，来访者 `a2a_only`，没有 `daisy:grant` 的凭据 `insufficient_scope`。`inspect` 是 POST，放在 `/api/contacts…` 这个留出的位置上，所以写 `notLetIn`（“只读：……”）。导入、移除、加入 / 移出白名单照旧 `letsIn: "contact"`（PIN + `commitLetIn`）。契约 identity-card.md 第 6 节、scopes.md 第 2 节随之写明。命令行 `daisy contact export|inspect|list|show` 照旧问 PIN；网页设置 › 对外打开时直接列出联系人，导入时**先**验名片给你看，再要 PIN（P4-12 决定 7 改了）。
2. **第 7 节第 3 条（`kid` 的编码）→ 统一 base32。** P2-01 的 `SelfIssuer` 签的 `kid` 改成 base32 身份编号（见 ADR-113 的关口决定一节）；`Contacts.verifyToken` 只认 `kid === 联系人的身份编号`，base64url 指纹写的 `kid` 拒绝（审查 L-5 关闭）。`keyRefBytes` / `byKeyRef` 照旧认三种写法——那是给人输入和给 URN 用的，与 `kid` 无关。
