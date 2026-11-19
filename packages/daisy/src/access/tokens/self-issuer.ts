/**
 * P2-01 (token.md §4.1, ADR-099 A1 + B2): the first implementation — this
 * Daisy is its own issuer. Its Ed25519 identity key (keys/identity-key.json,
 * 0600, made on first start) signs; the public half verifies. `iss` is the
 * URN of the key's RFC 7638 thumbprint (base64url, RFC 9278), `kid` its
 * identity number — the same 32 bytes in base32 (identity-card.md §3).
 * D-40 ④ (phase-4 gate): `kid` is base32 everywhere; it was the base64url
 * thumbprint before, and a token carrying that is no longer accepted.
 *
 * Signs: the AI's working credential (P1-03, ai-credential.ts), a token for
 * an AI when no external issuer is configured (P2-02, delegate.ts), and the
 * two short JWTs of an RFC 8693 exchange (the actor token, the RFC 7523
 * client assertion). Verifies: only EdDSA / Ed25519, only its own key.
 */
import { ownerT } from "../../platform/language.ts";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { join } from "node:path";
import { CompactSign, SignJWT, calculateJwkThumbprint, type JWK, type JWTPayload } from "jose";
import { readSecretFile } from "../secret-file.ts";
import { base32 } from "../../../../a2a-client/src/identity.ts";
import { TLS_BINDING_TYP } from "../../../../a2a-client/src/binding.ts";
import { PROOF_TYP as RELAY_PROOF_TYP } from "../../../../relay/src/protocol.ts";
import { ensureKeysDir, exists, writeSecret } from "../keys.ts";
import {
  ACCESS_TOKEN_TYP,
  IDENTITY_CARD_TYP,
  THUMBPRINT_URN,
  verifyAccessToken,
  type TokenVerifier,
  type VerifyOptions,
  type VerifyResult,
} from "./common.ts";

/** Self-issued tokens: EdDSA (RFC 8037); `Ed25519` (RFC 9864) accepted too (ADR-099 rec. 1). */
export const SELF_ALGORITHMS = ["EdDSA", "Ed25519"];

/** What an access token this Daisy signs says (token.md §3). */
export interface SelfClaims {
  sub: string;
  aud: string | string[];
  clientId: string;
  scope: string;
  act?: { sub: string; name?: string };
  /** Lifetime in seconds (the caller bounds it). */
  ttlS: number;
  /** Private claims (e.g. the AI credential's `daisy_turn`). */
  extra?: Record<string, unknown>;
  /** P4-12: a `jti` chosen beforehand (`daisy token`'s `client_id` names it); default a fresh one. */
  jti?: string;
}

export const newJti = () => randomBytes(16).toString("base64url");

export class SelfIssuer implements TokenVerifier {
  readonly kind = "self" as const;
  private constructor(
    private privateKey: KeyObject,
    readonly publicKey: KeyObject,
    /** The key's RFC 7638 thumbprint, base64url (43): only inside the URN. */
    readonly thumbprint: string,
    readonly publicJwk: { kty: string; crv: string; x: string },
  ) {
    this.kid = base32(Buffer.from(thumbprint, "base64url"));
  }
  /**
   * The token header's `kid`: this Daisy's identity number — base32
   * lowercase of the thumbprint, 52 characters (identity-card.md §3, D-40 ④).
   */
  readonly kid: string;
  /** This Daisy's identity: `urn:ietf:params:oauth:jwk-thumbprint:sha-256:<thumbprint>`. */
  get urn() {
    return THUMBPRINT_URN + this.thumbprint;
  }
  get issuer() {
    return this.urn;
  }
  /** Load the identity key (made on first start). */
  static async open(dataDir: string): Promise<SelfIssuer> {
    ensureKeysDir(dataDir);
    const file = join(dataDir, "keys", "identity-key.json");
    if (!exists(file)) {
      const { privateKey } = generateKeyPairSync("ed25519");
      writeSecret(file, JSON.stringify(privateKey.export({ format: "jwk" })));
    }
    const jwk = JSON.parse(
      readSecretFile(file, process.platform === "win32" ? undefined : process.getuid?.()),
    ) as JWK;
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d)
      throw new Error(ownerT()("server-access.identityKey.notEd25519", { file }));
    const privateKey = createPrivateKey({ key: jwk as any, format: "jwk" });
    const publicKey = createPublicKey(privateKey);
    const pub = publicKey.export({ format: "jwk" }) as JWK;
    const publicJwk = { kty: pub.kty!, crv: pub.crv!, x: pub.x! };
    const thumbprint = await calculateJwkThumbprint(publicJwk, "sha256");
    return new SelfIssuer(privateKey, publicKey, thumbprint, publicJwk);
  }
  /** Sign an access token (RFC 9068 `at+jwt`). */
  async sign(c: SelfClaims): Promise<{ token: string; jti: string; iat: number; exp: number }> {
    const iat = Math.floor(Date.now() / 1000),
      exp = iat + c.ttlS,
      jti = c.jti ?? newJti();
    const token = await new SignJWT({
      ...(c.extra ?? {}),
      client_id: c.clientId,
      scope: c.scope,
      ...(c.act ? { act: c.act } : {}),
    })
      .setProtectedHeader({ alg: "EdDSA", typ: ACCESS_TOKEN_TYP, kid: this.kid })
      .setIssuer(this.urn)
      .setSubject(c.sub)
      .setAudience(c.aud)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .setJti(jti)
      .sign(this.privateKey);
    return { token, jti, iat, exp };
  }
  /**
   * Sign a plain JWT (`typ: JWT`) — the RFC 8693 actor token and the
   * RFC 7523 client assertion. Never an access token: this Daisy's
   * verifier wants `at+jwt`, so neither is ever accepted by it.
   */
  async signJwt(claims: JWTPayload & { sub: string; aud: string }, ttlS: number): Promise<string> {
    const iat = Math.floor(Date.now() / 1000);
    const { sub, aud, ...rest } = claims;
    return new SignJWT(rest)
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: this.kid })
      .setIssuer(typeof claims.iss === "string" ? claims.iss : this.urn)
      .setSubject(sub)
      .setAudience(aud)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttlS)
      .setJti(newJti())
      .sign(this.privateKey);
  }
  /**
   * P4-01 (identity-card.md §2): sign this Daisy's identity card — a JWS
   * with exactly the header `{"alg":"EdDSA","typ":"daisy-card+jwt"}` over
   * the card's fields (contacts/card.ts builds them). Not a JWT access
   * token: no `iss` / `aud` / `exp`, and `typ` is not `at+jwt`, so no
   * verifier here ever takes a card for a credential.
   */
  async signCard(payload: Record<string, unknown>): Promise<string> {
    return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: "EdDSA", typ: IDENTITY_CARD_TYP })
      .sign(this.privateKey);
  }
  /**
   * P5-02 (packages/relay/PROTOCOL.md §4, ADR-143): the relay login proof —
   * a JWS with exactly `{"alg":"EdDSA","typ":"daisy-relay-proof+jwt"}` over
   * `{v, aud, nonce, key}` (relay protocol.ts `proofPayload`). Its `typ` is
   * no card's, token's or binding claim's: nothing here takes it as one.
   */
  async signRelayProof(payload: { v: 1; aud: string; nonce: string; key: { kty: "OKP"; crv: "Ed25519"; x: string } }): Promise<string> {
    return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: "EdDSA", typ: RELAY_PROOF_TYP })
      .sign(this.privateKey);
  }
  /**
   * P5-02 (ADR-100, a2a-usage.md §15.1): the TLS binding claim — exactly
   * `{"alg":"EdDSA","typ":"daisy-tls-binding+jwt"}` over `{v, id, spki,
   * iat, exp}` (packages/a2a-client/src/binding.ts verifies it).
   */
  async signTlsBinding(payload: { v: 1; id: string; spki: string[]; iat: number; exp: number }): Promise<string> {
    return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: "EdDSA", typ: TLS_BINDING_TYP })
      .sign(this.privateKey);
  }
  /** token.md §4.1 steps 1–6: header, key, signature, iss, aud, times. */
  async verify(token: string, o: VerifyOptions): Promise<VerifyResult> {
    const r = await verifyAccessToken(token, this.publicKey, {
      ...o,
      issuer: this.urn,
      algorithms: SELF_ALGORITHMS,
    });
    // Step 3: `kid` is this key's identity number (base32 only, D-40 ④).
    if (r.ok && r.token.kid !== this.kid) return { ok: false, why: "unknown_key" };
    return r;
  }
}
