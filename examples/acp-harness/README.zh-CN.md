# 不改代码接入一个 ACP harness

[English](README.md)

Daisy 自带 Kimi Code CLI、OpenCode、Antigravity 和 DeepSeek Harness（实验档）四家 ACP harness。别的会说 ACP（Agent Client Protocol）的命令行，可以写成 JSON 文件里的一项，在数据目录的 `runner.json` 里用 `acpHarnesses` 指给 Daisy（或用环境变量 `DAISY_ACP_HARNESSES`），不用改代码。

[`acp-harnesses.json`](acp-harnesses.json) 是一个例子：Gemini CLI，用 `gemini --experimental-acp` 启动 ACP 模式。这个参数以 Gemini CLI 自己的说明为准（`gemini --help`），版本变了就跟着改 `launch.args`。

## 用法

把文件放进 Daisy 的数据目录（`daisy status` 的“数据目录”一行写着位置；下面以 Linux 的默认位置为例，macOS 是 `~/Library/Application Support/Daisy`），在同一个目录的 `runner.json` 里加一项 `"acpHarnesses": "acp-harnesses.json"`（已有的项不要动），然后重启：

```sh
cp examples/acp-harness/acp-harnesses.json ~/.local/share/daisy/acp-harnesses.json
# 编辑 ~/.local/share/daisy/runner.json，加上： "acpHarnesses": "acp-harnesses.json"
daisy stop && daisy start
daisy doctor          # 能看到 Gemini CLI，以及它是否已安装、版本号
```

开机自启（`daisy autostart`）的 Daisy 也读 `runner.json`；`daisy` 命令同样读它，所以 `--agent gemini` 不用另设变量就认。

只想试一次，也可以用环境变量（只对这次从终端启动的 Daisy 有效；设了它就不看 `runner.json` 的 `acpHarnesses`）：

```sh
daisy stop
DAISY_ACP_HARNESSES=~/.local/share/daisy/acp-harnesses.json daisy start
```

Daisy 只在启动时读一次这个文件。文件有错时（JSON 不对、`id` 不合法或和内置的重名、缺 `launch.command`）Daisy 照常启动，但不加载有错的项，并在日志、`daisy status`、`daisy doctor` 里用一行说明是哪一项、哪里不对。

## 用起来

每次启动时，Daisy 给还没有“主机登录”身份档的每家 harness 建一个，所以加好、重启之后就有“gemini · 主机登录”（Daisy 起的这个名字跟着显示语言变）。然后在网页上新建会话时选它。登录用这台机器上 `gemini` 自己的登录（`loginHint` 里写的那句会显示在设置页）。你删掉的身份档不会自动建回来；要再建一个：

```sh
daisy workspace catalog            # 看执行节点 id（nodes[].id）
daisy profile create --agent gemini --auth-mode subscription --node-id <节点 id> --label "Gemini CLI"
```

## 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | Daisy 里的 agent 值：小写字母开头，2–31 个字符，只用小写字母、数字、`-`。不能是 `claude`、`codex`、内置的四家（`kimi`、`opencode`、`antigravity`、`deepseek`）或 Runner 的其他能力名 |
| `launch.command` / `launch.args` | 命令必填 | 在 stdio 上启动 ACP 服务的命令和参数（命令不在 PATH 里时写绝对路径） |
| `name` / `short` / `letter` / `color` / `description` | 否 | 界面上的名字、句子里的短名、头像字母、颜色、开始页上的一句介绍 |
| `versionArgs` | 否 | 版本探测的参数（默认 `--version`），`daisy doctor` 和检测用 |
| `install` / `loginHint` | 否 | 没装时怎么装、怎么登录，`daisy doctor` 和设置页显示 |
| `binDirs` | 否 | 家目录下要加进 PATH 的安装目录 |
| `modes` | 否 | 权限模式（`values`、`default`）、算作只读的那个值（`readOnly`，只算“弱只读”：agent 自己遵守，Daisy 不强制）、跳过所有确认的值（`bypass`）。不写：没有模式、没有只读，这家不接受别人的“问” |
| `efforts` | 否 | 会话没列出推理强度时提供的候选 |
| `resume` | 否 | 恢复会话的方式：`load`、`resume`，默认两个都试（实际按 agent 在 `initialize` 里的声明） |
| `tier` | 否 | `second`（二线）或 `experimental`（实验档，默认） |
| `features` | 否 | 只能声明通用适配器按 agent 的回答去做的三项：`fork`、`compact`、`usage`，值为 `native` 或 `none` |

文件里的一项不能声明 Daisy 没有代码支持的能力（不会模拟）：插话、撤回、额度、独立登录等一律按“不支持”处理。完整的类型和默认值见 `packages/contracts/src/acp-harnesses.ts`。指南里的详细说明：[写一个 ACP harness 配置](../../docs/guide/zh-CN/acp-harness.md)。

这个例子由 `tests/examples.test.ts` 用 Daisy 自己的加载代码检查。
