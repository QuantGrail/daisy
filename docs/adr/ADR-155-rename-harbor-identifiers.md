# ADR-155：代码里的标识符和不落盘的名字从 Harbor 改成 Daisy；旧名字只留在兼容需要的地方，有清单和守卫测试（P6-05）

- 日期：2026-11-18
- 状态：**已实施（分支 `p6-05`，基于 `p6-gate`；待合入）**
- 来源：维护者的决定（开源整理：改名保持兼容；注入标记照旧写）
- 相关：ADR-152（契约取值）、ADR-153（环境变量、磁盘名）、ADR-154（模型读到的名字、工具名）。注释里的文字是 P6-06，同一编号之后补一节。

## 背景

ADR-152/153/154 改完了会落到数据、磁盘、环境和模型上下文里的名字（都带兼容读取）。剩下的是代码本身：导出的 TS 名字（`HarborClient`、`HarborError`、`HarborApp`、`useHarborTheme`、`HarborSchedule`、`HarborApproval*` …）、内部名字（`HarborToolHost`、`HarborRewindFiles`、`HARBOR_FORK_TITLES`、`isHarborForkTitle`、`harborSteer`、局部变量 `harborTools` …）、CSS 类、`data-*` 属性、testID、文件名、测试夹具的协议行、临时目录前缀、根包名 `agent-harbor`。扫描（Babel 分词，注释单独算）：改之前代码（不含注释）里 1668 处，其中发布的源码（packages / apps / scripts / 根）925 处、测试 617 处。

## 决定

### 1. 改名（不留别名）

`@daisy-ai/client`、`@daisy-ai/ui` 还没有发布过，没有外部使用者，所以**不加已弃用的旧名字别名**，一次改完。

| 类别 | 旧 → 新 |
| --- | --- |
| 客户端包 | `HarborClient` → `DaisyClient`，`HarborClientOptions` → `DaisyClientOptions`，`HarborError` → `DaisyError` |
| 界面包（导出） | `HarborApp`/`HarborAppProps`/`HarborAppRoute`/`HarborAppHostOptions`、`HarborChat*`（`HarborChat`、`…Props`、`…Phase`、`…Status`、`…Activity`、`…LoadError`）、`HarborSessionView`、`HarborNewSession`、`HarborAgentLogin(Props)`、`HarborBrandingProps`、`HarborHostProvider`/`HarborHostAdapters`/`useHarborHost`、`HarborTheme*`（`HarborTheme`、`…Provider`、`…Input`、`ResolvedHarborTheme`、`defaultHarborTheme`、`createHarborTheme`、`resolveHarborTheme`、`harborThemeFromTokens`、`HarborColors`、`HarborRadius`、`HarborStyles`、`HarborBrandTokens`）、`useHarborTheme`/`useHarborTime`/`useHarborCopy`/`useHarborFocusScope`、`HarborCopy`/`defaultHarborCopy`、`HarborPickedFile`、`HarborFileRequest`、`HarborTimeOptions`、`harborTimeFormat`、`harborPhaseTone`/`HarborPhaseTone`/`harborPhaseColor`、`harborSessionPhase`/`harborChatPhase`、`harborColors`、`harborOfflineNote`、`HarborApprovalList`/`HarborApprovalCard` → 同名的 `Daisy…` / `daisy…` |
| 契约包 | `HarborSchedule`、`HarborApproval`（及 `…Kind`、`…Status`、`…Option`、`…Base`、`…RespondSchema`）、`HarborCallApproval`、`HarborPermissionApproval`、`HarborInterception`、`HarborOwnerApproval`、`HARBOR_FORK_TITLES`、`isHarborForkTitle` → `Daisy…`、`DAISY_FORK_TITLES`、`isDaisyForkTitle`（接口文档里的类型名随之改，`docs/api` 重新生成） |
| 服务端 / 执行端内部 | `HarborApprovals`/`harborApprovals`、`HarborToolHost`、`HarborTitle`（`NativeRenames.harbor`/`setHarbor` → `daisy`/`setDaisy`）、`harborOf`、`harborWaits`、`harborSteer`、`harborWake`、`HarborRewindFiles` → `Daisy…`；局部变量 `harborTools` → `daisyTools`（Claude / Codex 适配器）、`toolHost`（worker）；`nativeTimerArgs({ harbor })` → `{ daisyTools }`；`rewindNotice` 里的 `harbor` → `fallback` |
| 界面属性 | `LiveBadge` 的 `harbor` → `scheduler`（与 `schedulerPending` 一致），`offlineEffect` / `daisyOfflineNote` 的参数同 |
| CSS / DOM | `harbor-resizing`、`harbor-resizing-row`、`harbor-resize`、`harbor-composer-resize` → `daisy-…`；`data-harbor-focus(-ring)` → `data-daisy-focus(-ring)`（`dataSet` 的键 `daisyFocus` 由 react-native-web 写成 `data-daisy-focus`，选择器跟着改，焦点框照常） |
| testID | `harbor-approval-*`、`harbor-event`、`harbor-rail`、`harbor-sidebar(-toggle)` → `daisy-…` |
| 文件名 | `tests/rewind-files-harbor.test.ts` → `tests/rewind-files-fallback.test.ts`（`tests/platform-pending.json` 的 Windows 标记跟着改名，条数不变，`--shrink-check` 通过；引用它的 ADR-131/140/152 跟着改） |
| 测试夹具 | 假 CLI 的协议行 `HARBOR_TOOL` → `DAISY_TOOL`，记录 `harbor-tool` / `harbor-tools-list` / `harbor-tools.jsonl` → `daisy-…`，环境变量 `DAISY_FIXTURE_RECORD_HARBOR` → `DAISY_FIXTURE_RECORD_TOOLS`；`harbor-test.png` → `daisy-test.png`（e2e 脚本早已写 `daisy-test.png`，假 Codex 却找 `harbor-test.png`，顺带对上）；临时目录前缀 `harbor-*` → `daisy-*`；测试标题和测试数据里指本产品的 “Harbor” → “Daisy” |
| 脚本 | 私有仓库里的探针脚本（不公开）让模型回的 `HARBOR_OK` / `HARBOR_NATIVE_OK` → `DAISY_OK` / `DAISY_NATIVE_OK` |
| 根包 | `package.json` / `package-lock.json` 的根名 `agent-harbor` → `daisy-monorepo`（lockfile 用 `npm install --package-lock-only --offline` 核对，无其它变化）。私有的导出流程（决定哪些文件进公开仓库）里把根名改成 `daisy-monorepo` 的那一步因此不再改动任何东西，保留（无害） |

做法：Babel 分词找出全部标识符，按一张映射表整词替换（标识符、字符串、模板、正则、JSX 文字，以及注释里**点名这些标识符**的地方；注释的其余文字不动，P6-06 处理），再按类型检查和逐类审阅补手工改动（上面的局部变量、属性、CSS、testID、夹具、测试文字）。顺带：`platform/settings.ts` 用 `legacyEnvName` 代替自己拼的 `HARBOR_` 名字；分层提示词的四条提示用 `INJECT_MARK` 常量写「Harbor 注入」，不再各自写死。

### 2. 留下的（兼容需要）

留下的每一处都在 `tests/fixtures/legacy-names.json` 里，按文件和匹配写了理由：

- **契约旧值**（ADR-152）：能力 / 来源 `"harbor"`、编号前缀 `harbor:`、类型 `harbor_bash` / `harbor_monitor`、字段 `harborPending`、回退结果 `via: "harbor"`——存下的历史和旧服务端 / 执行端还会发。
- **工具旧名**（ADR-154）：MCP 服务器 `harbor`、`mcp__harbor__*`、`harbor_*`、旧执行端读的任务字段 `harborTools`。
- **旧标记**（ADR-154）：`[[HARBOR_NEEDS_FILES]]`、`Harbor fork` / `Harbor rewind`、`Harbor 系统`、`【Harbor 补送…】`（读）；注入标记 `Harbor 注入`（照旧写，维护者的决定）。
- **环境变量**（ADR-153）：`daisyEnv` 的 `HARBOR_*` 回退、`HARBOR_BASE_PATH`、只为提醒和排除而点名的 `HARBOR_DATA`、后台命令不继承的 `^HARBOR_`。
- **磁盘和存储**（ADR-153）：`harbor-worktrees`、`harbor/<会话>`、`~/.local/share/agent-harbor`、浏览器键 `harbor.*` / 侧栏 `harbor`、终端页握手 `harbor-terminal-*`、旧数据库 `harbor.sqlite` 及拒绝它时对主人说的「旧 Agent Harbor 的数据库」（旧版已停用，旧数据库不导入）。
- **冻结的**：schema 第 1 步 SQL 里的一句注释（哈希固定）。
- **旧数据夹具**：`tests/fixtures/prompt-legacy-*.json`（旧提交时模型读到的原文）。
- **测试**：上面每一项的兼容测试用旧名字造旧数据；进程重启测试里旧启动脚本的 LaunchAgent 标签（证明它不再被当成 launchd 单元）。
- **私有插件包**不在本次范围、也不扫描：它发给自己外部服务端的标识（agent 标识 `harbor-<agent>`、`harbor-runner`、回调来源 `/^harbor-/`）要和那个服务端一起改；包里的临时目录前缀顺带改了。它的测试驱动脚本（不公开）里的提供方名 `harbor-codex` 同理（清单里有一条，公开树里没有这个文件时这条不算过期）。

本来就有说明的地方（`LEGACY_*` 常量、文档注释写了 ADR-152/153/154 的）不再加注释；没有说明的补一行 `// legacy name, kept for compatibility (ADR-15x)`。

### 3. 守卫测试

新 `tests/no-harbor-names.test.ts`：扫描根 `package.json` / `package-lock.json`、`apps/`、`scripts/`（私有仓库才有的私有脚本目录除外）、`tests/` 和 `packages/*`（插件包除外——按 `check-core-names` 的同一规则认：导出 `./server` 或 `./runner` 的包），文件类型 ts/tsx/js/mjs/cjs/json/css/html/py/sh/cs。注释不算（自带的小词法器：JS/TS 的行注释、块注释，字符串、模板嵌套、正则字面量照常保留；CSS 块注释、HTML 注释、Python / shell 的 `#`；与 Babel 分词在全树上的结果逐处一致）。代码里出现的每一处旧名字都必须被清单里某条（文件 glob + 行内正则，匹配范围要盖住这一处）覆盖，否则失败；清单里一条都没盖到的也失败（文件不在树里的除外）。第二条测试检查词法器本身（注释不算、字符串 / 标识符 / 模板 / 正则算、过期判断）。

清单和测试都不写私有插件的名字，可以随公开树发布。

## 结果

代码（不含注释）里的旧名字：1668 → 510 处。发布的源码 925 → 62 处（全部是上面第 2 节的兼容项）；测试 617 → 224 处（兼容测试 + 旧数据夹具 93）；守卫自己 22 处、清单文件不扫描；私有插件包 33 → 26 处（只改了临时目录前缀）。标识符（不含私有插件包）只剩环境变量名和 `harborTools` / `harborPending` / `harbor_bash` / `harbor_monitor` 这几个旧字段 / 旧值。注释从 536 处降到 482 处（只是点名的标识符跟着改），其余是 P6-06。

## 没改的

- 注释的文字（P6-06）、提示词的措辞（ADR-154 已做）、A2A 扩展 URI（维护者决定保留）。
- `docs/` 里描述历史的文字（私有的施工文档、旧 ADR 里的旧标识符名字）；只把引用改名测试文件的路径改了。

## 回滚

还原本次提交即可：没有落盘或上线的名字变化。注意 `@daisy-ai/client` / `@daisy-ai/ui` 的使用者（仓库内的 apps/app、私有插件包、测试）要一起还原。

## § P6-06a：代码、测试、脚本里的注释和测试数据脱敏

范围：发布的 `packages/`、`apps/`、`scripts/`、`tests/`。目标是发布前的名字扫描在这些地方 0 处——靠改内容，不靠放宽允许清单（一条没加；`legacy-names.json` 只删了一条过期的）。

决定：

1. **注释里的人名**（同事、主人的账户名）去掉；“谁定的”写成“主人定的”或直接写规则本身；用户反馈的原话在能说明行为时保留、不署名。测试数据里的人名换成 alice / bob。
2. **内部工单 / 文档编号**去掉；测试和示例里的任务编号换成 `T-1`（`scripts/context-harness.tsx` 与 `e2e-context.cjs` 一起改，旧提示词夹具 `prompt-legacy-74a2714.json` 与产生它的测试输入一起改——那段文字是测试自己的输入拼出来的）。
3. **不公开的早期 ADR（ADR-0xx）**：约 1570 行引用。常见形状（括号里的引用、行首 `ADR-0xx:` 标签、测试标题前缀）机械删除；其余逐处改成自足的句子，或换成真正覆盖它的公开 ADR（099–156 中公开的）；内部评审编号（review L1、re-review 3）一起去掉。剩下的 7 行在 schema 第 1 步（V1）的 SQL 注释里，冻结、哈希固定，不改（导出扫描不查 ADR 编号）。
4. **用户看得到的文字**（命令帮助、接口说明 → `docs/api`、`commands.md`，错误提示）不带总纲节号、D-xx、P 编号、ADR 编号（公开 ADR 编号只在有意义处保留）；`agent resident create` 的帮助和错误提示指向实际存在的 `daisy workspace catalog`。测试标题去掉 D-xx 前缀（T-/A-/P- 标签保留，AGENTS.md 说明它们是标签）。普通代码注释里的 P/D 编号保留（公开 ADR 150–156 同样使用）。
5. **注释里指产品的 Harbor → Daisy**（只动注释，按 `no-harbor-names` 的词法器定位）；解释旧名字的地方（`Harbor 注入`、`Harbor 系统`、旧数据库、旧值）照留。
6. **私有插件不出现在核心测试里**：只验证某个私有插件的用例（要装了它才跑、开它的配置、假的插件服务端）整段移进那个插件包自己的测试（共 30 条，在装了它的地方照跑）；`tests/fixtures/plugins.ts` 改成通用的 `pluginInstalled` / `needsPlugin`；假 agent（`tests/fixtures/agent.cjs`）不再固定回显插件的环境变量，改为回显 `DAISY_FIXTURE_ENV_KEYS` 列出的变量（插件自己的测试传入）；只需“某个外部平台 / 签发方 / 宿主”的地方换成中性名字（`tasks:*` 作用域、`Acme Desk`、`host.example`、`DOC-0a1b2c3d4e5f` / `team-cli`）；按包名点检插件的测试改成“每个插件包”（对 `@daisy-ai/daisy` 有 peer 依赖的包）。
7. **内网地址**：`startup.test.ts` 的地址换成 RFC 5737 的 192.0.2.50；`access-faces.test.ts` 需要私网地址，换成测试里其他地方也用的一个虚构私网地址。进程重启测试里的旧 LaunchAgent 标签只需“不是 Daisy 的某个标签”，换成 `com.example.agent-node`，对应的 `legacy-names.json` 条目删除。
8. 顺带：`contracts/src/restart.ts` 的 `launch.sh --supervise` 换成现在真实的几种管理者（systemd、launchd、Windows 助手的 supervise、`DAISY_RUNNER_SELF_RESTART=1`、自行拉起）；`let-in.test.ts` 的 `_phase4` 旧注释改掉；`update/upgrade.ts` 里旧安装路径的说明已在更早的提交里消失。

没改：schema 第 1 步（V1）SQL 注释里的 ADR-0xx 与一处旧名字（冻结）。
