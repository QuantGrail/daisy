/**
 * P5-02 (总纲 5.9, 7.6, ADR-144): this Daisy and its relay — the settings
 * (config.ts), the relay address's key and certificate (certs.ts, ACME
 * acme.ts), the connection (link.ts), and the TLS binding claim served at
 * /.well-known/daisy-tls-binding (ADR-100).
 *
 * Decided here (ADR-144 §3): a relay does not need the outside face to
 * listen anywhere — the relay's streams go into the outside face's own TLS
 * server (faces.ts `injectRelay`), and the outside face's rules (the
 * credentials it takes, the terminal / shell / browse switches, the
 * passcode, which turns on) apply to them. Turning the relay on is the
 * PIN-guarded step; off is not.
 */
import { ownerT } from "../platform/language.ts";
import { createPublicKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RelayStatus } from "../../../contracts/src/api/relay.ts";
import { TLS_BINDING_LIMITS } from "../../../contracts/src/limits.ts";
import { spkiHashOfDer } from "../../../a2a-client/src/binding.ts";
import type { SelfIssuer } from "../access/tokens/self-issuer.ts";
import type { Faces } from "../access/faces.ts";
import { exists } from "../access/keys.ts";
import { tlsFiles } from "../access/tls.ts";
import { RelayCerts } from "./certs.ts";
import { RelayLink, type LinkLimits, type LinkTransport } from "./link.ts";
import { acmeUsable, parseRelayUrl, readRelayConfig, relayAddressOf, writeRelayConfig, RELAY_OFF, type RelayConfig } from "./config.ts";
import type { AcmeTransport } from "./acme.ts";

export { parseRelayUrl, checkAcmeDirectory, readRelayConfig, relayAddressOf, DEFAULT_ACME_DIRECTORY } from "./config.ts";

export interface RelayDeps {
  dataDir: string;
  self: SelfIssuer;
  faces: Faces;
  /** Tests only: the test CA and resolver for the fake domain, a test ACME server's CA. */
  transport?: { link?: LinkTransport; acme?: AcmeTransport };
  limits?: Partial<LinkLimits>;
}

export class Relay {
  private link: RelayLink | null = null;
  private certs: RelayCerts | null = null;
  private claim: { text: string; at: number; spki: string } | null = null;

  constructor(private d: RelayDeps) {}

  config(): RelayConfig {
    return readRelayConfig(this.d.dataDir);
  }

  /** The relay address in cards (null when off). */
  address(): string | null {
    return relayAddressOf(this.config(), this.d.self.kid);
  }

  /** Start what the settings say (at start-up, and after each change). */
  async apply(): Promise<void> {
    await this.halt();
    const c = this.config();
    if (!c.enabled) return;
    const p = parseRelayUrl(c.url);
    if ("error" in p) return;
    const certs = (this.certs ??= new RelayCerts(this.d.dataDir, this.d.transport?.acme ? { transport: this.d.transport.acme } : {}));
    const host = `${this.d.self.kid.slice(0, 32)}.${p.domain}`;
    // Never ask a public CA for a name it cannot issue (and never from the tests).
    const unusable = acmeUsable(p.domain, c.acme.directory, !!this.d.transport?.acme);
    certs.start(host, unusable ? { ...c.acme, enabled: false } : c.acme, unusable);
    this.claim = null;
    let link: RelayLink | null = null;
    this.d.faces.relay = {
      host,
      port: p.port,
      context: () => certs.context(),
      // P5-03b: a phone's browser opens the relay address only with a CA's certificate (ADR-100; review L-4).
      certificate: () => certs.browserTrust(),
      connected: () => link?.state === "connected",
    };
    this.link = link = new RelayLink({
      domain: p.domain,
      port: p.port,
      self: this.d.self,
      inject: (stream, meta) => this.d.faces.injectRelay(stream, meta.addr),
      challenge: (h) => certs.challenge(h),
      ...(this.d.transport?.link ? { transport: this.d.transport.link } : {}),
      ...(this.d.limits ? { limits: this.d.limits } : {}),
    });
    this.link.start();
  }

  /** Stop the connection and every stream (the settings stay as they are). */
  async halt(): Promise<void> {
    const l = this.link;
    this.link = null;
    this.d.faces.stopRelay();
    this.certs?.stop();
    await l?.stop();
  }

  /** Save the settings (sync: inside commitLetIn); `apply` / `halt` follow. */
  save(c: RelayConfig) {
    writeRelayConfig(this.d.dataDir, c);
  }

  /**
   * Off: saved off (synchronously — a failed write throws, so a PIN reset
   * never reports a relay off that is not), and disconnected now whatever
   * happened to the write (review L-2). Returns once the link is down.
   */
  offNow(): Promise<void> {
    const c = this.config();
    let down: Promise<void> | undefined;
    try {
      this.save({ ...(c.url ? c : RELAY_OFF), enabled: false });
    } finally {
      // halt's synchronous part (streams, the relay host, the link) runs here.
      down = this.halt();
    }
    return down;
  }

  /** Tests: the link and the certificate manager. */
  get current() {
    return { link: this.link, certs: this.certs };
  }

  status(): RelayStatus {
    const c = this.config();
    const l = this.link;
    const cert = this.certs && c.enabled ? this.certs.status() : null;
    return {
      enabled: c.enabled,
      relay: c.url || null,
      state: l?.state ?? "off",
      since: l?.since ?? null,
      address: this.address(),
      lastError: c.enabled ? (l?.lastError ?? null) : null,
      retryAt: l?.retryAt ?? null,
      streams: l?.streamCount ?? 0,
      cert: cert ?? {
        kind: "none",
        notAfter: null,
        renewAt: null,
        acme: { ...c.acme },
        lastError: null,
        note: ownerT()("server-relay.status.noRelay"),
      },
    };
  }

  /** The SPKI hashes of this Daisy's TLS keys (the relay key; the outside face's own). */
  private spkis(): string[] {
    const out: string[] = [];
    if (this.certs) out.push(this.certs.spki);
    else if (exists(`${this.d.dataDir}/keys/relay-tls-key.pem`)) out.push(new RelayCerts(this.d.dataDir).spki);
    const f = tlsFiles(this.d.dataDir);
    if (exists(f.cert)) {
      try {
        const x = new X509Certificate(readFileSync(f.cert, "utf8"));
        out.push(spkiHashOfDer(createPublicKey(x.publicKey).export({ type: "spki", format: "der" }) as Buffer));
      } catch {}
    }
    return [...new Set(out)];
  }

  /**
   * The TLS binding claim (a2a-usage.md §15.1): re-signed every hour,
   * good for a day; null when this Daisy has no TLS key yet.
   */
  async bindingClaim(): Promise<string | null> {
    const spki = this.spkis();
    if (!spki.length) return null;
    const now = Math.floor(Date.now() / 1000);
    const key = spki.join(",");
    if (this.claim && this.claim.spki === key && now - this.claim.at < TLS_BINDING_LIMITS.refreshS) return this.claim.text;
    const text = await this.d.self.signTlsBinding({ v: 1, id: this.d.self.kid, spki, iat: now, exp: now + TLS_BINDING_LIMITS.ttlS });
    this.claim = { text, at: now, spki: key };
    return text;
  }
}
