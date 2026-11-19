/**
 * P1-03 (D-31, ADR-101, ADR-110): the two faces.
 *
 * - Local face: 127.0.0.1 only, plain HTTP, Fastify's own server (main.ts
 *   listens; the port by ports.ts). Takes the command-line credential, the
 *   AI's working credential and local web sessions.
 * - Outside face: off by default. When the owner turns it on (with the
 *   PIN), a second server listens where the owner said — TLS by default
 *   (self-signed, tls.ts), plain HTTP only on a private-network address —
 *   and hands its requests to the same router. Takes outside web sessions
 *   only (a one-time code from `daisy open --external`).
 *
 * Which face a request came in on is decided by the server that accepted
 * the connection (every socket is tagged when accepted), never by its
 * address or headers: a request relayed through this machine would look
 * like 127.0.0.1 (ADR-101 A2).
 *
 * P5-02 (ADR-101, ADR-144 §3): the relay's streams. A third server — TLS,
 * tagged `external`, never listening on any port — takes the byte streams
 * the relay link hands over (`injectRelay`) and gives its requests to the
 * same router as the outside face. It holds only the relay address's
 * certificate (SNI must be that address). The relay module gets
 * `injectRelay` and nothing else: no path to the local face's server.
 * Requests on it are the outside face's in every respect (credentials,
 * the terminal / shell / browse switches, Host and Origin checks).
 */
import { msg, type Msg } from "../app/errors.ts";
import { ownerT } from "../platform/language.ts";
import { createServer as createHttp, type Server } from "node:http";
import { createServer as createHttps } from "node:https";
import type { SecureContext } from "node:tls";
import type { Duplex } from "node:stream";
import { isIP } from "node:net";
import { networkInterfaces, hostname } from "node:os";
import { Socket as NetSocket, type Socket } from "node:net";
import type { FastifyInstance } from "fastify";
import { bindPort, type Face, type PortSource } from "./ports.ts";
import { readAccessConfig, writeAccessConfig, type ExternalConfig } from "./config.ts";
import { tlsMaterial, type TlsMaterial } from "./tls.ts";
import { FACE_LIMITS } from "../../../contracts/src/limits.ts";

export const FACE = Symbol.for("daisy.face");
/** P5-02: the caller's address the relay reported, on a relay stream (its word only). */
const RELAY_ADDR = Symbol.for("daisy.relayAddr");
/**
 * P5-02 review M-1: set on every TLS socket of the relay's server — the
 * request came through the relay. `remoteAddress` is never touched (it
 * would put relay callers in the local face's rate-limit buckets).
 */
export const VIA_RELAY = Symbol.for("daisy.viaRelay");

/** Did this request come through the relay? (review M-1 / L-3) */
export function viaRelay(req: any): boolean {
  const raw = req?.raw ?? req;
  return raw?.socket?.[VIA_RELAY] !== undefined;
}

/**
 * P5-02 review M-1: whose bucket a request goes in when no credential
 * names it — always per face, and a relay caller by the relay's word
 * (`relay:<addr>`, never the address of this machine's own sockets).
 */
export function rateIdOf(req: any): string {
  const raw = req?.raw ?? req;
  const relay = raw?.socket?.[VIA_RELAY];
  if (relay !== undefined) return `relay:${relay || "?"}`;
  return `${faceOf(req)}:ip:${req.ip}`;
}

/**
 * P5-03b (ADR-142 §经中转): where a request came from, as a device record
 * keeps it (`last_ip`): `relay:<addr>` through the relay (the relay's word
 * for the caller), `relay` when the relay said nothing usable — never this
 * machine's own end of the relay stream — else the socket's address.
 */
export function callerOf(req: any): string | null {
  const raw = req?.raw ?? req;
  const relay = raw?.socket?.[VIA_RELAY];
  if (relay !== undefined) return relay ? `relay:${relay}` : "relay";
  return typeof req?.ip === "string" && req.ip ? req.ip : null;
}

/** Tag every connection `server` accepts with its face. */
export function tagFace(server: Server, face: Face) {
  const tag = (s: Socket) => {
    (s as any)[FACE] = face;
  };
  server.on("connection", tag);
  server.on("secureConnection", tag);
}

/**
 * The face a request came in on: the tag its connection got when a
 * listener accepted it. Review L-2: an untagged real socket (a listener
 * nobody tagged) counts as the outside face — never more trusted; only a
 * request made inside this process (`app.inject`: light-my-request, no
 * net.Socket) is local.
 */
export function faceOf(req: any): Face {
  const raw = req.raw ?? req;
  const tag = raw.socket?.[FACE];
  if (tag === "local" || tag === "external") return tag;
  return raw.socket instanceof NetSocket ? "external" : "local";
}

/** Private-network addresses (where plain HTTP on the outside face is allowed). */
export function privateAddress(host: string): boolean {
  const v = isIP(host);
  if (v === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (v === 6) {
    const h = host.toLowerCase();
    return h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h);
  }
  return false;
}

const wildcard = (h: string) => h === "0.0.0.0" || h === "::";

/**
 * Why the outside face cannot listen as `c` says, or null (review L-1:
 * the route and every start — a hand-edited config.json included — check
 * the same). Plain HTTP only on a private-network or loopback address.
 */
export function validateExternal(c: { host: string; tls: boolean }): Msg | null {
  const host = c.host;
  if (!host || /[\s/]/.test(host) || host.toLowerCase() === "localhost")
    return msg("server-access.external.hostRequired");
  if (!isIP(host) && !/^[a-z0-9.-]+$/i.test(host)) return msg("server-access.external.hostBad");
  if (!c.tls && !privateAddress(host))
    return msg("server-access.external.plainHttp");
  return null;
}
const bracket = (h: string) => (isIP(h) === 6 ? `[${h}]` : h);

export interface FaceInfo {
  url: string | null;
  port: number | null;
  source: PortSource | null;
}

export class Faces {
  local: FaceInfo = { url: null, port: null, source: null };
  external: FaceInfo & {
    server?: Server;
    tls: boolean;
    host: string;
    /** P6-15: SHA-256 of the self-signed certificate it serves (colon hex); null when plain or off. */
    fingerprint: string | null;
  } = {
    url: null,
    port: null,
    source: null,
    tls: true,
    host: "",
    fingerprint: null,
  };
  private connections = new Set<Socket>();
  /** P5-02: the relay's TLS server (no listener) and its streams. */
  private relaySrv: Server | null = null;
  private relayConns = new Set<Duplex>();
  /**
   * P5-02: the relay address (`<sub>.<domain>`, its public port) and its
   * certificate, while a relay is on. P5-03b: what a browser makes of that
   * certificate and whether the link is up — what the pairing / one-time
   * links tell the owner.
   */
  relay: {
    host: string;
    port: number;
    context: () => SecureContext | null;
    /** P5-03b review L-4: what a phone's browser makes of the relay address's certificate. */
    certificate?: () => "trusted" | "custom-ca" | "self-signed";
    connected?: () => boolean;
  } | null = null;
  /** Told when a face starts / stops (runtime file). */
  onChange: () => void = () => {};
  /** P6-15 (ADR-158): told when the outside face made a new certificate (the audit). */
  onCertificate: (made: { reason: string; detail: string; fingerprint: string; host: string }) => void = () => {};
  constructor(
    private app: FastifyInstance,
    private dataDir: string,
  ) {}

  config(): ExternalConfig {
    return readAccessConfig(this.dataDir).external;
  }

  /** main.ts: the local face is listening on `port`. */
  setLocal(port: number, source: PortSource) {
    this.local = { url: `http://127.0.0.1:${port}`, port, source };
    this.onChange();
  }

  /** `Host` values a face answers to (DNS rebinding: anything else is refused). */
  hostAllowed(face: Face, host: string | undefined): boolean {
    if (!host) return false;
    const h = host.toLowerCase();
    if (face === "local") {
      // In-process requests (tests) carry `localhost:80` / no port.
      const p = this.local.port;
      return p === null
        ? /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h)
        : h === `127.0.0.1:${p}` || h === `localhost:${p}`;
    }
    // P5-02: the relay address (the port is the relay's public one; 443 may be left out).
    const r = this.relay;
    if (r && (h === r.host || h === `${r.host}:${r.port}` || (r.port === 443 && h === `${r.host}:443`))) return true;
    const e = this.external;
    if (!e.port) return false;
    const names = wildcard(e.host)
      ? [
          ...Object.values(networkInterfaces())
            .flat()
            .map((i) => i?.address)
            .filter((a): a is string => !!a)
            .map((a) => a.replace(/%.*$/, "")),
          hostname().toLowerCase(),
        ]
      : [e.host.toLowerCase()];
    return names.some((n) => h === `${bracket(n)}:${e.port}`);
  }

  /** The origin a page served by `face` has (its requests must carry exactly it). */
  originAllowed(face: Face, origin: string, host: string | undefined): boolean {
    if (!this.hostAllowed(face, host)) return false;
    const viaRelay = face === "external" && !!this.relay && host!.toLowerCase().split(":")[0] === this.relay.host;
    const scheme = face === "local" ? "http" : viaRelay || this.external.tls ? "https" : "http";
    return origin.toLowerCase() === `${scheme}://${host!.toLowerCase()}`;
  }

  /** Tests: the outside face's listener (null when off). */
  get externalServer(): Server | null {
    return this.external.server ?? null;
  }
  /** Is the outside face up? */
  get externalListening() {
    return !!this.external.server;
  }

  /**
   * Start the outside face with `c` (already validated). Restarts it if it
   * was up. Throws (port taken, bad address) without changing what is
   * saved.
   */
  async startExternal(c: ExternalConfig): Promise<void> {
    const bad = validateExternal(c);
    if (bad) {
      const t = ownerT();
      throw new Error(t("server-access.external.badSetting", { why: t.dynamic(bad.key, bad.params) }));
    }
    await this.stopExternal();
    const handler = (req: any, res: any) => this.app.routing(req, res);
    let m: TlsMaterial | null = null;
    if (c.tls) {
      m = tlsMaterial(this.dataDir, c.host);
      if (m.generated)
        try {
          this.onCertificate({ ...m.generated, fingerprint: m.fingerprint, host: c.host });
        } catch {}
    }
    const server: Server = m
      ? (createHttps({ cert: m.cert, key: m.key, minVersion: "TLSv1.2" }, handler) as any)
      : createHttp(handler);
    tagFace(server, "external");
    // P4-04 review M-2: a bounded number of connections, and TCP keep-alive
    // so a caller that vanished does not hold a socket (a blocking A2A send) forever.
    server.maxConnections = FACE_LIMITS.externalMaxConnections;
    server.on("connection", (s: Socket) => {
      s.setKeepAlive(true, FACE_LIMITS.tcpKeepAliveMs);
      this.connections.add(s);
      s.on("close", () => this.connections.delete(s));
    });
    // The live socket: the same upgrade path as the local face's server.
    server.on("upgrade", (req, socket, head) =>
      this.app.server.emit("upgrade", req, socket, head),
    );
    const listen = (port: number) =>
      new Promise<void>((ok, fail) => {
        server.once("error", fail);
        server.listen({ port, host: c.host }, () => {
          server.off("error", fail);
          ok();
        });
      });
    const r = await bindPort("external", { dataDir: this.dataDir, given: c.port }, listen);
    this.external = {
      server,
      tls: c.tls,
      host: c.host,
      port: r.port,
      source: r.source,
      fingerprint: m?.fingerprint ?? null,
      url: `${c.tls ? "https" : "http"}://${bracket(wildcard(c.host) ? hostname() : c.host)}:${r.port}`,
    };
    this.onChange();
  }

  async stopExternal(): Promise<void> {
    const s = this.external.server;
    this.external = { url: null, port: null, source: null, tls: true, host: "", fingerprint: null };
    if (!s) return;
    for (const c of this.connections) c.destroy();
    this.connections.clear();
    await new Promise<void>((ok) => s.close(() => ok()));
    this.onChange();
  }

  /**
   * P5-02: a stream the relay handed over → the relay TLS server (the
   * outside face). `addr` is the caller's address as the relay saw it
   * (its word only; used for per-address rate limits).
   */
  injectRelay(stream: Duplex, addr: string): void {
    if (!this.relay) return void stream.destroy();
    if (!this.relaySrv) {
      const handler = (req: any, res: any) => this.app.routing(req, res);
      const server: Server = createHttps(
        {
          minVersion: "TLSv1.2",
          ALPNProtocols: ["http/1.1"],
          SNICallback: (name: string, cb: (e: Error | null, c?: SecureContext) => void) => {
            const r = this.relay;
            const ctx = r && name.toLowerCase() === r.host ? r.context() : null;
            if (ctx) cb(null, ctx);
            else cb(new Error("not the relay address"));
          },
        },
        handler,
      ) as any;
      tagFace(server, "external");
      // Every TLS socket of this server came through the relay; the caller's
      // address the relay reported rides along under its own symbol (best
      // effort: Node's TLS keeps the wrapped stream on an internal
      // JSStreamSocket; absent, the relay callers share one bucket).
      server.on("secureConnection", (t: any) => {
        const a = t._handle?._parentWrap?.stream?.[RELAY_ADDR];
        t[VIA_RELAY] = typeof a === "string" ? a : "";
      });
      server.on("tlsClientError", () => {});
      server.on("upgrade", (req, socket, head) => this.app.server.emit("upgrade", req, socket, head));
      this.relaySrv = server;
    }
    if (this.relayConns.size >= FACE_LIMITS.externalMaxConnections) return void stream.destroy();
    (stream as any)[RELAY_ADDR] = addr;
    this.relayConns.add(stream);
    stream.once("close", () => this.relayConns.delete(stream));
    this.relaySrv.emit("connection", stream);
  }

  /** P5-02: the relay is off — its streams end now. */
  stopRelay(): void {
    this.relay = null;
    for (const c of this.relayConns) c.destroy();
    this.relayConns.clear();
  }

  /** Is the outside face reachable from elsewhere (listening, or through a relay)? */
  get externalReachable() {
    return this.externalListening || !!this.relay;
  }

  /** Save and apply the outside face's settings. */
  async setExternal(c: ExternalConfig): Promise<void> {
    if (c.enabled) await this.startExternal(c);
    else await this.stopExternal();
    writeAccessConfig(this.dataDir, (old) => ({ ...old, external: c }));
  }
}
