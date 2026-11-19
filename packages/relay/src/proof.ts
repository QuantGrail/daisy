/**
 * P5-01 (ADR-100 recommendation 3, ADR-143 §2): the login proof. A Daisy
 * signs the relay's challenge with its Ed25519 identity key (ADR-099, the
 * same key its identity card names); the relay derives the subdomain from
 * that key, so a subdomain can only be held by whoever holds the key.
 *
 * Checked, in order, every one refused on its own: the JWS shape; header
 * exactly `{alg: "EdDSA", typ: "daisy-relay-proof+jwt"}` (no `jwk`, `kid`,
 * `jku`, `x5u`, `crit`…); payload `v` 1; `aud` this relay's domain; `nonce`
 * the one sent on this connection; `key` a strict Ed25519 public JWK; the
 * signature under `key`.
 */
import { createPublicKey } from "node:crypto";
import { compactVerify } from "jose";
import { base32, identityId, thumbprintBytes } from "../../a2a-client/src/identity.ts";
import { PROOF_TYP, SUBDOMAIN_LENGTH } from "./protocol.ts";

/** The subdomain of an Ed25519 public key: base32 of the first 160 bits (20 bytes) of its RFC 7638 thumbprint. */
export const subdomainOfKey = (k: { x: string }) => base32(thumbprintBytes(k).subarray(0, 20));

export type ProofResult = { ok: true; sub: string; id: string } | { ok: false; why: string };

const MAX_PROOF = 2048;

function json(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export async function verifyProof(proof: unknown, want: { domain: string; nonce: string }): Promise<ProofResult> {
  const no = (why: string): ProofResult => ({ ok: false, why });
  if (typeof proof !== "string" || proof.length > MAX_PROOF) return no("shape");
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(proof)) return no("shape");
  const [h, p] = proof.split(".") as [string, string, string];
  const header = json(h);
  if (!header) return no("header");
  const hk = Object.keys(header).sort().join(",");
  if (hk !== "alg,typ" || header.alg !== "EdDSA" || header.typ !== PROOF_TYP) return no("header");
  const payload = json(p);
  if (!payload) return no("payload");
  if (payload.v !== 1) return no("version");
  if (payload.aud !== want.domain) return no("aud");
  if (typeof payload.nonce !== "string" || payload.nonce !== want.nonce) return no("nonce");
  const k = payload.key as Record<string, unknown> | undefined;
  if (!k || typeof k !== "object" || Array.isArray(k)) return no("key");
  if (Object.keys(k).sort().join(",") !== "crv,kty,x" || k.kty !== "OKP" || k.crv !== "Ed25519") return no("key");
  if (typeof k.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(k.x)) return no("key");
  const raw = Buffer.from(k.x, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== k.x) return no("key");
  let keyObj;
  try {
    keyObj = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" });
  } catch {
    return no("key");
  }
  try {
    await compactVerify(proof, keyObj, { algorithms: ["EdDSA"] });
  } catch {
    return no("signature");
  }
  const sub = subdomainOfKey({ x: k.x });
  if (sub.length !== SUBDOMAIN_LENGTH) return no("key");
  return { ok: true, sub, id: identityId({ x: k.x }) };
}
