# ADR-107：本机接口的定义只有一份——服务端路由、命令行元数据、接口文档、客户端类型都从它来

- 日期：2026-11-17
- 状态：**已实施（P1-06），待审查**
- 工作包：P1-06（为 P1-03、P1-07、P1-08 铺路）
- 相关：入口等价原则（命令行、本地网页、本机接口三者能力一致）、工程约定（接口定义只有一份，命令行、网页、接口文档都从它生成）；契约草稿 `docs/contracts/local-api.md` 第 1 节、`docs/contracts/scopes.md`

## 背景

P1-06 之前，本机接口的“定义”散在各处：路由在 `packages/daisy/src/app/*.ts` 和十几个领域模块里各自 `app.get/post(...)`，请求校验是处理函数里就地写的 zod，客户端包的 `DaisyClient` 又按路径字符串手写一遍，没有接口文档，也没有命令行。P1-07 要做 `daisy` 命令，P1-03 要按 scope / 通道 / PIN 检查每条接口，两者都需要一张“每条接口是什么”的表。

## 决定

### 1. 一条接口一条定义（`packages/contracts/src/api/`）

每个文件导出一个或几个 `group(<分组>, { <key>: route({...}) })`，`api/index.ts` 汇总成 `api`（按文件）和 `API_ROUTES`（扁平表）。id 是 `<分组>.<key>`，由 `group` 填，不手写。一条定义有：

| 字段 | 含义 |
| --- | --- |
| `method`、`path` | 服务端按它注册（`:name` 为路径参数） |
| `summary`、`description` | 命令行帮助和文档的标题与说明 |
| `scope` | `scopes.md` 的六个之一，`null` = 不要令牌。P1-03 起由服务端检查，现在只是标注 |
| `pin` | “放别人进来”，还要 PIN 授权（默认 false；阶段 1 没有这类接口） |
| `channels` | 主人的哪些通道能调用，默认三个都行（网页、配对设备、命令行）；回答 AI 的工具授权和提问是 `["web", "device"]` |
| `aiSelf` | AI 的工作凭据能调用这条接口，且只限这个路径参数是它自己的会话（权限表「读对话记录和事件：只限自己这个会话」）。不写就不对 AI 开放；定义里的 `channels` 由此算出（带 `ai` 当且仅当写了 `aiSelf`） |
| `auth` | 不靠 Bearer 令牌认证的两种：`gateway-secret`（宿主后端的网关密钥，服务端到服务端）、`socket-first-frame`（实时连接第一帧带令牌）。区分“公开”（`scope: null` 且没有 `auth`）和“自带凭据” |
| `idempotent` | 请求体里有幂等键：`true` 表示 `requestId`，也可以写字段名（终端输入是 `id`）。命令行自动生成它 |
| `params`、`query`、`body` | zod schema；`params` 不写时按路径生成（每个都是 string） |
| `bodyFull` | 处理函数分两步校验请求体时，最终要满足的 schema（文档和命令行读它） |
| `output` | `json<T>("名字")`（类型取自契约的 TS 类型）、`json(schema)`、`binary(...)`、`websocket(...)` |
| `errors` | 会回的机器可读错误码（已知的才写） |
| `cli` | `cmd("session cancel", { args })`，或 `exempt("理由")` |
| `removal` | 计划删除的工作包和原因（P1-03 要删的账号、机器类接口） |

### 2. 服务端：从定义注册、用定义的 schema 校验，不改语义

`packages/daisy/src/app/serve.ts` 的 `serve(app, def, handler, options?)` 按定义的方法和路径注册，并把定义挂在路由配置上（`config.api`，P1-03 的检查从这里读）。处理函数里原来就地写的 schema 原样搬进定义，在**原来的位置**用定义的 schema 解析（`def.body.parse(req.body)`、逐字段的 `def.query.shape.x.parse(...)`）。所以校验的先后（先认证、再找会话、再校验请求体）、错误状态码和错误文案都不变；`tests/*` 不需要改。

`createApp` 记下每条注册的路由和它的定义（`registeredRoutes()`）。测试要求：每条 `/api/*` 路由都经定义注册，每条定义都注册了，方法和路径一致。新路由绕过定义表就会失败。

### 2a. AI 的工作凭据只到自己的会话

设计的权限表里，AI 工作凭据一栏只有“读对话记录和事件：只限自己这个会话”和 AI 自用工具（定时唤醒、周期任务、后台命令、主动发言、调用别的智能体）。后者经 MCP 提供（`daisy:tools`），不是本机接口，不在这张表里。所以本机接口默认**不对 AI 开放**；只有写了 `aiSelf: "<会话 id 所在的路径参数>"` 的接口对 AI 开放，P1-03 检查令牌所属会话等于这个参数。现在开放的 8 条：会话快照、往前翻页、事件、恢复记录及其事件、在线活动、队列、定时列表，都是 `GET /api/sessions/:id/...`、`daisy:session:read`。测试：对 AI 开放当且仅当写了 `aiSelf`，`aiSelf` 是路径参数，且只能是会话下的只读接口；列会话、新建会话、审批、附件下载、命令状态（`/api/shell/:id` 的 id 是命令 id）、实时通道、`/api/me`、注销都不对 AI 开放。

### 2b. 凭据和文件不进命令行参数

字段可以标 `secretInput(...)`（凭据）或 `fileInput(...)`（文件内容，base64），写进 JSON Schema 的 `x-daisy-input`，校验不变。命令行元数据里它们的 `source` 是 `prompt`（从标准输入或不回显的提示读，不接受命令行里的值，免得进 shell 历史和 `ps`）或 `file`（选项给文件路径）；凭据不能做位置参数。现在标了的：身份档的 `apiKey`、harness 登录的授权码 `code`、附件上传的 `data`（文件），以及 P1-03 要删的账号密码几处。

### 3. 命令行元数据（`api/cli.ts`），给 P1-07

`cliCommands(API_ROUTES)`：每条有 `cli` 的定义一个命令，带位置参数（默认是路径参数）、选项（其余字段，`--kebab-case`，类型、限制、默认值、说明来自 zod 的 JSON Schema 和 `.describe()`）、是否要 PIN、是否自动带幂等键、请求体不是普通对象时用 `--json`。`cliTree` 给出子命令树，`cliHelp` 给出帮助文本。命令一律是叶子（不能一条命令又是另一条的上一级），测试检查。

不经本机接口的本地命令不在这张表里，由 P1-07 写在命令行包里（`local-api.md` 第 1 节）。**合并规则**：本地命令的名字登记在契约的 `LOCAL_COMMANDS`（`start`、`stop`、`status`、`open`、`update`、`doctor`、`uninstall`、`autostart`）；表里的命令第一个词不能是其中任何一个（测试检查），所以两套合在一起时不会出现“一个叶子下面还有命令”。本地命令要调用接口时（例如 `daisy update` 等空闲重启、`daisy status` 读健康检查），直接用定义（`DaisyClient.call` 或 `fillPath`），不另起名字。重启这一组因此叫 `daisy restart status|request|cancel`，`daisy update` 留给 P1-07。P1-07 要新增本地命令时，先把名字加进 `LOCAL_COMMANDS`。

### 4. 接口文档（`docs/api/`）

`npm run gen:api`（`scripts/gen-api-docs.ts`）生成 `docs/api/local-api.md`（人读：分组目录、每条接口的权限与命令、字段表、命令行总表与每条命令的帮助、没有命令的接口及理由）和 `docs/api/openapi.json`（OpenAPI 3.1，`x-daisy-scope` / `x-daisy-pin` / `x-daisy-channels` / `x-daisy-cli`）。两份都提交；测试比对生成结果与仓库里的文件，不一致就失败。

### 5. 客户端类型

`DaisyClient.call(def, { params, query, body })`：路径、查询、请求体、回答的类型都从定义来（`ApiInput<D>`、`ApiOutput<D>`）。原有的手写方法保留（网页和手机都在用），一部分改为经 `call` 实现、参数类型取自定义。

### 6. 入口等价的检查

每条定义要么有命令，要么 `exempt("理由")`，理由写进文档的“没有命令的接口”一节。限制了通道且不含命令行的接口必须豁免。豁免只有这几类：回答 AI 的工具授权和提问（权限表「替 AI 点头」）；P1-03 要删的账号密码、多账号、机器管理、按内网地址准入；不是主人操作的服务端调用（宿主令牌交换、平台镜像通知设置）；进程级命令内部读的（健康检查）；WebSocket 推送通道；同一操作的另一种写法（PUT 与 PATCH）。

### 7. 放别人进来的操作单独成接口（阶段 4）

两处现在留着“桩”，阶段 4 必须改成单独的、要 PIN 的 `daisy:grant` 接口，不能在现有接口上加参数：

- **公开会话**：`POST /api/sessions` 的请求体为兼容旧客户端仍接受 `visibility` / `visibleTo`，但阶段 4 之前一律记为私有、这两个字段被忽略；定义用 `bodyFull` 把它们从文档和命令行里去掉。把会话设为公开、改开放范围是“放别人进来”，阶段 4 走单独的接口（`pin: true`、`scope: "daisy:grant"`），新建会话不会因为带了这两个字段就公开。
- **调用卡片**：`POST /api/approvals/:aid/respond` 只回答自己 AI 的卡片（工具授权、提问、被拦截的操作），限网页和配对设备、不要 PIN。别人的调用请求（调用卡片，`approvals.ts` 的 `respondCard`）现在是回 404 的桩；阶段 4 它是单独的、要 PIN 的 `daisy:grant` 接口，命令行可以调用（权限表「批准或拒绝别人的调用请求」主人与命令行都 ✓、要 PIN），不能并进这条只限网页的接口。

## 和契约草稿 `local-api.md` 的差别

| 草稿 | 这次 | 原因 |
| --- | --- | --- |
| `input: { params, body }` | `params`、`query`、`body` 平铺 | 处理函数里写 `def.body.parse(...)` 更短；内容相同 |
| `id` 手写 | 由 `group` 按 `<分组>.<key>` 生成 | 少一处重复 |
| `output` 必填 zod，测试模式校验每个响应 | `output` 必填，但多数是 `json<T>("名字")`：类型取自契约现有的 TS 接口，没有 zod | 回答的类型在契约里本来就是 TS 接口；为 100 多条接口另写一遍 zod 等于再造一份定义。测试模式下的响应校验留作后续 |
| `cliExempt` 单独一张表 | 写在定义的 `cli: exempt(...)` 里 | “只写一处” |
| `since`、`deprecated` | 没加 | 接口版本还是 1，没有废弃的接口；`removal` 记 P1-03 要删的 |
| 服务端中间件按定义查 scope / 通道 / PIN | 只标注，不检查 | 属于 P1-03 |
| 错误用 RFC 9457（带 `fix`）、`Idempotency-Key` 请求头 | 没改 | 不在本包范围；现有 `{ error, code }` 和请求体 `requestId` 原样保留 |

## 后果

- 新增一条接口：在 `api/<分组>.ts` 加一条定义，处理函数用 `serve` 注册，跑 `npm run gen:api`。文档和命令行元数据自动有它；忘了注册、注册到别的路径、忘了写命令或理由、忘了重新生成文档，测试都会失败。
- P1-03 读 `routeDef(req)` 做 scope / 通道 / PIN 检查；P1-07 读 `cliCommands` / `cliTree` / `cliHelp`，配上本地命令，就有完整的 `daisy`。
- 插件（P1-10 的缝隙）现在不注册 `/api/*` 路由；以后插件要加本机接口，同样写定义。

## 后续

1. 错误格式改为 RFC 9457（`application/problem+json`，带 `fix`），错误码登记进契约（每条定义的 `errors` 引用）。
2. `Idempotency-Key` 请求头，等同于请求体的 `requestId`。
3. 回答的 zod schema：从最常用的几条开始（会话、快照、条目），测试模式下按定义校验响应。
4. `Daisy-Api-Version` 请求 / 响应头、`GET /api/version`、OpenAPI 的不兼容改动检查（`local-api.md` 第 7 节）。
5. 客户端的手写方法逐步换成 `call`，最后从定义生成。
