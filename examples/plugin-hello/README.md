# A minimal Daisy plugin

[中文](README.zh-CN.md)

A Daisy plugin is a separate npm package exporting two halves (its name can be any valid npm package name, see "Plugin names" in the guide: the short name `example-hello` means `@daisy-ai/example-hello`; a third-party package is written by its full name, such as `@acme/daisy-foo` or `npm:daisy-plugin-foo`):

- `./server` (control plane): `createServerPlugin(host)`, which can provide three hooks: "inject an organization prompt when a session starts" (`sessionPrompt`), "subscribe to outside events and wake sessions" (`events`), and "its own notification kinds" (`notificationKinds`);
- `./runner` (runner): `createRunnerPlugin(host)`, which can add environment variables to a session's harness processes (`sessionEnv`), declare its own secret paths (hidden from read-only side branches), and do some work in every loop of the runner (`tick`).

A plugin may import Daisy's pieces only from `@daisy-ai/daisy/plugin` (types, `log`, `OWNER_ID` and a few other helpers); the core never imports plugins. Plugins are off by default: a plugin's code is loaded only after it is enabled by name.

This example (`example-hello`):

- `src/runner.ts`: adds `HELLO_SESSION` (the session id), `HELLO_AGENT` (which harness) and `HELLO_GREETING` (the option `greeting`) to every session's harness processes;
- `src/server.ts`: logs one line when loaded and registers no hooks.

## Try it (in a checkout of this repository)

```sh
npm ci
ln -s ../../examples/plugin-hello node_modules/@daisy-ai/example-hello   # so Daisy can import it
DAISY_PLUGINS=example-hello npm start
```

In a session, ask the AI to run `env | grep HELLO_` and you see the three variables. Options go in `runner.json` in the data directory (when `plugins` is present it wins, and `DAISY_PLUGINS` is ignored):

```json
{ "plugins": { "example-hello": { "greeting": "Hello" } } }
```

If an enabled plugin is not installed, Daisy does not start and says "The plugin “example-hello” is not installed (@daisy-ai/example-hello is not found)".

This example's package is under `@daisy-ai`, so it is enabled by its short name. Your own plugin uses your own package name (for example `@acme/daisy-hello`): the `name` that `createServerPlugin` / `createRunnerPlugin` return is that package name, and so is the name you enable it by (`DAISY_PLUGINS=@acme/daisy-hello`); once it is published, users install it next to Daisy with `npm install -g @acme/daisy-hello`.

## Outside callbacks

The `host.scheduler` passed to `events.subscribe(host)` can wake a session: `host.scheduler.wake(sessionId, scheduleId, label, text, { budget })`. When the wake means "an outside system's result came back" (an outside callback), make `scheduleId` with `callbackScheduleId(kind, itemId, { human })` (imported from `@daisy-ai/daisy/plugin`); for example `callbackScheduleId("build", "B-42")` gives `callback:build:B-42`:

- Kind: starts with a lower-case letter, only lower-case letters, digits, `_` and `-`, at most 32 characters; item id: starts with a letter or digit, only letters, digits, `_`, `.` and `-`, at most 64 characters. Anything else throws. What kinds and item ids look like is up to the plugin; Daisy neither knows nor checks them.
- `human: true` (giving `callback-human:…`) means this is a person's decision: the turn it causes does not count toward a resident session's daily limit (whether this wake itself is limited by the daily count is decided by the `budget` option of `wake`).
- Daisy relies only on this format to decide how outside callbacks are handled: a callback stopped before it ran is not lost but delivered with the next turn; it can be merged into the owner's own message and delivered with it; and while the same item is still waiting, a new result is merged into that turn.

## Notification kinds

If the plugin's own events should have a switch in the notification settings, declare `notificationKinds` (type `NotificationKindDecl`, imported from `@daisy-ai/daisy/plugin`) in the object `createServerPlugin` returns:

```ts
return {
  name: "example-hello",
  notificationKinds: [
    {
      id: "hello_ping",
      label: { en: "Greeting", "zh-CN": "问候" },
      hint: { en: "The example plugin's greeting", "zh-CN": "例子插件的问候" },
      default: true,
    },
  ],
};
```

- `id`: starts with a lower-case letter, only lower-case letters, digits and `_`, at most 32 characters; it must not clash with Daisy's own kinds (`approval`, `task`, `ai_private_message`, `ai_failed`, `retract`) or another plugin's, otherwise Daisy does not start and says which plugin. `label` is the name people see (1–40 characters), `hint` is an explanation (optional, at most 200 characters), and `default` is whether it is on by default on both devices (on when omitted).
- `label` and `hint` are given per language, keyed by language tag (`{ en: "…", "zh-CN": "…" }`, type `PluginText`): each reader sees their display language's words (the closest tag, so `zh-Hans` gets `zh-CN`), else the English ones, else the first. Give at least English; a plain string still works and is shown as written in every language.
- Declared kinds come after Daisy's own, in `kinds` and `matrix` of `GET /api/notification-preferences` (`daisy notify show`); they can be changed with `daisy notify set`, and the push service's check (`POST …/check`) follows them.
- While the plugin is not installed or not enabled, the kind appears nowhere and cannot be changed; switches people saved for it earlier are kept and have no effect, and apply again once the plugin is enabled again.

The full interface: `packages/daisy/src/plugins/server.ts`, `packages/daisy/src/plugins/runner.ts`, `packages/daisy/src/plugins/api.ts`; the outside callback format is in `packages/daisy/src/schedule/callback-jobs.ts`. More in the guide: [Plugins](../../docs/guide/en/plugins.md).

`tests/examples.test.ts` loads and checks this example through Daisy's own plugin loader (importing it by name).
