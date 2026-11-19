# ADR-140：macOS 完整支持（P5-04）——进程管理、登录时自启（launchd）、终端、数据目录，清零“尚未支持”

- 日期：2026-11-17
- 状态：**已实施（分支 `p5-04`，待合入 `daisy-next`）**
- 来源：P5-04；P0-03 第 4 项（`docs/research/harness-platforms.md`）；真机检查发现的钥匙串问题（ADR-133）
- 相关：ADR-102（数据目录与端口）、ADR-104 / ADR-106（退出码 75、进程组）、ADR-112（命令行与安装，第 4 节开机自启）、旧版的约定（Codex 停止时终止本轮的命令；沙箱留下的孤儿）、设计要求（macOS、Windows 上“问”的只读只能靠 harness 自己的模式，如实声明）

## 背景

阶段 1–4 的进程管理按 Linux 写：读 `/proc` 的地方在 macOS 上要么直接报错（测试里 `scandir '/proc'`），要么静默什么都不做（`transport.ts` 停一轮时只杀进程组，跑出组的后代不管；`sandbox-reap.ts` 在非 Linux 上返回空表）。开机自启只有 systemd 用户单元，macOS 上 `daisy autostart` 说“尚未支持（P5-04）”。`tests/platform-pending.json` 里 macOS 有 21 个“尚未支持”标记。

真机检查发现的钥匙串问题（ADR-133）又给了一个必须用 macOS 自己机制的理由：从受限（沙箱）shell 里起的 Daisy 及其子进程读不到登录钥匙串，Claude 订阅登录就像过期了一样；launchd 在主人的登录会话（`gui/<uid>` 域）里起的进程读得到。

## 决定

### 1. 进程表：一处读，Linux 用 /proc，macOS 用 ps

新模块 `platform/proc-table.ts`：`readProcTable()` 一次读出所有进程的 pid / ppid / pgid / 起始时间 / 短名 / 是否僵尸——Linux 读 `/proc/<pid>/stat`，macOS 跑一次 `ps -axo pid=,ppid=,pgid=,state=,lstart=,ucomm=`（`LC_ALL=C`、`TZ=UTC`，`lstart` 换成毫秒）；`commandLines(pids)`（Linux `/proc/<pid>/cmdline`，macOS `ps -ww -o pid=,command= -p …`）；`processName(pid)`（Linux `/proc/<pid>/comm`，macOS `ps -o ucomm=`）；`descendants()`。Windows 返回空（P5-05）。

“起始时间”用来认出“还是不是当初那个进程”：Linux 是时钟节拍，macOS 是到秒的 `lstart`。macOS 上同一秒里同一个 pid 被复用、又恰好是同一棵树里的，分不出来——接受（同 ADR-106 对组号复用的取舍）。

逐处处理（`grep -rn "/proc/\|platform === \"linux\"" packages/`）：

| 位置 | 原来（macOS 上） | 现在 |
| --- | --- | --- |
| `turns/transport.ts` `stop()` | 只杀进程组；离组的后代不管 | `processTree(child.pid)`：组员 + 按父进程找到的全部后代（带起始时间），SIGTERM、1.5 秒后 SIGKILL，等它们都退（僵尸不算）；macOS 每 100 ms 看一次（一次 `ps`），Linux 每 20 ms |
| `platform/process-groups.ts` | `procInfo` 已有 ps 分支；`members` / `procTable` 各自一份 ps 解析 | 都改用 `readProcTable()`；`processTree` 的“自己和祖先不碰”从同一张表算（macOS 上不再一个祖先一次 `ps`）；新增 `aliveInTree()` |
| `platform/sandbox-reap.ts` `readProcs` | 非 Linux 返回空表 | 用 `readProcTable()` + `commandLines()`。macOS 上 Codex 的沙箱是 Seatbelt（`sandbox-exec` 套上配置后原地 exec），命令和 Codex 之间没有留下的包装进程，找不到 `bwrap` 是**事实**而不是跳过：terminate 本身就结束了命令 |
| `update/upgrade.ts` `supervisedBySystemd`、`update/restart.ts` `supervision` | 父进程名读 `/proc/<ppid>/comm`（macOS 抛错被吞） | `processName(process.ppid)` |
| `update/restart.ts` `supervision` | launchd 只认旧版启动脚本（launch.sh）的标签 | 新增：`DAISY_LAUNCHD_LABEL` 是我们的标签（`ai.daisy.daisy[-<8 位哈希>]`）且父进程是 launchd（pid 1）→ `supervised: true, manager: "launchd", unit: <标签>`。两个条件都要：后台进程也会被过继给 pid 1，但 `daisy start` 从它的环境里删掉了这个变量。实测：launchd 在任务进程里设的 `XPC_SERVICE_NAME` 是 `0`，不能用 |
| `update/autoupdate.ts` `ownUnit` | 读 `/proc/self/cgroup`（macOS 抛错被吞） | 只在 Linux 读；macOS 的标签从上面那个变量来 |
| `access/shared-host.ts` | 只看 `dscl . -list /Users` | 另外看 `ps -axo uid=`：有别的 ≥ 501 的账户在跑进程也算共用（对应 Linux 的 /proc 一看，抓目录服务 / 移动账户） |
| `access/peer.ts` | 已经用 `lsof`（ESTABLISHED、本账户、不是自己） | 核对过，不改；`tests/access.test.ts` 的真子进程用例在 macOS 上通过 |
| `platform/read-only.ts`、`turns/worker.ts` `readOnly` | Bubblewrap 只有 Linux 有 | 不改：能力声明 `workspaceAccess.readOnly: false`，强制只读会话拒绝、绝不降级为可写（见“打折扣”表） |
| `cli/local/*`、`platform/autostart.ts` | 自启 / 托管只有 systemd | 见第 2 节 |

### 2. 登录时自启：每用户 LaunchAgent（`platform/launchd.ts`）

- `daisy autostart on` 写 `~/Library/LaunchAgents/<标签>.plist`（0644，launchd 拒绝组 / 其他可写的 plist），标签默认数据目录是 `ai.daisy.daisy`，显式数据目录是 `ai.daisy.daisy-<数据目录哈希前 8 位>`（与 systemd 单元名同规则）。不要 root、不是系统守护进程。内容：
  - `ProgramArguments`：Daisy 进程本身（`node --import <quiet> --import <tsx> main.ts`，与 systemd 单元的 `ExecStart` 同一个 `serverCommand()`）；`WorkingDirectory` 安装目录；
  - `EnvironmentVariables`：`PATH`（`autostart on` 时的绝对路径项，同单元）、`DAISY_LAUNCHD_LABEL`、显式数据目录时 `DAISY_DATA`；不写端口（ADR-102）；
  - `RunAtLoad`；`KeepAlive { SuccessfulExit: false }`：崩溃或非零退出（75：更新或主人要求的重启）再起，`daisy stop`（SIGTERM → 退出 0）不再起；`ThrottleInterval` 10；`ExitTimeOut` 45（同 `TimeoutStopSec`）；`Umask` 077；`ProcessType Standard`；
  - `StandardOutPath` / `StandardErrorPath`：`<数据目录>/logs/daisy.log`（与后台进程同一个文件）。`on` 先建好 0700 的 `logs/` 和 0600 的日志文件（launchd 自己建会是 0644）。
- `on` 还 `launchctl enable gui/<uid>/<标签>`（清掉 `launchctl disable` 留下的覆盖）；**不启动**它（同 systemd 的 enable ≠ start）。如果旧的 plist 已载入且没在跑，先 `bootout`，下次 `daisy start` / 登录载入新的。
- `off`：删 plist；载入但没在跑的顺手 `bootout`；正在跑的不动（“这一次的 Daisy 还在运行，由 launchd 托管，到 `daisy stop` 为止”）。
- `daisy start`（plist 在）：没载入 → `launchctl bootstrap gui/<uid> <plist>`（`RunAtLoad` 起它）；已载入 → `launchctl kickstart gui/<uid>/<标签>`。gui 域不在（只有 ssh、没人登录桌面）时报错并说怎么办：登录桌面后再 start，或 `autostart off` 后以后台进程方式启动。`--port` 被拒（端口由 plist 决定）。
- `daisy stop`：载入着就 `launchctl bootout gui/<uid>/<标签>`（launchd 发 SIGTERM，45 秒后 SIGKILL），等进程退出；卸载后 launchd 不会再起它，直到下次 `daisy start` 或登录。
- `daisy status`：托管方式 `launchd（<标签>；日志 <文件>）`；开机自启 `已开启（launchd 登录项 <标签>，在你登录后启动）`；`--json` 的 `managedBy: "launchd"`、`autostart.manager`。
- `daisy uninstall`：经 launchd 停 → 删 plist → 核对 plist 不在、没载入、没在跑（卸载后不留后台进程和自启动项）。
- 网页设置（`settings.autostartStatus / autostartSet`）走同一套逻辑：`manager: "launchd"`、`unit: <标签>`、开着时 `hint` 说明“在你登录后由 launchd 启动；在你的登录会话里运行，钥匙串才读得到”。
- 推荐路径（钥匙串问题，ADR-133）：macOS 上不开自启时 `daisy start` 起的是后台进程，启动后多打一行“建议：macOS 上用 `daisy autostart on` 交给 launchd……”；Claude 钥匙串读不到的提示（ADR-133）也改为建议先 `autostart on`。不开自启时**不**偷偷经 launchd 启动（那等于替主人装了登录项）。
- “开机”在 macOS 上是“登录后”：LaunchAgent 在主人登录图形界面时载入。没有 linger 的对应物；要开机不登录就跑得用 LaunchDaemon（root），不做。

### 3. 终端窗口与数据目录

- 终端的伪终端桥（`turns/terminal-pty.py`，Python `pty.fork`）在 macOS 上可用：真 tty（`/dev/ttys*`）、窗口大小与调整、输入、退出码、停止时整组结束——新测试 `tests/terminal-pty.test.ts` 在 Linux 和 macOS 上都跑。macOS 的 pty 在程序退出后读到 EOF（Linux 是 EIO），两种都结束循环。依赖 `python3`（macOS 的命令行工具自带 3.9）。
- 数据目录：`tests/cli-local.test.ts` 的真进程用例在 `daisy start` 后遍历数据目录，所有目录与文件都没有组 / 其他权限位（目录 0700、文件 0600），macOS 上通过。

### 4. 测试：清零 macOS 标记

21 个 darwin 标记全部去掉（`tests/platform-pending.json` 的 `darwin: []`），逐个：

| 标记 | 原因 | 怎么修 |
| --- | --- | --- |
| adapters 1、filesystem 2、identity-switch-rules 1、process-restart（takePrepared）1、title-sync 1 | 临时目录 `/var → /private/var`，产品按设计返回 realpath，测试拿未解析的路径比 | 测试里 `realpathSync(mkdtempSync(…))`；title-sync 是 Claude 按物理 cwd 命名项目目录 |
| rewind-files-fallback 7 | 6 个是**产品缺陷**：文件检查点把 cwd 换成 realpath 后，harness 按给它的 cwd 报的路径（`/var/…`）被判成“工作区外” | `TurnCheckpoint` 另记 harness 拿到的 cwd，`workspacePath` 两个基准都认（`turns/file-checkpoints.ts`）；第 7 个是测试比较 realpath |
| live 3、session-delete 2 | 测试读 `/proc/<pid>/environ` 找 agent 进程 | `tests/fixtures/proc-env.ts`：macOS 用 `ps -axE`（本账户进程的启动环境） |
| scheduler-review（只读的 bash 工具） | Bubblewrap 只有 Linux 有 | Linux 上照跑；macOS 上 `skip` 并写明原因；新增一条 macOS 用例：只读执行被拒、不降级为可写 |
| prompt-off-chain | 基线快照没跟上阶段 4 有意加的 A2A 工具；macOS 上没有强制只读会话；worktree 路径是 realpath | 快照按阶段 4（P4-07、ADR-127）有意的改动手工补了 `agents` / `call_agent` / `call_result`（只改普通、续接、独立分支几项，测试头注释写明）；节点声明没有只读时不比较两个只读项，审计计数相应减 2；归一化也替换 realpath。Linux 的同名标记保留：只读两项要在有 Bubblewrap 的 Linux 上量过才能动 |

另：测试永远碰不到主人的 launchd / systemd——测试的 `testIo` 不再真的运行 `launchctl` / `systemctl` / `loginctl`（没被假冒时当“没装”）；产品里服务端的 `processHost()` 和命令行的 `io.exec` 在 `node --test` 之下（测试运行器给每个测试文件设 `NODE_TEST_CONTEXT`，测试起的 Daisy / `daisy` 继承它）同样把这三个当“没装”（`blockedUnderTest`）。要它们的测试传假的（`autostartHost`、`testIo`）。launchd 的测试（`tests/autostart-launchd.test.ts`）用假 `launchctl`：`bootstrap` 读 plist，按其中的 `ProgramArguments` / 环境 / 工作目录 / 日志真的起 Daisy，`bootout` 发 SIGTERM 并卸载——所以“plist 写的东西能把 Daisy 起来”是被测过的；在 macOS 上另用 `plutil -lint` 校验 plist。

### 5. 两个 macOS 上偶发的测试

- `tests/identity-switch.test.ts`：测试直接往 `jobs` 插一行 `running` 的假任务来造“忙”，但没有租约（`lease_until` 默认 0）；队列的回收（`reap`）下一拍就把它当“执行节点失联”结掉。负载高时这一拍落在插入和换身份请求之间，换身份就通过了（期望 409 得到 200）。测试时序问题：假任务带上 10 分钟租约，像真的一样。
- `tests/runner-autoupdate-e2e.test.ts`：**产品问题**。测试每一阶段结束用 SIGTERM 停整个进程组；自动更新每 0.5 秒看一次 GitHub，停的那一刻正在跑的 `git fetch` 被一起杀掉，于是记成“更新失败（第 4 次，8 分钟后重试）”写进 `update.json`；下一阶段启动的进程遵守这 8 分钟退避，150 秒内根本不去看 C5，超时。负载越高 git 越慢，撞上的概率越大。真实环境里同样会发生（服务管理器停 Daisy 时正好在查更新，就白白背上退避）。修法：`AutoUpdate.stop()`（Runner 的中止信号触发）；后台的查看 / 构建失败先等 1 秒再记，那时如果进程已在停止，只记一行“被打断，不算更新失败”，不计次数、不设退避。

## macOS 打折扣

| 功能 | Linux | macOS | 怎么体现 |
| --- | --- | --- | --- |
| 强制只读（Daisy 自己的只读层） | Bubblewrap，内核强制 | 没有；只读用 harness 自己的模式（如实声明） | 能力声明 `workspaceAccess.readOnly: false`；强制只读会话被拒、不降级；测试 `skip` 写明原因 |
| “开机即启动、不用登录” | systemd linger | 没有对应物：LaunchAgent 在登录后启动 | `daisy autostart on` / 网页设置都说“在你登录后启动” |
| 进程身份（pid 复用） | 时钟节拍 | 到秒 | 见第 1 节，接受 |
| 读别的进程的环境（只在测试里用） | `/proc/<pid>/environ` | `ps -E`：只看得到本账户、非系统二进制的 | 测试夹具；产品不用 |
| 终端 | Python pty | 同（要 `python3`） | — |

## 后果

- macOS 上安装形态和对话的真机检查可以按 launchd 重做（真机检查加了“重启机器后自启”的 macOS 版）；`daisy start` 在开着自启时经 launchd，读得到钥匙串。
- 依赖 launchd 行为的地方（`bootout` 等进程退出、`KeepAlive` 对退出码 75 再起、登录时载入）只在假 `launchctl` 上测过；真 launchd 上由维护者在 macOS 上做“重启机器后自启”的真机检查确认。实测过一次探针任务（不是 Daisy）：`bootstrap` 立即按 `RunAtLoad` 起、`print` 的 `state` / `pid` 格式、`Umask` 生效、`XPC_SERVICE_NAME` 在进程里是 `0`、launchd 建的日志是 0644。
- 新增 `settings` 接口的描述文字（`docs/api` 重新生成），接口本身不变。
