/**
 * P2-01 (token.md §2–§4, ADR-099, ADR-113): one token-verification
 * interface, two implementations —
 *
 * - `SelfIssuer` (self-issuer.ts): this Daisy signs and verifies with its
 *   own Ed25519 identity key (EdDSA only).
 * - `ExternalIssuer` (external-issuer.ts): an issuer the owner configured
 *   (with the PIN); its public keys (JWKS) are cached in the data
 *   directory and used offline, rotated by `kid` (EdDSA, ES256, RS256).
 *
 * Both answer the same thing for a token: valid, with its claims as
 * token.md §3 names them — or refused, with a reason for the audit only
 * (the caller is told 401 `invalid_token` and nothing more, §4.3).
 * The rules every access token must meet are here, once, so the two
 * cannot drift apart: `typ` at+jwt (RFC 9068), an allow-listed `alg`
 * (never `none`, never HS*), the required claims, `exp` / `iat` within
 * the clock skew, `exp - iat` within the caller's bound, `aud` exact.
 */
import { decodeJwt, decodeProtectedHeader, errors, jwtVerify, type JWTPayload, type KeyObject } from "jose";
import { TOKEN_LIMITS } from "../../../../contracts/src/limits.ts";
import { ACCESS_TOKEN_TYP, UNSAFE_TEXT } from "../../../../a2a-client/src/constants.ts";

/**
 * P4-09 (ADR-128): `ACCESS_TOKEN_TYP` (RFC 9068 §2.1; jose compares it with
 * an `application/` prefix stripped), `IDENTITY_CARD_TYP`, `UNSAFE_TEXT` and
 * `THUMBPRINT_URN` live in packages/a2a-client (shared with the standalone
 * A2A MCP); re-exported here for the rest of Daisy.
 */
export {
  ACCESS_TOKEN_TYP,
  IDENTITY_CARD_TYP,
  THUMBPRINT_URN,
  UNSAFE_TEXT,
} from "../../../../a2a-client/src/constants.ts";

/** The longest subject / actor a principal carries (longer ones are cut). */
export const LABEL_MAX = 200;

/** The claims every access token carries (RFC 9068 §2.2, token.md §3). */
const REQUIRED = ["iss", "sub", "aud", "exp", "iat", "jti", "client_id", "scope"];

/** A valid token, as token.md §3 names its parts. */
export interface VerifiedToken {
  issuer: string;
  subject: string;
  audience: string[];
  jti: string;
  clientId: string;
  scopes: string[];
  /** RFC 8693: the AI actually acting (present → an AI acting for `subject`). */
  act?: { sub: string; name?: string };
  iat: number;
  exp: number;
  kid: string;
  alg: string;
  claims: JWTPayload;
}

/** Why a token was refused — for the audit, never for the caller. */
export type Rejection =
  | "malformed"
  | "bad_header"
  | "unknown_issuer"
  | "unknown_key"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "wrong_issuer"
  | "wrong_audience"
  | "bad_claims"
  | "too_long"
  /** P4-04 (P4-01 review): a contact's cross-Daisy token presented a second time. */
  | "replayed";

export type VerifyResult =
  | { ok: true; token: VerifiedToken }
  | { ok: false; why: Rejection };

export interface VerifyOptions {
  /** The audience this token must name (`aud`, exact match of one entry). */
  audience: string;
  /** The longest `exp - iat` accepted (seconds). */
  maxLifetimeS?: number;
}

/** The one interface (P2-01 item 1). */
export interface TokenVerifier {
  readonly kind: "self" | "external";
  /** The `iss` this verifier answers for. */
  readonly issuer: string;
  verify(token: string, o: VerifyOptions): Promise<VerifyResult>;
}

const JWT_SHAPE = /^[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*$/;

/** Looks like a compact JWS (three base64url parts). */
export const looksLikeJwt = (t: string) => t.length <= 8192 && JWT_SHAPE.test(t);

/**
 * The `iss` and header of a token, unverified — only to pick the verifier
 * (token.md §4: route by `iss`). Never trusted for anything else.
 */
export function peek(
  token: string,
): { iss: string; alg: string; kid: string | null; clientId: string | null } | null {
  if (!looksLikeJwt(token)) return null;
  try {
    const h = decodeProtectedHeader(token);
    const p = decodeJwt(token);
    if (typeof p.iss !== "string" || typeof h.alg !== "string") return null;
    return {
      iss: p.iss,
      alg: h.alg,
      kid: typeof h.kid === "string" ? h.kid : null,
      // P4-12: picks `daisy token`'s verifier among this Daisy's own tokens.
      clientId: typeof p.client_id === "string" ? p.client_id : null,
    };
  } catch {
    return null;
  }
}

/** `daisy:a daisy:b` → ["daisy:a", "daisy:b"] (RFC 6749 §3.3). */
export const scopesOf = (s: unknown): string[] =>
  typeof s === "string" ? [...new Set(s.split(" ").filter(Boolean))] : [];

/** Map jose's errors onto a reason (the caller never sees it). */
export function rejectionOf(e: unknown): Rejection {
  if (e instanceof errors.JWTExpired) return "expired";
  if (e instanceof errors.JWTClaimValidationFailed) {
    // A required claim that is absent (`iat` included) is a malformed set
    // of claims, not a token "not yet valid".
    if (e.reason === "missing") return "bad_claims";
    if (e.claim === "aud") return "wrong_audience";
    if (e.claim === "iss") return "wrong_issuer";
    if (e.claim === "nbf" || e.claim === "iat") return "not_yet_valid";
    return "bad_claims";
  }
  if (e instanceof errors.JWSSignatureVerificationFailed) return "bad_signature";
  if (e instanceof errors.JOSEAlgNotAllowed || e instanceof errors.JOSENotSupported) return "bad_header";
  if (e instanceof errors.JWKSNoMatchingKey) return "unknown_key";
  return "malformed";
}

/**
 * Verify `token` with `key` against the common rules, then shape the
 * result. `algorithms` is the caller's allow-list (the token's own `alg`
 * is never trusted).
 */
export async function verifyAccessToken(
  token: string,
  key: KeyObject | CryptoKey | Uint8Array,
  o: VerifyOptions & { issuer: string; algorithms: string[] },
): Promise<VerifyResult> {
  if (!looksLikeJwt(token)) return { ok: false, why: "malformed" };
  let payload: JWTPayload, header: { alg?: string; kid?: string };
  try {
    ({ payload, protectedHeader: header } = await jwtVerify(token, key as any, {
      algorithms: o.algorithms,
      typ: ACCESS_TOKEN_TYP,
      issuer: o.issuer,
      audience: o.audience,
      clockTolerance: TOKEN_LIMITS.clockSkewS,
      requiredClaims: REQUIRED,
    }));
  } catch (e) {
    return { ok: false, why: rejectionOf(e) };
  }
  return shape(payload, header, o);
}

/** The checks jose does not make, and the result's shape. */
export function shape(
  payload: JWTPayload,
  header: { alg?: string; kid?: string },
  o: VerifyOptions,
): VerifyResult {
  const now = Math.floor(Date.now() / 1000);
  const { iat, exp } = payload;
  if (typeof iat !== "number" || typeof exp !== "number") return { ok: false, why: "bad_claims" };
  // `iat` not in the future (jose only bounds it with maxTokenAge).
  if (iat > now + TOKEN_LIMITS.clockSkewS) return { ok: false, why: "not_yet_valid" };
  if (exp <= iat) return { ok: false, why: "bad_claims" };
  if (o.maxLifetimeS !== undefined && exp - iat > o.maxLifetimeS) return { ok: false, why: "too_long" };
  const p = payload as Record<string, unknown>;
  if (typeof p.sub !== "string" || !p.sub || typeof p.jti !== "string" || !p.jti)
    return { ok: false, why: "bad_claims" };
  if (typeof p.client_id !== "string" || typeof p.scope !== "string") return { ok: false, why: "bad_claims" };
  // Review M-2: who the token says — the person, the AI — reaches the
  // principal, the audit and (P4-03) the owner's cards: no control or
  // bidi characters there.
  if (UNSAFE_TEXT.test(p.sub)) return { ok: false, why: "bad_claims" };
  let act: VerifiedToken["act"];
  if (p.act !== undefined) {
    const a = p.act as Record<string, unknown> | null;
    if (!a || typeof a !== "object" || typeof a.sub !== "string" || !a.sub)
      return { ok: false, why: "bad_claims" };
    if (UNSAFE_TEXT.test(a.sub)) return { ok: false, why: "bad_claims" };
    if (a.name !== undefined && (typeof a.name !== "string" || UNSAFE_TEXT.test(a.name)))
      return { ok: false, why: "bad_claims" };
    act = { sub: a.sub, ...(typeof a.name === "string" ? { name: a.name } : {}) };
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud!];
  return {
    ok: true,
    token: {
      issuer: payload.iss!,
      subject: p.sub,
      audience: aud.map(String),
      jti: p.jti,
      clientId: p.client_id,
      scopes: scopesOf(p.scope),
      ...(act ? { act } : {}),
      iat,
      exp,
      kid: String(header.kid ?? ""),
      alg: String(header.alg ?? ""),
      claims: payload,
    },
  };
}
