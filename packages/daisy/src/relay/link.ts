/**
 * P5-02 (packages/relay/PROTOCOL.md v1, ADR-143 「对 P5-02 的交代」,
 * ADR-144 §2–§4): this Daisy's side of the relay protocol.
 *
 * - Connects out to `wss://<domain>[:port]/v1/control` and keeps it; logs
 *   in by signing the relay's challenge with the identity key
 *   (SelfIssuer.signRelayProof); checks the welcome names this Daisy (its
 *   identity number, `<first 32 characters>.<domain>`).
 * - Reconnects on its own: base × 2^n, at most the cap, times 0.5–1; from
 *   the base again after a 1012 (relay restart); reset after a welcome. No
 *   ping for 2.5 × the relay's interval: the connection is dead — reconnect.
 * - Each `open`: a new data connection claims it (`openDataStream`, the one
 *   place that knows how a claim is presented), the caller's ClientHello
 *   is read (hello.ts): a CA's TLS-ALPN-01 check (`acme-tls/1`) gets the
 *   challenge certificate on its own TLS server and nothing else; anything
 *   else is handed to `inject` — the outside face's relay TLS server
 *   (ADR-101). This module never sees the local face.
 * - Never logged: the claim, the nonce, the proof.
 */
import { EventEmitter } from "node:events";
import { createServer as createTlsServer, type SecureContext } from "node:tls";
import type { Duplex } from "node:stream";
import { WebSocket, createWebSocketStream } from "ws";
import { CLAIM_HEADER, CLOSE, PATHS, PROTOCOL_VERSION, SECRET_RE, SUBDOMAIN_LENGTH, proofPayload, type ChallengeMsg, type OpenMsg, type WelcomeMsg } from "../../../relay/src/protocol.ts";
import { RELAY_LINK_LIMITS } from "../../../contracts/src/limits.ts";
import type { SelfIssuer } from "../access/tokens/self-issuer.ts";
import { readClientHello } from "./hello.ts";
import { log } from "../observe/log.ts";
import { ownerT } from "../platform/language.ts";

/** P6-23b: the link's state as the owner reads it (relay status), in the owner's language. */
const say = (key: string, params?: Record<string, unknown>) => ownerT().dynamic(`server-relay.link.${key}`, params);

export type LinkState = "off" | "connecting" | "connected" | "waiting" | "refused";
/** The link's limits, as numbers (tests shorten the backoff). */
export type LinkLimits = { -readonly [K in keyof typeof RELAY_LINK_LIMITS]: number };

export interface LinkTransport {
  /** Tests: the test CA behind the relay's own certificate. */
  ca?: string;
  /** Tests: a resolver standing in for DNS (the fake domain). */
  lookup?: (host: string, o: unknown, cb: (...a: unknown[]) => void) => void;
}

export interface LinkOptions {
  domain: string;
  port: number;
  self: SelfIssuer;
  /** Hand a caller's byte stream to the outside face (its relay TLS server). */
  inject: (stream: Duplex, meta: { n: number; addr: string }) => void;
  /** The TLS-ALPN-01 certificate for `host`, while a challenge is open. */
  challenge: (host: string) => SecureContext | null;
  transport?: LinkTransport;
  limits?: Partial<LinkLimits>;
}

export class RelayLink extends EventEmitter {
  readonly host: string;
  private L: LinkLimits;
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private pingMs: number;
  private streams = new Set<Duplex>();
  private data = new Set<WebSocket>();
  private challengeServer;
  state: LinkState = "off";
  since: number | null = null;
  lastError: string | null = null;
  private watchdogFired = false;
  retryAt: number | null = null;
  welcome: WelcomeMsg | null = null;

  constructor(private o: LinkOptions) {
    super();
    this.L = { ...RELAY_LINK_LIMITS, ...o.limits };
    this.pingMs = this.L.pingIntervalDefaultMs;
    this.host = `${o.self.kid.slice(0, SUBDOMAIN_LENGTH)}.${o.domain}`;
    // A CA's TLS-ALPN-01 check: the challenge certificate, `acme-tls/1`, then close (RFC 8737 §3).
    this.challengeServer = createTlsServer(
      {
        ALPNProtocols: ["acme-tls/1"],
        SNICallback: (name, cb) => {
          const ctx = name.toLowerCase() === this.host ? this.o.challenge(this.host) : null;
          if (ctx) cb(null, ctx);
          else cb(new Error("no challenge"));
        },
      },
      (s) => s.end(),
    );
    this.challengeServer.on("tlsClientError", () => {});
  }

  get streamCount() {
    return this.streams.size;
  }

  private url(path: string) {
    return `wss://${this.o.domain}${this.o.port === 443 ? "" : `:${this.o.port}`}${path}`;
  }

  private wsOptions() {
    return {
      perMessageDeflate: false,
      handshakeTimeout: this.L.connectTimeoutMs,
      maxPayload: 1024 * 1024 + 1024,
      ...(this.o.transport?.ca ? { ca: this.o.transport.ca } : {}),
      ...(this.o.transport?.lookup ? { lookup: this.o.transport.lookup } : {}),
    } as ConstructorParameters<typeof WebSocket>[2];
  }

  private set(state: LinkState) {
    if (this.state !== state) {
      this.state = state;
      this.since = Date.now();
      this.emit("state", state);
    }
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.timer = this.watchdog = null;
    this.retryAt = null;
    this.ws?.terminate();
    this.ws = null;
    for (const d of this.data) d.terminate();
    for (const s of this.streams) s.destroy();
    this.data.clear();
    this.streams.clear();
    this.welcome = null;
    this.set("off");
    this.challengeServer.close();
  }

  private arm() {
    if (this.watchdog) clearTimeout(this.watchdog);
    const t = setTimeout(() => {
      this.lastError = say("noHeartbeat");
      this.watchdogFired = true;
      this.ws?.terminate();
    }, this.pingMs * this.L.pingWatchdogFactor) as unknown as NodeJS.Timeout;
    t.unref?.();
    this.watchdog = t;
  }

  private connect() {
    this.set("connecting");
    this.retryAt = null;
    const ws = new WebSocket(this.url(PATHS.control), this.wsOptions());
    this.ws = ws;
    let challenged = false;
    ws.on("error", (e) => {
      const m = String((e as Error).message);
      const status = /Unexpected server response: (\d+)/.exec(m)?.[1];
      this.lastError =
        status === "429"
          ? say("tooManyPending")
          : status === "503"
            ? say("fullRetry")
            : say("unreachable", { domain: this.o.domain, error: m.slice(0, 160) });
    });
    ws.on("open", () => this.arm());
    ws.on("ping", () => this.arm());
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return ws.close(CLOSE.protocol);
      let m: any;
      try {
        m = JSON.parse(raw.toString("utf8"));
      } catch {
        return ws.close(CLOSE.protocol);
      }
      if (!m || typeof m !== "object" || m.v !== PROTOCOL_VERSION) return;
      if (m.t === "challenge" && !challenged) {
        challenged = true;
        void this.hello(ws, m as ChallengeMsg);
      } else if (m.t === "welcome") this.welcomed(ws, m as WelcomeMsg);
      else if (m.t === "open" && this.welcome && ws === this.ws) this.opened(m as OpenMsg);
      // Unknown `t`: ignored (minor versions add messages).
    });
    ws.on("close", (code) => {
      // The watchdog already said why (no heartbeat): keep that.
      const silent = this.watchdogFired;
      this.watchdogFired = false;
      if (this.ws === ws) this.ws = null;
      if (this.watchdog) clearTimeout(this.watchdog);
      this.watchdog = null;
      const was = this.welcome;
      this.welcome = null;
      if (this.stopped) return;
      if (code === CLOSE.restart) {
        this.attempt = 0;
        this.lastError = say("restarting");
      } else if (code === CLOSE.proofRefused) this.lastError = say("proofRefused");
      else if (code === CLOSE.notAllowed) {
        // The operator's allow-list: trying again changes nothing — until the settings change or a restart.
        this.lastError = say("notAllowed");
        this.retryAt = null;
        this.set("refused");
        return;
      } else if (code === CLOSE.replaced) {
        // The same key logged in elsewhere: do not fight over it.
        this.lastError = say("replaced");
        this.attempt = Math.max(this.attempt, 10);
      } else if (code === CLOSE.full) this.lastError = say("full");
      else if (was && !silent) this.lastError = say("closed", { code });
      this.schedule();
    });
  }

  private async hello(ws: WebSocket, c: ChallengeMsg) {
    // Only a nonce of the protocol's shape (32 bytes base64url) is ever signed.
    if (typeof c.nonce !== "string" || !SECRET_RE.test(c.nonce) || typeof c.aud !== "string" || c.aud !== this.o.domain)
      return ws.close(CLOSE.protocol);
    try {
      const proof = await this.o.self.signRelayProof(proofPayload(c, this.o.self.publicJwk) as any);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, proof }));
    } catch {
      ws.close(CLOSE.protocol);
    }
  }

  private welcomed(ws: WebSocket, w: WelcomeMsg) {
    // The relay must name this Daisy: its identity number and its host.
    if (w.id !== this.o.self.kid || w.host !== this.host) {
      this.lastError = say("wrongWelcome");
      return ws.close(CLOSE.protocol);
    }
    this.welcome = w;
    const ping = Number(w.limits?.pingIntervalMs);
    if (Number.isFinite(ping) && ping >= 1000 && ping <= 600_000) this.pingMs = ping;
    this.arm();
    this.attempt = 0;
    this.lastError = null;
    this.set("connected");
    log.info(`Connected to the relay: https://${this.host}${this.o.port === 443 ? "" : `:${this.o.port}`}`);
    this.emit("welcome", w);
  }

  /** base × 2^n, at most the cap, × 0.5–1 (PROTOCOL.md §6). */
  private schedule() {
    const d = Math.min(this.L.backoffMaxMs, this.L.backoffBaseMs * 2 ** this.attempt) * (0.5 + Math.random() / 2);
    this.attempt = Math.min(this.attempt + 1, 30);
    this.retryAt = Date.now() + d;
    this.set("waiting");
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) this.connect();
    }, d) as unknown as NodeJS.Timeout;
  }

  private opened(m: OpenMsg) {
    if (typeof m.claim !== "string" || !SECRET_RE.test(m.claim)) return;
    if (this.streams.size + this.data.size >= this.L.maxStreams) {
      this.ws?.send(JSON.stringify({ t: "reject", v: PROTOCOL_VERSION, claim: m.claim }));
      return;
    }
    const n = Number.isSafeInteger(m.n) ? m.n : 0;
    // The relay's word only (rate-limit keys): an IP's characters or nothing.
    const addr = typeof m.addr === "string" && /^[0-9a-fA-F:.]{2,45}$/.test(m.addr) ? m.addr : "";
    this.openDataStream(m.claim, (stream) => this.route(stream, { n, addr }));
  }

  /**
   * The one place that knows how a data connection presents its claim
   * (PROTOCOL.md 1.1 §5: in the upgrade request's `daisy-relay-claim`
   * header; a refused claim is an HTTP 404 before any WebSocket; no Origin
   * header, ever). Every frame sent is at most the relay's
   * `maxDataFrameBytes`: bigger writes are split. Hands over the byte
   * stream once the upgrade succeeded (the relay sends the ClientHello next).
   */
  private openDataStream(claim: string, ready: (stream: Duplex) => void) {
    const ws = new WebSocket(this.url(PATHS.data), { ...(this.wsOptions() as object), headers: { [CLAIM_HEADER]: claim } } as never);
    this.data.add(ws);
    ws.on("error", () => {});
    ws.on("close", () => this.data.delete(ws));
    ws.on("open", () => {
      this.data.delete(ws);
      const max = Math.max(1024, Math.min(Number(this.welcome?.limits?.maxDataFrameBytes) || 65_536, 1024 * 1024));
      const send = ws.send.bind(ws) as (...a: unknown[]) => void;
      (ws as unknown as { send: (...a: unknown[]) => void }).send = (d: unknown, ...rest: unknown[]) => {
        if (!Buffer.isBuffer(d) || d.length <= max) return send(d, ...rest);
        const cb = rest.find((r) => typeof r === "function");
        for (let o = 0; o < d.length; o += max) send(d.subarray(o, o + max), { binary: true }, o + max >= d.length ? cb : undefined);
      };
      const stream = createWebSocketStream(ws);
      stream.on("error", () => {});
      ready(stream);
    });
  }

  /** Read the ClientHello; a CA's check or a call. */
  private route(stream: Duplex, meta: { n: number; addr: string }) {
    this.streams.add(stream);
    stream.once("close", () => this.streams.delete(stream));
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => stream.destroy(), this.L.helloTimeoutMs);
    const onData = (c: Buffer) => {
      chunks.push(Buffer.from(c));
      const head = Buffer.concat(chunks);
      const h = readClientHello(head, this.L.helloMaxBytes);
      if (h.state === "need") return;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.pause();
      if (h.state === "bad" || (h.sni !== null && h.sni !== this.host)) return void stream.destroy();
      stream.unshift(head);
      if (h.alpn.includes("acme-tls/1")) {
        // Only while a challenge is open; never the outside face.
        if (!this.o.challenge(this.host)) return void stream.destroy();
        this.challengeServer.emit("connection", stream);
        return;
      }
      this.o.inject(stream, meta);
    };
    stream.on("data", onData);
    stream.once("close", () => clearTimeout(timer));
  }
}
