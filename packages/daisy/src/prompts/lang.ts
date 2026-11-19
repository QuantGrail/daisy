/**
 * P6-24 (ADR-159 §6): the language a new session's prompts are written in
 * — the owner's language at the moment it is created (the owner setting,
 * else the system's, else English), among the languages Daisy ships
 * prompts for. Stored on the session (`Session.lang`) and kept for its
 * whole life: changing the setting reaches new sessions only.
 *
 * Loading this module also loads the packs from disk for the browser-safe
 * prompt builders in contracts (`i18n-node.ts` registers itself).
 */
import "../../../contracts/src/i18n-node.ts";
import { shippedPacks } from "../../../contracts/src/i18n-node.ts";
import type { Lang } from "../../../contracts/src/i18n.ts";
import { resolveLanguage } from "../platform/language.ts";

/** The language for a session created now. */
export function newSessionLang(dataDir: string | undefined): Lang {
  return resolveLanguage({ env: process.env, platform: process.platform, dataDir, packs: shippedPacks() }).lang;
}
