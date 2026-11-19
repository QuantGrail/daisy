# ADR-145：安装与更新（P5-06）——npm 安装的 Daisy 自己更新：先备份、等空闲、试运行、失败退回；卸载不留进程和自启动项

- 日期：2026-11-18
- 状态：**已实施（分支 `p5-06`，基于 `p5-04`，待合入 `daisy-next`）**
- 来源：P5-06；维护者的决定（自动更新在备份与退回落地后团队内部默认开；暂只做 npm 安装，三个系统上安装、更新、卸载的命令相同，单文件安装包以后再定）；要求（一条命令装好；升级前有备份、升级后旧数据都在、失败能退回；卸载不留后台进程和自启动项，数据目录保留）
- 相关：ADR-104（更新与重启，A1 + B2 + C1 + D1）、ADR-108（存储：结构只增不删、升级前备份）、旧版的约定（重启等后台任务有上限，`restart-drain.ts`）、ADR-106（单进程、退出码 75）、ADR-112（命令行与安装）、ADR-140（macOS launchd）、P5-05（Windows 开机自启，并行施工）

## 背景

到 P5-04 为止，“更新整个 Daisy”有两条路，都不完整：

- `update/autoupdate.ts`（旧版的 git 检出自动更新）：从 GitHub 的 main 取代码、在 `releases/<commit>/` 旁建、切 `current` 软链、`launch.sh` 的守卫回退。它只服务“代码检出 + 启动器”的旧安装形态；npm 安装的 Daisy 在它眼里是 `installed`，什么也不做。
- `update/upgrade.ts`：主人手动 `npm install -g` 新版本后，进程发现 `.release` 变了，空闲 60 秒后退出 75 让服务管理器拉起。没有更新前备份（只有结构升级时 ADR-108 的备份），新版本起不来时没有退路；`daisy start` 起的后台进程（macOS 默认、Windows、没有 systemd 的 Linux）根本不会自己重启。

维护者定了这一阶段只做 npm 安装。所以 P5-06 要做的是：让 **npm 安装的 Daisy** 自己更新，并补上“升级前有备份、旧数据都在、失败能退回”，以及“卸载不留后台进程和自启动项”。

## 决定

### 1. 安装、更新、卸载：三个系统上同样的命令

| 做什么 | 命令 |
| --- | --- |
| 安装 | `npm install -g @daisy-ai/daisy`（发布前：`npm install -g ./daisy-ai-daisy-<版本>.tgz`） |
| 更新 | `daisy update --apply`（来源里最新的）、`daisy update --apply --from <tgz>`；或者照旧 `npm install -g <新版本>`，Daisy 空闲后自己换上；自动更新开着时什么都不用做 |
| 退回 | `daisy update --rollback` |
| 卸载 | `daisy uninstall`，然后它最后打印的那条 `npm uninstall -g --prefix <这份安装的前缀> @daisy-ai/daisy`（`uninstallCommand()`：前缀和更新用同一个 `globalPrefix()`，按系统的 shell 加引号；另一个前缀下的安装不受影响） |

npm 7 以后不再为全局包运行卸载脚本，单靠 `npm uninstall` 去不掉自启动项、停不掉后台进程，所以保留 `daisy uninstall` 这一步，文档和 `daisy uninstall` 的输出都写明第二步。

### 2. 更新是什么：在 npm 的全局目录里原地换包，换之前留好退路

`update/package.ts`。Daisy 从 `<前缀>/lib/node_modules/@daisy-ai/daisy`（Windows：`<前缀>\node_modules\@daisy-ai\daisy`）运行时，`globalPrefix()` 认出前缀；不是这个形态（代码检出、项目内安装）就不自己更新，说明原因。

一次更新按顺序：

1. **找到**：来源是主人设置的 runner.json `updateSource`（`daisy update --source …`，要 PIN；或环境变量 `DAISY_UPDATE_SOURCE`）——一个放 `.tgz` 的目录（团队共享目录，现在就能用）、一个 `.tgz`、`npm:@daisy-ai/daisy[@标签]`（`npm view` 看版本，`npm pack` 下载，npm 按注册表的完整性校验；**只在 `@daisy-ai` scope 注册在维护者名下、包发布之后才用**）、或 `off`。**没有默认来源**（见第 5 节）。新版本先复制 / 下载进数据目录的 `update/incoming/`，在本进程里读 tar 包的 `package.json` 和 `.release`（不解包、不运行任何东西），名字必须是 `@daisy-ai/daisy`。**只向前**（按 semver 比版本，构建号不算）：自动更新只取版本号更高的；主人要换成版本号更低的、或**版本号相同而构建不同**的（例如 `0.1.0+cef8a18` 换 `0.1.0+e55447d`：分不出新旧）都要明确 `--allow-downgrade`（`targetRefusal()`，运行中的 `apply` 和 Daisy 没在运行时的 `applyStopped` 同一条规则）；同一个构建说“就是正在运行的版本”，不换。**目标包必须带启动守卫**：打包脚本在 package.json 里写 `"daisy": {"updateGuard": 1}`（第 3 节的守卫在这个版本里），没有这个标记的包（P5-06 之前的构建）一律不换，带不带 `--allow-downgrade` 都一样，提示“目标版本不支持安全更新与退回，请手动安装”——换过去之后没人能确认或退回它。来源目录里这样的包不算候选。
2. **等空闲**：沿用 Runner 循环的空闲判断和旧版的 `restart-drain.ts`（重启等后台任务有上限）：新版本在等时算“有重启待做”，后台命令 / 监视最多再等 30 分钟（只计其余都空闲的时间），之后停掉并如实回报；一轮在跑、卡片在等、登录、终端命令都会一直挡着。自动更新要连续空闲 60 秒，主人要求的（`--apply`）5 秒。
3. **备份数据库**：`store/open.ts` 的 `backupForUpdate()`——用一个只读连接 `VACUUM INTO backups/daisy-update-<旧>-to-<新>-<时间>.sqlite`（运行中的 Daisy 照常持有它的连接，WAL 下也是一致快照），0600，保留最新 3 份（与结构升级的备份分开计数）。**每次更新都备份**，不只是结构要升级时。备份写不成就不更新。
4. **留退路**：正在运行的版本打成包放在 `update/packages/<版本>.tgz`（`npm pack` 安装目录：只有文件，约 1 MB；依赖再装时从 npm 缓存来）。一个版本启动并确认健康后就打好（`settled()`），更新时缺了再打；保留最新 3 个。
5. **安装并检查能加载**：`npm install -g --prefix <它运行所在的前缀> <tgz>`（用 node 直接跑 npm 的 `npm-cli.js`，Windows 上不经 shell）。装好后核对磁盘上的 `.release`，再在一个单独的进程里加载新代码的模块（`app.ts`、`turns/worker.ts`、`update/guard.ts`；只加载、不启动）。npm 失败或加载失败：把第 4 步的包装回去，Daisy 照常运行旧版本，记“失败 / 已退回”，按 1 分钟起翻倍退避（最长 6 小时）。
6. **切换**：写 `update/pending.json`（从、到、备份、退路、前缀、谁发起、启动次数），退出 75 重启。

主人在运行中手动 `npm install -g` 了新版本（`upgrade.ts` 发现 `.release` 变了）：空闲后同样备份、检查能加载、写 pending，再重启；加载不了就装回留着的包。

### 3. 新版本试运行；失败自动退回（`update/guard.ts`）

进程入口 `main.ts` 变薄：先跑启动守卫，再 `import("./daemon.ts")`（原来的进程主体）。守卫只依赖 `node:` 模块和 `package.ts`，所以**新版本连加载都失败**（语法错、缺模块）时守卫也在。

- 自己是 pending 里的新版本：启动次数加一，进入试运行。**健康** = 本机面的 `/api/health` 回答了、Runner 同步过一次（没有 Runner 时只看前者）；120 秒内健康就记“已换上”，删 pending。
- 试运行中退出（退出码不是主人停止的 0、也不是重启的 75）、120 秒没健康、或已经启动了 3 次都没健康（进程被强杀、退出处理没来得及跑）：**退回**——同步执行 `npm install -g <之前版本的包>`，记在 pending 上，然后让之前的版本起来：有服务管理器（systemd、launchd）时退出非零 / 75 由它拉起；`daisy start` 的后台进程自己起一个接班进程。
- 自己是 pending 里的旧版本（退回之后）：记“失败，已退回”和原因，删 pending。
- 都不是（又装了第三个版本）：记“失败”，删 pending。
- **数据库不恢复**：结构只增不删（ADR-108 第 5 节），旧版本照常用新版本留下的库。更新前的备份留在 `backups/`，需要时手动恢复（`daisy status` / `daisy update` 写出备份路径）。

### 4. 没有服务管理器也能自己重启：`respawn`

`daisy start` 的后台进程以前带 `HARBOR_RUNNER_SELF_RESTART=0`，重启请求一律拒绝，装了新版本也不换。现在它带 `DAISY_RESPAWN=1`，`restart.ts` 的 `supervision()` 认作 `manager: "respawn"`、可以重启：退出时（数据目录锁已释放之后）以同样的命令分离启动接班进程，接班进程带 `DAISY_RESPAWN_AFTER=<前任进程号>`，等前任退出后才拿锁。macOS 默认（维护者的决定：不开自启时 `daisy start` 不走 launchd）、Windows、没有 systemd 的 Linux 都靠它。`daisy start --foreground` 和直接 `npm start` 仍然不自己重启。

### 5. 自动更新默认开

备份与退回已经落地，按维护者的决定：npm 安装的 Daisy **默认开**自动更新（runner.json `autoUpdate: false` 关）。但**没有默认来源**（调度审查）：包是 `private: true`、从没发布过，`@daisy-ai` scope 也还没注册，默认用 npm 的 `latest` 等于让抢注这个 scope 的人把代码推进每一台开着自动更新的 Daisy。所以来源不设置时自动更新在配置上仍是“开”，但什么也不做：不定期查、不报 E404，`daisy status` 只有一行“自动更新：没有设置更新来源（daisy update --source … 或 runner.json 的 updateSource）”，`daisy update --check` 说同样的话并以非零退出；`--apply --from <tgz>` 照常可用。设了来源之后，开着时每 30 分钟看一次来源，找到更新的版本就在空闲后按第 2–3 节换上；关着时不看来源，`daisy update --check` / `--apply` 由主人手动做（自动更新关着 `--apply` 也执行）。代码检出的 GitHub 自动更新（旧版的 git 检出更新）不变。

### 6. 记录：审计和 `daisy status`

每个结果写进 `update/state.json` 的历史（最近 20 条），Daisy 起来后写进审计：`update.applied`、`update.rolled_back`、`update.failed`（从、到、谁发起、原因、备份路径）；主人的操作另记 `update.check`、`update.request`。`daisy status`（Daisy 没在运行时也读得到）多一行“上次更新”：`0.1.0+a → 0.2.0+b 已换上（时间）；更新前备份 …`，或“失败，已退回：原因”；进行中的更新也会显示。`GET /api/update` 多一个 `package`（来源、找到的版本、自动更新开关、上次结果、进行中的记录）。

### 7. 接口

三条新接口，都在“设置”组、`daisy:manage`、`notLetIn`、AI 和来访者调不到（13 种身份的矩阵覆盖）：

- `POST /api/update/check`：现在查一次来源，不安装。
- `POST /api/update/apply {from?, allowDowngrade?}`：空闲后换上。不要 PIN（ADR-104 Q2：更新不放任何人进来，要等空闲、记审计）。
- `PUT /api/update/source {source | null}`：设置 / 去掉更新来源，**要 PIN**（所有通道：来源决定以后运行什么代码，按维护者的决定“写都要 PIN”，和其它要 PIN 的写一样经 `commitLetIn` 落盘），写 runner.json 的 `updateSource`，记审计 `update.source`。npm 规格只能是 `@daisy-ai/daisy`；目录和 `.tgz` 要是存在的绝对路径。Daisy 没在运行时 `daisy update --source` 拒绝（PIN 要运行中的 Daisy 核对）。

命令行由本地命令 `daisy update` 提供（Daisy 没在运行时它自己做同样的步骤：装好、写 pending、标“启动时先备份”，下次 `daisy start` 时新版本在打开数据库**之前**备份，再试运行）。`DELETE /api/update/restart` 也撤回还没执行的更新请求。

### 8. 卸载：每个系统一个小接口（`platform/autostart-hooks.ts`）

```ts
interface AutostartHooks {
  name: string;
  implemented: boolean;
  remove(ctx): Promise<boolean>;     // 停用并删除会再启动 Daisy 的东西
  leftovers(ctx): Promise<string[]>; // 卸载后还剩什么（空 = 干净）
  manualRemoval(ctx): string;        // daisy 已经卸掉时手动怎么删
}
```

Linux（systemd 用户单元）、macOS（LaunchAgent）实现；**Windows 是给 P5-05 留的桩**（`windowsHooks`：不删也找不到任何东西，`implemented: false`），P5-05 把它换成自己机制的删除和检查。`daisy uninstall`：停止 Daisy → 结束上次留下的 harness 进程组（`process-groups.json`，非 Windows）→ `hooks.remove` → 检查进程和 `hooks.leftovers` → 打印数据目录（保留），删除数据的命令按系统给（Windows 给 PowerShell 的 `Remove-Item`）。

## 没有照 ADR-104 做的地方

- **不是版本目录 + 指针（ADR-104 D1），而是 npm 原地换包 + 留退路**。维护者定了只用 npm：全局安装的位置由 npm 决定，`daisy` 命令和 systemd / launchd 都指向它；另做 `versions/` 和指针就得再造一个启动器，把 npm 装的那份变成“只负责第一次安装”，`npm install -g` 新版本和自己的版本目录谁算数也说不清。原地换的风险是 ADR-104 写的“运行中的进程后来再按需加载的模块会新旧混搭”：这里只在完全空闲、马上就退出的时刻安装（安装后只做一次加载检查就退出），窗口只有安装那几秒；npm 换一个包目录本身是整体换（失败时它自己撤回）。退回不原子：靠再装一次之前的包（几秒），依赖来自 npm 缓存。
- **每次更新都备份**，不只是结构升级时（ADR-104 C1）：P5-06 的要求是“更新前备份数据库”。代价：库大时每次更新多一份拷贝（保留 3 份）。结构升级时 ADR-108 的备份照旧另做。
- **不做“不可自动回退”的数据库恢复**：现在没有 `breaking` 的结构步骤（ADR-108 第 5 节），守卫回退时不动数据库；第一个 `breaking` 步骤出现时再加“确认期内恢复备份”。

## 后果

- npm 安装的 Daisy 在三个系统上同样地更新：找、等、备份、装、试、退回，每一步有记录。
- 退回依赖 npm 缓存里还有之前版本的依赖（刚装过，通常在）。缓存被清空且没有网络时退回会失败：pending 记 `rolledBack.ok: false`，守卫不再循环，继续跑新版本，`daisy status` 说手动命令（`npm install -g <留着的包>`）。
- `daisy start` 的后台进程现在会自己重启（更新、主人的重启请求）。
- 没有默认来源：装好之后自动更新什么也不查，直到主人用 `daisy update --source`（要 PIN）设一个。现在团队可以指向共享的 `.tgz` 目录；npm 注册表要等 `@daisy-ai` scope 注册在维护者名下、包发布之后再用。环境变量 `DAISY_UPDATE_SOURCE` 也算显式设置（谁能设进程环境，谁本来就能改 runner.json）。
- Windows：代码有平台分支，但没在 Windows 上跑过；开机自启的卸载钩子是桩。

## 测试

- `tests/package-update.test.ts`：先写的拒绝用例（AI 工作凭据、无凭据、别人的令牌调不到 check / apply；不能自己更新的 Daisy 回 409）；主人 apply 一个包（审计、状态、撤回、更旧要 `--allow-downgrade`、不是 Daisy 的包被拒）；全局前缀（Linux / macOS / Windows / 检出）；semver；读 tar 包；目录来源只取更新的；更新前备份（打开着的库、0600、只留 3 份）；切换的顺序（备份 → 留退路 → 安装 → 加载检查 → pending）且只在空闲后；备份失败 / npm 失败 / 加载失败都不改变什么（装回、记录、审计、退避）；自动更新开 / 关 / 不能重启；手动安装的版本；守卫的决定表、确认、退出即退回、3 次启动、加载失败；`respawn` 的判定；卸载钩子与 Windows 桩；更新来源——先写的拒绝用例（AI 凭据、没有 PIN 的命令行和网页都设不了、什么也没写）、只认本包的 npm 规格和存在的绝对路径、去掉；没有来源时不查、不报错、`--check` 非零退出、`--apply --from` 照常。
- `tests/package-update-e2e.test.ts`（升级、退回、卸载的端到端检查，真的 npm，离线）：从这份代码打出 A（旧）、B（新）、C（新但故意坏掉）三个包，`npm install -g --prefix <临时目录>` 装 A，用它自己的 `daisy start` 起来、建一个会话；B 放进来源目录 → 自动更新换上、确认，会话还在、备份里有它、审计有 `update.applied`；`daisy update --apply --from C` → C 起不来，守卫装回 B，B 照常运行，记“失败，已退回”，数据不动；停掉后 `daisy update --rollback` → A 装回，`daisy start` 时先备份再确认；`daisy uninstall` → 没有进程、数据目录保留；`npm uninstall -g` 去掉命令。Windows 上跳过（停止在 Windows 上是强制结束，P5-05），要在 Windows CI 上跑。
