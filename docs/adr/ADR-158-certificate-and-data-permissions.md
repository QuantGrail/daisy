# ADR-158：对外面的证书不悄悄换、指纹给主人看；数据目录里一律只有主人能读；状态即时反映更新来源（P6-15）

- 日期：2026-11-18
- 状态：**已实施（分支 `p6-15`，基于 `p6-gate`；待合入）**
- 来源：阶段 5 的真机验收发现的三件事
- 相关：ADR-101（两个入口面、对外面的自签名证书）、ADR-102（数据目录）、ADR-142（配对）、ADR-145（更新来源）

## 背景

1. **证书被悄悄换掉。** `tlsMaterial` 在检查已有证书时出的任何错——密钥文件权限过宽（`readSecretFile` 拒绝）、属主不对、读不了、证书解析失败——都落进一个空的 `catch {}`，然后直接生成新的证书和密钥，不留一个字。新证书让所有“首次连接时记下、之后钉住”的一方（配对的设备、记住了旧证书的 A2A 调用方）认不出这台 Daisy。
2. **主人没有可以对照的指纹。** 配对和远程打开的提示说“核对证书指纹再继续”，但 Daisy 自己从不说指纹是什么；验收时只能用 openssl 手算，再和一份旧记录比。
3. **数据目录里面的权限。** 数据目录本身一直是 0700，但 `daisy start` 从 shell 启动时进程继承 shell 的 022：数据库、索引、Runner 的身份缓存、插件、会话文件都是 0644 / 0755（launchd、systemd 的单元早就写了 077，后台进程没有）。
4. **`daisy update --source` 之后 `daisy status` 还说“没有来源”几十秒。** “自动更新”这一行读的是 Runner 上次同步时报的能力，不是更新器现在的状态。

## 决定

### 1. 证书只为写明的原因生成，每次都说

- 只有三个原因会生成新的自签名证书：**还没有**（第一次，或证书 / 密钥有一个不在了）、**不覆盖监听地址**、**一天内到期**。
- 每次生成都写日志（原因、地址、新的 SHA-256 指纹，绝不写密钥），并记一条审计 `access.tls.generate`（`{ reason, host, fingerprint }`，执行者 `system`）。
- 密钥或证书文件**属于这个账户但别的账户能读**：经打开的文件（`O_NOFOLLOW`）去掉组和其他人的位，日志说一声，证书**不换**。
- 文件在、但用不了——是符号链接、不是普通文件、属主是别的账户、空、读不了、证书解析不了、密钥和证书不是一对——**拒绝开启对外面**，说清楚是哪个文件、怎么办（删掉这一对再开启会生成新的，已配对的设备要重新核对指纹）。接口回 409 `tls_refused`；启动时这一行进日志，本机面照常。

### 2. 指纹给主人看

证书的 SHA-256（DER，冒号分隔的大写十六进制，和 `openssl x509 -fingerprint -sha256`、Chrome 的证书查看器一样）出现在：

- `GET /api/access` 的 `external.fingerprint`（`daisy access show`；只在对外面用 TLS 监听时有，否则 null）；
- `daisy status` 的“对外面”下一行；
- 配对码和对外一次性口令的回答（`fingerprint` 字段；`warning` 里也写出这个指纹和 `daisy access show`），`daisy pair`、`daisy open --external` 单独打印一行；
- 网页“设置 › 入口面与口令”在对外面的地址下面；“设置 › 设备”的配对提示（`warning`）。

文档（配对、安全模型、第一次使用）改成：浏览器里的 SHA-256 和 `daisy access show` 打印的一致再继续。

### 3. 数据目录：掩码 077，启动时收紧，doctor 报告

- **掩码。** `main.ts` 的第一件事是 `process.umask(0o077)`（`platform/umask.ts`），不管怎么启动的（`daisy start`、launchd、systemd、前台）。Runner 在同一个进程里，一样。
- **AI 起的程序沿用启动时的掩码**（调度方的决定）。harness、命令、终端、后台任务在主人自己的目录里写文件，它们应该得到和以前一样的权限：`spawnTree`（POSIX）在启动时掩码不是 077 时，用 `/bin/sh -c 'umask <启动时的> && exec "$0" "$@"'` 起程序（`exec` 让 pid、进程组、信号都是程序自己的；找不到的程序照原样起，调用方仍拿到 ENOENT）。启动时的掩码放在 `DAISY_START_UMASK` 里，接班进程沿用。launchd / systemd 本来就是 077（plist 在 `platform/launchd.ts`，`Umask` 63；systemd 单元在 `platform/autostart.ts`，`UMask=0077`），什么都不变。登录（`codex login` 等）不经 `spawnTree`，在 077 下写身份目录。
- **身份目录**本身 0700（`resolveIdentity` 已经这样建）。harness 在里面写的文件跟启动时的掩码走，但在 0700 的目录里面；每次启动会一并收紧。
- **启动时收紧一次**（`platform/data-perms.ts`，`openDatabase` 调用，POSIX）：整个数据目录递归，`lstat`、从不跟随符号链接、只改属于这个账户的、已经收紧的不动、有别的硬链接的文件不动（它的权限和数据目录外的名字共用），经打开的条目改（同一个 inode 才改），只去掉组和其他人的位、保留主人的（插件的程序仍可执行）；最多看 20 万个条目。`keys/` 里面不动：宽权限的凭据照旧拒绝启动（它可能已经被别的账户读过，要主人知道），对外面的证书和密钥在读取处收紧（上面第 1 条）。改了多少写一行日志。Windows 仍靠数据目录继承的 DACL。
- **`daisy doctor`** 新增“数据目录里的权限”：还有多少个条目组或其他人有权限（举几个例子）、多少个因为硬链接没改；AI 命令行自己的身份目录只看目录本身。修法：重启 Daisy，或 `chmod -R go-rwx <数据目录>`。

### 4. 状态即时反映更新来源

节点的 `capabilities.runner.autoUpdate`（`GET /api/catalog`，`daisy status` 和设置页读它）在服务端换成这个进程的更新器**现在**的状态（`nodeAutoUpdate(packageUpdate.status())`）；一个 Daisy 只有一个在同一进程里的 Runner。`daisy status` 也先用 `GET /api/update` 回答里的 `package`。

## 没有做的

- **没有让 AI 起的程序也用 077。** 那样更简单，也和 launchd / systemd 一致，但主人用 `daisy start` 时 AI 在工作区里新建的文件会变成只有主人能读，和他在终端里自己建的不一样。调度方选了沿用启动时的掩码。
- **Daisy 自己在工作区里做的写入**（隔离工作区的 `git worktree` 检出、回退恢复的文件、上传）用 077，和 launchd / systemd 下一直以来一样；`daisy update` 起的 `npm install -g` 也是。
- 不给中转地址的证书加指纹显示（它有自己的 TLS 绑定声明，ADR-144）。

## 影响

- 契约：`AccessStatus.external.fingerprint`、`PairingCode.fingerprint`、对外一次性口令回答的 `fingerprint`；`PUT /api/access/external` 新错误码 `tls_refused`。`docs/api`、`commands.md` 已重新生成。
- 新审计动作 `access.tls.generate`。
- 测试：`tests/tls-certificate.test.ts`（三个原因、宽权限只收紧不换、几种用不了的情况都拒绝、指纹和 openssl 的算法一致、接口 / 配对 / 审计）、`tests/data-perms.test.ts`（收紧规则、doctor 前后、真实启动在 022 的 shell 下、AI 程序的掩码和接班进程）、`tests/package-update.test.ts`（设置来源后目录立即反映）。

## § 安全审查修订（2026-11-18，分支 `p6-15`）

独立安全审查没有高危；按它的中、低危项改：

- **数据目录本身是链接**（M1）：先 `realpath` 根目录再走，下面仍只 `lstat`；`daisy doctor` 因此不会对一个链接报“都只有你能读写”。
- **`DAISY_START_UMASK`**（M2）：只有接班进程（带 `DAISY_RESPAWN_AFTER`）才采用；不管采不采用都立即从环境里删掉，只由 `startSuccessor` 交给接班进程，AI 起的程序看不到。让组或其他账户能写的掩码（000、002、020 …）不交给 AI 的程序：补上 022，并在启动时打印一行说明。
- **走的途中目录被换成链接**（L1）：读一个目录的名字前核对它的 `realpath` 还是它自己；改权限前核对父目录同样没变；不进别的账户的目录。
- **找程序**（L2）：只认 PATH 里的绝对路径，相对的路径或 PATH 项不包装、照原样起。`exec "$0"` 的 `$0` 总是以 `/` 开头的绝对路径，不会被当成选项；没有用 `exec --`，因为不是每个 `/bin/sh` 都接受它。
- **启动时的工作量**（L3）：AI 命令行自己的身份目录在启动时也只看目录本身（和 doctor 一样）：目录 0700，里面不走——那里可能是很大的缓存。
- **悬空链接**（L4）：判断证书 / 密钥在不在用 `lstat`，链接（哪怕指向不存在的地方）一律拒绝，不会被当成“还没有”而写穿。
- **回答里的信息**（L5）：`tls_refused` 的回答只带一句简短原因（不带绝对路径和 uid，详情只进日志）；端口被占用才是 `port_in_use`，地址不在这台机器上是 `external_invalid`，其他失败是新的 `external_failed`（详情进日志）。
- **launchd 的掩码**（L6）：plist 由 `platform/launchd.ts` 生成，写的是 `Umask` 63（= 077）；`platform/autostart.ts` 只生成 systemd 单元（`UMask=0077`）。上面的说法已写明出处。
