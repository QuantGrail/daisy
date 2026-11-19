/**
 * P5-03b (ADR-142 §「经中转」, ADR-144 §「交给 P5-03」, W-3, 总纲 7.6): pairing
 * a phone through the relay — a whole Daisy (createApp) and the relay
 * program (P5-01) in one process, on the fake domain `relay.test` with a
 * test CA; no DNS, no network, no real ACME (`acme: false`, or the
 * in-process stand-in tests/fixtures/fake-acme.ts).
 *
 * Refused first: no way in at all (no listener, no relay) gives no code; a
 * device session or credential carried to the local face; a Host that is
 * not the relay address; the relay callers' rate limits are per caller (the
 * relay's word), never shared with the direct listener's or the local
 * face's. Then: the phone pairs through the relay alone (no listener) —
 * redeem, session, the sessions, a card answered, revoking cuts its live
 * channel through the relay at once; a device paired one way is used the
 * other; the list says "via relay" (the relay's word for the address, never
 * a misleading one); turning the relay off drops the device sessions and
 * the unused codes but keeps the pairing; the links say plainly when a
 * phone's browser will not trust the relay's certificate (self-signed) and
 * offer the direct address when the listener is on. No cookie is ever set.
 */
import { LIVE_CLOSE } from "../packages/contracts/src/live.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import tls from "node:tls";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { duplexPair } from "node:stream";
import WebSocketNode from "ws";
import { api } from "../packages/contracts/src/api/index.ts";
import { DEVICE_LIMITS } from "../packages/contracts/src/limits.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { newPairingCode } from "../packages/daisy/src/access/devices.ts";
import { daisy, runningTurn, type Daisy } from "./fixtures/daisy-with-issuer.ts";
import { runnerHeaders } from "./fixtures/runner-calls.ts";
import { testRelay, until, localLookup, type TestRelay } from "./fixtures/relay-net.ts";
import { fakeAcme, type FakeAcme } from "./fixtures/fake-acme.ts";

const PIN = "246810";
const webHolder = (token: string) => `web:${createHash("sha256").update(token).digest("hex")}`;

let net: TestRelay;
let acme: FakeAcme | undefined;
const opened: Daisy[] = [];
after(async () => {
  for (const d of opened) await d.close().catch(() => {});
  await acme?.close();
  await net?.stop().catch(() => {});
});

interface Answer {
  status: number;
  text: string;
  json: any;
  headers: Record<string, string | string[] | undefined>;
  authorized: boolean;
}

/** HTTPS to `base` (`https://<host>:<port>`) — every name is 127.0.0.1; `ca` to check the certificate like a browser. */
function httpsTo(base: string, method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string>; ca?: string } = {}): Promise<Answer> {
  const u = new URL(base);
  const body = o.body === undefined ? undefined : JSON.stringify(o.body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port: Number(u.port) || 443,
        servername: u.hostname,
        method,
        path,
        agent: false,
        ...(o.ca ? { ca: o.ca } : { rejectUnauthorized: false }),
        headers: {
          host: u.host,
          // What the phone's browser sends: its page is this origin.
          ...(method !== "GET" ? { origin: `${u.protocol}//${u.host}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}),
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
          ...(o.headers ?? {}),
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        const authorized = (res.socket as tls.TLSSocket).authorized;
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode ?? 0, text, json, headers: res.headers, authorized });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}

/** Every answer the phone got: none may set a cookie (ADR-100: `__Host-` if one ever comes). */
const seen: Answer[] = [];

async function setup(o: { listener?: boolean; acme?: boolean } = {}) {
  net ??= await testRelay();
  let d: Daisy;
  if (o.acme) {
    acme ??= await fakeAcme({ relayPort: net.port });
    d = await daisy({ relay: { transport: { link: net.daisyOptions.transport.link, acme: { ca: acme.tlsCa, lookup: localLookup } }, limits: net.daisyOptions.limits } });
  } else d = await daisy({ relay: net.daisyOptions });
  opened.push(d);
  let direct: string | null = null;
  if (o.listener) {
    const on = await d.ctx.app.inject({ method: "PUT", url: "/api/access/external", headers: d.withPin(), payload: { host: "127.0.0.1", tls: false } });
    assert.equal(on.statusCode, 200, on.body);
    direct = `http://127.0.0.1:${on.json().external.port}`;
  }
  const webToken = d.ctx.issueToken();
  const web = { authorization: `Bearer ${webToken}` };
  const webPin = () => ({ ...web, [PIN_GRANT_HEADER]: d.pin.grant(PIN, webHolder(webToken)).grant });
  const relayOn = async () => {
    const r = await d.ctx.app.inject({
      method: "PUT",
      url: api.relay.relaySet.path,
      headers: d.withPin(),
      payload: o.acme ? { url: net.url, acmeDirectory: acme!.directory } : { url: net.url, acme: false },
    });
    assert.equal(r.statusCode, 200, r.body);
    const st = await until(
      async () => (await d.ctx.app.inject({ url: api.relay.relayShow.path, headers: d.asCli })).json(),
      (s) => s.state === "connected" && (!o.acme || s.cert.kind === "acme"),
      20_000,
      "connected",
    );
    return st.address as string;
  };
  const pair = async (name?: string) => {
    const r = await d.ctx.app.inject({ method: "POST", url: "/api/devices/pair", headers: webPin(), payload: name ? { name } : {} });
    assert.equal(r.statusCode, 200, r.body);
    return r.json() as {
      code: string;
      url: string | null;
      via: string;
      certificate: string;
      warning: string | null;
      relayUrl: string | null;
      relayCertificate: string | null;
      relayWarning: string | null;
      expiresAt: number;
    };
  };
  /** The phone, through the relay (`base` = the relay address) or the direct listener. */
  const phone = async (base: string, method: string, path: string, o2: { token?: string; body?: unknown; headers?: Record<string, string>; ca?: string } = {}): Promise<Answer> => {
    let a: Answer;
    if (base.startsWith("https:")) a = await httpsTo(base, method, path, o2);
    else {
      const r = await fetch(base + path, {
        method,
        headers: {
          ...(o2.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(o2.token ? { authorization: `Bearer ${o2.token}` } : {}),
          ...o2.headers,
        },
        ...(o2.body !== undefined ? { body: JSON.stringify(o2.body) } : {}),
      });
      const text = await r.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {}
      a = { status: r.status, text, json, headers: Object.fromEntries(r.headers), authorized: false };
    }
    seen.push(a);
    return a;
  };
  const devices = async (state = "all") =>
    (await d.ctx.app.inject({ url: `/api/devices?state=${state}`, headers: web })).json().devices as any[];
  return { d, direct, web, webToken, webPin, relayOn, pair, phone, devices };
}

/** The code from a pairing link (`…/#pair=<code>`), as the page reads it. */
const codeOf = (url: string | null) => decodeURIComponent(String(url).split("#pair=")[1]!);
/** Review M-1 (b): what the owner is told about any link through the relay. */
const OPERATOR = "这个链接经中转。中转运营者能冒签证书，从而拿到配对码和这台设备的凭据——只在你信任这个中转（例如团队自己架的）时用。";

// ── refused first ─────────────────────────────────────────────────────────

test("no way in at all (no listener, no relay): no pairing code and no outside one-time code — nothing made", async () => {
  const s = await setup();
  const r = await s.d.ctx.app.inject({ method: "POST", url: "/api/devices/pair", headers: s.webPin(), payload: {} });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "external_off");
  assert.equal(s.d.ctx.access.devices.pendingCodes(), 0);
  const o = await s.d.ctx.app.inject({ method: "POST", url: api.access.openCodeExternal.path, headers: s.d.withPin() });
  assert.equal(o.statusCode, 409);
  assert.equal(o.json().code, "external_off");
});

test("through the relay, the outside face's rules hold for devices: a code or credential on the local face is refused, a device session is not good on the local face, a Host other than the relay address is refused", async () => {
  const s = await setup();
  const addr = await s.relayOn();
  const c = await s.pair();
  // Trading on the local face: refused, the code not used up.
  const local = await s.d.ctx.app.inject({ method: "POST", url: "/api/devices/redeem", payload: { code: c.code } });
  assert.equal(local.statusCode, 403);
  assert.equal(local.json().code, "device_face");
  assert.equal(s.d.ctx.access.devices.pendingCodes(), 1);
  // A Host that is not the relay address (the right SNI — the relay routes by it — and a forged Host): refused, the code not used.
  const forged = await s.phone(addr, "POST", "/api/devices/redeem", { body: { code: c.code }, headers: { host: "evil.example", origin: "https://evil.example" } });
  assert.equal(forged.status, 403, forged.text);
  assert.equal(forged.json.code, "host_not_allowed");
  // Another site's page asking (its Origin): refused.
  const xsite = await s.phone(addr, "POST", "/api/devices/redeem", { body: { code: c.code }, headers: { origin: "https://evil.example" } });
  assert.equal(xsite.status, 403, xsite.text);
  assert.equal(s.d.ctx.access.devices.pendingCodes(), 1);
  // Now through the relay as the page does: paired.
  const p = await s.phone(addr, "POST", "/api/devices/redeem", { body: { code: c.code, name: "手机" } });
  assert.equal(p.status, 200, p.text);
  // The device session and credential on the local face: refused.
  assert.equal((await s.d.ctx.app.inject({ url: "/api/me", headers: { authorization: `Bearer ${p.json.token}` } })).statusCode, 401);
  const ex = await s.d.ctx.app.inject({ method: "POST", url: "/api/devices/session", payload: { secret: p.json.secret } });
  assert.equal(ex.json().code, "device_face");
  // The credential is no Bearer through the relay either.
  assert.equal((await s.phone(addr, "GET", "/api/me", { token: p.json.secret })).status, 401);
});

/**
 * A caller the relay reports as `addr`: a stream handed straight to the
 * outside face's relay server (what the relay link does with each stream),
 * TLS to the relay address over it.
 */
function relayCaller(s: Awaited<ReturnType<typeof setup>>, host: string, addr: string) {
  return (method: string, path: string, body: unknown): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const [mine, theirs] = duplexPair();
      s.d.ctx.access.faces.injectRelay(theirs, addr);
      const text = JSON.stringify(body);
      // No agent: the request goes over exactly this TLS stream.
      const req = https.request(
        {
          method,
          path,
          createConnection: () => tls.connect({ socket: mine as any, servername: host, rejectUnauthorized: false }),
          headers: { host: `${host}:${net.port}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            let json: any = null;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString());
            } catch {}
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on("error", reject);
      req.end(text);
    });
}

test("the relay-routed rate limits are per caller (the relay's word): one caller's bad tries never use up another's, the direct listener's or the local face's", async () => {
  const s = await setup({ listener: true });
  const addr = await s.relayOn();
  const host = new URL(addr).hostname;
  const a = relayCaller(s, host, "203.0.113.7");
  const b = relayCaller(s, host, "198.51.100.9");
  // The device record keeps the relay's word for the caller (never this machine's end of the stream).
  const c = await s.pair();
  const paired = await a("POST", "/api/devices/redeem", { code: c.code });
  assert.equal(paired.status, 200);
  const row = (await s.devices()).find((x) => x.id === paired.json.deviceId);
  assert.deepEqual([row.lastVia, row.lastIp], ["relay", "203.0.113.7"]);
  // A relay that said nothing usable about the caller: "via relay", no address at all.
  const mute = await relayCaller(s, host, "")("POST", "/api/devices/redeem", { code: (await s.pair()).code });
  assert.equal(mute.status, 200);
  const row2 = (await s.devices()).find((x) => x.id === mute.json.deviceId);
  assert.deepEqual([row2.lastVia, row2.lastIp], ["relay", null]);
  // Device credentials (no lock): caller A runs into its own limit…
  const statuses: number[] = [];
  for (let i = 0; i < DEVICE_LIMITS.sessionPerMinute + 1; i++)
    statuses.push((await a("POST", "/api/devices/session", { secret: `ddev_${"x".repeat(43)}` })).status);
  assert.equal(statuses.at(-1), 429, statuses.join(","));
  assert.ok(statuses.slice(0, DEVICE_LIMITS.sessionPerMinute).every((x) => x === 401), statuses.join(","));
  // …caller B, the direct listener and the local face are not limited by it.
  const fromB = await b("POST", "/api/devices/session", { secret: `ddev_${"y".repeat(43)}` });
  assert.equal(fromB.status, 401);
  assert.equal(fromB.json.code, "device_invalid");
  const direct = await s.phone(s.direct!, "POST", "/api/devices/session", { body: { secret: `ddev_${"z".repeat(43)}` } });
  assert.equal(direct.status, 401);
  const local = await s.d.ctx.app.inject({ method: "POST", url: "/api/devices/session", payload: { secret: `ddev_${"w".repeat(43)}` } });
  assert.equal(local.statusCode, 403);
  // Pairing codes: the same per caller (the 5-wrong-codes lock is for all callers together — that is the guess bound).
  for (let i = 0; i < DEVICE_LIMITS.redeemPerMinute; i++) await a("POST", "/api/devices/redeem", { code: newPairingCode() });
  assert.equal((await a("POST", "/api/devices/redeem", { code: newPairingCode() })).status, 429);
  assert.notEqual((await b("POST", "/api/devices/redeem", { code: newPairingCode() })).status, 429);
  assert.notEqual((await s.phone(s.direct!, "POST", "/api/devices/redeem", { body: { code: newPairingCode() } })).status, 429);
});

// ── the phone through the relay ───────────────────────────────────────────

test("W-3 through the relay (no listener; a CA's certificate): the link is the relay's fixed address, with the operator warning; the phone redeems, trades its credential, sees the sessions, answers a card; the list says via relay", async () => {
  const s = await setup({ acme: true });
  const addr = await s.relayOn();
  assert.equal(s.d.ctx.access.faces.externalListening, false, "no listener: the relay alone");
  const t = await runningTurn(s.d);
  const c = await s.pair();
  // The link is the relay address (ctx.relay.address()), the code after `#`.
  assert.equal(s.d.ctx.relay.address(), addr);
  assert.ok(c.url?.startsWith(`${addr}/#pair=`), String(c.url));
  assert.equal(c.via, "relay");
  assert.equal(c.relayUrl, null, "the relay link is the main one: no alternative");
  // Review M-1 (b): only the relay — issued, but said plainly what the relay operator could do.
  assert.ok(c.warning?.includes(OPERATOR), String(c.warning));
  // Redeem through the relay.
  const r = await s.phone(addr, "POST", "/api/devices/redeem", { body: { code: codeOf(c.url), name: "我的 iPhone" }, ca: acme!.root });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.face, "external");
  const me = await s.phone(addr, "GET", "/api/me", { token: r.json.token });
  assert.equal(me.status, 200, me.text);
  assert.equal(me.json.channel, "device");
  assert.equal(me.json.face, "external");
  assert.equal(me.json.deviceId, r.json.deviceId);
  // The sessions.
  const list = await s.phone(addr, "GET", "/api/sessions", { token: r.json.token });
  assert.equal(list.status, 200, list.text);
  assert.ok(list.text.includes(t.own));
  // A card: the AI asks; the phone answers through the relay.
  const nodeId = JSON.parse(readFileSync(join(s.d.dir, "runner.json"), "utf8")).nodeId;
  const ev = await s.d.inject({
    method: "POST",
    url: `/api/runner/jobs/${t.job.id}/events`,
    headers: { ...runnerHeaders(nodeId), "x-lease": t.job.lease },
    payload: {
      events: [
        {
          id: "evt-perm-p503b",
          type: "approval",
          data: { id: "perm-p503b", title: "Bash", input: { command: "ls" }, options: [{ id: "allow", label: "允许本次" }, { id: "deny", label: "拒绝" }], category: "permission" },
        },
      ],
    },
  });
  assert.equal(ev.statusCode, 200, ev.body);
  const cards = await s.phone(addr, "GET", "/api/approvals?status=pending", { token: r.json.token });
  assert.ok(cards.json.items.some((x: any) => x.id === "perm:perm-p503b"), cards.text);
  const answer = await s.phone(addr, "POST", "/api/approvals/perm:perm-p503b/respond", { token: r.json.token, body: { decision: "allow" } });
  assert.equal(answer.status, 200, answer.text);
  // A new session from the credential, through the relay.
  const fresh = await s.phone(addr, "POST", "/api/devices/session", { body: { secret: r.json.secret } });
  assert.equal(fresh.status, 200, fresh.text);
  assert.equal(fresh.json.deviceId, r.json.deviceId);
  assert.equal((await s.phone(addr, "GET", "/api/me", { token: fresh.json.token })).status, 200);
  // The list: via relay, with the relay's word for the caller (the test relay reports 127.0.0.1), never this machine's own socket address.
  const row = (await s.devices()).find((x) => x.id === r.json.deviceId);
  assert.equal(row.lastVia, "relay");
  assert.equal(row.lastIp, "127.0.0.1");
  assert.equal(row.face, "external");
  // Never a code, credential or session in the audit.
  const audit = JSON.stringify(s.d.ctx.store.all("SELECT * FROM audit"));
  for (const x of [c.code, r.json.secret, r.json.token, fresh.json.token]) assert.ok(!audit.includes(x), "审计里有秘密");
  // Not a cookie anywhere.
  for (const a of seen) assert.equal(a.headers["set-cookie"], undefined);
});

test("W-3 through the relay: revoking cuts the phone's live channel through the relay at once; its next request and its credential are refused", async () => {
  const s = await setup();
  const addr = await s.relayOn();
  const t = await runningTurn(s.d);
  const c = await s.pair();
  const p = (await s.phone(addr, "POST", "/api/devices/redeem", { body: { code: c.code } })).json;
  const u = new URL(addr);
  const ws = new WebSocketNode(`wss://${u.host}/api/live`, { lookup: localLookup as any, rejectUnauthorized: false, servername: u.hostname, origin: addr } as any);
  const frames: any[] = [];
  let closed: number | null = null;
  ws.on("message", (m) => frames.push(JSON.parse(String(m))));
  ws.on("close", (code) => (closed = code));
  await new Promise((ok, fail) => (ws.once("open", ok), ws.once("error", fail)));
  ws.send(JSON.stringify({ type: "subscribe", token: p.token, sessionId: t.own }));
  await until(() => frames.some((f) => f.type === "ready"), Boolean, 5000, "ready through the relay");
  // Without the PIN: nothing revoked.
  const noPin = await s.d.ctx.app.inject({ method: "DELETE", url: `/api/devices/${p.deviceId}`, headers: s.web });
  assert.equal(noPin.json().code, "pin_required");
  assert.equal(closed, null);
  const rv = await s.d.ctx.app.inject({ method: "DELETE", url: `/api/devices/${p.deviceId}`, headers: s.webPin() });
  assert.equal(rv.statusCode, 200, rv.body);
  await until(() => closed, (x) => x !== null, 2000, "the channel through the relay closed");
  assert.equal(closed, LIVE_CLOSE.deviceRevoked);
  assert.equal((await s.phone(addr, "GET", "/api/sessions", { token: p.token })).status, 401);
  const ex = await s.phone(addr, "POST", "/api/devices/session", { body: { secret: p.secret } });
  assert.equal(ex.status, 401);
  assert.equal(ex.json.code, "device_invalid");
  ws.close();
});

test("one device, both ways: paired on the direct listener it works through the relay, and paired through the relay it works on the listener (the record's face is the outside face either way); the list follows the way it last came", async () => {
  const s = await setup({ listener: true });
  const addr = await s.relayOn();
  // Paired on the direct listener…
  const c1 = await s.pair();
  const a = (await s.phone(s.direct!, "POST", "/api/devices/redeem", { body: { code: c1.code } })).json;
  assert.equal((await s.devices()).find((x) => x.id === a.deviceId).lastVia, "direct");
  assert.equal((await s.devices()).find((x) => x.id === a.deviceId).lastIp, "127.0.0.1");
  // …used through the relay: its session and its credential.
  assert.equal((await s.phone(addr, "GET", "/api/me", { token: a.token })).status, 200);
  const viaRelay = await s.phone(addr, "POST", "/api/devices/session", { body: { secret: a.secret } });
  assert.equal(viaRelay.status, 200, viaRelay.text);
  assert.equal((await s.devices()).find((x) => x.id === a.deviceId).lastVia, "relay");
  // Paired through the relay, used on the listener.
  const c2 = await s.pair();
  const b = (await s.phone(addr, "POST", "/api/devices/redeem", { body: { code: c2.code } })).json;
  assert.equal((await s.phone(s.direct!, "GET", "/api/me", { token: b.token })).status, 200);
  assert.equal((await s.phone(s.direct!, "POST", "/api/devices/session", { body: { secret: b.secret } })).status, 200);
});

test("turning the relay off: the device sessions end and the unused codes go (their link was the relay's); the pairing stays — the credential trades again on the listener, and through the relay once it is back", async () => {
  const s = await setup({ listener: true });
  const addr = await s.relayOn();
  const c = await s.pair();
  const p = (await s.phone(addr, "POST", "/api/devices/redeem", { body: { code: c.code } })).json;
  await s.pair();
  assert.equal(s.d.ctx.access.devices.pendingCodes(), 1);
  const off = await s.d.ctx.app.inject({ method: "DELETE", url: api.relay.relayOff.path, headers: s.d.withPin() });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(s.d.ctx.access.devices.pendingCodes(), 0, "the relay's codes went with it");
  assert.equal((await s.phone(s.direct!, "GET", "/api/me", { token: p.token })).status, 401);
  const again = await s.phone(s.direct!, "POST", "/api/devices/session", { body: { secret: p.secret } });
  assert.equal(again.status, 200, again.text);
  assert.ok((await s.devices("active")).some((x) => x.id === p.deviceId));
  // Without the relay a new code's link is the listener's.
  const direct = await s.pair();
  assert.equal(direct.via, "direct");
  assert.ok(direct.url?.startsWith(`${s.direct}/#pair=`));
  // The relay back: the same address, the same device through it.
  assert.equal(await s.relayOn(), addr);
  assert.equal((await s.phone(addr, "POST", "/api/devices/session", { body: { secret: p.secret } })).status, 200);
});

// ── which link, and what the owner is told ────────────────────────────────

test("review M-1 / L-1: the listener on — the DIRECT link is the default and the relay link only the alternative (`relayUrl`, with the operator warning); a self-signed relay gets no link at all", async () => {
  // Listener + a self-signed relay: the direct link; no relay link (never a QR that teaches clicking through a warning).
  const s = await setup({ listener: true });
  await s.relayOn();
  const c = await s.pair();
  assert.equal(c.via, "direct");
  assert.ok(c.url?.startsWith(`${s.direct}/#pair=`), String(c.url));
  assert.equal(c.certificate, "plain");
  assert.equal(c.relayUrl, null);
  assert.equal(c.relayCertificate, "self-signed");
  assert.match(String(c.relayWarning), /自签名/);
  assert.match(String(c.relayWarning), /不要点过证书警告/);
  const o = (await s.d.ctx.app.inject({ method: "POST", url: api.access.openCodeExternal.path, headers: s.d.withPin() })).json();
  assert.equal(o.via, "direct");
  assert.ok(o.url.startsWith(`${s.direct}/#code=`), o.url);
  assert.equal(o.relayUrl, null);
  // Listener + a CA's certificate on the relay: still the direct link first; the relay's is offered, with the operator warning.
  const s2 = await setup({ listener: true, acme: true });
  const addr2 = await s2.relayOn();
  const c2 = await s2.pair();
  assert.equal(c2.via, "direct");
  assert.ok(c2.url?.startsWith(`${s2.direct}/#pair=`));
  assert.ok(c2.relayUrl?.startsWith(`${addr2}/#pair=`), String(c2.relayUrl));
  assert.equal(codeOf(c2.relayUrl), c2.code);
  assert.ok(c2.relayWarning?.includes(OPERATOR), String(c2.relayWarning));
  assert.equal(c2.warning, null, "the direct link (plain HTTP on loopback here) needs no warning");
  const o2 = (await s2.d.ctx.app.inject({ method: "POST", url: api.access.openCodeExternal.path, headers: s2.d.withPin() })).json();
  assert.ok(o2.url.startsWith(`${s2.direct}/#code=`));
  assert.ok(o2.relayUrl?.startsWith(`${addr2}/#code=`));
  assert.match(String(o2.relayWarning), /中转运营者能冒签证书/);
  // The command line: the direct link, then the relay's with its warning.
  const { renderPairingCode } = await import("../packages/daisy/src/cli/table.ts");
  const out: string[] = [];
  renderPairingCode(c2, { io: { out: (x: string) => out.push(x) } } as any);
  const text = out.join("\n");
  assert.ok(text.includes(c2.url!));
  assert.ok(text.includes(c2.relayUrl!));
  assert.ok(text.includes(OPERATOR));
  // The listener alone: no relay word at all.
  const s3 = await setup({ listener: true });
  const c3 = await s3.pair();
  assert.equal(c3.via, "direct");
  assert.equal(c3.certificate, "plain");
  assert.equal(c3.relayUrl, null);
  assert.equal(c3.relayWarning, null);
});

test("review L-1: only a self-signed relay — the code, but no link or QR: typed by hand, and plainly told not to click through the certificate warning (pairing, `daisy open --external`, the command line)", async () => {
  const s = await setup();
  const addr = await s.relayOn();
  const c = await s.pair();
  assert.equal(c.url, null);
  assert.equal(c.via, "relay");
  assert.equal(c.certificate, "self-signed");
  assert.match(String(c.code), /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  for (const w of ["在设备上手动输入", "不要点过证书警告", "不要继续"]) assert.ok(c.warning?.includes(w), `${w}: ${c.warning}`);
  assert.ok(!String(c.warning).includes("用不了"));
  const o = await s.d.ctx.app.inject({ method: "POST", url: api.access.openCodeExternal.path, headers: s.d.withPin() });
  assert.equal(o.statusCode, 200, o.body);
  assert.equal(o.json().url, null);
  assert.ok(o.json().code);
  assert.match(String(o.json().warning), /不要点过证书警告/);
  // The code typed by hand still works through the relay (what a client that checks the certificate some other way does).
  const ws = await s.phone(addr, "POST", "/api/web/session", { body: { code: o.json().code } });
  assert.equal(ws.status, 200, ws.text);
  // The command line: the code, no link line, the warning.
  const { renderPairingCode } = await import("../packages/daisy/src/cli/table.ts");
  const out: string[] = [];
  renderPairingCode(c, { io: { out: (x: string) => out.push(x) } } as any);
  const text = out.join("\n");
  assert.ok(text.includes(c.code));
  assert.ok(!text.split("\n").some((l) => l.startsWith("链接")), text);
  assert.ok(!text.includes("#pair="));
  assert.match(text, /在设备上手动输入/);
  const { renderExternalLink } = await import("../packages/daisy/src/cli/local/commands.ts");
  const out2: string[] = [];
  renderExternalLink(o.json(), (x: string) => out2.push(x));
  assert.ok(out2.join("\n").includes(o.json().code));
  assert.match(out2.join("\n"), /不要点过证书警告/);
  assert.ok(!out2.join("\n").includes("#code="));
});

test("review L-4: a CA's certificate from another directory than Let's Encrypt is `custom-ca` (the phone must trust that CA), said so; the phone that trusts it pairs through the relay", async () => {
  const s = await setup({ acme: true });
  const addr = await s.relayOn();
  const c = await s.pair();
  assert.equal(c.via, "relay");
  assert.equal(c.certificate, "custom-ca");
  assert.ok(c.warning?.includes("由你指定的证书机构签发（手机需要信任它）"), String(c.warning));
  assert.ok(c.warning?.includes(OPERATOR));
  const r = await s.phone(addr, "POST", "/api/devices/redeem", { body: { code: c.code }, ca: acme!.root });
  assert.equal(r.authorized, true, "a phone that trusts that CA");
  assert.equal(r.status, 200, r.text);
});

test("review L-4: what a browser makes of the relay certificate — `trusted` only for a Let's Encrypt leaf for this host, not expired; an ACME answer that is a CA, self-issued, or for another host counts as self-signed", async () => {
  const { browserTrustOf, acmeLeafOk } = await import("../packages/daisy/src/relay/certs.ts");
  const { DEFAULT_ACME_DIRECTORY } = await import("../packages/daisy/src/relay/config.ts");
  const now = Date.now();
  assert.equal(browserTrustOf({ kind: "acme", notAfter: now + 86_400_000, directory: DEFAULT_ACME_DIRECTORY }, now), "trusted");
  assert.equal(browserTrustOf({ kind: "acme", notAfter: now + 86_400_000, directory: "https://acme.test/directory" }, now), "custom-ca");
  assert.equal(browserTrustOf({ kind: "acme", notAfter: now - 1, directory: DEFAULT_ACME_DIRECTORY }, now), "self-signed");
  assert.equal(browserTrustOf({ kind: "self-signed", notAfter: now + 86_400_000, directory: DEFAULT_ACME_DIRECTORY }, now), "self-signed");
  const { X509Certificate, generateKeyPairSync } = await import("node:crypto");
  const { TestCA } = await import("../packages/relay/tests/helpers/pki.ts");
  const { selfSignedCert } = await import("../packages/daisy/src/relay/x509.ts");
  const ca = new TestCA("L-4 CA");
  const leaf = new X509Certificate(ca.issue(["abc.relay.test"]).cert);
  assert.equal(acmeLeafOk(leaf, "abc.relay.test"), true);
  assert.equal(acmeLeafOk(leaf, "other.relay.test"), false, "another host");
  assert.equal(acmeLeafOk(new X509Certificate(ca.cert), "abc.relay.test"), false, "a CA certificate");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  assert.equal(acmeLeafOk(new X509Certificate(selfSignedCert(privateKey, "abc.relay.test", 30)), "abc.relay.test"), false, "self-issued");
  // RelayCerts: an "ACME" answer that is self-issued is installed as self-signed.
  const { RelayCerts } = await import("../packages/daisy/src/relay/certs.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const certs = new RelayCerts(mkdtempSync(join(tmpdir(), "daisy-l4-")));
  certs.start("abc.relay.test", { enabled: false, directory: DEFAULT_ACME_DIRECTORY });
  const own = (certs as any).keyPem as string;
  const { createPrivateKey } = await import("node:crypto");
  (certs as any).install(selfSignedCert(createPrivateKey(own), "abc.relay.test", 30), "acme");
  assert.equal(certs.status().kind, "self-signed");
  assert.equal(certs.browserTrust(), "self-signed");
  certs.stop();
});

test("review L-2: a pairing lock is per caller — one source's wrong codes lock that source only; the owner's code still pairs from another; 20 wrong codes in a code's life void it; the list shows each lock", async () => {
  const s = await setup();
  const addr = await s.relayOn();
  const host = new URL(addr).hostname;
  const bad = relayCaller(s, host, "203.0.113.66");
  const good = relayCaller(s, host, "198.51.100.1");
  const c = await s.pair();
  for (let i = 0; i < DEVICE_LIMITS.redeemFailuresMax; i++) assert.equal((await bad("POST", "/api/devices/redeem", { code: newPairingCode() })).status, 401);
  // That caller is locked — even with the right code (which it does not use up).
  const locked = await bad("POST", "/api/devices/redeem", { code: c.code });
  assert.equal(locked.status, 423);
  assert.equal(s.d.ctx.access.devices.pendingCodes(), 1);
  // The list shows the lock, by source.
  const list = (await s.d.ctx.app.inject({ url: "/api/devices", headers: s.web })).json();
  assert.deepEqual(list.pairLocks.map((x: any) => x.who), ["relay:203.0.113.66"]);
  assert.ok(list.pairLockedUntil > Date.now());
  // Another caller pairs with the owner's code.
  const ok = await good("POST", "/api/devices/redeem", { code: c.code });
  assert.equal(ok.status, 200);
  // The global cap: 20 wrong codes (from however many sources) in a code's life void it.
  const d = s.d.ctx.access.devices;
  const fresh = await s.pair();
  for (let i = 0; i < DEVICE_LIMITS.codeWrongMax; i++)
    assert.throws(() => d.redeem(newPairingCode(), { face: "external", bucket: `relay:192.0.2.${i}` }));
  assert.equal(d.pendingCodes(), 0, "voided after 20 wrong codes in its life");
  assert.throws(() => d.redeem(fresh.code, { face: "external", bucket: "relay:192.0.2.250" }), (e: any) => e.code === "code_invalid" && e.key === "server-access.device.codeInvalid");
  const audit = JSON.stringify(s.d.ctx.store.all("SELECT action,target FROM audit"));
  assert.ok(audit.includes("device.pair.voided"));
  assert.ok(audit.includes("device.pair.locked"));
  // A code made after that has its own 20.
  const third = await s.pair();
  for (let i = 0; i < DEVICE_LIMITS.codeWrongMax - 1; i++) assert.throws(() => d.redeem(newPairingCode(), { face: "external", bucket: `relay:192.0.3.${i}` }));
  assert.equal(d.redeem(third.code, { face: "external", bucket: "relay:192.0.3.250" }).device.state, "active");
});

test("review L-3: choosing another relay voids the unused codes and the outside face's sessions and one-time codes (as turning the relay off does); choosing the same one again does not", async () => {
  const s = await setup();
  await s.relayOn();
  await s.pair();
  const ext = s.d.ctx.issueToken("external");
  const once = (await s.d.ctx.app.inject({ method: "POST", url: api.access.openCodeExternal.path, headers: s.d.withPin() })).json();
  assert.ok(s.d.ctx.access.web.find(ext));
  // The same relay again: nothing goes.
  const same = await s.d.ctx.app.inject({ method: "PUT", url: api.relay.relaySet.path, headers: s.d.withPin(), payload: { url: net.url, acme: false } });
  assert.equal(same.statusCode, 200, same.body);
  assert.equal(s.d.ctx.access.devices.pendingCodes(), 1);
  assert.ok(s.d.ctx.access.web.find(ext));
  // Another relay (another address): the codes, the outside sessions and the unused one-time code go.
  const other = await s.d.ctx.app.inject({ method: "PUT", url: api.relay.relaySet.path, headers: s.d.withPin(), payload: { url: "https://other-relay.test", acme: false } });
  assert.equal(other.statusCode, 200, other.body);
  assert.equal(s.d.ctx.access.devices.pendingCodes(), 0);
  assert.equal(s.d.ctx.access.web.find(ext), undefined, "the outside face's sessions went");
  assert.equal(s.d.ctx.access.web.takeCode(once.code, "external"), false);
});
