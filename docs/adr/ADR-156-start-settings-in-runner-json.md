# ADR-156：开机自启也生效的启动设置写在 runner.json；坏的 ACP harness 文件不再让一切起不来（P6-11）

- 日期：2026-11-18
- 状态：**已实施（分支 `p6-11`，基于 `p6-gate`；待合入）**
- 来源：阶段 6 写公开文档（P6-08）时发现的产品问题（P6-11 第 1–3 项）；设计要求（PIN 管“放别人进来”和决定这台机器运行什么代码的写）；维护者的决定（端口按 uid 派生首选值，被占就找空闲并记住；写都要 PIN）
- 相关：ADR-102（数据目录、端口、自启单元不写端口）、ADR-130（通用 ACP 适配器、`$DAISY_ACP_HARNESSES`）、ADR-145（`runner.json` 的 `updateSource` 要 PIN）、ADR-153（环境变量改名，`daisyEnv`）

## 背景

1. **开机自启丢环境变量。** systemd 单元、launchd plist、Windows 的 Run 项只带 `PATH`（和显式的 `DAISY_DATA`）。`DAISY_ACP_HARNESSES`、`DAISY_<ID>_BIN`、`DAISY_PORT` 到不了自启的 Daisy；公开文档只能写几条没测过的绕法（systemd drop-in、`setx`），macOS 没有办法。命令行也要终端里有 `DAISY_ACP_HARNESSES` 才认 `--agent <id>`。
2. **坏的 `DAISY_ACP_HARNESSES` 让每条 `daisy` 命令都崩**，连 `--help` 也是一屏堆栈：文件在 contracts 被导入时读，`JSON.parse` 或条目检查直接抛出。
3. **第一次启动之后才加的 harness 没有“主机登录”身份档**：只有第一次启动（空数据库）时给当时已知的每家建一个，之后要主人手动 `profile create`。
4. `scripts/doctor.ts` 还按旧的固定端口 8787 去问。

## 决定

### 1. 设置写在数据目录已有的 `runner.json`，环境变量 > 文件 > 默认

不新开文件：`runner.json` 已经是这台机器的节点设置（`plugins`、`autoUpdate`、`updateSource`、`selfRestart` …），在数据目录里，0600。新加三项：

| 项 | 等于 | 取值 |
| --- | --- | --- |
| `port` | `DAISY_PORT` | 1–65535 的整数；和环境变量一样是“指定的端口”，被占用就启动失败 |
| `acpHarnesses` | `DAISY_ACP_HARNESSES` | 额外 harness 文件的**路径**；相对路径按数据目录算 |
| `agentBins` | `DAISY_<ID>_BIN` | `{ "<agent id>": "<命令>" }`，内置的和额外的都行 |

`packages/daisy/src/platform/settings.ts` 读它（只用 `node:` 模块）。两个入口在别的东西加载**之前**把文件里的值写进本进程的环境，只写环境里没有的（新名字、旧 `HARBOR_` 名字、`PORT` 都算有；空串不算）：

- Daisy 进程：`main.ts`（systemd、launchd、Windows 守护进程、`daisy start` 都经它），用 `startDataDir` 的数据目录。
- `daisy` 命令：`bin/daisy.mjs`，数据目录按命令行自己的规则（`--data-dir`、`DAISY_DATA`、系统惯例；`argvDataDir` 和 `cli/main.ts` 的 `globals` 同一套）。

这样所有读取处（`agentCommand`、daemon 的端口、contracts 的 harness 表）一行不改，命令行和 Daisy 进程看到同一组 harness。harness 表在 `contracts/acp-harnesses.ts` 加载时定下（`AGENT_IDS`、`AgentSchema`、能力声明等都是模块级常量），所以只能在加载前把路径交给它；用环境变量交接是最小的改动，而且 harness 子进程、AI 在会话里运行的 `daisy` 命令继承到的也是同一个值。

**路径而不是内联。** `acpHarnesses` 指向一个文件，不把 harness 定义直接写进 `runner.json`：格式和 `DAISY_ACP_HARNESSES` 的文件、`examples/acp-harness/acp-harnesses.json` 完全一样，只有一个读取口（contracts 的 `loadAcpHarnessFile`），从环境变量换到 `runner.json` 只改一行；`runner.json` 也保持是一组短小的键。

**首次启动不覆盖。** 第一次启动写 `runner.json` 时保留主人事先写好的项（以前是整个覆盖），所以可以在第一次启动前就写好端口和 harness。

`daisy doctor` 和 `scripts/doctor.ts` 用同一条端口规则（`access/ports.ts` 的 `expectedLocalPort`：指定的 > 记住的 > 按 uid 派生，`runner.json` 的 `port` 算指定的），不再假设 8787；`scripts/doctor.ts` 用 `npm start` 的数据目录，有运行时文件就问它记着的地址，没有就只说启动时会试哪个端口（不去问那个端口：可能是这个账户另一个数据目录的 Daisy）。

### 2. 坏的文件：一行说明，命令照常，Daisy 照常启动

- `loadAcpHarnessFile(file, read)` 不再抛出：文件读不了或不是 JSON 数组，一家也不加载；某一项不对（`id` 无效 / 已被占用 / 重复、`launch` 无效），只跳过那一项，其余照常加载。每个问题一行（去掉控制字符），写明文件路径、第几项、哪里不对。进程里的问题在 `ACP_HARNESS_PROBLEMS`。
- `runner.json` 里写错的项（`port` 不是整数、`agentBins` 的 id 不合法……）不采用，同样一行一个问题；`runner.json` 本身不是合法 JSON 时什么也不采用（其余代码照旧处理它）。
- `daisy` 命令：每个进程在标准错误里每个问题提一行 `✗ …`，然后照常执行；`doctor` 和 `status` 不提，因为它们在自己的输出里说。
- `daisy doctor`：按现在的文件重新读一遍，`runner.json` 的问题和 harness 文件的问题各是一条 ✗（退出码 1），附怎么改；加载成功的额外 harness 一条 ✓，写明文件从环境变量还是 `runner.json` 来。
- Daisy 进程：启动时把问题记进日志，并写进运行时文件 `runtime.json` 的 `problems`；`daisy status`（文本和 `--json`）列出正在运行的 Daisy 启动时发现的问题和现在文件里的问题（去重）。

以前的规则是“文件坏了就启动失败，不悄悄跳过”（ADR-130 第 2 节）。“不悄悄”保留：每个跳过的项都在日志、status、doctor、每条命令里说出来；只是不再因为一个可选的扩展让整个 Daisy 和命令行都不能用——包括用来排查它的 `--help`、`doctor`、`status`。

### 3. 每次启动补“主机登录”身份档

`app/bootstrap.ts` 的 `ensureHostLogins` 每次启动都跑（第一次启动也走它）：给 `runner.json` 的节点上还没给过的每个 agent 建一个“主机登录”身份档（`<agent> · 主机登录`、订阅、沿用本机 CLI 目录，和第一次启动建的一样）。“给过”记在新表 `host_login_agents(node_id, agent, created_at)`（schema 第 15 步，只加表）：

- 后来出现的 harness（额外文件里新加的、更新后新增的内置 harness）下次启动就有身份档。
- 主人删掉的不会再建回来（记录还在）。
- 第 15 步把升级前已有身份档的 agent（任何身份档，不只主机登录）都记为给过：手动建过的不会重复，删过主机登录、留着别的身份档的也不会被补。
- `bootstrap` / `bootstrapLocal` 关着时什么也不做（和第一次启动一样）。

### 4. 谁能写这几项：直接编辑文件，没有命令或接口

没有现成的 `daisy config` 一类命令，这次也不加：`agentBins`、`acpHarnesses` 决定 Daisy 执行哪个程序，按设计要求（决定这台机器运行什么代码的写要 PIN）和维护者的决定“写都要 PIN”，接口里这类写要 PIN（同类的 `updateSource` 写进 `runner.json` 就要 PIN，ADR-145）。只有直接编辑文件这一条路时，PIN 挡不住也不需要挡：文件只有主人的系统账户能读写（0600，目录 0700），能改它的进程本来就能改主人的 shell 配置、`DAISY_<ID>_BIN` 或 harness 本身（同一系统账户就是界限，PIN 的设计里同样写明了这一点）。所以：

- 本工作包**不加**任何写这几项的接口或命令；文档写“编辑 `runner.json`”。
- 以后要是加了写它们的命令或接口，必须 `pin: true`（和 `/api/update/source` 一样）。
- 只问支线本来就不许读 `**/runner.json`（`turns/sidecar.ts`），不变。

### 5. 安全审查后的收紧（同一工作包）

- **命令只能是绝对路径或命令名**（`contracts/start-files.ts` 的 `commandShapeOk`）。harness 在会话的工作目录里启动（`acp.ts`、`worker.ts` 以 `cwd` 为工作区 spawn），相对路径的命令会执行工作区里被放进去的文件。`agentBins` 的值、额外 harness 文件的 `launch.command` 是相对路径时都不采用并一行说明；`daisy doctor` 的 `which` 也不再按命令行自己的目录解析相对路径（Windows 的 `findOnPath` 本来就拒绝）。
- **文件可信才用**：`runner.json` 和额外 harness 文件（不论来自 `runner.json` 还是环境变量）在读之前 `stat`：不属于当前 uid，或组 / 其他人可写（`mode & 0o022`），就整个不用并说明（Daisy、命令行、doctor 同一规则，`untrustedFile`）。只看写位：别人能读额外 harness 文件（0644）不要紧。`--data-dir` / `DAISY_DATA` 可以指向任何目录，doctor 现在会执行 `runner.json` 里写的命令（`--version`、`auth status`），所以这一条有意义。Windows 上不在这里判断（没有 uid；数据目录在每个用户自己的 `%LOCALAPPDATA%` 下，用 ACL 判断要加载辅助程序，而这一步在别的东西加载之前跑）。
- **子进程不继承从文件来的值**：`daisy start` 起的 Daisy 进程（`childEnv`）、重启时起的后继进程（`startSuccessor`）去掉本进程从 `runner.json` 写进环境的名字（值没变过的），由子进程自己读 `runner.json`：之后改了文件、重启就生效，doctor 说“来自 runner.json”也就对了。harness 子进程仍继承（它们里面运行的 `daisy` 命令看到同一组 harness）。
- **`--data-dir` 只有一个解析**：`splitDataDirArg` 同时给 `bin/daisy.mjs` 和 `cli/main.ts` 的 `globals` 用：最后一个算数，`--` 之后不算，没有值是用法错误。
- **问题行不引用文件内容**：JSON 解析失败只说第几行第几列（或第几个字符），不带解析器的消息（它会引用文件里的文字）。
- **`agentBins` 的键必须是已知的 agent**：内置的（`BUILTIN_AGENT_IDS`，测试保证和 contracts 的表一致）或额外 harness 文件里的 id；别的键说明后不采用。

### Windows

`settings.ts` 和 `expectedLocalPort` 没有按系统分的代码：路径用 `node:path`（Windows 上 `C:\…` 是绝对路径，相对路径按数据目录算），环境变量照样写进进程。Windows 的 Run 项经守护进程启动的也是 `main.ts`。纯逻辑的测试在所有系统上跑；起真进程的测试只在 POSIX 上跑（和现有的启动测试一样）。

### 6. 补充（P6-13）：给定的端口只有一条规则

原先三处不一致：`runner.json` 的 `port` 收 1–65535，`DAISY_PORT`（或 `PORT`）不检查范围（低于 1024 的在 Linux 上监听失败，被说成“已被占用”；不是数字的悄悄不用），`daisy start --port` 收 1024–65535。现在统一为 **1024–65535 之间的整数**（`contracts/start-files.ts` 的 `portOk` / `PORT_RULE`），和对外面端口的设置（`ExternalFaceSchema`）一致：Daisy 从不需要 root，普通账户在 Linux 上也监听不了 1024 以下。

- `runner.json` 的 `port` 不在范围内：照第 3 节，这一项不采用并说明，Daisy 照常启动（用派生的端口）。
- `DAISY_PORT` / `PORT` 设了但不合规则（`0` 照旧视同没设）：Daisy 拒绝启动，说是哪个变量、什么值、要什么范围（和 `--port` 的用法错误一样，是主人明说的端口，不能悄悄换成别的）。`daisy doctor` 在 Daisy 没运行时把它报成失败。
- `expectedLocalPort` 只把合规则的值当“指定的”。


## 测试

- `tests/start-settings.test.ts`：三项变成环境变量、相对路径按数据目录；环境变量（新名字、旧名字、`PORT`）优先，空串不算；写错的项一行一个问题且不采用、`runner.json` 坏了不抛；`argvDataDir` 和命令行同一规则；`loadAcpHarnessFile` 坏 JSON / 非数组 / 不存在 / 某几项坏（保留好的）、每个问题一行；**真 `daisy` 子进程**：坏的 `DAISY_ACP_HARNESSES` 下 `--help` 退出 0、标准错误恰好一行、没有堆栈，`status --json` 带 `problems`；只有 `runner.json` 的 `acpHarnesses`、没有环境变量时 `--help` 列出 `acme`、`--agent acme` 不被拒，别的数据目录照旧拒；`doctor` 用 `runner.json` 的 `agentBins` 找到 Claude、端口按“指定的”、文件问题是 ✗ 并说来源；`expectedLocalPort` 的四个来源；**真 Daisy 进程**（只有 `DAISY_DATA`，像自启那样）：用 `runner.json` 的端口（`given`），坏的一项写进日志和 `runtime.json`，好的一项有“acme · 主机登录”，首次启动保留了事先写的 `port`，`daisy status --json` 列出问题。
- `tests/bootstrap.test.ts`：首次启动保留事先写的 `runner.json` 项；后来出现的 harness 下次启动有主机登录身份档，主人删掉的不再建，别的不重复；`bootstrapLocal` 关时不建；第 15 步把已有身份档的 agent 记为给过。
- `tests/examples.test.ts`：示例 README 写了 `runner.json` 的做法。
- 安全审查后加的（先写，`doctor` 的两条在修改前的代码上失败）：相对路径的命令被拒（`agentBins`、`launch.command`）、doctor 不执行按自己目录解析的相对路径；别人可写 / 别人的 `runner.json` 和 harness 文件不用、doctor 不执行其中的命令；`daisy start` 的子进程和后继进程不带从文件来的值；`--data-dir` 最后一个算数、空值是用法错误，命令行本身同样；解析错误不含文件内容；`agentBins` 的未知键不采用、额外文件的 id 算已知。
