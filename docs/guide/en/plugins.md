# Plugins

[中文](../zh-CN/plugins.md)

Plugins add things Daisy does not have by itself, for example injecting an organization's own prompt when a session starts, receiving events from an outside system and waking a session, or adding environment variables to harness processes. Most people need no plugins.

**No plugin is enabled by default.** While a plugin is not enabled, its code is not loaded, and its endpoints, tables, environment variables and paths do not exist.

## What a plugin is

A plugin is a separate npm package (for its name see "Plugin names" below) that exports two halves:

- `./server`: the half inside the Daisy process. It can supply the organization's prompt when a session starts, subscribe to outside events and wake sessions, and declare its own notification kinds, with their names per language (they appear in the notification settings only while the plugin is enabled; while it is not, the switches you saved for it are kept unchanged and have no effect);
- `./runner`: the half that runs sessions. It can add environment variables to a session's harness processes, declare its own secret files (side-question branches cannot read them), and do some work in every loop of the runner.

A plugin imports Daisy's pieces only from `@daisy-ai/daisy/plugin`; Daisy's core code never refers to any plugin by name.

**A plugin runs in the same process and under the same system account as Daisy, and can do everything Daisy can.** Enable only plugins you trust.

## Plugin names

A name in `plugins` / `DAISY_PLUGINS` can be written three ways, and **the package loaded is exactly the one written**:

| Form | Example | Package loaded |
| --- | --- | --- |
| Short name | `my-plugin` | `@daisy-ai/my-plugin` |
| Full scoped package name | `@acme/daisy-foo` | `@acme/daisy-foo` |
| `npm:` plus an unscoped package name | `npm:daisy-plugin-foo` | `daisy-plugin-foo` |

- **A name with no `@`, `/` or `:` is always a short name** and means `@daisy-ai/<short name>`, exactly as before; existing configurations need no change. A short name uses only lower-case letters, digits and `-`, starts with a letter, and is at most 40 characters.
- An unscoped third-party package is written `npm:<package name>`. That way a short name is never taken for another package of the same name: `my-plugin` is only ever `@daisy-ai/my-plugin`, and `npm:my-plugin` is the package called `my-plugin`. `npm:@acme/daisy-foo` is the same as `@acme/daisy-foo`.
- Full package names are checked against npm's naming rules: lower case, only letters, digits and `-`, `.`, `_`, `~`, not starting with `.` or `_`, at most 214 characters.
- It cannot be one of Daisy's own packages (`daisy`, `contracts`, `client`, `ui`, `server`, `runner`, `relay`, `a2a-mcp`, `a2a-client`, neither as a short name nor under `@daisy-ai/`), nor the name of a module built into Node.
- **Package names only, never paths**: `./x`, `../x`, `/opt/x`, `C:\x`, `file:` and URLs are all refused.

An invalid name makes Daisy refuse to start and say which name.

The name a plugin reports itself (the `name` returned by `createServerPlugin` / `createRunnerPlugin`) must be the name it was enabled by or its package name: a plugin under `@daisy-ai/` reports its short name (such as `my-plugin`), any other plugin reports its package name (such as `@acme/daisy-foo` or `daisy-plugin-foo`). In `runner.json`, a plugin's options go under the name you enabled it by.

## Installing: next to Daisy

Daisy looks for a plugin's package the way Node does, upwards from **where Daisy itself is installed**, so a plugin installed in the same place as Daisy is found:

- Daisy installed with `npm install -g @daisy-ai/daisy`: install the plugin with `npm install -g` as well, for example

  ```sh
  npm install -g @acme/daisy-foo          # or daisy-plugin-foo, or the plugin's .tgz
  ```

  Both end up in npm's global directory (`npm root -g`), where Daisy finds the plugin. If you changed npm's global directory (`npm config set prefix ~/.local`) or installed Daisy with `--prefix`, use the same one for the plugin. Daisy updating itself (`npm install -g` of a newer version) leaves the plugins next to it alone.
- Running from a source checkout (`npm start`): run `npm install --no-save <plugin>` at the checkout's root (the next `npm ci` removes it, so install it again after that).

Daisy does **not** look for plugins anywhere else: not in `NODE_PATH` (the ES modules Daisy uses do not read it), not in the data directory, not in the current directory. Only packages in those places count: one Node finds further up (such as `C:\node_modules`, which any account can create on Windows), or one that resolves outside its package folder (such as through a tsconfig `paths` mapping in a source checkout), is not loaded.

## Enabling

First install the plugin's package next to Daisy (see "Installing" above). Then pick one:

- `plugins` in `runner.json` in the data directory (also applies when Daisy starts at boot; recommended):

  ```json
  { "plugins": { "my-plugin": { "some-option": "value" }, "@acme/daisy-foo": true, "npm:daisy-plugin-foo": true } }
  ```

  `plugins` can be a list of names (`["my-plugin", "@acme/daisy-foo"]`) or an object whose keys are plugin names and whose values are the options handed to that plugin; `true` enables it without options, `false` does not enable it. **When `plugins` is present it wins** (an empty one enables nothing), and the environment variable is ignored.

- The environment variable `DAISY_PLUGINS`, comma-separated plugin names, for example `DAISY_PLUGINS=my-plugin,@acme/daisy-foo`. Plugins enabled this way get no options. A Daisy started at boot does not receive your terminal's environment variables (see [Environment variables](environment.md)), so for lasting use write it in `runner.json`.

After a change, restart Daisy (`daisy stop && daisy start`). If an enabled plugin is not installed, Daisy does not start and says "The plugin “<plugin name>” is not installed (<package name> is not found)".

## Only the owner decides which plugins load

A plugin's code runs as the system account that runs Daisy, so:

- The plugin list has exactly two sources: `runner.json` in the data directory and the environment variable `DAISY_PLUGINS` that you set yourself. No endpoint, command or web setting in Daisy writes this list; a paired device cannot change it.
- **A known limit**: in a session that acts, the AI runs commands as your account, so it can edit `runner.json` or run `npm install -g` — just as it can change any file of your account. Daisy does not stop that; only ask-only side branches and resident sessions are kept out of the data directory. Let the AI act only in work you trust, and watch what it changes.
- When `runner.json` belongs to another account, another account can change it (group or others have write permission), or it cannot be read, **Daisy does not start** and says why: this file decides which code Daisy runs and where (plugins, updates, the AI's identity folders, workspaces). Daisy does not quietly tighten its permissions either (that would make whatever someone else wrote in it yours), and setting the update source is refused. Look at what is in it, make sure it is yours, `chmod go-w` it, then start. On Windows this check is not made (the data directory's permissions are the system's access control).
- When `runner.json` is not valid JSON, Daisy does not start and says at which line and column; fix it and start again.
- Enable only packages you trust, and as with any global npm package, check the name for typos.

## Writing a plugin

The smallest example is `examples/plugin-hello/` in the repository: it adds a few environment variables to each session's harness processes, and explains how to try it in a source checkout without installing it. The hooks and types a plugin can use are defined in `packages/daisy/src/plugins/`.
