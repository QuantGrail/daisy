# Daisy

[中文](README.zh-CN.md)

Daisy turns the coding agents you already use (Claude Code, Codex, Kimi Code, OpenCode, Antigravity, DeepSeek Harness) into AI agents you can reach from anywhere, and that other agents can call.

You install one Daisy per machine, under your own account. It runs the official command-line tools for you, keeps their sessions, and gives you a local web page, a phone page and a command line. Other people's agents can call yours over [A2A](https://a2a-protocol.org/) 1.0, and yours can call theirs. There is no central server: one machine, one Daisy, one owner.

(Not to be confused with daisyUI, the CSS library.)

## Features

- **Six harnesses, one way of working.** Claude Code and Codex through their native protocols; Kimi Code, OpenCode, Antigravity and DeepSeek Harness through one generic [ACP](https://agentclientprotocol.com/) adapter. Add another ACP harness with a JSON file. Each harness declares what it supports; Daisy shows only that and never fakes the rest.
- **A full workbench in the browser.** Streaming replies, tool approvals and questions as cards, queueing and steering, rewind, fork, compact, model and effort switches, attachments, the official terminal window on the same session.
- **On your phone.** Pair a phone browser with a one-time code; revoke it any time.
- **A command line for nearly everything.** Sessions, workspaces, logins, contacts, agents, relay, pairing and updates all have `daisy` commands with JSON output, generated from the same route table as the local API. One exception: an AI's tool-approval and question cards are answered only in the web page or on a paired device; `daisy watch` tells you when one is waiting.
- **Agents that others can call.** Exchange signed identity cards with people you trust. Make a session public, or run a resident agent that gives each visitor a separate session. Callers "ask" (read-only) by default and "act" only if you allow it. First calls wait for your approval.
- **Your AI can call others.** Daisy gives each harness three tools (`agents`, `call_agent`, `call_result`). `daisy-mcp` gives the same tools to a harness without Daisy.
- **Reachable behind a router.** Run your own `daisy-relay` (or use someone's) for a fixed public address. The relay forwards TLS by SNI without terminating it, and stores nothing.
- **The owner stays in charge.** A PIN guards everything that lets someone in. Local face on loopback only; the outside face is off until you turn it on. Audit log, redaction of secrets, tokens bound to one turn.
- **Linux, macOS and Windows,** natively. Start at login without root or administrator; updates wait until idle, back up first and roll back on failure.

## Status

Daisy is pre-release (0.1.0). Expect changes to commands and the local API before 1.0.

- The package is **not on npm yet**. Until it is, build a `.tgz` from this repository (see below).
- The web page, the command line and the AI's prompts speak English or Chinese (Simplified): Daisy follows your system's language, and you can switch in Settings › Display language or with `daisy language set` (see [Language](docs/guide/en/install.md#language)). More languages are drop-in language packs — see [CONTRIBUTING.md](CONTRIBUTING.md).
- The user guide is in English and Chinese.

## Install

Requirements: Node.js 24 or later. To have a conversation you also need at least one harness (Claude Code, Codex, …); it can be installed before or after Daisy.

```sh
npm install -g @daisy-ai/daisy
```

Before the npm release, get the source and build and install a local package instead:

```sh
git clone https://github.com/QuantGrail/daisy.git
cd daisy
npm ci
npm run build:web
npm run pack:daisy                                   # artifacts/daisy-ai-daisy-<version>.tgz
npm install -g ./artifacts/daisy-ai-daisy-<version>.tgz
```

Details, data directory, ports, start at boot, update and uninstall: [docs/guide/en/install.md](docs/guide/en/install.md).

## Quick start

On macOS, run `daisy autostart on` first (recommended): Daisy then starts through launchd inside your login session, where Claude Code can read its login from the keychain. Started from a restricted terminal instead, Claude may look logged out. See [Start at boot](docs/guide/en/install.md#start-at-boot).

```sh
daisy start        # runs in the background
daisy pin set      # no AI turn starts until a PIN is set
daisy open         # opens the local web page with a one-time link
```

In the web page, pick an identity (a harness login) and a workspace, and start a conversation. If `claude`, `codex` or `kimi` is already logged in on this machine, the ready-made "host login" identity just works.

Next steps: [docs/guide/en/first-use.md](docs/guide/en/first-use.md).

## Documentation

- [User guide](docs/guide/README.md): install, first use, every command, harness support, relay, pairing, security model, ACP harness config, integrations, plugins, environment variables.
- [Local API](docs/api/local-api.md) (generated from the route table) and [OpenAPI](docs/api/openapi.json).
- Design decisions: [docs/adr](docs/adr).

## Repository layout

| Path | What |
| --- | --- |
| `packages/daisy` | The Daisy process and the `daisy` command |
| `packages/contracts` | Shared types, the route table, capability declarations |
| `packages/ui`, `apps/app` | The web page |
| `packages/client` | TypeScript client for the local API |
| `packages/relay` | `daisy-relay`, published on its own |
| `packages/a2a-client`, `packages/a2a-mcp` | A2A client and the standalone `daisy-mcp` |

Development: `npm ci`, `npm run typecheck`, `npm test`, `npm run build:web`, `npm start`.

## License

Apache License 2.0. See [LICENSE](LICENSE).

Copyright The Daisy Authors.
