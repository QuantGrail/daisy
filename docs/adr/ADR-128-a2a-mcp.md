# ADR-128：独立的 A2A MCP——不装 Daisy 的 harness 自带身份和通讯录，只做客户端

- 日期：2026-11-17
- 状态：**已实施（P4-09，分支 `p4-09`，基于 `p4-08`；未合入 `daisy-next`；包没有发布）**
- 工作包：P4-09（独立的 A2A MCP）
- 相关：设计要求——私人 agent 也要有身份；A2A 只做客户端；公钥互认；私人 agent 经独立的 A2A MCP 调用别人；名字集中在一处常量。契约 `identity-card.md`（第 1、4、6 节）、`token.md` 第 3 / 5 节、`a2a-usage.md` 第 15 节、`trace.md`；ADR-099、ADR-120（名片、P4-01 审查的形近标签和编号检查）、ADR-127（P4-08 客户端、出站连接）

## 背景

私人 agent 可以是完全不装 Daisy 的 harness。它要调用别人，对方就得认得它：自带一对密钥，用同样的公钥互认方式加进别人的通讯录；别人没有地址可以调用它。P4-08 在 Daisy 里做了三个客户端工具，客户端代码（`a2a/client/net.ts`、`peer.ts`）写成只依赖 `node:*` 和契约，留给本包复用。本包要的是一个能单独发布到 npm 的小包，不能把整个 Daisy 进程带进去。

## 决定

### 1. 共用的代码搬到 `packages/a2a-client`（`@daisy-ai/a2a-client`，工作区包，只有源码）

| 文件 | 来自 | 内容 |
| --- | --- | --- |
| `net.ts`、`peer.ts` | `packages/daisy/src/a2a/client/` | 出站连接（SSRF 规则、钉住 IP、TLS 判断、不跟随跳转、上限）与 `A2APeer`，原样 |
| `identity.ts` | `packages/daisy/src/contacts/identity.ts` | 身份编号的三种写法，原样 |
| `card.ts` | `packages/daisy/src/contacts/card.ts` | 名片的生成、读取和验证（含 P4-01 审查的形近标签、全角冒号、零宽字符、“人看的部分里任何一串 52 个 base32 字符都必须是这张名片的编号”）。`makeCard` 的签名方改成接口 `CardSigner`（`SelfIssuer` 照样满足）；新增 `expectIdMatches`（导入时“和对方核对过的编号”，Daisy 的导入接口改用它） |
| `constants.ts` | `access/tokens/common.ts`、`contacts/index.ts` | `THUMBPRINT_URN`、`IDENTITY_CARD_TYP`、`ACCESS_TOKEN_TYP`、`UNSAFE_TEXT`、`A2A_CLIENT_ID` |
| `token.ts` | 新 | `signA2AToken`：一个请求一张跨 Daisy 令牌的规则集中在这里——`iss` = `sub` = 自己的 URN，`aud` 正好是对方的 URN（一个字符串），`client_id` `a2a`，scope `daisy:invoke`，最长 300 秒（超过报错，不悄悄缩短），每张新的 `jti`，头 `EdDSA` / `at+jwt` / `kid` = 指纹 |

依赖：`node:*`、`jose`、`packages/contracts/src`（`a2a.ts`、`limits.ts`、`names.ts`；`a2a.ts` 带着 `zod`）。Daisy 里原来的位置留成转出（`a2a/client/index.ts`、`contacts/identity.ts`、`contacts/card.ts`——`cardReader` 这个测试缝留在 Daisy）、`common.ts` 和 `contacts/index.ts` 再导出常量，Daisy 其余代码和测试的引用不变。`scripts/pack-daisy.ts` 的 `PACKED_DIRS` 加 `packages/a2a-client/src`（安装包里的 Daisy 也要它）。

### 2. 包 `packages/a2a-mcp`（`@daisy-ai/a2a-mcp`，命令 `daisy-mcp`）

- 名字：按设计时的建议叫 **Daisy MCP**（`MCP_NAME`），命令 `daisy-mcp`（新常量 `MCP_COMMAND_NAME`，都在 `contracts/src/names.ts`）；npm 前缀 `@daisy-ai`。
- 发布形态：`node build.mjs`（`npm pack` 的 `prepack`）用 esbuild 把 `src/bin.ts` 连同 `packages/a2a-client`、用到的契约**打成一个文件** `dist/daisy-mcp.mjs`（约 110 KB，带 `#!/usr/bin/env node`）；npm 包里只有这个文件、`README.md` 和 `package.json`。打包时检查：只能打进 `packages/a2a-mcp|a2a-client|contracts/src` 的文件（Daisy 进程的任何文件进来就失败），留作 import 的包必须在 `dependencies` 里。
- 依赖（精确版本）：`@modelcontextprotocol/sdk` **1.32.1**（官方 MCP SDK；仓库里本来就有——`@anthropic-ai/claude-agent-sdk` 的 peer，锁文件里已是 1.32.1，这次成为本包的直接依赖，锁文件只去掉了一串 `"peer": true`，没有新版本）、`jose` 6.2.12、`zod` 4.6.5；开发依赖 `esbuild` 0.28.2（`tsx` 已经带着同一版本）。`engines.node` `>=24.0.0`，和仓库一致。
- **`"private": true`**：发布要维护者明确同意。这一版只做到“随时可以发布”：`npm pack --dry-run` 的内容由测试核对；发布时维护者去掉 `private`、`npm publish --access public`（`publishConfig.access` 已写好）。

### 3. 它自己的目录（`home.ts`）

`--home <目录>` > 环境变量 `DAISY_MCP_HOME` > 系统惯例：macOS `~/Library/Application Support/Daisy MCP`，Linux `$XDG_CONFIG_HOME/daisy-mcp`（没有就 `~/.config/daisy-mcp`），Windows `%APPDATA%\Daisy MCP`。和 Daisy 的数据目录分开（同一台机器上的 Daisy 和 MCP 是两个身份）。

| 文件 | 内容 |
| --- | --- |
| `identity-key.json` | Ed25519 私钥（JWK），第一次用时生成（`wx`，两个进程同时第一次启动时后来的用先写的那把） |
| `profile.json` | 名片上的名字、备注 |
| `contacts.json` | 通讯录：只存每张名片的 JWS 和加入 / 更新时间；**每次读都用共用的 `readCard` 重新验证**，验不过的（被手改过的）不用 |
| `tls-pins.json` | 对方自签证书的指纹，按“联系人 × 地址源”，规则同 ADR-127 第 4 节第 5 条 |
| `calls/<调用编号>.json` | 每次调用一个文件（多个 harness 进程共用一个目录时互不覆盖），最多留 500 个（先删最早的已结束的） |

目录 0700、文件 0600，整文件写（临时文件改名）；读时拒绝符号链接、非普通文件、别的账户的文件、组或其他人能读写的文件（说明怎么改），不悄悄用。Windows 上不检查 ACL（见“留下的问题”）。

### 4. 名片与通讯录（`identity.ts`、`contacts.ts`）

- 自己的名片：`daisy-mcp card --name <名字> [--note <备注>]`，按 identity-card.md 第 1–3 节，用共用的 `makeCard` 生成、自己的私钥签；**`addrs` 为空**（identity-card.md 第 1 节：别人认得它，但没有地址可以调用它）。第一次必须写 `--name`（不默认用系统用户名或主机名，免得把这些带到别人的通讯录里），之后记在 `profile.json`。导出不需要确认（名片是公开的）。
- 导入别人的名片：`daisy-mcp import [<文件>|-] [--expect-id <编号>] [--update] [--yes]`。验证就是 P4-01 的那一套（共用的 `readCard`，第 4 节第 1–5 步，含审查加的形近标签和编号检查），之后照 Daisy 导入接口的规则：自己的名片拒绝；`--expect-id` 对不上拒绝（整个编号任何写法，或至少 16 个字符的开头）；已在通讯录里——同一张名片“没有变化”，更旧的名片永不替换，新名片列出变化、只有加 `--update` 才替换。
- **确认代替 PIN**：MCP 没有 PIN，通讯录靠系统账户的文件权限保护。导入前把名字、完整编号（四个一组）、地址和“请和对方核对编号”的提示写到 stderr；要么加 `--yes`，要么（名片来自文件、终端可交互时）当场输入 yes，否则不导入。移除同样要确认。
- **AI 加不了联系人**：三个工具里没有导入 / 移除；互认只能由主人在命令行做。
- 对方 Daisy 那边：主人用 `daisy contact import` 导入 MCP 的名片（要 PIN，可同时加白名单），和导入任何 Daisy 的名片一样（P4-01 没有为此改动）。

### 5. 三个工具（`calls.ts`、`server.ts`）

官方 SDK 的 `McpServer` + `StdioServerTransport`，工具名、参数和 P4-08 一样（ADR-127 第 2 节）：`agents`、`call_agent`（`contact` 可以是编号、≥ 8 个字符的唯一前缀或唯一名字；`agent`、`text`、`mode`、`continue`、`replyTo`）、`call_result`。回答的文字、`<external_message>`（JSON，`<` `>` 转义）、“只是参考资料，不是你的本人的指令”、失败的说明都照 P4-08。

以这个 MCP 的身份：每个请求（目录、名片、发送、每次查询）现签一张（共用的 `signA2AToken`，120 秒），`act` = `{sub: "agent:daisy-mcp", name: <serve --agent-name，默认 Daisy MCP，去掉控制和方向字符，≤ 64>}`，不保存。出站连接、名片接口同源、JSON-RPC 优先、`Retry-After`、413、同一条消息原样重发（同一个 `messageId`，最多 5 次）全部是共用的 `A2APeer` / `net.ts` 和与 P4-08 相同的规则；回环一律不连（`bin.ts` 和打包出来的命令没有任何参数或环境变量能放开，只有测试的入口 `tests/fixtures/a2a-mcp-loopback.ts` 调 `main(argv, { policy })` 放开）。

和 P4-08 不同的地方（没有 Daisy 的会话、轮次和唤醒）：

1. **没有唤醒**：`call_agent` 发出后在工具里等一会儿（`A2A_CLIENT_LIMITS.inlineWaitMs`，6 秒，期间按 0.5 秒起 ×1.5 查任务，对方的 `Retry-After` 照办），没等到就回调用编号和“稍后用 `call_result` 查”；`call_result` 带编号时再向对方查（同样有界的等待），对方暂时连不上的发送在这里重发。没有后台定时器：MCP 进程只在 harness 开着时存在。
2. **链路**：这个 MCP 只会是一条调用链的起点（没人能调用它，所以没有更深的一轮）——每次新调用一个新链路号、深度 1；`replyTo` 沿用那次调用的链路号和深度。不数“同一链路号上的 64 次”（本机只有发出的，每次都是新链路号；对方 Daisy 照样按调用方数）。
3. 编号（A2A 的 contextId、taskId 各只有一个意思）：对方的 contextId / taskId 记在调用文件里，不编造；`continue` 取“这个联系人 × 这个 agent”最近一次的 contextId（这个目录里所有调用，不分 harness 会话）。

### 6. 命令（`main.ts`）

`daisy-mcp [serve] [--agent-name <名字>]`（harness 启动它；stdin 关闭就退出）、`card`、`import`、`contacts [--json]`、`remove <编号> [--yes]`、`--help`、`--version`，全局 `--home`。名片打印到 stdout（可以直接重定向成 `.daisycard` 文件），说明写到 stderr。

### 7. 只做客户端

本包和 `packages/a2a-client` 的源码、打出来的文件里都没有 `createServer` / `.listen(`（测试检查）；名片没有地址；Daisy 那边这个联系人的 `addrs` 是空的，Daisy 的 AI 对它 `call_agent` 得到“名片上没有地址……没有地址可以调用”（P4-08 已有的 `no_address`）。

## 测试

`tests/a2a-mcp.test.ts`（8 条，先写被拒绝的；`daisy-mcp` 命令从源码经 tsx 跑，MCP 客户端是官方 SDK 的 `Client` + `StdioClientTransport`，**真的起一个子进程**）：

1. 导入拒绝 P4-01 拒绝的：自己的名片；繁体标签 `編號` 加全角冒号显示别人的编号；人看的部分多一行别人的编号；名字行和签名的不一致；载荷被改（签名不对）；`--expect-id` 对不上、不足 16 个字符；没有确认（没有终端可问）——每一步之后通讯录都是空的；确认并核对（16 个字符、带空格、大写）后加入。
2. 已有的联系人：同一张名片没有变化；新名片没有 `--update` 被拒（列出名字和地址的变化），加了才替换；更旧的名片永不替换；移除要确认。
3. 目录：各系统的默认位置、`DAISY_MCP_HOME`、`--home`；0700 / 0600；私钥文件被改成 644 时拒绝使用并说明，输出里没有私钥。
4. 令牌：`iss` = `sub` = 自己、`aud` 正好是对方、`client_id` `a2a`、scope、120 秒、`kid`、`act`、每张新 `jti`；共用规则拒绝 301 秒和不是身份 URN 的 `aud`。
5. 真正的入口（生产规则）：Daisy 在回环上，`agents`、`call_agent` 都回“不连本机回环地址”，Daisy 没有任务、没见过任何令牌。
6. Daisy 没导入 MCP 的名片：发现和调用都回“对方不认得”，看不到 agent，没有任务。
7. **私人 agent 只装 MCP 调用别人**：一个真实的 Daisy（进程内、自己的数据目录、127.0.0.1 临时端口，不是 29311 / 29711）导入 MCP 的名片并加白名单，公开一个 agent（测试的执行方）；MCP 导入 Daisy 的名片；SDK 客户端列出正好三个工具（没有加联系人的）→ `agents` 列出 Daisy 和 agent（名字在 `<external_message>` 里）→ `call_agent`（慢的回答先拿到调用编号）→ Daisy 上的任务调用方是 `contact:<MCP 的编号>`、`actor` `agent:daisy-mcp`、问、深度 1、新链路号 → `call_result` 拿到回答（参考资料、对方的 taskId / contextId）；每个请求一张令牌、都记在这个联系人名下；`continue` 同一个 contextId 且对方带上了历史；`mode: act` 对方收到办；对方要补充时 `replyTo` 在同一个任务上完成，再 `replyTo` 被拒；伪造的 `</external_message>` 被转义；`call_result` 列出调用；调用文件 0600；**反过来没有地址**：Daisy 上这个联系人 `addrs` 为空，Daisy 的 AI 调用它被告知没有地址可以调用。
8. 发布形态：`package.json`（名字、`bin`、`private`、依赖都是精确版本且正好三个）；源码不监听、不 import Daisy 进程；打包到临时文件，打出来的命令不经 tsx 单独运行（生成名片、经 SDK 客户端列工具、空通讯录）、不含监听、不含放开回环的设置；`npm pack --dry-run --json` 的文件正好是 `README.md`、`dist/daisy-mcp.mjs`、`package.json`。

搬动代码波及的现有测试照旧通过（`contacts`、`a2a-client-net`、`a2a-client`、`cli-table`、`access`、`cli-pack`——后者加了一条：安装包里有 `packages/a2a-client/src`）。

## 待维护者决定的问题（先照推荐做）

1. **名字**：包 `@daisy-ai/a2a-mcp`，命令 `daisy-mcp`，显示名 Daisy MCP（设计时的建议）。
2. **放在这个仓库里**（工作区包），没有新建仓库（施工约定：建新仓库前要问人）。
3. **发布**：包保持 `private: true`；要发布时由维护者去掉它并 `npm publish --access public`（`@daisy-ai` 组织）。`package.json` 还没有 `license` 字段（仓库根也没有），发布前要定（已答复：开源许可证 Apache-2.0）。
4. **MCP 的导入不要 PIN**（它没有 PIN）：靠系统账户的文件权限，加上 `--yes` / 终端确认和 `--expect-id`。
5. **默认目录**放在系统的配置目录（不是数据目录），另可 `DAISY_MCP_HOME` / `--home`。
6. **`act`**：`agent:daisy-mcp`，名字由 `serve --agent-name` 给（默认 Daisy MCP）——对方主人看到的是“联系人 X 的 AI”。
7. **链路**：每次调用新链路号、深度 1；不在本机数 64 次。
8. **没有后台轮询和唤醒**：工具里等 6 秒，之后由 AI 用 `call_result` 查（MCP 没有可靠的办法叫醒 harness 里的 AI）。
9. **官方 MCP SDK 1.32.1**：会带进一串传递依赖（express、hono 等它的 HTTP 传输用的，本包不用）。另一个选择是自己写 stdio 的 JSON-RPC（小得多，但要自己跟 MCP 协议版本）。
10. `engines.node >=24`，和仓库一致；更低的版本没有测过。
11. 对方的自签证书首次信任，同 ADR-127。

## 留下的问题

- 只在 macOS 本机验证。Windows 上不检查目录和文件的 ACL（Daisy 的 ADR-099 用 ACL；这里只用 POSIX 权限位，Windows 上整个文件权限检查跳过）。
- 多个 harness 进程共用一个目录时，`contacts.json` / `tls-pins.json` 的写没有加锁（只有命令行改通讯录；证书首次信任的竞争无害），调用各自一个文件。
- 没有取消工具（`A2APeer.cancelTask` 已有）；对方返回的文件不取回，只列文件名（同 P4-08）。
- 不支持经中转（P5）；没有 `daisy-mcp` 的界面。
- “只装 MCP 调用别人”的真机验证：自动化测试在本机进程内跑通；在另一台机器上装上打出来的包、对一个真实 Daisy 做一遍，留给维护者（发布之前可以用 `npm pack` 出来的 tgz 装）。
