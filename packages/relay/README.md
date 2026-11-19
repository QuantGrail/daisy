# Daisy Relay（`@daisy-ai/relay`）

给在路由器、防火墙后面的 Daisy 一个固定的对外地址。Daisy 主动连到中转并保持连接；别人按 `https://<子域名>.<中转域名>` 调用它，中转只看 TLS 握手里的域名（SNI）决定递给谁，**不终止 TLS**：内容在调用方和 Daisy 之间端到端加密，中转只看到 SNI 和密文。

它不做的事：不保存请求（目标不在线时在握手阶段直接拒绝）、不判断谁能调用谁（那是每个 Daisy 自己的事）、不做穿透。

协议（版本 1）：[PROTOCOL.md](PROTOCOL.md)。设计：仓库里的 `docs/adr/ADR-100-relay-and-e2e.md`、`docs/adr/ADR-143-relay.md`。

## 部署要求

- 一台能占用公网 **443** 端口的机器。
- 一个域名，例如 `relay.example`；DNS 里 `relay.example` 和通配的 `*.relay.example` 都指向这台机器。
- 一张**只覆盖 `relay.example` 本身**的证书和私钥（PEM），比如用 certbot 申请。不要用 `*.relay.example` 的通配证书：持有它的中转就能解密 Daisy 的流量，`daisy-relay --check` 会拒绝。
- Node.js 24 或更新版本。

## 用法

```sh
daisy-relay --config /etc/daisy-relay/relay.json --check   # 检查配置和证书
daisy-relay --config /etc/daisy-relay/relay.json           # 运行
```

配置是 JSON，示例见 `relay.example.json`；环境变量 `DAISY_RELAY_DOMAIN`、`DAISY_RELAY_HOST`、`DAISY_RELAY_PORT`、`DAISY_RELAY_TLS_CERT`、`DAISY_RELAY_TLS_KEY`、`DAISY_RELAY_LOG_LEVEL` 覆盖文件里的值。所有上限在 `limits` 里，名字和默认值见 PROTOCOL.md 第 8 节和 `src/config.ts`。

- 日志：每行一个 JSON 对象，写到标准输出。只记事件、子域名、地址、流水号、字节数、时长和原因，不记任何内容、令牌、认领凭据和中转不服务的域名。
- `SIGHUP`：重读证书文件（续期后用）。`SIGTERM` / `SIGINT`：停止；在线的 Daisy 收到“中转重启”（1012）后会自动重连。
- 绑定 443 在 Linux 上需要权限：用 systemd 的 `AmbientCapabilities=CAP_NET_BIND_SERVICE`，或在前面做端口转发。

## 使用别人运营的中转时

中转读不到内容，但运营者控制着域名，理论上能给你的子域名另签一张证书在中间解密。Daisy 之间的调用不怕这个（调用方先校验你用身份私钥签的 TLS 绑定声明）；第三方客户端经中转调用时，要信任运营者不这么做。

## 许可证

Apache-2.0，见 LICENSE。
