/**
 * P2-04 (ADR-115): the browser origins of external interfaces (an
 * organisation's web page, say) that may call this Daisy across origins — kept in
 * config.json's `uiOrigins` (0600), set by the owner with the PIN.
 *
 * A server-side interface (a Node process: no `Origin`, no
 * `Sec-Fetch-Site`) needs none of this; see guard.ts `crossSite`.
 *
 * What an origin may be: `https://host[:port]`, exactly (the
 * serialization a browser sends — lowercase, no default port, no path, no
 * trailing slash); `http://` only on this machine's loopback (localhost,
 * 127.0.0.1, [::1]) for development. Never `*`, `null`, a wildcard host,
 * credentials, a path, a query or a fragment.
 */
import { msg, type Msg } from "../app/errors.ts";
import { isIP } from "node:net";
import { readConfigSection, writeConfigSection } from "./config.ts";

export const UI_ORIGINS_KEY = "uiOrigins";
export const UI_ORIGINS_MAX = 16;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The origin as a browser serializes it, or why it is not allowed. Input is
 * the owner's text; the result is compared byte for byte with `Origin`.
 */
export function normalizeUiOrigin(raw: string): { origin: string } | { error: Msg } {
  const s = String(raw ?? "").trim();
  if (!s || s === "null" || s.includes("*"))
    return { error: msg("server-access.uiOrigin.notConcrete", { origin: s.slice(0, 80) }) };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { error: msg("server-access.uiOrigin.notUrl", { origin: s.slice(0, 80) }) };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { error: msg("server-access.uiOrigin.httpsOnly", { origin: s.slice(0, 80) }) };
  if (u.username || u.password) return { error: msg("server-access.uiOrigin.credentials", { origin: s.slice(0, 80) }) };
  // A path, query or fragment means the owner pasted a page, not an origin.
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || /[?#]/.test(s) || /\/./.test(s.replace(/^[a-z]+:\/\//i, "")))
    return { error: msg("server-access.uiOrigin.path", { origin: s.slice(0, 80) }) };
  const host = u.hostname.toLowerCase();
  if (!host) return { error: msg("server-access.uiOrigin.noHost", { origin: s.slice(0, 80) }) };
  if (u.protocol === "http:" && !LOOPBACK.has(host))
    return { error: msg("server-access.uiOrigin.plainHttp", { origin: s.slice(0, 80) }) };
  const bare = host.replace(/^\[|\]$/g, "");
  if (!isIP(bare) && !/^[a-z0-9.-]+$/.test(host)) return { error: msg("server-access.uiOrigin.hostBad", { origin: s.slice(0, 80) }) };
  return { origin: u.origin.toLowerCase() };
}

/** Normalize a whole list (duplicates dropped); the first bad one is the error. */
export function normalizeUiOrigins(list: readonly string[]): { origins: string[] } | { error: Msg } {
  if (list.length > UI_ORIGINS_MAX) return { error: msg("server-access.uiOrigin.tooMany", { max: UI_ORIGINS_MAX }) };
  const out: string[] = [];
  for (const raw of list) {
    const r = normalizeUiOrigin(raw);
    if ("error" in r) return r;
    if (!out.includes(r.origin)) out.push(r.origin);
  }
  return { origins: out };
}

/** What config.json says (anything malformed is dropped — never more open). */
export function readUiOrigins(dataDir: string): string[] {
  const raw = readConfigSection(dataDir, UI_ORIGINS_KEY);
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw.slice(0, UI_ORIGINS_MAX)) {
    if (typeof x !== "string") continue;
    const r = normalizeUiOrigin(x);
    // Only exactly what a save would have written counts.
    if ("origin" in r && r.origin === x && !out.includes(x)) out.push(x);
  }
  return out;
}

/** Kept in memory (the guard asks on every cross-origin request). */
export class UiOrigins {
  private list: string[];
  constructor(private dataDir: string) {
    this.list = readUiOrigins(dataDir);
  }
  get(): readonly string[] {
    return this.list;
  }
  has(origin: string): boolean {
    return this.list.includes(origin.toLowerCase());
  }
  /** Save (already normalized); an empty list removes the section. */
  set(origins: string[]) {
    writeConfigSection(this.dataDir, UI_ORIGINS_KEY, origins.length ? origins : undefined);
    this.list = [...origins];
  }
}
