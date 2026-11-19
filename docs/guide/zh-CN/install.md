# 安装、更新与卸载

[English](../en/install.md)

Daisy 装在你自己的系统账户下：一个进程、一个数据目录、一条命令 `daisy`。不需要 root 或管理员，不装系统服务。Linux、macOS、Windows 上，安装、更新、卸载的命令都一样。

装好之后看 [第一次使用](first-use.md)。

> 网页、命令行和给 AI 的提示词有中文（简体）和英文两种。Daisy 跟随系统的语言；要切换，见 [语言](#语言)。

## 要求

| 项 | 说明 |
| --- | --- |
| 系统 | Linux（开机自启要 systemd 用户实例）；macOS（建议 13 或更新，这是 Claude Code 的要求）；Windows 10 1809 / Windows 11 或更新，原生运行，不经 WSL |
| Node.js | 24 或更新。用 `node --version` 看。没有的话装一个，例如 `nvm install 24` |
| npm | 随 Node 一起装 |
| harness | 至少一家：Claude Code、Codex、Kimi Code CLI、OpenCode、Antigravity CLI 或 DeepSeek Harness。可以先装 Daisy，之后再装 harness |
| 其他 | Linux、macOS 上，官方命令行窗口（终端）要 `python3`。Windows 上建议装 Git for Windows：Kimi Code 必须有它，Daisy 的“在终端执行”也优先用其中的 Git Bash |

## 安装

```sh
npm install -g @daisy-ai/daisy
```

> **注意：`@daisy-ai/daisy` 还没有发布到 npm。** 发布之前，取得源代码，从一个本地打好的包（`.tgz`）安装，见下面两节。

### 取得源代码

```sh
git clone https://github.com/QuantGrail/daisy.git
cd daisy
```

### 从 .tgz 安装（发布到 npm 之前）

1. 在源代码目录里打包：

   ```sh
   npm ci
   npm run build:web
   npm run pack:daisy        # 打出 artifacts/daisy-ai-daisy-<版本>.tgz，不发布
   ```

2. 全局安装这个包：

   ```sh
   npm install -g ./artifacts/daisy-ai-daisy-<版本>.tgz
   ```

   Windows（PowerShell 或 CMD）写法相同：`npm install -g .\artifacts\daisy-ai-daisy-<版本>.tgz`。

### 没有权限写全局目录时

Node 是系统装的时候，`npm install -g` 可能提示没有权限写 `/usr/lib/node_modules`。不要用 sudo。把 npm 的全局目录改到自己家目录下，再装一次：

```sh
npm config set prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"     # 也写进 ~/.bashrc 或 ~/.profile
npm install -g @daisy-ai/daisy           # 或者那个 .tgz
```

Windows 上 npm 的全局目录默认是 `%APPDATA%\npm`，已在 PATH 里，不要管理员。

只想这一次装到别处、不改 npm 的全局设置，用 `--prefix`：

```sh
npm install -g --prefix ~/daisy-cli ./artifacts/daisy-ai-daisy-<版本>.tgz
export PATH="$HOME/daisy-cli/bin:$PATH"   # Windows 上命令直接在 <目录> 里，不在 bin 下
```

以后 `daisy update` 和 `daisy uninstall` 都认这份安装所在的目录，不用再写 `--prefix`。

### 确认

```sh
daisy --version
daisy doctor
```

`daisy doctor` 是只读的自检：Node 版本、数据目录权限、各家 harness 是否安装和登录、PIN、端口、开机自启。有 ✗ 的项会说怎么办。

## 数据目录

Daisy 的一切（会话、设置、密钥、日志、更新前的备份）都在数据目录里。

| 系统 | 位置 |
| --- | --- |
| Linux | `$XDG_DATA_HOME/daisy`，默认 `~/.local/share/daisy` |
| macOS | `~/Library/Application Support/Daisy` |
| Windows | `%LOCALAPPDATA%\Daisy` |

- 只有你能读：Linux、macOS 上目录是 0700、凭据文件 0600；Windows 上只有你、SYSTEM 和管理员能访问。
- 换一个位置：每条命令加 `--data-dir <目录>`，或者设环境变量 `DAISY_DATA`。同一个账户跑两个 Daisy 时这样用。开机自启会记住它。
- 不要用 `~/.daisy`：那是另一个同名程序（PyPI 上的 daisy-sdk）的目录。

里面几个常用的文件：

| 文件 | 是什么 |
| --- | --- |
| `daisy.sqlite` | 数据库 |
| `runtime.json` | 正在运行的 Daisy 的进程号、地址和端口（命令行从这里读，不猜） |
| `logs/daisy.log` | 日志（由 systemd 托管时在 journald 里） |
| `keys/` | 身份密钥、命令行凭据、证书 |
| `backups/` | 每次更新前的数据库备份 |
| `config.json`、`runner.json` | 设置 |

## 端口

Daisy 有两个入口面：

- **本机面**：只听 `127.0.0.1`，永远开着。网页和命令行都经它。
- **对外面**：给别的机器用，默认关；开启要 PIN（见 [第一次使用](first-use.md) 和 [安全模型](security.md)）。

端口不用指定。Daisy 按你的系统账户 uid 算出首选端口：本机面 `29200 + (uid mod 390)`，对外面 `29600 + (uid mod 390)`。例如 Linux 上 uid 1000 是 29420 / 29820，macOS 上 uid 501 是 29311 / 29711。这样一台机器上的每个账户各有各的端口。

- 首选端口被占用时，在同一段 390 个端口里找一个空闲的，第一次启动找到的会记住。
- 要固定端口：在数据目录的 `runner.json` 里加 `"port": <端口>`（开机自启时也生效，见下面的“开机自启”），或者 `daisy start --port <端口>`、环境变量 `DAISY_PORT`（这两个只对从终端启动的后台进程有效）。三处都是 1024–65535 之间的整数。指定的端口被占用时启动失败，不会悄悄换。
- 实际用的端口写在数据目录的 `runtime.json` 里，`daisy status` 也会显示。

## 开机自启

```sh
daisy autostart on      # 开启
daisy autostart         # 看状态
daisy autostart off     # 关闭
```

都不要 root 或管理员。

| 系统 | 做法 | 什么时候启动 |
| --- | --- | --- |
| Linux | 用户级 systemd 单元 `~/.config/systemd/user/daisy.service` | 你登录之后。要开机就启动、不用登录（服务器上常这样），再运行一次 `loginctl enable-linger $USER`（有的系统要管理员执行） |
| macOS | LaunchAgent `~/Library/LaunchAgents/ai.daisy.daisy.plist` | 你登录这台 Mac 之后 |
| Windows | 当前用户的启动项（注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `Daisy`） | 你登录 Windows 之后。任务管理器的“启动应用”里能看到、能停用 |

数据目录不是默认的（用了 `--data-dir` 或 `DAISY_DATA`）时，名字后面多一段 `-<8 位十六进制>`，取自数据目录绝对路径的 SHA-256 的前 8 位，例如 `ai.daisy.daisy-1a2b3c4d`、`daisy-1a2b3c4d.service`、`Daisy-1a2b3c4d`：几个数据目录各有各的自启项，互不覆盖。实际的名字看 `daisy status` 的“开机自启”一行（`daisy status --json` 里是 `autostart.unit`）。

开了自启之后，`daisy start` / `daisy stop` 经 systemd、launchd 或 Windows 的守护进程。Daisy 崩溃或换新版本时由它们拉起。

- 开启时如果 Daisy 已经作为后台进程在运行，`daisy stop` 再 `daisy start` 就交给自启了。
- 单元里的 PATH 取自运行 `daisy autostart on` 时的环境。之后新装的 harness 不在原来的 PATH 里，再运行一次 `daisy autostart on`。
- 自启的 Daisy 只带 PATH（和指定了的 `DAISY_DATA`），不带你终端里的其他环境变量。固定的端口、额外的 ACP harness、harness 的命令改写在数据目录的 `runner.json` 里，自启时照样生效。加在文件里已有的项旁边：

  ```json
  { "port": 29420, "acpHarnesses": "acp-harnesses.json", "agentBins": { "kimi": "/home/me/.kimi-code/bin/kimi" } }
  ```

  同一项设了环境变量时以环境变量为准；Daisy 启动时读这个文件。完整的规则见 [环境变量 › 写在 runner.json 里](environment.md#写在-runnerjson-里)。
- **macOS 上建议开着。** Claude Code 的订阅登录存在登录钥匙串里。从受限终端起的后台进程读不到钥匙串，Claude 会像没登录一样。launchd 在你的登录会话里启动 Daisy，就读得到。

## 系统差异

### macOS

- 只经 SSH 连到 Mac、没有人登录桌面时，`daisy start` 经不了 launchd，会说怎么办：登录桌面后再 start，或者 `daisy autostart off` 后以后台进程运行（这样读不到钥匙串）。
- 没有 Daisy 自己的强制只读（它要 Linux 的 Bubblewrap）。要求强制只读的会话会被拒绝，不会降级成可写。

### Windows

- 第一次启动时，Daisy 用 Windows 自带的 .NET Framework 4 C# 编译器编出一个小辅助程序（`%LOCALAPPDATA%\Programs\Daisy\helper\…\daisy-win.exe`，几秒钟，只有一次）。它负责：停止 AI 时收走它起的所有进程、官方命令行窗口（ConPTY）、登录后自启、“只有你能读”的访问控制。公司策略禁止运行本地编译的程序时，这些功能不可用，`daisy doctor` 会说明。
- `daisy stop` 写一个停止请求，Daisy 照常收尾后退出。
- 没有 Daisy 自己的强制只读；Codex 的“问”只算弱只读（它的 Windows 沙箱取决于系统版本和管理员设置）；停止一个 AI 是立即结束，没有温和期。完整的表见 [harness 支持范围](harnesses.md)。

## 日常

| 想做的事 | 命令 |
| --- | --- |
| 看是否在运行、地址、PIN、中转、更新 | `daisy status`（`--json` 给脚本） |
| 停止 | `daisy stop`（正在运行的一轮会结束并标为中断，不会重放） |
| 自检 | `daisy doctor` |
| 看日志 | `<数据目录>/logs/daisy.log`；由 systemd 托管时 `journalctl --user -u daisy` |
| 全部命令 | `daisy --help`，或 [命令参考](commands.md) |

## 语言

Daisy 有中文（简体）和英文两种语言：网页、命令行、本机接口的提示，以及给 AI 的提示词。什么都没设时跟随系统的语言（`LC_ALL`、`LC_MESSAGES`、`LANG`、`LANGUAGE`；macOS 上还看账户的首选语言），都不是中文或英文时用英文。

| 想做的事 | 怎么做 |
| --- | --- |
| 给这台 Daisy 选语言 | 网页“设置 → 显示语言”，或 `daisy language set zh-CN` / `daisy language set en`（`daisy language set null` 重新跟随系统）；`daisy language show` 看设置、正在用的语言和可选的语言 |
| 某一条命令用别的语言 | `daisy --lang en <命令>`（或 `--lang=zh-CN`） |
| 某个终端或脚本 | `DAISY_LANG=en`——对命令行它排在设置前面；对用它启动的 Daisy，它只顶替系统的语言 |

`daisy language set` 和 `daisy language show` 在 Daisy 还没启动过或已经停止时也能用：设置直接写进数据目录的 `config.json`，下次启动时生效（会多说一句提示）。所以可以在第一次 `daisy start` 之前就选好语言。

网页立即切换。Daisy 自己起的名字（“本机”、“用户主目录”、“<harness> · 主机登录”）也跟着显示语言变；你自己起的名字原样不变。已经在进行的会话保持开始时的语言（它的 AI 的提示词不会在对话中途换），之后新建的会话用新语言。日志总是英文。

别的语言是一个语言包：数据目录里的 `<数据目录>/locales/<语言标签>/` 文件夹（例如 `locales/fr/`），里面的 JSON 文件和源代码里 `packages/contracts/locales/en/` 同名、同键。Daisy 几秒内就发现它，不用重启，设置页和 `daisy language` 里都能选。放在这里的语言包只能增加一种语言，不会改动随 Daisy 发布的中文和英文；它管给人看的文字，这种语言的会话里给 AI 的提示词是英文。语言包缺的键显示英文。想让一种语言随 Daisy 发布，见 [CONTRIBUTING.zh-CN.md](../../../CONTRIBUTING.zh-CN.md)。

## 更新

| 想做的事 | 命令 |
| --- | --- |
| 看版本、找到的新版本、上一次更新的结果 | `daisy update` |
| 设置从哪里取新版本（要 PIN） | `daisy update --source <来源>` |
| 现在就查一次（不安装） | `daisy update --check` |
| 换上来源里最新的版本 | `daisy update --apply` |
| 换上这台机器上的一个包 | `daisy update --apply --from ./daisy-ai-daisy-<版本>.tgz` |
| 换回上一个版本 | `daisy update --rollback` |
| 也可以 | `npm install -g <新版本>`，Daisy 空闲后自己换上 |

**更新来源没有默认值，要自己设。** 没设时自动更新什么也不查，`daisy status` 会显示“没有设置更新来源”。`daisy update --apply --from <tgz>` 照常能用。来源可以是：

- 一个放 `daisy-ai-daisy-*.tgz` 的目录（取版本最高的），或一个 `.tgz` 的绝对路径；
- `npm:@daisy-ai/daisy@latest`——**只在这个包发布到 npm 之后再用**；
- `off` 关掉，`none` 去掉。

设置存在 `runner.json` 的 `updateSource`；环境变量 `DAISY_UPDATE_SOURCE` 同义。

自动更新默认开：每 30 分钟看一次来源，有更新的版本就在空闲时换上，只向前不向后。关掉：在 `<数据目录>/runner.json` 里加 `"autoUpdate": false`（`daisy update --apply` 照样能手动换）。

每次换版本，Daisy 都这样做：

1. **等完全空闲**：没有正在运行的一轮、等回答的卡片、登录、终端命令。从不打断正在运行的一轮。
2. **先备份数据库**：`<数据目录>/backups/daisy-update-<旧版本>-to-<新版本>-<时间>.sqlite`，保留最新 3 份。
3. **留退路**：当前版本的包放在 `<数据目录>/update/packages/`。
4. **重启进新版本**：120 秒内没有正常运行，就自动装回之前的版本。

结果写进审计，`daisy status` 和 `daisy update` 都显示。

- Daisy 没在运行时 `daisy update --apply` 也能用：下次 `daisy start` 时先备份、再试新版本。
- 换旧版本，或版本号相同而构建不同的包，要加 `--allow-downgrade`。
- 数据库不随退回恢复（数据库结构只增不删，旧版本照常用）。确实要回到更新前的数据：停掉 Daisy，用 `backups/` 里那份替换 `daisy.sqlite`，并删掉旁边的 `daisy.sqlite-wal`、`daisy.sqlite-shm`。备份之后的数据会丢。

## 卸载

```sh
daisy uninstall
npm uninstall -g --prefix <npm 全局目录> @daisy-ai/daisy
```

第二条**照抄 `daisy uninstall` 最后打印的那一条**：它带着这份安装所在的 npm 全局目录。机器上别处还装着一份 Daisy 时，不带 `--prefix` 可能删掉另一份。

`daisy uninstall` 停掉 Daisy、结束它留下的 harness 进程、删除开机自启项，并检查没有留下后台进程。**数据目录不删**，最后告诉你它在哪。要彻底删掉数据：

```sh
rm -rf "<数据目录>"                              # Linux、macOS
Remove-Item -Recurse -Force "<数据目录>"         # Windows PowerShell
```

只运行 `npm uninstall` 去不掉自启项，所以先运行 `daisy uninstall`。忘了的话，手动删（数据目录不是默认的时，换成带 `-<8 位十六进制>` 的名字，见 [开机自启](#开机自启)）：

- Linux：`systemctl --user disable --now daisy.service && rm ~/.config/systemd/user/daisy.service && systemctl --user daemon-reload`
- macOS：`launchctl bootout gui/$(id -u)/ai.daisy.daisy; rm ~/Library/LaunchAgents/ai.daisy.daisy.plist`
- Windows（PowerShell）：`Remove-ItemProperty -Path HKCU:\Software\Microsoft\Windows\CurrentVersion\Run -Name Daisy`

## 出问题时

| 现象 | 怎么办 |
| --- | --- |
| `daisy: command not found` | npm 的全局 bin 目录不在 PATH 里。`npm prefix -g` 看全局目录，把它下面的 `bin`（Windows 上就是那个目录）加进 PATH |
| `Daisy 需要 Node.js 24 或更高版本` | 装 Node 24，再重新安装 |
| `Daisy 没在运行` | `daisy start` |
| 启动后马上退出 | 错误里有日志的最后几行；完整日志见“看日志” |
| `连不上你的 systemd 用户实例` | 在正常登录的会话里运行（`su`、`sudo` 切过来的会话没有用户总线）；或先 `loginctl enable-linger $USER` 再重新登录 |
| macOS：Claude 说读取钥匙串失败，或报告没登录 | `daisy autostart on`，再 `daisy stop && daisy start`。`daisy status` 的托管方式应是 launchd |
| macOS：`launchd 没能启动 ai.daisy.daisy…` | 没有人登录这台 Mac 的桌面。登录后再 `daisy start` |
| 已登录，但一轮失败，说模型不支持（`model is not supported`） | 这个账号用不了那个模型。点对话底部的模型 →“读取原生模型列表”，选列表里的模型再发 |
| 网页打开是空的 | 安装包里没带网页：先 `npm run build:web` 再打包，重新安装 |
| 别的 | `daisy doctor`。每条错误信息都写了怎么办 |
