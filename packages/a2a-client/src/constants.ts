/**
 * P4-09 (ADR-128): constants of the identity contracts that both Daisy and
 * the standalone A2A MCP (`@daisy-ai/a2a-mcp`) need. Moved here from
 * packages/daisy/src/access/tokens/common.ts (which re-exports them), so
 * the MCP does not take any of the Daisy process with it.
 */

/** RFC 9278 / token.md §3: a Daisy's identity as a URN of its key's thumbprint. */
export const THUMBPRINT_URN = "urn:ietf:params:oauth:jwk-thumbprint:sha-256:";

/**
 * identity-card.md §2 (P4-01): the JWS `typ` of an identity card. Never an
 * access token's: every verifier wants `at+jwt`, so a card is never a
 * credential, and a card verifier wants this, so a token is never a card.
 */
export const IDENTITY_CARD_TYP = "daisy-card+jwt";

/** RFC 9068 §2.1: the `typ` of an access token. */
export const ACCESS_TOKEN_TYP = "at+jwt";

/**
 * P4-01 review M-2: characters that never belong in text shown to people
 * or written to the audit — C0 / C1 controls (ESC, BEL, newlines), the
 * Arabic letter mark, zero-width and directional marks (U+200B–U+200F),
 * line / paragraph separators and bidi embeddings / overrides
 * (U+2028–U+202E), word joiner, invisible operators and bidi isolates
 * (U+2060–U+206F), and the BOM / zero-width no-break space (U+FEFF).
 * A token whose subject or actor carries one is refused; a card whose
 * name, note or address does is refused.
 */
export const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;

/** token.md §3: the `client_id` of a token one Daisy (or the MCP) signs to call another. */
export const A2A_CLIENT_ID = "a2a";
