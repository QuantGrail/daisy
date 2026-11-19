# 自己架一个 Daisy Relay（systemd）

[English](README.md)

中转给在路由器后面的 Daisy 一个固定的对外地址，按 TLS 握手里的域名（SNI）把连接原样递给它，**不解密**。协议和设计见 `packages/relay/README.md`、`packages/relay/PROTOCOL.md`。指南里的说明：[中转](../../docs/guide/zh-CN/relay.md)。

这里的文件：

- [`relay.json`](relay.json)：配置。`relay.example.com` 换成你的域名，`limits` 只写想改的项（全部上限和默认值见 `packages/relay/src/config.ts`）。
- [`daisy-relay.service`](daisy-relay.service)：systemd 系统服务。用专用账户运行，只给绑定 443 端口的权限，`SIGHUP` 重读证书。

## 1. 域名和证书

DNS 里两条记录指向这台机器（例子里的 `203.0.113.10` 是文档用地址）：

```
relay.example.com.     A  203.0.113.10
*.relay.example.com.   A  203.0.113.10
```

证书**只覆盖 `relay.example.com` 本身**。不要用 `*.relay.example.com` 的通配证书：持有它的中转就能解密 Daisy 的流量，`daisy-relay --check` 会拒绝。每个 Daisy 自己为 `<子域名>.relay.example.com` 申请证书（ACME TLS-ALPN-01，经中转原样递过去）。

```sh
sudo certbot certonly --standalone -d relay.example.com    # 用 80 端口完成验证
```

## 2. 安装

`@daisy-ai/relay` 还没有发布到 npm：先在一份代码检出里打包（`npm ci && npm pack -w @daisy-ai/relay`，得到 `daisy-ai-relay-<版本>.tgz`），拷到这台机器上安装（发布之后换成 `sudo npm install -g @daisy-ai/relay`）：

```sh
sudo npm install -g ./daisy-ai-relay-<版本>.tgz   # 需要 Node.js 24 或更新
command -v daisy-relay                        # 和 daisy-relay.service 里 ExecStart 的路径对上
sudo useradd --system --no-create-home --shell /usr/sbin/nologin daisy-relay
sudo install -d -m 0750 -g daisy-relay /etc/daisy-relay
sudo install -m 0640 -g daisy-relay relay.json /etc/daisy-relay/relay.json
```

把证书放到配置里写的位置，私钥只给 `daisy-relay` 组读。用 certbot 的部署钩子，续期后自动更新并让中转重读（`/etc/letsencrypt/renewal-hooks/deploy/daisy-relay.sh`，可执行）：

```sh
#!/bin/sh
set -e
d=relay.example.com
case " $RENEWED_DOMAINS " in *" $d "*) ;; *) exit 0 ;; esac
install -m 0644 "$RENEWED_LINEAGE/fullchain.pem" /etc/daisy-relay/$d.fullchain.pem
install -m 0640 -g daisy-relay "$RENEWED_LINEAGE/privkey.pem" /etc/daisy-relay/$d.key.pem
systemctl reload daisy-relay 2>/dev/null || true
```

第一次手动跑一次：`sudo RENEWED_DOMAINS=relay.example.com RENEWED_LINEAGE=/etc/letsencrypt/live/relay.example.com sh /etc/letsencrypt/renewal-hooks/deploy/daisy-relay.sh`。

## 3. 启动

```sh
sudo -u daisy-relay daisy-relay --config /etc/daisy-relay/relay.json --check   # 配置正确：relay.example.com，监听 0.0.0.0:443
sudo cp daisy-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now daisy-relay
journalctl -u daisy-relay -f      # 每行一个 JSON：只有事件、子域名、地址、字节数、原因，没有内容和令牌
```

## 4. 让 Daisy 用它

在每个 Daisy 上（要输入 PIN）：

```sh
daisy relay set relay.example.com
daisy relay show          # 连上了、对外地址 https://<子域名>.relay.example.com、证书
```

之后导出的身份名片里带着这个地址，别的网络里的 Daisy 导入名片后就能经中转调用。

这个例子由 `tests/examples.test.ts` 用中转自己的配置加载代码和 `--check` 检查。
