/**
 * P4-01 (identity-card.md, ADR-120): the identity card. P4-09 (ADR-128)
 * moved making, reading and verifying cards to
 * packages/a2a-client/src/card.ts, so the standalone A2A MCP imports a card
 * with exactly the same checks; re-exported here for the rest of Daisy.
 */
import { readCard } from "../../../a2a-client/src/card.ts";

export * from "../../../a2a-client/src/card.ts";

/**
 * The routes read cards through this (tests hold an import inside its
 * await to show that a PIN reset meanwhile leaves nothing written — P4-02
 * review M-1, `commitLetIn`).
 */
export const cardReader = { read: readCard };
