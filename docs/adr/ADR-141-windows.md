# ADR-141：Windows 原生支持（P5-05）——作业对象收进程树、ConPTY 终端、当前用户启动项、ACL 版“只有你能读”、不经 shell 找命令行

- 日期：2026-11-18
- 状态：**已实施（分支 `p5-05`，基于 `p5-04`；待 Windows CI 与真机验证，待合入 `daisy-next`）**
- 来源：P5-05；设计要求（Windows 原生支持：进程管理、终端窗口、开机自启三处另做）；施工流程的约定（“尚未支持”的 Windows 标记只减不增、P5-05 清零；Windows CI 按预算跑）；P0-03 第 4 项（`docs/research/harness-platforms.md`）
- 相关：ADR-140（macOS：进程表、launchd，本 ADR 在其上扩展）、ADR-112（命令行与安装）、ADR-102（数据目录与端口）、ADR-099 / ADR-108（凭据和数据库文件只有主人可读）、ADR-104 / ADR-106（退出码 75、进程组）

## 背景

阶段 1–4 的进程管理、终端、自启、文件权限都按 POSIX 写：停一轮靠进程组信号（Windows 没有）；终端窗口是 `python3` 的 `pty`（Windows 没有）；自启只有 systemd / launchd；“只有主人可读”靠 0600 / 0700（Windows 上权限位没有意义）；harness 的命令行按名字直接 `spawn`（Windows 上 npm 装的是 `.cmd`，Node 不经 shell 不肯起它，CVE-2024-27980；`#!` 脚本也起不来）。

Windows CI 基线（`daisy-next` 上的一次全量运行）：969 条结果失败 562 条，140 个测试文件里 100 个有失败。几乎所有建 app 的测试都失败，只剩纯函数的测试通过：主因是 `access/secret-file.ts` 按权限位判断凭据文件，Windows 上普通文件是 0666，每次启动都“权限过宽，拒绝启动”。

本机（macOS）不能运行 Windows：Windows 代码都在平台判断之后，纯逻辑在所有系统上单测，需要 Windows 本身的部分写成只在 Windows 上跑的测试，交 Windows CI。

## 决定

### 0. 一个自带的 Windows 辅助程序，不用原生插件、安装时不编译

`platform/windows/daisy-win.cs`：一个 C# 5 文件，**第一次用时**由 Windows 自带的 .NET Framework 4 编译器（`%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，Windows 10 / 11 都有）编译成 GUI 子系统的小程序（`/target:winexe`：自己从不开控制台窗口），放在 `%LOCALAPPDATA%\Programs\Daisy\helper\<源码哈希>\daisy-win.exe`（Windows 约定的“每用户程序”位置，只有本账户能写）。源码变了就编一个新的放在旁边；正在用的不动。`platform/windows/helper.ts` 负责找编译器、编译、缓存；编不出来时记下原因、本进程不再重试。

考虑过的别的做法：

| 做法 | 为什么不用 |
| --- | --- |
| `taskkill /T /F` | 只按父进程号找后代：父进程先退了的孙进程找不到；Daisy 被强行结束时没人去收 |
| 每次用 PowerShell `Add-Type` 现编 | 每次起一个 harness 多 1–3 秒 |
| `koffi` 等 FFI 预编译包 | 给三个系统都加一个原生依赖；而且 Node 起进程不能“挂起创建”，先起后放进作业之间有空档，这期间起的子进程会漏掉 |
| `node-pty` | 原生插件（要编译或预编译包）；而终端只是三处 Windows 差异之一，作业对象、ACL、启动项同样要调 Win32 |
| 仓库里放编好的 exe | 二进制进仓库、没有签名，来历说不清 |

辅助程序的命令：`job`、`pty`、`supervise`、`ps`、`cmdlines`、`acl-set`、`acl-get`、`whoami`、`profiles`、`tcp-owner`、`run-get` / `run-set` / `run-delete`、`path`、`version`（文件头有说明）。

### 1. 进程管理：作业对象（Job Object），KILL_ON_JOB_CLOSE

`platform/spawn.ts` 的 `spawnTree(command, args, options)` 是三个系统同一个调用：Linux / macOS 照旧（`detached`，自己的进程组，ADR-140 的 `processTree`）；Windows 上起的是 `daisy-win job --parent <Daisy 的 pid> --app <程序> --cmdline <命令行>`：

1. 新建作业对象，限制 `KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION`，**不设** `SILENT_BREAKAWAY_OK`；
2. `CreateProcess(…, CREATE_SUSPENDED | CREATE_NO_WINDOW)`，标准句柄就是 Daisy 给辅助程序的管道（harness 直接和 Daisy 说话，不经转发）；
3. 放进作业，再恢复运行——所以 harness 起的任何东西从一开始就在作业里；
4. 等 harness 或 Daisy（`--parent`）先结束；harness 结束时作业里剩下的也一起结束。

为什么这样能收干净（Microsoft Learn，“Nested Jobs”与 `JOBOBJECT_BASIC_LIMIT_INFORMATION`）：

- `KILL_ON_JOB_CLOSE`：作业的最后一个句柄关闭时，作业里所有进程结束。句柄只在辅助程序手里（不可继承）。
- 嵌套作业里，子进程默认属于父进程所在的每一个作业；静默脱离（`SILENT_BREAKAWAY_OK`，Node 的 libuv 给自己起的子进程建的作业就带它）只向上脱离到**第一个不允许脱离的作业**为止——我们的作业不允许，所以 harness 是 Node 程序、它再起子进程，也都留在我们的作业里。
- 什么时候整棵树结束：停止一轮 / 关会话（`child.kill()` 结束辅助程序）；harness 自己退出；Daisy 正常退出或被强行结束——辅助程序是 Daisy 的非 detached 子进程，在 libuv 的全局 kill-on-close 作业里，Daisy 一死它就被结束；另外它也等着 Daisy 的进程句柄，Daisy 先没了就结束作业。
- 停止后的“确认都没了”：Windows 上也有进程表了（辅助程序 `ps`，Toolhelp 快照 + 创建时间，100 ns 精度），`transport.ts` 的等待与 ADR-140 相同。Windows 的父进程号不会清零、会被复用，所以按父进程找后代时，**比父进程早创建的不算**。
- `DAISY_WIN_JOB_BREAKAWAY=1`（默认关）允许作业里的程序用 `CREATE_BREAKAWAY_FROM_JOB` 起脱离作业的子进程——如果某家 harness 的沙箱需要它才能起。脱离的进程只在停止时按父进程找得到，Daisy 被强行结束时会留下。默认不开，见“留给维护者的决定”。
- 辅助程序不可用（编不出来）：harness 直接起，停止时只能按父进程找后代，Daisy 被强行结束时可能留下；日志说一次，`daisy doctor` 报 ✗，能力表写成 `processTree: parent-only`。

**关闭会话不留进程，在 Windows 上**：`tests/windows-platform.test.ts` 两条只在 Windows 上跑的用例——①停止时连“父进程已退出的孙进程”一起结束；②替身 Daisy 被强行结束后，它起的树里没有任何进程活着。

### 2. 终端窗口：Windows 自己的伪终端（ConPTY）

现有终端是 `turns/terminal-pty.py`（Python `pty.fork`），不是 node-pty。Windows 上换成 `daisy-win pty`：`CreatePseudoConsole`（Windows 10 1809+），程序起在作业里、挂在伪终端上（`STARTF_USESTDHANDLES` + 空句柄、不继承句柄，与 node-pty 相同），协议与 `terminal-pty.py` 一字不差（JSON 行：`{"text"}`、`{"cols","rows"}` 进，`{"data": base64}` 出；标准输入关闭 → 结束整棵树、退出码 143）。`terminal.ts` 和 `login.ts`（界面里的登录，原来 Windows 上直接拒绝）都用它。

### 3. 登录时自启：当前用户的启动项（HKCU Run），不用计划任务

`daisy autostart on` 写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `Daisy`（显式数据目录：`Daisy-<数据目录哈希前 8 位>`，与 systemd 单元 / launchd 标签同规则），值是一条命令行（不经 shell）：

```
"…\daisy-win.exe" supervise --name Daisy --log "<数据目录>\logs\daisy.log" --cwd "<安装目录>" [--set DAISY_DATA=…] --app "<node.exe>" --cmdline "<node.exe> --import … main.ts"
```

`supervise`：没有控制台窗口（Daisy 用 `CREATE_NO_WINDOW` 起，它和它的子进程共用一个没有窗口的控制台，不会一闪一闪地弹窗）；输出追加到日志；Daisy 在作业里；退出码 75（更新、主人要求的重启）再起，运行过一分钟之后的非零退出（崩溃）3 秒后再起；0（`daisy stop`）和“一分钟内就失败”（起不来）不再起、带着 Daisy 的退出码结束。它设 `DAISY_WIN_SUPERVISOR=<名字>`，`update/restart.ts` 看到它**且**父进程是 `daisy-win` 才认为“退出后会被拉起”。

- `daisy start`：启动项在 → 起同一条命令（值里的辅助程序路径旧了就顺手改写）；不在 → 同样经辅助程序 `supervise`，同样在 75 / 崩溃后再起（与 P5-06 的“后台进程自己起接班进程”同一目的；守护进程下 Daisy 不再自己起接班进程，`update/restart.ts` 里 `byWindows` 优先于 `respawn`）。`--once` 保留在辅助程序里，不再使用。
- `daisy stop`：Windows 没有能发给无控制台进程的 SIGTERM（Node 在 Windows 上的 `process.kill` 是 TerminateProcess：不排空、这一轮不标中断）。改为写 `<数据目录>\run\stop-request`（内容是 Daisy 的 pid），Daisy 每半秒看一次（只在 Windows 上），照 SIGTERM 收尾、退出 0；别的 pid 的、启动前留下的请求删掉不理。60 秒还没退就报错，并给出 `taskkill /PID … /F`。
- `daisy autostart off` 删值；正在运行的不动。`daisy uninstall` 经 P5-06 的 `autostart-hooks.ts` 的 `windowsHooks`：删值，残留检查看 Run 值和这个数据目录的 `supervise` 进程（卸载后不留后台进程和自启动项），手动删除给 PowerShell 的 `Remove-ItemProperty`。
- 注册表经辅助程序的 `run-get` / `run-set` / `run-delete` 读写，在 `AutostartHost` 上叫 `daisy-win`：测试用假的；`node --test` 之下真的永远不碰（与 launchctl / systemctl 同一个 `blockedUnderTest`）。

为什么不用计划任务：

| | HKCU Run | 计划任务（登录触发） |
| --- | --- | --- |
| 要管理员 | 不要（本账户自己的键） | `schtasks /create /sc onlogon` 要管理员；用 XML 指定只对本账户能否免管理员，本机无法核实 |
| 默认行为 | 登录后启动一次 | 默认“用电池时不启动 / 改用电池时停止”、72 小时后结束，都要逐项改 |
| 窗口 | 由我们的 GUI 辅助程序起，没有窗口 | 同样要一个不开窗口的启动器 |
| 主人看得到、关得掉 | 任务管理器 → 启动应用 | 任务计划程序 |
| 再起 | 辅助程序自己按退出码（与 launchd `KeepAlive`、systemd `RestartForceExitStatus=75` 同义） | 有“失败后重新启动”，但退出码非零算不算失败要再核实 |

“开机” 在 Windows 上同 macOS：是**登录后**。不登录就启动要 Windows 服务（要管理员），不做。

接口：`settings.autostartStatus` 的 `manager` 增加 `windows-run`（去掉阶段 1 预留、从未返回过的 `task-scheduler`），`docs/api` 重新生成。

### 4. 路径、文件权限、“只有你能读”、找命令行

- **只有你能读**：Windows 上 `restrictToOwner` 写受保护的 DACL——只有本账户、SYSTEM、Administrators 完全控制，目录上可继承（之后在里面建的文件自动一样）；`ownerOnly` 读辅助程序 `acl-get` 列出的属主与每一条访问控制项（SID 一律写全——SDDL 会把某些 SID 缩写，例如 RID 为 500 的账户写成 `LA`；Windows CI 第一次运行把刚设好的目录判成“过宽”，推测就是这个原因），由纯函数 `ownerOnlyAcl` 判断：允许项只能是这三者（或只作用于子项的 CREATOR OWNER），属主只能是这三者之一。这三者是 OpenSSH for Windows 对私钥文件的要求，对应 POSIX 上 root 总能读。凭据文件（`readSecretFile`）在 Windows 上按 ACL 判断，过宽拒绝启动（原来按权限位，必然拒绝）；`keys/` 目录建时就收紧。辅助程序不可用：不改、判断结果为“说不清”（接受，日志说一次）——数据目录在默认位置（`%LOCALAPPDATA%\Daisy`，在用户目录下）时，Windows 默认就只有本人、SYSTEM、管理员能进。
- **找 harness 的命令行**（`platform/windows/cmdline.ts`）：只按 PATH × PATHEXT 找，**不找当前目录**（工作区里放一个 `claude.cmd` 不会被执行）；`.exe` / `.com` 直接起；npm（cmd-shim）/ pnpm 的 `.cmd`：读出它要跑的脚本，用旁边的 `node.exe`、PATH 上的 node 或 Daisy 自己的 Node 直接跑——参数不经 cmd.exe，提示词里的 `& | ^ %` 不会被当成命令；别的批处理拒绝并说怎么办；按路径给的 Node 脚本（`.js` / `.cjs` / `.mjs`、或首行 `#!…node`）用 node 跑。命令行引号按 MSVCRT / `CommandLineToArgvW` 的规则（`splitCommandLine` 反向验证）。版本探测、状态检查、标题、回退、登录、`daisy doctor` 都走同一个 `resolveSpawn`。
- **“在终端执行”和后台命令**：Windows 上用 Git Bash（Git for Windows，Claude Code 和 Kimi Code 在 Windows 上也用它；`-lc` 时设 `CHERE_INVOKING=1` 留在工作目录），没有就用 Windows PowerShell，命令经 `-EncodedCommand` 传（不需要任何引号）；永远不用 `System32\bash.exe`（那是 WSL）。
- 其他：工作区路径按本机规则（`C:\…`，大小写不敏感）；Claude Code 的规则路径在 Windows 上写成 `//c/…`（官方文档：Windows 路径先换成 POSIX 形式再匹配）——原来写成 `/C:\…`，只问支线的“不许读凭据目录”规则在 Windows 上会静默失效；盘符根目录和家目录一样不做文件快照；端口按“域\用户名”派生（原来 Windows 上所有账户都是 0 号，派生出同一个端口）；共用机器检查读本机的用户配置列表；本机网页免口令时确认连接的另一端是本账户的进程（TCP 表 + 进程令牌，原来 Windows 上一律要口令）；`daisy open` 打开浏览器不再经 `cmd /c start`（链接里的 `&` 会被 cmd 拆开）。

### 5. 能力声明：做不到、打折扣的如实写、界面上隐藏

`platform/capabilities.ts`：`applyPlatform` 在节点上报 `agentFeatures` 之前去掉这个系统做不到的，`platformReport` 作为 `capabilities.platform` 一并上报（`processTree`、`terminal`、`enforcedReadOnly`、`shell`、`ownerOnly`）。界面、控制面、命令行仍按 P4-11 的能力声明一处读。

| 功能 | Linux | macOS | Windows | 怎么体现 |
| --- | --- | --- | --- | --- |
| 强制只读（Daisy 自己的只读层） | Bubblewrap，内核强制 | 没有 | 没有 | `workspaceAccess.readOnly: false`；强制只读会话被拒、不降级为可写 |
| “问”的只读强度：Claude Code | strong（工具层限制） | strong | strong（工具层限制，不靠沙箱；Claude Code 原生 Windows 没有沙箱） | 能力声明 |
| “问”的只读强度：Codex | strong（只读沙箱） | strong | **weak**：Codex 的 Windows 沙箱取决于系统版本（MXC 要 Windows 11 24H2 的新版本）和管理员的一次设置，`unelevated` 下不支持禁止读取的路径 | `applyPlatform` 把 `readOnly.opts.strength` 改为 `weak`，A2A 名片和“问”的路由按它说 |
| “问”的只读强度：ACP harness | 各家声明（多为 weak） | 同 | 同；Antigravity 的沙箱要 Windows 11 24H2 + 2026-08 更新 | 各家声明，不改 |
| 停止时收整棵进程树 | 进程组 + 按父进程 | 同 | 作业对象（没有辅助程序时只能按父进程） | `capabilities.platform.processTree` |
| 官方命令行窗口 | Python pty | 同 | ConPTY（Windows 10 1809+，经辅助程序）；没有辅助程序时不提供 | 没有时 `terminal: none`，界面不出按钮 |
| 开机自启 | systemd 用户单元（linger 可开机即启） | launchd，登录后 | 当前用户启动项，登录后 | `autostart` 视图说明 |
| 停止 Daisy | SIGTERM | 同 | 停止请求文件（照 SIGTERM 收尾） | — |
| 只有你能读 | 0600 / 0700 | 同 | ACL（你、SYSTEM、管理员）；没有辅助程序时不改、不判断 | `capabilities.platform.ownerOnly` |
| “在终端执行” / 后台命令的 shell | bash / sh | 同 | Git Bash，没有就 PowerShell（写法不同） | `capabilities.platform.shell`；`daisy doctor` 提示装 Git |
| Codex 的后台命令沙箱（`codex sandbox`） | 有 | 有 | 未核实（`codex sandbox` 在 Windows 上的行为） | 留待真机 |
| harness 是批处理文件 | — | — | 只认 npm / pnpm 启动脚本，别的拒绝 | 报错说怎么办 |
| 停止一个 harness 时“温和地” | SIGTERM，1.5 秒后 SIGKILL | 同 | 直接结束（Windows 没有给无控制台进程的温和信号） | — |

各家 harness 在原生 Windows 上都能跑（P0-03 第 4 项），没有遇到“某家只能经 WSL”的情况，不需要停下来问人。Kimi Code 首次启动前必须装 Git for Windows——`daisy doctor` 检查 Git Bash。

### 6. 测试与持续集成

- `tests/windows-platform.test.ts`：纯逻辑 17 条在三个系统上跑（命令行引号往返、PATH × PATHEXT 与 npm 启动脚本、Node 脚本、批处理拒绝、不找当前目录、shell 选择与 `-EncodedCommand`、访问控制判断 14 种、Windows 进程表与按创建时间找后代、`job` / `pty` / `supervise` 参数、启动项经假辅助程序开 / 关 / 状态 / 网页视图、`node --test` 下不碰真注册表、托管识别、停止请求、能力叠加、路径与账户）；6 条只在 Windows 上跑（作业对象收树含孤儿、Daisy 被杀时收树、进程表、ACL 与凭据文件、ConPTY 往返与退出码、辅助程序自身）。
- `tests/cli-local.test.ts`、`tests/storage.test.ts` 里原来的“尚未支持（P5-05）”换成真实期望。
- `tests/fixtures/acp-scenario.ts` 的假 ACP 命令从 `#!/bin/sh` 换成 Node 脚本（三个系统都能跑）。
- `scripts/ci-test.mjs`：`CI_RUN_MARKED=1` 也跑被整文件标记的文件（失败照旧容忍），某个整文件标记的文件全过时报告“这个标记可以去掉”；`scripts/ci-test-reporter.mjs` 给失败带上前 600 个字符的原因（基线只有名字，没有原因）。`.github/workflows/ci.yml` 的手动触发加 `run_marked`、`test_files` 两个输入。
- win32 标记（100 个整文件）本包**没有动**：没有 Windows 机器，不能证明哪个文件已经全过。按下面的 Windows CI 计划跑一次后再逐个去掉。

## 后果

- Windows 上安装形态和对话的真机检查要在 Windows CI 和真机上重做；本包只在 macOS 上跑过（Windows 分支都在平台判断之后），C# 辅助程序在本机**没有编译过**（本机没有 C# 编译器），第一次 Windows CI 就是它的第一次编译。
- 停止 harness 在 Windows 上是“立即结束”，没有 POSIX 那 1.5 秒的温和期。
- Daisy 在 Windows 上多一个本地编译的小程序；有的公司策略（AppLocker / WDAC）会禁止运行本地编译的程序——那时作业对象、终端、自启、ACL 都不可用，`daisy doctor` 报 ✗，能力表如实降级。

## 留给维护者的决定

1. **辅助程序的来源**：本 ADR 选“第一次用时用 Windows 自带的 csc.exe 现编”。替代：发布时随包附一个签名的 exe（要代码签名证书），或换成 `koffi` 之类的预编译 FFI 包。
2. **自启机制**：选 HKCU Run，不选计划任务（理由见第 3 节）。如果要“开机不登录就启动”，只能做 Windows 服务（要管理员），本包没做。
3. **作业对象是否允许显式脱离**：默认不允许（关会话时收得干净；代价是某家 harness 的沙箱若必须 `CREATE_BREAKAWAY_FROM_JOB`，它会起不来、报错可见）。`DAISY_WIN_JOB_BREAKAWAY=1` 可以打开。
4. **Codex 在 Windows 上的“问”定为 weak**：如果维护者确认目标机器都是 Windows 11 24H2 + MXC，可以改回 strong。

## Windows CI 记录

- 第一次（定向 10 个文件）：辅助程序编译通过，作业对象、ConPTY 的用例通过；102 条失败是“只有你能读”的判断读 SDDL（缩写的 SID 对不上）——改为辅助程序逐条列出、SID 写全。
- 第二次（全量 + `run_marked`）：796 通过 / 173 失败（基线 562 失败），143 个文件 90 个全过。共同根因：① Runner 上报的 uid 在 Windows 上是 -1，控制面拒绝每次 `/sync`，节点从不上线（约 100 条端到端“State timed out / did not settle”）——改为账户的稳定编号；② 8.3 短名（`RUNNER~1`）——工作区与文件检查点用原生 realpath；③ 测试里的 Unix 套接字路径（Windows 用命名管道）、权限位断言、读别的进程的环境与命令行（辅助程序 `cmdlines`、假 agent 自报环境）、SIGTERM 期待优雅退出（改用停止请求）、`/` 拆路径、CRLF。win32 标记 100 → 15，留下的每个都写明原因（自动更新的 POSIX 安装方式、Bubblewrap、进程组信号、`#!/bin/sh` 假命令行，以及几处未验证的）。
- 第三次（全量）：966 通过 / 22 失败，145 个文件 132 个全过；剩下的未标记失败都是测试侧或 P5-06 的路径计算，已修。win32 标记 → 8，各写原因。
