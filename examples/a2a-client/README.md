# Calling a Daisy agent from code (A2A)

[中文](README.zh-CN.md)

Public agents and resident agents on a Daisy speak standard A2A 1.0. The caller needs an identity of its own (an Ed25519 key) and must be known to the other Daisy:

1. You give your **identity card** to the other Daisy's owner, who imports it (`daisy contact import --card-file your-card.daisycard --whitelist`, needs the PIN). The allowlist means approved in advance; without it, your first call shows a card waiting for approval on their side.
2. They give you their card (`daisy contact export`). It holds their public key, id and addresses.
3. Their agent must be open to you (a public agent is open to everyone whose card was imported by default).

## `call-agent.ts`: with `@daisy-ai/a2a-client`

This is the code Daisy itself and `daisy-mcp` use: the safety rules for outgoing connections (no loopback or cloud metadata addresses, no redirects, size and time limits), the TLS binding check for relay addresses, and a fresh token for every request are all built in.

```sh
# in a checkout of this repository (after npm ci)
node --import tsx examples/a2a-client/call-agent.ts card --key me.key.json --name "My script" > me.daisycard
# …give me.daisycard to the other side to import, get their bob.daisycard back…
node --import tsx examples/a2a-client/call-agent.ts call --key me.key.json --card bob.daisycard "Hi, please look at this error"
```

If they opened more than one agent to you, it lists them; pick one with `--agent <agentId>`. If they need more information from you, send again with `--task` and `--context` as the prompt says. The private key file `me.key.json` is readable only by you (0600); never commit it anywhere.

## `official-sdk.ts`: with the official SDK

`@a2a-js/sdk` reads the agent card (`<Daisy address>/a2a/<agentId>/.well-known/agent-card.json`) and sends messages by itself; you only give it a fetch that adds `Authorization: Bearer <token>` to every request. The token's fields:

| Field | Value |
| --- | --- |
| Header | `alg` EdDSA, `typ` `at+jwt`, `kid` your identity id (52 base32 characters) |
| `iss`, `sub` | Your own identity URN (`urn:ietf:params:oauth:jwk-thumbprint:sha-256:<thumbprint>`) |
| `aud` | The other Daisy's identity URN (exactly one) |
| `client_id` / `scope` | `a2a` / `daisy:invoke` |
| `exp` | At most 5 minutes; a new `jti` every time (each is accepted only once) |

The official SDK uses a plain fetch: it trusts only certificates signed by a certificate authority, has none of the outgoing rules above, and does not check the TLS binding statement through a relay. Prefer `call-agent.ts` when you can.

Both examples are run by `tests/examples.test.ts` against a real in-process Daisy (temporary port, fake harness, no network).
