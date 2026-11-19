/**
 * P0-06 / D-25: every name the product carries, in one place. Interface
 * text, command-line help, log prefixes and docs take the name from here;
 * renaming again means changing this file only.
 *
 * The package names are `@daisy-ai/*` (P1-02b, D-33). Values that still
 * say "harbor" — old storage keys, env vars (`HARBOR_*`), headers, paths —
 * are read only for compatibility, next to their new names (ADR-153,
 * ADR-155; each one is listed in tests/fixtures/legacy-names.json).
 *
 * Renamed by ADR-154 (P6-04): the text the model reads (prompts, tool
 * descriptions, wake headings; tests/fixtures/prompt-off-chain-base.json
 * pins it byte for byte) says Daisy; Daisy's tools are the MCP server
 * `daisy` / `daisy_<name>` (`TOOL_SERVER`, native-tools.ts — a native
 * conversation started before keeps `harbor`); the marks kept data is
 * recognised by are written new and read in both spellings
 * (`DAISY_FORK_TITLES` / `LEGACY_FORK_TITLES` in title.ts,
 * `SYSTEM_SENDER` in items.ts, `ASK_NEEDS_FILES` in ask-sidecar.ts) —
 * except INJECT_MARK (guide.ts): the organisation's boot core keys on
 * 「Harbor 注入」, so it is still written so (D-43) and read in both.
 *
 * Renamed by ADR-152 (P6-02; old values still read): the capability value
 * `"harbor"` → `"fallback"` (ADR-152), Daisy's scheduler items
 * (`source: "scheduler"`, ids `scheduler:<id>`, types `scheduler_bash` /
 * `scheduler_monitor`, `session.schedulerPending`), a rewind's
 * `files.via: "fallback"`.
 */

/** The product's name, as people read it. */
export const PRODUCT_NAME = "Daisy";

/** The command people type (`daisy …`). */
export const COMMAND_NAME = "daisy";

/** Prefix of every scope (5.11): `daisy:session:read`, `daisy:grant`, … */
export const SCOPE_PREFIX = `${COMMAND_NAME}:`;

/** A scope by its name: `scopeName("session:read")` → `daisy:session:read`. */
export const scopeName = (name: string) => `${SCOPE_PREFIX}${name}`;

/**
 * Name of the data directory (ADR-102, D-29; 12.4: not `~/.daisy`, which
 * `daisy-sdk` uses). The resolver is packages/daisy/src/platform/paths.ts
 * (`dataDir()`, in use since P1-04).
 */
export const DATA_DIR_NAME = "daisy";

/**
 * Prefix of the identifiers (URIs) of Daisy's extensions, e.g. the A2A
 * extension for 「办」. The full identifiers are P0-04's.
 */
export const EXTENSION_ID_PREFIX = `urn:${COMMAND_NAME}:`;

/** Prefix of the product's own log lines. */
export const LOG_PREFIX = `[${COMMAND_NAME}]`;

/** 【建议】The relay (5.9) and the standalone A2A MCP server (0.3 item 4). */
export const RELAY_NAME = `${PRODUCT_NAME} Relay`;
export const MCP_NAME = `${PRODUCT_NAME} MCP`;
/** P4-09 (ADR-128): the standalone A2A MCP's command (`daisy-mcp`, the npm package's `bin`). */
export const MCP_COMMAND_NAME = `${COMMAND_NAME}-mcp`;
/** P5-01 (ADR-143): the relay's command (`daisy-relay`, the npm package's `bin`). */
export const RELAY_COMMAND_NAME = `${COMMAND_NAME}-relay`;

