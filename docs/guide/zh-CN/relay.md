# 中转：自己架一个，把 Daisy 连上去

[English](../en/relay.md)

在路由器或防火墙后面的 Daisy，别人连不进来。中转（`daisy-relay`）给它一个固定的对外地址：Daisy 主动连出到中转并保持连接，别人按 `https://<子域名>.<中转域名>` 找它，中转把连接原样递进去。

中转做的事很少：

- 只看 TLS 握手里的域名（SNI）决定递给谁，**不终止 TLS**：内容在调用方和 Daisy 之间端到端加密。
- 不保存任何请求。目标不在线时，在握手阶段直接拒绝。
- 不判断谁能调用谁（那是每个 Daisy 自己的事），不做穿透。

想直连的人可以自己组网（例如 VPN 或覆盖网络），然后开启对外面，不需要中转。

## 一、自己架一个中转

### 要准备的

- 一台能占用公网 **443** 端口的机器，装 Node.js 24 或更新。
- 一个域名，例如 `relay.example`。DNS 里 `relay.example` 和通配的 `*.relay.example` 都指向这台机器。
- 一张**只覆盖 `relay.example` 本身**的证书和私钥（PEM），例如用 certbot 申请。**不要用 `*.relay.example` 的通配证书**：中转持有它就能解密 Daisy 的流量，`daisy-relay --check` 会拒绝。

### 拿到程序

`@daisy-ai/relay` 是一个单独的包，还没有发布到 npm。在一份代码检出里打包：

```sh
npm ci
npm pack -w @daisy-ai/relay          # 打出 daisy-ai-relay-<版本>.tgz
```

把包拷到中转机器上安装：

```sh
npm install -g ./daisy-ai-relay-<版本>.tgz
daisy-relay --version
```

包里的代码只有一个打包好的文件，依赖只有 `ws`、`jose` 两个，不依赖 Daisy 本身。

### 配置

配置是一个 JSON 文件，例如 `/etc/daisy-relay/relay.json`：

```json
{
  "domain": "relay.example",
  "listen": { "host": "0.0.0.0", "port": 443 },
  "tls": {
    "cert": "/etc/daisy-relay/relay.example.fullchain.pem",
    "key": "/etc/daisy-relay/relay.example.key.pem"
  },
  "logLevel": "info",
  "limits": {
    "maxDaisys": 1000,
    "maxStreamsPerDaisy": 64,
    "bytesPerSecPerDaisy": 16777216
  }
}
```

| 项 | 说明 | 默认 |
| --- | --- | --- |
| `domain` | 中转自己的域名，小写，至少两段 | 必填 |
| `listen.host`、`listen.port` | 监听地址和端口 | `0.0.0.0`、`443` |
| `tls.cert`、`tls.key` | 中转自己域名的证书和私钥文件 | 必填 |
| `logLevel` | `debug`、`info`、`warn`、`error` | `info` |
| `limits` | 各种上限，只写要改的；名字和默认值见 `packages/relay/src/config.ts` 的 `DEFAULT_LIMITS` 和协议说明第 8 节 | 见下 |
| `allowIdentities` | 只让这些 Daisy 登记：一组身份编号（52 个字符，空格和大小写不论）。不写就是谁都可以 | 不限 |

环境变量覆盖文件里的值：`DAISY_RELAY_CONFIG`（配置文件路径）、`DAISY_RELAY_DOMAIN`、`DAISY_RELAY_HOST`、`DAISY_RELAY_PORT`、`DAISY_RELAY_TLS_CERT`、`DAISY_RELAY_TLS_KEY`、`DAISY_RELAY_LOG_LEVEL`。上限只能写在文件里。

几条默认上限（免得一个 Daisy 拖垮整个中转）：

| 上限 | 默认 |
| --- | --- |
| 同时在线的 Daisy | 1000；同一个来源地址 128 |
| 每个 Daisy 同时的连接（流） | 64，其中等待认领的 16 |
| 每个 Daisy 的带宽（两个方向合计） | 16 MiB/秒 |
| 每条流 | 最多 256 MiB，空闲 5 分钟关闭，最长 1 小时 |
| 公网端口 | 总连接 10000；每个来源 512，新建 20/秒 |

“来源”是一个 IPv4 地址或一个 IPv6 /64。

### 运行

```sh
daisy-relay --config /etc/daisy-relay/relay.json --check   # 检查配置和证书
daisy-relay --config /etc/daisy-relay/relay.json           # 运行
```

- 在 Linux 上绑定 443 要权限。不要用 root 跑它：用 systemd 的 `AmbientCapabilities=CAP_NET_BIND_SERVICE`，或者在前面做端口转发。
- `SIGHUP` 重读证书文件（证书续期后发一个）。`SIGTERM`、`SIGINT` 停止；在线的 Daisy 收到“中转重启”后会自动重连。
- 日志每行一个 JSON，写到标准输出。只记事件、子域名、地址、流水号、字节数、时长和原因；不记任何内容、令牌、认领凭据，也不记中转不服务的域名。

一个 systemd 单元的例子（按你的路径改）：

```ini
# /etc/systemd/system/daisy-relay.service
[Unit]
Description=Daisy Relay
After=network-online.target
Wants=network-online.target

[Service]
User=daisy-relay
ExecStart=/usr/bin/env daisy-relay --config /etc/daisy-relay/relay.json
ExecReload=/bin/kill -HUP $MAINPID
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

证书文件要让 `daisy-relay` 这个用户读得到。

### 检查它在工作

```sh
curl https://relay.example/v1/info                    # 协议版本
curl https://relay.example/v1/presence/<子域名>       # 某个 Daisy 在不在线
```

## 二、把 Daisy 连到中转

在 Daisy 那台机器上：

```sh
daisy relay set relay.example        # 要 PIN；端口不是 443 时写 https://relay.example:8443
daisy relay show                     # 选了哪个、连上没有、对外地址、证书
daisy status                         # 多一行“中转”
```

- Daisy 主动连出并保持；断了自动重连，间隔逐步拉长，最长 30 秒。中转拒绝这个 Daisy 时（例如运营者用 `allowIdentities` 只放某些 Daisy 登记），不再重试，`daisy relay show` 显示 `refused`。
- 对外地址是固定的：`https://<身份编号的前 32 个字符>.relay.example`。它由这个 Daisy 的身份密钥算出来：重连、重启、停用后再选同一个中转，地址都不变。
- 选了中转，导出的身份名片（`daisy contact export`）里就带上这个地址，停用后去掉；经中转取到的 agent 名片写的也是这个地址。
- 不需要先开启对外面。选了中转，对外面就“经中转开着”，网页口令自动启用。

停用：

```sh
daisy relay off                      # 也要 PIN
```

正在经中转的连接立即断开，名片里不再有中转地址。密钥和证书留着，再选同一个中转时地址不变。

### 证书（ACME）

中转不终止 TLS，所以 Daisy 要为自己的中转地址准备证书：

- 选了中转后，Daisy 立即生成一张**自签名**证书，马上就能在 Daisy 之间用（Daisy 之间另有一层核对，见下）。
- 同时在后台向证书机构申请证书（ACME 的 TLS-ALPN-01 质询，经中转透传）。默认是 Let's Encrypt。申请到就换上，到期前自动续期。
- 申请不到时保留现有证书，1 小时后再试，每次间隔翻倍，最长 24 小时。`daisy relay show` 和 `daisy status` 会写原因。
- 用自签名证书期间，**经中转只有 Daisy 之间能用**：第三方 A2A 客户端和浏览器会报证书不受信任，配对和 `daisy open --external` 也不给经中转的链接（见 [配对](pairing.md)）。
- 打开 ACME 即同意那家证书机构的订户协议。
- 不想申请：`daisy relay set relay.example --acme false`，只用自签名证书。
- 换一家支持 TLS-ALPN-01 的证书机构：`--acme-directory https://<它的 ACME 目录地址>`。
- `.test`、`.example`、`.invalid`、`.localhost`、`.local`、`.internal`、`home.arpa` 这些保留域名，不管配哪个证书机构都不会去申请。

### 经中转能进来什么

经中转进来的请求只进对外面，永远到不了本机面：

- 只认对外面的凭据：对外面的网页会话、配对设备、别人的 Daisy 签的令牌、你签发的 A2A 令牌。本机命令行凭据、AI 的工作凭据、本机网页会话经中转都不被认出。
- 经中转**一律不提供终端、执行命令、浏览目录**，不管对外面自己的开关怎么设。
- 调用你的 agent 照样要过调用授权（开放范围、白名单、待批准的卡片）。

重置 PIN 时中转随对外面一起关闭。

## 三、用别人运营的中转

中转读不到内容，但运营者控制着那个域名的 DNS 和 443 端口，**能给你的子域名另申请一张受信任的证书，在中间解密**。

- **Daisy 之间的调用不怕这个。** 发令牌之前，调用方的 Daisy 先取你的 Daisy 用身份私钥签的“TLS 绑定声明”，核对这条连接的证书在声明里，才发请求。中转造不出这份声明。对不上就断开、什么都不发，并记审计。独立的 `daisy-mcp` 也做同样的核对。
- **第三方 A2A 客户端和浏览器只信证书机构。** 它们经别人的中转调用你、或你经别人的中转打开网页、配对手机时，要信任运营者不这么做。`daisy open --external` 和 `daisy pair` 在只有中转时会直接写出这条警告。
- 想避免：自己架中转，或者对外面直连（自己组网）。

运营者能看到的：目标子域名、调用方地址、每条连接的字节数和时长、谁在线。看不到：请求、回答、令牌、路径、HTTP 头。

协议细节在 `packages/relay/PROTOCOL.md`。
