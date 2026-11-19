# 本机接口契约

版本：0.1　状态：草稿，待维护者评审
修订：0.1（2026-11-16）初稿。 0.1.1（2026-11-18，P6-02，ADR-152）第 7 节加“公开发布前的一次改名”：带产品旧名的取值和字段改成中性写法，服务端读旧写、只发新写。

依据：设计的工程约定（接口定义只有一份；界面只经客户端包和契约包访问）、数据与兼容约定（主.次.修；不兼容改动只在主版本）、“不重放副作用”原则（幂等键）、“入口等价”原则（命令行、本地网页、本机接口能力一致）、本机接口的分组与细分权限、P1-06、P1-07、P4-12；现有 `packages/contracts`（zod 4，`API_VERSION = 1` 在 `src/index.ts`）。

本文定两件事：接口定义怎么写，才能“只有一份”；版本与兼容的规则。具体有哪些接口不在这里列，由定义表生成的文档列。

---

## 1. 只有一份：定义表

每条本机接口在契约包里写一条定义。服务端路由、命令行子命令、帮助文本、接口文档都从这张表生成或校验，不再各写一遍。

位置：`packages/contracts/src/api/<分组>.ts`，分组照设计（会话、审批、身份档、工作区、调用授权、设置、附件，加上系统、事件）。`packages/contracts/src/api/index.ts` 汇总成一张表。（P1-00 拆 `index.ts` 时一并建立这个目录。）

**一条定义长这样**

```ts
import { z } from "zod";
import { route } from "./route.ts";

export const sessionCancel = route({
  id: "session.cancel",                 // 全表唯一，点分，生成命令名和文档锚点
  method: "POST",
  path: "/api/sessions/:id/cancel",
  summary: "停下会话当前这一轮",          // 一句话，命令行帮助和文档标题
  description: "排队中的消息保留。已经产生的副作用不回滚。",
  scope: "daisy:session:write",         // scopes.md
  pin: false,                           // true：还要 PIN 授权（第 6 节）
  channels: "any",                      // 或 ["web", "device"]：通道限制（scopes.md）
  idempotent: true,                     // 写操作是否接受幂等键（第 5 节）
  input: {
    params: z.object({ id: z.string() }),
    body: z.object({ reason: z.string().max(200).optional() }),
  },
  output: z.object({ status: SessionStatusSchema }),
  errors: ["session_not_found", "not_running"],   // 第 4 节的错误码
  cli: {
    command: ["session", "cancel"],     // daisy session cancel <id>
    args: ["id"],                       // 位置参数取自 params/body 的哪些字段
    // 其余字段自动成为 --选项，名字由字段名转短横线写法
  },
  since: "1.0",                         // 第一次出现的接口版本
  deprecated: undefined,                // 或 { since: "1.4", use: "session.stop" }
});
```

**生成什么、校验什么**

| 产物 | 怎么来 | 说明 |
| --- | --- | --- |
| 服务端路由 | 服务端遍历定义表注册。输入用 `input` 校验，scope、通道、PIN 由同一段中间件按定义检查 | 处理函数只写业务，不再自己写 zod 校验和权限判断 |
| 客户端包 | 由定义表生成带类型的调用函数（`client.session.cancel({ id })`） | 本地网页、手机、外部界面都只经客户端包（工程约定） |
| 命令行 | 有 `cli` 的定义自动成为子命令；参数、`--help` 文本来自 `summary`、`description` 和 zod 字段的 `.describe()` | 命令行走本机接口，不直接读写数据库（P1-07） |
| 接口文档 | 生成 Markdown 和 OpenAPI 3.1（zod 4 自带 `z.toJSONSchema()`） | 每次构建重新生成，提交进仓库，差异在评审里可见 |
| 测试 | 一条检查：每条定义要么有 `cli`，要么在 `cliExempt` 里写明理由 | 入口等价。允许的例外只有两类：回答工具授权和提问（只在网页和配对设备上）；进程级命令 |

**不经定义表的命令**：`daisy start`、`stop`、`status`（进程还没起来时也要能用）、`open`、`uninstall`、`autostart`、`doctor`、`update` 里不经接口的部分。它们写在命令行包里，列进一张“本地命令”表，同样生成帮助文本。

**输出也要定义。** `output` 是必填的。服务端在测试模式下用它校验每个响应，防止实现悄悄多返回或少返回字段。

## 2. 请求的公共部分

| 项 | 写法 |
| --- | --- |
| 认证 | `Authorization: Bearer <凭据>`。本地网页用会话 Cookie（加防跨站检查，始终开启）。认证结果见 token.md 第 3 节 |
| 链路号 | 可选 `traceparent` 请求头（trace.md）。不带时，每个写请求新起一个 |
| 幂等键 | 写请求带 `Idempotency-Key` 请求头（第 5 节） |
| PIN 授权 | `Daisy-Pin-Grant` 请求头（第 6 节） |
| 接口版本 | 可选 `Daisy-Api-Version` 请求头（第 7 节） |
| 内容类型 | `application/json`。上传附件用 `multipart/form-data` |

## 3. 响应的公共部分

- 成功：`2xx`，JSON，形状照定义的 `output`。
- 每个响应带 `Daisy-Api-Version: <主.次>` 响应头。
- 列表一律分页：`{ "items": [...], "cursor": <下一页的游标或 null>, "hasMore": <布尔> }`。现有的 `after` 序号游标（会话事件、事件出口）保持原样。

## 4. 错误

用 RFC 9457 的问题详情格式，`Content-Type: application/problem+json`：

```json
{
  "type": "https://quantgrail.github.io/daisy/errors/pin_required",
  "title": "需要输入 PIN",
  "status": 403,
  "code": "pin_required",
  "detail": "把会话设为公开属于“放别人进来”的操作，需要先输入 PIN。",
  "fix": "在网页上输入 PIN 后重试；命令行会提示你输入。",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

| 字段 | 说明 |
| --- | --- |
| `type` | 指向这个错误码说明的地址，主机与 A2A 扩展 URI 相同（a2a-usage.md 第 8 节）。客户端不需要去访问它 |
| `code` | 机器读的错误码，小写下划线，全表登记在契约包里（每条定义的 `errors` 引用它）。客户端按它判断，不按文字 |
| `detail` | 出了什么事（工程约定：每条错误信息说明出了什么事） |
| `fix` | 怎么解决（工程约定：…以及怎么解决）。必填 |
| `traceId` | 这次请求的链路号，便于对照审计 |

现有代码里 `HttpError(status, message, code)` 的三个参数正好对应 `status`、`detail`、`code`，迁移时补上 `fix`。错误信息里不出现凭据、令牌、PIN。

通用错误码：`unauthenticated`（401）、`insufficient_scope`（403）、`channel_not_allowed`（403，比如命令行回答工具授权）、`pin_required`（403）、`pin_locked`（423，带 `retryAfter`）、`not_found`（404）、`invalid_input`（400，带出错字段）、`idempotency_conflict`（409）、`unsupported_capability`（409，harness 没声明这个能力）、`api_version_unsupported`（400）。

## 5. 幂等键

- 所有改状态的请求（`POST`、`PUT`、`PATCH`、`DELETE`）接受 `Idempotency-Key` 请求头，1–100 个字符，客户端每个动作生成一个，重试时不变（不重放副作用）。
- 同一个凭据主体、同一个接口、同一个键：内容相同返回原来那一次的结果（同样的状态码和响应体）；内容不同回 409 `idempotency_conflict`。
- 键保存 24 小时（limits.md）。
- 现有接口里放在请求体的 `requestId`（比如发消息、建会话）继续接受，等同于这个请求头；两者都带且不同时回 400。命令行和客户端包一律用请求头。

## 6. PIN 怎么传

1. 先换一张 PIN 授权：`POST /api/pin/grant`，请求体 `{ "pin": "…" }`。成功返回 `{ "grant": "<不透明串>", "expiresAt": … }`。
2. 之后要 PIN 的请求带 `Daisy-Pin-Grant: <grant>`。
3. 授权绑定换它的那个凭据（网页会话、配对设备），别的凭据拿去无效。5 分钟内有效（设计要求：“输入一次后，在这次网页会话里短时间内有效”）。
4. 连续输错的锁定、有效期等数值见 limits.md。锁定期间回 423 `pin_locked`，带还要等多久。
5. **命令行不缓存授权**：每条要 PIN 的命令都在终端里提示输入，授权只存在这个命令进程的内存里，用完即弃。原因：缓存文件主人可读，AI 也就可读。
6. PIN 和 PIN 授权不写进日志、审计、错误信息。

## 7. 版本与兼容

**三样东西各有版本**

| 东西 | 版本 | 在哪里看 |
| --- | --- | --- |
| Daisy | `主.次.修` | `daisy --version`、`GET /api/version` |
| 本机接口 | `主.次`。主版本跟 Daisy 的主版本一致；次版本在本机接口有新增时加 1 | `Daisy-Api-Version` 响应头、`GET /api/version` |
| 对外协议 | A2A `1.0`、事件格式、令牌格式、身份名片格式各自的版本 | `GET /api/version` |

`GET /api/version`（不要令牌）返回：

```json
{ "daisy": "1.2.3", "api": "1.4", "a2a": ["1.0"], "events": "1.0", "token": "1.0", "identityCard": 1, "mcp": ["2025-11-25", "2026-07-28"] }
```

现有契约包里的 `API_VERSION = 1` 就是这里的主版本，改成 `API_VERSION = { major: 1, minor: n }`。

**兼容的改动（次版本，可以随时做）**

- 新增接口。
- 请求里新增**可选**字段，或放宽校验（变长、多接受一种取值）。
- 响应里新增字段。
- 新增错误码（旧客户端按状态码处理）。
- 新增枚举取值，**仅限**定义里标了“开放枚举”的字段（客户端必须容忍不认识的值）。其余枚举加值算不兼容。

**不兼容的改动（只在主版本）**

- 删除或改名接口、字段、错误码。
- 可选字段变必填，收紧校验。
- 改变字段或接口的含义、默认值、权限要求（scope、PIN、通道）。
- 给封闭枚举加值。

**废弃**：要去掉的接口先标 `deprecated: { since, use }`，文档和命令行帮助里显示替代做法，响应带 `Deprecation` 响应头。它一直保留到下一个主版本才删。

**公开发布前的一次改名（ADR-152）**：第一次公开发布之前，契约里带产品旧名的取值和字段改成了不带产品名的写法，按上面的规则本该等主版本，这里作为发布前的一次例外：

| 旧写法 | 新写法 |
| --- | --- |
| 能力取值 `harbor`（能力声明、`features`、快照的 `rewindFiles`、「停止」的 `subagents` / `commands`） | `fallback` |
| 回退结果的 `files.via: "harbor"` | `fallback` |
| 会话字段 `harborPending` | `schedulerPending` |
| 「后台」条目的 `source: "harbor"`、编号 `harbor:<id>`、类型 `harbor_bash` / `harbor_monitor` | `source: "scheduler"`、`scheduler:<id>`、`scheduler_bash` / `scheduler_monitor` |
| `POST …/background/:tid/stop` 回答的 `source: "harbor"` | `scheduler` |

服务端只发新写法；数据库里旧版本存下的记录、旧版本执行端的上报在读出时换成新写法；`…/background/:tid/stop` 两种编号都收。客户端包和界面连到旧版本的 Daisy 时两种写法都认（契约包 `isFallback`、`schedulerPendingOf`、`normalizeLiveTimer`）。A2A 线上的内容不受影响。

**客户端怎么对版本**

- 客户端可以带 `Daisy-Api-Version: <主>` 或 `<主.次>`。主版本不同回 400 `api_version_unsupported`，说明两边各是什么版本、该升级哪一边。次版本比服务端新时照常处理，客户端自己根据响应头判断能不能用新接口。
- 必须忽略响应里不认识的字段。
- 客户端包和服务端在同一个仓库里一起发布，版本总是相同；这条规则主要管外部界面、手机和别的项目。

**检查**：持续集成里比对“这次生成的 OpenAPI”和“上一个发布版本的 OpenAPI”，出现不兼容改动而主版本没变时失败。

## 8. 给 harness 的 MCP 工具

不属于本机接口，但版本规则相同。【建议】同时支持 MCP 2025-11-25 和 2026-07-28 两版（各家 harness 自带的 MCP 客户端版本不一；2026-07-28 去掉了 `initialize` 握手）。走 stdio 时 MCP 授权规范不适用，AI 工作凭据经环境变量交给 MCP 进程（research/auth-mcp-a2a.md）。工具的输入输出同样在契约包里用 zod 定义，工具描述从定义生成。
