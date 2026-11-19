/**
 * P5-02 (ADR-100 B1/B2, ADR-099 / ADR-102 key storage, ADR-144 §5): the
 * key and certificate of the relay address.
 *
 * - keys/relay-tls-key.pem: ECDSA P-256, made once, kept across renewals
 *   and relay changes (its SPKI is what the TLS binding claim names).
 * - keys/relay-tls-cert.pem: the certificate served for `<sub>.<domain>` —
 *   a CA's (ACME TLS-ALPN-01) or the self-signed fallback.
 * - keys/acme-account-key.pem: the ACME account's own ECDSA P-256 key.
 * - keys/relay-tls.json: what is known about them (kind, host, expiry,
 *   ARI id and window, the account URL, the last ACME problem).
 *
 * Every file 0600 in keys/ (0700), read back through readSecretFile.
 * A self-signed certificate is made at once so the relay address works
 * between Daisies right away; ACME runs in the background and swaps the
 * certificate in when it succeeds; a failure keeps what there is and
 * tries again later (growing wait, ADR-100's rate limits).
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate, type KeyObject } from "node:crypto";
import { createSecureContext, type SecureContext } from "node:tls";

import { join } from "node:path";
import { RELAY_LINK_LIMITS as L } from "../../../contracts/src/limits.ts";
import { spkiHashOfDer } from "../../../a2a-client/src/binding.ts";
import { ensureKeysDir, exists, writeSecret } from "../access/keys.ts";
import { readSecretFile } from "../access/secret-file.ts";
import { AcmeClient, type AcmeTransport } from "./acme.ts";
import { alpnChallengeCert, ariCertId, csrDer, selfSignedCert } from "./x509.ts";
import { log } from "../observe/log.ts";
import { DEFAULT_ACME_DIRECTORY } from "./config.ts";
import { ownerT } from "../platform/language.ts";

/** P6-23b: what the served certificate is good for, in the owner's language. */
export const certNote = (kind: string) => ownerT()(kind === "acme" ? "server-relay.cert.note.acme" : "server-relay.cert.note.selfSigned");

/**
 * P5-03b review L-4: is what an ACME directory answered a CA's leaf for
 * `host` — names it, is no CA itself, and was not issued by itself? Else
 * it is served as self-signed (never called "trusted").
 */
export function acmeLeafOk(leaf: X509Certificate, host: string): boolean {
  return !!leaf.checkHost(host) && !leaf.ca && leaf.issuer !== leaf.subject;
}

/**
 * P5-03b review L-4: what a phone's browser makes of the served
 * certificate — `trusted` only for Let's Encrypt (the default directory)
 * and not expired; another directory's is `custom-ca` (the phone must
 * trust that CA); anything else `self-signed`.
 */
export function browserTrustOf(m: { kind?: string; notAfter?: number; directory?: string }, now: number): "trusted" | "custom-ca" | "self-signed" {
  if (m.kind !== "acme" || !((m.notAfter ?? 0) > now)) return "self-signed";
  return m.directory === DEFAULT_ACME_DIRECTORY ? "trusted" : "custom-ca";
}

interface Meta {
  host?: string;
  kind?: "acme" | "self-signed";
  notAfter?: number;
  directory?: string;
  accountUrl?: string;
  certId?: string | null;
  renewAt?: number | null;
  lastError?: string | null;
  failures?: number;
}

const uid = () => (process.platform === "win32" ? undefined : process.getuid?.());

export class RelayCerts {
  private files;
  private meta: Meta = {};
  private key: KeyObject;
  private keyPem: string;
  private certPem: string | null = null;
  private ctx: SecureContext | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;
  /** Active TLS-ALPN-01 certificates, by host. */
  private challenges = new Map<string, SecureContext>();
  private acme: { enabled: boolean; directory: string } = { enabled: false, directory: "" };
  private host = "";
  /** Why ACME is off although the owner wants it (a reserved name). */
  private why: string | null = null;
  /** The issuance in flight (stop() aborts it). */
  private abort: AbortController | null = null;
  /** Told when the served certificate changes. */
  onChange: () => void = () => {};

  constructor(
    private dataDir: string,
    private o: { transport?: AcmeTransport; now?: () => number } = {},
  ) {
    const dir = ensureKeysDir(dataDir);
    this.files = {
      key: join(dir, "relay-tls-key.pem"),
      cert: join(dir, "relay-tls-cert.pem"),
      account: join(dir, "acme-account-key.pem"),
      meta: join(dir, "relay-tls.json"),
    };
    if (!exists(this.files.key)) {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      writeSecret(this.files.key, privateKey.export({ type: "pkcs8", format: "pem" }));
    }
    this.keyPem = readSecretFile(this.files.key, uid());
    this.key = createPrivateKey(this.keyPem);
    if (this.key.asymmetricKeyType !== "ec") throw new Error(ownerT()("server-relay.cert.keyNotEc", { file: this.files.key }));
    try {
      if (exists(this.files.meta)) this.meta = JSON.parse(readSecretFile(this.files.meta, uid())) || {};
    } catch {
      this.meta = {};
    }
  }

  private now() {
    return this.o.now ? this.o.now() : Date.now();
  }

  /** SHA-256 of this key's SPKI, base64url — what the binding claim names. */
  get spki(): string {
    return spkiHashOfDer(createPublicKey(this.key).export({ type: "spki", format: "der" }) as Buffer);
  }

  private saveMeta() {
    writeSecret(this.files.meta, JSON.stringify(this.meta, null, 2) + "\n");
  }

  private install(pem: string, kind: "acme" | "self-signed") {
    const leaf = new X509Certificate(pem);
    // Never serve a certificate for another key (a CA could not have one; a hand-edited file could).
    if (!leaf.checkPrivateKey(this.key)) throw new Error(ownerT()("server-relay.cert.keyMismatch"));
    // Review L-4: an "ACME" answer that is not a CA's leaf for this host is not called one.
    if (kind === "acme" && !acmeLeafOk(leaf, this.host)) kind = "self-signed";
    this.ctx = createSecureContext({ cert: pem, key: this.keyPem, minVersion: "TLSv1.2" });
    this.certPem = pem;
    writeSecret(this.files.cert, pem);
    this.meta = {
      ...this.meta,
      host: this.host,
      kind,
      notAfter: Date.parse(leaf.validTo),
      certId: kind === "acme" ? ariCertId(pem) : null,
    };
    this.saveMeta();
    this.onChange();
  }

  /**
   * Serve `host` (`<sub>.<domain>`): the certificate on disk if it covers
   * it and is still good, else a fresh self-signed one; then keep ACME
   * going in the background when it is on.
   */
  start(host: string, acme: { enabled: boolean; directory: string }, why: string | null = null) {
    this.host = host;
    this.acme = acme;
    this.why = why;
    this.stopped = false;
    let ok = false;
    if (exists(this.files.cert) && this.meta.host === host) {
      try {
        const pem = readSecretFile(this.files.cert, uid());
        const x = new X509Certificate(pem);
        if (x.checkHost(host) && Date.parse(x.validTo) > this.now() + 3600_000) {
          this.install(pem, this.meta.kind === "acme" ? "acme" : "self-signed");
          ok = true;
        }
      } catch {}
    }
    if (!ok) {
      this.meta = { ...this.meta, renewAt: null, failures: 0, lastError: null };
      this.install(selfSignedCert(this.key, host, L.selfSignedDays, this.now()), "self-signed");
    }
    // Another directory than the one the certificate came from: ask the new one.
    if (acme.enabled && this.meta.kind === "acme" && this.meta.directory !== acme.directory) this.meta.renewAt = this.now();
    this.schedule(acme.enabled ? (this.meta.renewAt ?? this.now()) : null);
  }

  stop() {
    this.stopped = true;
    // Tidy-up of the review: an issuance in flight stops too.
    this.abort?.abort();
    this.abort = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.challenges.clear();
  }

  private schedule(at: number | null) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.meta.renewAt = at;
    if (at === null || this.stopped) return;
    const ms = Math.max(0, Math.min(at - this.now(), 2 ** 31 - 1));
    const t = setTimeout(() => {
      this.timer = null;
      // Review L-1: never an unhandled rejection (work() catches; this is the second line).
      this.tick().catch((e) => log.error(`✗ relay address certificate: ${String((e as Error)?.message ?? e).slice(0, 200)}`));
    }, ms) as unknown as NodeJS.Timeout;
    t.unref?.();
    this.timer = t;
  }

  /** Run the ACME side now (tests; also what the timer does). */
  tick(): Promise<void> {
    if (!this.running)
      this.running = this.work().finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private client(signal: AbortSignal): AcmeClient {
    if (!exists(this.files.account)) {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      writeSecret(this.files.account, privateKey.export({ type: "pkcs8", format: "pem" }));
    }
    const accountKey = createPrivateKey(readSecretFile(this.files.account, uid()));
    return new AcmeClient({
      directoryUrl: this.acme.directory,
      accountKey,
      kid: this.meta.directory === this.acme.directory ? (this.meta.accountUrl ?? null) : null,
      ...(this.o.transport ? { transport: this.o.transport } : {}),
      signal,
    });
  }

  private async work() {
    if (this.stopped || !this.acme.enabled) return;
    const host = this.host;
    const ac = new AbortController();
    this.abort = ac;
    let c: AcmeClient | null = null;
    try {
      // Review L-1: a bad account key file is a problem to show, not a crash.
      c = this.client(ac.signal);
      // A CA certificate already: is it time (ARI, else a third of its life left)?
      if (this.meta.kind === "acme" && this.meta.directory === this.acme.directory && this.certPem) {
        const x = new X509Certificate(this.certPem);
        const from = Date.parse(x.validFrom),
          to = Date.parse(x.validTo);
        let due = to - (to - from) * L.renewAtRemaining;
        let next = L.renewCheckMs;
        const w = this.meta.certId ? await c.renewalInfo(this.meta.certId).catch(() => null) : null;
        if (ac.signal.aborted) return;
        if (w) {
          // RFC 9773 §4.2: a random moment inside the window.
          due = w.start + Math.random() * (w.end - w.start);
          next = Math.max(60_000, Math.min(w.retryAfterMs, L.renewCheckMs));
        }
        if (this.now() < due) return this.schedule(Math.min(due, this.now() + next));
      }
      const csr = csrDer(this.key, host);
      const pem = await c.issue(
        host,
        csr,
        (keyAuth) => {
          const ch = alpnChallengeCert(host, keyAuth, this.now());
          this.challenges.set(host, createSecureContext({ cert: ch.cert, key: ch.key }));
          return () => this.challenges.delete(host);
        },
        this.meta.kind === "acme" && this.meta.directory === this.acme.directory ? this.meta.certId : null,
      );
      if (this.stopped || host !== this.host) return;
      this.meta = { ...this.meta, directory: this.acme.directory, accountUrl: c.accountUrl ?? undefined, lastError: null, failures: 0 };
      this.install(pem, "acme");
      log.info(`Relay address certificate issued by the certificate authority (until ${new Date(this.meta.notAfter!).toISOString()})`);
      this.schedule(this.now() + L.renewCheckMs);
    } catch (e) {
      if (ac.signal.aborted || this.stopped) return;
      const failures = (this.meta.failures ?? 0) + 1;
      const wait = Math.min(L.acmeRetryMaxMs, L.acmeRetryFirstMs * 2 ** (failures - 1));
      this.meta = {
        ...this.meta,
        ...(c?.accountUrl ? { directory: this.acme.directory, accountUrl: c.accountUrl } : {}),
        lastError: String((e as Error).message ?? e).slice(0, 300),
        failures,
      };
      log.error(`✗ relay address certificate not obtained (${this.meta.kind === "acme" ? "keeping the current certificate" : "keeping the self-signed certificate"}; retrying in ${Math.round(wait / 60000)} min): ${this.meta.lastError}`);
      this.schedule(this.now() + wait);
      this.saveMeta();
    } finally {
      if (this.abort === ac) this.abort = null;
    }
  }

  /** The context for the relay host (the served certificate). */
  context(): SecureContext | null {
    return this.ctx;
  }

  /** The TLS-ALPN-01 certificate for `host` while a challenge is open. */
  challenge(host: string): SecureContext | null {
    return this.challenges.get(host) ?? null;
  }

  status() {
    const kind = this.ctx ? (this.meta.kind ?? "self-signed") : "none";
    return {
      kind: kind as "acme" | "self-signed" | "none",
      notAfter: this.meta.notAfter ?? null,
      renewAt: this.acme.enabled ? (this.meta.renewAt ?? null) : null,
      acme: { ...this.acme },
      lastError: this.acme.enabled ? (this.meta.lastError ?? null) : this.why,
      note: certNote(kind),
    };
  }

  /** P5-03b review L-4: what a phone's browser makes of the certificate served now. */
  browserTrust(): "trusted" | "custom-ca" | "self-signed" {
    return this.ctx ? browserTrustOf(this.meta, this.now()) : "self-signed";
  }

  /** Tests / status: the certificate served now. */
  get certificate(): string | null {
    return this.certPem;
  }
}

