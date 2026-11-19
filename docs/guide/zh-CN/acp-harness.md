# 写一个 ACP harness 配置

[English](../en/acp-harness.md)

[ACP](https://agentclientprotocol.com/)（Agent Client Protocol）是编码 agent 在标准输入输出上说的 JSON-RPC 协议。Kimi Code、OpenCode、Antigravity、DeepSeek Harness 都经它接入 Daisy，用的是同一个通用适配器。

接一家新的 ACP harness 不用改代码：写一个 JSON 文件，在数据目录的 `runner.json` 里用 `acpHarnesses` 指向它（也可以用环境变量 `DAISY_ACP_HARNESSES`）。

## 最少要写什么

```json
[
  { "id": "acme", "launch": { "command": "acme", "args": ["acp"] } }
]
```

这样就够了：Daisy 用 `acme acp` 启动它，在标准输入输出上说 ACP。没写的项按通用的默认值（见下表），也就是“只能基本对话”。

## 完整的例子

下面是一家假想的 harness“Acme Agent”：命令是 `acme`，`acme acp` 起 ACP 服务，有 `default`、`plan`、`auto` 三个模式，`plan` 只规划不动手。把 `acme` 换成你的 harness 的命令和它的实际情况。

```json
[
  {
    "id": "acme",
    "name": "Acme Agent",
    "short": "Acme",
    "letter": "A",
    "color": "#3b7dd8",
    "tier": "experimental",
    "description": "通过 ACP 接入 Acme Agent。",
    "launch": { "command": "acme", "args": ["acp"] },
    "versionArgs": ["--version"],
    "install": "npm install -g acme-agent",
    "binDirs": [".acme/bin"],
    "loginHint": "在本机终端运行 acme login",
    "modes": {
      "values": ["default", "plan", "auto"],
      "default": "default",
      "readOnly": "plan",
      "bypass": null
    },
    "efforts": ["low", "medium", "high"],
    "resume": ["load"],
    "features": { "fork": "native", "compact": "native", "usage": "native" }
  }
]
```

## 告诉 Daisy 用这个文件

存成例如数据目录里的 `acp-harnesses.json`，然后在同一个目录的 `runner.json` 里加一项 `acpHarnesses`：

```json
{
  "nodeId": "…（第一次启动时写的，别动）",
  "acpHarnesses": "acp-harnesses.json"
}
```

- 数据目录：Linux 是 `$XDG_DATA_HOME/daisy`（默认 `~/.local/share/daisy`），macOS 是 `~/Library/Application Support/Daisy`，Windows 是 `%LOCALAPPDATA%\Daisy`（用了 `--data-dir` 或 `DAISY_DATA` 就是那个目录，见 [安装 › 数据目录](install.md#数据目录)）。`daisy status` 的“数据目录”一行写着实际位置。
- `runner.json` 是 Daisy 第一次启动时写的，里面已有的项不要动，只加这一项。还没启动过也可以先自己建一个只有这一项的 `runner.json`，第一次启动会保留它。
- 路径可以写绝对路径；相对路径按数据目录算。
- `runner.json` 和这个文件都必须属于你的账户、别的账户不能写（`chmod go-w`）；否则 Daisy 不用它，并说明原因。

然后：

```sh
daisy stop && daisy start
daisy doctor                       # 应该列出 Acme Agent：装没装、版本；文件有错会说哪一项
```

文件只在启动时读一次。改了文件要重启 Daisy。

开机自启（`daisy autostart on`）起的 Daisy 也读 `runner.json`，所以不用另外配置。`daisy` 命令按同一个数据目录的 `runner.json` 认 `--agent acme`，终端里不用设任何变量。

也可以用环境变量 `DAISY_ACP_HARNESSES=<文件>`：设了它就以它为准，不看 `runner.json` 的 `acpHarnesses`。环境变量只到得了从这个终端启动的 Daisy（`daisy start` 的后台进程）；开着开机自启时，Daisy 由系统的服务管理器启动，带不上你终端里的变量，所以那时请用 `runner.json`。

## 每一项

| 项 | 必填 | 说明 | 不写时 |
| --- | --- | --- | --- |
| `id` | 是 | Daisy 里的名字，会话和身份档的 `agent` 就是它。小写字母开头，只有小写字母、数字、`-`，2–31 个字符。不能和已有的重名：`claude`、`codex`、`kimi`、`opencode`、`antigravity`、`deepseek`，以及 `runner`、`filesystem`、`plugins`、`images`、`sync` | — |
| `launch.command` | 是 | 启动命令：命令名（在 PATH 里找）或绝对路径。不能是相对路径（如 `./acme`、`bin/acme`）：harness 在会话的工作目录里启动，相对路径会指到那里的文件，这样的一项不加载 | — |
| `launch.args` | 否 | 启动参数，一个字符串数组 | `[]` |
| `name` | 否 | 产品名：设置页、`daisy doctor`、选择器里用 | 同 `id` |
| `short` | 否 | 句子里的简称 | 同 `name` |
| `letter` | 否 | 头像上的一个字 | `name` 的第一个字 |
| `color` | 否 | 头像和强调色 | `#777777` |
| `tier` | 否 | `second`（二线：必备能力加声明的能力）或 `experimental`（实验：只承诺基本对话） | `experimental` |
| `description` | 否 | 新建会话时的一句说明 | “通过 ACP 接入 …。” |
| `versionArgs` | 否 | 查版本的参数（检测、`daisy doctor`） | `["--version"]` |
| `install` | 否 | 怎么安装（`daisy doctor` 提示用） | “按 … 官方说明安装” |
| `binDirs` | 否 | 相对家目录的安装目录，加进 Daisy 找命令的 PATH | 无 |
| `loginHint` | 否 | 怎么登录（提示用） | “在本机终端里登录 …” |
| `modes.values` | 否 | 权限模式的取值（ACP 的 `session/set_mode` 或 `mode` 配置项） | 没有模式 |
| `modes.default` | 否 | 默认模式 | `""` |
| `modes.readOnly` | 否 | 哪个模式算只读。写了，这家就能接受“问”（弱只读）；不写，就不能接受“问” | 无 |
| `modes.bypass` | 否 | 跳过所有确认的那个模式。Daisy 不会给公开 agent 和外来任务用它 | 无 |
| `efforts` | 否 | 会话没列出推理强度时，提供的推理强度取值 | `[]`（只用会话自己列的） |
| `resume` | 否 | 恢复会话的方法：`load`（`session/load`）、`resume`（`session/resume`）。实际按 harness 在 `initialize` 里的声明来 | `["load", "resume"]` |
| `features` | 否 | 额外声明的能力，只认 `fork`、`compact`、`usage`，值是 `native` 或 `none` | 都是 `none` |

`features` 里声明的能力，Daisy 仍然按 harness 自己的回答核对：`fork` 要它在 `initialize` 里声明 `session/fork`，`compact` 要会话的可用命令里有 `compact`，`usage` 要它发 `usage_update`。声明了而 harness 不支持时，`fork`、`compact` 用的时候会失败并说明，`usage` 只是没有数据。

## 配置文件做不到的

这些需要 Daisy 的代码支持，只有内置的条目有：

- **在 Daisy 里登录**（`daisy login`、网页的“启动官方登录”）。配置里的 harness 只能沿用本机的登录：先在终端里登录好。
- **官方命令行窗口**、读写 harness 自己的配置文件、套餐余量。
- **运行中追加、撤回、文件回退、“问”走支线。** 通用 ACP 适配器对任何 harness 都没有这些。

切模型、推理强度、权限模式时，Daisy 重启 harness 进程再接着原会话。

能力的总表见 [harness 支持范围](harnesses.md)。

## 只读与“问”

- 写了 `modes.readOnly`：别人“问”你公开的这个 agent 时，这一轮切到那个模式，在主线上排在你这一轮后面跑。它只是 harness 自己遵守的模式，不是硬限制，所以按**弱只读**算，名片上会写明。
- 没写：这家不能只读地回答，拒绝“问”。要公开它，得允许“办”。

只把真正不改文件、不执行有副作用命令的模式写成 `readOnly`。

## 建身份档、开会话

每次启动时，Daisy 给还没有“主机登录”身份档的每家 harness 建一个（沿用这台机器上已有的登录），后来加进文件的也一样：加好、重启之后，设置页和 `daisy workspace catalog` 里就有“acme · 主机登录”。你删掉的身份档不会再自动建回来；要再要一个，自己建：

```sh
daisy workspace catalog                     # 看节点 id
daisy profile create --agent acme --auth-mode subscription --node-id <节点 id> --label "Acme · 主机登录"
```

然后在网页里新建会话，选这个身份档。

## 换命令、排错

- 换启动命令（例如装在别处）：在 `runner.json` 里写 `"agentBins": { "acme": "/opt/acme/bin/acme" }`（绝对路径或命令名，不能是相对路径；键必须是内置的或这个文件里的 id），或者设环境变量 `DAISY_ACME_BIN=/opt/acme/bin/acme`（规则是 `DAISY_<ID>_BIN`，ID 大写、`-` 换成 `_`；环境变量优先）。
- 文件读不了、不是 JSON 数组，或者某一项不对（例如 `id 无效`、`id 已被占用`、`launch.command / launch.args 无效`、`id 重复`）：Daisy 照常启动，只是不加载有问题的项（文件整个坏了就一家也不加载），并在日志、`daisy status` 和 `daisy doctor` 里用一行说明是哪个文件、第几项、哪里不对。`daisy` 命令照常能用，每条命令在标准错误里提一行。改好文件，重启 Daisy。
- `daisy doctor` 看这家装没装、版本对不对，以及文件是从 `runner.json` 还是环境变量来的。

## 谁能改这些设置

`acpHarnesses` 和 `agentBins` 决定 Daisy 执行哪个程序。Daisy 没有能写它们的命令或接口，只能直接编辑 `runner.json`。这个文件只有你的系统账户能读写（文件 0600，数据目录 0700），和你的 shell 配置文件一样。Daisy 的接口里决定这台机器运行什么代码的设置（例如更新来源 `daisy update --source`）都要 PIN；要是以后加了写这几项的命令，也一样要 PIN。
