/**
 * P5-02 (ADR-100 「TLS 绑定声明」, ADR-144, a2a-usage.md §15.1): the TLS
 * binding claim — a Daisy says, signed with its Ed25519 identity key,
 * which TLS keys are its own. A Daisy client reads it, verifies it with
 * the key from its address book, and only then sends a token on a
 * connection whose certificate carries one of those keys.
 *
 * Why: a relay operator controls its domain's DNS and port 443 and can get
 * a publicly trusted certificate for any Daisy's subdomain, then sit in the
 * middle (D-41 ②). WebPKI alone cannot tell; the identity key can — the
 * relay never has it. The same holds for a self-signed certificate (the
 * fallback when ACME fails), so between Daisies a relay address is as
 * safe with either.
 *
 * The claim (compact JWS):
 * - header exactly `{"alg":"EdDSA","typ":"daisy-tls-binding+jwt"}` — no
 *   other member (no `jwk`, `kid`, `crit`…); `typ` differs from a card's,
 *   a token's and a relay proof's, so no signature stands in for another;
 * - payload `{ v: 1, id, spki: [...], iat, exp }`: `id` the 52-character
 *   identity number, `spki` the base64url SHA-256 of each TLS key's
 *   SubjectPublicKeyInfo (DER), 1–8 of them.
 *
 * Self-contained: node:crypto and jose (shared with the standalone MCP).
 */
import { createHash, type X509Certificate } from "node:crypto";
import { compactVerify, decodeProtectedHeader } from "jose";
import { TLS_BINDING_LIMITS as L } from "../../contracts/src/limits.ts";
import { KeyedError } from "../../contracts/src/i18n-process.ts";
import type { MessageKey } from "../../contracts/src/i18n.ts";
import { keyObjectOf } from "./card.ts";
import { identityId, type PublicJwk } from "./identity.ts";

/** Where a Daisy serves its claim (both faces; no token: it is public). */
export const TLS_BINDING_PATH = "/.well-known/daisy-tls-binding";
/** The claim's JWS `typ`. */
export const TLS_BINDING_TYP = "daisy-tls-binding+jwt";
/** A SPKI hash in the claim: SHA-256, base64url, no padding. */
export const SPKI_RE = /^[A-Za-z0-9_-]{43}$/;

export interface BindingClaim {
  v: 1;
  id: string;
  spki: string[];
  iat: number;
  exp: number;
}

/** SHA-256 of a SubjectPublicKeyInfo (DER), base64url — what a claim names. */
export const spkiHashOfDer = (spkiDer: Uint8Array): string =>
  createHash("sha256").update(spkiDer).digest("base64url");

/** The SPKI hash of a certificate's key. */
export const spkiHashOfCert = (cert: X509Certificate): string =>
  spkiHashOfDer(
    cert.publicKey.export({ type: "spki", format: "der" }) as Buffer,
  );

export class BindingError extends KeyedError {
  constructor(
    readonly code:
      | "malformed" // not a compact JWS, too big, wrong header
      | "signature" // not signed by the contact's key
      | "claims" // payload shape, version, identity, times
      | "mismatch", // a valid claim that does not name this connection's key
    key: MessageKey,
    params: Record<string, string | number> = {},
  ) {
    super(key, params);
  }
}

const bad = (
  code: BindingError["code"],
  key: MessageKey,
  params?: Record<string, string | number>,
) => new BindingError(code, key, params);

/**
 * Verify a claim against `key` — the contact's key from the address book,
 * never a key the claim or the connection offers. Throws BindingError.
 */
export async function verifyBindingClaim(
  jws: string,
  key: PublicJwk,
  now = Date.now(),
): Promise<BindingClaim> {
  if (typeof jws !== "string") throw bad("malformed", "a2a.binding.notText");
  const text = jws.trim();
  if (Buffer.byteLength(text, "utf8") > L.maxBytes)
    throw bad("malformed", "a2a.binding.tooLong");
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text))
    throw bad("malformed", "a2a.binding.notJws");
  let header: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(text) as Record<string, unknown>;
  } catch {
    throw bad("malformed", "a2a.binding.headerUnreadable");
  }
  const keys = Object.keys(header).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "alg" ||
    keys[1] !== "typ" ||
    header.alg !== "EdDSA" ||
    header.typ !== TLS_BINDING_TYP
  )
    throw bad("malformed", "a2a.binding.headerWrong", { typ: TLS_BINDING_TYP });
  let payload: Uint8Array;
  try {
    ({ payload } = await compactVerify(text, keyObjectOf(key), {
      algorithms: ["EdDSA"],
    }));
  } catch {
    throw bad("signature", "a2a.binding.signature");
  }
  let p: any;
  try {
    p = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw bad("claims", "a2a.binding.payloadNotJson");
  }
  if (!p || typeof p !== "object" || Array.isArray(p))
    throw bad("claims", "a2a.binding.payloadWrong");
  if (p.v !== 1) throw bad("claims", "a2a.binding.version");
  if (p.id !== identityId(key)) throw bad("claims", "a2a.binding.identity");
  if (
    !Array.isArray(p.spki) ||
    p.spki.length < 1 ||
    p.spki.length > L.maxSpki ||
    !p.spki.every((s: unknown) => typeof s === "string" && SPKI_RE.test(s))
  )
    throw bad("claims", "a2a.binding.spkiList");
  if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp))
    throw bad("claims", "a2a.binding.times");
  const t = Math.floor(now / 1000);
  if (p.iat > t + L.skewS) throw bad("claims", "a2a.binding.future");
  if (p.exp <= t) throw bad("claims", "a2a.binding.expired");
  if (p.exp - p.iat > L.maxLifetimeS)
    throw bad("claims", "a2a.binding.lifetime");
  return { v: 1, id: p.id, spki: [...p.spki], iat: p.iat, exp: p.exp };
}

/** The message key of a claim that does not name the connection's key. */
export const MISMATCH_KEY = "a2a.binding.mismatch" satisfies MessageKey;

/**
 * One contact's claims, per origin: fetched when a connection shows a key
 * no valid cached claim names, verified, cached until it expires.
 * `fetch` gets the claim's text WITHOUT any token (outboundRequest with no
 * Authorization) — the connection it uses proves nothing; the signature does.
 */
export class TlsBindingVerifier {
  private cache = new Map<string, BindingClaim>();
  private inflight = new Map<string, Promise<BindingClaim>>();
  constructor(
    private o: {
      key: PublicJwk;
      fetch: (origin: string) => Promise<string>;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.o.now ? this.o.now() : Date.now();
  }

  private fresh(origin: string): Promise<BindingClaim> {
    let p = this.inflight.get(origin);
    if (!p) {
      p = this.o
        .fetch(origin)
        .then((text) => verifyBindingClaim(text, this.o.key, this.now()))
        .finally(() => this.inflight.delete(origin));
      this.inflight.set(origin, p);
    }
    return p;
  }

  /**
   * May a token go over a connection to `origin` whose certificate's key
   * hashes to `spki`? Throws BindingError when not.
   */
  async check(origin: string, spki: string): Promise<void> {
    const c = this.cache.get(origin);
    if (c && c.exp * 1000 > this.now() && c.spki.includes(spki)) return;
    const claim = await this.fresh(origin);
    this.cache.set(origin, claim);
    if (!claim.spki.includes(spki)) throw bad("mismatch", MISMATCH_KEY);
  }

  /** Forget what was learnt (the contact's card changed). */
  clear() {
    this.cache.clear();
  }
}
