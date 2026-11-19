/**
 * P4-01 (identity-card.md §3, ADR-099 C1, ADR-120): a Daisy's identity —
 * the RFC 7638 JWK thumbprint (SHA-256) of its Ed25519 public key — and the
 * three ways it is written:
 *
 * | form | where | example length |
 * | --- | --- | --- |
 * | identity number (`id`): base32 (RFC 4648), lowercase, no padding | cards, the UI, the command line, logs, token header `kid` (D-40 ④) | 52 |
 * | relay subdomain: the identity number's first 32 characters (160 bits; ADR-100, relay PROTOCOL.md §2) | `<sub>.<relay domain>` | 32 |
 * | thumbprint: base64url, no padding (what `jose` returns) | inside the URN only | 43 |
 * | URN: `urn:ietf:params:oauth:jwk-thumbprint:sha-256:<thumbprint>` (RFC 9278) | token `iss` / `sub` / `aud` | 89 |
 *
 * All three are the same 32 bytes; each converts to the others here, so a
 * lookup takes whichever it is handed (`keyRefBytes`).
 *
 * P4-09 (ADR-128): moved from packages/daisy/src/contacts/ to the shared
 * packages/a2a-client (node:* only), for the standalone A2A MCP too.
 */
import { createHash } from "node:crypto";
import { THUMBPRINT_URN } from "./constants.ts";

/** An Ed25519 public key as a JWK (only the members RFC 7638 hashes). */
export interface PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding. */
export function base32(bytes: Uint8Array): string {
  let out = "",
    bits = 0,
    value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** The inverse of `base32` (lowercase or uppercase); null when it is not one. */
export function unbase32(s: string): Uint8Array | null {
  const t = s.toLowerCase();
  if (!/^[a-z2-7]*$/.test(t)) return null;
  const out: number[] = [];
  let bits = 0,
    value = 0;
  for (const ch of t) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  // Non-canonical trailing bits would give two spellings of one id.
  if (value !== 0) return null;
  return Uint8Array.from(out);
}

/** The RFC 7638 input for an Ed25519 key: members sorted, no whitespace. */
export const canonicalJwk = (k: { x: string }) =>
  `{"crv":"Ed25519","kty":"OKP","x":"${k.x}"}`;

/** The 32 thumbprint bytes of an Ed25519 public key. */
export const thumbprintBytes = (k: { x: string }): Uint8Array =>
  new Uint8Array(createHash("sha256").update(canonicalJwk(k), "utf8").digest());

/** Identity number: base32 lowercase of the thumbprint (52 characters). */
export const identityId = (k: { x: string }) => base32(thumbprintBytes(k));

/** Every form of one identity. */
export interface IdentityForms {
  id: string;
  thumbprint: string;
  urn: string;
}

export function formsOfBytes(bytes: Uint8Array): IdentityForms {
  const thumbprint = Buffer.from(bytes).toString("base64url");
  return { id: base32(bytes), thumbprint, urn: THUMBPRINT_URN + thumbprint };
}

export const formsOfKey = (k: { x: string }): IdentityForms => formsOfBytes(thumbprintBytes(k));

/**
 * Whatever names an identity — its identity number (spaces allowed, any
 * case), its base64url thumbprint, or its URN — as the 32 bytes; null when
 * it is none of these.
 */
export function keyRefBytes(ref: string): Uint8Array | null {
  if (typeof ref !== "string" || ref.length > 200) return null;
  let s = ref.trim();
  if (s.startsWith(THUMBPRINT_URN)) s = s.slice(THUMBPRINT_URN.length);
  else {
    const compact = s.replace(/\s+/g, "");
    if (compact.length === 52) {
      const b = unbase32(compact);
      if (b && b.length === 32) return b;
    }
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(s)) {
    const b = Buffer.from(s, "base64url");
    if (b.length === 32 && b.toString("base64url") === s) return new Uint8Array(b);
  }
  return null;
}

/** `k7m2 q6xd 4tfa …`: groups of four for people (identity-card.md §3). */
export const groupedId = (id: string) => id.replace(/(.{4})(?=.)/g, "$1 ");
