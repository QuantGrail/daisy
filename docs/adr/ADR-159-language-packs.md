# ADR-159：语言包——界面、命令行、接口提示、提示词和文档都按主人选的语言显示（P6-20）

- 日期：2026-11-18
- 状态：**已实施机制和一段样板（分支 `p6-20`，基于 `p6-gate`；待合入）**；其余各块由 P6-22 / P6-23 / P6-24 按第 10 节分头转换
- 来源：D-44 ①（“英文版全部做完”：界面、命令行帮助与输出、服务端给人看的提示、给模型的提示词、全部用户文档都要有英文，按主人选的语言显示，中文仍是一等语言）；主人对做法的要求：翻译放在每种语言单独的资源文件（语言包）里，源代码只写键名；加一种语言就是加一个语言包目录，不改代码
- 相关：ADR-102（数据目录、`config.json`）、ADR-107（接口定义表、生成文档）、ADR-112（命令行）、ADR-145（npm 包）、ADR-154（给模型看的文字）、ADR-156（`runner.json`）

## 背景

Daisy 的文字全写在源代码里，而且只有中文：扫描（第 9 节）在要发布的源代码里找到约 5,400 行带中文的字符串、模板和 JSX 文字，分在界面、命令行、服务端、接口定义表、给模型的提示词和几个单独发布的小程序里。D-44 ① 要求全部有英文，按主人选的语言显示。

这次只做**机制**、**分工的设计**和**一段从头到尾转换好的样板**；大头由后面三个工作包并行做。所以设计要满足：三个包同时改不互相冲突；转换一块就锁住一块（不会再长回中文）；没转换的地方照常工作。

## 决定

### 1. 语言包：每种语言一个目录，每块一个 JSON 文件，源代码只写键名

```
packages/contracts/locales/
  en/      common.json  cli.json  api.json  ui.json  docs.json  …  prompts/*.md（P6-24）
  zh-CN/   common.json  cli.json  api.json  ui.json  docs.json  …  prompts/*.md
```

- 每个文件是平铺的 `{ "键": "文字" }`，**键以文件名（区域）开头**：`cli.json` 里只有 `cli.*`，`ui-chat.json` 里只有 `ui-chat.*`（读取时检查，不合规的键不用并报告）。区域名可以带 `-` 分区，分区让同一区域能被几个人同时加键而不改同一个文件。
- 源代码只写键：`t("cli.status.running", { pid, uptime })`。没有自然语言的字符串留在 `.ts` / `.tsx` 里（第 5 节的检查锁住它）。
- 插值只有 `{名字}`，没有复数和格式化规则（数字原样打印）；`{product}`、`{command}` 总是自动填上（`names.ts`），语言包里不写产品名，改名仍只改一处。
- **语言列表就是现有的目录**，代码里没有语言清单：加一种语言 = 加一个 `locales/<语言>/` 目录（目录名是 BCP 47 标签，`en`、`zh-CN`、`ja` …）。
- **参照包是 `en`**：类型化的键从它生成（`packages/contracts/src/i18n-keys.gen.ts`，`npm run gen:i18n`，测试检查是最新的）；别的语言缺某个键时用 `en` 的；`en` 也没有就显示键本身（绝不抛错）。随 Daisy 发布的两个包（`en`、`zh-CN`）必须 100% 完整：测试要求两边的键完全相同、每个键的 `{参数}` 完全相同、没有空文字。
- 键的类型：`t("…")` 的键必须存在，参数按名字和个数检查（生成的 `MessageParams`）；运行时拼出来的键（`cli.local.${名字}.summary`）用 `t.dynamic(…)`，不检查类型，所以只在键集合确定、测试覆盖到的地方用。

代码在 `packages/contracts/src/i18n.ts`（浏览器也能用：匹配语言、解析 `Accept-Language`、插值、带回退的翻译器）和 `i18n-node.ts`（Node：从磁盘读语言包、读提示词文件、数据目录里的附加语言包）。

**为什么用 `en` 作参照和回退。** 第三种语言（社区加的）缺键时，英文比中文更可能被读懂；中文仍是一等语言——它的包必须完整，测试和英文一样严格。

**主人另放的语言包（可选）。** `<数据目录>/locales/<语言>/*.json` 里的语言包被发现并可选用（命令行、本机接口、网页都看得到，5 秒内生效，不用重启）。它只能**增加**一种语言，不能改写随 Daisy 发布的语言（同名目录以发布的为准）：发布的文字（包括给模型的提示词）不会被数据目录里的文件悄悄换掉。它和数据目录里的其他文件一样只有主人账户能写。

### 2. 用哪种语言：一个主人设置，加上明确的覆盖

**设置存在哪。** `config.json`（数据目录里主人对这台 Daisy 的设置，ADR-102）的 `language` 一节：`"zh-CN"`、`"en"` 等，没有这一节 = 跟随系统。选 `config.json` 而不是数据库：命令行在 Daisy 没运行时也要知道语言（本地命令从不读数据库）；选它而不是 `runner.json`：`runner.json` 是节点的启动设置（ADR-156），显示语言是主人的偏好，和口令方式、对外面放在一起。写用 `writeConfigSection`，其他节保持不变。

**谁能改、要不要 PIN。** `PUT /api/settings/language`（`daisy language set <语言>`，网页“设置 → 显示语言”），scope `daisy:manage`，**不要 PIN**：它不放任何人进来，也不决定这台机器运行什么代码（第 5.11 节 PIN 只管这两类），和开机自启同一档。AI 的工作凭据够不着（不是它自己会话的接口）。改了的影响写在第 6 节（只对新会话的提示词生效）。

**解析顺序**（第一个能对上现有语言包的胜出）：

| 谁 | 顺序 |
| --- | --- |
| 命令行 | `--lang <语言>`（或 `--lang=<语言>`）> `DAISY_LANG` > 主人设置 > 系统语言 > 英文 |
| 本机接口 | 请求的 `Accept-Language` > 主人设置 > 系统语言（Daisy 进程的 `DAISY_LANG` 算在这里）> 英文 |
| 网页 | 主人设置（`/api/health` 的 `language`，未设置时是系统语言）；浏览器的语言只在还不知道主人设置时用 |

**系统语言**：`DAISY_LANG`、`LC_ALL`、`LC_MESSAGES`、`LANG`（POSIX 顺序；`C`、`POSIX` 不算）、`LANGUAGE`，macOS 上再看账户的首选语言（`defaults read -g AppleLanguages`：launchd 起的 Daisy 没有 `LANG`），最后看运行时自己的区域（`Intl`，Windows 的用户区域）。标签按“同一主语言”就近匹配：`zh_CN.UTF-8`、`zh-Hans-CN`、`zh-TW` 都到 `zh-CN`（目前只有这一个中文包；以后有 `zh-TW` 包就精确匹配它），`en-GB` 到 `en`。

**都对不上时用英文。** 公开发布面对的是不知道是谁的读者；系统是中文的人自动得到中文。

**`DAISY_LANG` 在两边的位置不同。** 对命令行它是这一个终端的选择，排在主人设置前面（例如脚本要稳定的英文输出）；对 Daisy 进程它只顶替系统语言，主人在网页上选了就以选的为准，否则网页上的选择会被一个看不见的环境变量压住。

### 3. 本机接口：错误有稳定的 `code` 和按语言的文字

- 每个回答的错误保持原来的形状：`error`（给人看的文字）、`code`（机器读，稳定，不随语言变）、可有 `fix`。客户端按 `code` 判断，不按文字（local-api.md 第 4 节本来的规定）。
- 用消息键抛的错误（`LocalizedError(status, code, key, params, fixKey?)`）由错误处理按请求的语言说；回答带 `Content-Language`。
- 本次转换：参数校验失败（所有接口共用的那条路径）现在是 `invalid_input` + `api.error.invalidInput`，服务端内部错误是 `internal` + `api.error.serverFault`，语言接口的 `language_unknown`。其余 `HttpError(…, "中文", code)` 由 P6-23 换成 `LocalizedError`。
- 命令行每个请求带 `Accept-Language: <命令行的语言>`，网页的客户端带 `Accept-Language: <网页的语言>`（`DaisyClient.language`），所以服务端的文字和命令行、网页自己的文字是同一种语言。

### 4. 网页拿语言包的方式：向服务端取

- `GET /api/locales/:lang?areas=ui,common`（公开：登录页在没有会话时就要用；里面只有界面文字）。服务端按标签就近匹配（`zh-Hans-CN` → `zh-CN`），回答已经把英文垫在下面（缺的键显示英文，不显示键名）。`areas=ui` 同时取 `ui-*` 分区。
- 不打进网页构建：网页由同一个 Daisy 提供，版本总是一致；数据目录里另放的语言网页也能用；构建产物不随语言增多变大。代价是第一帧前多一次本机请求——`App.tsx` 本来就等 `/api/health`（取宿主外观）再显示，现在在同一步里取语言包。
- 嵌入 Daisy 的宿主页面：调用一次 `loadUiLanguage(client)`（`@daisy-ai/ui` 导出）；`Settings` 发现还没取时自己取一次。
- 组件用 `useT()`（语言切换时重新渲染），组件外用 `t`。网页切换语言：设置页选完后立即重新取包，整页跟着变，不用刷新。

### 5. 锁住已经转换的地方：中文扫描和只减不增的名单

- `scripts/i18n-scan.ts` 读要发布的源代码（`packages/**`、`apps/app/**`；不含测试、生成的文件、`scripts/`，以及不进公开树的私有文件），用一个小词法器去掉注释（含 JSX 注释）和正则表达式，数还剩中文的行。
- `tests/i18n-pending.json`：还没转换的文件和它们现在的行数。测试要求：不在名单上的文件一行都不能有；在名单上的不能超过名单的数；**少了必须把名单改小**（到 0 删掉这一项）。所以转换只能前进，新写的中文会立刻失败。转换好的样板文件写进测试，永远不能回到名单上。
- 最终状态：名单是空的。第 10 节写了少数应当长期保留的中文（存量数据的识别标记），由 P6-24 决定后移到明确写了理由的保留项（届时给名单加 `kept` 一节，每条带理由），不再算“待转换”。
- 扫描只认中文；新写的**英文**硬编码字符串它看不出来。约定：转换后的文件里，给人看的英文同样走语言包（评审时检查）；日志行例外，见第 10 节的约定 7。

### 6. 给模型的提示词（P6-24 实施）

- 长的提示词是每种语言一个文件：`locales/<语言>/prompts/<名字>.md`，用 `promptText(名字, 语言)` 读（缺的语言用英文的）；短的（工具说明、唤醒标题、标记）放在 `prompt*.json` 区域的键里。不再写成代码里的模板字符串。
- **按语言各自钉住**：现在 `tests/fixtures/prompt-off-chain-base.json` 逐字节钉住中文提示词；P6-24 给每种语言一份钉住的样本（`…-zh-CN.json`、`…-en.json`），改任何一种都要显式更新样本。
- **会话的语言在创建时定下**：新会话记下当时主人的语言，它的提示词各层（系统层、指南、工具说明、唤醒标题）都用这个语言，直到会话结束。主人改了语言，只影响之后新建的会话（以及新会话的新一轮）；已经在进行的会话保持原来的语言——中途换语言会让同一段上下文里出现两种语言的规则，模型看到的“同一条规则”不再相同，而且原生会话的系统提示词本来就改不了。设置页和 `daisy language set` 的帮助都写明了这一点。
- 被存下来、以后要识别的标记（例如 ADR-154 里的注入标记、补送标题）：写时用会话的语言，读时认**所有语言**的写法和旧写法（和 D-43 的改名规则一样）。

### 7. 生成的文档

- 命令参考：`scripts/gen-cli-docs.mjs` 按语言生成 `docs/guide/<语言>/commands.md`——帮助块用那个语言运行命令得到（io 的 `DAISY_LANG`），页面自己的话和指向另一种语言那一页的链接（`[English](../en/commands.md)` / `[中文](../zh-CN/commands.md)`，P6-21 的约定）是语言包的 `docs.cli.*`。`node scripts/gen-cli-docs.mjs --lang en` 现在就能写英文页；提交的语言是 `CLI_DOC_LANGS`，现在只有 `zh-CN`，`docs/guide/en/commands.md` 仍是 P6-21 写的占位页（这时生成的英文页里，表格命令的帮助大部分还是中文）。**P6-23 的做法**：把 `cli/table.ts`、`contracts/src/api/cli.ts`（`cliHelp`、字段说明）和定义表的文字都移进语言包、`daisy --lang en <每条命令> --help` 不再出中文之后，① 把 `"en"` 加进 `CLI_DOC_LANGS`；② 运行 `node scripts/gen-cli-docs.mjs`，生成的页替换占位页；③ `tests/cli-docs.test.ts` 的 `--check` 随之覆盖两种语言；④ `tests/guide-pages.test.ts` 对 `commands.md` 现在只查存在和互链，生成页两边结构相同后可以去掉 `GENERATED` 的豁免；⑤ 在 i18n 测试里加一条：英文页代码块外没有中文。
- 接口文档：`scripts/gen-api-docs.ts` 已按语言取接口的一句话说明和描述（`localizedRoutes`：语言包里的 `api.route.<id>.summary` / `.description`，没有就用定义表自己的）。决定：**`docs/api` 最终只出英文**（它是给开发者的参考，`openapi.json` 也只能有一种语言）；在 P6-23 把定义表和 `docs.ts` 的文字移进语言包之前仍生成中文，P6-23 完成时把 `API_DOC_LANG` 改成 `en`。中文用户指南里链到它的地方照旧。
- 定义表的文字（`summary`、`description`、字段的 `.describe()`、`exempt` 和 `notLetIn` 的理由）最终都移到 `api.route.<id>.*` 键里，定义里的 `summary` 字段届时删除；P6-23 改 `docs.ts`、`cliHelp` 让它们接受一个翻译器。

### 8. 测试的默认语言

测试运行时（`scripts/ci-test.mjs` 和 `npm test` 预加载 `tests/test-env.mjs`）没设 `DAISY_LANG` 就设成 `zh-CN`：现有的几千条断言写的是中文，转换一块时它们照旧成立，与运行机器的系统语言无关（本地关口用 `LANG=en_US.UTF-8`）。转换后的部分**两种语言都要测**：测试自己设 `--lang`、io 的 `DAISY_LANG`、`Accept-Language` 或 `setUiPack`。

### 9. 现状盘点（`node --import tsx scripts/i18n-scan.ts`，本分支）

去掉注释后仍带中文的行（转换前约 5,400 行；本次样板转换约 200 行）：

| 区域 | 文件 | 行 | 内容 |
| --- | ---: | ---: | --- |
| 服务端（`packages/daisy/src`，不含 `cli/`、`prompts/`） | 136 | 1,896 | 接口错误的 `message`、审批卡片和阶段文字、更新与重启、harness 适配、A2A 服务端、调度；其中一部分是给模型的（第 10 节归 P6-24） |
| 网页（`packages/ui`、`apps/app`） | 46 | 1,385 | 全部界面文字 |
| 接口定义表（`packages/contracts/src/api`） | 32 | 717 | 每条接口的说明、字段说明、免命令理由，喂给 `--help` 和 `docs/api`；`docs.ts` 的文档正文 |
| contracts 其余 | 23 | 413 | 指南与常驻提示词、工具说明、标题生成提示（给模型）；命令清单、模型选项、通知种类（给界面） |
| 命令行（`packages/daisy/src/cli`） | 8 | 324 | 其余本地命令（start / stop / open / update / doctor / uninstall / autostart / watch）、表格命令的帮助与输出 |
| 提示词层（`packages/daisy/src/prompts`） | 2 | 150 | 给模型 |
| `packages/a2a-client` | 5 | 134 | 名片校验、网络错误（Daisy 和 daisy-mcp 共用） |
| `packages/a2a-mcp`（daisy-mcp 命令） | 7 | 130 | 帮助、工具说明、错误 |
| `packages/relay`（中转程序） | 3 | 35 | 帮助、配置错误 |
| `packages/client` | 1 | 13 | 客户端自己的错误（超时、连接断开） |
| **合计** | **263** | **5,197** | |

文件级的清单就是 `tests/i18n-pending.json`（`--files` 按行数列出）。

本次转换好的样板（两种语言都有测试，`tests/i18n.test.ts` 20 条）：

- `daisy --help` 的总览（含每条本地命令的一句话、单命令组的接口说明）、组帮助、`--lang`；`cli/main.ts`、`cli/errors.ts`、`cli/daisy.ts` 全部（连接、超时、凭据、PIN 提示、每个错误码的“怎么办”）；
- `daisy status` 全部（运行中 / 没运行、每一行、中转、更新、自启、PIN），`status --help`；
- 本机接口：参数校验失败和内部错误的回答、语言设置的两条接口和 `language_unknown`、网页语言包接口、`/api/health` 的 `language`；
- 网页：设置页的标题、说明、嵌入说明，新的“显示语言”卡片（跟随系统 / English / 简体中文，选完整页立即切换），“正在连接…”；
- 命令参考页的正文（`docs.cli.*`）。

### 10. 分工：三个包各管一组文件，互不交叉

**原则：一个源文件只归一个包**（混着给人看和给模型看的文字的文件，整个文件归一个包，那个包两类都转）；**每个包只往自己的区域文件里加键**（`common.json` 除外，加之前先看有没有现成的）；`i18n-keys.gen.ts`、`tests/i18n-pending.json` 都是一行一项、按字母排序，各包改的是不同的行，合并冲突时重新生成即可（`npm run gen:i18n`、`node --import tsx scripts/i18n-scan.ts --write` 后核对只减不增）。

| 包 | 源文件 | 区域文件（键的前缀） | 生成物 |
| --- | --- | --- | --- |
| **P6-22 网页** | `packages/ui/src/**`、`apps/app/**`；contracts 里给界面的 `commands.ts`、`agent-features.ts`、`agent-label.ts`、`model-options.ts`、`notifications.ts`、`context-usage.ts`、`profile.ts`、`branding.ts` | `ui.json`、`ui-<分区>.json`（例如 `ui-chat`、`ui-sharing`、`ui-settings`） | — |
| **P6-23 命令行与服务端** | `packages/daisy/src/cli/**`、`packages/daisy/bin/**`、`packages/contracts/src/api/**`（定义表、`docs.ts`、`cli.ts`）、contracts 的 `acp-harnesses.ts`、`start-files.ts`、`env.ts`、`a2a.ts`、`approvals.ts`、`items.ts`、`message.ts`、`agent-capabilities.ts`；`packages/daisy/src/**` 中不归 P6-24 的全部；`packages/client`、`packages/relay`、`packages/a2a-mcp`、`packages/a2a-client`；`scripts/gen-cli-docs.mjs`、`scripts/gen-api-docs.ts` | `cli.json`、`cli-<分区>.json`；`api.json`（`api.route.*`、`api.error.*`）；`server.json`、`server-<分区>.json`；`relay.json`；`mcp.json`；`a2a.json`；`client.json`；`docs.json` | `docs/api`（完成时切到英文）、`docs/guide/en/commands.md`（完成时加入 `CLI_DOC_LANGS`） |
| **P6-24 给模型的提示词** | `packages/daisy/src/prompts/**`、`packages/daisy/src/a2a/ask-act-prompt.ts`、`packages/daisy/src/resident/prompt.ts`、`packages/daisy/src/tools/daisy-tools.ts`、`packages/daisy/src/turns/transcript-carry.ts`、`packages/daisy/src/schedule/scheduler.ts`；contracts 的 `guide.ts`、`resident-prompt.ts`、`prompt.ts`、`native-tools.ts`、`ask-sidecar.ts`、`title.ts`、`scheduler.ts` | `prompt.json`、`prompt-<分区>.json`；`locales/<语言>/prompts/*.md` | 每种语言一份钉住的提示词样本 |

P6-23 是最大的一块（约 3,300 行）。如果要再并行，可以按上表拆成 **P6-23a**（命令行、接口定义表、文档生成：`cli/**`、`bin/**`、`contracts/src/api/**`、两个生成脚本、`cli*` / `api*` / `docs` 区域）和 **P6-23b**（服务端其余、`client`、`relay`、`a2a-mcp`、`a2a-client`：`server*`、`relay`、`mcp`、`a2a`、`client` 区域），两者的文件和区域互不重叠。

单独发布的 `relay` 和 `daisy-mcp`（构建成一个 `.mjs`）：它们的语言包同样写在 `packages/contracts/locales/<语言>/relay.json`、`mcp.json`，由各自的 `build.mjs` 在构建时把所有语言的这两个区域打进产物（不读磁盘，不支持数据目录里另放的语言）；语言按 `--lang` > `DAISY_LANG` > 系统语言 > 英文（它们没有主人设置）。

### 11. 给后面三个包的约定

1. **源代码只写键**。新加文字：在 `en` 和 `zh-CN` 的同名区域文件里各加一项（两边同一个键、同样的 `{参数}`），`npm run gen:i18n`，代码里 `t("区域.…", { … })`。键名按“区域.对象.情况”起（`cli.status.relay.connected`），说明它是什么，不写文字本身。
2. **哪里取 `t`**：命令行 `import { t } from "packages/daisy/src/cli/lang.ts"`；服务端回答里的错误抛 `LocalizedError`（`app/language.ts`），需要按请求说话的地方用 `requestT(req, dataDir)`；网页组件 `useT()`，组件外 `t`（`packages/ui/src/i18n.ts`）；给模型的文字按**会话的语言**取（P6-24 加 `sessionT(session)` / `promptText(名字, 会话语言)`）。不要在模块顶层把翻译好的文字存进常量（语言在运行时才定）：存键，用时再翻。
3. **整句进语言包，不拼句子**：语序在两种语言里不同。可选的一段做成另一个键，作为参数传进去（`cli.status.autostart.systemdOn` 的 `{linger}`）。列表的分隔符也是键（`cli.list.separator`：中文“；”，英文“; ”）。
4. **标签对齐**按显示宽度算（中文两列），列宽按当前语言最长的标签算（`status` 的做法）。
5. **日期时间**用 `toLocaleString(t.lang)`；数字原样。
6. **存下来的文字**：能存结构（键和参数）就不存渲染好的句子，显示时再翻；已经存下的历史照原样显示。识别存量数据用的标记写时用一种语言，读时认所有语言和旧写法（第 6 节）。
7. **日志**（`log.info` / `log.error` 写进日志文件的行）不进语言包，直接写英文：日志是给排查问题的人（包括维护者）看的，一种固定的语言便于搜索和报告问题。主人在终端或网页上看到的文字一律走语言包。转换时把日志里的中文改成英文。
8. **测试**：保持现有中文断言不动（测试默认 `zh-CN`）；每个转换的块加英文的断言（`--lang en`、`DAISY_LANG: "en"`、`Accept-Language: en`、`setUiPack("en", …)`）。不要断言整段英文措辞到让以后改措辞很痛苦的程度，抓关键词即可。
9. **每转换一个文件**：`node --import tsx scripts/i18n-scan.ts --write` 更新名单，核对 diff 只有数字变小或条目消失。
10. **文档**：中文用户指南（`docs/guide/zh-CN`）和英文（`docs/guide/en`，P6-21）各自维护；生成的部分按第 7 节。

## 补记 P6-24：给模型的提示词按会话的语言（2026-11-18，分支 `p6-24`）

按第 6 节实施，补几处具体做法：

- **会话的语言**：`Session.lang`（会话记录的 JSON，不需要改表结构）。新建会话时取主人当时的语言（`prompts/lang.ts` 的 `newSessionLang`：主人设置 > 系统语言 > 英文，只在随 Daisy 发布的语言里选），之后不变；分支（/fork）沿用原会话的记录，只问支线沿用主线的，常驻 agent 的来访会话取创建时主人的语言。**没有这个字段的会话（P6-24 之前建的）按中文**（`LEGACY_PROMPT_LANG`）：它们的提示词本来就是中文，进行中的对话不换语言。
- **取文字**：`contracts/src/prompt-i18n.ts`（浏览器也能用）：`sessionT(session)` / `promptT(lang)` 给出带 `long(名字)` 的翻译器，`long` 读 `locales/<语言>/prompts/<名字>.md`（去掉文件末尾的一个换行）。语言包由 Node 一侧注册（`i18n-node.ts` 被载入时；`prompts/lang.ts` 等模块顺带载入），契约包本身不读磁盘，网页构建不受影响。给模型的文字只用随 Daisy 发布的语言包：数据目录里另放的语言包只给人看的文字用，那种语言的会话拿到英文提示词。
- **区域文件**：`prompt-guide`（分层提示词：层标记、组织层、会话说明层的固定段、来源与锁定理由）、`prompt-resident`（任务常驻 Agent 的各段）、`prompt-native`（缺少的工具、工具的人话名）、`prompt-tools`、`prompt-schedule`（Daisy 的工具说明与结果、唤醒 / 补送 / 暂停的标题）、`prompt-a2a`、`prompt-ask`、`prompt-title`、`prompt-source`、`prompt-carry`、`prompt-admin`（提示词设置页和管理页的回答、错误）；长文字 `prompts/*.md`（安全规则、常驻 Agent 的默认段、标题生成、只问的旁路提问等）。契约里原来给网页用的两张中文表（层名 `GUIDE_LAYER_TITLE`、状态 `GUIDE_STATE_TEXT`）删除，网页用自己的 `ui-prompts.layer.*` / `ui-prompts.guideState.*`（P6-22）。英文用词与网页一致（organisation、startup core）。
- **谁的语言**：模型读的（系统层、工具说明与结果、唤醒标题、Runner 每轮附加的行、只问支线、标题生成）= 会话的语言；回答主人或管理员请求的（提示词设置页、管理页、它们的错误）= 请求的语言（`requestT` / `LocalizedError`）；没有请求的后台写入（节点上报、队列）= 主人当时的语言；日志 = 英文。
- **标记**：层标记（`【会话说明】` / `[Session notes]` 等）写时用会话的语言，检查主人写的文字和 `defang` 时认所有语言的写法（`allPromptMarkers`，`promptForms(键)`）。中文的 `defang` 结果逐字不变；别的语言的标记行换成全角括号或在前面加 `> `。补送标题、只问的回答标记、外来任务的分隔行等同理：写用会话的语言，读认所有语言和旧写法（旧的中文写法放在正则里）。注入标记 `Harbor 注入` 在每种语言里都照原样写（组织启动核心按这几个字判断）。
- **长期保留的中文**：新增 `tests/i18n-kept.json`（文件 → 行数和理由），这些行不算“待转换”；`scripts/i18n-scan.ts --write` 写名单时扣掉它们，`tests/i18n.test.ts` 检查每条都有理由、行数不超过实际。目前只有 `guide.ts` 的注入标记两行（写的 `Harbor 注入` 和读时也认的 `Daisy 注入`）以及 `defang` 的两行替换（中文层标记的原样替换；把任何语言带括号的标记换成全角括号）。
- **组织启动核心**：它是组织写的文字（中文），识别它的 `## 规则`、`红线` 用正则，不进语言包；Daisy 给它的小节起的名字（“开头”“结尾”）按会话的语言。P6-17 的 `orgChangeVia`（插件给的“怎么改”的说法）两种语言都接：拉丁字母和汉字相邻时补一个空格，只在模板里挨着汉字的一边补，所以中文逐字不变、英文不受影响。
- **钉住的样本**：`tests/fixtures/prompt-off-chain-base.json`（中文）逐字节不变；新 `tests/fixtures/prompt-off-chain-base-en.json` 是同一条链在英文会话下的结果（`DAISY_WRITE_SNAPSHOT_EN` 写出、人工核对过），在 macOS 上写，所以没有强制只读的两条（有 Bubblewrap 的机器只比较中文的那两条）。`prompt-legacy-74a2714.json` 不动。
- **没转的**：`contracts/src/prompt.ts` 的 `buildPrompt`（任务数据、页面数据、终端结果的包裹语）本来就是英文、中英文会话相同，保持原样（改成按语言会改变中文会话收到的文字）；`turns/worker.ts` 的独立分支行、`turns/sidecar.ts` 的 `SIDECAR_TOOL_REFUSAL`、`contracts/src/a2a.ts` 的 `WEAK_READ_ONLY_NOTE`、`contracts/src/items.ts` 的 `SYSTEM_SENDER` 在 P6-23 的文件里，留给它（键可以复用 `prompt-admin` 里的独立分支那一行）。

## 理由

- 语言包而不是代码里的 `{ zh, en }` 对：翻译者和以后的社区语言不用碰 TypeScript；加语言不改代码；两种语言的完整性和参数一致性可以机械地检查。
- 平铺的 JSON、键以区域开头：好比对、好合并（按字母排序，一行一项），读一个键就知道该去哪个文件找。
- 类型从英文包生成：错键、漏参数在类型检查时就报，而不是在主人面前显示一个键名。
- 网页向服务端取语言包：语言是数据，不是构建的一部分；附加语言包对网页同样有效。
- 设置放 `config.json`：命令行不运行 Daisy 也读得到；不需要数据库迁移。

## 放弃的做法

- **键 → `{ "zh-CN": …, en: … }` 的 TypeScript 目录**（最初的设想）：文字仍在代码里，加语言要改代码，被主人的要求否定。
- **i18next 一类的库**：要的功能很少（插值、回退、按区域加载），自己写不到 300 行，没有依赖，浏览器和 Node 同一份代码。
- **把语言包打进网页构建**：语言越多包越大，附加语言包对网页无效。
- **运行中的会话随设置立刻换语言**：见第 6 节。
- **语言设置要 PIN**：它不属于“放别人进来”，也不决定运行什么代码。
- **都对不上时默认中文**：公开发布时英文对不知道是谁的读者更稳妥；中文系统的人自动得到中文。

## 后果

- 新增 `packages/contracts/locales/`（随 npm 包发布，`pack-daisy.ts` 的 `PACKED_DIRS`），`npm run gen:i18n`，`tests/i18n-pending.json`，`tests/test-env.mjs`。
- 新接口 3 条：`settings.languageShow`、`settings.languageSet`（`daisy language show|set`）、`system.locales`；`/api/health` 多 `language`；参数校验失败的回答多了 `code: "invalid_input"`，内部错误多了 `code: "internal"`。
- 命令行多一个全局选项 `--lang`，环境变量 `DAISY_LANG`；`daisy status` 的标签列宽随语言。
- 网页的 `<html lang>` 跟着语言包走（原来固定 `zh-CN`；宿主外观里写了 `lang` 的仍以宿主为准）。
- 在 P6-22 / 23 / 24 完成之前，选英文的主人会看到中英混排：转换过的地方是英文，其余仍是中文。

## 留给主人决定

1. 都对不上时默认英文（推荐；系统是中文的自动是中文）。
2. 显示语言不要 PIN（推荐，理由见第 2 节）。
3. 已经在进行的会话保持原来的语言，新语言只用于之后的新会话（推荐，第 6 节）。
4. `docs/api` 最终只出英文（推荐，第 7 节）。
5. 日志行固定写英文，不随显示语言（推荐，第 11 节约定 7）。
6. 数据目录里另放的语言包只能增加语言、不能改写随 Daisy 发布的语言（推荐，第 1 节）。

## 补记：P6-22 网页的转换（2026-11-18）

- **范围**：`packages/ui/src` 全部、`apps/app`、contracts 里给界面的八个文件（第 10 节）。键在 `ui.json` 和 `ui-<分区>.json`：`ui-app`、`ui-chat`、`ui-copy`、`ui-commands`、`ui-inbox`、`ui-present`、`ui-trace`、`ui-queue`、`ui-sharing`、`ui-access`、`ui-settings`、`ui-identities`、`ui-devices`、`ui-login`、`ui-prompts`，contracts 的在 `ui-contracts`。网页取 `areas=ui` 时这些分区一起取到。
- **contracts 里的共享函数**（`unsupportedMessage`、`settingsError`、`autoCompactError`、`agentLabel`、`notificationKinds`、`glmModelWarning` …）多了最后一个可选参数 `t: Translate`。网页总是传自己的 `t`；服务端和命令行应传请求的或命令的翻译器（P6-23）。没传时用 `defaultTranslate()`（`contracts/src/i18n-default.ts`，浏览器安全）：Node 进程在载入 `i18n-node.ts` 时登记一个默认翻译器——随 Daisy 发布的语言包、进程自己的语言（`DAISY_LANG`、`LC_ALL`、`LC_MESSAGES`、`LANG`，都没有用英文）；没有登记（浏览器）时键原样返回。这样服务端还没转换的调用处不用改也照旧说话（测试里是中文）。只在 contracts 里给界面的函数里用，界面组件不用它。
- 只给界面用的 `commandList(agent, discovered, features, t)`、`commonCommands(t)` 的 `t` 是必填。去掉了存翻译好文字的常量（`FEATURE_TITLES`、`EFFORT_WORDS`、`DELETED_AGENT_TITLE`、`NOTIFICATION_KIND_INFO`），换成按语言取的函数（`featureTitle`、`effortWord`、`deletedAgentTitle`、`notificationKindInfo`）。zod 的校验文字用 `{ error: () => defaultTranslate()(…) }`。
- **识别存量数据的标记**：会话的占位标题（`新对话`、`Untitled` …）和“已删除的 AI”是存下来的数据，`ui-contracts.agent.genericTitles` / `deletedTitles` 两个包里写的是同一份所有语言的写法（`|` 分隔），所以任何语言的界面都认得任何语言写下的占位标题。
- **宿主文案（`DaisyCopy`）**：默认值来自 `ui-copy` 区域，`useDaisyCopy()` 随语言切换重新取；宿主给的覆盖照旧优先。`defaultDaisyCopy` / `toolAuthorizationCopy` 仍导出（读的时候是当前语言）。
- 网页根组件（`apps/app/App.tsx`）调用 `useT()`，切换语言时整页重新渲染，不用刷新。

## 补记：P6-23a 的实施（命令行、接口定义表、文档生成）

- 日期：2026-11-18；分支 `p6-23a`（基于 `p6-gate` 544776fb，合入 26f3a109）。
- **定义表里不再有文字。** 每条接口的文字按约定的键放在 `api.json`：`api.route.<id>.summary`（必有）、`.description`、`.exempt`（`cli: exempt()` 的理由；几条接口共用一个理由时 `exempt("<键>")`，例如 `api.exempt.autostart`）、`.notLetIn`（`notLetIn: true` 的理由）、`.auditWhy`、`.removal`。`RouteSpec` 去掉了 `summary`、`description`、`auditWhy` 和 `removal.why`；`notLetIn` 变成 `true`，“理由至少 6 个字”的检查从 `letInProblems` 移到测试（`tests/i18n-routes.test.ts`：每条接口的键两种语言都有、没有多余的键）。分组标题是 `api.group.<id>`，“放别人进来”的各行和重置 PIN 吊销的各项是 `api.letIn.<种类>`、`api.revocation.<种类>`。
- **字段说明写键。** `.describe("api.route.<id>.field.<名字>")`（共用的 schema 用 `api.field.<文件>.<名字>`）；显示时翻译（`describedText`、`fieldText`，JSON Schema 里嵌套的 `description` 由 `localizeSchema` 翻译）。接口的回答名字（`json("api.output.…")`）和 schema 自己的校验消息（`.refine(…, "api.validation.…")`）同样写键；服务端回答 `invalid_input` 的 `details` 时翻译是键的消息（`app/http.ts` 一行）。
- **说明里引用的限值不抄进语言包。** `api/text-params.ts` 的 `API_TEXT_PARAMS`（配对码几分钟、PIN 长度、事件每页条数……从 `limits.ts` 取）在显示时填进 `{名字}`，改了限值文档和帮助跟着变。
- **翻译器从外面给。** `cliHelp(c, t)`、`apiMarkdown({ …, t })`、`apiOpenApi({ …, t })`、`limitsText(limits, t)`；`FieldInfo.limits` 变成结构（长度、取值、项数、默认），显示时按语言写。`gen-api-docs` 的 `API_DOC_LANG` 改为 `en`：`docs/api` 只出英文（第 7 节的决定）。`gen-cli-docs` 的 `CLI_DOC_LANGS` 加 `en`，`docs/guide/en/commands.md` 由它生成（替换 P6-21 的占位页），`tests/guide-pages.test.ts` 去掉了 commands.md 的豁免，并检查英文页除了指回中文页的链接没有中文。
- **命令行全部本地命令和生成命令的运行器**（`cli/local/*`、`cli/table.ts`、`cli/io.ts`、`cli/routes.ts`、`bin/daisy.mjs`）走 `cli.*` 键。`bin/daisy.mjs` 的“Node 版本太旧”在加载任何 Daisy 代码之前，直接读 `locales/<语言>/cli.json`（`--lang`、`DAISY_LANG`、POSIX 区域变量，zh* 为中文，否则英文）。中文输出与转换前逐字相同（`docs/guide/zh-CN/commands.md` 重新生成后无差异）。
- **留下的**（不在本包改完，交给别的包）：`contracts/src/api/invoke.ts` 的 `INVOKE_DECISION_LABELS`、`CROSS_TALK_NOTE` 和 `residents.ts` 的 `RESIDENT_LAYER_TITLES` 共 10 行仍在 `tests/i18n-pending.json`——它们由服务端（`invoke/invoke-access.ts`、`a2a/public-agents.ts`，P6-23b；`resident/prompt.ts`，P6-24）放进接口的回答或存下来，用哪种语言要随那边的改动一起定（按请求的语言或存结构），单独换成键会让回答里出现键名。`pinRuleError` 现在回答键（`api.pin.rule.*`，参数 `PIN_RULE_PARAMS`），`access/pin.ts` 暂按 Daisy 进程的语言说出来，P6-23b 换成按请求语言的 `LocalizedError` 即可。

## 补记：P6-23b 的实施（服务端其余、client、relay、daisy-mcp、a2a-client、contracts 共享文字）

- 日期：2026-11-18；分支 `p6-23b`（基于 `p6-gate` 544776fb，合入 31d2346e 与 `p6-23a`）。`tests/i18n-pending.json` 到此为空。
- **谁的语言**：回答请求的错误 = 请求的 `Accept-Language`（`LocalizedError`，在 `app/errors.ts`；`Msg` / `msg()` 让检查函数返回“键 + 参数”而不是句子，参数里可以再嵌一个消息，`sayMsg` 先说里层）；共享包抛的错误只要带 `localized: true`、`key`、`params`（a2a-client 的 `KeyedError`、`ContactError`、`PinError`、`InvokeError.toHttp()`）同样按请求语言说。请求以外的话（卡片、通知、状态、启动问题）= 主人的语言 `ownerT()`（`platform/language.ts`：设置 > 系统 > 英文，一秒缓存）；写进某个会话、给主人看的文字 = `inSessionT(session)`（`Session.lang`，没有就主人的语言）；给模型读的仍是 P6-24 的 `sessionT(s)`（没有语言的旧会话按中文）。Runner 和服务在同一个进程（D-02），P6-17 的 `turnT()` 改为会话语言 > 主人设置。
- **命令行进程**：`setCliLanguage` 同时设 `setProcessLanguage`（`ownerT` 跟着 `--lang`）、contracts 的默认翻译器和 A2A 客户端的翻译器，所以本地命令用到的服务端模块（自启、更新、doctor 的检查）跟命令行同一种语言。
- **单独发布的两个程序**：`relay`、`daisy-mcp` 的 `build.mjs` 用 esbuild 插件把 `i18n-node.ts` 换成内联的语言包（relay：`relay`；daisy-mcp：`mcp` + `a2a`），运行时不读磁盘；语言 `--lang` > `DAISY_LANG` > 系统 > 英文（`contracts/src/i18n-process.ts`，与 Daisy 的系统语言判断同序，因为打包产物不能引用 Daisy 的代码）。
- **packages/client**（浏览器）：错误带 `code` + `key`，文字由 `setClientTranslator()` 给（网页设成自己的 `t`），没设时用参照包 `en/client.json`，不会显示键名。
- **contracts 的共享文字**：ACP harness 的说明 / 安装 / 登录提示等内置定义里存键，只通过 `harnessText(h, 字段, t)` 读（主人自己写的 harness 文件里的文字原样）；网页自己显示的放 `common-contracts.json`（网页取 `ui`、`common` 区域），只有服务端和命令行显示的放 `server-contracts.json`。
- **存下来的文字**：有现成结构的就存键（`invoke_requests.closed_why`、唤醒条目的 `tail` / `tailKind`、文件夹与 shell 结果的 `errorKey`），读的时候按读者的语言说；其余在写入时按主人 / 会话的语言写一次。旧数据照原样显示；识别旧文字的正则保留中文写法（native-append 的 `wakeBase`、queue-merge、harness 的停止词、`isSystemSender`），正则不计入扫描。
- **日志**：一律英文，脱敏标记从 `[已隐去]` 改为 `[redacted]`；迁移第 2–15 步的说明改英文。schema 第 1 步的 SQL 注释受 `V1_SHA256` 保护，记入 `tests/i18n-kept.json`。
- **新错误码**约 130 个（原来没有 `code` 的错误补上，原有的不变），尚未写进接口定义的 `errors` 清单。

## 补记：P6-25 收尾（网页接上客户端翻译器、错误码清单、daisy-mcp 默认翻译器、扫描器、浏览器脚本、文档、英文冒烟）

- 日期：2026-11-18；分支 `p6-25`（基于 `p6-gate` e270fb53）。`tests/i18n-pending.json` 保持为空。
- **网页**：`setUiPack` 同时调用 `setClientTranslator`，`UI_AREAS` 加 `client`，客户端自己的错误（超时、断线）跟网页同一种语言；终端页的地址带 `lang`（`terminal-url.ts`）。网页按服务端文字识别的几处对照了最终的英文：`queueRowRead` 认 `/已读取|read by the AI/i`；唤醒标记的 ◷ 认服务端真实的标题（「【Daisy 定时器到点】」/“[Daisy timer due]”/“[Daisy scheduled task fired]”，原来的 `/^定时/` 对真实标题从来没匹配上）。排队理由、自动模式行（旧数据才有的 `place`）的正则核对后无需改。
- **服务端两处同类问题**：`commands.ts` 用中文正则判断“只是版本太旧”（旧 Runner 仍可把主人的纯文字当立即追加），英文主人下判断失效——改为 `versionOnlyBlock(why)`（按主人语言的文字比较，中文写法仍认）；`queue-merge.ts` 的 `restoreCarried` 只按中文去掉合并尾巴——改为先按记下的 `tail` / `tailKind` 去掉（任何语言），旧数据按中文正则。
- **错误码**：P6-23b 新加的错误码里，能经接口定义表里的路由回答的 92 个写进了 72 条路由的 `errors`（Runner 一侧的进程内调用不在定义表里，不列）；`/api/sessions/:id…` 下的路由都列 `session_not_found`、`not_session_owner`。`docs/api` 重新生成。新测试：每条路由列出的码都确实出现在回答它的代码里（防笔误）。
- **daisy-mcp**：打包产物里没有 `i18n-node.ts`，所以 contracts 的校验文字（A2A 片段、消息）原来会显示键名。`main.ts` 在没有登记默认翻译器时把本命令的语言（`pt`）登记为默认；`inline-packs.mjs`（从 `build.mjs` 拆出，测试也用）把 `server-contracts.a2a.*`、`server-contracts.message.*` 两组键一起打进产物。
- **扫描器**：裸 `>` 之后的 `/` 不再当正则开头（JSX 文字 `<Text>/compact …`），`=>` 之后仍是；重扫没有新的中文行。
- **浏览器脚本**：`scripts/e2e*.cjs` 按中文按钮名找元素，后台改为明确用中文启动（`e2eEnv()`：`DAISY_LANG=zh-CN`），与机器的语言无关；`context-harness.tsx` 像宿主一样先 `loadUiLanguage`。
- **文档**：README、指南不再说“暂时只有中文”；指南安装页加“语言”一节（中英同结构）；英文指南引用英文界面文字，`<!-- ui-zh -->` 全部去掉；CONTRIBUTING 说明语言包、改翻译、加一种语言。
- **Linux CI（run 44289151230）的三处**：`examples.test.ts` 的 daisy-mcp 用例——MCP 客户端只传默认环境变量（没有 `LANG` / `DAISY_LANG`），daisy-mcp 按设计用系统语言（Linux 上是英文、这台 Mac 的首选语言是中文），测试改为明确给语言（一个配置中文、一个英文）；`prompt-off-chain` 的中文钉住样本里两条只读条目补上 P5-04 当时没法在 macOS 上量的 A2A 工具（与普通条目同样的工具、同样的位置，`toolsFor` 与工作区模式无关）；英文会话那条找“发送内容审计”时两种语言的名字都认（原来只认中文，英文下得到 `undefined: NaN`）。

## 补记：P6-28 英文外部验收的修正（默认名字跟着读者的语言、Daisy 没运行时选语言、复数、文档）

- 日期：2026-11-18；分支 `p6-28`（基于 `p6-gate` b6872884）。`tests/i18n-pending.json` 保持为空。
- **Daisy 自己起的名字跟着读者的语言**（第 11 节约定 6 的落实）。本机节点（“本机” / “This machine”）、主目录工作区（“用户主目录” / “Home folder”）、每家 harness 的主机登录身份档（“<harness> · 主机登录” / “<harness> · host login”）原来在第一次启动时按主人当时的语言写死在数据库里，之后换语言也不变。现在：新写的行**不存名字**（空字符串；主人起的名字至少一个字，所以空就是“用默认名”），显示时按读者的语言从语言包取（`common-contracts.defaultName.*`，网页也取得到）。
  - **旧数据**：读的时候把“等于任何一种语言的默认名”的名字当作默认名（`platform/default-names.ts` 的 `isDefaultName`，语言是当时存在的全部语言包，含数据目录里另放的）。**不加迁移步骤、不改旧行**：这样旧版本 Daisy 照样读得懂，第三种语言（数据目录里的语言包）写下的默认名也认得；代价是主人恰好把名字起成某种语言的默认名时，也按默认名显示（显示的字在那种语言里一样）。改默认名的措辞时，旧写法必须仍被认出：`tests/outsider-en.test.ts` 钉住了至今写过的六种写法。
  - **接口**：`/api/catalog` 的节点、工作区、身份档，身份档的保存回答，会话快照的 `node`，选目录的结果，提示词管理页的节点，都按**请求的语言**给出名字，默认名带 `labelDefault: true`（`NodeInfo`、`Workspace`、`Profile`、`SessionNodePresence` 加这个可选字段）。网页用 `shownName(kind, x, t)`（contracts 的 `default-names.ts`）显示：带标记的按网页当前语言重说一遍，所以切换语言后不用重新取数据。交给 Runner 的一轮（身份档、工作区的名字会写进额度条目）按**会话的语言**（`inSessionT`）。命令行的表格命令打印服务端的回答，跟着 `Accept-Language`；`daisy doctor` / `status` 不显示这些名字。给模型的提示词里没有这些名字。
- **Daisy 没运行时也能选语言。** `daisy language set|show` 是表格命令，原来没有运行时文件就报“没在运行”。现在找不到运行中的 Daisy（没有运行时文件，或进程已不在）时，命令自己做：`set` 用和接口同一个检查（`platform/language.ts` 的 `chooseLanguage`：只接受有语言包的语言，存语言包自己的写法；`null` 回到跟随系统），直接写数据目录的 `config.json`（目录不存在就建，0700），`show` 从那里读；标准错误上多一句“Daisy 没在运行：设置已直接写进 …，启动时生效”。显示的 `system` 是命令行这个进程看到的系统语言。运行中时照旧走接口。指南安装页“语言”一节写明了（中英）。
- **复数**（第 1 节“没有复数”改为有一种）：插值支持 ICU 的复数选择 `{count, plural, one {# step} other {# steps}}`——按语言的复数规则（`Intl.PluralRules`；`=0` 这样的精确值优先）选一支，`#` 是那个数，支里可以再有 `{名字}`。`paramsOf` 把选择用的数也算作参数，所以两种语言的参数仍然相同；中文没有复数变化，照旧写 `{count} 个步骤`，不受影响。取的是回退包（英文）的文字时用回退包语言的规则。不合格式或没给数时原样保留，绝不抛错。网页的宿主文案（`fillCopy`）同样认。英文包里把会出现 1 的计数（步数、次数、秒、分钟、文件、轮……约 100 处）都改成了复数选择；测试检查英文包里不再有“计数参数 + 复数名词”的写法。只用在限值上、永远大于 1 的（`{max}` 等）不改。
- **插件的通知种类可以按语言给名字。** `NotificationKindDecl` 的 `label`、`hint` 现在是 `PluginText`：一个字符串（各语言原样显示，和以前一样），或按语言标签给的一组（`{ en: "Greeting", "zh-CN": "问候" }`）。读者看到自己语言的（就近匹配），没有用英文的，再没有用第一句；`GET /api/notification-preferences` 的 `kinds` 按请求语言给（核心的种类也是）。每一句同样的长度限制，键必须是语言标签。`examples/plugin-hello` 真的声明了一个这样的种类，`tests/examples.test.ts` 检查两种语言。
- **给人看的帮助里不提 ADR 编号**：接口的说明、免命令理由、不放人进来的理由（进 `--help`、命令参考和 `docs/api`）、中转的两句、网页一句，去掉“（ADR-xxx）”。`docs.json` 里给开发者看的 `docs/api` 页眉照旧提 ADR-107。
- **文档与脚本**：`CONTRIBUTING.md` 拆成英文 `CONTRIBUTING.md` 和中文 `CONTRIBUTING.zh-CN.md`（互相链接，导出清单两个都发布；中文 README、中文安装页、AGENTS.md 链到中文那份）；英文例子 README 里的中文界面文字换成英文界面文字，`<!-- ui-zh -->` 去掉；`pack-daisy`、`local-daisy`、`e2e-open`、`e2e` 的输出和错误改英文（脚本是开发者工具，和日志一样用英文；浏览器脚本里按中文界面找按钮的选择器不变）。
