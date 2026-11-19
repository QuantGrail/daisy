# Daisy 工作约定（给贡献者和编程 agent）

在这个仓库里改代码的人和 AI 编程 agent 都按这里办。开发环境、测试命令、提交格式见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)（English: [CONTRIBUTING.md](CONTRIBUTING.md)）；产品怎么用见 [用户指南](docs/guide/README.md)；设计为什么这样定，见 [docs/adr](docs/adr/) 里的架构决策记录（ADR）和 [docs/contracts](docs/contracts/) 里的契约。

## 改动

- 产品名和命令名只从 `packages/contracts/src/names.ts` 取；界面、日志、帮助文字不直接写产品名。
- 给人看的文字和给模型的提示词只写在语言包里（`packages/contracts/locales/<语言>/`，见 ADR-159）：源代码只写键，`en` 和 `zh-CN` 两边一起加，`npm run gen:i18n`；还没转换的文件记在 `tests/i18n-pending.json`，只减不增。
- 界面接入只经 `@daisy-ai/client` 和 `@daisy-ai/contracts`，不依赖某一家 harness 的原始协议。
- 本机接口只有一份定义（`packages/contracts/src/api/`）。改了接口要重新生成 `docs/api`（`npm run gen:api`），每条接口都经集中的路由表和访问检查。
- 数据库结构的改动在 `packages/daisy/src/store/schema.ts` 里追加一步迁移，不改已有的步骤。
- 核心代码不提任何插件；插件只经 `@daisy-ai/daisy/plugin` 接入。
- 改名要兼容旧名：先读新名，没有再读旧名并提示改名；已有的数据和工作区照旧能用。
- 运行中的一轮不能因为网页关掉而中止；重放不能重复产生工具的副作用。

## 测试与验证

- 改行为，先写说明这个行为的测试；权限、认证、协议的改动必须有行为测试。
- 测试不联网、不用真实的 harness 登录或额度，用 `tests/fixtures/` 里的假程序。
- 提交前跑本地关口（命令见 CONTRIBUTING.zh-CN.md）。某个系统上暂时不支持的测试记在 `tests/platform-pending.json`，条目只减不增。
- 用假程序做的测试和真实 harness / 真机上的验证要分开报告，不能拿前者冒充后者。

## 安全

- 不改动机器上已有的 harness 凭据、别的仓库或系统设置。
- 不提交数据目录（`.data/`）、账号凭据、附件或工作区内容；日志、错误信息、测试、文档里不出现凭据、令牌、PIN。
- 安全问题按 [SECURITY.md](SECURITY.md) 私下报告。

## 读 ADR 时

- 有设计决定的改动写一份 ADR（`docs/adr/ADR-<编号>-<名字>.md`）：背景、决定、理由、放弃的做法、后果。
- ADR 里的 `P1-03`、`P4-02` 之类是 Daisy 重写时各个工作包的编号，`审查 H-1`、`M-2` 之类是那个工作包安全审查意见的编号；它们只是标签，说明这条决定从哪一步来。ADR 编号不连续的地方是没有公开的内部记录。
