# Relay: run your own and connect Daisy to it

[中文](../zh-CN/relay.md)

A Daisy behind a router or firewall cannot be reached from outside. A relay (`daisy-relay`) gives it a fixed public address: Daisy connects out to the relay and keeps the connection open; others reach it at `https://<subdomain>.<relay domain>`, and the relay hands the connection through unchanged.

The relay does very little:

- It looks only at the domain name in the TLS handshake (SNI) to decide where to send a connection, and **does not terminate TLS**: the content is encrypted end to end between the caller and Daisy.
- It stores no requests. When the target is offline, it refuses during the handshake.
- It does not decide who may call whom (that is each Daisy's job), and does no NAT traversal.

If you would rather connect directly, set up your own network (for example a VPN or an overlay network) and turn on the outside face; then you need no relay.

## 1. Run your own relay

### What you need

- A machine that can take public port **443**, with Node.js 24 or later.
- A domain, for example `relay.example`. In DNS, both `relay.example` and the wildcard `*.relay.example` point at the machine.
- A certificate and private key (PEM) that cover **only `relay.example` itself**, for example from certbot. **Do not use a wildcard certificate for `*.relay.example`**: a relay holding one could decrypt Daisy traffic, and `daisy-relay --check` refuses it.

### Get the program

`@daisy-ai/relay` is a separate package and is not on npm yet. Pack it in a source checkout:

```sh
npm ci
npm pack -w @daisy-ai/relay          # produces daisy-ai-relay-<version>.tgz
```

Copy the package to the relay machine and install it:

```sh
npm install -g ./daisy-ai-relay-<version>.tgz
daisy-relay --version
```

Its code is a single bundled file with only two dependencies, `ws` and `jose`; it does not depend on Daisy itself.

### Configure

The configuration is a JSON file, for example `/etc/daisy-relay/relay.json`:

```json
{
  "domain": "relay.example",
  "listen": { "host": "0.0.0.0", "port": 443 },
  "tls": {
    "cert": "/etc/daisy-relay/relay.example.fullchain.pem",
    "key": "/etc/daisy-relay/relay.example.key.pem"
  },
  "logLevel": "info",
  "limits": {
    "maxDaisys": 1000,
    "maxStreamsPerDaisy": 64,
    "bytesPerSecPerDaisy": 16777216
  }
}
```

| Field | Meaning | Default |
| --- | --- | --- |
| `domain` | The relay's own domain, lower case, at least two labels | Required |
| `listen.host`, `listen.port` | Listen address and port | `0.0.0.0`, `443` |
| `tls.cert`, `tls.key` | Certificate and private key files for the relay's own domain | Required |
| `logLevel` | `debug`, `info`, `warn`, `error` | `info` |
| `limits` | Limits; write only the ones you change. Names and defaults are in `DEFAULT_LIMITS` in `packages/relay/src/config.ts` and section 8 of the protocol description | See below |
| `allowIdentities` | Let only these Daisys register: a list of identity ids (52 characters; spaces and case do not matter). Leave it out to allow anyone | No limit |

Environment variables override the file: `DAISY_RELAY_CONFIG` (path of the configuration file), `DAISY_RELAY_DOMAIN`, `DAISY_RELAY_HOST`, `DAISY_RELAY_PORT`, `DAISY_RELAY_TLS_CERT`, `DAISY_RELAY_TLS_KEY`, `DAISY_RELAY_LOG_LEVEL`. Limits can only be set in the file.

Some default limits (so one Daisy cannot bring the whole relay down):

| Limit | Default |
| --- | --- |
| Daisys online at once | 1000; 128 from one source address |
| Connections (streams) per Daisy at once | 64, of which 16 waiting to be claimed |
| Bandwidth per Daisy (both directions together) | 16 MiB/s |
| Per stream | At most 256 MiB, closed after 5 minutes idle, at most 1 hour |
| Public port | 10000 connections in total; 512 per source, 20 new per second |

A "source" is one IPv4 address or one IPv6 /64.

### Run

```sh
daisy-relay --config /etc/daisy-relay/relay.json --check   # check the configuration and certificate
daisy-relay --config /etc/daisy-relay/relay.json           # run
```

- Binding port 443 on Linux needs a privilege. Do not run it as root: use systemd's `AmbientCapabilities=CAP_NET_BIND_SERVICE`, or forward the port in front of it.
- `SIGHUP` re-reads the certificate files (send one after renewing). `SIGTERM` and `SIGINT` stop it; connected Daisys get "relay restarting" and reconnect by themselves.
- Logs are one JSON object per line on standard output. They record only the event, subdomain, address, stream number, byte counts, duration and reason; never content, tokens or claim credentials, and never domains the relay does not serve.

An example systemd unit (adjust the paths):

```ini
# /etc/systemd/system/daisy-relay.service
[Unit]
Description=Daisy Relay
After=network-online.target
Wants=network-online.target

[Service]
User=daisy-relay
ExecStart=/usr/bin/env daisy-relay --config /etc/daisy-relay/relay.json
ExecReload=/bin/kill -HUP $MAINPID
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

The `daisy-relay` user must be able to read the certificate files.

### Check that it works

```sh
curl https://relay.example/v1/info                    # protocol version
curl https://relay.example/v1/presence/<subdomain>    # whether a Daisy is online
```

## 2. Connect Daisy to the relay

On the Daisy machine:

```sh
daisy relay set relay.example        # needs the PIN; if the port is not 443, write https://relay.example:8443
daisy relay show                     # which relay, connected or not, public address, certificate
daisy status                         # gains a "Relay" line
```

- Daisy connects out and stays connected; when the connection drops it reconnects by itself, waiting longer each time, at most 30 seconds. If the relay refuses this Daisy (for example when its operator lets only certain Daisys register with `allowIdentities`), Daisy stops trying and `daisy relay show` says `refused`.
- The public address is fixed: `https://<first 32 characters of the identity id>.relay.example`. It is derived from this Daisy's identity key, so it stays the same across reconnects, restarts, and turning the same relay off and on again.
- With a relay chosen, the identity card you export (`daisy contact export`) carries this address, and turning the relay off removes it; agent cards fetched through the relay show this address too.
- You do not need to turn on the outside face first. Choosing a relay turns the outside face "on through the relay", and the web passcode turns on automatically.

Turn it off:

```sh
daisy relay off                      # also needs the PIN
```

Connections through the relay drop at once, and the cards no longer carry the relay address. The keys and certificate are kept; choosing the same relay again gives the same address.

### Certificates (ACME)

The relay does not terminate TLS, so Daisy needs a certificate for its own relay address:

- As soon as you choose a relay, Daisy makes a **self-signed** certificate that works straight away between Daisys (Daisys check each other in another way too, see below).
- At the same time it asks a certificate authority for a certificate in the background (ACME TLS-ALPN-01 challenge, passed through the relay). The default is Let's Encrypt. Once issued, it is put in place and renewed automatically before it expires.
- If it cannot get one, it keeps the current certificate and tries again after 1 hour, doubling the wait each time, up to 24 hours. `daisy relay show` and `daisy status` give the reason.
- While the certificate is self-signed, **only Daisy-to-Daisy traffic works through the relay**: third-party A2A clients and browsers report an untrusted certificate, and pairing and `daisy open --external` give no link through the relay (see [Pairing](pairing.md)).
- Turning ACME on means you accept that certificate authority's subscriber agreement.
- To not ask for one: `daisy relay set relay.example --acme false` uses only the self-signed certificate.
- To use another certificate authority that supports TLS-ALPN-01: `--acme-directory https://<its ACME directory URL>`.
- For reserved domains — `.test`, `.example`, `.invalid`, `.localhost`, `.local`, `.internal`, `home.arpa` — Daisy never asks, whatever authority is configured.

### What can come in through the relay

Requests that come in through the relay reach only the outside face, never the local face:

- Only outside-face credentials are recognized: outside-face web sessions, paired devices, tokens signed by other people's Daisys, and A2A tokens you issued. The local command-line credential, AI work credentials and local web sessions are not recognized through the relay.
- Through the relay there is **never a terminal, command execution or directory browsing**, whatever the outside face's own switches say.
- Calling your agents still goes through call authorization (audience, allowlist, cards waiting for approval).

Resetting the PIN turns the relay off together with the outside face.

## 3. Using a relay someone else runs

The relay cannot read the content, but its operator controls the domain's DNS and port 443, so **they can get another trusted certificate for your subdomain and decrypt in the middle**.

- **Daisy-to-Daisy calls are safe from this.** Before sending a token, the calling Daisy fetches a "TLS binding statement" signed with your Daisy's identity private key and checks that this connection's certificate is listed in it; only then does it send the request. The relay cannot forge that statement. If it does not match, the caller disconnects, sends nothing, and writes an audit entry. The standalone `daisy-mcp` does the same check.
- **Third-party A2A clients and browsers trust only certificate authorities.** When they call you through someone else's relay, or you open the web page or pair a phone through someone else's relay, you have to trust the operator not to do this. `daisy open --external` and `daisy pair` print this warning when only a relay is available.
- To avoid it: run your own relay, or use the outside face directly (on your own network).

What the operator can see: the target subdomain, the caller's address, each connection's byte counts and duration, who is online. What they cannot see: requests, answers, tokens, paths, HTTP headers.

The protocol details are in `packages/relay/PROTOCOL.md`.
