# 从程序里调用 Daisy 的智能体（A2A）

[English](README.md)

Daisy 上公开的 agent 和常驻 agent 说标准的 A2A 1.0。调用方要有自己的身份（一把 Ed25519 密钥），并且被对方的 Daisy 认得：

1. 你把自己的**身份名片**交给对方的主人，对方导入（`daisy contact import --card-file 你的名片.daisycard --whitelist`，要 PIN）。白名单表示预先批准；不加白名单时，第一次调用会在对方那里弹一张待批准的卡片。
2. 对方把它的名片（`daisy contact export`）给你。名片里有它的公钥、编号和地址。
3. 对方的 agent 要对你开放（公开 agent 默认对所有互认的人开放）。

## `call-agent.ts`：用 `@daisy-ai/a2a-client`

Daisy 自己和 `daisy-mcp` 用的就是这套代码：出站连接的安全规则（不连本机回环和云元数据地址、不跟随重定向、大小和时间上限）、中转地址的 TLS 绑定核对、每个请求一张新令牌，都已经在里面。

```sh
# 在这个仓库的检出里（npm ci 之后）
node --import tsx examples/a2a-client/call-agent.ts card --key me.key.json --name "我的脚本" > me.daisycard
# …把 me.daisycard 交给对方导入，拿回对方的 bob.daisycard…
node --import tsx examples/a2a-client/call-agent.ts call --key me.key.json --card bob.daisycard "你好，帮我看看这段报错"
```

对方对你开放了不止一个 agent 时，它会列出来，用 `--agent <agentId>` 选。对方要你补充信息时，按提示带上 `--task` 和 `--context` 再发一次。私钥文件 `me.key.json` 只有你能读（0600），不要提交到任何地方。

## `official-sdk.ts`：用官方 SDK

`@a2a-js/sdk` 直接读 agent 名片（`<Daisy 地址>/a2a/<agentId>/.well-known/agent-card.json`）并发消息，只需要给它一个在每个请求上加 `Authorization: Bearer <令牌>` 的 fetch。令牌的字段：

| 字段 | 值 |
| --- | --- |
| 头 | `alg` EdDSA，`typ` `at+jwt`，`kid` 你的身份编号（52 个 base32 字符） |
| `iss`、`sub` | 你自己的身份 URN（`urn:ietf:params:oauth:jwk-thumbprint:sha-256:<指纹>`） |
| `aud` | 对方 Daisy 的身份 URN（只能一个） |
| `client_id` / `scope` | `a2a` / `daisy:invoke` |
| `exp` | 不超过 5 分钟；`jti` 每次都要新的（对方每个只收一次） |

官方 SDK 用的是普通的 fetch：只认证书机构签的证书，没有上面那些出站规则，经中转时也不核对 TLS 绑定声明。能用 `call-agent.ts` 时优先用它。

两个例子都由 `tests/examples.test.ts` 对一个进程内的真实 Daisy 跑通（临时端口，假的 harness，不联网）。
