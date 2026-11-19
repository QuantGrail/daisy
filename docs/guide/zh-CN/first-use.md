# 第一次使用

[English](../en/first-use.md)

先按 [安装](install.md) 装好 `daisy`。下面五步走完，就有了第一轮对话。每条命令都有 `--help`。

> 网页、命令行和给 AI 的提示词有中文（简体）和英文两种。Daisy 跟随系统的语言；要切换，见 [语言](install.md#语言)。

## 1. 启动

```sh
daisy start
```

Daisy 在后台运行，打印本机面的地址（`http://127.0.0.1:<端口>`）、进程号、数据目录和日志位置。已经在运行时只说明一下。

macOS 上建议先 `daisy autostart on`，再 `daisy start`（原因见 [安装 › 开机自启](install.md#开机自启)）。

## 2. 设一个 PIN

```sh
daisy pin set
```

- 至少 6 位，可以是纯数字。输入时不显示，要输两次。
- **没设 PIN 之前，Daisy 不启动任何 AI 轮次。** `daisy status` 和网页会一直提醒。
- PIN 守着“放别人进来”的操作：从别的机器打开网页、选中转、配对设备、互认名片、公开 agent、签发令牌等。AI 不能替你输入。
- Daisy 只保存 PIN 的校验值。连续输错 5 次锁 15 分钟，之后逐轮加长，最长 24 小时。
- 忘了 PIN：在这台机器上 `daisy pin reset --confirm`，再 `daisy pin set`。重置会收回所有放进来的东西（对外面、互认的名片、授权、配对的设备、外部签发方），见 [安全模型](security.md)。

## 3. 打开本地网页

```sh
daisy open
```

它向 Daisy 要一个一次性口令（10 分钟内有效、只能用一次），在浏览器里打开带口令的链接。没有图形界面时把链接打印出来。

**经 SSH 登录服务器时**，链接只在那台机器本机能打开。在自己电脑上建一条隧道，再打开打印出来的链接：

```sh
ssh -N -L <端口>:127.0.0.1:<端口> <服务器>
```

或者开启对外面，从别的机器直接打开（要 PIN）：

```sh
daisy access external on --host <这台机器的组网或内网地址>
daisy open --external
```

对外面默认用 TLS（自签名证书），浏览器第一次会提示证书不受信任：在浏览器里查看证书的 SHA-256 指纹，和 `daisy access show` 打印的（`external.fingerprint`）一致再继续。终端、执行命令、浏览目录在对外面上默认关。

## 4. 登录一家 harness

Daisy 不重造 harness，它驱动你装好的官方命令行。第一次启动时，Daisy 已经为每家 harness 建好一个“主机登录”身份档，用工作目录“用户主目录”（你的家目录）。所以有两种做法：

- **沿用这台机器上已有的登录。** 你已经在终端里登录过 `claude`、`codex` 或 `kimi` 的话，什么都不用做，新建会话时选“`<harness> · 主机登录`”这个身份档即可。
- **给 Daisy 一份独立的登录。** 在网页的“设置 › harness 登录（身份档）”里新建、按提示登录。独立登录有自己的目录，不动这台机器上原有的登录。用 API key 的 Claude 也在这里加。

终端里也能做独立登录：

```sh
daisy workspace catalog                              # 看执行节点 id（nodes[].id）和已有的身份档
daisy profile create-managed --agent codex --node-id <节点 id> --label 我的 Codex
daisy login start <身份档 id>                        # 回答里有登录流程 id
daisy login show <流程 id>                           # 拿到授权地址，在任何一台机器的浏览器里打开
daisy login input <流程 id>                          # 授权页给了授权码时交给它（提示输入，不回显）
daisy login show <流程 id>                           # status 变成 complete 就好了
```

`daisy doctor` 会显示每家 harness 是否安装、是否登录。各家能做什么，见 [harness 支持范围](harnesses.md)。

## 5. 第一轮对话

在网页里点新建会话，选身份档和工作目录，发一条消息。

**第一轮就报模型不支持**（例如 `The '…' model is not supported when using Codex with a ChatGPT account`）：登录没问题，是这个账号用不了那个模型。点对话底部显示的模型，点“读取原生模型列表”，选列表里的一个模型，再发一次（只改这个会话）。Codex 的主机配置里写了这个账号用不了的模型时，Daisy 会改用列表里的默认模型开始，并在对话里说明。

终端里也行：

```sh
daisy workspace catalog                       # 工作目录 id 和身份档 id
daisy session create --agent claude --workspace-id <工作目录 id> --profile-id <身份档 id> --title 第一个会话
daisy session send <会话 id> "你好，介绍一下这个目录"
daisy session show <会话 id>
```

AI 要用工具时，可能会请求授权或向你提问。**回答这些卡片只在网页和配对的设备上**，命令行不提供。用 `daisy watch` 可以在终端里看到有卡片在等。

要换一个工作目录：`daisy workspace add --node-id <节点 id> --label 项目 --path /绝对/路径`，或在网页的设置里加。

## 下一步

- 在手机上用：[配对手机或浏览器](pairing.md)
- 让别的网络里的人或 AI 调用你：[中转](relay.md)、[外部接入：A2A 与 daisy-mcp](integrations.md)
- 每条命令：[命令参考](commands.md)
- 安全怎么保证、有哪些已知限制：[安全模型](security.md)
