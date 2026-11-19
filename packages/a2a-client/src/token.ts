/**
 * P4-09 (ADR-128, token.md §3 / §5): the access token a caller signs for
 * ONE request to another Daisy — the rules in one place:
 *
 * - `iss` = `sub` = the caller's own identity URN (a Daisy, or the
 *   standalone MCP, speaks only for its own owner: recognition does not pass
 *   on, 5.6 「不传递」);
 * - `aud` exactly the other side's URN (one string, never a list);
 * - `client_id` `a2a`, `scope` `daisy:invoke`;
 * - at most `TOKEN_LIMITS.a2aMaxS` (5 minutes) long — asking for more is an
 *   error, not silently shortened;
 * - a fresh `jti` every time (the other side takes each one once);
 * - header `alg` EdDSA, `typ` at+jwt, `kid` the caller's identity number
 *   (base32 of the thumbprint, 52 — D-40 ④; never the base64url form).
 *
 * Daisy signs through its `SelfIssuer` (P4-08, a2a/outgoing.ts) with the
 * same claims; the standalone MCP signs here. Tokens are never kept.
 */
import { randomBytes, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";
import { TOKEN_LIMITS } from "../../contracts/src/limits.ts";
import { KeyedError } from "../../contracts/src/i18n-process.ts";
import { ACCESS_TOKEN_TYP, A2A_CLIENT_ID, THUMBPRINT_URN } from "./constants.ts";
import { base32 } from "./identity.ts";

export interface A2ATokenClaims {
  /** The caller's own thumbprint (base64url, 43): `iss` = `sub` as its URN; `kid` is its base32 identity number. */
  thumbprint: string;
  /** The other side's identity URN. */
  aud: string;
  /** RFC 8693: the AI acting (`agent:…`, a display name). */
  act?: { sub: string; name?: string };
  ttlS: number;
}

export async function signA2AToken(key: KeyObject, c: A2ATokenClaims): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(c.thumbprint)) throw new KeyedError("a2a.token.thumbprint");
  if (typeof c.aud !== "string" || !c.aud.startsWith(THUMBPRINT_URN)) throw new KeyedError("a2a.token.aud");
  if (!Number.isInteger(c.ttlS) || c.ttlS < 1 || c.ttlS > TOKEN_LIMITS.a2aMaxS)
    throw new KeyedError("a2a.token.ttl", { max: TOKEN_LIMITS.a2aMaxS });
  const self = THUMBPRINT_URN + c.thumbprint;
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({
    client_id: A2A_CLIENT_ID,
    scope: "daisy:invoke",
    ...(c.act ? { act: c.act } : {}),
  })
    .setProtectedHeader({ alg: "EdDSA", typ: ACCESS_TOKEN_TYP, kid: base32(Buffer.from(c.thumbprint, "base64url")) })
    .setIssuer(self)
    .setSubject(self)
    .setAudience(c.aud)
    .setIssuedAt(iat)
    .setExpirationTime(iat + c.ttlS)
    .setJti(randomBytes(16).toString("base64url"))
    .sign(key);
}
