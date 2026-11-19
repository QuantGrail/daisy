# Writing an ACP harness config

[中文](../zh-CN/acp-harness.md)

[ACP](https://agentclientprotocol.com/) (Agent Client Protocol) is the JSON-RPC protocol that coding agents speak over standard input and output. Kimi Code, OpenCode, Antigravity and DeepSeek Harness all connect to Daisy through it, using one generic adapter.

Adding another ACP harness needs no code change: write a JSON file and point to it with `acpHarnesses` in `runner.json` in the data directory (or with the environment variable `DAISY_ACP_HARNESSES`).

## The least you need

```json
[
  { "id": "acme", "launch": { "command": "acme", "args": ["acp"] } }
]
```

That is enough: Daisy starts it with `acme acp` and speaks ACP over standard input and output. Fields you leave out take the generic defaults (see the table below), which means "basic conversation only".

## A full example

Here is an imaginary harness, "Acme Agent": its command is `acme`, `acme acp` starts the ACP server, it has three modes `default`, `plan` and `auto`, and `plan` only plans without acting. Replace `acme` with your harness's command and what it really does.

```json
[
  {
    "id": "acme",
    "name": "Acme Agent",
    "short": "Acme",
    "letter": "A",
    "color": "#3b7dd8",
    "tier": "experimental",
    "description": "Acme Agent, connected through ACP.",
    "launch": { "command": "acme", "args": ["acp"] },
    "versionArgs": ["--version"],
    "install": "npm install -g acme-agent",
    "binDirs": [".acme/bin"],
    "loginHint": "Run acme login in a terminal on this machine",
    "modes": {
      "values": ["default", "plan", "auto"],
      "default": "default",
      "readOnly": "plan",
      "bypass": null
    },
    "efforts": ["low", "medium", "high"],
    "resume": ["load"],
    "features": { "fork": "native", "compact": "native", "usage": "native" }
  }
]
```

## Tell Daisy to use the file

Save it, for example, as `acp-harnesses.json` in the data directory, then add `acpHarnesses` to `runner.json` in the same directory:

```json
{
  "nodeId": "… (written on first start, leave it alone)",
  "acpHarnesses": "acp-harnesses.json"
}
```

- Data directory: `$XDG_DATA_HOME/daisy` on Linux (default `~/.local/share/daisy`), `~/Library/Application Support/Daisy` on macOS, `%LOCALAPPDATA%\Daisy` on Windows (or the directory given by `--data-dir` or `DAISY_DATA`, see [Install › Data directory](install.md#data-directory)). The "Data dir" line of `daisy status` shows the real location.
- Daisy writes `runner.json` on first start. Leave the fields already in it alone and only add this one. If Daisy has never started, you can create a `runner.json` holding just this field; the first start keeps it.
- The path can be absolute; a relative path is relative to the data directory.
- `runner.json` and this file must belong to your account and must not be writable by other accounts (`chmod go-w`); otherwise Daisy does not use them and says why.

Then:

```sh
daisy stop && daisy start
daisy doctor                       # should list Acme Agent: installed or not, version; a broken file says which field
```

The file is read once, at start. After changing it, restart Daisy.

A Daisy started at boot (`daisy autostart on`) reads `runner.json` too, so it needs nothing extra. The `daisy` command reads `runner.json` from the same data directory to recognize `--agent acme`; you set no variables in your terminal.

You can also use the environment variable `DAISY_ACP_HARNESSES=<file>`: when it is set it wins, and `acpHarnesses` in `runner.json` is ignored. An environment variable only reaches a Daisy started from that terminal (the background process of `daisy start`). With start at boot on, Daisy is started by the system's service manager and does not get the variables of your terminal, so use `runner.json` then.

## Every field

| Field | Required | Meaning | When left out |
| --- | --- | --- | --- |
| `id` | Yes | The name inside Daisy; the `agent` of sessions and identities. Starts with a lower-case letter, only lower-case letters, digits and `-`, 2–31 characters. Must not clash with an existing name: `claude`, `codex`, `kimi`, `opencode`, `antigravity`, `deepseek`, or `runner`, `filesystem`, `plugins`, `images`, `sync` | — |
| `launch.command` | Yes | The start command: a command name (looked up in `PATH`) or an absolute path. Not a relative path (such as `./acme` or `bin/acme`): the harness starts in the session's working directory, where a relative path would point at that directory's files; such an entry is not loaded | — |
| `launch.args` | No | Start arguments, an array of strings | `[]` |
| `name` | No | Product name, used in settings, `daisy doctor` and pickers | Same as `id` |
| `short` | No | Short name used in sentences | Same as `name` |
| `letter` | No | The character on the avatar | First character of `name` |
| `color` | No | Avatar and accent color | `#777777` |
| `tier` | No | `second` (second tier: required capabilities plus the declared ones) or `experimental` (only basic conversation promised) | `experimental` |
| `description` | No | One sentence shown when creating a session | "… over ACP." |
| `versionArgs` | No | Arguments that print the version (detection, `daisy doctor`) | `["--version"]` |
| `install` | No | How to install it (hint in `daisy doctor`) | "Install it as …'s official instructions say" |
| `binDirs` | No | Install directories relative to the home directory, added to the `PATH` Daisy searches for commands | None |
| `loginHint` | No | How to log in (hint) | "Log in to … in a terminal on this machine" |
| `modes.values` | No | Values of the permission mode (ACP `session/set_mode` or the `mode` config option) | No modes |
| `modes.default` | No | Default mode | `""` |
| `modes.readOnly` | No | Which mode counts as read-only. Set it and this harness can take "ask" (weak read-only); leave it out and it cannot take "ask" | None |
| `modes.bypass` | No | The mode that skips every confirmation. Daisy never uses it for public agents or tasks from outside | None |
| `efforts` | No | Reasoning-effort values offered when the session lists none | `[]` (only what the session lists) |
| `resume` | No | How to resume a session: `load` (`session/load`), `resume` (`session/resume`). What is actually used follows what the harness declares in `initialize` | `["load", "resume"]` |
| `features` | No | Extra declared capabilities; only `fork`, `compact` and `usage` are recognized, each `native` or `none` | All `none` |

Daisy still checks what you declare in `features` against the harness's own answers: `fork` needs `session/fork` declared in `initialize`, `compact` needs `compact` among the session's available commands, and `usage` needs the harness to send `usage_update`. If you declare one the harness does not support, `fork` and `compact` fail with an explanation when used, and `usage` simply shows no data.

## What a config file cannot do

These need support in Daisy's code, which only the built-in entries have:

- **Logging in through Daisy** (`daisy login`, or "+ Sign in with an official account" under Settings › "Harness sign-in (profiles)" in the web page). A harness from a config file can only reuse this machine's login: log in in a terminal first.
- **The official terminal window**, reading and writing the harness's own config files, plan allowance.
- **Adding a message while running, withdrawing, file rewind, "ask" on a side branch.** The generic ACP adapter has none of these for any harness.

When you switch model, reasoning effort or permission mode, Daisy restarts the harness process and continues the same session.

The full capability table is in [Harnesses](harnesses.md).

## Read-only and "ask"

- With `modes.readOnly`: when someone "asks" this agent you made public, the turn switches to that mode and runs on the main line after your turn. It is only a mode the harness keeps by itself, not a hard limit, so it counts as **weak read-only**, and the agent card says so.
- Without it: this harness cannot answer read-only, and "ask" is refused. To make it public you have to allow "act".

Only name a mode `readOnly` if it really changes no files and runs no commands with side effects.

## Create an identity and open a session

On every start, Daisy creates a "host login" identity for every harness that does not have one yet (reusing this machine's existing login), including harnesses added to the file later: after you add one and restart, settings and `daisy workspace catalog` show "acme · host login". An identity you deleted is not created again automatically; to get one back, create it yourself:

```sh
daisy workspace catalog                     # find the node id
daisy profile create --agent acme --auth-mode subscription --node-id <node id> --label "Acme · host login"
```

Then create a session in the web page and pick this identity.

## Changing the command, troubleshooting

- To change the start command (for example when it is installed elsewhere): add `"agentBins": { "acme": "/opt/acme/bin/acme" }` to `runner.json` (an absolute path or a command name, not a relative path; the key must be a built-in id or an id from this file), or set the environment variable `DAISY_ACME_BIN=/opt/acme/bin/acme` (the rule is `DAISY_<ID>_BIN`, ID in upper case, `-` replaced with `_`; the environment variable wins).
- If the file cannot be read, is not a JSON array, or an entry is wrong (for example `invalid id`, `id already taken`, `launch.command / launch.args invalid`, `id repeated`): Daisy starts as usual but does not load the broken entries (a completely broken file loads none), and one line in the log, `daisy status` and `daisy doctor` says which file, which entry, and what is wrong. The `daisy` command keeps working and mentions it in one line on standard error for every command. Fix the file and restart Daisy.
- `daisy doctor` shows whether the harness is installed, whether the version is right, and whether the file came from `runner.json` or the environment variable.

## Who can change these settings

`acpHarnesses` and `agentBins` decide which program Daisy runs. Daisy has no command or endpoint that writes them; you can only edit `runner.json` directly. Only your system account can read and write that file (file 0600, data directory 0700), like your shell's config files. Settings in Daisy's API that decide what code this machine runs (for example the update source, `daisy update --source`) all need the PIN; any future command that writes these fields will need it too.
