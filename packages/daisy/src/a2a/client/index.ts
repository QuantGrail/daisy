/**
 * P4-08 (ADR-127): the A2A client. P4-09 (ADR-128) moved net.ts and
 * peer.ts to packages/a2a-client (shared with the standalone A2A MCP; only
 * `node:*` and contracts/src). Daisy's own use of it (contacts, tokens, the
 * AI's calls, polling, waking) is ../outgoing.ts.
 */
export * from "../../../../a2a-client/src/net.ts";
export * from "../../../../a2a-client/src/peer.ts";
