/**
 * The Daisy side of the relay protocol (PROTOCOL.md), minimal, for tests —
 * what P5-02 builds properly in packages/daisy/src/relay-link: log in with
 * an Ed25519 identity key, keep the control connection, claim each inbound
 * connection on a new data WebSocket and hand the byte stream to an HTTPS
 * server holding `<subdomain>.<domain>`'s certificate (TLS ends here, not on
 * the relay). Reconnects with a growing, jittered delay.
 *
 * Also: a caller (plain HTTPS / TLS through the relay) and a TCP tap that
 * records every byte between clients and the relay's public port.
 */
import { EventEmitter } from "node:events";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CompactSign } from "jose";
import { WebSocket, createWebSocketStream } from "ws";
import {
  CLAIM_HEADER,
  PATHS,
  PROOF_TYP,
  proofPayload,
  type ChallengeMsg,
  type OpenMsg,
  type WelcomeMsg,
} from "../../src/protocol.ts";
import { subdomainOfKey } from "../../src/proof.ts";
import { identityId } from "../../../a2a-client/src/identity.ts";
import type { Leaf } from "./pki.ts";

export interface Identity {
  privateKey: KeyObject;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string };
  sub: string;
  id: string;
}

export function newIdentity(): Identity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const j = publicKey.export({ format: "jwk" }) as { x: string };
  const jwk = { kty: "OKP" as const, crv: "Ed25519" as const, x: j.x };
  return { privateKey, jwk, sub: subdomainOfKey(jwk), id: identityId(jwk) };
}

/** Sign a proof (header, payload and key can be overridden to forge bad ones). */
export async function signProof(
  signer: KeyObject,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "EdDSA", typ: PROOF_TYP },
): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader(header as { alg: string })
    .sign(signer);
}

/** Resolve every name to one local address. */
export const lookupTo = (address: string, family: number) => (_h: string, o: unknown, cb: (...a: unknown[]) => void) =>
  (o as { all?: boolean })?.all ? cb(null, [{ address, family }]) : cb(null, address, family);

/** Resolve every name to 127.0.0.1 (the fake domain never touches DNS). */
export const localLookup = (_h: string, o: unknown, cb: (...a: unknown[]) => void) =>
  (o as { all?: boolean })?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4);

export interface Frame {
  n: number;
  dir: "toDaisy" | "fromDaisy";
  bytes: Buffer;
}

export interface TestDaisyOptions {
  domain: string;
  /** The port Daisys connect to (the relay's public port, or a tap in front of it). */
  port: number;
  /** Trusts the relay's own certificate. */
  ca: string;
  identity?: Identity;
  /** The certificate for `<sub>.<domain>` (made by the test, with the Daisy's own key). */
  leaf: (sub: string) => Leaf;
  handler?: (req: IncomingMessage, res: ServerResponse) => void;
  backoff?: { baseMs: number; maxMs: number };
  /** Do not claim `open`s (simulates a Daisy that went silent). */
  silent?: boolean;
  /** The local address to connect from (tests of per-source limits): "127.0.0.1" (default) or "::1". */
  from?: "127.0.0.1" | "::1";
}

export class TestDaisy extends EventEmitter {
  readonly identity: Identity;
  readonly leaf: Leaf;
  readonly frames: Frame[] = [];
  readonly opens: OpenMsg[] = [];
  /** Every message the relay sent on control connections. */
  readonly controlLog: Record<string, unknown>[] = [];
  welcome: WelcomeMsg | null = null;
  welcomes = 0;
  closeCodes: number[] = [];
  /** When each control connection attempt started (ms). */
  readonly attempts: number[] = [];
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly server: https.Server;
  private readonly data = new Set<WebSocket>();

  constructor(private readonly o: TestDaisyOptions) {
    super();
    this.identity = o.identity ?? newIdentity();
    this.leaf = o.leaf(this.identity.sub);
    this.server = https.createServer(
      { cert: this.leaf.cert, key: this.leaf.key },
      o.handler ??
        ((req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          req.on("end", () => {
            res.setHeader("content-type", "text/plain");
            res.end(`daisy ${this.identity.sub} got ${req.method} ${req.url} ${Buffer.concat(chunks).length}`);
          });
        }),
    );
    this.server.on("tlsClientError", () => {});
  }

  get host() {
    return `${this.identity.sub}.${this.o.domain}`;
  }

  /** Connect; resolves at the first welcome. */
  start(): Promise<WelcomeMsg> {
    this.stopped = false;
    const p = new Promise<WelcomeMsg>((resolve) => this.once("welcome", resolve));
    this.connect();
    return p;
  }

  /** Resolves at the next welcome. */
  nextWelcome(): Promise<WelcomeMsg> {
    return new Promise((resolve) => this.once("welcome", resolve));
  }

  private wsOptions() {
    return {
      ca: this.o.ca,
      lookup: this.o.from === "::1" ? lookupTo("::1", 6) : localLookup,
      perMessageDeflate: false,
      handshakeTimeout: 5000,
    } as unknown as ConstructorParameters<typeof WebSocket>[2];
  }

  private url(path: string) {
    return `wss://${this.o.domain}:${this.o.port}${path}`;
  }

  private connect() {
    this.attempts.push(Date.now());
    const ws = new WebSocket(this.url(PATHS.control), this.wsOptions());
    this.ws = ws;
    ws.on("error", () => {});
    ws.on("message", async (data) => {
      const m = JSON.parse(data.toString());
      this.controlLog.push(m);
      if (m.t === "challenge") {
        const c = m as ChallengeMsg;
        const proof = await signProof(this.identity.privateKey, { ...proofPayload(c, this.identity.jwk) });
        ws.send(JSON.stringify({ t: "hello", v: 1, proof }));
      } else if (m.t === "welcome") {
        this.welcome = m;
        this.welcomes++;
        this.attempt = 0;
        this.emit("welcome", m);
      } else if (m.t === "open") {
        this.opens.push(m);
        this.emit("open", m);
        if (!this.o.silent) this.claim(m as OpenMsg);
      }
    });
    ws.on("close", (code) => {
      this.closeCodes.push(code);
      this.emit("closed", code);
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) this.schedule();
    });
  }

  /** Exponential backoff with jitter: base·2^attempt, at most max, times 0.5–1. */
  private schedule() {
    const b = this.o.backoff ?? { baseMs: 200, maxMs: 5000 };
    const d = Math.min(b.maxMs, b.baseMs * 2 ** this.attempt) * (0.5 + Math.random() / 2);
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) this.connect();
    }, d) as unknown as NodeJS.Timeout;
  }

  /** Decline an `open` on the control channel. */
  reject(claim: string) {
    this.ws?.send(JSON.stringify({ t: "reject", v: 1, claim }));
  }

  /** Send any raw control message (tests). */
  sendControl(text: string | Buffer) {
    this.ws?.send(text);
  }

  claim(m: OpenMsg) {
    // PROTOCOL.md §5: the claim goes in the upgrade request; no claim frame.
    const ws = new WebSocket(this.url(PATHS.data), {
      ...(this.wsOptions() as object),
      headers: { [CLAIM_HEADER]: m.claim },
    } as never);
    this.data.add(ws);
    ws.on("error", () => {});
    ws.on("unexpected-response", (_q, res) => this.emit("claimRefused", res.statusCode));
    ws.on("close", () => this.data.delete(ws));
    ws.on("open", () => {
      ws.on("message", (d, isBinary) => {
        if (isBinary) this.frames.push({ n: m.n, dir: "toDaisy", bytes: Buffer.from(d as Buffer) });
      });
      // Frames at most maxDataFrameBytes (from the welcome): split bigger writes.
      const max = this.welcome?.limits.maxDataFrameBytes ?? 65_536;
      const send = ws.send.bind(ws) as (...a: unknown[]) => void;
      (ws as unknown as { send: (...a: unknown[]) => void }).send = (d: unknown, ...rest: unknown[]) => {
        if (!Buffer.isBuffer(d)) return send(d, ...rest);
        this.frames.push({ n: m.n, dir: "fromDaisy", bytes: Buffer.from(d) });
        const cb = rest.find((r) => typeof r === "function");
        for (let o = 0; o < d.length; o += max) {
          const last = o + max >= d.length;
          send(d.subarray(o, o + max), { binary: true }, last ? cb : undefined);
        }
        if (d.length === 0) send(d, ...rest);
      };
      const duplex = createWebSocketStream(ws);
      duplex.on("error", () => {});
      this.server.emit("connection", duplex);
    });
  }

  /** Drop the control connection without telling the relay anything else (tests). */
  dropControl() {
    this.ws?.terminate();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws?.terminate();
    for (const d of this.data) d.terminate();
    this.server.close();
  }
}

const spkiHash = (b: Buffer) => createHash("sha256").update(b).digest("base64");

export interface CallResult {
  status: number;
  body: string;
  /** SHA-256 of the SPKI of the certificate the caller saw. */
  peerSpki: string;
}

/** A caller: HTTPS to `https://<host>/…` through the relay at 127.0.0.1:port. */
export function call(
  port: number,
  host: string,
  ca: string,
  o: { method?: string; path?: string; body?: string; headers?: Record<string, string>; from?: string } = {},
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: o.from ?? "127.0.0.1",
        port,
        servername: host,
        method: o.method ?? "GET",
        path: o.path ?? "/",
        ca,
        agent: false,
        headers: { host, ...(o.headers ?? {}) },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        const cert = (res.socket as tls.TLSSocket).getPeerX509Certificate?.();
        const spki = cert ? spkiHash(cert.publicKey.export({ type: "spki", format: "der" }) as Buffer) : "";
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), peerSpki: spki });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (o.body) req.write(o.body);
    req.end();
  });
}

/** A bare TLS handshake to `servername` through the relay: how it ends, and how long it took. */
export function handshake(
  port: number,
  servername: string,
  ca: string,
): Promise<{ ok: boolean; code?: string; message?: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const s = tls.connect({ host: "127.0.0.1", port, servername, ca });
    s.on("secureConnect", () => {
      s.destroy();
      resolve({ ok: true, ms: Date.now() - t0 });
    });
    s.on("error", (e: NodeJS.ErrnoException) =>
      resolve({ ok: false, code: e.code, message: e.message, ms: Date.now() - t0 }),
    );
    s.on("close", () => resolve({ ok: false, code: "CLOSED", ms: Date.now() - t0 }));
  });
}

export interface Tapped {
  conn: number;
  dir: "up" | "down";
  bytes: Buffer;
}

/** A TCP tap: listen on a port, forward to `target`, record every byte both ways. */
export async function tap(target: number): Promise<{ port: number; log: Tapped[]; close: () => Promise<void> }> {
  const log: Tapped[] = [];
  const socks = new Set<net.Socket>();
  let conn = 0;
  const server = net.createServer((a) => {
    const id = ++conn;
    const b = net.connect(target, "127.0.0.1");
    socks.add(a);
    socks.add(b);
    a.on("data", (d) => {
      log.push({ conn: id, dir: "up", bytes: Buffer.from(d) });
      b.write(d);
    });
    b.on("data", (d) => {
      log.push({ conn: id, dir: "down", bytes: Buffer.from(d) });
      a.write(d);
    });
    const end = () => {
      a.destroy();
      b.destroy();
    };
    a.on("close", end);
    b.on("close", end);
    a.on("error", end);
    b.on("error", end);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    log,
    close: () =>
      new Promise<void>((r) => {
        for (const s of socks) s.destroy();
        server.close(() => r());
      }),
  };
}

/**
 * A bare data-connection upgrade (`/v1/data`) with the given headers: the
 * HTTP status if refused before the upgrade, or the open WebSocket and the
 * frames it got.
 */
export function dataUpgrade(
  port: number,
  ca: string,
  headers: Record<string, string>,
  o: { domain?: string; from?: "127.0.0.1" | "::1" } = {},
): Promise<{ status: number; ws?: WebSocket; got: Buffer[] }> {
  return new Promise((resolve) => {
    const got: Buffer[] = [];
    const ws = new WebSocket(`wss://${o.domain ?? "relay.test"}:${port}${PATHS.data}`, {
      ca,
      lookup: o.from === "::1" ? lookupTo("::1", 6) : localLookup,
      headers,
      perMessageDeflate: false,
    } as never);
    ws.on("error", () => resolve({ status: 0, got }));
    ws.on("unexpected-response", (_q, res) => {
      resolve({ status: res.statusCode ?? 0, got });
      res.resume();
    });
    ws.on("message", (d: Buffer) => got.push(Buffer.from(d)));
    ws.on("open", () => resolve({ status: 101, ws, got }));
  });
}
