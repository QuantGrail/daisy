# ADR-112：`daisy` 命令行与 Linux 上的安装、自启、卸载

- 日期：2026-11-17
- 状态：**已实施（P1-07、P1-09），待抽查**（非安全工作包，按施工流程的约定只抽查）
- 工作包：P1-07（命令行）、P1-09（安装、自启、卸载，Linux）
- 相关：设计要求——入口等价（命令行、本地网页、本机接口三者能力一致）、小而可删（一个进程、一个数据目录，卸载后不留后台程序和自启动项）、每条错误信息说明出了什么事、怎么解决；终端安装、终端控制；命名决定：npm 前缀 `@daisy-ai`；`docs/guide/zh-CN/install.md`、`docs/guide/zh-CN/commands.md`；ADR-102（数据目录与端口）、ADR-104（更新与重启）、ADR-106（一个进程、启动器）、ADR-107（接口定义与命令行元数据）、ADR-110（本机认证、运行时文件）

## 背景

P1-06 把每条本机接口的命令行元数据放进了定义表（`cliCommands` / `cliTree` / `cliHelp`），P1-03 给了命令行的凭据（`keys/cli-credential`）和运行时文件（`runtimeFile(dataDir())`，本机面地址、凭据文件路径）。还缺：一个能装、能跑的 `daisy` 程序；不经接口的本地命令（启动、停止、自检、自启、卸载……）；把它装到一台 Linux 机器上的办法。

## 决定

### 1. 命令树 = 本地命令 + 定义表生成的命令

- 源码在 `packages/daisy/bin/daisy.mjs` + `packages/daisy/src/cli/`。P1-07 时还在旧的 `services/` 目录下、按相对路径引用核心（没有新增 workspace 包，免得改 `package-lock.json`）；按 ADR-103，目录搬家是 P1-02b 的事，P1-02b 已搬。
- 顶层命令 = `LOCAL_COMMANDS`（契约里登记的 8 个：`start`、`stop`、`status`、`open`、`update`、`doctor`、`uninstall`、`autostart`，实现在 `packages/daisy/src/cli/local/`）+ `cliTree(API_ROUTES)` 的各组（`access`、`approval`、`attachment`、`client-build`、`login`、`notify`、`profile`、`prompt`、`restart`、`session`、`whoami`、`workspace`，合入 P1-05 后加 `pin`）。ADR-107 第 3 节的合并规则保证两者不撞名、每条命令都是叶子；测试另外检查 `LOCAL` 的实现恰好是 `LOCAL_COMMANDS`。
- 帮助全部来自定义：叶子命令 `--help` 是 `cliHelp(meta)` 加命令行自己的通用选项；一组命令（`daisy session`）列出它的叶子和摘要；顶层 `daisy --help` 列本地命令和各组。只有两组加了手写的“怎么串起来”的说明（`login`、`session`）。
- 全局选项 `--data-dir <目录>`（等同 `DAISY_DATA`，ADR-102 写的 `daisy start --data-dir` 做成了对所有命令有效），`-V/--version`，`-h/--help`，`daisy help <命令…>`。

### 2. 本地命令怎么管进程

一律从运行时文件找 Daisy（端口按 uid 派生、被占会换，所以不猜端口），进程号还活着且 `GET /api/health` 回答才算在运行。命令行从不读写数据库；本地命令只碰进程和文件（日志、systemd 单元）。

| 命令 | 做法 |
| --- | --- |
| `start` | 已在运行 → 说明地址和进程号、退出 0。开着自启（单元文件在）→ `systemctl --user start <单元>`，由 systemd 托管（崩溃和退出码 75 的重启、更新由它拉起）。否则 → **直接起一个后台进程** `node --import <tsx> packages/daisy/src/main.ts`（`detached`，输出追加到 `<数据目录>/logs/daisy.log`，0600，超过 10 MB 时轮换一次），环境里去掉 `INVOCATION_ID` / `JOURNAL_STREAM`、设 `HARBOR_RUNNER_SELF_RESTART=0`：它知道自己没人托管，重启请求会被拒绝并说明怎么做（ADR-106 第 3 节），而不是退出后再也起不来。等到运行时文件里是这个进程、健康检查通过才返回；进程提前退出就把日志最后几行连同原因一起报出来。`--port` 设 `DAISY_PORT`（被占就报错，不悄悄换）；`--foreground` 在当前终端前台运行（调试，或交给别的服务管理器）。启动后查 PIN，未设置就醒目提示（PIN 未设置时不启动任何 AI 轮次） |
| `stop` | 由 systemd 托管 → `systemctl --user stop`；否则先确认进程是这个 Daisy（回答健康检查，或命令行是 `main.ts`），再发 SIGTERM，最多等 60 秒（进程自己：结束正在运行的一轮 20 秒 + 排空 5 秒）。正在运行的一轮标为中断、不重放（不重放副作用） |
| `status` | 是否在运行、进程号、版本、数据目录、本机面地址与端口来源、对外面（`GET /api/access`）、网页口令、托管方式、开机自启（含 linger）、PIN（`GET /api/pin`；未设置时醒目提示“先 daisy pin set，否则 AI 不会开始工作”）、更新（`GET /api/update`）。`--json` 给脚本和 AI。退出码 0 在运行、3 没在运行 |
| `open` | `POST /api/web/open-code`（`--external`：先要 PIN，`POST /api/web/open-code/external` 带 `daisy-pin-grant`），然后在浏览器里打开回答里的 `url`。没有图形界面、经 SSH 登录、`--print` 或 `--external` 时只打印；经 SSH 时附上 `ssh -N -L` 隧道的写法 |
| `update` | 看：装在磁盘上的版本（`.release`）、正在运行的版本、等着换上的版本和它在等什么、自动更新状态、这种安装方式下怎么拿新版本。`--apply` = `POST /api/update/restart {mode:"idle"}`；`--now` 先拿到 409 的打断清单，输入 `yes` 才带 `confirm` 重发；`--cancel` = `DELETE`。重启这一组接口本身是表里的 `daisy restart status|request|cancel` |
| `doctor` | 只读自检：Node 版本（≥ 24）、数据目录（属主、读写、0700）、本机凭据文件（0600）、Daisy 是否在运行、PIN、端口是否空闲（没在运行时）、网页是否构建、三家 harness 是否安装（`--version`）和登录（只跑它们自己的只读状态命令：`claude auth status --json`、`codex login status`，只报“已登录 / 没登录 / 订阅还是 API key”，不读凭据文件、不打印账号；Kimi 没有只读查法，如实说）、开机自启。有 ✗ 退出码 1 |
| `autostart on\|off` | 见第 4 节。不带参数看状态 |
| `uninstall` | 见第 5 节 |

### 3. 定义表生成的命令怎么跑（`packages/daisy/src/cli/table.ts`）

一个通用的执行器，没有按命令写的代码（唯一例外：`pin set` 的新 PIN 输两次、Daisy 说要旧 PIN 时再问一次）。

- **参数**：位置参数按定义（默认路径参数），其余字段是 `--kebab-case` 选项；类型按字段的 JSON Schema 转：数字、整数、布尔（`--x`、`--x false`、`--x=false`、`--no-x`）、枚举（不在取值里就报错并列出可选值）、`null`、对象（JSON）、数组（重复选项，或给一个 JSON 数组）。位置参数写 `-` 从标准输入读整段文字（发长消息）。`--` 之后都算位置参数。缺参数、多参数、未知选项、类型不对，都说明哪里不对、正确写法是什么，退出码 2。
- **`--json`**：请求体不是普通对象的命令（`rawBody`）必须用它给整个请求体；其余有请求体的命令可以用它给一个基础对象，再由选项覆盖。`--json @文件`、`--json -`（标准输入）也行。
- **凭据**（`source: prompt`）：从不回显的提示读，标准输入不是终端时读下一行；命令行里写了值（`--code=…`、`--code …`、或放进 `--json '{…}'`）一律拒绝并说明“只写 `--code` 不带值，会提示你输入”。必填的凭据总会问；可选的（`--api-key`）写了不带值的选项才问。读到的值只进请求体。
- **文件**（`source: file`）：选项给路径，发送内容的 base64。
- **幂等键**：`idempotent` 的命令自动生成 UUID 填进定义里的字段（`requestId`，终端输入是 `id`）；`--idempotency-key` 可以指定，连不上时错误里会给出这次的键，用它重发不会重复执行（不重放副作用）。
- **PIN**：`pin: true` 的命令先提示输入 PIN（不回显），`POST /api/pin/grant {pin}` 换授权，放在请求头 `daisy-pin-grant` 里发这一个请求，用完即弃——不缓存、不打印、不写文件（local-api.md 第 6 节；PIN 授权绑定持有者 `cli`，ADR-110）。
- **回答**：JSON 原样缩进打印到标准输出（AI 和脚本好读）；二进制（附件、安装包）用 `--output <文件>` 保存，标准输出不是终端时直接写出，是终端时拒绝。
- **错误**（`packages/daisy/src/cli/errors.ts`、`daisy.ts`）：每条都是“✗ 出了什么事 / 怎么办：怎么解决”。“出了什么事”用服务端的 `error`（带 `details`）；“怎么办”按服务端的 `code` 选（`unauthenticated` → 检查数据目录或重启；`pin_not_set` → `daisy pin set`；`channel_not_allowed` → 去网页上做；`route_not_defined` → 命令行和 Daisy 版本不一致；`restart_unavailable` → 交给 systemd……），没有 `code` 时按状态码（404 → 用 list 命令查 id；5xx → 日志在哪）。没在运行、运行时文件过期、连不上，都说“先运行 daisy start”，退出码 3。凭据、PIN、授权、一次性口令都不出现在错误和输出里（一次性链接是 `daisy open` 的输出本身，本地网页的口令设计就是打印一条带一次性口令的链接）。
- **契约的一处补充**：`CliCommandMeta` 加 `output: "json" | "binary" | "websocket"`（回答的种类），命令行据此决定打印还是保存。

### 4. 开机自启：systemd 用户单元（P1-09）

- `daisy autostart on`：确认能连上自己的 systemd 用户实例（`systemctl --user show-environment`），写 `$XDG_CONFIG_HOME/systemd/user/<单元>`（默认 `~/.config/systemd/user/daisy.service`），`daemon-reload`、`enable`。**不用 root、不装系统服务**。单元内容：`Type=simple`；`ExecStart` 直接跑 Daisy 进程（`<node> --import <tsx> …/main.ts`，不经包装程序，systemd 就是托管者）；`WorkingDirectory` 是安装目录；`Environment=PATH=…` 取运行 `autostart on` 时的 PATH（只留绝对路径，补上 node 所在目录和系统目录），这样开机时也找得到装在 `~/.local/bin`、nvm 目录里的 harness；`Restart=on-failure` + `RestartForceExitStatus=75`（更新、主人的重启，ADR-104）；`KillMode=mixed`（SIGTERM 只给 Daisy，让它先结束一轮、排空，剩下的子进程在它退出后再杀——旧单元用的 `control-group` 会同时杀掉 harness，来不及收尾）；`TimeoutStopSec=45`；`UMask=0077`；`WantedBy=default.target`。按 ADR-102 不写端口、`HOST`、用户；数据目录只在主人显式指定时（`--data-dir` / `DAISY_DATA`）写 `Environment=DAISY_DATA=…`，这时单元名是 `daisy-<数据目录 SHA-256 前 8 位>.service`，同一账户的两个 Daisy 不共用单元。路径里的空格、`%`、`$` 按 systemd 的规则转义。
- **linger 不自动打开**：用户单元默认在主人登录后才启动；要“开机即启动、不用登录”（服务器重启后自己起来的情形）需要 `loginctl enable-linger <用户>`。它是 logind 的账户设置，在有的系统上还要管理员授权；按“不改系统设置”的约束，`autostart on` 只检查并醒目提示这一条命令，`status`、`doctor` 也显示。
- `daisy autostart off`：`disable`、删除单元文件、`daemon-reload`。正在由这个单元运行的 Daisy 不停（停是 `daisy stop` 的事），下次开机不再启动。
- 开着自启时 `daisy start/stop` 经 systemd；`autostart on` 时已有一个后台进程在跑，就提示“`daisy stop` 再 `daisy start` 交给 systemd”，不擅自打断它。
- macOS、Windows：`autostart` 明确回答“尚未支持（P5-04 / P5-05）”和现在怎么办（手动 `daisy start`），退出码 1。
- **网页也能开关（入口等价，应 P1-08 的设置页）**：定义表加两条，`settings.autostartStatus`（`GET /api/autostart`）和 `settings.autostartSet`（`PUT /api/autostart {enabled}`），回答 `{ supported, enabled, manager: "systemd-user"|"launchd"|"task-scheduler"|null, unit?, reason?, linger?, hint? }`（`AutostartViewSchema`）；`daisy:manage`、不要 PIN、主人的三个通道、AI 不开放。服务端（`packages/daisy/src/app/autostart.ts`）和 `daisy autostart` 用同一个模块 `packages/daisy/src/platform/autostart.ts`（原来在命令行包里，为此挪进核心；命令行从那里引用），作用于这个进程的数据目录。macOS、Windows 回答 `supported: false`、`manager: null` 和“尚未支持（P5-04 / P5-05）”，开启请求也是同样的回答（不报错）；Linux 上 systemctl 失败回 409 `autostart_failed`，消息里带怎么办。
- **选择：`autostart` 留在 `LOCAL_COMMANDS`，这两条接口的 `cli` 写 `exempt("由本地命令 daisy autostart 提供……")`**，不改由定义表生成：开机自启是在 Daisy 没在运行时最需要设的东西（装好、还没启动就想打开；卸载时 Daisy 已经停了还要关掉），而表生成的命令要连上正在运行的 Daisy 才能用。两边共用一套逻辑，所以网页和命令行的结果一样（测试：网页开、命令行看到已开；命令行关、网页看到已关）。

### 5. 卸载（不留后台进程和自启动项）

`daisy uninstall`（`--yes` 跳过确认）：停止 Daisy → `autostart off` → 复查（运行时文件里的进程不在、单元文件不在、没启用、没在运行），有残留就报错列出；最后告诉主人**数据目录保留在哪**、要删用 `rm -rf "<目录>"`、命令本身用 `npm uninstall -g @daisy-ai/daisy` 卸掉。npm 7 起不再运行卸载钩子，所以“去掉自启动项”只能靠这条命令，安装文档把两步写在一起。

### 6. 安装包（P1-09）

- `scripts/pack-daisy.ts`（`npm run pack:daisy`）在临时目录拼出包，再 `npm pack`，**不发布**：`package.json` 是 `private: true`，误敲 `npm publish` 也会被 npm 拒绝。包名 `@daisy-ai/daisy`（命名决定：npm 前缀 `@daisy-ai`），`bin: { daisy: "packages/daisy/bin/daisy.mjs" }`，`engines.node >= 24`。
- 包里保持仓库里的路径：`packages/daisy/src`（含 `.py` 等非 TS 文件）、`packages/daisy/bin`、`packages/contracts/src`（P1-02b 之前在旧的 `services/` 目录下）、`apps/app/dist`（构建好的网页；`--no-web` 可省）。不带：测试、脚本、App 源码、私有插件包（不在公开仓库；不装它 Daisy 照常运行）、`_phase4` 的停放代码。
- 依赖由扫描打进包的代码的导入得出（新增导入不会漏），版本取根 `package.json`，另加 `tsx`（运行 TypeScript）。导入了根 `package.json` 里没有的包，打包直接失败。
- `.release` = `<版本>+<12 位提交>`。有它的目录是“安装版”（autoupdate.ts `installed`），git 自动更新不碰它；由 systemd 托管时，`npm install -g` 新的 tgz 改了 `.release`，`upgrade.ts` 在完全空闲 60 秒后自己重启换上（ADR-104），后台进程方式的要 `daisy stop`、`daisy start`。
- `bin/daisy.mjs` 先检查 Node 版本（旧 Node 得到一句话而不是语法错误），再注册 tsx、载入 `src/main.ts`。
- 全局安装要 root 的机器上不用 sudo：`npm config set prefix ~/.local`（`docs/guide/zh-CN/install.md`）。

### 7. `daisy login` 的选择

设计要求写“`daisy login`：登录某一家 harness 或配置 API key”，定义表里是 `login start|list|show|input|cancel` 一组。**选了“`login` 作为一组命令保留，帮助里给出流程”**，不做交互程序：① 叶子规则（ADR-107）：`login` 已经是一组，再让它自己也能运行会出现“又是叶子又有子命令”；② 网页的“设置 → 登录”是第一次使用时的主路径（第一次使用的第 4 步），交互程序会把同一流程再写一遍；③ 每一步都是表里的命令，AI 和脚本能一步步调用（入口等价），授权码照样不回显。`daisy login`（不带子命令）列出子命令和六步流程：`workspace catalog` → `profile create-managed` → `login start` → `login show`（授权地址）→ `login input`（提示输入授权码）→ `login show`；API key 用 `profile create --auth-mode apiKey --api-key`（提示输入）。

## 偏离

- ADR-102 写运行时文件优先放 `$XDG_RUNTIME_DIR/daisy/`；P1-03 实际放在数据目录（`runtime.json`），命令行照它读，进程号已死时当作没在运行。
- ADR-102 写单元里不写数据目录：默认数据目录确实不写；显式指定的数据目录必须写，否则开机起来的是另一个 Daisy。
- 设计里建议的 `daisy token`（给第三方 A2A 客户端签令牌）属于阶段 2 / 4，阶段 1 没有对应接口，没做。
- `daisy pin set|status|reset` 来自 P1-05 的定义表，合入 `daisy-next` 后自动出现；`pin set` 新 PIN 输两次、已设置过时按服务端的 `pin_old_required` 再问旧 PIN；`pin reset` 只在命令行（`channels: ["cli"]`）、要 `--confirm`、不要 PIN。命令行的 PIN 授权一次有效（ADR-110 M-3），本来就是每条要 PIN 的命令现场换一张。P1-05 服务端两句提示里“命令行尚未提供”的说法改成了现在的命令（`packages/daisy/src/access/pin.ts`）。

## 后果

- 新增一条接口：写定义，命令行自动有它，帮助、参数、凭据读取、幂等键、PIN 都跟着定义走；不用改命令行。
- 主人在终端上：`npm install -g <tgz>` → `daisy start` → `daisy pin set` → `daisy open`。
- 测试：开机自启的两条接口与命令行共用逻辑、各系统的回答在 `tests/cli-local.test.ts`；`tests/cli-table.test.ts`（表驱动：每条生成命令的帮助、参数解析 22 例、`--json`、标准输入、幂等键、凭据、PIN、错误映射、没在运行、下载、文件）、`tests/cli-local.test.ts`（每条本地命令；真实进程的启动 / 停止 / 状态 / 卸载；假 systemctl 下单元文件的内容、启用、删除）、`tests/cli-principle6.test.ts`（入口等价）、`tests/cli-pack.test.ts`（包的内容；`DAISY_TEST_INSTALL=1` 时真的 `npm install -g`）。另有真机检查。

## 后续

1. macOS 的 launchd 代理、Windows 的计划任务或服务（P5-04、P5-05），届时 `autostart` 去掉“尚未支持”。**macOS 已做（P5-04，ADR-140）**：每用户 LaunchAgent `~/Library/LaunchAgents/ai.daisy.daisy[-<哈希>].plist`，`daisy start` / `stop` 经 `launchctl bootstrap|kickstart` / `bootout`，网页设置回答 `manager: "launchd"`。
2. 包名改名（命名决定：内部包名改为 `@daisy-ai/*`）后，旧的包名前缀不再出现；目录搬进 `packages/daisy`（P1-02b）。
3. 错误格式改 RFC 9457（带 `fix`）后，命令行直接用服务端的 `fix`，本地的 `code → 怎么办` 表退为兜底。
4. 发布到 npm（要维护者明确授权）后，安装文档（`docs/guide/zh-CN/install.md`）的安装改成 `npm install -g @daisy-ai/daisy`。

**补记（2026-11-17，真机检查中发现，ADR-133）**：`doctor` 也查 Daisy 托管的 Claude 身份——`runner.json` 的 `nodeId` / `identityRoot`（默认 `<数据目录>/runner`）下有 `.claude.json` 的身份目录，各跑一次 `claude auth status --json`（`CLAUDE_CONFIG_DIR` 指向它，不继承本机的 API key 环境变量），每个一行「Claude 独立登录 <id 前 8 位>」；本机登录那一行也改用与一轮启动检查同一个分类（超时、钥匙串、未登录、程序不存在、其它各有说法，暂时性失败再问一次）。只看结论和 `.claude.json` 里有没有账号记录，不打印账号。
