/**
 * P5-01 (ADR-100 A1 / C1 / D1, ADR-143): the relay.
 *
 * One public TCP port (443 in production). For each inbound connection the
 * relay reads the TLS ClientHello's server name and nothing else:
 *
 * - `<domain>` (the relay's own name): handed to the relay's own HTTPS
 *   server — control and data WebSockets for Daisys, the presence query.
 *   The only TLS the relay terminates.
 * - `<subdomain>.<domain>`, that Daisy online: the relay tells the Daisy on
 *   its control connection (`open`, with a one-time claim); the Daisy opens a
 *   data WebSocket with the claim in its upgrade request; from then on the
 *   relay copies bytes both ways (the ClientHello it read first) without
 *   looking at them. TLS runs end to end between caller and Daisy.
 * - anything else, or the Daisy not online: a TLS `unrecognized_name` alert at
 *   the handshake and close (D1). Nothing of the connection is kept.
 *
 * Stores nothing, judges no access (that is each Daisy's), no NAT traversal.
 * Every limit is in config.ts. Review round 1 (ADR-143 §9): per-source
 * shares on every pool, the claim checked before the upgrade, bounded
 * buffering with a global budget, aggregated logs for unauthenticated noise.
 */
import { randomBytes } from "node:crypto";
import https from "node:https";
import net from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { RELAY_COMMAND_NAME } from "../../contracts/src/names.ts";
import { DEFAULT_LIMITS, checkAllow, checkDomain, checkLimits, type Limits } from "./config.ts";
import { Sources, TokenBucket, plainIp } from "./limits.ts";
import { makeLogger, type Logger } from "./log.ts";
import { verifyProof } from "./proof.ts";
import {
  ALERT,
  CLAIM_HEADER,
  CLOSE,
  PATHS,
  PROTOCOL_VERSION,
  SECRET_RE,
  SUBDOMAIN_LENGTH,
  SUBDOMAIN_RE,
  type WelcomeMsg,
} from "./protocol.ts";
import { alertRecord, parseClientHello } from "./sni.ts";

export interface RelayOptions {
  /** The relay's own domain (`relay.example`). */
  domain: string;
  host?: string;
  /** 0 = any free port (tests). */
  port: number;
  /** PEM of the relay's own certificate and key (for `domain` only). */
  cert: string | Buffer;
  key: string | Buffer;
  limits?: Partial<Limits>;
  /** If set, only these identity numbers may register (operator allow-list). */
  allowIdentities?: string[] | null;
  logger?: Logger;
}

/** Counts only — what the relay holds right now (tests and operators). */
export interface RelayState {
  /** Subdomains with a Daisy online. */
  online: string[];
  /** Subdomains the relay has any record of (online, or streams still running). */
  known: number;
  pending: number;
  /** Streams not yet torn down (closing ones included). */
  streams: number;
  /** Bytes of ClientHellos held while waiting for a claim. */
  heldBytes: number;
  /** Bytes queued inside the relay for streams (its queues, socket and WebSocket buffers). */
  bufferedBytes: number;
  /** Of those, the bytes in the relay's own queues — what counts against `maxBufferedBytes`. */
  budgetBytes: number;
  publicConnections: number;
  unauthenticatedControls: number;
  ipEntries: number;
  /** Refusals since the last aggregated log line, by reason. */
  refusals: Record<string, number>;
}

export interface Relay {
  readonly port: number;
  readonly domain: string;
  readonly limits: Limits;
  state(): RelayState;
  /** Replace the relay's own certificate (SIGHUP). */
  setTls(cert: string | Buffer, key: string | Buffer): void;
  /** Stop: Daisys are told 1012 (restart) and everything is closed. */
  close(): Promise<void>;
}

interface Sub {
  name: string;
  session: Session | null;
  pending: Set<Pending>;
  streams: Set<Stream>;
  opens: TokenBucket;
  bytes: TokenBucket;
}

interface Session {
  ws: WebSocket;
  sub: Sub;
  ip: string;
  alive: boolean;
  msgs: TokenBucket;
  /** Releases this Daisy's slot in its source's `maxDaisysPerIp`. */
  unsource: () => void;
}

interface Pending {
  claim: string;
  n: number;
  sub: Sub;
  socket: net.Socket;
  buf: Buffer | null;
  ip: string;
  timer: NodeJS.Timeout;
}

interface Stream {
  n: number;
  sub: Sub;
  socket: net.Socket;
  ws: WebSocket;
  inBytes: number;
  outBytes: number;
  started: number;
  closed: boolean;
  life: NodeJS.Timeout;
  queued: () => number;
}

/** A public connection handed to the relay's own HTTPS server. */
interface OwnConn {
  ip: string;
  /** Releases its slot in the source's connection count. */
  unsource: () => void;
  deadline: NodeJS.Timeout;
}

const noop = () => {};
// Node's timers (the DOM typings in this repo would make them numbers).
const later = (fn: (...a: unknown[]) => void, ms: number) => setTimeout(fn, ms) as unknown as NodeJS.Timeout;
const every = (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as NodeJS.Timeout;

/** Close politely, then for sure: a peer that never answers the close frame cannot hold a slot. */
function shut(ws: WebSocket, code: number, reason: string) {
  try {
    ws.close(code, reason);
  } catch {
    /* already closing */
  }
  later(() => ws.terminate(), 1000).unref();
}

/** The relay-wide byte budget (review M2). */
class Budget {
  used = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}
  over(extra = 0) {
    return this.used + extra > this.max;
  }
  add(n: number) {
    this.used += n;
  }
  sub(n: number) {
    this.used -= n;
    if (!this.over() && this.waiters.length) {
      const w = this.waiters;
      this.waiters = [];
      for (const f of w) f();
    }
  }
  /** Call `f` once the budget is no longer exceeded. */
  wait(f: () => void) {
    if (!this.over()) f();
    else this.waiters.push(f);
  }
}

/**
 * One direction of a stream. Writes chunks in order, each when the Daisy's
 * byte rate (bytesPerSecPerDaisy) allows and the destination is not
 * backed up (`blocked`, then `onDrain`). Holds the source while more than a
 * window is queued here or the relay-wide budget is spent; counts what it
 * queues against the budget.
 */
class Paced {
  private q: { b: Buffer; at: number }[] = [];
  private bytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private held = false;
  private waitingBudget = false;
  private stopped = false;
  private onEmpty: (() => void) | null = null;
  constructor(
    private readonly o: {
      bucket: TokenBucket;
      budget: Budget;
      window: number;
      write: (b: Buffer) => void;
      blocked: () => boolean;
      onDrain: (f: () => void) => void;
      hold: () => void;
      release: () => void;
    },
  ) {}
  get queued() {
    return this.bytes;
  }
  push(b: Buffer) {
    if (this.stopped) return;
    const delay = this.o.bucket.reserve(b.length);
    if (delay === 0 && this.q.length === 0 && !this.draining && !this.o.blocked()) return this.o.write(b);
    this.q.push({ b, at: Date.now() + delay });
    this.bytes += b.length;
    this.o.budget.add(b.length);
    this.check();
    this.pump();
  }
  private pump() {
    if (this.stopped || this.timer || this.draining) return;
    while (this.q.length) {
      if (this.o.blocked()) {
        this.draining = true;
        this.o.onDrain(() => {
          this.draining = false;
          this.pump();
        });
        break;
      }
      const wait = this.q[0]!.at - Date.now();
      if (wait > 0) {
        this.timer = later(() => {
          this.timer = null;
          this.pump();
        }, wait);
        break;
      }
      const x = this.q.shift()!;
      this.bytes -= x.b.length;
      this.o.budget.sub(x.b.length);
      this.o.write(x.b);
    }
    this.check();
    if (!this.q.length && this.onEmpty) {
      const f = this.onEmpty;
      this.onEmpty = null;
      f();
    }
  }
  /** Hold or release the source. */
  private check() {
    if (this.stopped) return;
    const tooMuch = this.bytes > this.o.window || this.o.budget.over();
    if (tooMuch && !this.held) {
      this.held = true;
      this.o.hold();
    }
    if (!this.held) return;
    if (this.o.budget.over()) {
      if (!this.waitingBudget) {
        this.waitingBudget = true;
        this.o.budget.wait(() => {
          this.waitingBudget = false;
          this.check();
        });
      }
    } else if (this.bytes <= this.o.window / 2) {
      this.held = false;
      this.o.release();
    }
  }
  /** Run `f` once everything queued is written. */
  whenEmpty(f: () => void) {
    if (!this.q.length) f();
    else this.onEmpty = f;
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.o.budget.sub(this.bytes);
    this.q = [];
    this.bytes = 0;
    this.onEmpty = null;
  }
}

function parseMsg(data: RawData, isBinary: boolean): Record<string, unknown> | null {
  if (isBinary) return null;
  try {
    const v = JSON.parse(data.toString());
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export async function startRelay(opts: RelayOptions): Promise<Relay> {
  const domain = checkDomain(opts.domain);
  const L: Limits = checkLimits({ ...opts.limits });
  const allow = opts.allowIdentities ? new Set(checkAllow(opts.allowIdentities)) : null;
  const log = opts.logger ?? makeLogger("info");
  const subs = new Map<string, Sub>();
  const claims = new Map<string, Pending>();
  const publicSockets = new Set<net.Socket>();
  const controls = new Set<WebSocket>();
  /** Own-domain connections by `<remote address>|<remote port>` (the TLS socket shares them). */
  const ownConns = new Map<string, OwnConn>();
  const budget = new Budget(L.maxBufferedBytes);
  const refusals = new Map<string, number>();
  let online = 0;
  let unauth = 0;
  let heldBytes = 0;
  let serial = 0;
  let closing = false;

  const sources = new Sources(L.maxIpEntries, [1, L.source56Factor, L.source48Factor], {
    newConn: [L.newConnectionsPerIpPerSec, L.newConnectionsPerIpBurst],
    own: [L.ownRequestsPerIpPerSec, L.ownRequestsPerIpBurst],
  });

  /**
   * A refusal an unauthenticated peer can cause at will (review L3): one
   * debug line, and a count that is logged as a total every
   * `refusalLogIntervalMs` at info. Never at info per event.
   */
  const refused = (ev: string, reason: string, f: Record<string, string | number> = {}) => {
    refusals.set(reason, (refusals.get(reason) ?? 0) + 1);
    log.debug(ev, { reason, ...f });
  };

  const subOf = (name: string): Sub => {
    let s = subs.get(name);
    if (!s) {
      s = {
        name,
        session: null,
        pending: new Set(),
        streams: new Set(),
        opens: new TokenBucket(L.opensPerDaisyPerSec, L.opensPerDaisyBurst),
        bytes: new TokenBucket(L.bytesPerSecPerDaisy, L.bytesPerSecPerDaisy),
      };
      subs.set(name, s);
    }
    return s;
  };
  const release = (s: Sub) => {
    if (!s.session && s.pending.size === 0 && s.streams.size === 0) subs.delete(s.name);
  };

  /** Refuse at the handshake with a TLS alert (D1), keep nothing, close. */
  function refuse(socket: net.Socket, alert: number) {
    socket.removeAllListeners("data");
    try {
      socket.end(alertRecord(alert));
    } catch {
      /* gone */
    }
    socket.resume(); // whatever else arrives is discarded
    later(() => socket.destroy(), 2000).unref();
  }

  // ---------------------------------------------------------------------
  // The relay's own HTTPS server (its own domain only).
  // ---------------------------------------------------------------------
  const own = https.createServer(
    {
      cert: opts.cert,
      key: opts.key,
      minVersion: "TLSv1.2",
      handshakeTimeout: L.ownTlsHandshakeTimeoutMs,
      headersTimeout: L.ownHeadersTimeoutMs,
      requestTimeout: L.ownHeadersTimeoutMs * 3,
      maxHeaderSize: L.maxHeaderBytes,
    },
    onRequest,
  );
  own.on("secureConnection", (ts) => {
    const c = ownConns.get(peerKey(ts.remoteAddress, ts.remotePort));
    if (!c) return void ts.destroy();
    clearTimeout(c.deadline);
    c.deadline = later(() => {
      refused("own.refused", "head_deadline", { ip: c.ip });
      ts.destroy();
    }, L.ownHeadersTimeoutMs);
  });
  own.on("tlsClientError", (_e, s) => s.destroy());
  own.on("clientError", (_e, s) => s.destroy());
  own.on("upgrade", onUpgrade);

  const wssControl = new WebSocketServer({
    noServer: true,
    maxPayload: L.maxControlMessageBytes,
    perMessageDeflate: false,
    clientTracking: false,
  });
  const wssData = new WebSocketServer({
    noServer: true,
    maxPayload: L.maxDataFrameBytes,
    perMessageDeflate: false,
    clientTracking: false,
  });

  const peerKey = (addr: string | undefined, port: number | undefined) => `${addr}|${port}`;
  /**
   * The request head is complete: stop the connection's deadline (TLS
   * handshake + head, absolute — Node checks headersTimeout only on servers
   * that listen themselves, and handshakeTimeout is not absolute).
   */
  const ownConnOf = (req: IncomingMessage): OwnConn | undefined => {
    const c = ownConns.get(peerKey(req.socket.remoteAddress, req.socket.remotePort));
    if (c) clearTimeout(c.deadline);
    return c;
  };
  const ipOfReq = (req: IncomingMessage) => plainIp(req.socket.remoteAddress);

  function onRequest(req: IncomingMessage, res: ServerResponse) {
    ownConnOf(req);
    const ip = ipOfReq(req);
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-length": Buffer.byteLength(text),
        connection: "close",
      });
      res.end(req.method === "HEAD" ? undefined : text);
    };
    if (!sources.take(ip, "own")) {
      refused("own.refused", "rate_limited", { ip });
      return send(429, { error: "rate_limited" });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: "method_not_allowed" });
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === PATHS.info)
      return send(200, { v: PROTOCOL_VERSION, relay: RELAY_COMMAND_NAME, protocols: [PROTOCOL_VERSION], domain });
    if (path.startsWith(PATHS.presencePrefix)) {
      const label = path.slice(PATHS.presencePrefix.length);
      if (!SUBDOMAIN_RE.test(label)) return send(400, { error: "bad_subdomain" });
      return send(200, { v: PROTOCOL_VERSION, subdomain: label, online: !!subs.get(label)?.session });
    }
    return send(404, { error: "not_found" });
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const conn = ownConnOf(req);
    socket.on("error", noop);
    const ip = ipOfReq(req);
    const no = (status: string, reason: string) => {
      refused("upgrade.refused", reason, { ip });
      socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      later(() => socket.destroy(), 1000).unref();
    };
    if (closing) return no("503 Service Unavailable", "closing");
    // Only Daisys connect here, never web pages (a page could otherwise make
    // its visitors' browsers hold control slots).
    if (req.headers.origin !== undefined) return no("403 Forbidden", "origin");
    const path = (req.url ?? "/").split("?")[0];

    if (path === PATHS.data) {
      // The claim is checked before the upgrade: there is no pool of
      // unclaimed data connections to fill (review M1).
      const claim = req.headers[CLAIM_HEADER];
      const p = typeof claim === "string" && SECRET_RE.test(claim) ? claims.get(claim) : undefined;
      if (!p || !p.buf) {
        // Guessing costs the address its request budget.
        if (!sources.take(ip, "own")) return no("429 Too Many Requests", "rate_limited");
        return no("404 Not Found", "unknown_claim");
      }
      // One use: gone from the table before anything else happens.
      claims.delete(p.claim);
      clearTimeout(p.timer);
      // A claimed data connection belongs to its Daisy, not to its address
      // (review M3): its stream counts under maxStreamsPerDaisy, so it gives
      // back its slot and its new-connection token on the address.
      if (conn) {
        conn.unsource();
        sources.refund(conn.ip, "newConn");
      }
      let upgraded = false;
      socket.once("close", () => {
        // The WebSocket handshake failed: the caller is refused.
        if (!upgraded && p.sub.pending.has(p)) dropPending(p, ALERT.internalError);
      });
      wssData.handleUpgrade(req, socket, head, (ws) => {
        upgraded = true;
        p.sub.pending.delete(p);
        startStream(p, ws);
      });
      return;
    }

    if (!sources.take(ip, "own")) return no("429 Too Many Requests", "rate_limited");
    if (path === PATHS.control) {
      if (unauth >= L.maxUnauthenticatedControls) return no("503 Service Unavailable", "unauthenticated_full");
      const unsource = sources.admit(ip, "unauth", L.maxUnauthControlsPerIp);
      if (!unsource) return no("429 Too Many Requests", "unauthenticated_per_source");
      unauth++; // counted from here, before the handshake completes
      let counted = true;
      const uncount = () => {
        if (!counted) return;
        counted = false;
        unauth--;
        unsource();
      };
      socket.once("close", uncount);
      wssControl.handleUpgrade(req, socket, head, (ws) => onControl(ws, ip, uncount));
      return;
    }
    no("404 Not Found", "not_found");
  }

  // ---------------------------------------------------------------------
  // Control connections: challenge → proof → online.
  // ---------------------------------------------------------------------
  function onControl(ws: WebSocket, ip: string, uncount: () => void) {
    ws.on("error", noop);
    controls.add(ws);
    const nonce = randomBytes(32).toString("base64url");
    let state: "wait" | "verifying" | "online" | "done" = "wait";
    let session: Session | null = null;
    const timer = later(() => {
      refused("control.refused", "hello_timeout", { ip });
      state = "done";
      uncount();
      shut(ws, CLOSE.timeout, "hello timeout");
    }, L.helloTimeoutMs);
    ws.send(JSON.stringify({ t: "challenge", v: PROTOCOL_VERSION, nonce, aud: domain }));

    ws.on("close", () => {
      clearTimeout(timer);
      uncount();
      controls.delete(ws);
      if (session) dropSession(session);
    });

    const fail = (code: number, why: string, text: string) => {
      state = "done";
      uncount();
      refused("control.refused", why, { ip });
      shut(ws, code, text);
    };

    ws.on("message", async (data, isBinary) => {
      if (state === "online") return onControlMessage(session!, data, isBinary);
      if (state !== "wait") {
        // A second message before the answer, or after a refusal.
        return fail(CLOSE.protocol, "two_hellos", "one hello only");
      }
      state = "verifying";
      const m = parseMsg(data, isBinary);
      if (!m || m.t !== "hello" || m.v !== PROTOCOL_VERSION) return fail(CLOSE.protocol, "bad_hello", "expected hello");
      const r = await verifyProof(m.proof, { domain, nonce });
      if (state !== "verifying" || ws.readyState !== WebSocket.OPEN) return;
      clearTimeout(timer);
      if (!r.ok) return fail(CLOSE.proofRefused, r.why, "proof refused");
      if (allow && !allow.has(r.id)) return fail(CLOSE.notAllowed, "not_allowed", "not allowed here");
      if (closing) return fail(CLOSE.restart, "closing", "relay restart");
      const sub = subs.get(r.sub);
      const again = !!sub?.session; // the same key reconnecting
      if (!again && online >= L.maxDaisys) {
        log.warn("relay.full", { count: online });
        return fail(CLOSE.full, "relay_full", "relay full");
      }
      // Registered Daisys per source (review M1): fresh keys cost nothing to
      // make, so each source gets a share. A key already online keeps its slot.
      const unsource = again ? sub!.session!.unsource : sources.admit(ip, "daisys", L.maxDaisysPerIp);
      if (!unsource) return fail(CLOSE.full, "daisys_per_source", "too many Daisys from this address");
      uncount();
      const s = subOf(r.sub);
      if (s.session) {
        // Only the holder of the same private key gets here (the proof says so):
        // the newest connection wins, so a Daisy whose old connection went
        // silently dead is back at once. The old connection's source slot moves
        // to the new one.
        const old = s.session;
        old.unsource = noop;
        s.session = null;
        online--;
        log.info("daisy.replaced", { sub: s.name, ip: old.ip });
        shut(old.ws, CLOSE.replaced, "replaced");
      }
      session = {
        ws,
        sub: s,
        ip,
        alive: true,
        msgs: new TokenBucket(L.controlMessagesPerSec, L.controlMessagesBurst),
        unsource,
      };
      s.session = session;
      online++;
      state = "online";
      ws.on("pong", () => {
        if (session) session.alive = true;
      });
      const welcome: WelcomeMsg = {
        t: "welcome",
        v: 1,
        subdomain: s.name,
        host: `${s.name}.${domain}`,
        id: r.id,
        limits: {
          claimTimeoutMs: L.claimTimeoutMs,
          maxStreams: L.maxStreamsPerDaisy,
          pingIntervalMs: L.pingIntervalMs,
          maxDataFrameBytes: L.maxDataFrameBytes,
        },
      };
      ws.send(JSON.stringify(welcome));
      log.info("daisy.online", { sub: s.name, ip, count: online });
    });
  }

  function onControlMessage(session: Session, data: RawData, isBinary: boolean) {
    if (!session.msgs.take()) {
      log.info("control.closed", { sub: session.sub.name, reason: "rate_limited" });
      return shut(session.ws, CLOSE.rateLimited, "too many messages");
    }
    const m = parseMsg(data, isBinary);
    if (!m || m.v !== PROTOCOL_VERSION) return shut(session.ws, CLOSE.protocol, "bad message");
    if (m.t === "reject") {
      const p = typeof m.claim === "string" ? claims.get(m.claim) : undefined;
      if (p && p.sub === session.sub) {
        log.debug("stream.refused", { sub: p.sub.name, n: p.n, reason: "daisy_rejected" });
        dropPending(p, ALERT.internalError);
      }
    }
    // Other types: ignored (a newer minor version may add some).
  }

  function dropSession(session: Session) {
    const s = session.sub;
    if (s.session !== session) return; // already replaced
    s.session = null;
    online--;
    session.unsource();
    // Nobody will claim these now: refuse their callers at once.
    for (const p of [...s.pending]) if (claims.get(p.claim) === p) dropPending(p, ALERT.unrecognizedName);
    log.info("daisy.offline", { sub: s.name, ip: session.ip, count: online });
    release(s);
  }

  // ---------------------------------------------------------------------
  // Inbound connections on the public port.
  // ---------------------------------------------------------------------
  const pub = net.createServer({ noDelay: true }, (socket) => {
    const ip = plainIp(socket.remoteAddress);
    if (closing || publicSockets.size >= L.maxPublicConnections) {
      refused("public.refused", "max_connections", { ip });
      return void socket.destroy();
    }
    if (!sources.take(ip, "newConn")) {
      refused("public.refused", "per_ip_rate", { ip });
      return void socket.destroy();
    }
    const unsource = sources.admit(ip, "conns", L.maxConnectionsPerIp);
    if (!unsource) {
      refused("public.refused", "per_ip_connections", { ip });
      return void socket.destroy();
    }
    publicSockets.add(socket);
    socket.once("close", () => {
      unsource();
      publicSockets.delete(socket);
    });
    socket.on("error", noop);

    let buf: Buffer = Buffer.alloc(0);
    // An absolute deadline: a ClientHello trickled a byte at a time still ends here.
    const timer = later(() => {
      refused("hello.refused", "timeout", { ip });
      socket.destroy();
    }, L.clientHelloTimeoutMs);
    const onData = (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const r = parseClientHello(buf, L.maxClientHelloBytes);
      if (r.state === "need") {
        if (buf.length > L.maxClientHelloBytes) {
          clearTimeout(timer);
          refused("hello.refused", "too_big", { ip });
          socket.destroy();
        }
        return;
      }
      socket.off("data", onData);
      socket.pause();
      clearTimeout(timer);
      if (r.state === "bad") {
        refused("hello.refused", r.reason, { ip });
        return void socket.destroy();
      }
      route(socket, buf, r.sni, ip, unsource);
      buf = Buffer.alloc(0) as Buffer;
    };
    socket.on("data", onData);
  });

  function route(socket: net.Socket, hello: Buffer, sni: string | null, ip: string, unsource: () => void) {
    if (sni === domain) {
      const key = peerKey(socket.remoteAddress, socket.remotePort);
      const c: OwnConn = {
        ip,
        unsource,
        // Absolute: the TLS handshake (a trickled handshake still ends here);
        // then, from the handshake's end, the request head (secureConnection).
        deadline: later(() => {
          refused("own.refused", "handshake_deadline", { ip });
          socket.destroy();
        }, L.ownTlsHandshakeTimeoutMs),
      };
      ownConns.set(key, c);
      socket.once("close", () => {
        clearTimeout(c.deadline);
        if (ownConns.get(key) === c) ownConns.delete(key);
      });
      socket.unshift(hello);
      own.emit("connection", socket);
      return;
    }
    const suffix = "." + domain;
    const label = sni && sni.endsWith(suffix) ? sni.slice(0, -suffix.length) : null;
    if (!label || label.length !== SUBDOMAIN_LENGTH || !SUBDOMAIN_RE.test(label)) {
      // Not a name this relay serves: say so, and do not log the name.
      refused("stream.refused", sni ? "unknown_name" : "no_sni", { ip });
      return refuse(socket, ALERT.unrecognizedName);
    }
    const s = subs.get(label);
    if (!s?.session) {
      refused("stream.refused", "offline", { ip });
      return refuse(socket, ALERT.unrecognizedName);
    }
    if (s.pending.size >= L.maxPendingPerDaisy || s.pending.size + s.streams.size >= L.maxStreamsPerDaisy) {
      refused("stream.refused", "busy", { ip, sub: label });
      return refuse(socket, ALERT.internalError);
    }
    if (!s.opens.take()) {
      refused("stream.refused", "rate_limited", { ip, sub: label });
      return refuse(socket, ALERT.internalError);
    }
    if (budget.over(heldBytes + hello.length)) {
      refused("stream.refused", "buffer_budget", { ip, sub: label });
      return refuse(socket, ALERT.internalError);
    }
    const claim = randomBytes(32).toString("base64url");
    const n = ++serial;
    const p: Pending = {
      claim,
      n,
      sub: s,
      socket,
      buf: hello,
      ip,
      timer: later(() => {
        refused("stream.refused", "claim_timeout", { sub: s.name, n });
        dropPending(p, ALERT.internalError);
      }, L.claimTimeoutMs),
    };
    s.pending.add(p);
    claims.set(claim, p);
    heldBytes += hello.length;
    socket.once("close", () => {
      if (s.pending.has(p)) dropPending(p, null);
    });
    s.session.ws.send(JSON.stringify({ t: "open", v: PROTOCOL_VERSION, n, claim, addr: ip }));
    log.debug("stream.open", { sub: s.name, n, ip });
  }

  function dropPending(p: Pending, alert: number | null) {
    if (claims.get(p.claim) === p) claims.delete(p.claim);
    clearTimeout(p.timer);
    p.sub.pending.delete(p);
    if (p.buf) heldBytes -= p.buf.length;
    p.buf = null;
    if (alert === null) p.socket.destroy();
    else refuse(p.socket, alert);
    release(p.sub);
  }

  // ---------------------------------------------------------------------
  // Streams: copy bytes both ways, bounded.
  // ---------------------------------------------------------------------
  function startStream(p: Pending, ws: WebSocket): Stream {
    const { socket, sub } = p;
    const hello = p.buf!;
    heldBytes -= hello.length;
    p.buf = null;
    ws.on("error", noop);
    const W = L.streamWindowBytes;
    let toCaller: Paced;
    let toDaisy: Paced;
    const s: Stream = {
      n: p.n,
      sub,
      socket,
      ws,
      inBytes: 0,
      outBytes: 0,
      started: Date.now(),
      closed: false,
      life: null as unknown as NodeJS.Timeout,
      queued: () => toCaller.queued + toDaisy.queued + socket.writableLength + ws.bufferedAmount,
    };
    // Counted (maxStreamsPerDaisy) until torn down, closing included (review M2).
    sub.streams.add(s);

    toCaller = new Paced({
      bucket: sub.bytes,
      budget,
      window: W,
      write: (b) => socket.write(b),
      blocked: () => socket.writableNeedDrain || socket.writableLength >= W,
      onDrain: (f) => socket.once("drain", f),
      hold: () => ws.pause(),
      release: () => ws.resume(),
    });
    toDaisy = new Paced({
      bucket: sub.bytes,
      budget,
      window: W,
      write: (b) =>
        ws.send(b, { binary: true }, (err) => {
          // An error while the data connection is closing is its close, handled there.
          if (err && ws.readyState === WebSocket.OPEN) end("daisy_error", "hard");
        }),
      blocked: () => ws.bufferedAmount >= W,
      onDrain: (f) => {
        // `ws` has no drain event: look again shortly.
        const look = () => (s.closed && torn ? undefined : ws.bufferedAmount < W ? f() : later(look, 10));
        later(look, 10);
      },
      hold: () => socket.pause(),
      release: () => socket.resume(),
    });

    let sockGone = false;
    let wsGone = false;
    let torn = false;
    let grace: NodeJS.Timeout | null = null;
    const teardown = () => {
      if (torn) return;
      torn = true;
      if (grace) clearTimeout(grace);
      clearTimeout(s.life);
      toCaller.stop();
      toDaisy.stop();
      sub.streams.delete(s);
      log.debug("stream.closed", {
        sub: sub.name,
        n: s.n,
        inBytes: s.inBytes,
        outBytes: s.outBytes,
        ms: Date.now() - s.started,
      });
      release(sub);
    };
    const cut = (code?: number, reason = "") => {
      toCaller.stop();
      toDaisy.stop();
      if (code) shut(ws, code, reason);
      else ws.terminate();
      socket.destroy();
      teardown();
    };

    /** hard: cut both now. daisyGone / callerGone: deliver what is queued to the other side (within the grace), then close it. */
    function end(reason: string, how: "hard" | "daisyGone" | "callerGone", code?: number) {
      if (s.closed) {
        if (how === "hard") cut(code, reason);
        return;
      }
      s.closed = true;
      log.debug("stream.ending", { sub: sub.name, n: s.n, reason });
      if (how === "hard") return cut(code, reason);
      grace = later(() => cut(), L.streamCloseGraceMs);
      if (how === "daisyGone") {
        toDaisy.stop();
        toCaller.whenEmpty(() => socket.end());
      } else {
        toCaller.stop();
        toDaisy.whenEmpty(() => {
          if (ws.readyState === WebSocket.OPEN) shut(ws, 1000, "");
        });
      }
    }
    s.life = later(() => end("max_duration", "hard", CLOSE.tooMuch), L.maxStreamDurationMs);

    const over = () => s.inBytes + s.outBytes > L.maxStreamBytes;

    // caller → Daisy (the ClientHello the relay read first, then the rest)
    const fromCaller = (chunk: Buffer) => {
      if (s.closed) return;
      s.inBytes += chunk.length;
      if (over()) return end("too_many_bytes", "hard", CLOSE.tooMuch);
      toDaisy.push(chunk);
    };
    fromCaller(hello);
    socket.on("data", fromCaller);
    socket.setTimeout(L.streamIdleTimeoutMs, () => end("idle", "hard"));
    socket.on("end", () => end("caller_closed", "callerGone"));
    socket.on("close", () => {
      sockGone = true;
      if (wsGone) teardown();
      else end("caller_closed", s.closed ? "callerGone" : "hard");
    });

    // Daisy → caller: binary frames only
    ws.on("message", (data, isBinary) => {
      if (s.closed) return;
      if (!isBinary) return end("text_frame", "hard", CLOSE.protocol);
      const b = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      s.outBytes += b.length;
      if (over()) return end("too_many_bytes", "hard", CLOSE.tooMuch);
      toCaller.push(b);
    });
    ws.on("close", () => {
      wsGone = true;
      if (sockGone) teardown();
      else end("daisy_closed", "daisyGone");
    });
    socket.resume();
    log.debug("stream.piped", { sub: sub.name, n: s.n });
    return s;
  }

  // ---------------------------------------------------------------------
  // Heartbeats, bookkeeping, start, stop.
  // ---------------------------------------------------------------------
  const ping = every(() => {
    for (const s of subs.values()) {
      const ses = s.session;
      if (!ses) continue;
      if (!ses.alive) {
        log.info("daisy.offline", { sub: s.name, reason: "no_pong" });
        ses.ws.terminate();
        continue;
      }
      ses.alive = false;
      try {
        ses.ws.ping();
      } catch {
        /* closing */
      }
    }
  }, L.pingIntervalMs);
  ping.unref();
  const sweep = every(() => sources.sweep(), 60_000);
  sweep.unref();
  const tally = every(() => {
    for (const [reason, count] of refusals) log.info("relay.refusals", { reason, count });
    refusals.clear();
  }, L.refusalLogIntervalMs);
  tally.unref();

  await new Promise<void>((resolve, reject) => {
    pub.once("error", reject);
    pub.listen({ host: opts.host ?? "0.0.0.0", port: opts.port }, () => {
      pub.off("error", reject);
      resolve();
    });
  });
  const port = (pub.address() as net.AddressInfo).port;
  log.info("relay.listening", { host: opts.host ?? "0.0.0.0", port, domain, version: PROTOCOL_VERSION });

  const allStreams = () => [...subs.values()].flatMap((s) => [...s.streams]);
  return {
    port,
    domain,
    limits: L,
    state: () => ({
      online: [...subs.values()].filter((s) => s.session).map((s) => s.name),
      known: subs.size,
      pending: claims.size,
      streams: allStreams().length,
      heldBytes,
      bufferedBytes: allStreams().reduce((a, s) => a + s.queued(), 0),
      budgetBytes: budget.used,
      publicConnections: publicSockets.size,
      unauthenticatedControls: unauth,
      ipEntries: sources.size,
      refusals: Object.fromEntries(refusals),
    }),
    setTls(cert, key) {
      own.setSecureContext({ cert, key });
    },
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(ping);
      clearInterval(sweep);
      clearInterval(tally);
      const closed = new Promise<void>((r) => pub.close(() => r()));
      for (const ws of controls) {
        try {
          ws.close(CLOSE.restart, "relay restart");
        } catch {
          /* closing */
        }
      }
      // A moment for the close frames to leave, then everything goes.
      await new Promise((r) => setTimeout(r, 100));
      for (const p of [...claims.values()]) dropPending(p, null);
      for (const st of allStreams()) st.ws.terminate();
      for (const ws of controls) ws.terminate();
      for (const sock of publicSockets) sock.destroy();
      own.closeAllConnections();
      own.close();
      await closed;
      log.info("relay.stopped", {});
    },
  };
}

export { DEFAULT_LIMITS };
