# What each harness supports, and known limits

[中文](../zh-CN/harnesses.md)

Daisy does not rebuild harnesses. It drives the official command-line tools you installed, through one shared list of capabilities: each harness declares what it supports; the web page shows only what was declared; the command line answers "not supported" when you ask for a capability that was not declared; and Daisy never imitates a capability the harness does not have.

The tables on this page come from the capability declarations in the code (`packages/contracts/src/agent-capabilities.ts`, `acp-harnesses.ts`, `agent-stop.ts`). A running Daisy lowers them once more for the CLI version it detects. To see what one session can actually do, look at `features` in the answer of `daisy session show <id>`.

## The six harnesses

| Harness | Connection | Tier | Start command | How to install | How to log in |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Native protocol (two-way stream-json) | First | `claude` | Anthropic's official instructions | In Daisy's web page (subscription or API key), or reuse this machine's `claude` login |
| Codex | Native protocol (Codex App Server) | First | `codex` | `npm install -g @openai/codex` or the official instructions | In Daisy's web page, or reuse this machine's `codex` login |
| Kimi Code CLI | ACP | Second | `kimi acp` | Kimi's official instructions (installs to `~/.kimi-code/bin`) | In Daisy's web page, or `kimi login` in a terminal on this machine |
| OpenCode | ACP | Second | `opencode acp` | OpenCode's official instructions | `opencode auth login` in a terminal on this machine |
| Antigravity CLI | ACP | Second | `agy acp` | Antigravity's official instructions; check ACP support with `agy acp --help` | Run `agy` once in a terminal on this machine to log in |
| DeepSeek Harness | ACP | Experimental | `dsh acp` | `npm install -g @deepseek-ai/dsh` (needs Node 24.9 or later; developer preview) | No login; set up the model key as dsh's documentation says |

- The old Kimi CLI is archived; install Kimi Code CLI.
- The "experimental" tier only promises basic conversation.
- To use a different command for a harness (for example one installed outside `PATH`): add `"agentBins": { "claude": "<command>", "kimi": "<command>" }` to `runner.json` in the data directory (it also applies when Daisy starts at boot), or set `DAISY_CLAUDE_BIN`, `DAISY_CODEX_BIN`, or for an ACP harness `DAISY_<ID>_BIN` (ID in upper case, `-` replaced with `_`, for example `DAISY_KIMI_BIN`; the environment variable wins). See [Environment variables › Settings in runner.json](environment.md#settings-in-runnerjson).
- To add an ACP harness that is not listed here, see [Writing an ACP harness config](acp-harness.md).
- `daisy doctor` lists, for each harness, whether it is installed; for Claude Code and Codex it also checks the login (ACP harnesses have no read-only way to check it; you find out when you use them).

## Capability table

Legend: **✓** the harness does it itself; **◐** Daisy does it for the harness using the harness's own means (for example restarting the process and continuing the same session, Daisy's own file snapshots, Daisy's queue); **—** not supported (the web page does not show it; the command line answers "not supported").

All six support the four required capabilities: open and resume a session, send a message and stream the reply, cancel, and tool permission requests and questions.

| Capability | Claude Code | Codex | Kimi Code | OpenCode | Antigravity | DeepSeek |
| --- | --- | --- | --- | --- | --- | --- |
| Add a message while running (immediately) | ✓ | ✓ | — | — | — | — |
| Withdraw an added message | ✓ | — | — | — | — | — |
| Rewind | ✓ | ✓ | ✓ (`/undo`) | — | — | — |
| Undo file changes when rewinding | ✓ | ◐ (Daisy's snapshots) | — | — | — | — |
| Fork | ✓ | ✓ | ✓ | ✓ | — | — |
| Compact the context | ✓ | ✓ | ✓ | — | — | — |
| Switch model | ✓ | ✓ | ◐ (restart process) | ◐ | ◐ | ◐ |
| Switch reasoning effort | ✓ | ✓ | ◐ | ◐ | ◐ | ◐ |
| Permission mode | ✓ | ✓ | ◐ | ◐ | — | — |
| Read-only mode (needed for "ask") | ✓ strong | ✓ strong | ✓ weak (`plan`) | ✓ weak (`plan`) | — | — |
| Side question or fork (where "ask" runs off the main line) | ✓ side question | ✓ temporary fork | — | — | — | — |
| Context usage | ✓ | ✓ | ✓ | ✓ | — | — |
| Plan allowance left | ✓ | ✓ | — | — | — | — |
| Background task list | ✓ | ✓ | — | — | — | — |
| Official terminal window | ✓ | ✓ | ✓ | — | — | — |

**Lowered by CLI version.** The table shows Claude Code 2.1.316 or later and Codex 0.157 or later (Codex's background task list needs 0.157.1). With older versions (or before Daisy has detected the version): adding a message while running becomes Daisy putting plain text into the current turn (◐); no withdrawing; Claude Code's reasoning-effort and permission-mode switches and Codex's model and permission-mode switches become a process restart (◐); Daisy does Claude Code's rewind for it (◐); neither can undo files when rewinding; "ask" becomes a read-only fork that Daisy opens (◐).

**Limits shared by all ACP harnesses.** The generic ACP adapter cannot put a message into a running turn (ACP does not define it), so added messages queue until the turn ends; switching model, reasoning effort or permission mode restarts the harness process and continues the same session; no file rewind; no plan allowance; the compaction threshold is not reported.

## What stopping a turn stops

Stopping always means "stop this turn and everything it started in the foreground". Whatever you deliberately put in the background keeps running.

| Harness | Sub-agents | Running commands | Keeps running |
| --- | --- | --- | --- |
| Claude Code | Stopped (by the harness) | Stopped (foreground Bash) | Bash / Agent put in the background, Daisy's background tasks |
| Codex | Stopped (Daisy interrupts each sub-thread) | Stopped (Daisy ends this turn's commands) | Terminals left by earlier turns, Daisy's background tasks |
| ACP harnesses | No such thing | Stopped (by the harness) | Daisy's background tasks |

If it has not stopped after 5 seconds, Daisy ends the harness process; the session later continues from the same thread. The interrupted turn is marked interrupted and is **never replayed**.

## Ask and act

When someone calls your public agent over A2A, the default is "ask": a read-only answer. Only a request marked "act" does things (you can turn "act" off). Where an "ask" runs depends on two rows above (read-only mode, side question or fork):

| Harness | How an "ask" runs | Read-only strength |
| --- | --- | --- |
| Claude Code | While the main process is up, a native side question (no tools, not in the main history, does not interrupt the main line); otherwise a forked process that can only read (Read / Grep / Glob) and has no MCP | Strong (limited at the tool level, not by a sandbox) |
| Codex | A temporary fork with a read-only sandbox for each ask | Strong; weak on Windows |
| Kimi Code, OpenCode | No side branch: it queues on the main line after your turn, that turn switches to `plan` mode, and the full question and answer stay in the main line | Weak: `plan` is a mode the harness keeps by itself, not a hard limit |
| Antigravity, DeepSeek | No read-only mode over ACP: "ask" is refused. They can be made public only if you allow "act" | — |

Side branches are capped: 2 at a time per main line, 30 per 24 hours. The agent card states the read-only strength honestly: a weak read-only agent's card description says so.

An "act" goes into the main line, queued after your current turn, without interrupting you. Its permission mode is automatic by default (when the harness has an `auto` mode; otherwise the session's own mode) and can be changed with `daisy agent act set`; the mode that skips every confirmation is never used.

## Four ways to use the working directory

`--workspace-mode` when creating a session (sessions created in the web page use shared editing):

| Way | Value | Files | Notes |
| --- | --- | --- | --- |
| Shared editing | `shared` (default) | The current files of the chosen directory | Sessions can run at the same time; avoid editing the same file at once |
| Read-only analysis | `read-only` | The current files of the chosen directory | Daisy enforces read-only: only on Linux, and it needs `/usr/bin/bwrap` (Bubblewrap). When it cannot, it refuses instead of falling back to writable |
| Separate development | `isolated` | A separate Git worktree and branch | Starts from the committed HEAD, without uncommitted changes; Daisy never merges or deletes it for you |
| Version review | `snapshot` | A read-only worktree pinned to one commit | Unaffected by later edits in the original directory. Like read-only analysis, Daisy enforces read-only: only on Linux, with Bubblewrap |

Daisy does not serialize for you: several sessions in one directory can edit files at the same time; avoiding conflicts is up to how you split the work.

## Differences between systems

Every harness runs on Linux, macOS and native Windows; none needs WSL. The differences:

| Item | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Daisy's own enforced read-only (`read-only` and `snapshot` sessions) | Bubblewrap | None | None |
| Claude Code "ask" | Strong | Strong | Strong (limited at the tool level; Claude Code has no sandbox on native Windows) |
| Codex "ask" | Strong (read-only sandbox) | Strong | Weak (Codex's Windows sandbox depends on the Windows version and an administrator's setup) |
| Stopping the whole process tree | Process group | Process group | Job object (needs Daisy's Windows helper) |
| Official terminal window | Needs `python3` | Needs `python3` | ConPTY, needs the helper; not offered without it |
| Shell for "run in terminal" and background commands | bash / sh | bash / sh | Git Bash, else PowerShell (different syntax) |
| Stopping a harness | SIGTERM, then forced after 1.5 seconds | Same as Linux | Ended at once |

On Windows:

- **Kimi Code needs Git for Windows before its first start** (it uses Git Bash as its shell); it is recommended for Claude Code. `daisy doctor` checks.
- Antigravity's sandbox needs Windows 11 24H2 with the August 2026 update.
- For `.cmd` launchers installed by npm, Daisy runs their script with node directly, not through cmd.exe; other batch files are refused.
- Daisy looks for harness commands only in `PATH`, never in the current directory (a `claude.cmd` placed in a workspace is not run).
- If a harness's sandbox needs child processes to leave Daisy's job object, set `DAISY_WIN_JOB_BREAKAWAY=1` (off by default). Processes that leave may stay behind when Daisy is killed.

## Not yet verified

The following could not be verified during research. The code treats them as "not supported" until they are:

- Whether Antigravity supports fork and modes over ACP.
- Whether OpenCode and DeepSeek Harness have side questions; OpenCode's `/compact` over ACP and a terminal window for the same session.
- Whether Kimi Code's `plan` mode really blocks every write (so it counts as weak read-only).
- How `dsh acp` actually behaves on Windows.
- How `codex sandbox` (Codex's sandbox for background commands) behaves on Windows.
