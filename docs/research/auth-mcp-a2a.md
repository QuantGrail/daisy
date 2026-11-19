# MCP 授权规范要点；A2A 名片里声明 OAuth2 / Bearer 的写法

核实日期：2026-11-16（P0-03 第 6 项）

## 结论：MCP 授权规范

- **当前版本是 2026-07-28**（2026-07-28 发布，上一版 2025-11-25）。这一版整体改动很大：去掉了 `initialize` 握手和 `Mcp-Session-Id` 会话，协议变成无状态，每个请求在 `_meta` 里带协议版本和客户端能力；新增 `server/discover`。这些不是授权部分，但凡是 Daisy 自己写的 MCP 服务端都会受影响。
- **适用范围**：基于 HTTP 的传输 SHOULD 遵守授权规范；**stdio 传输 SHOULD NOT 遵守**，改从环境里取凭据。
- **角色**：MCP 服务端是 OAuth 2.1 的资源服务器；授权服务器可以是独立的一方。
- **要点**（MUST 级为主）：
  - 授权服务器 MUST 实现 OAuth 2.1（公共客户端用 PKCE）。
  - MCP 服务端 MUST 实现 OAuth 2.0 受保护资源元数据（RFC 9728）：401 时在 `WWW-Authenticate` 里给 `resource_metadata`，或者在 `/.well-known/oauth-protected-resource[/路径]` 提供；客户端两种都 MUST 支持。
  - 授权服务器 MUST 提供 RFC 8414 元数据或 OpenID Connect Discovery 之一，客户端两种都 MUST 支持。
  - 客户端注册：优先 **Client ID 元数据文档**（SHOULD），其次预注册；**动态客户端注册（RFC 7591）在本版被标为弃用**，只为兼容保留。
  - 客户端 MUST 在授权和换令牌请求里带 `resource` 参数（RFC 8707），值是 MCP 服务端的规范 URI。
  - 令牌 MUST 放在 `Authorization: Bearer` 头里，每个请求都带，MUST NOT 放在 URL 查询串里。
  - 服务端 MUST 校验令牌是发给自己的（audience），MUST NOT 接受或转发别人的令牌（禁止令牌透传）；无效或过期返回 401，scope 不够返回 403 并在 `WWW-Authenticate` 里写 `error="insufficient_scope"` 和需要的 `scope`（客户端据此做逐步提权）。
  - 本版新增：授权服务器 SHOULD 在授权响应里带 `iss`（RFC 9207），客户端遇到就 MUST 校验；客户端凭据要按签发方分开保存，换了授权服务器 MUST 重新注册；动态注册时 MUST 指定 `application_type`。
  - 刷新令牌 MUST 保密，客户端 MUST NOT 假设一定会拿到刷新令牌。

## 结论：A2A 名片里的认证声明

按 1.0.1 的 proto（数据定义以它为准）：

- `AgentCard.security_schemes`：`map<string, SecurityScheme>`，JSON 写作 **`securitySchemes`**。
- `AgentCard.security_requirements`：`repeated SecurityRequirement`，JSON 写作 **`securityRequirements`**。每一项是 `{"schemes": {"<方案名>": {"list": ["scope1", ...]}}}`（`StringList` 在 ProtoJSON 里是带 `list` 字段的对象）。
- `SecurityScheme` 是 oneof，JSON 里用包装键：`apiKeySecurityScheme`、`httpAuthSecurityScheme`、`oauth2SecurityScheme`、`openIdConnectSecurityScheme`、`mtlsSecurityScheme`。
- `HTTPAuthSecurityScheme`：`scheme`（必填，如 `"Bearer"`）、`bearerFormat`（如 `"JWT"`）、`description`。
- `OAuth2SecurityScheme`：`flows`（必填）、`oauth2MetadataUrl`（RFC 8414 元数据地址）、`description`。`flows` 是 oneof：`authorizationCode`（`authorizationUrl`、`tokenUrl`、`refreshUrl`、`scopes`、`pkceRequired`）、`clientCredentials`（`tokenUrl`、`refreshUrl`、`scopes`）、`deviceCode`；`implicit`、`password` 已弃用。
- 名片还可以带 `signatures`（JWS），以及 `capabilities.extendedAgentCard`（认证后取扩展名片）。
- **规范里写法不一致的地方**：1.0.x 正文的样例名片用的是旧写法 `"security": [{"google": ["openid", ...]}]`；proto 和 1.1.0-rc 的样例都是 `securityRequirements` + `schemes` + `list`。**以 proto 为准**。当时（前身 Agent Harbor）代码里的 `a2a.ts` 写的是 `securityRequirements: [{ schemes: { harbor: { list: [] } } }]`，与 proto 一致。

Bearer 示例（第三方客户端用 `daisy token` 生成的令牌）：

```json
{
  "securitySchemes": {
    "daisy": {
      "httpAuthSecurityScheme": { "scheme": "Bearer", "bearerFormat": "JWT", "description": "..." }
    }
  },
  "securityRequirements": [{ "schemes": { "daisy": { "list": [] } } }]
}
```

外部签发方用 OAuth2 时（示例，地址是占位）：

```json
{
  "securitySchemes": {
    "issuer": {
      "oauth2SecurityScheme": {
        "oauth2MetadataUrl": "https://issuer.example/.well-known/oauth-authorization-server",
        "flows": {
          "clientCredentials": {
            "tokenUrl": "https://issuer.example/token",
            "scopes": { "daisy:a2a": "调用这个 agent" }
          }
        }
      }
    }
  },
  "securityRequirements": [{ "schemes": { "issuer": { "list": ["daisy:a2a"] } } }]
}
```

`securityRequirements` 多项之间、同一项内多个方案之间是“或”还是“且”，A2A 规范和 proto 都没有明文写；这套结构照搬 OpenAPI，OpenAPI 的语义是“多项之间为或、同一项内为且”。Daisy 只声明一种方案时不涉及这个问题。

## 出处

- MCP 授权（2026-07-28）：https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization ；源文件 https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/docs/specification/2026-07-28/basic/authorization
- MCP 变更记录：https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP 发布：https://github.com/modelcontextprotocol/modelcontextprotocol/releases
- A2A proto：https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto （`AgentCard`、`SecurityScheme`、`SecurityRequirement`、`OAuthFlows`）
- A2A 规范 4.5 节、7 节、8.5 节样例：https://a2a-protocol.org/latest/specification/ ；1.1.0-rc 修正后的样例：https://github.com/a2aproject/A2A/blob/v1.1.0-rc/docs/specification.md

## 对当时设计的影响

1. 设计里“第三方客户端用 `daisy token` 生成令牌，按标准 Bearer 带上”与 A2A 规范相符：名片声明一个 `httpAuthSecurityScheme`（`Bearer`）即可，不需要自定义扩展，满足“名片上的认证方式是标准的”这一要求。
2. 设计里“令牌用 OAuth2 的签名令牌格式”可行。若要让第三方客户端自己去外部签发方取令牌，名片要声明 `oauth2SecurityScheme`，并给出 `oauth2MetadataUrl`。签名令牌的 audience 要写被调用的那个 Daisy，与 MCP 规范“只接受发给自己的令牌、不透传”的原则一致，也和设计里“令牌写明发给哪个 Daisy”一致。
3. **MCP 授权规范对 Daisy 的约束有限**：给 harness 的 MCP 工具（现有进程内 MCP）和独立的 A2A MCP 若走 stdio，规范明确说不适用，凭据从环境变量或启动参数来。只有 Daisy 以 HTTP 方式对外提供 MCP 时才要实现受保护资源元数据、401/403 挑战这一套。
4. **要注意 MCP 2026-07-28 的不兼容变化**：去掉了 `initialize` 和会话。Daisy 自己写的 MCP 服务端要决定支持哪一版（各家 harness 自带的 MCP 客户端版本不一，可能还在用 2025-11-25）。建议在 P0-04 里写明支持的 MCP 版本范围。这不推翻设计。
5. 没有推翻设计。
