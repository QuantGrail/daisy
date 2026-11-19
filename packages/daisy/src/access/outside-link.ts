/**
 * P5-03b (ADR-142 §「经中转」, ADR-144 §「交给 P5-03」, ADR-100): the link a
 * pairing code or an outside one-time code is handed out with.
 *
 * - "Reachable from elsewhere" is `faces.externalReachable` (the listener,
 *   or a relay) — pairing works with only a relay.
 * - Review M-1 (the dispatcher's decision; the owner may revisit it): the
 *   relay operator controls DNS and SNI for the relay address, so it can
 *   answer an ACME challenge itself and get a trusted certificate for it —
 *   and read a `#pair=` code, the device credential in that origin's
 *   storage, a one-time passcode. So when the listener is on, its DIRECT
 *   link is the one given; the relay's is the alternative (`relay`), said
 *   plainly. With only a relay the relay's link is given, said plainly.
 * - Review L-1: a relay with only a self-signed certificate gets no link at
 *   all (no QR that teaches clicking through a warning): the code, typed
 *   by hand, and "do not click through the certificate warning".
 * - What a phone's browser makes of the certificate (review L-4):
 *   `trusted` — a Let's Encrypt leaf for the relay address; `custom-ca` — a
 *   CA the owner named (the phone must trust it); `self-signed`; `plain`.
 */
import { ownerT } from "../platform/language.ts";
import type { Translate } from "../../../contracts/src/i18n.ts";
import type { Faces } from "./faces.ts";

export type BrowserTrust = "trusted" | "custom-ca" | "self-signed";

export interface LinkWay {
  /** The address to put the code after (`<base>/#pair=…`); null: no link — the code by hand. */
  base: string | null;
  via: "relay" | "direct";
  certificate: BrowserTrust | "plain";
  warning: string | null;
  /** P6-15: the listener's self-signed certificate SHA-256 (colon hex), to compare with the browser's. */
  fingerprint?: string | null;
}

export interface OutsideLink {
  main: LinkWay;
  /** The relay, as the alternative to a direct `main` (null: no relay). */
  relay: LinkWay | null;
}

/** What it is for: a pairing code (`pair`) or an outside one-time passcode (`code`). */
export type LinkFor = "pair" | "code";

/*
 * Review M-1 (b): the words, as the dispatcher set them (P6-23b: in the
 * language packs, `server-access.link.*`; said in the asker's language).
 */
function relayWay(faces: Faces, address: string, what: LinkFor, t: Translate): LinkWay {
  const r = faces.relay!;
  const certificate: BrowserTrust = r.certificate?.() ?? "self-signed";
  const words: string[] = [];
  if (certificate === "self-signed") words.push(t.dynamic(`server-access.link.selfSigned.${what}`));
  else {
    words.push(t.dynamic(`server-access.link.relayOperator.${what}`));
    if (certificate === "custom-ca") words.push(t("server-access.link.customCa"));
  }
  if (r.connected && !r.connected()) words.push(t("server-access.link.notConnected"));
  const warning = words.reduce((first, next) => t("server-access.link.then", { first, next }));
  return { base: certificate === "self-signed" ? null : address, via: "relay", certificate, warning };
}

/**
 * P6-15 (ADR-158): what to compare — the browser's SHA-256 with this one
 * (`daisy access show` prints it too).
 */
export function selfSignedWarning(fingerprint: string | null, t: Translate = ownerT()): string {
  return t("server-access.link.selfSignedListener", {
    which: fingerprint ? t("server-access.link.fingerprintThis", { fingerprint }) : t("server-access.link.fingerprintCli"),
  });
}

/** The link for a code on the outside face, or null when nothing reaches it from elsewhere. */
export function outsideLink(faces: Faces, relayAddress: string | null, what: LinkFor, t: Translate = ownerT()): OutsideLink | null {
  if (!faces.externalReachable) return null;
  const listening = faces.externalListening && faces.external.url ? faces.external.url : null;
  const relay = faces.relay && relayAddress ? relayWay(faces, relayAddress, what, t) : null;
  if (listening)
    return {
      main: {
        base: listening,
        via: "direct",
        certificate: faces.external.tls ? "self-signed" : "plain",
        warning: faces.external.tls ? selfSignedWarning(faces.external.fingerprint, t) : null,
        fingerprint: faces.external.tls ? faces.external.fingerprint : null,
      },
      relay,
    };
  return relay ? { main: relay, relay: null } : null;
}

/** The fields a pairing code / one-time code answer carries, its code put after `#<key>=`. */
export function linkFields(l: OutsideLink, key: "pair" | "code", code: string) {
  const at = (base: string | null) => (base ? `${base}/#${key}=${encodeURIComponent(code)}` : null);
  return {
    url: at(l.main.base),
    via: l.main.via,
    certificate: l.main.certificate,
    warning: l.main.warning,
    fingerprint: l.main.fingerprint ?? null,
    relayUrl: at(l.relay?.base ?? null),
    relayCertificate: (l.relay?.certificate ?? null) as BrowserTrust | null,
    relayWarning: l.relay?.warning ?? null,
  };
}
