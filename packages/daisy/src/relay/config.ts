/**
 * P5-02 (ADR-144 §1): the relay settings — the `relay` section of
 * config.json (ADR-102, 0600, written whole). Unreadable or malformed:
 * off (never more open).
 */
import { msg, type Msg } from "../app/errors.ts";
import { ownerT } from "../platform/language.ts";
import { isIP } from "node:net";
import { readConfigSection, writeConfigSection } from "../access/config.ts";

/** Let's Encrypt's production directory (ADR-100 B1: the default). */
export const DEFAULT_ACME_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";

export interface RelayConfig {
  enabled: boolean;
  /** `https://<domain>[:port]` — the relay's own address, normalized. */
  url: string;
  acme: { enabled: boolean; directory: string };
}

export const RELAY_OFF: RelayConfig = {
  enabled: false,
  url: "",
  acme: { enabled: true, directory: DEFAULT_ACME_DIRECTORY },
};

/** A DNS name (not an IP: a relay hands out subdomains of it). */
const DNS_RE = /^(?=.{1,190}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The relay's address as the owner wrote it (`relay.example`,
 * `https://relay.example:8443`) → `{ url, domain, port }`, or why not.
 * Only https, only a DNS name of two labels or more, no path / query /
 * credentials. The domain leaves room for the 32-character subdomain.
 */
export function parseRelayUrl(raw: string): { url: string; domain: string; port: number } | { error: Msg } {
  const t = String(raw ?? "").trim();
  if (!t) return { error: msg("server-relay.config.urlMissing") };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return { error: msg("server-relay.config.urlBad") };
  }
  if (u.protocol !== "https:") return { error: msg("server-relay.config.urlNotHttps") };
  if (u.username || u.password) return { error: msg("server-relay.config.urlCredentials") };
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) return { error: msg("server-relay.config.urlPath") };
  const domain = u.hostname.toLowerCase().replace(/\.$/, "");
  // A name, never an address (the URL parser turns `127.1` into 127.0.0.1): its last label has a letter.
  if (isIP(domain.replace(/^\[|\]$/g, "")) || !DNS_RE.test(domain) || !/[a-z]/.test(domain.split(".").pop()!))
    return { error: msg("server-relay.config.urlNotDomain") };
  const port = u.port ? Number(u.port) : 443;
  return { url: `https://${domain}${port === 443 ? "" : `:${port}`}`, domain, port };
}

/** An ACME directory URL: https, no credentials or fragment. */
export function checkAcmeDirectory(raw: string): Msg | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return msg("server-relay.config.acmeBad");
  }
  if (u.protocol !== "https:") return msg("server-relay.config.acmeNotHttps");
  if (u.username || u.password || u.hash) return msg("server-relay.config.acmeCredentials");
  return null;
}

export function readRelayConfig(dataDir: string): RelayConfig {
  const r = readConfigSection(dataDir, "relay") as any;
  if (!r || typeof r !== "object") return RELAY_OFF;
  const parsed = typeof r.url === "string" ? parseRelayUrl(r.url) : { error: msg("server-relay.config.urlMissing") };
  const dir = typeof r.acme?.directory === "string" && !checkAcmeDirectory(r.acme.directory) ? r.acme.directory : DEFAULT_ACME_DIRECTORY;
  return {
    enabled: r.enabled === true && !("error" in parsed),
    url: "error" in parsed ? "" : parsed.url,
    acme: { enabled: r.acme?.enabled !== false, directory: dir },
  };
}

export function writeRelayConfig(dataDir: string, c: RelayConfig): void {
  writeConfigSection(dataDir, "relay", c);
}

/**
 * The relay address callers use (identity card `addrs`, `kind: "relay"`):
 * `https://<first 32 characters of the identity number>.<domain>[:port]`
 * — null when the relay is off. Stable: the same key and relay give the
 * same address across reconnects and restarts.
 */
export function relayAddressOf(c: RelayConfig, identityId: string): string | null {
  if (!c.enabled) return null;
  const p = parseRelayUrl(c.url);
  if ("error" in p) return null;
  return `https://${identityId.slice(0, 32)}.${p.domain}${p.port === 443 ? "" : `:${p.port}`}`;
}

/**
 * Names no public CA issues for (RFC 2606 / RFC 6761 / RFC 6762): ACME is
 * not even tried for them, whatever the directory (review L-4) — the
 * tests' fake domain (`relay.test`) never reaches a CA. Only the tests'
 * in-process ACME stand-in is let through, by a tests-only switch
 * (createApp's `relay.transport.acme`, never set by main.ts).
 */
export const RESERVED_TLD = /(^|\.)(test|example|invalid|localhost|local|internal|home\.arpa)$/;
export function acmeUsable(domain: string, _directory: string, testStandIn = false): string | null {
  if (!testStandIn && RESERVED_TLD.test(domain)) return ownerT()("server-relay.config.reservedDomain", { domain });
  return null;
}
