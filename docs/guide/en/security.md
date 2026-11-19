# Security model

[中文](../zh-CN/security.md)

This page explains how Daisy protects what belongs to its owner, and what it cannot protect. Please do read the last section, "Known limits".

## Basic facts

- **One Daisy, one owner.** Daisy runs under the owner's system account; the owner is that account. There are no multiple accounts and no administrators. To let someone else use Daisy, have them install their own.
- **No central server.** Sessions, settings and keys live in the data directory on the owner's machine, readable only by the owner (0700 / 0600; on Windows, only the owner, SYSTEM and administrators). The Daisy process creates files with mask 077, and on every start it tightens entries in the data directory that the group or other accounts have rights to (without following symbolic links, only entries that belong to you); `daisy doctor` reports any that remain. Programs the AI starts (harnesses, commands, terminals) keep the mask Daisy was started with, because they write files in your own directories.
- **The AI runs under the owner's account too.** Processes started by a harness can read everything the owner can read. Much of the design below starts from this, and it is also the biggest limit.
- **Safety comes first.** Nobody you have not exchanged cards with gets in; no grant ever includes conversation history, working directories or credentials; decisions that let someone in accept only the owner in person plus the PIN.
- **Interrupted work is never replayed.** A turn interrupted by stop, restart or update is marked interrupted and does not run again by itself.

## Two faces

| | Local face | Outside face |
| --- | --- | --- |
| Listens on | Only `127.0.0.1`, always on | Off by default; turning it on needs the PIN; it can also be on through a relay only |
| For | The owner on this machine: web page, command line, the AI's work credentials | Other machines: the owner's web page, paired devices, other Daisys, third-party A2A clients |
| Encryption | Never leaves this machine | TLS by default (self-signed certificate; go on only when the SHA-256 in the browser matches the one `daisy access show` prints); plain HTTP only on loopback, private or overlay network addresses |
| Terminal, running commands, browsing directories | Available | Off by default, turning on needs the PIN; always off through a relay |

Each connection belongs to the face whose listener accepted it. The checks look only at that mark, never at the source address or request headers.

Every request passes one central check, in this order:

1. `Host` must be this face's own name (against DNS rebinding).
2. An `/api` request with `Origin` must come from this face's own origin, and `Sec-Fetch-Site` may only be `same-origin` or `none` (against cross-site requests). The only exception is external UI origins the owner put on the allowlist, and only on the outside face.
3. Any `/api` route not in the API definition table is refused.
4. Recognize the credential. If none is recognized, 401, without saying which part was wrong.
5. Authorize by the definition: outside-face switches, channel, the AI limited to its own session, scope, PIN.

## Who holds which credential

| Who | Credential | Valid | On which face |
| --- | --- | --- | --- |
| Command line | `keys/cli-credential` (0600) | Always | Local face only |
| The owner's web page | A web session (exchanged for a one-time code from `daisy open`; the code is valid 10 minutes, once) | 30 days on the local face, 7 days on the outside face | Only the face that issued it |
| A paired device | A device credential, used only to get 12-hour device sessions | Expires after 30 days without use; can be revoked on its own | Only the face it paired on |
| The AI | One work credential (a signed token) per turn | At most 1 hour; invalid as soon as the turn ends | Local face only |
| Another Daisy | A token freshly signed each time with that Daisy's identity private key | Usable once | The outside face's A2A entry |
| A third-party A2A client | A token signed by `daisy token issue` | 7 days by default, at most 90 days | The outside face's A2A entry |
| An external issuer | Tokens signed by an issuer the owner configured | At most 24 hours when issued to the owner | Both faces |

The server stores only the SHA-256 of each credential, never the credential itself (except the command-line credential file `keys/cli-credential`: the command line has to read it, so it holds the credential itself, readable only by your account). The AI's work credential can read only a few endpoints of its own session; it cannot answer tool permission requests or questions, and cannot do anything that needs the PIN.

**Web passcode.** When this machine has only your account and the outside face is off, a browser on this machine can open the web page without a passcode (Daisy checks that the process at the other end of the connection belongs to your account). When the machine has other accounts, or the outside face is on, the passcode turns on automatically: you always go through the one-time link from `daisy open`. `daisy access passcode on|off|auto` changes this (needs the PIN).

## PIN

The PIN guards every kind of action that lets someone else in:

| Kind | Examples |
| --- | --- |
| Entry | Turning on the outside face, one-time codes for the outside face, the passcode setting of the local web page |
| Relay | Choosing or turning off a relay |
| Devices | Pairing a new device, revoking a device |
| Contacts | Importing or removing cards, managing the allowlist |
| Calls | Approving or rejecting someone's call request, revoking grants, changing the audience |
| Agents | Making a session public, allowing "act" or not, creating and changing resident agents |
| Tokens | Issuing and revoking tokens for third-party A2A clients; configuring an external issuer |
| External UIs | Changing the allowed external UI origins |
| Updates | Setting the update source (it decides what code runs later) |

- At least 6 characters; digits only is fine. Only a verifier (scrypt) is stored.
- A correct PIN gives a short-lived grant (5 minutes) bound to the credential that sent the request. On the command line the grant is **used up after one use**: every command-line process (including `daisy` run by the AI through a shell) shares one holder, so the AI cannot borrow the PIN you just typed.
- Reading these settings in the web page or on a device needs no PIN; reading them on the local command line does (the command-line credential may be in use by your AI).
- 5 wrong entries in a row lock it for 15 minutes, 5 more for 1 hour, then the lock doubles, up to 24 hours. The lock is stored in the database and survives a restart.
- **Until a PIN is set, Daisy starts no AI turn.** The web page and paired devices always show when, and through which entry, the PIN was last set or reset.

**Resetting the PIN** (`daisy pin reset --confirm`, only on the local command line) takes back everything that was let in: it turns off the outside face and invalidates its sessions and codes, turns off the relay, and revokes every grant, every imported card, every paired device and every third-party token, forgets the tokens fetched for the AI, clears the allowed external UI origins, and drops trust in external issuers. After that the PIN can only be set again on the local command line. Public agents are not made private again and resident agents are not paused, but with cards, grants and tokens gone nobody can call in.

## How others call you

1. **Exchange cards**: both sides exchange identity cards (`daisy contact export` / `daisy contact import`). A card is signed with the identity private key, but that only proves "this content came from whoever holds this key". Before importing, check the id with the other person face to face or by phone (at least the first 16 characters, `--expect-id`). Exchanging cards by itself grants no right to call.
2. **Kind of agent**: a session is a **private** agent by default; nobody can call it. You can make a session **public** (others "ask" or "act" directly in that session, so conversations mix, see below), or create a **resident** agent (each visiting conversation gets its own session, they cannot see each other, and permissions follow your configuration).
3. **Audience**: open to everyone whose card you imported, or only to the people you list.
4. **First call**: for an agent open to everyone, the first call shows you a card: always allow, allow once, reject. After a reject, the same person calling the same agent within 10 minutes is refused outright. A card nobody handles expires after 7 days. People on the allowlist get no card.
5. **Ask and act**: by default others can only "ask" (a read-only answer); only a request marked "act" does things, and you can turn "act" off. Read-only strength and how it runs: [Harnesses › Ask and act](harnesses.md#ask-and-act). Tasks from outside never use the permission mode that skips every confirmation.
6. **Marked by source when handed to the AI**: everything someone else writes reaches the AI as outside material, marked with who sent it and whether it is an ask or an act, and stated plainly not to be the owner's instruction. Answers from the other side's AI are also only reference material to your AI.

Rules for grants: one grant per agent per person; one-way; not transitive; covering calls only, never conversation history, working directories or credentials; revocable at any time (`daisy grant revoke`), which stops that person's calls in progress.

## Audit and redaction

- Every change that passed the checks, every refused request and every AI tool call writes an audit entry: who, through which face and channel, which endpoint, the result, the reason, the trace id. Query strings, request bodies, credentials, the PIN and passcodes are never recorded.
- To look: `daisy audit list` (audit entries), `daisy audit logs` (recent log lines). Reading the audit is itself recorded. The AI cannot read either.
- Redaction: every secret Daisy makes or receives (credentials of every kind, PIN grants, harness API keys, login authorization codes) is registered the moment it appears; wherever it shows up in logs, error answers or the audit it is replaced with `[redacted]`. Strings shaped like tokens, keys or passcodes are also masked. Daisy errs on the side of masking too much.
- Logs go only to `logs/daisy.log` (or journald); the last 1000 lines stay in memory for `daisy audit logs`.

## What a relay operator can see

- Can see: the target's subdomain, the caller's address, each connection's byte counts and duration, which Daisys are online.
- Cannot see: requests, answers, tokens, paths, HTTP headers.
- A malicious operator can get a trusted certificate for your subdomain and decrypt in the middle. Daisy-to-Daisy calls check the TLS binding statement and are protected; third-party clients and browsers are not. Details: [Relay › Using a relay someone else runs](relay.md#3-using-a-relay-someone-else-runs).

## Known limits

These are not bugs. They are facts known at design time, written down so you know them too.

1. **The AI can read everything the owner can read.** That includes the database, the PIN verifier, the identity private key and the command-line credential. An AI set on getting around Daisy can edit the database or code directly, guess the PIN offline (shorter is easier), or sign tokens itself with the private key. The PIN only blocks the path through the API. On the called side, call authorization, revocation and concurrency limits still apply.
2. **The narrow permissions given to the AI are only a convention on this machine.** The AI work credential's narrow scope and "tool permission requests are answered only in the web page" cannot stop an AI that does not play by the rules. It can also edit configuration in the data directory (for example the external issuer or the public-key cache in `config.json`), which takes effect after a restart without the PIN. So: give automatic permissions only to harnesses and models you trust, and use a longer PIN.
3. **The AI can enter wrong PINs on purpose** and lock you out of "let someone in" actions for a while. That is an inconvenience only; it lets nobody in, and the lock is shown prominently in the web page.
4. **A public agent mixes conversations.** Visitors can read that session's context, and answers may reveal your own work; an "act" request does things on your main line in automatic mode, and the question and answer stay in the main line. To keep them apart, use a resident agent.
5. **A resident agent's isolation has a gap.** Visiting conversations are separate sessions but share the agent's workspace: a file written to the workspace by one conversation can be read by another. When Bash is allowed, the shell can read any file the owner can read; keeping other conversations' records out of reach then relies only on the harness's deny-read rules and the judgment of automatic mode. When serving outsiders, limit its tools to read-only (Read, Grep, Glob), or give it its own workspace and identity. The web page warns about this.
6. **When the machine is off, its AIs cannot be reached and their history cannot be viewed.** The relay stores nothing.
7. **Harnesses connected through ACP can do less than native ones**; "ask" on Kimi Code and OpenCode is only weak read-only. See [Harnesses](harnesses.md).
8. **macOS and Windows have no enforced read-only mode from Daisy itself**, and on Windows Codex's "ask" is only weak read-only.
9. **A third-party client calling you through someone else's relay has to trust the relay operator.** When you pair a device through a relay-only link, the operator could in theory get the pairing code and the device credential.
10. **Revoking does not roll back.** When you revoke a device, take back a grant or turn off "act", changes that have already started are not undone; a running turn finishes or is stopped, and its side effects are not rolled back.
11. **After you replace the relay TLS key by hand, the old TLS binding statement stays valid until it expires (at most one day).** Normal renewal keeps the key, so it is unaffected.

## Reporting security issues

If you find an exploitable problem, please do not post details in a public issue, discussion or pull request. Use GitHub's private vulnerability reporting: on the repository's **Security** page click **Report a vulnerability** (<https://github.com/QuantGrail/daisy/security/advisories/new>); only you and the maintainers can see it. What to include, scope and supported versions: [SECURITY.md](../../../SECURITY.md) in the repository root.
