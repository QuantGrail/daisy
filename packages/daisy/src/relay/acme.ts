/**
 * P5-02 (ADR-100 B1/B2, ADR-144 §5): a small ACME client (RFC 8555) for
 * one thing — a certificate for this Daisy's relay address, proven with
 * TLS-ALPN-01 (RFC 8737) through the relay, renewed when the CA's
 * renewal information says (ARI, RFC 9773) or at a third of the lifetime
 * left.
 *
 * Why not `acme-client` (ADR-099 named it): it brings axios and
 * @peculiar/x509 with a dozen packages behind them into a security
 * package, has no ARI, and needs global settings to trust a test CA.
 * What is ours here is only the protocol's message flow; every JWS is
 * jose's (ES256, the account key an ECDSA P-256 key of its own), every
 * signature node:crypto's (x509.ts), and the tests run it against an
 * independent ACME stand-in that checks each JWS with jose and validates
 * the challenge by a real TLS handshake through the relay.
 *
 * Every URL the server hands back must be on the directory's origin
 * (https): a misbehaving ACME server cannot point this Daisy anywhere else.
 */
import { request as httpsRequest } from "node:https";
import { createPublicKey, type KeyObject } from "node:crypto";
import { calculateJwkThumbprint, FlattenedSign, type JWK } from "jose";
import { RELAY_LINK_LIMITS as L } from "../../../contracts/src/limits.ts";
import { ownerT } from "../platform/language.ts";

/** P6-23b: shown to the owner (relay status), in the owner's language. */
const say = (key: string, params?: Record<string, unknown>) => ownerT().dynamic(`server-relay.acme.${key}`, params);
/** A URL's name: a protocol field as it is, else its words. */
const urlName = (what: string) => (ownerT().has(`server-relay.acme.url.${what}`) ? say(`url.${what}`) : what);

export class AcmeError extends Error {
  constructor(
    message: string,
    /** The problem document's `type` (urn:ietf:params:acme:error:…), when the server sent one. */
    readonly type: string | null = null,
    readonly status = 0,
  ) {
    super(message);
  }
}

export interface AcmeTransport {
  /** Tests: the test CA that signed the ACME server's certificate. */
  ca?: string;
  /** Tests: a resolver standing in for DNS. */
  lookup?: (host: string, o: unknown, cb: (...a: unknown[]) => void) => void;
}

interface Directory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  renewalInfo?: string;
  meta?: { termsOfService?: string };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

const PROBLEM = "application/problem+json";
const MAX_BODY = 1024 * 1024;

export interface RenewalWindow {
  start: number;
  end: number;
  /** When to ask again (Retry-After), ms. */
  retryAfterMs: number;
}

export class AcmeClient {
  private dir: Directory | null = null;
  private nonces: string[] = [];
  private kid: string | null;
  private jwk: JWK;
  private readonly origin: string;

  constructor(
    private o: {
      directoryUrl: string;
      /** ECDSA P-256 (ES256). */
      accountKey: KeyObject;
      /** The account URL learnt before (saved by the caller). */
      kid?: string | null;
      transport?: AcmeTransport;
      /** Aborts every request in flight and every wait (RelayCerts.stop). */
      signal?: AbortSignal;
    },
  ) {
    this.origin = new URL(o.directoryUrl).origin;
    this.kid = o.kid ?? null;
    const pub = createPublicKey(o.accountKey).export({ format: "jwk" }) as JWK;
    this.jwk = { kty: pub.kty!, crv: pub.crv!, x: pub.x!, y: pub.y! };
  }

  get accountUrl() {
    return this.kid;
  }

  /** A URL the server gave: only on the directory's origin. */
  private same(url: unknown, what: string): string {
    if (typeof url !== "string") throw new AcmeError(say("urlMissing", { what: urlName(what) }));
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new AcmeError(say("urlBad", { what: urlName(what) }));
    }
    if (u.origin !== this.origin) throw new AcmeError(say("urlOffOrigin", { what: urlName(what) }));
    return u.href;
  }

  private http(method: "GET" | "HEAD" | "POST", url: string, body?: string, accept = "application/json"): Promise<Reply> {
    const u = new URL(url);
    if (this.o.signal?.aborted) return Promise.reject(new AcmeError(say("stopped")));
    return new Promise<Reply>((resolve, reject) => {
      const req = httpsRequest(
        {
          method,
          host: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          servername: u.hostname,
          headers: {
            accept,
            "user-agent": "daisy-acme/1",
            ...(body !== undefined ? { "content-type": "application/jose+json", "content-length": Buffer.byteLength(body) } : {}),
          },
          minVersion: "TLSv1.2",
          agent: false,
          timeout: L.acmeRequestTimeoutMs,
          ...(this.o.transport?.ca ? { ca: this.o.transport.ca } : {}),
          ...(this.o.transport?.lookup ? { lookup: this.o.transport.lookup as any } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let n = 0;
          res.on("data", (c: Buffer) => {
            n += c.length;
            if (n > MAX_BODY) {
              req.destroy();
              return reject(new AcmeError(say("tooLarge")));
            }
            chunks.push(c);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers as any, body: Buffer.concat(chunks) }));
          res.on("error", () => reject(new AcmeError(say("readBroken"))));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      const onAbort = () => req.destroy(new Error(say("stopped")));
      this.o.signal?.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => this.o.signal?.removeEventListener("abort", onAbort));
      req.on("error", (e) => reject(new AcmeError(say("unreachable", { host: u.host, error: (e as Error).message.slice(0, 120) }))));
      req.end(body);
    });
  }

  private json(r: Reply): any {
    try {
      return JSON.parse(r.body.toString("utf8"));
    } catch {
      throw new AcmeError(say("notJson"), null, r.status);
    }
  }

  private problem(r: Reply, what: string): AcmeError {
    let type: string | null = null,
      detail = "";
    if (String(r.headers["content-type"] ?? "").startsWith(PROBLEM) || r.body.length) {
      try {
        const p = JSON.parse(r.body.toString("utf8"));
        type = typeof p.type === "string" ? p.type.slice(0, 120) : null;
        detail = typeof p.detail === "string" ? p.detail.slice(0, 300) : "";
      } catch {}
    }
    return new AcmeError(
      say("problem", {
        what,
        status: r.status,
        type: type ? say("problem.type", { type: type.replace("urn:ietf:params:acme:error:", "") }) : "",
        detail: detail ? say("detail", { detail }) : "",
      }),
      type,
      r.status,
    );
  }

  async directory(): Promise<Directory> {
    if (this.dir) return this.dir;
    const r = await this.http("GET", this.o.directoryUrl);
    if (r.status !== 200) throw this.problem(r, say("step.directory"));
    const d = this.json(r);
    this.dir = {
      newNonce: this.same(d.newNonce, "newNonce"),
      newAccount: this.same(d.newAccount, "newAccount"),
      newOrder: this.same(d.newOrder, "newOrder"),
      ...(typeof d.renewalInfo === "string" ? { renewalInfo: this.same(d.renewalInfo, "renewalInfo") } : {}),
      ...(d.meta && typeof d.meta === "object" ? { meta: { termsOfService: typeof d.meta.termsOfService === "string" ? d.meta.termsOfService : undefined } } : {}),
    } as Directory;
    return this.dir;
  }

  private keep(r: Reply) {
    const n = r.headers["replay-nonce"];
    if (typeof n === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(n)) this.nonces.push(n);
  }

  private async nonce(): Promise<string> {
    const n = this.nonces.pop();
    if (n) return n;
    const d = await this.directory();
    const r = await this.http("HEAD", d.newNonce);
    this.keep(r);
    const got = this.nonces.pop();
    if (!got) throw new AcmeError(say("noNonce"));
    return got;
  }

  /** A JWS POST (RFC 8555 §6.2); `payload` null = POST-as-GET. One retry on badNonce. */
  private async post(url: string, payload: unknown | null, o: { jwk?: boolean; accept?: string } = {}): Promise<Reply> {
    for (let attempt = 0; ; attempt++) {
      const nonce = await this.nonce();
      if (!o.jwk && !this.kid) throw new AcmeError(say("noAccount"));
      const bytes = payload === null ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(payload));
      const jws = await new FlattenedSign(bytes)
        .setProtectedHeader({ alg: "ES256", nonce, url, ...(o.jwk ? { jwk: this.jwk } : { kid: this.kid! }) })
        .sign(this.o.accountKey);
      const r = await this.http("POST", url, JSON.stringify(jws), o.accept);
      this.keep(r);
      if (r.status === 400 && attempt === 0) {
        const p = this.problem(r, "");
        if (p.type === "urn:ietf:params:acme:error:badNonce") continue;
      }
      return r;
    }
  }

  /** The account (made the first time; `termsOfServiceAgreed`: the owner agreed by turning ACME on). */
  async account(): Promise<string> {
    if (this.kid) return this.kid;
    const d = await this.directory();
    const r = await this.post(d.newAccount, { termsOfServiceAgreed: true }, { jwk: true });
    if (r.status !== 200 && r.status !== 201) throw this.problem(r, say("step.account"));
    this.kid = this.same(r.headers.location, "account");
    return this.kid;
  }

  /** RFC 8555 §8.1: token "." base64url(SHA-256 thumbprint of the account key). */
  async keyAuthorization(token: string): Promise<string> {
    return `${token}.${await calculateJwkThumbprint(this.jwk, "sha256")}`;
  }

  private async poll(url: string, done: (v: any) => boolean, deadline: number, what: string): Promise<any> {
    while (true) {
      const r = await this.post(url, null);
      if (r.status !== 200) throw this.problem(r, say("step.check", { what: say(`phase.${what}`) }));
      const v = this.json(r);
      if (done(v)) return v;
      if (v.status === "invalid") {
        const err = v.error ?? v.challenges?.find((c: any) => c.error)?.error;
        throw new AcmeError(
          say("phaseFailed", { what: say(`phase.${what}`), detail: err?.detail ? say("detail", { detail: String(err.detail).slice(0, 300) }) : "" }),
          typeof err?.type === "string" ? err.type : null,
        );
      }
      if (Date.now() > deadline) throw new AcmeError(say("phaseTimeout", { what: say(`phase.${what}`) }));
      const ra = Number(r.headers["retry-after"]);
      await new Promise((ok) => setTimeout(ok, Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : L.acmePollMs, 10_000)));
      if (this.o.signal?.aborted) throw new AcmeError(say("stopped"));
    }
  }

  /**
   * Order, prove and finalize a certificate for `host` (RFC 8555 §7.4).
   * `present(keyAuthorization)` puts the TLS-ALPN-01 certificate up and
   * returns how to take it down. `replaces`: the ARI id of the
   * certificate this one renews (RFC 9773 §5). Returns the PEM chain.
   */
  async issue(host: string, csr: Buffer, present: (keyAuthorization: string) => () => void, replaces?: string | null): Promise<string> {
    const deadline = Date.now() + L.acmeIssueTimeoutMs;
    await this.account();
    const d = await this.directory();
    let r = await this.post(d.newOrder, { identifiers: [{ type: "dns", value: host }], ...(replaces ? { replaces } : {}) });
    // A CA that will not take `replaces` (already replaced, not ARI): order plainly.
    if (replaces && r.status >= 400 && r.status < 500) r = await this.post(d.newOrder, { identifiers: [{ type: "dns", value: host }] });
    if (r.status !== 201) throw this.problem(r, say("step.order"));
    const orderUrl = this.same(r.headers.location, "order");
    const order = this.json(r);
    if (!Array.isArray(order.authorizations) || order.authorizations.length > 4) throw new AcmeError(say("orderBad"));
    for (const a of order.authorizations) {
      const authzUrl = this.same(a, "authz");
      const ar = await this.post(authzUrl, null);
      if (ar.status !== 200) throw this.problem(ar, say("step.authz"));
      const authz = this.json(ar);
      if (authz.status === "valid") continue;
      if (authz.identifier?.type !== "dns" || String(authz.identifier?.value).toLowerCase() !== host)
        throw new AcmeError(say("authzName"));
      const ch = Array.isArray(authz.challenges) ? authz.challenges.find((c: any) => c?.type === "tls-alpn-01") : null;
      if (!ch || typeof ch.token !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(ch.token))
        throw new AcmeError(say("noAlpn"));
      const take = present(await this.keyAuthorization(ch.token));
      try {
        const cr = await this.post(this.same(ch.url, "challenge"), {});
        if (cr.status !== 200) throw this.problem(cr, say("step.challenge"));
        await this.poll(authzUrl, (v) => v.status === "valid", deadline, "validation");
      } finally {
        take();
      }
    }
    let o = await this.poll(orderUrl, (v) => v.status === "ready" || v.status === "valid", deadline, "order");
    if (o.status === "ready") {
      const fr = await this.post(this.same(o.finalize, "finalize"), { csr: csr.toString("base64url") });
      if (fr.status !== 200) throw this.problem(fr, say("step.finalize"));
      o = await this.poll(orderUrl, (v) => v.status === "valid", deadline, "issue");
    }
    const cr = await this.post(this.same(o.certificate, "certificate"), null, { accept: "application/pem-certificate-chain" });
    if (cr.status !== 200) throw this.problem(cr, say("step.download"));
    const pem = cr.body.toString("utf8");
    if (!/^-----BEGIN CERTIFICATE-----/.test(pem.trim())) throw new AcmeError(say("notPem"));
    return pem;
  }

  /** RFC 9773: the CA's suggested renewal window for a certificate, or null when it has no ARI. */
  async renewalInfo(certId: string): Promise<RenewalWindow | null> {
    const d = await this.directory();
    if (!d.renewalInfo || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(certId)) return null;
    const r = await this.http("GET", `${d.renewalInfo.replace(/\/$/, "")}/${certId}`);
    if (r.status !== 200) return null;
    const v = this.json(r);
    const start = Date.parse(v?.suggestedWindow?.start),
      end = Date.parse(v?.suggestedWindow?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    const ra = Number(r.headers["retry-after"]);
    return { start, end, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : L.renewCheckMs };
  }
}
