# 参与贡献

[English](CONTRIBUTING.md)

谢谢你愿意改进 Daisy。下面是开发环境、测试、改动的约定和提交的方式。

## 开发环境

- Node.js 24 或更高（`node --version`），npm 随 Node 一起装。Linux、macOS、Windows 都可以开发。

```sh
npm ci                   # 安装依赖
npm start                # 从源码前台运行 Daisy
npm run build:web        # 构建本地网页
npm run daisy -- --help  # 从源码运行 daisy 命令
```

从源码运行时，数据目录默认是检出里的 `.data/`，不会碰你平时用的 Daisy；要放别处设 `DAISY_DATA`，端口冲突时设 `DAISY_PORT`。

## 测试

```sh
npm test                                   # 行为测试
npm run typecheck
npm run gen:api -- --check                 # docs/api 和接口定义一致
TZ=UTC LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 node scripts/ci-test.mjs   # 本地关口：全部测试
```

- 测试不联网：`tests/no-network.mjs` 拦下除本机以外的一切连接和域名解析。测试里不用真实的 harness、登录或额度，用 `tests/fixtures/` 里的假程序。
- 某个系统上暂时不支持的测试记在 `tests/platform-pending.json`，写明原因；条目只能减少，不能增加。
- 改行为，先写能说明这个行为的测试。权限、认证、协议的改动必须有行为测试。

## 改动的约定

- 产品名和命令名只从 `packages/contracts/src/names.ts` 取。
- 本机接口只有一份定义（`packages/contracts/src/api/`）：加或改接口时改那里，命令行和 `docs/api` 从它生成（`npm run gen:api`）。
- 数据库结构的改动在 `packages/daisy/src/store/schema.ts` 里追加一步迁移，不改已有的步骤。
- 给人看的文字和给 AI 的提示词只写在语言包里（见下面的[语言包](#语言包)），源代码里只写键；代码注释和日志用英文。日志、错误信息、测试里不出现凭据、令牌、PIN。
- 用户指南有中文（`docs/guide/zh-CN`）和英文（`docs/guide/en`）两份，同名、同结构；改一边就在同一个提交里改另一边。
- 核心代码不提任何插件；插件只经 `@daisy-ai/daisy/plugin` 接入。

## 语言包

Daisy 的文字按语言放在 `packages/contracts/locales/<语言>/`：每种语言一个目录（目录名是 BCP 47 标签，如 `en`、`zh-CN`），每块一个平铺的 JSON 文件（`cli.json`、`ui-chat.json`……），键以文件名开头（`cli.json` 里只有 `cli.*`）；长的提示词在 `prompts/*.md`。参数写成 `{名字}`；数量会改变措辞的地方用复数选择 `{count, plural, one {# step} other {# steps}}`（`#` 是那个数；没有复数变化的语言直接写 `{count} …`，中文就是这样）。设计见 `docs/adr/ADR-159-language-packs.md`。

**加或改一句文字**

- 在 `en` 和 `zh-CN` 的同名文件里各加一项（同一个键、同样的 `{参数}`），运行 `npm run gen:i18n`，代码里写 `t("区域.…", { … })`。整句进语言包，不拼句子。`en` 是参照包：类型化的键从它生成。
- `tests/i18n.test.ts` 检查两个随 Daisy 发布的语言包键完全相同、参数相同、没有空文字；`scripts/i18n-scan.ts` 不让中文重新写进源代码（`tests/i18n-pending.json` 保持为空，确实要保留的写进 `tests/i18n-kept.json` 并写明理由）。
- 测试默认用中文（`tests/test-env.mjs` 设 `DAISY_LANG=zh-CN`）；新文字两种语言都要测（`--lang en`、`Accept-Language: en`、`setUiPack("en", …)`）。

**改进翻译** —— 改对应语言目录里的那一项就行，键不变；给 AI 的提示词（`prompt*.json`、`prompts/*.md`）改了要更新 `tests/fixtures/` 里那种语言钉住的样本，并在合并请求里说明。

**加一种语言**

1. 先在自己的 Daisy 上试：把 `packages/contracts/locales/en/` 复制到 `<数据目录>/locales/<语言标签>/` 并翻译，Daisy 几秒内就能在“设置 → 显示语言”和 `daisy language` 里选到它（不用重启；缺的键显示英文）。
2. 要随 Daisy 发布，就在 `packages/contracts/locales/<语言标签>/` 下放全部文件（包括 `prompts/*.md`）——不改任何代码，语言列表就是这些目录。随 Daisy 发布的语言包必须完整（键、参数与 `en` 完全相同），并带一份钉住的提示词样本。最好请这种语言的母语使用者审一遍。

## 提交

- 提交信息：`类型(范围): 一句话`，例如 `fix(relay): …`、`feat(cli): …`、`docs: …`、`test(a2a): …`。一个提交做一件事。
- 合并请求里写清楚：改了什么、为什么、怎么测的（哪些测试、哪个系统），以及有没有改变已有的行为或数据。
- 安全问题不要开公开的 issue 或合并请求，按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可

Daisy 以 [Apache License 2.0](LICENSE) 发布。你提交的贡献按许可证第 5 条同样以 Apache-2.0 授权（inbound = outbound），不需要另签贡献者协议（CLA），也不要求 `Signed-off-by`。请只提交你有权以这个许可证提供的代码。

参与这个项目请遵守[行为准则](CODE_OF_CONDUCT.md)。
