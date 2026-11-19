# ADR-161：主机 Codex 配置里账号用不了的模型；模型被拒时的出路（P6-17）

- 日期：2026-11-18
- 状态：**已实施（分支 `p6-17`，基于 `p6-gate`；待合入）**
- 来源：阶段 6 外人真机验收：全新安装、沿用主机的 Codex 登录，第一轮就失败——`The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account.`；外人自己找到对话底部的模型 →「读取原生模型列表」→ 换模型才恢复
- 相关：Codex 的推理强度与 Fast 按原生模型列表；主机登录身份档

## 模型是从哪里来的

- 第一次启动建的「`codex · 主机登录`」身份档 `model: ""`、`configDir: ""`（`app/bootstrap.ts` 的 `ensureHostLogins`）。会话设置里也没有模型。
- `harness/codex.ts` 只在身份档或会话选了模型时才往 `thread/start` / `thread/resume` 里放 `model`。所以 Daisy 一个模型也没有发。
- `configDir` 为空就不设 `CODEX_HOME`，Codex 读这台机器原有的配置（`$CODEX_HOME`，默认 `~/.codex/config.toml`）。Codex 不带模型启动线程时用配置的 `model`，没有才用它自己的默认。
- 外人读到的原生列表里没有这个模型，而 Codex 自己的默认一定在列表里，所以模型来自主机配置的 `model`（这台机器的主人按自己的账号或旧版本写的）。没有读 `~/.codex` 核实。Daisy 的常量、模型清单、能力默认值里都没有这个模型。

## 决定

1. **没有在 Daisy 里选模型时，核对主机配置的模型**：`config/read` 给出了 `model`，就在启动线程之前问一次 `model/list {includeHidden:true}`（Codex 按登录给出这个账号能用的列表）。列表完整（非空、没有下一页）且里面按 `model` 或 `id` 都找不到它，就用列表的默认模型（`isDefault`，没有就用第一个不隐藏的）启动线程，并在对话里留一条提示「Codex 配置里的模型 X 不在这个账号的原生模型列表里，这个会话改用 Y。要换：点对话底部的模型。」此后这个进程里「默认」指的就是 Y。代码：`codexModelInstead()`。
   - 列表在、模型也在（包括隐藏的）：照旧什么都不发，主机配置说了算。
   - 读不到列表、列表为空或只有一页：不替换（不知道就不改）。
   - 主人在 Daisy 里选了模型（身份档或这个会话）：照发，不替换——那是主人的选择。只问支线沿用主线实际用的模型，也不替换。
   - 没有选“不发模型”以外的做法（例如 Daisy 自带一个默认模型）：模型名单随账号和 Codex 版本变，只有 Codex 自己的列表知道。
2. **模型被拒时说出路**：一轮因为模型失败（Codex 的 `error` 通知或 `turn/completed failed`，以及按线程记录收尾的那条路径），错误改成「这个账号用不了模型 X：点对话底部的模型，选「读取原生模型列表」，换成列表里的模型后重发。原文：…」，英文原文保留在后面。识别的说法：`… model is not supported …`、`model … does not exist / not found / not available`、`unsupported model`、`model_not_found`、`unsupported_model`。代码：`harness/model-switch.ts` 的 `unsupportedModelHint()`。只接在 Codex 上；Claude Code 自己会换模型（`system/model_fallback`，已有的「本轮换了模型」）。

新加的文字（提示的标题与正文、两种出路）都在语言包里（`server-harness.*`，ADR-159），中英两种。语言取这个进程 / 系统的（Runner 没有请求可读；主人设置在数据目录里，留给服务端的转换）。

## 测试

`tests/codex-unsupported-model.test.ts`：假 Codex 新加 `DAISY_FIXTURE_CODEX_CONFIG_MODEL`（主机配置的模型：`config/read` 给出、不带模型的线程用它）和 `DAISY_FIXTURE_CODEX_UNSUPPORTED`（这个模型的一轮照 Codex 对 ChatGPT 账号的报法失败：`error` 通知 + `turn/completed failed`）。主机配置的模型不在列表里 → `thread/start` 带列表默认、上报的模型是它、对话里有提示（改前这一轮失败）；在列表里 → 不发模型；主人选的被拒 → 照发、错误带出路和原文。`codexModelInstead` 与 `unsupportedModelHint` 的单元测试。

## 文档

`docs/guide/{zh-CN,en}/first-use.md` 第 5 节、`install.md`「出问题时」各加一条：已登录但模型不支持 → 对话底部的模型 →「读取原生模型列表」→ 选列表里的模型。
