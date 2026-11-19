# First use

[中文](../zh-CN/first-use.md)

Install `daisy` first ([Install](install.md)). After the five steps below you have your first conversation. Every command has `--help`.

> The web page, the command line and the AI's prompts speak English or Chinese (Simplified). Daisy follows your system's language; to switch, see [Language](install.md#language).

## 1. Start

```sh
daisy start
```

Daisy runs in the background and prints the local face's address (`http://127.0.0.1:<port>`), its process id, the data directory and the log. If it is already running, it just says so.

On macOS, we recommend running `daisy autostart on` before `daisy start` (why: [Install › Start at boot](install.md#start-at-boot)).

## 2. Set a PIN

```sh
daisy pin set
```

- At least 6 characters; digits only is fine. It is not shown while you type, and you type it twice.
- **Until a PIN is set, Daisy starts no AI turn.** `daisy status` and the web page keep reminding you.
- The PIN guards everything that lets someone else in: opening the web page from another machine, choosing a relay, pairing a device, accepting contact cards, making an agent public, issuing tokens. An AI cannot type it for you.
- Daisy keeps only a verifier of the PIN. Five wrong entries in a row lock it for 15 minutes; later locks grow longer, up to 24 hours.
- Forgot it? On this machine run `daisy pin reset --confirm`, then `daisy pin set`. A reset takes back everything that was let in (the outside face, contacts, grants, paired devices, an external token issuer); see the [security model](security.md).

## 3. Open the local web page

```sh
daisy open
```

It asks Daisy for a one-time code (valid 10 minutes, usable once) and opens a link carrying it in your browser. Without a desktop it prints the link.

**Logged in to a server over SSH?** The link only opens on that machine. Make a tunnel from your own computer, then open the printed link there:

```sh
ssh -N -L <port>:127.0.0.1:<port> <server>
```

Or turn on the outside face and open it from another machine directly (needs the PIN):

```sh
daisy access external on --host <this machine's private or overlay network address>
daisy open --external
```

The outside face uses TLS with a self-signed certificate by default, so the browser warns the first time: compare the certificate's SHA-256 fingerprint in the browser with the one `daisy access show` prints (`external.fingerprint`) and go on only when they match. The terminal, running commands and browsing directories are off on the outside face by default.

## 4. Log in to a harness

Daisy does not rebuild harnesses; it drives the official command-line tools you installed. On first start Daisy already made one "host login" identity per harness (shown as `<harness> · host login`) and a workspace for your home directory (shown as "Home folder"). So you have two ways:

- **Reuse the login this machine already has.** If you are logged in to `claude`, `codex` or `kimi` in a terminal, there is nothing to do: pick the `<harness> · host login` identity when you create a session.
- **Give Daisy a login of its own.** In the web page, open Settings › "Harness sign-in (profiles)", add one and follow the steps. It lives in its own directory and does not touch the machine's existing login. Claude with an API key is added here too.

The same login works in a terminal:

```sh
daisy workspace catalog                              # node ids (nodes[].id) and existing identities
daisy profile create-managed --agent codex --node-id <node id> --label "My Codex"
daisy login start <identity id>                      # the answer has a login flow id
daisy login show <flow id>                           # the authorization URL; open it in any browser
daisy login input <flow id>                          # paste a code if the page gives one (not echoed)
daisy login show <flow id>                           # done when status is complete
```

`daisy doctor` shows which harnesses are installed and logged in. What each harness can do: [harnesses](harnesses.md).

## 5. First conversation

In the web page, create a new session, pick an identity and a workspace, and send a message.

**The first turn says the model is not supported** (for example `The '…' model is not supported when using Codex with a ChatGPT account`): the login is fine; this account cannot use that model. Tap the model shown at the bottom of the conversation, press "Read the native model list", pick a model from the list and send again (this changes only this session). When the host's Codex config names a model the account cannot use, Daisy starts on the list's default model instead and says so in the conversation.

Or from a terminal:

```sh
daisy workspace catalog                       # workspace ids and identity ids
daisy session create --agent claude --workspace-id <workspace id> --profile-id <identity id> --title "First session"
daisy session send <session id> "Hello, tell me about this directory"
daisy session show <session id>
```

When the AI wants to use a tool it may ask for permission or ask you a question. **You answer these cards only in the web page and on paired devices**; the command line cannot. `daisy watch` shows in a terminal when a card is waiting.

To add another workspace: `daisy workspace add --node-id <node id> --label Project --path /absolute/path`, or add it in the web page's settings.

## Next

- Use it on a phone: [pairing](pairing.md)
- Let people or AIs on other networks call you: [relay](relay.md), [A2A and daisy-mcp](integrations.md)
- Every command: [command reference](commands.md)
- How Daisy keeps things safe, and known limits: [security model](security.md)
