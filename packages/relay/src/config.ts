/**
 * P5-01 (plan 7.6 "上限数值集中成配置", ADR-143 §5): every limit of the relay
 * in one table, with its default, and the loader for the config file and
 * environment. Nothing else in the relay hard-codes a number that protects it.
 */
import { KeyedError, pt } from "../../contracts/src/i18n-process.ts";
import { readFileSync } from "node:fs";

export const DEFAULT_LIMITS = {
  // -- the public port (443): every inbound TCP connection ------------------
  /** Open TCP connections on the public port, all together. */
  maxPublicConnections: 10_000,
  // "PerIp" limits count per source: an IPv4 address, or an IPv6 /64 — and,
  // for IPv6, also per /56 (× source56Factor) and per /48 (× source48Factor),
  // so a host with a whole prefix cannot multiply its share (review M1 / L2).
  /** Open TCP connections from one source, callers and Daisys alike (a claimed data connection counts for its Daisy instead). */
  maxConnectionsPerIp: 512,
  /** New TCP connections from one address: refill per second, and burst. */
  newConnectionsPerIpPerSec: 20,
  newConnectionsPerIpBurst: 100,
  /** The whole ClientHello must arrive within this (slowloris), counted from accept. */
  clientHelloTimeoutMs: 10_000,
  /** The largest ClientHello (all records together) the relay reads before giving up. */
  maxClientHelloBytes: 16_384,

  // -- the relay's own domain: control, data, presence ---------------------
  /** TLS handshake with the relay's own certificate must finish within this. */
  ownTlsHandshakeTimeoutMs: 10_000,
  /** HTTP request headers must arrive within this. */
  ownHeadersTimeoutMs: 10_000,
  /** Largest HTTP header block. */
  maxHeaderBytes: 8_192,
  /** HTTP requests and WebSocket upgrades on the relay's own domain from one address. */
  ownRequestsPerIpPerSec: 20,
  ownRequestsPerIpBurst: 100,

  // -- Daisys (control connections) ----------------------------------------
  /** Daisys online at once. */
  maxDaisys: 1_000,
  /** Daisys online from one source (a team behind one address). */
  maxDaisysPerIp: 128,
  /** Control connections that have not proved a key yet, all together. */
  maxUnauthenticatedControls: 256,
  /** …and from one source. */
  maxUnauthControlsPerIp: 8,
  /** The hello (proof) must arrive within this after the challenge. */
  helloTimeoutMs: 3_000,
  /** Largest control message (either way). */
  maxControlMessageBytes: 8_192,
  /** Control messages from one Daisy: per second, and burst. */
  controlMessagesPerSec: 20,
  controlMessagesBurst: 100,
  /** The relay pings each control connection this often; no pong by the next ping → closed. */
  pingIntervalMs: 20_000,

  // -- inbound streams (one per caller connection) -------------------------
  /** Streams (waiting + piped) for one Daisy at once. */
  maxStreamsPerDaisy: 64,
  /** Streams waiting for the Daisy's claim, for one Daisy. */
  maxPendingPerDaisy: 16,
  /** New inbound streams for one Daisy: per second, and burst. */
  opensPerDaisyPerSec: 20,
  opensPerDaisyBurst: 60,
  /** The Daisy must claim a stream within this (the caller waits this long at most). */
  claimTimeoutMs: 5_000,
  /** Largest data frame from a Daisy (it splits bigger writes). */
  maxDataFrameBytes: 65_536,
  /** Bytes one stream may have queued in one direction before the relay stops reading its source. */
  streamWindowBytes: 262_144,
  /** Bytes queued in the relay for all streams together (and held ClientHellos); over it, new streams are refused and sources paused. */
  maxBufferedBytes: 134_217_728,
  /** After one side of a stream closes, how long the other side gets to take what is queued. */
  streamCloseGraceMs: 5_000,
  /** Bytes one stream may carry, both directions together (the "request size" cap). */
  maxStreamBytes: 268_435_456,
  /** A stream with no bytes either way for this long is closed. */
  streamIdleTimeoutMs: 300_000,
  /** A stream lives at most this long. */
  maxStreamDurationMs: 3_600_000,
  /** Bytes per second for one Daisy, all its streams and both directions together. */
  bytesPerSecPerDaisy: 16_777_216,

  // -- bookkeeping ----------------------------------------------------------
  /** Sources remembered for the per-source limits (only idle ones are forgotten). */
  maxIpEntries: 100_000,
  /** IPv6 aggregates: a /56 gets this many times a source's limits, a /48 this many. */
  source56Factor: 4,
  source48Factor: 16,
  /** Refusals caused by unauthenticated peers are counted and logged as totals this often (L3). */
  refusalLogIntervalMs: 60_000,
};

export type Limits = typeof DEFAULT_LIMITS;

export interface RelayConfig {
  /** The relay's own domain; Daisys get `<subdomain>.<domain>`. */
  domain: string;
  listen: { host: string; port: number };
  /** PEM files of the relay's own certificate (for `domain` only — never a wildcard). */
  tls: { cert: string; key: string };
  limits: Limits;
  logLevel: "debug" | "info" | "warn" | "error";
  /** If set, only these identities (52-character identity numbers) may register. */
  allowIdentities: string[] | null;
}

/** A config the relay cannot run with: a message key (said in this process's language). */
export class ConfigError extends KeyedError {}

/** A DNS name the relay can serve under: lowercase, at least two labels, room for a 32-character label in front. */
export function checkDomain(d: unknown): string {
  if (typeof d !== "string") throw new ConfigError("relay.config.domainType");
  const s = d.toLowerCase();
  if (s !== d) throw new ConfigError("relay.config.domainCase");
  if (!/^(?=.{1,219}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(s))
    throw new ConfigError("relay.config.domainInvalid");
  return s;
}

export function checkLimits(raw: unknown): Limits {
  const out: Limits = { ...DEFAULT_LIMITS };
  if (raw === undefined) return out;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("relay.config.limitsType");
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in DEFAULT_LIMITS)) throw new ConfigError("relay.config.limitsUnknown", { key: k });
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new ConfigError("relay.config.limitsInteger", { key: k });
    (out as Record<string, number>)[k] = v;
  }
  if (out.maxPendingPerDaisy > out.maxStreamsPerDaisy)
    throw new ConfigError("relay.config.pendingOverStreams");
  return out;
}

const LEVELS = ["debug", "info", "warn", "error"] as const;

/**
 * The config: a JSON file (`--config`, or `DAISY_RELAY_CONFIG`), then the
 * environment on top: `DAISY_RELAY_DOMAIN`, `DAISY_RELAY_HOST`,
 * `DAISY_RELAY_PORT`, `DAISY_RELAY_TLS_CERT`, `DAISY_RELAY_TLS_KEY`,
 * `DAISY_RELAY_LOG_LEVEL`. Limits only come from the file.
 */
export function loadConfig(file: string | undefined, env: Record<string, string | undefined>): RelayConfig {
  let j: Record<string, any> = {};
  const path = file ?? env.DAISY_RELAY_CONFIG;
  if (path) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new ConfigError("relay.config.unreadable", { path, code: (e as NodeJS.ErrnoException).code ?? "error" });
    }
    try {
      j = JSON.parse(text);
    } catch {
      throw new ConfigError("relay.config.notJson", { path });
    }
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new ConfigError("relay.config.notObject");
    for (const k of Object.keys(j))
      if (!["domain", "listen", "tls", "limits", "logLevel", "allowIdentities"].includes(k))
        throw new ConfigError("relay.config.unknownKey", { key: k });
  }
  const domain = checkDomain(env.DAISY_RELAY_DOMAIN ?? j.domain);
  const host = env.DAISY_RELAY_HOST ?? j.listen?.host ?? "0.0.0.0";
  const portRaw = env.DAISY_RELAY_PORT ?? j.listen?.port ?? 443;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError("relay.config.port");
  if (typeof host !== "string" || !host) throw new ConfigError("relay.config.host");
  const cert = env.DAISY_RELAY_TLS_CERT ?? j.tls?.cert;
  const key = env.DAISY_RELAY_TLS_KEY ?? j.tls?.key;
  if (typeof cert !== "string" || typeof key !== "string" || !cert || !key)
    throw new ConfigError("relay.config.tlsMissing");
  const logLevel = env.DAISY_RELAY_LOG_LEVEL ?? j.logLevel ?? "info";
  if (!LEVELS.includes(logLevel)) throw new ConfigError("relay.config.logLevel", { levels: LEVELS.join(pt("relay.list.separator")) });
  return {
    domain,
    listen: { host, port },
    tls: { cert, key },
    limits: checkLimits(j.limits),
    logLevel,
    allowIdentities: checkAllow(j.allowIdentities),
  };
}

/** An operator allow-list: identity numbers (spaces allowed, any case) → normalised 52-character ids. */
export function checkAllow(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length === 0) throw new ConfigError("relay.config.allowEmpty");
  return raw.map((v) => {
    const id = typeof v === "string" ? v.replace(/\s+/g, "").toLowerCase() : "";
    if (!/^[a-z2-7]{52}$/.test(id))
      throw new ConfigError("relay.config.allowNotId", { value: String(v).slice(0, 60) });
    return id;
  });
}
