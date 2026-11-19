# Pairing a phone or another computer's browser

[中文](../zh-CN/pairing.md)

Pairing lets another device open Daisy's web page as the owner: see sessions, send messages, answer the AI's tool permission requests and questions. On a phone you use the browser; no app to install.

## First, make this Daisy reachable from the device

Pairing codes only work on the outside face. Pick one (both need the PIN):

- **Outside face, direct**: when the device and Daisy are on the same private or overlay network.

  ```sh
  daisy access external on --host <this machine's overlay or private network address>
  ```

  TLS (with a self-signed certificate) is the default. Plain HTTP (`--tls false`) is only allowed on loopback, private or overlay network addresses.

- **Through a relay**: when the device is on another network. See [Relay](relay.md).

When both are on, the pairing link uses the direct address by default; the relay link is given separately.

## Make a pairing code

```sh
daisy pair --name "My phone"
```

Or, in the web page, click "Make a pairing code…" under Settings › "Devices" (needs the PIN). The page shows the code in large type, a link and a QR code.

- The code has ten characters (`XXXXX-XXXXX`), is valid for 10 minutes and works once.
- The link is `<outside face address>/#pair=<code>`. The code sits after `#`, so it never reaches the request line or the logs.
- At most 5 unused codes exist at a time; making another pushes out the oldest.
- Setting, changing or resetting the PIN cancels every unused code.

## Enter it on the device

Scan the QR code with the phone, or open the link in the device's browser; the page fills in the code. You can also open the outside face address, choose "Connect this device with a pairing code", and type the code and a device name.

When the outside face uses a self-signed certificate, the device's browser warns that the certificate is not trusted. Check the certificate before going on:

1. On the machine where Daisy runs, run `daisy access show` and note `external.fingerprint`, the SHA-256 fingerprint of the outside face's certificate (64 hexadecimal digits separated by colons, like `AB:CD:…`). `daisy pair`, `daisy status` and the web page's Settings › "Faces and passcode" show the same one.
2. In the device's browser, open the certificate details (Chrome: the icon left of the address bar › Certificate) and find the **SHA-256** fingerprint.
3. Go on only if the two match; if they do not, stop and do not click through the warning.

Daisy makes a new certificate only when the outside face is turned on for the first time, when the listen address changes to one the certificate does not cover, or when it is close to expiry (397 days); each time it writes to the log and the audit (`access.tls.generate`, with the reason and the new fingerprint). If the certificate files exist but cannot be used (for example the wrong owner, or a key that does not match the certificate), the outside face does not start and says why; Daisy never quietly replaces the certificate. After a new certificate, paired devices and callers that remembered the old one see that the certificate changed: check it again as above.

After pairing, the device holds a device credential, stored in that browser. Opening the same address later lets it straight in.

- The device credential expires after 30 days without use.
- Each request uses a device session, renewed every 12 hours; the device renews it by itself.
- "Log out" on the device unpairs that device.

## Pairing through a relay

- You can pair with only a relay and no direct address, but `daisy pair` then warns plainly: **the relay's operator could in theory get the pairing code and the device credential** (they can get a certificate for your relay address and decrypt in the middle, see [Relay › Using a relay someone else runs](relay.md#3-using-a-relay-someone-else-runs)). A relay you run yourself does not have this problem.
- While the relay only has a self-signed certificate (no ACME certificate yet), you get the code but no link. Type the code on the device by hand, and **do not click through the certificate warning**.

## Manage devices

```sh
daisy device list                 # paired devices (records only, no credentials)
daisy device revoke <device id>   # revoke one; needs the PIN
```

Settings › "Devices" in the web page does the same. Revoking takes effect at once: its sessions become invalid, open live channels drop immediately, and requests in flight get 401. Changes that started before the revoke are not undone.

Resetting the PIN invalidates every paired device.

## Guessing protection

- 5 wrong codes from one source pause that source for 15 minutes; other sources are unaffected.
- Once a code has been issued, 20 wrong entries across all sources cancel that code.
- A wrong, expired or used code gets the same answer; it does not say which.
- Anyone who can reach the outside face can enter wrong codes on purpose to stop you pairing new devices for a while. That is an inconvenience only; it lets nobody in, and it shows in the audit log.
