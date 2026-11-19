# Adding an ACP harness without code

[中文](README.zh-CN.md)

Daisy ships with four ACP harnesses: Kimi Code CLI, OpenCode, Antigravity and DeepSeek Harness (experimental). Any other command-line tool that speaks ACP (Agent Client Protocol) can be added as one entry in a JSON file that you point Daisy to with `acpHarnesses` in `runner.json` in the data directory (or with the environment variable `DAISY_ACP_HARNESSES`), without changing code.

[`acp-harnesses.json`](acp-harnesses.json) is an example: Gemini CLI, started in ACP mode with `gemini --experimental-acp`. Gemini CLI's own help (`gemini --help`) is the authority on that flag; if a new version changes it, update `launch.args`.

## Usage

Put the file in Daisy's data directory (the "Data dir" line of `daisy status` shows where; the example below uses the Linux default, on macOS it is `~/Library/Application Support/Daisy`), add `"acpHarnesses": "acp-harnesses.json"` to `runner.json` in the same directory (leave the existing fields alone), and restart:

```sh
cp examples/acp-harness/acp-harnesses.json ~/.local/share/daisy/acp-harnesses.json
# edit ~/.local/share/daisy/runner.json and add: "acpHarnesses": "acp-harnesses.json"
daisy stop && daisy start
daisy doctor          # shows Gemini CLI, whether it is installed, and its version
```

A Daisy started at boot (`daisy autostart`) reads `runner.json` too, and so does the `daisy` command, so `--agent gemini` is recognized without setting any variable.

To try it once, you can also use the environment variable (it applies only to a Daisy started from this terminal; when it is set, `acpHarnesses` in `runner.json` is ignored):

```sh
daisy stop
DAISY_ACP_HARNESSES=~/.local/share/daisy/acp-harnesses.json daisy start
```

Daisy reads the file once, at start. If it has errors (invalid JSON, an invalid `id` or one that clashes with a built-in, a missing `launch.command`), Daisy starts as usual but does not load the broken entries, and one line in the log, `daisy status` and `daisy doctor` says which entry and what is wrong.

## Using it

On every start Daisy creates a "host login" identity for every harness that has none yet, so after adding the file and restarting you have "gemini · host login" (the name Daisy gives it follows the display language). Pick it when you create a session in the web page. It logs in with this machine's own `gemini` login (the `loginHint` sentence is shown in settings). An identity you deleted is not created again automatically; to create one:

```sh
daisy workspace catalog            # find the runner node id (nodes[].id)
daisy profile create --agent gemini --auth-mode subscription --node-id <node id> --label "Gemini CLI"
```

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | The agent value inside Daisy: starts with a lower-case letter, 2–31 characters, only lower-case letters, digits and `-`. Not `claude`, `codex`, the four built-ins (`kimi`, `opencode`, `antigravity`, `deepseek`), or another runner capability name |
| `launch.command` / `launch.args` | The command is | The command and arguments that start the ACP server on stdio (an absolute path if the command is not in `PATH`) |
| `name` / `short` / `letter` / `color` / `description` | No | Name in the web page, short name in sentences, avatar letter, color, one sentence on the start page |
| `versionArgs` | No | Arguments for version detection (default `--version`), used by `daisy doctor` and detection |
| `install` / `loginHint` | No | How to install it when missing and how to log in, shown by `daisy doctor` and in settings |
| `binDirs` | No | Install directories under the home directory to add to `PATH` |
| `modes` | No | Permission modes (`values`, `default`), the value that counts as read-only (`readOnly`, only "weak read-only": the agent keeps it by itself, Daisy does not enforce it), and the value that skips every confirmation (`bypass`). Left out: no modes, no read-only, and this harness takes no "ask" from others |
| `efforts` | No | Reasoning-effort choices offered when the session lists none |
| `resume` | No | How to resume a session: `load`, `resume`; both are tried by default (what is used follows what the agent declares in `initialize`) |
| `tier` | No | `second` (second tier) or `experimental` (default) |
| `features` | No | Only the three things the generic adapter does according to the agent's answers can be declared: `fork`, `compact`, `usage`, each `native` or `none` |

An entry cannot declare a capability Daisy has no code for (Daisy never imitates one): adding a message while running, withdrawing, plan allowance, an in-Daisy login and so on are all treated as "not supported". The full types and defaults are in `packages/contracts/src/acp-harnesses.ts`. More in the guide: [Writing an ACP harness config](../../docs/guide/en/acp-harness.md).

`tests/examples.test.ts` checks this example with Daisy's own loading code.
