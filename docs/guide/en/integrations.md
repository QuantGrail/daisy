# Integrations: A2A, daisy-mcp, external UIs

[中文](../zh-CN/integrations.md)

Daisy deals with the outside world in four ways:

| What you want | What to use |
| --- | --- |
| My AI calls someone else's agent | The three tools Daisy gives each harness (added automatically) |
| Someone else (their Daisy or any A2A client) calls my agent | Daisy's A2A server |
| A harness without Daisy calls someone else's agent | The standalone `daisy-mcp` |
| Write your own UI or program that drives Daisy | The local API plus an external issuer (or the command line on this machine) |

The protocol between Daisys is [A2A](https://a2a-protocol.org/) 1.0. Security rules: [Security model](security.md).

## Exchanging cards first

Two Daisys must first exchange cards. Each side does this once:

```sh
daisy contact export --name "Alice"        # needs the PIN; the `text` in the answer is the card: send all of it to the other side
daisy contact import --card-file bob.daisycard --expect-id "<id checked with the other side>"   # needs the PIN
daisy contact list
```

- You can pass the card text you received directly as the argument (`daisy contact import "<the whole text>"`), or save it as a `.daisycard` file and use `--card-file`.
- A card holds a display name, the public key and id, and the addresses where you can be reached (the outside face's direct address, the relay address). The card itself grants nothing.
- Before importing, check the id with the other person face to face or by phone, at least the first 16 characters. A card only proves "this content came from whoever holds this key".
- `--whitelist` also puts them on the allowlist: when they call an agent of yours that is "open to everyone whose card you imported", no card pops up.
- The card must carry an address for the other side to reach you: turn on the outside face (`daisy access external on`) or choose a relay (`daisy relay set`) first.

## My AI calls others

Daisy gives every harness it manages three tools (MCP), with no setup:

| Tool | What it does |
| --- | --- |
| `agents` | List the agents that people whose cards you imported have opened to you |
| `call_agent` | Call an agent: `mode` is `ask` (the default) or `act`; `continue: true` continues the previous conversation |
| `call_result` | Look up the result of a call |

In a session, just tell the AI "ask that agent on Alice's Daisy about …". The other side's answer reaches your AI as outside material, not as your instruction.

Whom your AI called: `daisy call list`, `daisy call show <id>`, or the settings in the web page.

When calling through a relay, Daisy first checks the other side's TLS binding statement; if it does not match, no token is sent and the call is refused (see [Relay](relay.md)).

## Others call me

A session is a private agent by default; nobody can call it. To be callable, pick one:

- **Make a session public**: `daisy agent public set <session id> true` (needs the PIN; `false` makes it private again). Others "ask" or "act" in that session. **Conversations mix**: visitors can read that session's context.
- **Create a resident agent**: `daisy agent resident create --name Support --harness claude --workspace-id <id> --profile-id <id> --tools Read --tools Grep --tools Glob` (needs the PIN). Each visiting conversation gets its own session, and they cannot see each other; the prompt has four layers (Daisy's rules, role, guidance, reference material); it can be paused, resumed and closed.

Then decide who may call:

```sh
daisy agent audience show <agent id>
daisy agent audience set <agent id> --open-to listed --listed <contact id>   # only listed people (needs the PIN); `all` means everyone whose card you imported
daisy agent act set <agent id> --act false    # allow ask only, no act (needs the PIN)
daisy request list                            # calls waiting for your approval
daisy request decide <request id> always      # always = allow always / once = allow once / reject (needs the PIN)
daisy grant list                              # existing grants; take one back with daisy grant revoke
```

Every command's options are in the [command reference](commands.md). The web page's settings have the same features.

### A2A server addresses

| | Address |
| --- | --- |
| Agent directory (Daisy's own, not part of A2A) | `GET <root>/a2a` |
| Agent card | `<root>/a2a/<agent id>/.well-known/agent-card.json` |
| JSON-RPC 2.0 | `POST <root>/a2a/<agent id>/jsonrpc` |
| HTTP+JSON | `<root>/a2a/<agent id>/message:send`, `…/tasks`, `…/tasks/<task id>`, `…/tasks/<task id>:cancel` |

`<root>` is the outside face address or the relay address. Notes:

- Only A2A 1.0 is supported: requests must carry the `A2A-Version: 1.0` header. Both transports (HTTP+JSON, JSON-RPC) are available, and the card declares both.
- Supported: send a message, get a task, list tasks (only the ones you started), cancel a task. Not supported: streaming, subscriptions, push notifications, the extended card.
- Without `returnImmediately: true`, Daisy answers only when the task ends or needs input; with it, the task comes back immediately. After a dropped connection, send again with the same `messageId` to get the original task.
- An agent you cannot see (private, or not open to you) always answers 404, as if it did not exist.
- A visiting conversation is reclaimed after 7 days idle with no unfinished task.

### Giving a third-party A2A client a token

A client that is not Daisy (for example a program written with the official A2A SDK) does not sign its own tokens. Issue one for it:

```sh
daisy token issue --for <contact id> --ttl 30d --note "for CI"    # needs the PIN
```

- The token appears only in this one answer; Daisy does not store it. Keep it like a password.
- Whoever holds it calls as that contact and still goes through call authorization (audience, allowlist, cards). `--for me` issues one to yourself, which also works only at the A2A entry.
- 7 days by default, at most 90 days. Manage them with `daisy token list` and `daisy token revoke <id>`; they become invalid when the contact is removed or the PIN is reset.
- The client sends `Authorization: Bearer <token>` with each request.

When calling through a relay while your relay certificate is still self-signed, third-party clients report an untrusted certificate; it works once ACME has issued a certificate (see [Relay › Certificates](relay.md#certificates-acme)).

## daisy-mcp: for harnesses without Daisy

`@daisy-ai/a2a-mcp` (command `daisy-mcp`) is a standalone MCP server that runs over stdio. It has its own key pair and contact list, exchanges the same cards as Daisy, and offers the same three tools: `agents`, `call_agent`, `call_result`. It is **client only**: it listens on no port, its card has no address, and nobody can call it.

Once published to npm it installs with `npm install -g @daisy-ai/a2a-mcp`. **It is not on npm yet**; until then, pack and install it from a source checkout (how to get the source: [Install › Get the source](install.md#get-the-source)):

```sh
npm ci
npm pack -w @daisy-ai/a2a-mcp                   # produces daisy-ai-a2a-mcp-<version>.tgz
npm install -g ./daisy-ai-a2a-mcp-<version>.tgz     # gives you the daisy-mcp command
```

Usage:

```sh
# 1. Export your own card and give it to the other Daisy's owner to import (daisy contact import); ask them to let you call
daisy-mcp card --name "Alice's Claude Code"

# 2. Import the other Daisy's card (check the id with them): it shows the card and imports only after you type yes
daisy-mcp import bob.daisycard --expect-id "<id>"

# 3. Configure the MCP server in the harness: command daisy-mcp, arguments serve [--agent-name "Alice's Claude Code"]
```

`--expect-id` only refuses a card whose id does not match; it does not replace the confirmation. When not run in a terminal (for example reading the card from standard input) it cannot ask, so add `--yes` after you have checked the id.

Other commands: `daisy-mcp contacts`, `daisy-mcp remove <id>`, `daisy-mcp --help`.

Keys and contacts live in the system's config directory by default (`$XDG_CONFIG_HOME/daisy-mcp` on Linux, or `~/.config/daisy-mcp` when that is unset; `~/Library/Application Support/Daisy MCP` on macOS, `%APPDATA%\Daisy MCP` on Windows), readable and writable only by the current account. Use `--home <dir>` or the environment variable `DAISY_MCP_HOME` to put them elsewhere. Needs Node.js 24 or later.

Ready-made configurations for Claude Code and Codex: [examples/daisy-mcp](../../../examples/daisy-mcp/).

## Writing your own UI or program

### On this machine: use the command line

On the same machine, the simplest way is to run the `daisy` command: API commands answer in JSON (see the [command reference](commands.md)). To keep reading events such as "the AI asks for permission", "the AI asks a question" and "someone wants to call":

```sh
daisy watch --cursor-file ~/.daisy-watch-cursor    # one JSON event per line (CloudEvents 1.0)
```

### The local API

The web page and the command line use the same local HTTP API, defined in `packages/contracts/src/api`; the documentation is generated from it: [local API documentation](../../api/local-api.md) and [OpenAPI description](../../api/openapi.json). Each endpoint states its scope, whether it needs the PIN, and which channels can use it.

### External issuers

To connect to Daisy as the owner from another program (for example your own web back end), configure an external issuer (OAuth / OpenID Connect):

```sh
daisy access issuer set --issuer https://id.example --owner-subject <the owner's sub at the issuer>    # needs the PIN
daisy access issuer show
```

- Tokens the issuer signs for the owner (`sub` is the owner) get the owner identity, and their lifetime may not exceed 24 hours; tokens signed for anyone else work only at the A2A entry.
- Daisy verifies tokens offline and rotates public keys by `kid`.
- **Answering the AI's tool permission requests and questions is not open** to these tokens: a UI can list the cards, but for answering it should send the owner to Daisy's web page or a paired device.
- A TypeScript client is in `packages/client` (`@daisy-ai/client`); it can talk to several Daisys at once.

A server-side process (recommended) needs no origin setting to connect to Daisy: Node's `fetch`, `ws` and `curl` send no `Origin`. **Do not add an `Origin` header yourself.**

A UI running in a browser needs its origin put on the allowlist by the owner first (it applies only on the outside face):

```sh
daisy access ui-origins set --origins https://ui.example    # needs the PIN; --origins can repeat
daisy access ui-origins show
daisy access ui-origins clear
```

The outside face uses a self-signed certificate by default: make your program trust only this Daisy's `keys/tls-cert.pem` (for example with `NODE_EXTRA_CA_CERTS`); do not turn off certificate checking.
