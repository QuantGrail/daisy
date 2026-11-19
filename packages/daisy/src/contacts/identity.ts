/**
 * P4-01 (identity-card.md §3, ADR-120): identity numbers. P4-09 (ADR-128)
 * moved the code to packages/a2a-client/src/identity.ts (shared with the
 * standalone A2A MCP); re-exported here for the rest of Daisy.
 */
export * from "../../../a2a-client/src/identity.ts";
