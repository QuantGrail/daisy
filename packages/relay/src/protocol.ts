/**
 * P5-01 (ADR-100 C1 / D1, ADR-143): the Daisy ↔ relay protocol, version 1 —
 * the constants and message shapes both sides use. The normative text is
 * packages/relay/PROTOCOL.md; this file must say the same thing.
 *
 * Dependency-free on purpose (no `ws`, no `jose`, no `node:*` beyond types),
 * so the Daisy side (P5-02, packages/daisy/src/relay-link) can import it by
 * path, the way the standalone MCP imports packages/a2a-client.
 */

/** The protocol's major version: in the paths (`/v1/…`) and every message's `v`. */
export const PROTOCOL_VERSION = 1;

/** The relay's own HTTPS paths (only under the relay's own domain). */
export const PATHS = {
  /** WebSocket: one per Daisy, kept open; the challenge / proof login, then `open` notices. */
  control: "/v1/control",
  /** WebSocket: one per inbound connection, opened by the Daisy with the claim in CLAIM_HEADER. */
  data: "/v1/data",
  /** GET `/v1/presence/<subdomain>` → `{ v, subdomain, online }`. */
  presencePrefix: "/v1/presence/",
  /** GET → `{ v, relay, protocols, domain }`. */
  info: "/v1/info",
} as const;

/** The JWS `typ` of the login proof — never a card's (`daisy-card+jwt`) or a token's (`at+jwt`). */
export const PROOF_TYP = "daisy-relay-proof+jwt";

/** A Daisy's subdomain: the first 160 bits of its identity thumbprint, base32 lowercase (32 characters). */
export const SUBDOMAIN_RE = /^[a-z2-7]{32}$/;
export const SUBDOMAIN_LENGTH = 32;

/**
 * The subdomain from a Daisy identity number (52-character base32 of the
 * 32-byte thumbprint): its first 32 characters, since 160 bits are exactly
 * 32 base32 characters. A caller holding someone's identity card can work
 * out their relay host without asking anyone.
 */
export function subdomainOfIdentityId(id: string): string | null {
  const s = typeof id === "string" ? id.replace(/\s+/g, "").toLowerCase() : "";
  if (!/^[a-z2-7]{52}$/.test(s)) return null;
  return s.slice(0, SUBDOMAIN_LENGTH);
}

/** WebSocket close codes the relay uses (PROTOCOL.md §6). */
export const CLOSE = {
  /** The relay is restarting: reconnect soon (short, jittered delay). */
  restart: 1012,
  /** Malformed or unexpected message. */
  protocol: 4400,
  /** The proof was refused (signature, typ, aud, nonce, key). */
  proofRefused: 4401,
  /** This relay's operator does not admit this identity (allow-list). */
  notAllowed: 4403,
  /** The hello did not arrive in time. */
  timeout: 4408,
  /** Another connection proved the same key; this one is replaced. */
  replaced: 4409,
  /** A stream went over its byte or time cap. */
  tooMuch: 4413,
  /** Too many messages. */
  rateLimited: 4429,
  /** The relay already serves its maximum number of Daisys, overall or from this source. */
  full: 4503,
} as const;

/** TLS alert descriptions the relay sends at the handshake (RFC 8446 §6). */
export const ALERT = {
  /** Target not online / not a name this relay serves (D1). */
  unrecognizedName: 112,
  /** Target online but the relay refused: a limit, or the Daisy did not claim in time. */
  internalError: 80,
} as const;

// --- relay → Daisy, control channel -------------------------------------

export interface ChallengeMsg {
  t: "challenge";
  v: 1;
  /** 32 random bytes, base64url; sign it back once, on this connection only. */
  nonce: string;
  /** The relay's own domain: the proof's `aud`. */
  aud: string;
}

export interface WelcomeMsg {
  t: "welcome";
  v: 1;
  /** The subdomain this Daisy holds while connected. */
  subdomain: string;
  /** `<subdomain>.<domain>`: the public host callers use (`https://<host>`, port 443 in production). */
  host: string;
  /** The Daisy's identity number (52 characters), as the relay derived it. */
  id: string;
  /** Limits worth knowing on the Daisy side. */
  limits: { claimTimeoutMs: number; maxStreams: number; pingIntervalMs: number; maxDataFrameBytes: number };
}

export interface OpenMsg {
  t: "open";
  v: 1;
  /** A serial number for logs on both sides (not a secret). */
  n: number;
  /** One-time secret (32 random bytes, base64url): send it on a new data WebSocket. Never log it. */
  claim: string;
  /** The caller's address as the relay saw it (informational; for the Daisy's own rate limits). */
  addr: string;
}

// --- Daisy → relay -------------------------------------------------------

export interface HelloMsg {
  t: "hello";
  v: 1;
  /** Compact JWS, header `{"alg":"EdDSA","typ":"daisy-relay-proof+jwt"}`, payload `ProofPayload`. */
  proof: string;
}

/** The payload a Daisy signs with its Ed25519 identity key. */
export interface ProofPayload {
  v: 1;
  /** The relay's domain from the challenge. */
  aud: string;
  /** The nonce from the challenge. */
  nonce: string;
  /** The identity public key (only these three members). */
  key: { kty: "OKP"; crv: "Ed25519"; x: string };
}

/** Control: decline an `open` (e.g. the Daisy is at its own limit). The relay refuses the caller. */
export interface RejectMsg {
  t: "reject";
  v: 1;
  claim: string;
}

/**
 * Data WebSocket: the upgrade request carries the claim in this header. The
 * relay checks it before upgrading (unknown, used or expired → HTTP 404, no
 * WebSocket); after the 101 the relay sends the ClientHello and from then on
 * there are binary frames only, both ways, each at most `maxDataFrameBytes`.
 * Upgrades that carry an `Origin` header are refused (403): only Daisys, not
 * web pages, connect here.
 */
export const CLAIM_HEADER = "daisy-relay-claim";

/** The payload a Daisy signs for a challenge (P5-02 signs it with its identity key). */
export function proofPayload(c: ChallengeMsg, key: { x: string }): ProofPayload {
  return { v: 1, aud: c.aud, nonce: c.nonce, key: { kty: "OKP", crv: "Ed25519", x: key.x } };
}

/** A claim / nonce: 32 bytes base64url, no padding. */
export const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
