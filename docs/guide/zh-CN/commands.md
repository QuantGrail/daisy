# 命令参考

[English](../en/commands.md)

<!-- 由 scripts/gen-cli-docs.mjs 从命令行自己的命令表生成，不要手改；改了命令后运行 node scripts/gen-cli-docs.mjs -->

这一页列出 `daisy` 的每一条命令，内容就是 `daisy <命令> --help` 打印的帮助。

命令分两类：

- **本地命令**：管这台机器上的 Daisy 进程和文件，Daisy 没在运行时也能用。
- **接口命令**：经本机接口调用正在运行的 Daisy。网页上能做的，这里都能做；回答 AI 的工具授权和提问除外（只在网页和配对的设备上）。

几条通用的规则：

- 标着“要 PIN”的命令会先在终端里提示输入 PIN。
- 凭据（PIN、API key、授权码）从提示或标准输入读取，从不接受命令行里的值，免得留在 shell 历史里。
- 接口命令的回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
- 全局选项 `--data-dir <目录>`（或环境变量 `DAISY_DATA`）换一个数据目录；`--lang <语言>`（或 `DAISY_LANG`）换一种语言。

接口命令背后的 HTTP 接口见 [本机接口文档](../../api/local-api.md)。

## 总览

```text
daisy —— Daisy 的命令行

用法：daisy <命令> [子命令] [参数] [选项]

本地命令（管这台机器上的 Daisy 进程和文件，Daisy 没在运行时也能用）：
  start       在后台启动 Daisy（已在运行时只说明一下）
  stop        停止 Daisy（正在运行的一轮会结束并标为中断，不会重放）
  status      看 Daisy 是否在运行、监听在哪、PIN 是否设置、自启与更新状态
  open        打开本地网页（带一次性口令的链接）
  update      查看、检查或换上新版本（等空闲、先备份、失败自动退回）
  doctor      自检：Node 版本、数据目录权限、各家 harness 是否安装与登录、PIN、端口、自启
  uninstall   卸载前的清理：停掉 Daisy、去掉开机自启；数据目录保留
  autostart   开启或关闭开机自启（Linux：systemd 用户单元；macOS：launchd 登录项；Windows：当前用户的启动项；都不要 root / 管理员）
  watch       持续读事件出口：AI 请求授权、AI 提问、有人想调用待批准，各自的出现与了结

接口命令（经本机接口，网页上能做的这里都能做；回答 AI 的工具授权和提问除外）：
  access      external off、external on、issuer refresh、issuer remove、issuer set、issuer show …
  agent       act set、act show、audience set、audience show、list、public set …
  approval    comment add、comment list、list、show
  attachment  download、upload
  audit       list、logs
  call        list、show
  contact     export、import、inspect、list、remove、show …
  device      list、revoke
  events      list、snapshot
  grant       list、revoke
  language    set、show
  login       cancel、input、list、show、start
  notify      list、set、show
  pair        生成一个配对码（daisy pair）：另一台设备输入它，就以主人身份连进来
  pin         reset、set、status
  profile     auto-compact restart、auto-compact show、create、create-managed、delete、update
  prompt      layers apply、layers apply-cancel、layers forget-node、layers set、layers show、mine set …
  relay       off、set、show
  request     decide、list、show
  restart     cancel、request、status
  session     activity、background stop、cancel、create、delete、events …
  token       issue、list、revoke
  whoami      我是谁：主人、经哪个通道、哪个入口面
  workspace   add、browse、browse-result、catalog

第一次使用：daisy start → daisy pin set → daisy open（在网页里登录 harness、建会话）

全局选项：
  --data-dir <目录>   用这个数据目录（默认按系统惯例；也可以设 DAISY_DATA）
  --lang <语言>       用这个语言（en、zh-CN；也可以设 DAISY_LANG；默认按设置或系统）
  -h, --help          帮助；每条命令都有：daisy <命令> --help
  -V, --version       版本
```

## 本地命令

### daisy start

```text
用法：daisy start [--port <端口>] [--foreground]

在后台启动 Daisy（已在运行时只说明一下）

开着开机自启（daisy autostart on）时由 systemd（Linux）或 launchd（macOS）启动，否则作为后台进程启动，输出写进数据目录的 logs/daisy.log。
macOS 上建议先 autostart on：launchd 在你的登录会话里启动它，Claude 的钥匙串登录才读得到。
端口不用指定：按系统账户 uid 派生、被占就找空闲的并记住。数据目录按系统惯例，--data-dir 或 DAISY_DATA 可以改。

选项：
  --port <端口>     指定本机面的端口，1024–65535（被占就报错，不悄悄换）
  --foreground      在这个终端里前台运行（调试，或交给别的服务管理器）

通用选项：--data-dir <目录>（默认按系统惯例，或 DAISY_DATA）；--lang <语言>（或 DAISY_LANG）
```

### daisy stop

```text
用法：daisy stop

停止 Daisy（正在运行的一轮会结束并标为中断，不会重放）

发 SIGTERM，等它收尾：正在运行的一轮标为中断（原则 2，不重放），网页连接断开，然后退出。由 systemd 托管时用 systemctl --user stop，由 launchd 托管时用 launchctl bootout。
开机自启照旧：下次开机还会启动（要关掉用 daisy autostart off）。

通用选项：--data-dir <目录>（默认按系统惯例，或 DAISY_DATA）；--lang <语言>（或 DAISY_LANG）
```

### daisy status

```text
用法：daisy status [--json]

看 Daisy 是否在运行、监听在哪、PIN 是否设置、自启与更新状态

退出码：0 在运行；3 没在运行。

选项：
  --json    以 JSON 输出（给脚本和 AI 读）

通用选项：--data-dir <目录>（默认按系统惯例，或 DAISY_DATA）；--lang <语言>（或 DAISY_LANG）
```

### daisy open

```text
用法：daisy open [--external] [--print]

打开本地网页（带一次性口令的链接）

向 Daisy 要一个一次性口令（10 分钟内有效、只能用一次），在浏览器里打开带口令的链接；打不开浏览器时把链接打印出来。

选项：
  --external   给别的机器用的链接（经对外面：开着对外面的监听时用它的直连地址，同时列出中转的地址作备选；只有中转时用中转的固定地址；要先 daisy access external on 或 daisy relay set）。这是“放别人进来”，要 PIN
  --print      只打印链接，不打开浏览器

通用选项：--data-dir <目录>（默认按系统惯例，或 DAISY_DATA）；--lang <语言>（或 DAISY_LANG）
```

### daisy update

```text
用法：daisy update [--check | --apply [--from <tgz>] [--allow-downgrade] | --rollback | --source <来源> | --now | --cancel]

查看、检查或换上新版本（等空闲、先备份、失败自动退回）

不带选项：装在磁盘上的版本、正在运行的版本、找到的新版本、自动更新开关、上一次更新的结果。
换版本要重启，而重启会打断正在运行的一轮（不重放），所以默认等完全空闲再换。
换之前先备份数据库（数据目录的 backups/），留下当前版本的包作退路（update/packages/）；新版本 120 秒内没有正常运行就自动退回。
Linux、macOS、Windows 上命令相同；Daisy 没在运行时也能用（下次启动时先备份数据库，再试新版本）。

选项：
  --check            现在就向更新来源查一次，不安装（没有默认来源：先 --source）
  --apply            等空闲后换上来源里最新的版本（自动更新关着也执行）；手动 npm install -g 过新版本时，等空闲后换上它
  --from <tgz>       和 --apply 一起：换上这台机器上的这个包
  --allow-downgrade  和 --apply 一起：允许换成更旧的版本
  --rollback         换回上一个版本（数据目录里留着的包）
  --source <来源>    设置更新来源（要 PIN）：放 .tgz 的目录或一个 .tgz（绝对路径）、npm:@daisy-ai/daisy@latest（这个 scope 注册、包发布之后才用）、off；none 去掉
  --now              立即重启：先列出会被打断的会话，确认后执行
  --cancel           撤回还没执行的重启 / 更新请求

重启这一组接口也可以直接用：daisy restart status|request|cancel。

通用选项：--data-dir <目录>（默认按系统惯例，或 DAISY_DATA）；--lang <语言>（或 DAISY_LANG）
```

### daisy doctor

```text
用法：daisy doctor [--json]

自检：Node 版本、数据目录权限、各家 harness 是否安装与登录、PIN、端口、自启

只读检查，不改任何东西，不读也不打印任何凭据（harness 的登录状态用它们自己的只读命令查）。
有 ✗ 时退出码为 1。

通用选项：--data-dir <目录>（默认按系统惯例，或 DAISY_DATA）；--lang <语言>（或 DAISY_LANG）
```

### daisy uninstall

```text
用法：daisy uninstall [--yes]

卸载前的清理：停掉 Daisy、去掉开机自启；数据目录保留

依次：停止 Daisy（正在运行的一轮标为中断）→ 结束它留下的 harness 进程 → 停用并删除开机自启项 → 检查没有留下后台进程和自启动项。
数据目录（会话、设置、密钥、更新前的备份）不删，最后告诉你它在哪、要删怎么删。命令本身最后用包管理器卸载（Linux、macOS、Windows 相同）：
  npm uninstall -g --prefix <这份安装所在的 npm 全局目录> @daisy-ai/daisy（daisy uninstall 最后打印的就是这份安装的确切命令）

选项：
  --yes    不再询问确认（脚本里用）

通用选项：--data-dir <目录>（默认按系统惯例，或 DAISY_DATA）；--lang <语言>（或 DAISY_LANG）
```

### daisy autostart

```text
用法：daisy autostart [on | off]

开启或关闭开机自启（Linux：systemd 用户单元；macOS：launchd 登录项；Windows：当前用户的启动项；都不要 root / 管理员）

on：Linux 生成并启用一个用户级 systemd 单元（~/.config/systemd/user/daisy.service）；macOS 写一个 LaunchAgent（~/Library/LaunchAgents/ai.daisy.daisy.plist），在你登录后由 launchd 启动；Windows 写当前用户的启动项（HKCU\Software\Microsoft\Windows\CurrentVersion\Run 下的 Daisy），在你登录后由 Daisy 的 Windows 守护进程启动。之后 daisy start / stop 经 systemd / launchd / 那个守护进程。
off：停用并删除它（正在运行的 Daisy 不受影响，下次开机 / 登录不再启动）。
不带参数：看现在的状态。
macOS 上建议开着：launchd 在你的登录会话里启动它，Claude 的钥匙串登录才读得到。

通用选项：--data-dir <目录>（默认按系统惯例，或 DAISY_DATA）；--lang <语言>（或 DAISY_LANG）
```

### daisy watch

```text
用法：daisy watch [--after <序号>] [--cursor-file <文件>] [--wait <秒>] [--max <条数>]

持续读事件出口：AI 请求授权、AI 提问、有人想调用待批准，各自的出现与了结

每条事件一行（CloudEvents 1.0 的 JSON，见 docs/contracts/events.md），打印到标准输出；状态提示打印到标准错误。
不带 --after 也没有游标文件时，先取一次快照（现在所有没了结的卡片），再从快照的序号接着读；之后长轮询，有新事件立即打印。
Daisy 重启或暂时连不上时等它回来，从同一个序号接着读；序号接不上（旧事件已清理、数据重建过）时重新取快照。

选项：
  --after <序号>         从这个序号之后开始读（不取快照）
  --cursor-file <文件>   把读到的序号存进这个文件（每处理完一页存一次），下次从它接着读；断在一页中间会再读到同一页，按事件的 id 去重
  --wait <秒>            每次最多等多久（1–30，默认 30）
  --max <条数>           打印这么多条后退出（脚本里用）

只读一页：daisy events list --after <序号>；快照：daisy events snapshot。

通用选项：--data-dir <目录>（默认按系统惯例，或 DAISY_DATA）；--lang <语言>（或 DAISY_LANG）
```

## 接口命令

### daisy access

```text
用法：daisy access <子命令> …

子命令：
  external off      关闭对外面
  external on       开启或改动对外面（监听地址、端口、TLS、终端等开关）（要 PIN）
  issuer refresh    现在重新取一次外部签发方的公钥集
  issuer remove     不再相信外部签发方，回到自签发
  issuer set        配置外部签发方（相信它签的令牌）（要 PIN）
  issuer show       看令牌签发方：自签发还是外部签发方、主人是谁、缓存的公钥
  passcode          设置本机网页的口令：auto（默认）、on、off（要 PIN）
  show              看两个入口面和口令：监听在哪、端口从哪来、口令是否启用
  ui-origins clear  清空允许的外部界面来源
  ui-origins set    设置允许的外部界面来源（整份替换）（要 PIN）
  ui-origins show   看允许的外部界面来源（浏览器里的外部界面，CORS）

每条子命令的参数：daisy access <子命令> --help
```

#### daisy access external off

```text
用法：daisy access external off

关闭对外面

收窄能连进来的范围，不要 PIN。对外面上的网页会话一并作废。

接口：DELETE /api/access/external（settings.externalOff）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy access external on

```text
用法：daisy access external on [选项]

开启或改动对外面（监听地址、端口、TLS、终端等开关）

扩大了能连进来的范围，要 PIN。开启后口令自动启用。明文只允许回环、组网或内网地址（127/8、10/8、172.16/12、192.168/16、100.64/10、::1、fc00::/7）。TLS 用 keys/ 里的自签名证书：只在还没有、不覆盖监听地址或一天内到期时生成新的（写进日志和审计）；证书文件在但不能用（属主不对、密钥和证书不是一对、读不了）时回 409 `tls_refused`，不悄悄换证书。

选项：
  --host                   监听地址：组网地址、0.0.0.0、回环地址（同一台机器上别的程序来访）等；不写 localhost（string，1–253 字符，必填）
  --port                   端口；不填按 uid 派生（29600 起）（integer，1024–65535）
  --tls                    默认 TLS（自签名证书）；false（明文）只允许回环、组网或内网地址（boolean，默认 true）
  --allow                  对外面上开放终端、执行命令、浏览目录（默认都关）（object，默认 {"terminal":false,"shell":false,"browse":false}）

这一步要输入 PIN（终端里提示）。

接口：PUT /api/access/external（settings.externalOn）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy access issuer refresh

```text
用法：daisy access issuer refresh

现在重新取一次外部签发方的公钥集

平时按缓存头自动取（没有就 1 小时），遇到不认识的 kid 也会取；签发方换钥匙后想立即生效时用。

接口：POST /api/access/issuer/refresh（settings.issuerRefresh）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy access issuer remove

```text
用法：daisy access issuer remove

不再相信外部签发方，回到自签发

收窄能连进来的范围，不要 PIN（同关闭对外面）。缓存的公钥和主人的令牌一并删除，替 AI 领过的令牌不再续。

接口：DELETE /api/access/issuer（settings.issuerRemove）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy access issuer set

```text
用法：daisy access issuer set [选项]

配置外部签发方（相信它签的令牌）

“放别人进来”的一种：签发方签给主人的令牌从此得到主人身份（不需要配对），签给别人的只能走 A2A 入口。要 PIN，AI 不能做。配置时先取一次元数据和公钥集，取不到就不保存；之后离线验证，按 kid 轮换。

选项：
  --issuer                 签发方标识，必须与它签的令牌的 iss 完全相同：https 地址（http 只在本机回环地址 127.0.0.1 / [::1]、设置了 DAISY_ALLOW_HTTP_ISSUER=1、且这台机器没有别人的账户时允许，供测试和本机部署）（string，8–2048 字符，必填）
  --metadata-url           元数据地址（RFC 8414 / OpenID Connect Discovery）；不填按签发方标识推出：https 地址（http 只在本机回环地址 127.0.0.1 / [::1]、设置了 DAISY_ALLOW_HTTP_ISSUER=1、且这台机器没有别人的账户时允许，供测试和本机部署）（string，8–2048 字符）
  --jwks-uri               公钥集（JWKS）地址；不填从元数据里取：https 地址（http 只在本机回环地址 127.0.0.1 / [::1]、设置了 DAISY_ALLOW_HTTP_ISSUER=1、且这台机器没有别人的账户时允许，供测试和本机部署）（string，8–2048 字符）
  --token-endpoint         令牌端点（RFC 8693 令牌交换）；不填从元数据里取：https 地址（http 只在本机回环地址 127.0.0.1 / [::1]、设置了 DAISY_ALLOW_HTTP_ISSUER=1、且这台机器没有别人的账户时允许，供测试和本机部署）（string，8–2048 字符）
  --owner-subject          哪个主体（sub）是这个 Daisy 的主人：只有它的令牌得到主人身份（string，1–256 字符，必填）
  --audience               这个 Daisy 在签发方那里的受众标识，验证令牌的 aud 用；不填是这个 Daisy 的 URN（string，1–512 字符）
  --client-id              向令牌端点证明自己（private_key_jwt）时的客户端编号；不填是这个 Daisy 的 URN 加 #client（string，1–512 字符）
  --owner-token            主人的令牌（签发方签给主人、没有 act，有效期 exp - iat 不超过 24 小时）：只用于替 AI 换令牌（subject_token），不能用来登录这个 Daisy；存在只有主人可读的文件里（从标准输入或提示读取，不接受命令行里的值，16–8192 字符）

这一步要输入 PIN（终端里提示）。

接口：PUT /api/access/issuer（settings.issuerSet）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy access issuer show

```text
用法：daisy access issuer show

看令牌签发方：自签发还是外部签发方、主人是谁、缓存的公钥

回答里有这个 Daisy 的公钥（JWK）：在外部签发方那里登记它，签发方才能验证 Daisy 替 AI 换令牌时的客户端断言（private_key_jwt）。不含任何令牌。

接口：GET /api/access/issuer（settings.issuerShow）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy access passcode

```text
用法：daisy access passcode <mode>

设置本机网页的口令：auto（默认）、on、off

auto：这台机器上还有别人的账户，或对外面开着时启用。改这个设置可能放宽谁能打开网页，要 PIN。

参数：
  <mode>                   （"auto" | "on" | "off"，必填）

这一步要输入 PIN（终端里提示）。

接口：PUT /api/access/passcode（settings.passcode）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy access show

```text
用法：daisy access show

看两个入口面和口令：监听在哪、端口从哪来、口令是否启用

对外面用自签名证书监听时，`external.fingerprint` 是这张证书的 SHA-256 指纹（DER，冒号分隔的十六进制，和 openssl、浏览器显示的一样）：浏览器提示证书不受信任时，和它一致再继续。

接口：GET /api/access（settings.show）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy access ui-origins clear

```text
用法：daisy access ui-origins clear

清空允许的外部界面来源

收窄能连进来的范围，不要 PIN（同关闭对外面）。已连上的实时通道在下一次变化时断开。

接口：DELETE /api/access/ui-origins（settings.uiOriginsClear）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy access ui-origins set

```text
用法：daisy access ui-origins set [选项]

设置允许的外部界面来源（整份替换）

“放别人进来”的一种：列进来的网页可以带着外部签发方签给主人的令牌，在浏览器里经对外面以主人身份调用本机接口和实时通道（本机面不认），所以要 PIN，AI 不能做。从这些来源来的请求只认外部签发方给主人的令牌；网页会话、本机凭据一律拒绝。

选项：
  --origins                允许的外部界面来源，每个写成 `https://主机[:端口]`（不带路径、不带结尾斜杠、不用通配符）；`http://` 只允许本机回环（localhost、127.0.0.1、[::1]，开发用）。空列表 = 一个都不允许（string[]，≤ 16 项，必填）

这一步要输入 PIN（终端里提示）。

接口：PUT /api/access/ui-origins（settings.uiOriginsSet）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy access ui-origins show

```text
用法：daisy access ui-origins show

看允许的外部界面来源（浏览器里的外部界面，CORS）

浏览器里运行的外部界面（比如组织平台的网页）要从这些来源经对外面调用本机接口（只在对外面生效，本机面不认别的来源）。服务端进程里的界面后端不带 Origin，不需要这项设置。

接口：GET /api/access/ui-origins（settings.uiOriginsShow）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy agent

```text
用法：daisy agent <子命令> …

子命令：
  act set          设置一个 agent 是否允许“办”、办的时候用什么权限模式（要 PIN）
  act show         看一个 agent 怎么接受“问”和“办”：是否允许办、办的权限模式、问的只读强度（要 PIN）
  audience set     改一个 agent 的开放范围和指定人名单（要 PIN）
  audience show    看一个 agent 的开放范围（对所有互认的人，或只对指定人）（要 PIN）
  list             列出别人可以调用的 agent（公开 agent 和常驻 agent）及各自的开放范围（要 PIN）
  public set       把一个会话设为公开 agent，或收回私有（要 PIN）
  public show      看一个会话是不是公开 agent，现在能不能设为公开
  resident close   关闭一个常驻 agent：不再接受调用，进行中的任务停下，专属会话关闭（记录保留）
  resident create  创建一个常驻 agent（要 PIN）
  resident delete  删除一个常驻 agent 和它的全部专属会话
  resident list    列出常驻 agent（要 PIN）
  resident pause   暂停一个常驻 agent：之后的调用被拒绝（AGENT_PAUSED）
  resident resume  恢复一个暂停的常驻 agent（要 PIN）
  resident set     修改一个常驻 agent：名字、提示词、权限模式、目录、工具、并发、用量、确认怎么处理（要 PIN）
  resident show    看一个常驻 agent：配置、分层提示词、用量、来访对话（要 PIN）

每条子命令的参数：daisy agent <子命令> --help
```

#### daisy agent act set

```text
用法：daisy agent act set <aid> [选项]

设置一个 agent 是否允许“办”、办的时候用什么权限模式

“放别人进来”的一种（种类 agent-exposure）：要 PIN，AI 不能做。允许办等于让别人在主线上按这个权限模式动手；关掉之后，还在排队、没开始的办一并撤掉（已拒绝 ACT_DISABLED），正在跑的照常跑完。权限模式不能是跳过所有确认的模式。公开 agent 没有只读模式（不能接受问）时不能关掉办（409 `act_required`：先收回私有）。

参数：
  <aid>                    agent 的编号（string，1–200 字符，必填）

选项：
  --act                    是否允许办：true 允许别人带“办”标记请这个 AI 在主线上动手（排在你当前这一轮后面）；false 关掉，带标记的调用一律被拒（ACT_DISABLED），问照常可用（boolean）
  --permission-mode        办的时候用什么权限模式：这个 AI 的权限模式之一（GET 的 modes），或 session = 跟随会话自己的（身份档的）。不能是跳过所有确认的模式（string，1–40 字符）

这一步要输入 PIN（终端里提示）。

接口：PUT /api/agents/:aid/act（grant.actSet）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy agent act show

```text
用法：daisy agent act show <aid>

看一个 agent 怎么接受“问”和“办”：是否允许办、办的权限模式、问的只读强度

问的只读强度和在哪里跑来自这个 AI 的能力声明：strong / weak（只靠 harness 的规划模式）/ none（不能问，只能办）；branch（只读支线）/ main-queue（不支持旁问和分叉，回落到主线排队，仍然只读）。只读：网页等主人入口不要 PIN，本机命令行要。

参数：
  <aid>                    agent 的编号（公开 agent 是它的会话编号）（string，1–200 字符，必填）

这一步要输入 PIN（终端里提示）。

接口：GET /api/agents/:aid/act（grant.actShow）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy agent audience set

```text
用法：daisy agent audience set <aid> [选项]

改一个 agent 的开放范围和指定人名单

两选一：对所有互认的人开放，或只对指定人开放。要 PIN。收窄立即生效：不再在范围内的人正在进行的调用被停下，等着的卡片作废。是否能被调用（公开、常驻、私人）不在这里改。

参数：
  <aid>                    agent 的编号（string，1–200 字符，必填）

选项：
  --open-to                all：对所有互认的人开放（第一次调用弹卡片，白名单里的人直接通过）；listed：只对指定人开放（名单里的直接通过，别人一律拒绝、不弹卡片）（"all" | "listed"，必填）
  --listed                 指定人：联系人的编号（或 8 个以上字符的唯一开头）。listed 时就是名单；不写则保持原来的名单（string[]，≤ 500 项）

这一步要输入 PIN（终端里提示）。

接口：PUT /api/agents/:aid/audience（grant.audienceSet）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy agent audience show

```text
用法：daisy agent audience show <aid>

看一个 agent 的开放范围（对所有互认的人，或只对指定人）

只读：网页等主人入口不要 PIN，本机命令行要。

参数：
  <aid>                    agent 的编号（公开 agent 是它的会话编号）（string，1–200 字符，必填）

这一步要输入 PIN（终端里提示）。

接口：GET /api/agents/:aid/audience（grant.audienceShow）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy agent list

```text
用法：daisy agent list

列出别人可以调用的 agent（公开 agent 和常驻 agent）及各自的开放范围

三种 agent：私人 agent 是其余所有会话，不在这里；公开 agent 是设为公开的会话（`daisy agent public set`）；常驻 agent 是一份配置（`daisy agent resident …`）。每个带开放范围、是否允许办、待批准的卡片数和永久授权数。只读：网页、配对设备、外部签发方给主人的令牌不要 PIN，本机命令行要（命令行凭据可能是主人的 AI）；仍要 `daisy:grant`，AI 和来访者读不到。

这一步要输入 PIN（终端里提示）。

接口：GET /api/agents（grant.agentList）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy agent public set

```text
用法：daisy agent public set <id> <public>

把一个会话设为公开 agent，或收回私有

“放别人进来”的一种（种类 agent-exposure）：要 PIN，AI 不能做。**公开 agent 会串话**：来访者问它时读得到主线的上下文，回答里可能带出主人自己工作的内容；带“办”标记的请求进主线，一问一答留在主线里。要互不干扰的对外服务用常驻 agent。设为公开之后，谁能调用由开放范围决定（默认对所有互认的人开放，第一次调用弹卡片；`PUT /api/agents/:aid/audience`）。拒绝（409）：会话已归档（`session_archived`）；是「只问」支线或常驻 agent 的会话（`not_publishable`）；会话的身份跳过所有确认（`bypass_not_private`）；这个 AI 没有只读模式、不能接受“问”，而“办”又关着（`act_required`：这样的 agent 只有在允许办时才能公开）。收回私有立即生效：进行中和排队的外来任务停下（已拒绝），等批准的卡片作废，它的授权、开放范围、问与办的设置一并清掉；已经产生的副作用不回滚。已经是这个状态时什么都不改。

参数：
  <id>                     会话的编号（公开 agent 的编号就是它）（string，1–200 字符，必填）
  <public>                 true：设为公开（你互认的人按开放范围可以经 A2A 调用它；会串话，见说明）；false：收回私有（进行中的调用停下，授权、开放范围、问与办的设置一并清掉）（boolean，必填）

这一步要输入 PIN（终端里提示）。

接口：PUT /api/sessions/:id/public（grant.publicSet）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy agent public show

```text
用法：daisy agent public show <id>

看一个会话是不是公开 agent，现在能不能设为公开

读自己的会话，不要 PIN（设为公开或收回在 `PUT` 同一地址，要 PIN）。`blocked` 说明现在为什么不能设为公开；`crossTalk` 是设为公开前要让主人知道的话（公开 agent 会串话）。

参数：
  <id>                     （string，必填）

接口：GET /api/sessions/:id/public（session.publicShow）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy agent resident close

```text
用法：daisy agent resident close <aid>

关闭一个常驻 agent：不再接受调用，进行中的任务停下，专属会话关闭（记录保留）

不要 PIN：关闭只收回，不放任何人进来。它的授权、开放范围、待批准的卡片一并删掉，进行中的调用停下（已拒绝），名片和地址随之消失；专属会话归档、进程停掉，记录留着可读。关闭后不能恢复，要再提供服务就新建一个。

参数：
  <aid>                    常驻 agent 的编号（string，1–200 字符，必填）

接口：POST /api/residents/:aid/close（grant.residentClose）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy agent resident create

```text
用法：daisy agent resident create [选项]

创建一个常驻 agent

“放别人进来”的一种（种类 agent-exposure）：要 PIN，AI 不能做。创建后它就能被互认的人调用（开放范围默认对所有互认的人，第一次调用弹卡片；用 `daisy agent audience set` 收窄）。每段来访对话拉起一个专属会话，互相看不到。身份档不能开着跳过所有确认的模式。

选项：
  --name                   名字：agent 名片上的标题（string，1–64 字符，必填）
  --description            一句话说明它提供什么服务（名片的描述）（string，≤ 500 字符）
  --role                   提示词第二层「角色」：它是谁、对外提供什么服务（string，≤ 20000 字符）
  --instructions           提示词第三层「做事的指引」：怎么回答、什么能做什么不能做（string，≤ 20000 字符）
  --knowledge              提示词第四层「资料」：它可以引用的背景资料（string，≤ 20000 字符）
  --permission-mode        权限模式：这个 harness 的权限模式之一，或 session = 跟随身份档的。默认 auto（harness 有这一档时）。不能是跳过所有确认的模式（string，1–40 字符）
  --dirs                   除工作区之外还可以用的目录（绝对路径，可重复）；只有声明支持的 harness 能设（Claude Code）（string[]，≤ 20 项）
  --tools                  可以用的 harness 内置工具（可重复，如 Read、Grep、Glob）；写 * 表示 harness 的默认全部。只有声明支持的 harness 能设（Claude Code）（string[]，≤ 64 项）
  --concurrency            同时进行的来访对话上限（默认 4）；超出的任务停在“已提交”排队，不丢（integer，1–32）
  --daily-turns            每 24 小时最多跑几轮（0 = 不限，最多 1000）；到了上限的调用被拒绝 QUOTA_EXCEEDED（integer，0–1000）
  --approvals              自动模式仍要人确认的操作：reject = 自动拒绝（默认，任务继续或失败，不等人）；owner = 发给主人确认（任务保持工作中）（"reject" | "owner"）
  --harness                用哪家 harness（claude、codex、kimi、opencode……）（string，1–64 字符，必填）
  --workspace-id           工作区的编号（`daisy workspace catalog` 列出）（string，1–200 字符，必填）
  --profile-id             身份档的编号（`daisy workspace catalog` 列出）：必须是这家 harness、在工作区所在设备上的（string，1–200 字符，必填）

这一步要输入 PIN（终端里提示）。

接口：POST /api/residents（grant.residentCreate）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy agent resident delete

```text
用法：daisy agent resident delete <aid>

删除一个常驻 agent 和它的全部专属会话

不要 PIN：删除只收回，不放任何人进来。先照“关闭”收回，再删掉配置和专属会话的记录。

参数：
  <aid>                    常驻 agent 的编号（string，1–200 字符，必填）

接口：DELETE /api/residents/:aid（grant.residentDelete）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy agent resident list

```text
用法：daisy agent resident list

列出常驻 agent

只读：网页、配对设备、外部签发方给主人的令牌不要 PIN，本机命令行要（命令行凭据可能是主人的 AI）；仍要 `daisy:grant`，AI 和来访者读不到。

这一步要输入 PIN（终端里提示）。

接口：GET /api/residents（grant.residentList）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy agent resident pause

```text
用法：daisy agent resident pause <aid>

暂停一个常驻 agent：之后的调用被拒绝（AGENT_PAUSED）

不要 PIN：暂停只收回，不放任何人进来。还在排队、没开始的任务一并被拒绝（AGENT_PAUSED）；已经在跑的这一轮照常跑完。

参数：
  <aid>                    常驻 agent 的编号（string，1–200 字符，必填）

接口：POST /api/residents/:aid/pause（grant.residentPause）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy agent resident resume

```text
用法：daisy agent resident resume <aid>

恢复一个暂停的常驻 agent

要 PIN：恢复等于重新让别人调用它。

参数：
  <aid>                    常驻 agent 的编号（string，1–200 字符，必填）

这一步要输入 PIN（终端里提示）。

接口：POST /api/residents/:aid/resume（grant.residentResume）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy agent resident set

```text
用法：daisy agent resident set <aid> [选项]

修改一个常驻 agent：名字、提示词、权限模式、目录、工具、并发、用量、确认怎么处理

要 PIN（收紧也算修改）。harness、工作区、身份档创建后不能改。新的设置从下一轮起生效；目录和工具变了，专属会话的进程在下一轮重开。

参数：
  <aid>                    常驻 agent 的编号（string，1–200 字符，必填）

选项：
  --name                   名字：agent 名片上的标题（string，1–64 字符）
  --description            一句话说明它提供什么服务（名片的描述）（string，≤ 500 字符）
  --role                   提示词第二层「角色」：它是谁、对外提供什么服务（string，≤ 20000 字符）
  --instructions           提示词第三层「做事的指引」：怎么回答、什么能做什么不能做（string，≤ 20000 字符）
  --knowledge              提示词第四层「资料」：它可以引用的背景资料（string，≤ 20000 字符）
  --permission-mode        权限模式：这个 harness 的权限模式之一，或 session = 跟随身份档的。默认 auto（harness 有这一档时）。不能是跳过所有确认的模式（string，1–40 字符）
  --dirs                   除工作区之外还可以用的目录（绝对路径，可重复）；只有声明支持的 harness 能设（Claude Code）（string[]，≤ 20 项）
  --tools                  可以用的 harness 内置工具（可重复，如 Read、Grep、Glob）；写 * 表示 harness 的默认全部。只有声明支持的 harness 能设（Claude Code）（string[]，≤ 64 项）
  --concurrency            同时进行的来访对话上限（默认 4）；超出的任务停在“已提交”排队，不丢（integer，1–32）
  --daily-turns            每 24 小时最多跑几轮（0 = 不限，最多 1000）；到了上限的调用被拒绝 QUOTA_EXCEEDED（integer，0–1000）
  --approvals              自动模式仍要人确认的操作：reject = 自动拒绝（默认，任务继续或失败，不等人）；owner = 发给主人确认（任务保持工作中）（"reject" | "owner"）

这一步要输入 PIN（终端里提示）。

接口：PATCH /api/residents/:aid（grant.residentSet）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy agent resident show

```text
用法：daisy agent resident show <aid>

看一个常驻 agent：配置、分层提示词、用量、来访对话

只读：网页等主人入口不要 PIN，本机命令行要。

参数：
  <aid>                    常驻 agent 的编号（string，1–200 字符，必填）

这一步要输入 PIN（终端里提示）。

接口：GET /api/residents/:aid（grant.residentShow）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy approval

```text
用法：daisy approval <子命令> …

子命令：
  comment add   在审批卡片上留言或要求修改
  comment list  读一张审批卡片上的讨论
  list          列出审批卡片（默认只列待处理的）
  show          读一张审批卡片

每条子命令的参数：daisy approval <子命令> --help
```

#### daisy approval comment add

```text
用法：daisy approval comment add <aid> [选项]

在审批卡片上留言或要求修改

留言不做决定。`requestId` 是幂等键：重发只记一条。

参数：
  <aid>                    （string，必填）

选项：
  --body                   （string，1–4000 字符，必填）
  --kind                   （"comment" | "change_request"，默认 "comment"）

重发同一条命令不会重复执行（自动带幂等键）。

接口：POST /api/approvals/:aid/comments（approval.comment）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  --idempotency-key <键>   指定幂等键（默认自动生成）；断线后用同一个键重发不会重复执行
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy approval comment list

```text
用法：daisy approval comment list <aid>

读一张审批卡片上的讨论

参数：
  <aid>                    （string，必填）

接口：GET /api/approvals/:aid/comments（approval.comments）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy approval list

```text
用法：daisy approval list [选项]

列出审批卡片（默认只列待处理的）

新的在前；`before` 取某个时间之前的，翻页用。

选项：
  --status                 待处理、已处理或全部（"pending" | "decided" | "all"，默认 "pending"）
  --before                 只列出早于这个时间（毫秒）的（integer，≥ 0）
  --limit                  条数（integer，1–200，默认 100）

接口：GET /api/approvals（approval.list）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy approval show

```text
用法：daisy approval show <aid>

读一张审批卡片

参数：
  <aid>                    （string，必填）

接口：GET /api/approvals/:aid（approval.show）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy attachment

```text
用法：daisy attachment <子命令> …

子命令：
  download  下载附件
  upload    上传附件

每条子命令的参数：daisy attachment <子命令> --help
```

#### daisy attachment download

```text
用法：daisy attachment download <id>

下载附件

常见图片类型以 inline 返回，其余作为下载。

参数：
  <id>                     （string，必填）

接口：GET /api/attachments/:id（attachment.download）

通用选项：
  --output <文件>          把下载的内容存到文件（不写就输出到标准输出）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy attachment upload

```text
用法：daisy attachment upload [选项]

上传附件

内容用 base64 放在 `data` 里；解码后最多 8 MiB。

选项：
  --name                   文件名（string，1–250 字符，必填）
  --mime                   MIME 类型（string，≤ 150 字符，必填）
  --data <文件>              文件内容，base64（给文件路径，发送文件内容，≤ 12582912 字符，必填）

接口：POST /api/attachments（attachment.upload）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy audit

```text
用法：daisy audit <子命令> …

子命令：
  list  查看审计：谁、经什么入口、对什么做了什么、结果、链路号
  logs  查看最近的日志（已隐去凭据、令牌、PIN）

每条子命令的参数：daisy audit <子命令> --help
```

#### daisy audit list

```text
用法：daisy audit list [选项]

查看审计：谁、经什么入口、对什么做了什么、结果、链路号

从新到旧分页。每个本机接口的动作（读取除外）、每次被拒绝、AI 用的每个工具、各处理函数自己的领域记录（如 pin.*、session.create）都在这里；同一次动作引起的记录带同一个链路号。只有主人能看（网页、配对设备、命令行），AI 的工作凭据不能。读审计本身也记一条。

选项：
  --limit                  最多取多少条（1–500，默认 100），从新到旧（integer，1–500，默认 100）
  --before                 翻页：上一页回答里的 next（string）
  --since                  只取这个时间（毫秒）及以后的（integer，≥ 0）
  --until                  只取这个时间（毫秒）以前的（integer，≥ 0）
  --channel                只取这个通道的：web、device、cli、issuer、a2a、ai、system、none（"web" | "device" | "cli" | "issuer" | "a2a" | "ai" | "system" | "none"）
  --route                  只取这个接口（如 session.cancel）或工具（如 tool.wakeup）的（string，1–100 字符）
  --action                 只取这个动作的（如 api.session.create、access.denied、pin.grant）（string，1–100 字符）
  --actor                  只取这类身份的（"owner" | "cli" | "ai" | "visitor" | "anonymous" | "system"）
  --outcome                只取这个结果的：ok、denied、error（"ok" | "denied" | "error"）
  --session                只取这个会话的 AI（或为它这一轮做的）（string，1–200 字符）
  --trace                  只取这个链路号的（string）

接口：GET /api/audit（system.auditList）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy audit logs

```text
用法：daisy audit logs [选项]

查看最近的日志（已隐去凭据、令牌、PIN）

这个进程最近写的日志行（最多 1000 行，重启后清空；完整日志在服务管理器里，如 journalctl）。每行都已经过脱敏，带链路号的可以和审计对上。只有主人能看。

选项：
  --limit                  最多取多少行（默认 200），最新的在最后（integer，1–1000，默认 200）
  --level                  最低级别：info（全部）、warn、error（"info" | "warn" | "error"）
  --trace                  只取这个链路号的（string）
  --after                  只取这个序号之后的（接着上次读）（integer，≥ 0）

接口：GET /api/logs（system.logs）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy call

```text
用法：daisy call <子命令> …

子命令：
  list  列出我的 AI 调用别人的 agent 的记录（我的 AI 调用了谁）
  show  看我的 AI 的一次调用：发了什么、对方的状态、完整的答复

每条子命令的参数：daisy call <子命令> --help
```

#### daisy call list

```text
用法：daisy call list [选项]

列出我的 AI 调用别人的 agent 的记录（我的 AI 调用了谁）

AI 的 `call_agent` 工具每发一次一条：调用了谁的哪个 agent、问还是办、对方回答到哪一步、答复、链路号。最新的在前。只读；回答里的答复截到 2000 字（全文用 `GET /api/calls/:cid`）。

选项：
  --session                只列这个会话（我的哪个 AI）发出的（string，1–200 字符）
  --contact                只列调用这个联系人（编号）的（string，1–200 字符）
  --state                  open：还没结束的（含等我的 AI 补充的）；settled：已结束的；all：全部（"open" | "settled" | "all"，默认 "all"）
  --limit                  条数（integer，1–200，默认 50）

接口：GET /api/calls（session.outgoingList）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy call show

```text
用法：daisy call show <cid>

看我的 AI 的一次调用：发了什么、对方的状态、完整的答复

参数：
  <cid>                    调用的编号（`daisy call list`）（string，1–200 字符，必填）

接口：GET /api/calls/:cid（session.outgoingShow）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy contact

```text
用法：daisy contact <子命令> …

子命令：
  export            导出自己的身份名片（一段可以复制的文本）（要 PIN）
  import            导入别人的身份名片（加进通讯录），可以同时加进白名单（要 PIN）
  inspect           看一张名片是谁的（验签名、算编号），不加入通讯录（要 PIN）
  list              列出通讯录里的联系人（互认的名片）和谁在白名单里（要 PIN）
  remove            移除一位联系人：从此不再认得他（要 PIN）
  show              看一位联系人，连同他名片的文本（要 PIN）
  whitelist add     把一位联系人加进白名单（要 PIN）
  whitelist remove  把一位联系人移出白名单（要 PIN）

每条子命令的参数：daisy contact <子命令> --help
```

#### daisy contact export

```text
用法：daisy contact export [选项]

导出自己的身份名片（一段可以复制的文本）

名片里有显示名、这个 Daisy 的公钥和编号、可以连到它的地址，由身份密钥签名。把文本发给对方（或存成 .daisycard 文件），对方导入后就认得你（互认要双方各导入一次）。名片本身不带任何权限。只读：网页等主人入口不要 PIN，本机命令行要。

选项：
  --name                   名片上的显示名；不写用这台机器上主人的账户名（string，1–64 字符）
  --note                   一句备注，比如“公司那台服务器”（string，≤ 200 字符）
  --direct                 直连地址（这个 Daisy 对外面的根地址），可以写多个；不写也不写 relay 时，用对外面正在监听的地址（没开就没有地址）（string[]，≤ 8 项）
  --relay                  中转给的固定地址，可以写多个（string[]，≤ 8 项）

这一步要输入 PIN（终端里提示）。

接口：GET /api/contacts/me（grant.contactExport）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy contact import

```text
用法：daisy contact import [card] [选项]

导入别人的身份名片（加进通讯录），可以同时加进白名单

“放别人进来”的一种：要 PIN，AI 不能做。先验名片（签名、编号、人看的行），不能加自己；已在通讯录里的人要带 update 才替换，更旧的名片不能替换更新的。加入后对方签的令牌才被认得；互认本身不带调用权限，勾上白名单才预先批准。

参数：
  <card>                   名片的文本：对方导出的整段（几行人看的加最后一行 daisy-card:1:…），或只有最后那一行；中间被插入的换行和空格会去掉（string，1–16384 字符）

选项：
  --card-file <文件>         名片文件（.daisycard，内容与文本相同）；和 card 二选一（给文件路径，发送文件内容，≤ 32768 字符）
  --whitelist              同时加进白名单：他调用你“对所有互认的人开放”的 agent 时不再弹卡片。更新已有联系人时不写就保持原样（boolean）
  --update                 这个人已经在通讯录里时，用这张（更新的）名片替换原来的；不写则回 409 并列出差异（boolean）
  --expect-id              你和对方核对过的编号（可以只写前 16 个以上字符）：名片的编号对不上就拒绝（string，≤ 200 字符）

这一步要输入 PIN（终端里提示）。

接口：POST /api/contacts（grant.contactImport）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy contact inspect

```text
用法：daisy contact inspect [card] [选项]

看一张名片是谁的（验签名、算编号），不加入通讯录

只读你给的这段文本，不读也不改通讯录。导入前先用它把名字和完整编号给主人看，请他和对方（经另一条可信的渠道）核对编号。只读：网页等主人入口不要 PIN，本机命令行要；仍要 `daisy:grant`，AI 不能调用。

参数：
  <card>                   名片的文本：对方导出的整段（几行人看的加最后一行 daisy-card:1:…），或只有最后那一行；中间被插入的换行和空格会去掉（string，1–16384 字符）

选项：
  --card-file <文件>         名片文件（.daisycard，内容与文本相同）；和 card 二选一（给文件路径，发送文件内容，≤ 32768 字符）

这一步要输入 PIN（终端里提示）。

接口：POST /api/contacts/inspect（grant.contactInspect）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy contact list

```text
用法：daisy contact list

列出通讯录里的联系人（互认的名片）和谁在白名单里

只读：网页、配对设备、外部签发方给主人的令牌不要 PIN，本机命令行要（命令行凭据可能是主人的 AI）；仍要 `daisy:grant`，AI 和来访者读不到。

这一步要输入 PIN（终端里提示）。

接口：GET /api/contacts（grant.contactList）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy contact remove

```text
用法：daisy contact remove <id>

移除一位联系人：从此不再认得他

立即生效：他签的令牌从下一个请求起一律 401，白名单随之去掉，进行中的调用由调用授权停下。要再认得他，得重新导入他的名片。

参数：
  <id>                     联系人的身份编号（可以带空格、不分大小写），或它的前 8 个以上字符（只要不和别人重），或它的 URN（string，8–200 字符，必填）

这一步要输入 PIN（终端里提示）。

接口：DELETE /api/contacts/:id（grant.contactRemove）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy contact show

```text
用法：daisy contact show <id>

看一位联系人，连同他名片的文本

只读：网页等主人入口不要 PIN，本机命令行要。

参数：
  <id>                     联系人的身份编号（可以带空格、不分大小写），或它的前 8 个以上字符（只要不和别人重），或它的 URN（string，8–200 字符，必填）

这一步要输入 PIN（终端里提示）。

接口：GET /api/contacts/:id（grant.contactShow）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy contact whitelist add

```text
用法：daisy contact whitelist add <id>

把一位联系人加进白名单

预先批准他调用你所有“对所有互认的人开放”的 agent：他第一次调用不再弹卡片。只对互认的人：先导入名片。

参数：
  <id>                     联系人的身份编号（可以带空格、不分大小写），或它的前 8 个以上字符（只要不和别人重），或它的 URN（string，8–200 字符，必填）

这一步要输入 PIN（终端里提示）。

接口：PUT /api/contacts/:id/whitelist（grant.contactWhitelistAdd）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy contact whitelist remove

```text
用法：daisy contact whitelist remove <id>

把一位联系人移出白名单

之后他调用“对所有互认的人开放”的 agent 时，没有单独授权的要主人批准。

参数：
  <id>                     联系人的身份编号（可以带空格、不分大小写），或它的前 8 个以上字符（只要不和别人重），或它的 URN（string，8–200 字符，必填）

这一步要输入 PIN（终端里提示）。

接口：DELETE /api/contacts/:id/whitelist（grant.contactWhitelistRemove）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy device

```text
用法：daisy device <子命令> …

子命令：
  list    列出配对过的设备（只有记录，没有凭据）（要 PIN）
  revoke  吊销一台配对过的设备（要 PIN）

每条子命令的参数：daisy device <子命令> --help
```

#### daisy device list

```text
用法：daisy device list [选项]

列出配对过的设备（只有记录，没有凭据）

默认只列还有效的；`state=all` 连吊销和过期的也列（保留 30 天）。`pairLocks`：因输错配对码被暂停配对的来源（按来源：直连监听的地址、经中转的按中转报的地址）和到什么时候；`pairLockedUntil`：其中最晚的（没有为 null）。只读：网页、配对设备、外部签发方给主人的令牌不要 PIN，本机命令行要（命令行凭据可能是主人的 AI）；仍要 `daisy:grant`，AI 和来访者读不到。

选项：
  --state                  active：还有效的；all：连吊销和过期的（保留 30 天）也列（"active" | "all"，默认 "active"）

这一步要输入 PIN（终端里提示）。

接口：GET /api/devices（settings.deviceList）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy device revoke

```text
用法：daisy device revoke <id>

吊销一台配对过的设备

立即生效：它的设备凭据和会话作废，已连上的实时通道马上断开（关闭码 4401，“设备已吊销”），正在处理的请求回答 401。要 PIN（配对和吊销设备同属一项要 PIN 的权限）。已经吊销的再吊销一次回答原来的记录。

参数：
  <id>                     设备编号（daisy device list 里的 id）（string，1–64 字符，必填）

这一步要输入 PIN（终端里提示）。

接口：DELETE /api/devices/:id（settings.deviceRevoke）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy events

```text
用法：daisy events <子命令> …

子命令：
  list      按序号增量读取事件出口（可长轮询）
  snapshot  事件出口的快照：现在所有没了结的卡片，和接着读的序号

每条子命令的参数：daisy events <子命令> --help
```

#### daisy events list

```text
用法：daisy events list [选项]

按序号增量读取事件出口（可长轮询）

每条事件是一条 CloudEvents 1.0 事件（docs/contracts/events.md）：AI 请求授权、AI 提问、有人想调用待批准，各有“出现”和“了结”两种。按 `seq` 从小到大；`cursor` 是这一页最后一条的 `seq`（这一页为空时等于 `after`），下次当 `after` 用；`hasMore` 为真时立即接着读。

`wait` 秒内（最多 30）没有新事件就回空页；有新事件立即回答。

断线续读：订阅方处理完一页再保存 `cursor`，重启后从它接着读；可能再读到同一批，按 `id` 去重。`after` 早于保留期内的事件（已被清理），或比这个 Daisy 写过的最大序号还大（数据被重建过）时回 410、`code: cursor_reset`：先取快照，再从快照的 `cursor` 接着读。

没人订阅时什么都不发生：事件照写，保留 30 天后清理；没了结的卡片对应的“出现”事件在了结之前不清理。

选项：
  --after                  只回答 seq 大于它的事件（上次回答的 cursor），默认 0（integer，≥ 0）
  --limit                  最多几条，默认 200（integer，1–200）
  --wait                   长轮询：没有新事件时最多等这么多秒（0–30），有新事件立即回答（integer，0–30）

接口：GET /api/events（events.list）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy events snapshot

```text
用法：daisy events snapshot

事件出口的快照：现在所有没了结的卡片，和接着读的序号

回答每张还没了结的卡片的“出现”事件（按 `seq` 从小到大），以及 `cursor`：之后用它做 `GET /api/events` 的 `after`，不会漏掉取快照之后的事件。第一次订阅、或收到 `cursor_reset` 时用。

接口：GET /api/events/snapshot（events.snapshot）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy grant

```text
用法：daisy grant <子命令> …

子命令：
  list    列出永久通过的调用授权（每个 agent 乘每个人一条）（要 PIN）
  revoke  撤销一条调用授权（要 PIN）

每条子命令的参数：daisy grant <子命令> --help
```

#### daisy grant list

```text
用法：daisy grant list [选项]

列出永久通过的调用授权（每个 agent 乘每个人一条）

白名单不在这里（它是联系人上的标记，见 `GET /api/contacts`）。只读：网页等主人入口不要 PIN，本机命令行要。

选项：
  --agent                  只列这个 agent 的（string，1–200 字符）
  --contact                只列这个联系人的（编号）（string，1–200 字符）

这一步要输入 PIN（终端里提示）。

接口：GET /api/grants（grant.grantList）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy grant revoke

```text
用法：daisy grant revoke <gid>

撤销一条调用授权

立即生效：这个人正在进行的、靠这条授权进来的调用被停下，之后再调用这个 agent 重新要批准。要 PIN。

参数：
  <gid>                    授权的编号（`GET /api/grants`）（string，1–200 字符，必填）

这一步要输入 PIN（终端里提示）。

接口：DELETE /api/grants/:gid（grant.grantRevoke）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy language

```text
用法：daisy language <子命令> …

子命令：
  set   设置显示语言（null 表示跟随系统）
  show  查看显示语言：主人的设置、现在用的、可选的

每条子命令的参数：daisy language <子命令> --help
```

#### daisy language set

```text
用法：daisy language set <language>

设置显示语言（null 表示跟随系统）

网页、命令行、本机接口的提示和新会话给模型的提示词都用它；已经在运行的会话保持原来的语言，下一个新会话起换。Daisy 没在运行时，daisy language set 和 daisy language show 自己读写数据目录里的 config.json（下次启动时生效）。

参数：
  <language>               语言（en、zh-CN …，见 language show 的 available）；null 跟随系统（string | null，必填）

接口：PUT /api/settings/language（settings.languageSet）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy language show

```text
用法：daisy language show

查看显示语言：主人的设置、现在用的、可选的

接口：GET /api/settings/language（settings.languageShow）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy login

```text
用法：daisy login <子命令> …

子命令：
  cancel  取消登录流程
  input   交授权页给的授权码
  list    列出自己最近的登录流程（30 条）
  show    看一个登录流程的状态、授权地址
  start   开始登录一家 harness（独立登录的身份档）

登录一家 harness（`login` 是一组命令，不是一个交互程序；网页的“设置 → 登录”做的是同一件事）：
  1. daisy workspace catalog                      看执行节点 id（nodes[].id）和已有的身份档
  2. daisy profile create-managed --agent codex --node-id <节点 id> --label 我的 Codex
                                                  建一个独立登录的身份档（不动这台机器上原有的登录）
  3. daisy login start <身份档 id>                 开始登录，回答里有登录流程 id
  4. daisy login show <流程 id>                    拿到授权地址（url、userCode），在任何一台机器的浏览器里打开
  5. daisy login input <流程 id>                   授权页给了授权码时交给它（提示输入，不回显）
  6. daisy login show <流程 id>                    status 变成 complete 就好了；取消用 daisy login cancel <流程 id>
用 API key 的 Claude：daisy profile create --agent claude --auth-mode apiKey --node-id <节点 id> --label 我的 key --api-key（提示输入 key，不回显）。

每条子命令的参数：daisy login <子命令> --help
```

#### daisy login cancel

```text
用法：daisy login cancel <id>

取消登录流程

参数：
  <id>                     登录流程 id（string，必填）

接口：POST /api/logins/:id/cancel（profile.loginCancel）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy login input

```text
用法：daisy login input <id> [选项]

交授权页给的授权码

参数：
  <id>                     登录流程 id（string，必填）

选项：
  --code                   授权码（从标准输入或提示读取，不接受命令行里的值，1–2048 字符，必填）

接口：POST /api/logins/:id/input（profile.loginInput）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy login list

```text
用法：daisy login list

列出自己最近的登录流程（30 条）

接口：GET /api/logins（profile.logins）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy login show

```text
用法：daisy login show <id>

看一个登录流程的状态、授权地址

参数：
  <id>                     登录流程 id（string，必填）

接口：GET /api/logins/:id（profile.login）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy login start

```text
用法：daisy login start <id>

开始登录一家 harness（独立登录的身份档）

已有进行中的登录时回答那一个。之后用 `login show` 看授权地址，需要时 `login input` 交授权码。

参数：
  <id>                     身份档 id（string，必填）

接口：POST /api/profiles/:id/login（profile.loginStart）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy notify

```text
用法：daisy notify <子命令> …

子命令：
  list  列出会话的通知：一轮结束、审批卡片、AI 出错
  set   改通知设置
  show  读通知设置（种类 × 设备）

每条子命令的参数：daisy notify <子命令> --help
```

#### daisy notify list

```text
用法：daisy notify list [选项]

列出会话的通知：一轮结束、审批卡片、AI 出错

每条通知只回答它现在的样子（最后一次修订）：待处理的审批是 `pending`，审批处理或撤回之后是 `handled` / `canceled` / `expired`，其余是 `unread`（已读与否由各界面自己记）。按最后变化从新到旧排列。

选项：
  --session-id             只看这个会话的通知（string，1–200 字符）
  --after                  游标：只回答在它之后有变化的条目（上次回答的 cursor）（integer，≥ 0）
  --limit                  最多几条，默认 50（integer，1–200）
  --device                 按这台设备的通知设置算出每条是否提醒（alert）（"web" | "mobile"）

接口：GET /api/notifications（session.notifications）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy notify set

```text
用法：daisy notify set [选项]

改通知设置

只改请求里列出的格子；带 `revision` 时防止覆盖另一台设备上的修改。

选项：
  --revision               上次读到的版本；不一致时回 409（integer，≥ 0）
  --device                 在哪台设备上改的（"web" | "mobile"）
  --matrix                 要改的格子：种类 → 设备 → 开关（Record<string, object>）

接口：PUT /api/notification-preferences（settings.notificationsSet）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy notify show

```text
用法：daisy notify show

读通知设置（种类 × 设备）

接口：GET /api/notification-preferences（settings.notifications）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy pair

```text
用法：daisy pair [选项]

生成一个配对码（daisy pair）：另一台设备输入它，就以主人身份连进来

“放别人进来”的一种（种类 device）：要 PIN，AI 不能做。配对码 10 分钟内有效、只能用一次，只在对外面上能用（先开启对外面的监听或选一个中转，都要 PIN）；回答里有码本身和一个链接（码在 # 后面，不进请求行和日志；网页把它画成二维码）。对外面的监听开着时链接是直连的（中转运营者能为中转地址冒签证书），中转的链接另给（`relayUrl`、`relayWarning`）；只有中转时给中转的链接，`warning` 直说中转运营者能拿到配对码和设备凭据；中转只有自签名证书时不给链接（`url: null`），只给码、在设备上手动输入，并说明不要点过证书警告。同时最多 5 个没用掉的码，再生成就挤掉最早的；同一来源（直连监听的地址；经中转的按中转报的地址）输错 5 次，暂停这个来源 15 分钟（别的来源照常）；所有来源一共输错 20 次，这期间的码作废。回答里 `wasLocked`、`recentFailures` 说明有人输错过。重置或修改 PIN 时没用掉的码一并作废，暂停也解除。

选项：
  --name                   给这台设备起的名字；不填时用设备自己报的（浏览器名）（string，1–60 字符）

这一步要输入 PIN（终端里提示）。

接口：POST /api/devices/pair（settings.pair）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy pin

```text
用法：daisy pin <子命令> …

子命令：
  reset   在本机重置 PIN（清掉 PIN 和全部 PIN 授权）
  set     设置或修改 PIN
  status  查看 PIN 是否已设置、是否被锁定

每条子命令的参数：daisy pin <子命令> --help
```

#### daisy pin reset

```text
用法：daisy pin reset [选项]

在本机重置 PIN（清掉 PIN 和全部 PIN 授权）

只在本机命令行做（本机凭据），网页、配对设备和 AI 都不能调用。重置会清掉 PIN 和所有 PIN 授权，撤销对外部签发方的信任和存着的主人令牌，关闭对外面并作废它上面的网页会话和一次性口令，吊销全部对外授权、互认的名片和配对的设备，记一条审计；之后只能在本机命令行重新设置 PIN。

选项：
  --confirm                确认重置：会撤销外部签发方的信任和存着的主人令牌，吊销全部对外授权、互认的名片和配对的设备（true，必填）

接口：POST /api/pin/reset（settings.pinReset）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy pin set

```text
用法：daisy pin set [选项]

设置或修改 PIN

第一次设置不需要旧 PIN；在本机重置过之后，只能在这台机器的命令行上重新设置。已经设置过时要带旧 PIN，旧 PIN 输错和换授权一样计入连续输错。修改后，之前发出的 PIN 授权全部失效。Daisy 只保存 PIN 的校验值。PIN 设好之前 Daisy 不启动任何 AI 轮次。

选项：
  --pin                    新 PIN（6–128 位，可以是纯数字）（从标准输入或提示读取，不接受命令行里的值，1–512 字符，必填）
  --old-pin                旧 PIN：已经设置过时必填（从标准输入或提示读取，不接受命令行里的值，1–512 字符）

接口：POST /api/pin（settings.pinSet）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy pin status

```text
用法：daisy pin status

查看 PIN 是否已设置、是否被锁定

还给出最近一次设置和重置的时间与入口，网页和配对设备据此持续提示主人。PIN 没设置时 Daisy 不启动任何 AI 轮次。

接口：GET /api/pin（settings.pinStatus）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy profile

```text
用法：daisy profile <子命令> …

子命令：
  auto-compact restart  立即重启还没用上新阈值的在线进程
  auto-compact show     看身份档的自动压缩阈值，以及各在线进程是否已用上
  create                新建身份档（API key 或复用本机已登录的 CLI）
  create-managed        新建独立登录的身份档（订阅登录，有自己的 CLI 目录）
  delete                删除身份档
  update                改身份档的模型、推理强度、权限模式、模型槽位、自动压缩阈值

每条子命令的参数：daisy profile <子命令> --help
```

#### daisy profile auto-compact restart

```text
用法：daisy profile auto-compact restart <id>

立即重启还没用上新阈值的在线进程

会打断这些进程正在做的事；先用 `show` 看 `interrupts`。

参数：
  <id>                     身份档 id（string，必填）

接口：POST /api/profiles/:id/auto-compact/restart（profile.autoCompactRestart）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy profile auto-compact show

```text
用法：daisy profile auto-compact show <id>

看身份档的自动压缩阈值，以及各在线进程是否已用上

参数：
  <id>                     身份档 id（string，必填）

接口：GET /api/profiles/:id/auto-compact（profile.autoCompact）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy profile create

```text
用法：daisy profile create [选项]

新建身份档（API key 或复用本机已登录的 CLI）

API key 身份只用于 Claude 及兼容服务；其他 Agent 用 `login` 登录。

选项：
  --label                  （string，1–100 字符，必填）
  --node-id                （string，必填）
  --agent                  （"claude" | "codex" | "kimi" | "opencode" | "antigravity" | "deepseek"，必填）
  --auth-mode              （"subscription" | "apiKey"，必填）
  --model                  （string，≤ 200 字符，默认 ""）
  --base-url               （string，≤ 1000 字符，默认 ""）
  --config-dir             （string，≤ 1000 字符，默认 ""）
  --api-key                （从标准输入或提示读取，不接受命令行里的值，≤ 10000 字符）
  --auth-header            （"apiKey" | "bearer"，默认 "apiKey"）
  --model-slots            （object）

接口：POST /api/profiles（profile.create）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy profile create-managed

```text
用法：daisy profile create-managed [选项]

新建独立登录的身份档（订阅登录，有自己的 CLI 目录）

建好后用 `daisy login start <id>` 登录；不会动本机原有的 CLI 凭据。

选项：
  --agent                  （"claude" | "codex" | "kimi" | "opencode" | "antigravity" | "deepseek"，必填）
  --node-id                执行节点 id（string，必填）
  --label                  显示名（string，1–100 字符，必填）

接口：POST /api/identities（profile.createManaged）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy profile delete

```text
用法：daisy profile delete <id>

删除身份档

还有排队或运行中的任务时拒绝；未完成的登录一并取消。用过它的会话仍可读，但不能再发消息。

参数：
  <id>                     身份档 id（string，必填）

接口：DELETE /api/profiles/:id（profile.delete）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy profile update

```text
用法：daisy profile update <id> [选项]

改身份档的模型、推理强度、权限模式、模型槽位、自动压缩阈值

带 `model` 时是整组模型设置（没带的字段清空）；只带 `autoCompactTokens` 时只改阈值，回答里附带 `autoCompact`。

参数：
  <id>                     身份档 id（string，必填）

选项：
  --model                  （string，≤ 200 字符）
  --reasoning-effort       （"" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "on" | "off"）
  --service-tier           （string，≤ 40 字符）
  --permission-mode        （string，≤ 80 字符）
  --sandbox-mode           （"read-only" | "workspace-write" | "danger-full-access"）
  --model-slots            （object）
  --auto-compact-tokens    自动压缩阈值（token）；null = CLI 默认（integer | null）

接口：PATCH /api/profiles/:id（profile.update）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy prompt

```text
用法：daisy prompt <子命令> …

子命令：
  layers apply         「立即生效」：先预估，再凭预估凭证确认
  layers apply-cancel  取消这一批里还没开始的排队
  layers forget-node   忘掉一个节点上报的组织核心
  layers set           改分层提示词的设置
  layers show          看分层提示词的设置、各节点上报与生效队列
  mine set             改自己的提示词补充（说明与可选段落）
  mine show            看自己的提示词补充

每条子命令的参数：daisy prompt <子命令> --help
```

#### daisy prompt layers apply

```text
用法：daisy prompt layers apply [选项]

「立即生效」：先预估，再凭预估凭证确认

不带 `confirm` 只回答预估和一张一次性的 `token`；带 `confirm: true` 和这张 `token` 才执行：压缩最近使用、还没用上新文字的至多 `limit` 个会话。

选项：
  --confirm                确认执行（否则只预估）（boolean，默认 false）
  --limit                  这一批最多压缩几个会话（integer，1–100，默认 20）
  --token                  预估时拿到的凭证（string，≤ 100 字符）

接口：POST /api/admin/prompt-layers/apply-now（settings.layersApplyNow）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy prompt layers apply-cancel

```text
用法：daisy prompt layers apply-cancel

取消这一批里还没开始的排队

接口：POST /api/admin/prompt-layers/apply-cancel（settings.layersApplyCancel）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy prompt layers forget-node

```text
用法：daisy prompt layers forget-node <id>

忘掉一个节点上报的组织核心

参数：
  <id>                     （string，必填）

接口：DELETE /api/admin/prompt-layers/nodes/:id（settings.layersForgetNode）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy prompt layers set

```text
用法：daisy prompt layers set [选项]

改分层提示词的设置

选项：
  --mode                   （"off" | "allowlist" | "all"）
  --sessions               （string[]，≤ 500 项）
  --users                  （string[]，≤ 500 项）
  --static-rules           （boolean）
  --claude-fresh           （boolean）
  --fresh-list             （string[]，≤ 500 项）
  --org-read               （boolean）
  --org-expected           （string）

接口：PUT /api/admin/prompt-layers（settings.layersSet）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy prompt layers show

```text
用法：daisy prompt layers show

看分层提示词的设置、各节点上报与生效队列

接口：GET /api/admin/prompt-layers（settings.layersShow）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy prompt mine set

```text
用法：daisy prompt mine set [选项]

改自己的提示词补充（说明与可选段落）

选项：
  --note                   个人补充说明（string，≤ 4000 字符）
  --sections               可选段落的开关；null 表示回到默认（object）

接口：PUT /api/me/prompt（settings.mineSet）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy prompt mine show

```text
用法：daisy prompt mine show

看自己的提示词补充

接口：GET /api/me/prompt（settings.mineShow）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy relay

```text
用法：daisy relay <子命令> …

子命令：
  off   停用中转：断开，地址从名片里去掉（要 PIN）
  set   选择中转（或换一个）：Daisy 主动连出并保持，得到一个固定的对外地址（要 PIN）
  show  看中转：选了哪个、连上没有、对外地址、证书

每条子命令的参数：daisy relay <子命令> --help
```

#### daisy relay off

```text
用法：daisy relay off

停用中转：断开，地址从名片里去掉

正在经中转的连接立即断开，名片里不再有中转地址。密钥和证书留着（再选同一个中转时地址不变）。它只收窄谁能连进来，但仍要 PIN：命令行凭据可能是主人的 AI 经 Bash 在用，不能让它悄悄断开主人在别的网络里的可达性。

这一步要输入 PIN（终端里提示）。

接口：DELETE /api/relay（settings.relayOff）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy relay set

```text
用法：daisy relay set <url> [选项]

选择中转（或换一个）：Daisy 主动连出并保持，得到一个固定的对外地址

经中转进来的请求只进对外面，所以选中转等于让任何能连到中转的人都能敲对外面的门：要 PIN。不需要先开启对外面的监听（只经中转也行）；对外面的口令自动启用。证书：默认向 Let's Encrypt 申请（TLS-ALPN-01，经中转透传），申请到之前和申请不到时用自签名证书——那时经中转只有 Daisy 之间能用（它们核对 TLS 绑定声明），第三方客户端和浏览器会报证书不受信任。

参数：
  <url>                    中转自己的地址，例如 relay.example 或 https://relay.example:8443（只写域名和端口）（string，1–300 字符，必填）

选项：
  --acme                   为中转地址向证书机构申请证书（ACME TLS-ALPN-01，默认 Let's Encrypt）。关掉则只用自签名证书：经中转只有 Daisy 之间能用（boolean，默认 true）
  --acme-directory         ACME 目录地址（https），默认 Let's Encrypt；可换成别的支持 TLS-ALPN-01 的证书机构（string，1–300 字符）

这一步要输入 PIN（终端里提示）。

接口：PUT /api/relay（settings.relaySet）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy relay show

```text
用法：daisy relay show

看中转：选了哪个、连上没有、对外地址、证书

接口：GET /api/relay（settings.relayShow）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy request

```text
用法：daisy request <子命令> …

子命令：
  decide  批准或拒绝一张调用请求：永久通过、仅本次、拒绝（要 PIN）
  list    列出别人调用我的 agent 的请求（待批准的卡片）（要 PIN）
  show    看一张调用请求（要 PIN）

每条子命令的参数：daisy request <子命令> --help
```

#### daisy request decide

```text
用法：daisy request decide <rid> <decision> [选项]

批准或拒绝一张调用请求：永久通过、仅本次、拒绝

“放别人进来”的一种：要 PIN，AI 不能做。同一个决定再发一次回答原来的结果；已经用别的决定处理、过期或作废的回 409。批准时如果情况已经变了（对方被移出通讯录、agent 收回私有或不再对他开放），卡片作废，回 409 `request_stale`。

参数：
  <rid>                    请求的编号（`call:…`，可以不写 `call:`）（string，1–200 字符，必填）
  <decision>               永久通过（always：写下一条授权，这个人以后调用这个 agent 不再问；正在等的调用都放行）、仅本次（once：只放行发起这张卡片的那一次调用；同时在等的其它调用转到一张新卡片上再问）、拒绝（reject：在等的调用都被拒，10 分钟内再调用直接拒绝）（"always" | "once" | "reject"，必填）

选项：
  --note                   附言（只记在卡片上）（string，≤ 2000 字符）

这一步要输入 PIN（终端里提示）。

接口：POST /api/requests/:rid/decision（grant.requestDecide）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy request list

```text
用法：daisy request list [选项]

列出别人调用我的 agent 的请求（待批准的卡片）

默认只列待批准的。同一张卡片也出现在审批列表（`GET /api/approvals`，`kind: "call"`）里，但只能在这里批准或拒绝（要 PIN）。读：网页等主人入口不要 PIN，本机命令行要；仍要 `daisy:grant`：AI 和来访者读不到。

选项：
  --status                 待批准、已处理或全部（"pending" | "decided" | "all"，默认 "pending"）
  --limit                  条数（integer，1–200，默认 100）

这一步要输入 PIN（终端里提示）。

接口：GET /api/requests（grant.requestList）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy request show

```text
用法：daisy request show <rid>

看一张调用请求

只读：网页等主人入口不要 PIN，本机命令行要。

参数：
  <rid>                    请求的编号（`call:…`，可以不写 `call:`）（string，1–200 字符，必填）

这一步要输入 PIN（终端里提示）。

接口：GET /api/requests/:rid（grant.requestShow）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy restart

```text
用法：daisy restart <子命令> …

子命令：
  cancel   撤回还没执行的重启请求
  request  重启 Daisy（空闲时，或立即）
  status   查看待做的更新和重启，以及它在等什么

每条子命令的参数：daisy restart <子命令> --help
```

#### daisy restart cancel

```text
用法：daisy restart cancel

撤回还没执行的重启请求

接口：DELETE /api/update/restart（settings.updateCancel）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy restart request

```text
用法：daisy restart request [选项]

重启 Daisy（空闲时，或立即）

`idle` 等没有任何运行中的工作再重启；`now` 立即重启，会打断正在运行的轮次：先回 409，列出会打断什么并给一个 `confirm` 凭据；带回这个凭据才执行（这期间又有新工作开始，就再 409、给新清单和新凭据）。被打断的不重放。

选项：
  --mode                   idle：等空闲；now：立即（"idle" | "now"，默认 "idle"）
  --confirm                上一次 409 给的确认凭据：确认打断那份清单上的工作（string，1–64000 字符）

接口：POST /api/update/restart（settings.updateRestart）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy restart status

```text
用法：daisy restart status

查看待做的更新和重启，以及它在等什么

列出已装好或已构建、等空闲才生效的版本，主人的重启请求，以及正在运行、会被打断的会话和命令；npm 安装的 Daisy 另有 `package`：来源、找到的新版本、自动更新开关、上一次更新的结果（换上 / 退回 / 失败，原因、更新前的备份）。

接口：GET /api/update（settings.updateStatus）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy session

```text
用法：daisy session <子命令> …

子命令：
  activity             在线进程最近在做什么
  background stop      停止「后台」里的一项（Agent 的后台任务或 Daisy 的定时）
  cancel               停下会话当前这一轮
  create               新建会话
  delete               删除会话
  events               按序号增量读会话事件
  identity fresh       不带历史继续：放弃无法搬过来的原生历史
  identity switch      换身份：会话以自己的另一个身份档继续
  items                往前翻页：某一条之前的条目
  list                 列出自己的会话
  offline              让会话下线：关掉它的在线进程
  operation harness    改会话所用 harness 的配置：配置文件、MCP 服务、插件、技能
  operation run        在会话上执行一个原生操作（列模型、分叉、回退、压缩等）
  operation status     查一个原生操作的状态与结果
  prompt apply         立即压缩并让新提示词生效
  prompt apply-cancel  取消排队中的「立即生效」
  prompt set           改会话自己的提示词补充
  prompt show          看会话的分层提示词与生效状态
  queue jump           插队发送：一条排队消息立即开始
  queue list           列出排队中的消息（已追加未读的在前，插队的其次）
  queue merge-jump     合并插队：选中的排队消息合成一条并插队
  queue merge-steer    合并追加：选中的排队消息合成一条送进正在运行的这一轮
  queue remove         移除一条排队消息（已追加未读的则撤回）
  queue remove-many    批量移除排队消息（选中的，或全部）
  queue resume         继续执行暂停的队列：发出下一条排队消息
  recovery events      分页读一条恢复记录的事件
  recovery list        列出被中断的轮次留下的恢复记录（最近 50 条）
  schedule add         设一个定时器（一次性唤醒或周期 cron）
  schedule cancel      取消一个定时器或后台命令
  schedule list        列出会话的定时器与后台命令
  schedule update      修改一个还在等待的定时器
  send                 向会话发一条消息
  shell run            在会话的工作目录里执行一条命令
  shell status         读一条命令的状态与输出
  show                 读取会话：设置、条目与游标
  steer                立即追加：把一条消息送进正在运行的这一轮
  terminal input       向终端输入文字或改窗口大小
  terminal open        在会话的工作目录里打开一个终端
  terminal output      按序号增量读终端输出
  terminal show        会话最近一个终端任务
  update               改会话：标题、归档、相关任务、模型与推理强度

常用：daisy session create … → daisy session send <id> "消息" → daisy session show <id>；
归档：daisy session update <id> --archived；回答 AI 的工具授权和提问只在网页上（daisy open）。

每条子命令的参数：daisy session <子命令> --help
```

#### daisy session activity

```text
用法：daisy session activity <id>

在线进程最近在做什么

会话不在线时 `items` 为空。

参数：
  <id>                     （string，必填）

接口：GET /api/sessions/:id/live/activity（session.activity）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session background stop

```text
用法：daisy session background stop <id> <tid>

停止「后台」里的一项（Agent 的后台任务或 Daisy 的定时）

`scheduler:` 开头的是 Daisy 的定时或后台命令，立即取消（旧写法 `harbor:` 也认）；其余是 Agent 的后台任务，交给在线进程去停。只有会话主人可以停。

参数：
  <id>                     （string，必填）
  <tid>                    （string，必填）

接口：POST /api/sessions/:id/background/:tid/stop（session.backgroundStop）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session cancel

```text
用法：daisy session cancel <id>

停下会话当前这一轮

排队中的消息保留。已经产生的副作用不回滚。

参数：
  <id>                     （string，必填）

接口：POST /api/sessions/:id/cancel（session.cancel）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session create

```text
用法：daisy session create [选项]

新建会话

`requestId` 是幂等键：同一个键再发一次，回答原来那个会话（带 `duplicate: true`）。新建的会话一律私有；把会话设为公开是一条单独的、要 PIN 的 `daisy:grant` 接口（`daisy agent public set`）。

选项：
  --workspace-mode         （"shared" | "isolated" | "read-only" | "snapshot"，默认 "shared"）
  --title                  （string，≤ 200 字符，默认 ""）
  --agent                  （"claude" | "codex" | "kimi" | "opencode" | "antigravity" | "deepseek"，必填）
  --workspace-id           （string，必填）
  --profile-id             （string，必填）
  --task                   （object）

重发同一条命令不会重复执行（自动带幂等键）。

接口：POST /api/sessions（session.create）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  --idempotency-key <键>   指定幂等键（默认自动生成）；断线后用同一个键重发不会重复执行
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session delete

```text
用法：daisy session delete <id>

删除会话

停下它的一切工作并立即隐藏；没有正在运行的一轮时立即清除数据。`stopping: true` 表示还有一轮正在被结束，结束后再清除。

参数：
  <id>                     （string，必填）

接口：DELETE /api/sessions/:id（session.delete）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session events

```text
用法：daisy session events <id> [选项]

按序号增量读会话事件

每次最多 500 条；`hasMore` 为真时用最后一条的序号接着读。

参数：
  <id>                     （string，必填）

选项：
  --after                  从这个序号之后读，默认 0（integer，≥ 0，必填）

接口：GET /api/sessions/:id/events（session.events）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session identity fresh

```text
用法：daisy session identity fresh <id>

不带历史继续：放弃无法搬过来的原生历史

换身份时对话记录搬不过来、旧身份又不再使用时用。下一条消息起开一个新的原生会话（对话视图保留全部条目）。

参数：
  <id>                     （string，必填）

接口：POST /api/sessions/:id/identity/fresh（session.freshIdentity）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session identity switch

```text
用法：daisy session identity switch <id> [选项]

换身份：会话以自己的另一个身份档继续

只限会话所有者、Claude Code 会话，且没有排队或运行中的一轮。会话单独选的模型清除，改用新身份的模型。

参数：
  <id>                     （string，必填）

选项：
  --profile-id             （string，1–100 字符，必填）

接口：POST /api/sessions/:id/identity（session.switchIdentity）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session items

```text
用法：daisy session items <id> [选项]

往前翻页：某一条之前的条目

参数：
  <id>                     （string，必填）

选项：
  --before                 从这一条（id）往前取（string，1–400 字符，必填）
  --view                   常驻会话的对话视图；别的会话忽略（"conversation"）
  --limit                  条数，默认 200（对话视图默认 20，最多 100）（integer，1–1000，默认 200）

接口：GET /api/sessions/:id/items（session.items）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session list

```text
用法：daisy session list [选项]

列出自己的会话

按最近更新排序；已删除的和「只问」的旁路会话不列出。

选项：
  --task-id                只列出与这个任务相关的会话（string，1–200 字符）

接口：GET /api/sessions（session.list）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session offline

```text
用法：daisy session offline <id>

让会话下线：关掉它的在线进程

进程在执行端下一次报告时关闭；`stopping` 表示确有进程要关。

参数：
  <id>                     （string，必填）

接口：POST /api/sessions/:id/offline（session.offline）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session operation harness

```text
用法：daisy session operation harness <id> <name> [选项]

改会话所用 harness 的配置：配置文件、MCP 服务、插件、技能

和原生操作一样异步执行、用 `session.operationStatus` 查结果，但它改的是这个身份档下 harness 的配置（以后每个会话都受影响），属于“管理”（`daisy:manage`），不是会话操作。

参数：
  <id>                     （string，必填）
  <name>                   操作名（"config.write" | "mcp.add" | "mcp.remove" | "plugin.install" | "plugin.uninstall" | "skill.write"，必填）

选项：
  --args                   操作的参数（Record<string, any>，默认 {}）

重发同一条命令不会重复执行（自动带幂等键）。

接口：POST /api/sessions/:id/operations/harness（session.harnessConfig）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  --idempotency-key <键>   指定幂等键（默认自动生成）；断线后用同一个键重发不会重复执行
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session operation run

```text
用法：daisy session operation run <id> <name> [选项]

在会话上执行一个原生操作（列模型、分叉、回退、压缩等）

异步：回答操作的 id，用 `session.operationStatus` 查结果。`fork` 的结果在新会话里（回答的 `sessionId`）。会话有排队或运行中的工作时拒绝。`rewind` 的 `args.count` 是回退几轮（1–10000，默认 1）。`fork`、`compact`、`rewind`（带 `files: true` 还要「回退时同时撤销文件」）要会话的 AI 声明了这项能力（快照的 `features`），否则回 409 `capability_unsupported`，`fix` 说怎么办。

参数：
  <id>                     （string，必填）
  <name>                   操作名（改 harness 配置的那几个走 `session operation harness`，打开终端走 `session terminal open`）（"catalog" | "models" | "skills" | "mcp" | "plugins" | "config.read" | "fork" | "rewind" | "compact" | "review"，必填）

选项：
  --args                   操作的参数（Record<string, any>，默认 {}）

重发同一条命令不会重复执行（自动带幂等键）。

接口：POST /api/sessions/:id/operations（session.operation）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  --idempotency-key <键>   指定幂等键（默认自动生成）；断线后用同一个键重发不会重复执行
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session operation status

```text
用法：daisy session operation status <id> <jid>

查一个原生操作的状态与结果

参数：
  <id>                     （string，必填）
  <jid>                    （string，必填）

接口：GET /api/sessions/:id/operations/:jid（session.operationStatus）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session prompt apply

```text
用法：daisy session prompt apply <id>

立即压缩并让新提示词生效

参数：
  <id>                     （string，必填）

接口：POST /api/sessions/:id/prompt/apply（session.promptApply）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session prompt apply-cancel

```text
用法：daisy session prompt apply-cancel <id>

取消排队中的「立即生效」

参数：
  <id>                     （string，必填）

接口：DELETE /api/sessions/:id/prompt/apply（session.promptApplyCancel）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session prompt set

```text
用法：daisy session prompt set <id> [选项]

改会话自己的提示词补充

常驻 Agent 和「只问」支线不能在这里改。

参数：
  <id>                     （string，必填）

选项：
  --note                   这个会话的补充说明；null 清除（string | null）
  --sections               可选段落的开关；null 表示跟随个人设置（object）

接口：PUT /api/sessions/:id/prompt/extra（session.promptExtra）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session prompt show

```text
用法：daisy session prompt show <id>

看会话的分层提示词与生效状态

参数：
  <id>                     （string，必填）

接口：GET /api/sessions/:id/prompt（session.promptShow）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session queue jump

```text
用法：daisy session queue jump <id> <jid>

插队发送：一条排队消息立即开始

正在运行的一轮不会被打断，它排在最前、下一轮发出。

参数：
  <id>                     （string，必填）
  <jid>                    （string，必填）

接口：POST /api/sessions/:id/queue/:jid/jump（session.queueJump）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session queue list

```text
用法：daisy session queue list <id>

列出排队中的消息（已追加未读的在前，插队的其次）

参数：
  <id>                     （string，必填）

接口：GET /api/sessions/:id/queue（session.queue）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session queue merge-jump

```text
用法：daisy session queue merge-jump <id> [选项]

合并插队：选中的排队消息合成一条并插队

来源不同的消息不能合在一条里，各自成一条，依次排在后面。

参数：
  <id>                     （string，必填）

选项：
  --ids                    选中的排队消息 id（string[]，≤ 20 项）
  --all                    全部排队消息（boolean）

接口：POST /api/sessions/:id/queue/merge-jump（session.queueMergeJump）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session queue merge-steer

```text
用法：daisy session queue merge-steer <id> [选项]

合并追加：选中的排队消息合成一条送进正在运行的这一轮

没有正在运行的一轮、或有消息不能追加时回 409；会话的 AI 没有声明「运行中追加」时回 409 `capability_unsupported`。

参数：
  <id>                     （string，必填）

选项：
  --ids                    选中的排队消息 id（string[]，≤ 20 项）
  --all                    全部排队消息（boolean）

接口：POST /api/sessions/:id/queue/merge-steer（session.queueMergeSteer）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session queue remove

```text
用法：daisy session queue remove <id> <jid>

移除一条排队消息（已追加未读的则撤回）

参数：
  <id>                     （string，必填）
  <jid>                    （string，必填）

接口：DELETE /api/sessions/:id/queue/:jid（session.queueRemove）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session queue remove-many

```text
用法：daisy session queue remove-many <id> [选项]

批量移除排队消息（选中的，或全部）

每条与单独移除相同；`all` 跳过 AI 已读的。逐条回答结果。

参数：
  <id>                     （string，必填）

选项：
  --ids                    选中的排队消息 id（string[]，≤ 100 项）
  --all                    全部排队消息（boolean）

接口：POST /api/sessions/:id/queue/remove（session.queueRemoveMany）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session queue resume

```text
用法：daisy session queue resume <id>

继续执行暂停的队列：发出下一条排队消息

参数：
  <id>                     （string，必填）

接口：POST /api/sessions/:id/queue/resume（session.queueResume）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session recovery events

```text
用法：daisy session recovery events <id> <jid> [选项]

分页读一条恢复记录的事件

参数：
  <id>                     （string，必填）
  <jid>                    （string，必填）

选项：
  --after                  从这个序号之后读（integer，≥ 0，默认 0）

接口：GET /api/sessions/:id/recoveries/:jid/events（session.recoveryEvents）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session recovery list

```text
用法：daisy session recovery list <id>

列出被中断的轮次留下的恢复记录（最近 50 条）

参数：
  <id>                     （string，必填）

接口：GET /api/sessions/:id/recoveries（session.recoveries）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session schedule add

```text
用法：daisy session schedule add <id> [选项]

设一个定时器（一次性唤醒或周期 cron）

这里先只校验 `kind`；其余字段按 ScheduleCreate（`delaySeconds`、`cron`、`prompt`、`label`…）由定时器再校验一次。只有会话主人可以设。

参数：
  <id>                     （string，必填）

选项：
  --kind                   （"wakeup" | "cron"，必填）
  --delay-seconds          （integer，60–2592000）
  --prompt                 （string，1–4000 字符，必填）
  --reason                 （string，≤ 300 字符，默认 ""）
  --cron                   （string，9–100 字符）
  --label                  （string，≤ 300 字符，默认 ""）
  --recurring              （boolean，默认 true）
  --expires-in-days        （integer，1–30，默认 7）

接口：POST /api/sessions/:id/schedules（session.scheduleAdd）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session schedule cancel

```text
用法：daisy session schedule cancel <id> <scid>

取消一个定时器或后台命令

参数：
  <id>                     （string，必填）
  <scid>                   （string，必填）

接口：POST /api/sessions/:id/schedules/:scid/cancel（session.scheduleCancel）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session schedule list

```text
用法：daisy session schedule list <id>

列出会话的定时器与后台命令

带今天已用的轮数和服务端时区（cron 按它解释）。

参数：
  <id>                     （string，必填）

接口：GET /api/sessions/:id/schedules（session.scheduleList）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session schedule update

```text
用法：daisy session schedule update <id> <scid> [选项]

修改一个还在等待的定时器

可改 cron、提示词、标签、结束时间；一次性的可改触发时间。后台命令不能改。

参数：
  <id>                     （string，必填）
  <scid>                   （string，必填）

选项：
  --cron                   （string，9–100 字符）
  --prompt                 （string，1–4000 字符）
  --label                  （string，≤ 300 字符）
  --delay-seconds          （integer，60–2592000）
  --expires-in-days        （integer，1–30）

接口：PATCH /api/sessions/:id/schedules/:scid（session.scheduleUpdate）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session send

```text
用法：daisy session send <id> <text> [选项]

向会话发一条消息

`delivery: "queue"` 时进排队；正在运行一轮时也会排在它之后。`requestId` 是幂等键：同一个键再发一次，回答原来那条（带 `duplicate: true`）。常驻 agent 暂停时拒绝。

参数：
  <id>                     （string，必填）
  <text>                   （string，≤ 100000 字符，必填）

选项：
  --delivery               （"normal" | "queue"，默认 "normal"）
  --attachment-ids         （string[]，≤ 8 项，默认 []）
  --context                （object）
  --terminal-ids           （string[]，≤ 8 项，默认 []）

重发同一条命令不会重复执行（自动带幂等键）。

接口：POST /api/sessions/:id/messages（session.send）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  --idempotency-key <键>   指定幂等键（默认自动生成）；断线后用同一个键重发不会重复执行
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session shell run

```text
用法：daisy session shell run <id> <command>

在会话的工作目录里执行一条命令

只在自己的会话里；命令排队交给执行端，用 `session shell status` 取结果。

参数：
  <id>                     （string，必填）
  <command>                （string，≤ 4000 字符，必填）

接口：POST /api/sessions/:id/shell（session.shellRun）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session shell status

```text
用法：daisy session shell status <id>

读一条命令的状态与输出

参数：
  <id>                     （string，必填）

接口：GET /api/shell/:id（session.shellStatus）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session show

```text
用法：daisy session show <id> [选项]

读取会话：设置、条目与游标

不带参数时回答完整快照；`tail` 只取最新的若干条；`since`（加 `from`）只取客户端版本之后的变化，做不到时退回快照。

参数：
  <id>                     （string，必填）

选项：
  --tail                   只取最新的 N 条（0 = 全部）（integer，0–5000，默认 0）
  --since                  客户端持有的游标：只回答其后的变化（integer，≥ 0）
  --from                   客户端持有的最早一条的 id（与 since 一起用）（string，1–400 字符）
  --view                   常驻会话的对话视图；别的会话忽略（"conversation"）
  --message-limit          每页条数，默认 20，服务端收进 1–100（string | number）

接口：GET /api/sessions/:id（session.show）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session steer

```text
用法：daisy session steer <id> <text> [选项]

立即追加：把一条消息送进正在运行的这一轮

正在运行的一轮不是主人自己的（别人的请求、AI 自己的、唤醒）时，改为排在它之后（`queued: true` 加 `reason`）。会话的 AI 没有声明「运行中追加」（快照 `features.steer` 为 `none`，如 Kimi Code）时回 409 `capability_unsupported`。`requestId` 是幂等键。

参数：
  <id>                     （string，必填）
  <text>                   （string，1–100000 字符，必填）

选项：
  --context                宿主页面的上下文（object）

重发同一条命令不会重复执行（自动带幂等键）。

接口：POST /api/sessions/:id/steer（session.steer）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  --idempotency-key <键>   指定幂等键（默认自动生成）；断线后用同一个键重发不会重复执行
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session terminal input

```text
用法：daisy session terminal input <id> <jid> [选项]

向终端输入文字或改窗口大小

请求体的 `id` 是这次输入的去重键：同一个 id 只收一次（命令行自动生成）。

参数：
  <id>                     （string，必填）
  <jid>                    （string，必填）

选项：
  --text                   要输入的文字（string，≤ 16000 字符）
  --cols                   列数（integer，20–500）
  --rows                   行数（integer，5–150）

重发同一条命令不会重复执行（自动带幂等键）。

接口：POST /api/sessions/:id/terminal/:jid/input（session.terminalInput）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  --idempotency-key <键>   指定幂等键（默认自动生成）；断线后用同一个键重发不会重复执行
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session terminal open

```text
用法：daisy session terminal open <id> [选项]

在会话的工作目录里打开一个终端

和原生操作一样异步执行，用 `session.operationStatus` 查状态，用 `session terminal output` / `input` 读写。对外面上默认关闭（终端开关）。

参数：
  <id>                     （string，必填）

选项：
  --name                   固定为 terminal（"terminal"，必填）
  --args                   操作的参数（Record<string, any>，默认 {}）

重发同一条命令不会重复执行（自动带幂等键）。

接口：POST /api/sessions/:id/operations/terminal（session.terminalOpen）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  --idempotency-key <键>   指定幂等键（默认自动生成）；断线后用同一个键重发不会重复执行
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session terminal output

```text
用法：daisy session terminal output <id> <jid> [选项]

按序号增量读终端输出

每次最多 100 段；`truncated` 表示更早的输出已不保留。

参数：
  <id>                     （string，必填）
  <jid>                    （string，必填）

选项：
  --after                  从这个序号之后读，默认 0（integer，≥ 0，必填）

接口：GET /api/sessions/:id/terminal/:jid/output（session.terminalOutput）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session terminal show

```text
用法：daisy session terminal show <id>

会话最近一个终端任务

参数：
  <id>                     （string，必填）

接口：GET /api/sessions/:id/terminal（session.terminalList）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy session update

```text
用法：daisy session update <id> [选项]

改会话：标题、归档、相关任务、模型与推理强度

归档会停下它正在做的一切，并取消它的定时。给会话单独设模型或推理强度，要会话的 AI 声明了「切模型」/「切推理强度」，否则回 409 `capability_unsupported`。

参数：
  <id>                     （string，必填）

选项：
  --title                  （string，1–200 字符）
  --archived               （boolean）
  --related-tasks          要保留的相关任务 id；没列出的移除，不会新增（string[]，≤ 200 项）
  --settings               这个会话的模型、推理强度等；空串表示用身份档的（object）

接口：PATCH /api/sessions/:id（session.update）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy token

```text
用法：daisy token <子命令> …

子命令：
  issue   给第三方 A2A 客户端签一张有期限的令牌（daisy token）（要 PIN）
  list    列出签给第三方 A2A 客户端的令牌（只有记录，没有令牌本身）（要 PIN）
  revoke  吊销一张签给第三方 A2A 客户端的令牌（要 PIN）

每条子命令的参数：daisy token <子命令> --help
```

#### daisy token issue

```text
用法：daisy token issue [选项]

给第三方 A2A 客户端签一张有期限的令牌（daisy token）

“放别人进来”的一种（种类 visitor-token）：要 PIN，AI 不能做。签出的令牌：`iss`、`aud` 是这个 Daisy；`sub` 是那位联系人（`me` 时是自己）；`scope` 只有 `daisy:invoke`；`client_id` 是 `token:<jti>`；没有 `act`。拿着它的人以那位联系人的身份经 A2A 调用，仍要过调用授权（开放范围、白名单、卡片）；`me` 签出的也只能走 A2A 入口，不能访问本机接口。令牌只在这一次回答里出现，Daisy 只存签发记录（jti、给谁、备注、到期时间），不存令牌本身：谁拿到它谁就能以这个身份调用，像密码一样保管。联系人被移除、重置 PIN 时一并作废。

选项：
  --for                    给谁：联系人的编号（或 8 个以上字符的唯一开头）；me = 我自己（仍只是来访者，只能走 A2A 入口，不给主人身份）（string，1–200 字符，必填）
  --ttl                    有效期：7d、12h、30m 或秒数；默认 7 天，最多 90 天（string，≤ 20 字符）
  --note                   备注（给谁用、做什么，例如“给 CI 用”）（string，≤ 200 字符）

这一步要输入 PIN（终端里提示）。

接口：POST /api/tokens（grant.tokenIssue）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy token list

```text
用法：daisy token list [选项]

列出签给第三方 A2A 客户端的令牌（只有记录，没有令牌本身）

默认只列还有效的；`state=all` 连过期和吊销的也列（保留 30 天）。只读：网页、配对设备、外部签发方给主人的令牌不要 PIN，本机命令行要（命令行凭据可能是主人的 AI）；仍要 `daisy:grant`，AI 和来访者读不到。

选项：
  --state                  active：还有效的；all：连过期和吊销的（保留 30 天）也列（"active" | "all"，默认 "active"）

这一步要输入 PIN（终端里提示）。

接口：GET /api/tokens（grant.tokenList）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy token revoke

```text
用法：daisy token revoke <jti>

吊销一张签给第三方 A2A 客户端的令牌

立即生效：拿着它的请求从下一次起被拒（401）。已经开始的任务不受影响（要停，撤销授权或收回 agent）。要 PIN。已经吊销的再吊销一次回答原来的记录。

参数：
  <jti>                    令牌的编号（`daisy token list` 里的 jti）（string，1–64 字符，必填）

这一步要输入 PIN（终端里提示）。

接口：DELETE /api/tokens/:jti（grant.tokenRevoke）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy whoami

```text
用法：daisy whoami

我是谁：主人、经哪个通道、哪个入口面

单主人：主人就是运行 Daisy 的系统账户。回答这次请求被认作哪个通道（网页、配对设备、命令行）和入口面（本机面、对外面）。

接口：GET /api/me（system.me）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

### daisy workspace

```text
用法：daisy workspace <子命令> …

子命令：
  add            登记一个工作目录
  browse         在执行节点上浏览目录，或创建并登记一个目录
  browse-result  取目录请求的结果
  catalog        列出能用的执行节点、工作区和自己的身份档

每条子命令的参数：daisy workspace <子命令> --help
```

#### daisy workspace add

```text
用法：daisy workspace add [选项]

登记一个工作目录

路径必须是执行节点上、它允许的根目录内的绝对路径。

选项：
  --node-id                执行节点 id（string，必填）
  --label                  显示名（string，1–100 字符，必填）
  --path                   绝对路径（string，1–2000 字符，必填）

接口：POST /api/workspaces（workspace.add）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy workspace browse

```text
用法：daisy workspace browse <id> [选项]

在执行节点上浏览目录，或创建并登记一个目录

异步：回答一个请求 id，用 `workspace browse-result` 取结果（30 秒内）。`ensure` 会在目录不存在时创建它，并登记为工作区。

参数：
  <id>                     执行节点 id（string，必填）

选项：
  --operation              browse：列目录；ensure：确保目录存在并登记（"browse" | "ensure"，必填）
  --path                   目录；空 = 主目录（string，≤ 4096 字符，默认 ""）
  --offset                 列目录的起始位置（翻页）（integer，0–1000000，默认 0）
  --hidden                 是否列出隐藏项（boolean，默认 false）

接口：POST /api/nodes/:id/filesystem（workspace.browse）

通用选项：
  --json <对象>            先用这个 JSON 对象作请求体，再按选项覆盖（@文件、- 同上）
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy workspace browse-result

```text
用法：daisy workspace browse-result <id>

取目录请求的结果

参数：
  <id>                     目录请求 id（string，必填）

接口：GET /api/filesystem/:id（workspace.browseResult）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```

#### daisy workspace catalog

```text
用法：daisy workspace catalog

列出能用的执行节点、工作区和自己的身份档

接口：GET /api/catalog（workspace.catalog）

通用选项：
  -h, --help               显示这段帮助

回答以 JSON 打印到标准输出；出错时说明出了什么事、怎么解决，退出码非 0。
```
