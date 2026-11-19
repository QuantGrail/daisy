# Install, update and uninstall

[中文](../zh-CN/install.md)

Daisy installs under your own system account: one process, one data directory, one command, `daisy`. It needs no root or administrator rights and installs no system service. The commands to install, update and uninstall are the same on Linux, macOS and Windows.

When it is installed, go on to [First use](first-use.md).

> The web page, the command line and the AI's prompts speak English or Chinese (Simplified). Daisy follows your system's language; to switch, see [Language](#language).

## Requirements

| Item | Notes |
| --- | --- |
| System | Linux (start at boot needs a systemd user instance); macOS (13 or later is suggested, Claude Code needs it); Windows 10 1809 / Windows 11 or later, native, no WSL |
| Node.js | 24 or later. Check with `node --version`. If you have none, install one, for example `nvm install 24` |
| npm | Comes with Node |
| Harness | At least one of Claude Code, Codex, Kimi Code CLI, OpenCode, Antigravity CLI, DeepSeek Harness. You can install Daisy first and a harness later |
| Other | On Linux and macOS the official terminal window needs `python3`. On Windows, install Git for Windows: Kimi Code requires it, and Daisy's "run in terminal" prefers its Git Bash |

## Install

```sh
npm install -g @daisy-ai/daisy
```

> **Note: `@daisy-ai/daisy` is not on npm yet.** Until it is published, get the source and install from a locally built package (`.tgz`), as below.

### Get the source

```sh
git clone https://github.com/QuantGrail/daisy.git
cd daisy
```

### Install from a .tgz (before the npm release)

1. Build the package in the source directory:

   ```sh
   npm ci
   npm run build:web
   npm run pack:daisy        # writes artifacts/daisy-ai-daisy-<version>.tgz; publishes nothing
   ```

2. Install it globally:

   ```sh
   npm install -g ./artifacts/daisy-ai-daisy-<version>.tgz
   ```

   On Windows (PowerShell or CMD) it is the same: `npm install -g .\artifacts\daisy-ai-daisy-<version>.tgz`.

### No permission to write the global directory

If Node came from the system package manager, `npm install -g` may fail to write `/usr/lib/node_modules`. Do not use sudo. Point npm's global directory into your home and install again:

```sh
npm config set prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"     # also add this to ~/.bashrc or ~/.profile
npm install -g @daisy-ai/daisy           # or the .tgz
```

On Windows, npm's global directory is `%APPDATA%\npm` by default. It is already on PATH and needs no administrator.

To install somewhere else just this once, without changing npm's global setting, use `--prefix`:

```sh
npm install -g --prefix ~/daisy-cli ./artifacts/daisy-ai-daisy-<version>.tgz
export PATH="$HOME/daisy-cli/bin:$PATH"   # on Windows the command sits directly in <dir>, not under bin
```

`daisy update` and `daisy uninstall` later recognize the directory this copy is installed in; you do not have to repeat `--prefix`.

### Check

```sh
daisy --version
daisy doctor
```

`daisy doctor` is a read-only self-check: Node version, data directory permissions, which harnesses are installed and logged in, the PIN, ports, start at boot. Each ✗ says how to fix it.

## Data directory

Everything Daisy keeps (sessions, settings, keys, logs, backups taken before updates) is in the data directory.

| System | Location |
| --- | --- |
| Linux | `$XDG_DATA_HOME/daisy`, by default `~/.local/share/daisy` |
| macOS | `~/Library/Application Support/Daisy` |
| Windows | `%LOCALAPPDATA%\Daisy` |

- Only you can read it: on Linux and macOS the directory is 0700 and credential files are 0600; on Windows only you, SYSTEM and Administrators have access.
- To use another place, add `--data-dir <dir>` to every command, or set the environment variable `DAISY_DATA`. Use this to run two Daisys under one account. Start at boot remembers it.
- Do not use `~/.daisy`: an unrelated program with the same name (daisy-sdk on PyPI) uses it.

Files you may look at:

| File | What it is |
| --- | --- |
| `daisy.sqlite` | The database |
| `runtime.json` | The running Daisy's process id, addresses and ports (the command line reads them here; it never guesses) |
| `logs/daisy.log` | The log (in journald when systemd runs Daisy) |
| `keys/` | Identity key, command-line credential, certificates |
| `backups/` | Database backups taken before each update |
| `config.json`, `runner.json` | Settings |

## Ports

Daisy has two faces:

- **Local face**: listens on `127.0.0.1` only and is always on. The web page and the command line use it.
- **Outside face**: for other machines. Off by default; turning it on needs the PIN (see [First use](first-use.md) and the [security model](security.md)).

You do not choose a port. Daisy derives one from your system account's uid: local face `29200 + (uid mod 390)`, outside face `29600 + (uid mod 390)`. For example uid 1000 on Linux gives 29420 / 29820, and uid 501 on macOS gives 29311 / 29711. So each account on a machine gets its own ports.

- If the preferred port is taken, Daisy picks a free one in the same 390-port range and remembers the one it found on first start.
- To fix a port: add `"port": <port>` to `runner.json` in the data directory (it also applies when Daisy starts at boot, see below), or use `daisy start --port <port>` or the environment variable `DAISY_PORT` (these two only reach a background process started from your terminal). The port is an integer from 1024 to 65535 in all three places. If that port is taken, start-up fails; Daisy never switches silently.
- The port in use is written to `runtime.json` in the data directory and shown by `daisy status`.

## Start at boot

```sh
daisy autostart on      # turn on
daisy autostart         # show state
daisy autostart off     # turn off
```

None of these needs root or administrator.

| System | How | When it starts |
| --- | --- | --- |
| Linux | A systemd user unit, `~/.config/systemd/user/daisy.service` | After you log in. To start at boot without a login (usual on a server), also run `loginctl enable-linger $USER` (some systems need an administrator for this) |
| macOS | A LaunchAgent, `~/Library/LaunchAgents/ai.daisy.daisy.plist` | After you log in to the Mac |
| Windows | A Run entry for the current user (`Daisy` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`) | After you log in to Windows. Task Manager's "Startup apps" shows it and can disable it |

When the data directory is not the default one (you used `--data-dir` or `DAISY_DATA`), the name gets a suffix `-<8 hex digits>`, the first 8 hex digits of the SHA-256 of the data directory's absolute path, for example `ai.daisy.daisy-1a2b3c4d`, `daisy-1a2b3c4d.service` or `Daisy-1a2b3c4d`, so several data directories each have their own entry without overwriting each other. The real name is on the "Autostart" line of `daisy status` (`autostart.unit` in `daisy status --json`).

With start at boot on, `daisy start` and `daisy stop` go through systemd, launchd or Daisy's Windows supervisor, which also restart Daisy after a crash or an update.

- If Daisy is already running as a background process when you turn it on, run `daisy stop` and `daisy start` to hand it over.
- The unit's PATH is the one `daisy autostart on` ran with. If you later install a harness outside that PATH, run `daisy autostart on` again.
- Daisy started at boot gets only PATH (and `DAISY_DATA` if you set one), not the other environment variables of your terminal. Put a fixed port, extra ACP harnesses and harness commands in `runner.json` in the data directory instead ; they apply at boot too. Add the keys next to the ones already there:

  ```json
  { "port": 29420, "acpHarnesses": "acp-harnesses.json", "agentBins": { "kimi": "/home/me/.kimi-code/bin/kimi" } }
  ```

  An environment variable, when set, wins over the file; Daisy reads it when it starts. The full rules are in [Environment variables › Settings in runner.json](environment.md#settings-in-runnerjson).
- **On macOS, turning it on is recommended.** Claude Code keeps its subscription login in the login keychain. A background process started from a restricted terminal cannot read the keychain, and Claude then looks logged out. launchd starts Daisy inside your login session, where the keychain is readable.

## Differences between systems

### macOS

- If you reach the Mac only over SSH and nobody is logged in to the desktop, `daisy start` cannot go through launchd and says what to do: log in to the desktop and start again, or `daisy autostart off` and run as a background process (which cannot read the keychain).
- Daisy's own enforced read-only mode (it needs Linux Bubblewrap) is not available. A session that requires it is refused; it is never downgraded to writable.

### Windows

- On first start Daisy compiles a small helper with the C# compiler that ships with Windows (.NET Framework 4): `%LOCALAPPDATA%\Programs\Daisy\helper\…\daisy-win.exe`. It takes a few seconds, once. The helper stops every process an AI started, runs the official terminal window (ConPTY), starts Daisy after login, and sets "only you can read" access control. If company policy forbids locally compiled programs, these features are missing and `daisy doctor` says so.
- `daisy stop` writes a stop request; Daisy finishes as usual and exits.
- No enforced read-only mode; Codex answers an "ask" with weak read-only only (its Windows sandbox depends on the Windows version and an administrator's setup); stopping an AI ends it at once, without a grace period. The full table is in [harnesses](harnesses.md).

## Everyday commands

| To | Command |
| --- | --- |
| See if it runs, its addresses, PIN, relay, updates | `daisy status` (`--json` for scripts) |
| Stop | `daisy stop` (a running turn ends and is marked interrupted; it is never replayed) |
| Self-check | `daisy doctor` |
| Read the log | `<data dir>/logs/daisy.log`; under systemd `journalctl --user -u daisy` |
| All commands | `daisy --help`, or the [command reference](commands.md) |

## Language

Daisy speaks English and Chinese (Simplified): the web page, the command line, the local API's messages and the prompts it gives the AI. With nothing set it follows your system's language (`LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE`; on macOS also the account's preferred languages), and English when that is neither.

| To | How |
| --- | --- |
| Choose for this Daisy | Settings › Display language in the web page, or `daisy language set en` / `daisy language set zh-CN` (`daisy language set null` follows the system again); `daisy language show` shows the setting, the language in use and the ones available |
| One command in another language | `daisy --lang en <command>` (or `--lang=zh-CN`) |
| One terminal or script | `DAISY_LANG=en` — for the command line it comes before the setting; for a Daisy started with it, it only stands in for the system's language |

`daisy language set` and `daisy language show` also work while Daisy has never started or is stopped: the setting is written straight to `config.json` in the data directory and applies at the next start (the command says so). So you can choose the language before the first `daisy start`.

The web page switches at once. The names Daisy gives things itself ("This machine", "Home folder", "<harness> · host login") follow the display language too; names you give stay as you typed them. A session already under way keeps the language it started with (its AI's prompts do not change mid-conversation); new sessions use the new one. Logs are always in English.

Another language is a language pack: a folder `<data dir>/locales/<language tag>/` (for example `locales/fr/`) with JSON files of the same names and keys as `packages/contracts/locales/en/` in the source. Daisy finds it within a few seconds, without a restart, and offers it in Settings and `daisy language`. A pack there can only add a language — it never changes the English or Chinese that ship with Daisy — and it covers what people read; the AI's prompts in such a session are English. Keys the pack lacks show in English. To ship a language with Daisy, see [CONTRIBUTING.md](../../../CONTRIBUTING.md).

## Update

| To | Command |
| --- | --- |
| See versions, a found update, the last update's result | `daisy update` |
| Set where updates come from (needs the PIN) | `daisy update --source <source>` |
| Check now without installing | `daisy update --check` |
| Switch to the newest version in the source | `daisy update --apply` |
| Switch to a package on this machine | `daisy update --apply --from ./daisy-ai-daisy-<version>.tgz` |
| Go back to the previous version | `daisy update --rollback` |
| Or | `npm install -g <new version>`; Daisy switches when idle |

**There is no default update source; you set one.** Without a source, automatic updates look nowhere and `daisy status` says no source is set. `daisy update --apply --from <tgz>` always works. A source is one of:

- a directory holding `daisy-ai-daisy-*.tgz` files (the highest version wins), or the absolute path of one `.tgz`;
- `npm:@daisy-ai/daisy@latest`. **Use this only after the package is published on npm**;
- `off` to turn it off, `none` to remove it.

It is stored as `updateSource` in `runner.json`; the environment variable `DAISY_UPDATE_SOURCE` means the same.

Automatic updates are on by default: every 30 minutes Daisy looks at the source and switches to a newer version when idle. It only moves forward. To turn this off, add `"autoUpdate": false` to `<data dir>/runner.json` (`daisy update --apply` still works).

Every switch goes like this:

1. **Wait until fully idle**: no running turn, no card waiting for an answer, no login, no terminal command. A running turn is never interrupted.
2. **Back up the database**: `<data dir>/backups/daisy-update-<old>-to-<new>-<time>.sqlite`. The newest 3 are kept.
3. **Keep a way back**: the current version's package goes to `<data dir>/update/packages/`.
4. **Restart into the new version**: if it is not running normally within 120 seconds, the previous version is put back.

The result goes into the audit log and shows in `daisy status` and `daisy update`.

- `daisy update --apply` works while Daisy is stopped: the next `daisy start` backs up first, then tries the new version.
- Going to an older version, or to a different build with the same version number, needs `--allow-downgrade`.
- Going back does not restore the database (its structure only grows, so older versions keep working). To really return to the data from before an update: stop Daisy, replace `daisy.sqlite` with the copy in `backups/`, and delete `daisy.sqlite-wal` and `daisy.sqlite-shm` next to it. Data written after the backup is lost.

## Uninstall

```sh
daisy uninstall
npm uninstall -g --prefix <npm global dir> @daisy-ai/daisy
```

**Copy the second command from the last line `daisy uninstall` prints.** It names the npm global directory of this install. If another copy of Daisy is installed elsewhere on the machine, an `npm uninstall -g` without `--prefix` may remove the other one.

`daisy uninstall` stops Daisy, ends harness processes it left, removes start at boot, and checks that nothing is left running. **It keeps the data directory** and tells you where it is. To delete the data too:

```sh
rm -rf "<data dir>"                              # Linux, macOS
Remove-Item -Recurse -Force "<data dir>"         # Windows PowerShell
```

`npm uninstall` alone cannot remove the start-at-boot entry, so run `daisy uninstall` first. If you forgot, remove it by hand (for a non-default data directory, use the name with the `-<8 hex digits>` suffix, see [Start at boot](#start-at-boot)):

- Linux: `systemctl --user disable --now daisy.service && rm ~/.config/systemd/user/daisy.service && systemctl --user daemon-reload`
- macOS: `launchctl bootout gui/$(id -u)/ai.daisy.daisy; rm ~/Library/LaunchAgents/ai.daisy.daisy.plist`
- Windows (PowerShell): `Remove-ItemProperty -Path HKCU:\Software\Microsoft\Windows\CurrentVersion\Run -Name Daisy`

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `daisy: command not found` | npm's global bin directory is not on PATH. `npm prefix -g` shows the global directory; add its `bin` (on Windows, the directory itself) to PATH |
| "Daisy needs Node.js 24 or later" | Install Node 24, then install Daisy again |
| "Daisy is not running" | `daisy start` |
| It exits right after start | The error shows the last lines of the log; for the full log see "Read the log" above |
| Cannot reach your systemd user instance | Run it in a normal login session (sessions from `su` or `sudo` have no user bus), or `loginctl enable-linger $USER` and log in again |
| macOS: Claude cannot read the keychain, or says it is logged out | `daisy autostart on`, then `daisy stop && daisy start`. `daisy status` should show launchd |
| macOS: "launchd could not start ai.daisy.daisy…" | Nobody is logged in to this Mac's desktop. Log in, then `daisy start` again |
| Logged in, but a turn fails saying the model is not supported | This account cannot use that model. Tap the model at the bottom of the conversation → "Read the native model list", pick a model from the list and send again |
| The web page is blank | The package was built without the web page: run `npm run build:web` before packing, and install again |
| Anything else | `daisy doctor`. Every error message says how to fix it |
