/**
 * P5-02 tests: the relay program (P5-01, packages/relay) in process on the
 * fake domain `relay.test` (D-41 ③), its own certificate from a throwaway
 * test CA, every name resolved to 127.0.0.1 — no DNS, no network.
 *
 * `transport` is what createApp's tests-only `relay` option takes for the
 * Daisy side; `call` is a caller (HTTPS through the relay's public port to
 * `https://<sub>.relay.test`).
 */
import https from "node:https";
import tls from "node:tls";
import { startRelay, type Relay } from "../../packages/relay/src/relay.ts";
import { makeLogger } from "../../packages/relay/src/log.ts";
import { TestCA } from "../../packages/relay/tests/helpers/pki.ts";
import { spkiHashOfCert } from "../../packages/a2a-client/src/binding.ts";

export const DOMAIN = "relay.test";

/** Resolve every name to 127.0.0.1 (the fake domain never touches DNS). */
export const localLookup = (_h: string, o: unknown, cb: (...a: unknown[]) => void) =>
  (o as { all?: boolean })?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4);

export async function testRelay(limits: Partial<import("../../packages/relay/src/config.ts").Limits> = {}) {
  const ca = new TestCA("Relay Test CA");
  const own = ca.issue([DOMAIN]);
  const logs: string[] = [];
  const logger = makeLogger("info", (l) => logs.push(l));
  let relay: Relay = await startRelay({ domain: DOMAIN, host: "127.0.0.1", port: 0, cert: own.cert, key: own.key, logger, limits });
  const port = relay.port;
  return {
    ca,
    logs,
    get relay() {
      return relay;
    },
    port,
    url: `https://${DOMAIN}:${port}`,
    /** createApp({ relay }) for a Daisy using this relay: quick reconnects. */
    daisyOptions: {
      transport: { link: { ca: ca.cert, lookup: localLookup } },
      limits: { backoffBaseMs: 100, backoffMaxMs: 1_000 },
    },
    /** The A2A client's tests-only policy: loopback allowed, every name → 127.0.0.1. */
    policy: { allowLoopback: true, lookup: async () => [{ address: "127.0.0.1", family: 4 }] },
    async stop() {
      await relay.close();
    },
    /** Start again on the same port (N-4). */
    async restart() {
      relay = await startRelay({ domain: DOMAIN, host: "127.0.0.1", port, cert: own.cert, key: own.key, logger, limits });
      return relay;
    },
  };
}
export type TestRelay = Awaited<ReturnType<typeof testRelay>>;

export interface CallResult {
  status: number;
  body: string;
  json: any;
  /** The certificate the caller saw: its key's SPKI hash, and whether `ca` vouched for it. */
  spki: string;
  authorized: boolean;
}

/** HTTPS to `https://<host>:<port><path>` through the relay (any certificate unless `ca`). */
export function call(
  port: number,
  host: string,
  o: { method?: string; path?: string; body?: unknown; headers?: Record<string, string>; ca?: string; hostHeader?: string } = {},
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const body = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        servername: host,
        method: o.method ?? "GET",
        path: o.path ?? "/",
        agent: false,
        ...(o.ca ? { ca: o.ca } : { rejectUnauthorized: false }),
        headers: {
          host: o.hostHeader ?? `${host}:${port}`,
          ...(body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}),
          ...(o.headers ?? {}),
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        const s = res.socket as tls.TLSSocket;
        const x = s.getPeerX509Certificate?.();
        const authorized = s.authorized;
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode ?? 0, body: text, json, spki: x ? spkiHashOfCert(x) : "", authorized });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}

/** A bare TLS handshake through the relay: how it ended. */
export function handshake(port: number, servername: string): Promise<{ ok: boolean; code?: string; message?: string }> {
  return new Promise((resolve) => {
    const s = tls.connect({ host: "127.0.0.1", port, servername, rejectUnauthorized: false });
    s.on("secureConnect", () => {
      s.destroy();
      resolve({ ok: true });
    });
    s.on("error", (e: NodeJS.ErrnoException) => resolve({ ok: false, code: e.code, message: e.message }));
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 10_000, what = "condition"): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 400)}`);
    await sleep(25);
  }
}

export { https };

/**
 * `fetch` through the relay: the URL's host is the relay address
 * (`https://<sub>.relay.test:<port>`); the connection goes to 127.0.0.1 on
 * that port with the name as SNI; any certificate (`ca` to check one).
 */
export function relayFetch(ca?: string) {
  return (input: string | URL, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> =>
    new Promise((resolve, reject) => {
      const u = new URL(String(input));
      const body = init.body;
      const req = https.request(
        {
          host: "127.0.0.1",
          port: Number(u.port) || 443,
          servername: u.hostname,
          method: init.method ?? "GET",
          path: u.pathname + u.search,
          agent: false,
          ...(ca ? { ca } : { rejectUnauthorized: false }),
          headers: { host: u.host, ...(init.headers ?? {}), ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
            const status = res.statusCode ?? 0;
            resolve(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: h }));
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
}
