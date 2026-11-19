/**
 * P4-12 (总纲 5.6 「第三方 A2A 客户端」, 5.10 `daisy token`, 5.11,
 * docs/contracts/token.md §7, ADR-132): a token for an A2A client we did
 * not write — signed by this Daisy for one of the owner's contacts (or the
 * owner, `me`), carried as a standard `Authorization: Bearer`, good only at
 * the A2A entry (a visitor, whatever it says), still subject to the call
 * authorization (D-19).
 *
 * Issuing and revoking let someone in (5.11 「签发、吊销 daisy token」,
 * scopes.md §2): `letsIn: "visitor-token"` at the place P4-02 reserved for
 * it (`/api/tokens…`). Listing takes the PIN on the command line only (D-40 ①, `PIN_ON_CLI`), still `daisy:grant`.
 * A PIN reset revokes every one (`visitor-tokens`, T-9).
 *
 * packages/daisy/src/access/visitor-tokens.ts.
 */
import { z } from "zod";
import { TOKEN_LIMITS } from "../limits.ts";
import { cmd, group, json, route, PIN_ON_CLI } from "./route.ts";

/** One token for a third-party client, as the record keeps it (never the token itself). */
export interface VisitorToken {
  /** The token's `jti`; its `client_id` is `token:<jti>`. */
  jti: string;
  /** Who holding it is: a contact, or the owner (`me` — still only a visitor, token.md §7). */
  for: { kind: "contact" | "me"; contactId: string | null; name: string };
  note: string | null;
  createdAt: number;
  expiresAt: number;
  /** When it was revoked (by the owner, a removed contact, a PIN reset); null: not. */
  revokedAt: number | null;
  revokedWhy: "owner" | "contact_removed" | "pin_reset" | null;
  /** The last time a request carried it (to the minute); null: never. */
  lastUsedAt: number | null;
  state: "active" | "expired" | "revoked";
}

const TTL = /^(\d{1,7})([smhd]?)$/;
const UNIT: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };
/** `7d`, `12h`, `30m`, `3600` (seconds) → seconds; null when it does not read. */
export function ttlSeconds(v: string): number | null {
  const m = TTL.exec(v.trim());
  return m ? Number(m[1]) * UNIT[m[2]!]! : null;
}

export const TokenIssueSchema = z
  .object({
    for: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("api.field.tokens.for"),
    ttl: z
      .string()
      .max(20)
      .refine((v) => {
        const s = ttlSeconds(v);
        return s !== null && s >= TOKEN_LIMITS.visitorMinS && s <= TOKEN_LIMITS.visitorMaxS;
      }, "api.validation.tokenTtl")
      .optional()
      .describe("api.field.tokens.ttl"),
    note: z.string().trim().max(200).optional().describe("api.field.tokens.note"),
  })
  .strict();

export const tokens = group("grant", {
  tokenIssue: route({
    method: "POST",
    path: "/api/tokens",
    scope: "daisy:grant",
    letsIn: "visitor-token",
    body: TokenIssueSchema,
    output: json<{ token: string; record: VisitorToken; warning: string }>("{ token, record: VisitorToken, warning }"),
    errors: ["pin_required", "contact_not_found", "contact_ambiguous", "too_many_tokens"],
    cli: cmd("token issue"),
  }),
  tokenList: route({
    method: "GET",
    path: "/api/tokens",
    scope: "daisy:grant",
    ...PIN_ON_CLI,
    query: z
      .object({
        state: z.enum(["active", "all"]).default("active").describe("api.route.grant.tokenList.field.state"),
      })
      .strict(),
    output: json<{ tokens: VisitorToken[] }>("{ tokens: VisitorToken[] }"),
    cli: cmd("token list"),
  }),
  tokenRevoke: route({
    method: "DELETE",
    path: "/api/tokens/:jti",
    scope: "daisy:grant",
    letsIn: "visitor-token",
    params: z.object({ jti: z.string().min(1).max(64).describe("api.route.grant.tokenRevoke.field.jti") }).strict(),
    output: json<{ revoked: VisitorToken }>("{ revoked: VisitorToken }"),
    errors: ["pin_required", "token_not_found"],
    cli: cmd("token revoke"),
  }),
});
