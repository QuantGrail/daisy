/**
 * P4-09 (ADR-128): the A2A client and identity-card code shared by Daisy
 * and the standalone A2A MCP (`@daisy-ai/a2a-mcp`). Depends only on
 * `node:*`, `jose` and packages/contracts/src — never on the Daisy process.
 *
 * - net.ts    outbound connections (SSRF rules, pinned address, TLS check,
 *             no redirects, caps, time limits) — ADR-127 §4
 * - peer.ts   one other Daisy at one address: directory, agent card,
 *             SendMessage, GetTask, CancelTask — ADR-127 §3
 * - identity.ts / card.ts   identity numbers, identity cards: make, read
 *             and verify (identity-card.md §2–§4, ADR-120)
 * - token.ts  the per-request cross-Daisy access token (token.md §3 / §5)
 * - binding.ts  the TLS binding claim (P5-02, ADR-100 / ADR-144)
 */
export * from "./constants.ts";
export * from "./net.ts";
export * from "./peer.ts";
export * from "./identity.ts";
export * from "./card.ts";
export * from "./token.ts";
export * from "./binding.ts";
