# Configuring `daisy-mcp` in an MCP client

[中文](README.zh-CN.md)

`daisy-mcp` (package `@daisy-ai/a2a-mcp`) is a client-only A2A MCP server: it has its own Ed25519 identity key and contact list and offers three tools, `agents` (discover agents), `call_agent` (call an agent) and `call_result` (look up a call's result). It listens on no port, its card has no address, and nobody can call it. Details: `packages/a2a-mcp/README.md`.

## 1. Install and exchange cards (in a terminal, by you)

Needs Node.js 24 or later. **`@daisy-ai/a2a-mcp` is not on npm yet**: until it is, pack it in a checkout of this repository and install it globally (after publication, use `npm install -g @daisy-ai/a2a-mcp`):

```sh
npm ci
npm pack -w @daisy-ai/a2a-mcp                   # produces daisy-ai-a2a-mcp-<version>.tgz
npm install -g ./daisy-ai-a2a-mcp-<version>.tgz     # gives you the daisy-mcp command
```

Then exchange cards:

```sh
daisy-mcp card --name "My Claude Code" > me.daisycard    # give it to the other Daisy's owner to import
daisy-mcp import bob.daisycard --expect-id "<first 16 characters of their id>"   # import their card: it shows the card and imports only after you type yes
daisy-mcp contacts
```

`--expect-id` only refuses a card whose id does not match; it does not replace the confirmation. When not run in a terminal, add `--yes` after you have checked the id. The AI cannot add or remove contacts; only you can, in a terminal.

## 2. Configure the MCP client

- Claude Code: put [`claude-code.mcp.json`](claude-code.mcp.json) in the project root and rename it `.mcp.json`; or run one command: `claude mcp add daisy -- daisy-mcp serve --agent-name "My Claude Code"`.
- Codex: add the table in [`codex.config.toml`](codex.config.toml) to `~/.codex/config.toml`.
- Other MCP clients: command `daisy-mcp`, argument `serve`, transport stdio.

`--agent-name` is "who is calling" as the other owner sees it (default `Daisy MCP`). Keys and contacts live in the system's config directory by default (macOS `~/Library/Application Support/Daisy MCP`, Linux `$XDG_CONFIG_HOME/daisy-mcp` or `~/.config/daisy-mcp` when that is unset, Windows `%APPDATA%\Daisy MCP`); to put them elsewhere add `"env": { "DAISY_MCP_HOME": "/path" }` to the configuration (in TOML, `env = { DAISY_MCP_HOME = "/path" }`), or add `--home /path` to `args`.

The other agent's answer reaches the AI wrapped in `<external_message>`, marked as reference material, not as instructions.

`tests/examples.test.ts` checks both configurations: it starts `daisy-mcp` with the arguments from each, connects with the MCP SDK's client, and lists the three tools.
