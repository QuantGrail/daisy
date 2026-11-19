# Environment variables

[中文](../zh-CN/environment.md)

Most people need no environment variables at all. These are the ones that matter to users.

Note: the background process started by `daisy start` inherits your terminal's environment. With start at boot on, Daisy is started by systemd, launchd or a Windows Run entry and gets only `PATH` and an explicitly given `DAISY_DATA`; the other variables of your terminal do not reach it. That is why the port, extra ACP harnesses and harness commands can also be written in `runner.json` in the data directory (see [Settings in runner.json](#settings-in-runnerjson) below), where they apply at boot as well.

## Daisy and the `daisy` command

| Variable | Effect | Equivalent setting |
| --- | --- | --- |
| `DAISY_DATA` | Data directory. If unset, the system's convention applies (see [Install › Data directory](install.md#data-directory)) | `--data-dir <dir>` |
| `DAISY_PORT` | Port of the local face, an integer from 1024 to 65535 (outside that range Daisy refuses to start and says why). If it is taken, start-up fails; Daisy never switches silently. When unset, `PORT` is used too | `daisy start --port <port>`; `port` in `runner.json` |
| `DAISY_UPDATE_SOURCE` | Update source: a directory holding `.tgz` files, one `.tgz`, `npm:@daisy-ai/daisy@latest`, or `off` | `daisy update --source` (needs the PIN; stored as `updateSource` in `runner.json`, which wins over the environment variable) |
| `DAISY_ACP_HARNESSES` | File of extra ACP harnesses (a JSON array). Read by Daisy and by the `daisy` command | `acpHarnesses` in `runner.json`; see [Writing an ACP harness config](acp-harness.md) |
| `DAISY_CLAUDE_BIN` | Claude Code's command, default `claude` | `agentBins.claude` in `runner.json` |
| `DAISY_CODEX_BIN` | Codex's command, default `codex` | `agentBins.codex` in `runner.json` |
| `DAISY_<ID>_BIN` | An ACP harness's command (ID in upper case, `-` replaced with `_`), for example `DAISY_KIMI_BIN`, `DAISY_OPENCODE_BIN`, `DAISY_ANTIGRAVITY_BIN`, `DAISY_DEEPSEEK_BIN` | `agentBins.<id>` in `runner.json` |
| `DAISY_CARD_TTL_HOURS` | How long the AI's tool permission and question cards wait for your answer (hours) | Default 24 |
| `DAISY_PLUGINS` | Which plugins to enable, comma-separated plugin names. None by default (see [Plugins](plugins.md)) | `plugins` in `runner.json` (when present it wins and the environment variable is ignored) |
| `DAISY_ALLOW_HTTP_ISSUER` | When `1`, an external issuer may use plain http on a loopback address (only when no other account exists on this machine; for tests and local deployments) | — |
| `DAISY_WIN_JOB_BREAKAWAY` | Windows only. When `1`, a harness may start child processes that leave Daisy's job object (when a harness's sandbox needs it). Such processes may stay behind when Daisy is killed | Off by default |
| `DAISY_ORIGINS` | Other origins of host pages that embed Daisy (comma-separated, for example `https://team.example.com`): used only to let them embed Daisy in an iframe and to open the page's links there; it never loosens the API's origin check | — |
| `DAISY_BRANDING`, `DAISY_BRANDING_FILE` | The web page's look when embedded in a host (colors, fonts, wording and so on, as JSON; the second is the path of a JSON file). Affects only the look | — |
| `DAISY_RATE_LIMIT` | Maximum requests per caller per minute (each web login, the command line and each AI turn count separately; unidentified callers count by source address); beyond it, 429. Default 6000 | — |
| `DAISY_RUNNER_SELF_RESTART` | For updates and restarts Daisy exits and something else starts it again. systemd, launchd, Windows Run entries and the background process of `daisy start` are all detected; nothing to set. When another service manager runs `daisy start --foreground`, set it to `1` (that manager starts Daisy again after it exits); set `0` to turn self-restart off (an update then takes effect only when you restart by hand) | `selfRestart: false` in `runner.json` is the same as `0` |

When building the web page (`npm run build:web`) one more is recognized: `DAISY_BASE_PATH`, for example `/daisy`, builds the web page to live under a sub-path (for embedding in another site); unset means the root path.

Other `DAISY_*` variables are for internal tuning and tests (timeouts, cache sizes, polling intervals and so on). They are not guaranteed to stay the same between versions; normally leave them alone.

### Settings in runner.json

`runner.json` in the data directory (written by Daisy on first start; the "Data dir" line of `daisy status` shows where) can hold these fields, which a Daisy started at boot also reads:

```json
{
  "nodeId": "… (leave existing fields alone)",
  "port": 29420,
  "acpHarnesses": "acp-harnesses.json",
  "agentBins": { "claude": "/opt/claude/bin/claude", "kimi": "/home/me/.kimi-code/bin/kimi" }
}
```

| Field | Same as | Notes |
| --- | --- | --- |
| `port` | `DAISY_PORT` | An integer from 1024 to 65535 (the same range applies to `DAISY_PORT` and `daisy start --port`). If it is taken, start-up fails; Daisy never switches silently |
| `acpHarnesses` | `DAISY_ACP_HARNESSES` | Path of the extra ACP harness file; a relative path is relative to the data directory |
| `agentBins` | `DAISY_<ID>_BIN` | Each harness's command, keyed by agent id (`claude`, `codex`, `kimi`, `opencode` …, or an id from the extra harness file; other keys are ignored). The value is an absolute path or a command name (looked up in `PATH`); relative paths are ignored, because the harness starts in the session's working directory, where a relative path would point at that directory's files |

- The environment variable wins: if the same setting is given as an environment variable (for `port`, `DAISY_PORT` or `PORT`; for `agentBins`, also the old `HARBOR_<ID>_BIN`), `runner.json` is not consulted for it; if neither is given, the default applies.
- Read only at start. After a change, restart Daisy (`daisy stop && daisy start`). The `daisy` command reads `runner.json` from the same data directory every time it runs, so the command line recognizes the same harnesses as Daisy.
- A wrong field (for example a `port` that is not an integer) is ignored; Daisy starts as usual, and `daisy doctor` and `daisy status` say which field.
- If `runner.json` (or the file `acpHarnesses` points to) does not belong to your account, or another account can write it, these fields (`port`, `acpHarnesses`, `agentBins`) are all ignored and Daisy says why: they decide which program Daisy runs. The Daisy process itself then does not start (the file also decides plugins, updates, identity folders and workspaces; see [Plugins](plugins.md)). When `runner.json` is not valid JSON, Daisy does not start and says at which line and column.
- These fields decide which program Daisy runs and which port it listens on, so they can only be changed by editing the file; no command or endpoint writes them. Only your account can read and write `runner.json`.

### Old names

In earlier versions of Daisy some of these variables started with `HARBOR_` (for example `HARBOR_CLAUDE_BIN`, `HARBOR_KIMI_BIN`, `HARBOR_ORIGINS`). The old names are deprecated but still read: a setting given only under its old name still works, and Daisy reminds you once in the log to switch to the new `DAISY_` name; if both are set, the new name wins. `HARBOR_DATA` is the exception: Daisy never used it; the data directory follows only `DAISY_DATA`.

## Set by Daisy for harnesses

Daisy sets these when it starts a harness, for the harness's tools. Do not set them yourself.

| Variable | What it is |
| --- | --- |
| `DAISY_URL` | Address of the local face |
| `DAISY_AI_CREDENTIAL_FILE` | The file holding this turn's AI work credential (readable only by the owner, invalid once the turn ends) |
| `DAISY_SESSION_ID` | The current session's id |

## daisy-relay

See [Relay](relay.md).

| Variable | Effect |
| --- | --- |
| `DAISY_RELAY_CONFIG` | Path of the configuration file (same as `--config`) |
| `DAISY_RELAY_DOMAIN` | The relay's own domain |
| `DAISY_RELAY_HOST`, `DAISY_RELAY_PORT` | Listen address and port, default `0.0.0.0:443` |
| `DAISY_RELAY_TLS_CERT`, `DAISY_RELAY_TLS_KEY` | Certificate and private key for the relay's own domain (PEM files; not a wildcard certificate) |
| `DAISY_RELAY_LOG_LEVEL` | `debug`, `info`, `warn`, `error` |

## daisy-mcp

| Variable | Effect |
| --- | --- |
| `DAISY_MCP_HOME` | Where keys and contacts are kept (same as `--home`) |
