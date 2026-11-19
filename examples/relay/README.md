# Running your own Daisy Relay (systemd)

[中文](README.zh-CN.md)

A relay gives a Daisy behind a router a fixed public address. It hands each connection to the right Daisy by the domain name in the TLS handshake (SNI), unchanged; **it never decrypts**. Protocol and design: `packages/relay/README.md`, `packages/relay/PROTOCOL.md`. More in the guide: [Relay](../../docs/guide/en/relay.md).

The files here:

- [`relay.json`](relay.json): the configuration. Replace `relay.example.com` with your domain; in `limits` write only what you change (every limit and default is in `packages/relay/src/config.ts`).
- [`daisy-relay.service`](daisy-relay.service): a systemd system service. It runs under a dedicated account with only the privilege to bind port 443; `SIGHUP` re-reads the certificate.

## 1. Domain and certificate

Two DNS records point at the machine (`203.0.113.10` in the example is a documentation address):

```
relay.example.com.     A  203.0.113.10
*.relay.example.com.   A  203.0.113.10
```

The certificate covers **only `relay.example.com` itself**. Do not use a wildcard certificate for `*.relay.example.com`: a relay holding one could decrypt Daisy traffic, and `daisy-relay --check` refuses it. Each Daisy gets its own certificate for `<subdomain>.relay.example.com` (ACME TLS-ALPN-01, passed through the relay unchanged).

```sh
sudo certbot certonly --standalone -d relay.example.com    # validates over port 80
```

## 2. Install

`@daisy-ai/relay` is not on npm yet: first pack it in a source checkout (`npm ci && npm pack -w @daisy-ai/relay`, which gives `daisy-ai-relay-<version>.tgz`), copy it to this machine and install it (after publication, use `sudo npm install -g @daisy-ai/relay`):

```sh
sudo npm install -g ./daisy-ai-relay-<version>.tgz   # needs Node.js 24 or later
command -v daisy-relay                        # must match the ExecStart path in daisy-relay.service
sudo useradd --system --no-create-home --shell /usr/sbin/nologin daisy-relay
sudo install -d -m 0750 -g daisy-relay /etc/daisy-relay
sudo install -m 0640 -g daisy-relay relay.json /etc/daisy-relay/relay.json
```

Put the certificate where the configuration says, with the private key readable only by the `daisy-relay` group. A certbot deploy hook updates them after each renewal and makes the relay re-read them (`/etc/letsencrypt/renewal-hooks/deploy/daisy-relay.sh`, executable):

```sh
#!/bin/sh
set -e
d=relay.example.com
case " $RENEWED_DOMAINS " in *" $d "*) ;; *) exit 0 ;; esac
install -m 0644 "$RENEWED_LINEAGE/fullchain.pem" /etc/daisy-relay/$d.fullchain.pem
install -m 0640 -g daisy-relay "$RENEWED_LINEAGE/privkey.pem" /etc/daisy-relay/$d.key.pem
systemctl reload daisy-relay 2>/dev/null || true
```

Run it by hand the first time: `sudo RENEWED_DOMAINS=relay.example.com RENEWED_LINEAGE=/etc/letsencrypt/live/relay.example.com sh /etc/letsencrypt/renewal-hooks/deploy/daisy-relay.sh`.

## 3. Start

```sh
sudo -u daisy-relay daisy-relay --config /etc/daisy-relay/relay.json --check   # config OK: relay.example.com, listening on 0.0.0.0:443
sudo cp daisy-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now daisy-relay
journalctl -u daisy-relay -f      # one JSON object per line: only event, subdomain, address, byte counts, reason; no content, no tokens
```

## 4. Let Daisy use it

On each Daisy (needs the PIN):

```sh
daisy relay set relay.example.com
daisy relay show          # connected, public address https://<subdomain>.relay.example.com, certificate
```

From then on the identity cards you export carry this address, and Daisys on other networks can call through the relay once they import your card.

`tests/examples.test.ts` checks this example with the relay's own configuration loader and `--check`.
