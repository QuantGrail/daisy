/**
 * P6-26 (phase-5 re-acceptance P5N-6, P5N-5; ADR-142 §5): a revoked paired
 * device is out at once — on the server, and on its page without a reload.
 *
 * A real Daisy with its outside face listening (plain HTTP on loopback);
 * the device is this process: real fetch, a real WebSocket (`ws`, the
 * browser's API), and the page's own device connection
 * (packages/ui/src/device-session.ts) on the real `@daisy-ai/client`.
 *
 * - Server: the command line's revoke (`daisy device revoke`, PIN) — the
 *   device's open live socket closes at once with its own code (4401); every
 *   request of its session is refused at once (no grace, nothing cached);
 *   its credential is refused; a new socket is refused; another device is
 *   untouched.
 * - Client: on that close the credential is asked for at once (before any
 *   reconnect — no timer), the trade is refused, the device given up
 *   (credential and session forgotten, `gone` told once, the view hears a
 *   401); a page coming back into view asks at once; the first load of a
 *   new window (no session yet) gets in directly; the credential only ever
 *   goes to the address the device paired with.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import WebSocketNode from "ws";
import { daisy } from "./fixtures/daisy-with-issuer.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { LIVE_CLOSE } from "../packages/contracts/src/live.ts";
import { DaisyError } from "../packages/client/src/index.ts";
import {
  deviceInvalid,
  pairedDeviceClient,
  pairCodeFromHash,
  watchPageShown,
  restorePairedDevice,
} from "../packages/ui/src/device-session.ts";
import {
  forgetPairedDevice,
  keptSessionToken,
  pairedDeviceForPage,
  parsePairedDevice,
  type PairedDevice,
} from "../packages/ui/src/device-store.ts";

const PIN = "246810";
const webHolder = (token: string) => `web:${createHash("sha256").update(token).digest("hex")}`;

async function setup() {
  const d = await daisy();
  const on = await d.ctx.app.inject({
    method: "PUT",
    url: "/api/access/external",
    headers: d.withPin(),
    payload: { host: "127.0.0.1", tls: false },
  });
  assert.equal(on.statusCode, 200, on.body);
  const ext = `http://127.0.0.1:${on.json().external.port}`;
  const webToken = d.ctx.issueToken();
  const web = { authorization: `Bearer ${webToken}` };
  const webPin = () => ({ ...web, [PIN_GRANT_HEADER]: d.pin.grant(PIN, webHolder(webToken)).grant });
  const cat = (await d.ctx.app.inject({ url: "/api/catalog", headers: web })).json();
  const session = (
    await d.ctx.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: web,
      payload: { agent: "claude", workspaceId: cat.workspaces[0].id, profileId: cat.profiles.find((p: any) => p.agent === "claude").id },
    })
  ).json().id as string;
  const phone = async (method: string, path: string, o: { token?: string; body?: unknown } = {}) => {
    const r = await fetch(ext + path, {
      method,
      headers: {
        ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
  /** Pair a device all the way (the owner's page makes the code, the device redeems it). */
  const paired = async (name: string) => {
    const c = await d.ctx.app.inject({ method: "POST", url: "/api/devices/pair", headers: webPin(), payload: { name } });
    assert.equal(c.statusCode, 200, c.body);
    const r = await phone("POST", "/api/devices/redeem", { body: { code: c.json().code, name } });
    assert.equal(r.status, 200, r.text);
    return r.json as { deviceId: string; token: string; secret: string };
  };
  /** `daisy device revoke <id>`: the command line's credential on the local face, with the PIN. */
  const cliRevoke = (id: string) => d.ctx.app.inject({ method: "DELETE", url: `/api/devices/${id}`, headers: d.withPin() });
  return { d, ext, web, session, phone, paired, cliRevoke };
}

const until = async (ok: () => boolean, what: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`not in time: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A raw live socket subscribed to `sessionId` with `token`. */
async function socket(ext: string, token: string, sessionId: string) {
  const ws = new WebSocketNode(ext.replace(/^http/, "ws") + "/api/live");
  const frames: any[] = [];
  const s = { ws, frames, closed: null as { code: number; reason: string } | null };
  ws.on("message", (m) => frames.push(JSON.parse(String(m))));
  ws.on("close", (code, reason) => (s.closed = { code, reason: String(reason) }));
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "subscribe", token, sessionId }));
  return s;
}

test("P5N-6 server: the command line's revoke ends the device at once — its socket closes with 4401, every request of its session is 401 at once, its credential too, a new socket is refused; another device is untouched", async () => {
  const { d, ext, session, phone, paired, cliRevoke } = await setup();
  try {
    const a = await paired("A");
    const b = await paired("B");
    const sa = await socket(ext, a.token, session);
    const sb = await socket(ext, b.token, session);
    await until(() => sa.frames.some((f) => f.type === "ready") && sb.frames.some((f) => f.type === "ready"), "both sockets ready");
    // Used a moment ago: anything that might keep it valid for a while is warm.
    for (const p of ["/api/me", "/api/sessions", `/api/sessions/${session}`]) assert.equal((await phone("GET", p, { token: a.token })).status, 200, p);
    const r = await cliRevoke(a.deviceId);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().revoked.state, "revoked");
    // At once, no wait in between: every kind of request of its session.
    const refused = async (method: string, path: string, body?: unknown) => {
      const x = await phone(method, path, { token: a.token, ...(body !== undefined ? { body } : {}) });
      assert.equal(x.status, 401, `${method} ${path}: ${x.text}`);
      assert.match(String(x.headers.get("www-authenticate")), /invalid_token/, path);
      assert.ok(!x.text.includes(session) || path.includes(session), "no data in the answer");
    };
    await refused("GET", "/api/me");
    await refused("GET", "/api/sessions");
    await refused("GET", `/api/sessions/${session}`);
    await refused("GET", "/api/events?after=0");
    await refused("PATCH", `/api/sessions/${session}`, { title: "after revoke" });
    // Its credential: no new session.
    const ex = await phone("POST", "/api/devices/session", { body: { secret: a.secret } });
    assert.equal(ex.status, 401);
    assert.equal(ex.json.code, "device_invalid");
    // Its open socket: closed now, with the revocation's own code.
    await until(() => sa.closed !== null, "the device's socket closed", 2000);
    assert.deepEqual(sa.closed, { code: LIVE_CLOSE.deviceRevoked, reason: "Device revoked" });
    // A new socket with its session: refused.
    const again = await socket(ext, a.token, session);
    await until(() => again.closed !== null, "a new socket refused");
    assert.equal(again.closed!.code, LIVE_CLOSE.credential);
    assert.ok(!again.frames.some((f) => f.type === "ready"));
    // The title did not change (the refused PATCH did nothing).
    const s = await d.ctx.app.inject({ url: `/api/sessions/${session}`, headers: d.asCli });
    assert.notEqual(s.json().session?.title, "after revoke");
    // B: its socket still open, its requests answered.
    assert.equal(sb.closed, null);
    assert.equal((await phone("GET", "/api/sessions", { token: b.token })).status, 200);
    sb.ws.close();
  } finally {
    await d.close();
  }
});

/** What the page keeps (sessionStorage / localStorage in the browser). */
function keeper(device: PairedDevice) {
  const k = {
    device: device as PairedDevice | null,
    session: "" as string | null,
    gone: 0,
    keep: {
      session: (t: string | null) => void (k.session = t),
      forget: () => void (k.device = null),
    },
  };
  return k;
}

test("P5N-6 client: on the 4401 close the page asks for its credential at once (before any reconnect), is refused, gives the device up — forgotten, told once, the view hears a 401", async () => {
  const { d, ext, session, paired, cliRevoke } = await setup();
  const watches: { close(): void }[] = [];
  try {
    const a = await paired("A");
    const device: PairedDevice = { id: a.deviceId, secret: a.secret, name: "A", url: ext };
    const k = keeper(device);
    const events: string[] = [];
    class WS extends WebSocketNode {
      constructor(url: string) {
        super(url);
        events.push("socket");
      }
    }
    const urls: string[] = [];
    const dc = pairedDeviceClient(device, a.token, {
      keep: k.keep,
      gone: () => k.gone++,
      fetch: (url, init) => {
        urls.push(url);
        if (url.endsWith("/api/devices/session")) events.push("trade");
        return fetch(url, init);
      },
      WebSocket: WS as any,
    });
    const errors: unknown[] = [];
    let live = false;
    const w = dc.client.watchSession(
      session,
      {
        data: () => {},
        connection: (s) => (live = s === "live"),
        error: (e) => errors.push(e),
      },
      // No polling in the way: only the socket can tell.
      { pollMs: 60_000, livePollMs: 60_000, pingMs: 60_000 },
    );
    watches.push(w);
    await until(() => live, "the view is live");
    events.length = 0;
    const r = await cliRevoke(a.deviceId);
    assert.equal(r.statusCode, 200, r.body);
    await until(() => k.gone === 1, "the device given up", 3000);
    // The credential was asked for on the close itself: the trade came
    // before any new socket (the reconnect timer had not fired).
    assert.equal(events[0], "trade", events.join(","));
    assert.equal(events.filter((e) => e === "trade").length, 1);
    assert.equal(k.device, null, "the device credential is forgotten");
    assert.equal(k.session, null, "the device session is forgotten");
    await until(() => errors.some((e) => e instanceof DaisyError && e.status === 401), "the view heard a 401");
    // Given up: no more trades with a void credential, however often asked.
    await assert.rejects(dc.client.credential(true), (e: any) => e instanceof DaisyError && e.status === 401);
    assert.equal(events.filter((e) => e === "trade").length, 1);
    assert.equal(k.gone, 1, "told once");
    // Review M-2: everything went to the address it paired with.
    assert.ok(urls.length > 0 && urls.every((u) => u.startsWith(ext + "/api/")), urls.join(" "));
  } finally {
    for (const w of watches) w.close();
    await d.close();
  }
});

test("P5N-6 client: an idle page with no socket asks at once when it comes back into view (a hidden page asks nothing)", async () => {
  const { d, ext, paired, cliRevoke } = await setup();
  try {
    const a = await paired("A");
    const device: PairedDevice = { id: a.deviceId, secret: a.secret, name: "A", url: ext };
    const k = keeper(device);
    let requests = 0;
    const dc = pairedDeviceClient(device, a.token, {
      keep: k.keep,
      gone: () => k.gone++,
      fetch: (url, init) => {
        requests++;
        return fetch(url, init);
      },
    });
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    const stop = watchPageShown(dc, win, doc);
    assert.equal((await cliRevoke(a.deviceId)).statusCode, 200);
    // Hidden: nothing asked.
    doc.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(requests, 0);
    assert.equal(k.gone, 0);
    // Shown: asked at once — 401, the trade refused, given up.
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await until(() => k.gone === 1, "given up when shown", 3000);
    assert.equal(k.device, null);
    stop();
    // Stopped: no more checks.
    const before = requests;
    win.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(requests, before);
  } finally {
    await d.close();
  }
});

test("P5N-5: a new window (the credential kept, no session yet) gets in on its first load; a stale session is renewed; a revoked device is given up; an unreachable Daisy keeps the pairing", async () => {
  const { d, ext, paired, cliRevoke } = await setup();
  try {
    const a = await paired("A");
    const device: PairedDevice = { id: a.deviceId, secret: a.secret, name: "A", url: ext };
    // A new window: no session kept.
    const k1 = keeper(device);
    let trades = 0;
    const counting = (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/devices/session")) trades++;
      return fetch(url, init);
    };
    const first = pairedDeviceClient(device, "", { keep: k1.keep, gone: () => k1.gone++, fetch: counting });
    assert.equal((await restorePairedDevice(first)).state, "in");
    assert.equal(trades, 1, "one trade, then in");
    assert.match(String(k1.session), /^dweb_/, "the new session is kept for the next load");
    // A session that ended (12 hours, or voided): renewed with the credential.
    const k2 = keeper(device);
    const stale = pairedDeviceClient(device, "dweb_not-a-session-anymore", { keep: k2.keep, gone: () => k2.gone++, fetch: counting });
    assert.equal((await restorePairedDevice(stale)).state, "in");
    assert.equal(trades, 2);
    // Daisy unreachable: the pairing stays.
    const k3 = keeper(device);
    const down = pairedDeviceClient(device, "", {
      keep: k3.keep,
      gone: () => k3.gone++,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    assert.equal((await restorePairedDevice(down)).state, "outage");
    assert.ok(k3.device, "an outage does not erase the pairing");
    assert.equal(k3.gone, 0);
    // Revoked: given up, told.
    assert.equal((await cliRevoke(a.deviceId)).statusCode, 200);
    const k4 = keeper(device);
    const late = pairedDeviceClient(device, "", { keep: k4.keep, gone: () => k4.gone++ });
    assert.equal((await restorePairedDevice(late)).state, "gone");
    assert.equal(k4.device, null);
    assert.equal(k4.gone, 1);
  } finally {
    await d.close();
  }
});

test("P5N-5: the pairing code in the address bar; the app lets a paired device in before it looks at a `#pair=` link, and handles one that arrives on an open page", () => {
  assert.equal(pairCodeFromHash("#pair=ABCDE-FGHJK"), "ABCDE-FGHJK");
  assert.equal(pairCodeFromHash("#x=1&pair=ABCDE%2DFGHJK"), "ABCDE-FGHJK");
  assert.equal(pairCodeFromHash("#pair=%E0%A4%A"), "", "malformed: the pairing mode, empty");
  assert.equal(pairCodeFromHash("#code=abc"), null);
  assert.equal(pairCodeFromHash(""), null);
  assert.equal(pairCodeFromHash(undefined), null);
  // apps/app/App.tsx (no DOM in these tests; scripts/e2e-pairing.cjs drives it in a browser).
  const app = readFileSync("apps/app/App.tsx", "utf8");
  const boot = app.slice(app.indexOf("const boot = async"));
  const restore = boot.indexOf("restorePairedDevice(");
  const pairMode = boot.indexOf("setPairCode(pair)");
  assert.ok(restore > 0 && pairMode > restore, "a working pairing is tried before the pairing screen");
  const changed = app.slice(app.indexOf("const changed = () =>"), app.indexOf('addEventListener("hashchange", changed)'));
  assert.match(changed, /takeHashPair\(\)/, "a `#pair=` link on an open page is taken");
  assert.match(changed, /setPairCode\(pair\)/);
  assert.match(app, /watchPageShown\(d, window, document\)/);
});

// ── P6-26 review ─────────────────────────────────────────────────────────

/** A localStorage / sessionStorage stand-in. */
function storage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}

test("review M-1: a stale tab giving up its old device does not erase the credential another tab paired anew — only the record it holds is forgotten", () => {
  const old: PairedDevice = { id: "dev_old", secret: "ddev_old", name: "A", url: "https://10.0.0.2:29600" };
  const fresh: PairedDevice = { id: "dev_new", secret: "ddev_new", name: "A", url: "https://10.0.0.2:29600" };
  // Another tab re-paired meanwhile: the stored record is the new one.
  const ls = storage({ "daisy.device.v1": JSON.stringify(fresh) });
  assert.equal(forgetPairedDevice(ls, "daisy.device.v1", old), false);
  assert.equal(parsePairedDevice(ls.getItem("daisy.device.v1"))?.secret, "ddev_new", "the new credential stays");
  // Same id, another secret (re-paired under the same record? never — still not ours).
  assert.equal(forgetPairedDevice(ls, "daisy.device.v1", { ...fresh, secret: "ddev_other" }), false);
  assert.ok(ls.getItem("daisy.device.v1"));
  // Its own record: forgotten.
  assert.equal(forgetPairedDevice(ls, "daisy.device.v1", fresh), true);
  assert.equal(ls.getItem("daisy.device.v1"), null);
  // Nothing stored, or unreadable: nothing to do.
  assert.equal(forgetPairedDevice(storage(), "daisy.device.v1", fresh), false);
  const junk = storage({ "daisy.device.v1": "not json" });
  assert.equal(forgetPairedDevice(junk, "daisy.device.v1", fresh), false);
  assert.equal(junk.getItem("daisy.device.v1"), "not json");
  // The app forgets through it (logout and the given-up device alike).
  const app = readFileSync("apps/app/App.tsx", "utf8");
  assert.doesNotMatch(app, /writeDevice\(null\)/);
  assert.match(app, /forgetPairedDevice\(localStorage, deviceKey, /);
});

test("review L-1: a stored device is used only on the page of the Daisy it paired with; a kept session only with that address", () => {
  const dev: PairedDevice = { id: "dev_a", secret: "ddev_a", name: "A", url: "https://h.example:29711/daisy" };
  assert.equal(pairedDeviceForPage(dev, "https://h.example:29711/daisy"), dev);
  assert.equal(pairedDeviceForPage(dev, "https://h.example:29711/daisy/"), dev, "a trailing slash is the same address");
  assert.equal(pairedDeviceForPage(dev, "https://h.example:29711/other"), null, "another Daisy under the same origin");
  assert.equal(pairedDeviceForPage(dev, "https://h.example:29711"), null);
  assert.equal(pairedDeviceForPage(null, "https://h.example:29711/daisy"), null);
  const kept = (url: string) => JSON.stringify({ url, token: "dweb_x" });
  assert.equal(keptSessionToken(kept("https://h.example:29711/daisy"), dev.url), "dweb_x");
  assert.equal(keptSessionToken(kept("https://h.example:29711/other"), dev.url), "", "another Daisy's session is not sent here");
  assert.equal(keptSessionToken(JSON.stringify({ token: "dweb_x" }), dev.url), "", "no address: not used");
  assert.equal(keptSessionToken("not json", dev.url), "");
  assert.equal(keptSessionToken(null, dev.url), "");
  const app = readFileSync("apps/app/App.tsx", "utf8");
  assert.match(app, /pairedDeviceForPage\(await readDevice\(\), url\)/);
  assert.match(app, /keptSessionToken\(/);
});

test("review L-2: only a 401 device_invalid gives the pairing up; a 403 (device_face, cross_site), a 429 or another 401 keep it and show the error", async () => {
  const device: PairedDevice = { id: "dev_a", secret: "ddev_a", name: "A", url: "http://127.0.0.1:1" };
  const answer = (status: number, code: string) => async (url: string) => {
    if (!url.endsWith("/api/devices/session")) {
      return new Response(JSON.stringify({ error: "refused", code: "unauthenticated" }), {
        status: 401,
        headers: { "content-type": "application/json", "www-authenticate": 'Bearer error="invalid_token"' },
      });
    }
    return new Response(JSON.stringify({ error: `said ${code}`, code }), { status, headers: { "content-type": "application/json" } });
  };
  for (const [status, code] of [
    [403, "device_face"],
    [403, "cross_site"],
    [429, "rate_limited"],
    [401, "unauthenticated"],
  ] as const) {
    const k = keeper(device);
    k.session = "dweb_kept";
    const d = pairedDeviceClient(device, "dweb_old", { keep: k.keep, gone: () => k.gone++, fetch: answer(status, code) as any });
    const r = await restorePairedDevice(d);
    assert.equal(k.gone, 0, `${status} ${code}: not given up`);
    assert.ok(k.device, `${status} ${code}: the pairing is kept`);
    assert.notEqual(r.state, "gone");
    if (status !== 429) {
      assert.equal(r.state, "refused", `${status} ${code}`);
      assert.match(String(r.error?.message), new RegExp(`said ${code}`), "the error to show");
    }
  }
  // 401 device_invalid: given up.
  const k = keeper(device);
  const d = pairedDeviceClient(device, "dweb_old", { keep: k.keep, gone: () => k.gone++, fetch: answer(401, "device_invalid") as any });
  assert.equal((await restorePairedDevice(d)).state, "gone");
  assert.equal(k.gone, 1);
  assert.equal(k.device, null);
  assert.equal(deviceInvalid(new DaisyError(401, "x", "device_invalid")), true);
  assert.equal(deviceInvalid(new DaisyError(403, "x", "device_face")), false);
  assert.equal(deviceInvalid(new DaisyError(401, "x", "unauthenticated")), false);
});

test("review L-4: a `#pair=` link arriving on the login screen keeps the message shown there", () => {
  const app = readFileSync("apps/app/App.tsx", "utf8");
  const changed = app.slice(app.indexOf("const changed = () =>"), app.indexOf('addEventListener("hashchange", changed)'));
  assert.doesNotMatch(changed, /text: ""/);
  assert.match(changed, /text: e\.text, n: e\.n \+ 1/);
});

// ── P6-27 (phase-5 2nd re-acceptance P5N-8, P5N-7) ───────────────────────

/** A fetch that never answers until aborted (a request the frozen page left hanging). */
function hanging(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_, fail) => {
    if (signal?.aborted) return fail(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => fail(new DOMException("aborted", "AbortError")));
  });
}

test("P5N-8 check: on a connection of its own — a page whose client is stuck behind a trade that never answers still finds out at once that it was revoked", async () => {
  const { d, ext, paired, cliRevoke } = await setup();
  const stuck: AbortController[] = [];
  try {
    const a = await paired("A");
    const device: PairedDevice = { id: a.deviceId, secret: a.secret, name: "A", url: ext };
    const k = keeper(device);
    let trades = 0;
    const dc = pairedDeviceClient(device, "", {
      keep: k.keep,
      gone: () => k.gone++,
      checkMs: 2000,
      fetch: (url, init) => {
        if (url.endsWith("/api/devices/session") && ++trades === 1) {
          // The first trade hangs (the page was frozen in the middle of it).
          const c = new AbortController();
          stuck.push(c);
          return hanging(c.signal);
        }
        return fetch(url, init);
      },
    });
    // Everything through the client now waits behind that trade.
    let settled = false;
    void dc.client.request("/me").then(
      () => (settled = true),
      () => (settled = true),
    );
    await until(() => trades === 1, "the first trade is under way");
    assert.equal((await cliRevoke(a.deviceId)).statusCode, 200);
    const t0 = Date.now();
    assert.equal(await dc.check(), "gone");
    assert.ok(Date.now() - t0 < 1500, `found out in ${Date.now() - t0} ms`);
    assert.equal(k.gone, 1, "given up, told once");
    assert.equal(k.device, null);
    assert.equal(settled, false, "the client's own request was still waiting");
    assert.equal(await dc.check(), "gone", "and stays gone (no more trades)");
    assert.equal(trades, 2);
  } finally {
    for (const c of stuck) c.abort();
    await d.close();
  }
});

test("P5N-8 check: in when paired; a session that ran out is traded and kept; Daisy not answering in time is `unknown` — the pairing kept", async () => {
  const { d, ext, paired } = await setup();
  try {
    const a = await paired("A");
    const device: PairedDevice = { id: a.deviceId, secret: a.secret, name: "A", url: ext };
    const k = keeper(device);
    let trades = 0;
    const dc = pairedDeviceClient(device, a.token, {
      keep: k.keep,
      gone: () => k.gone++,
      fetch: (url, init) => {
        if (url.endsWith("/api/devices/session")) trades++;
        return fetch(url, init);
      },
    });
    assert.equal(await dc.check(), "in");
    assert.equal(trades, 0);
    dc.client.token = "dweb_ran-out";
    assert.equal(await dc.check(), "in");
    assert.equal(trades, 1);
    assert.match(dc.client.token, /^dweb_/);
    assert.notEqual(dc.client.token, "dweb_ran-out");
    assert.equal(k.session, dc.client.token, "the new session is kept for the next load");
    // Daisy does not answer (a hung connection): bounded, nothing forgotten.
    const k2 = keeper(device);
    const silent = pairedDeviceClient(device, a.token, {
      keep: k2.keep,
      gone: () => k2.gone++,
      checkMs: 200,
      fetch: (_url, init) => hanging(init?.signal),
    });
    const t0 = Date.now();
    assert.equal(await silent.check(), "unknown");
    assert.ok(Date.now() - t0 < 1000);
    assert.ok(k2.device, "an outage does not erase the pairing");
    assert.equal(k2.gone, 0);
    // And the first load never waits forever: an outage after its bound.
    const t1 = Date.now();
    assert.equal((await restorePairedDevice(silent, 300)).state, "outage");
    assert.ok(Date.now() - t1 < 1500, `${Date.now() - t1} ms`);
    assert.ok(k2.device);
  } finally {
    await d.close();
  }
});

test("P5N-8 watchPageShown: every way back (shown, focus, pageshow, resume after a freeze, online) wakes the watches and checks — never while hidden; one check at a time; the watchdog checks when its tick comes late and asks again while Daisy does not answer", async () => {
  let checks = 0,
    wakes = 0,
    answer: "in" | "unknown" | "gone" = "in",
    hold: (() => void) | null = null;
  const dev = {
    check: () => {
      checks++;
      if (hold === null && answer !== "in") return Promise.resolve(answer);
      return new Promise<"in" | "unknown" | "gone">((ok) => {
        if (hold === null) return ok(answer);
        const was = hold;
        hold = () => {
          was();
          ok(answer);
        };
      });
    },
    client: { wake: () => void wakes++ },
  };
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  let clock = 1_000_000;
  const flush = () => new Promise((r) => setTimeout(r, 5));
  const stop = watchPageShown(dev, win, doc, { tickMs: 10, jumpMs: 1000, retryMs: 100 }, () => clock);
  try {
    // Hidden: nothing, whatever arrives (and however late the clock).
    for (const e of ["focus", "pageshow", "online"]) win.dispatchEvent(new Event(e));
    for (const e of ["visibilitychange", "resume"]) doc.dispatchEvent(new Event(e));
    clock += 60_000;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(checks, 0);
    assert.equal(wakes, 0);
    // Shown: each way back checks at once and wakes the watches.
    doc.visibilityState = "visible";
    let n = 0;
    for (const [target, e] of [
      [doc, "visibilitychange"],
      [doc, "resume"],
      [win, "focus"],
      [win, "pageshow"],
      [win, "online"],
    ] as const) {
      target.dispatchEvent(new Event(e));
      n++;
      assert.equal(checks, n, e);
      assert.equal(wakes, n, e);
      await flush();
    }
    // One at a time: a check still out is not doubled (the watches are still woken).
    hold = () => {};
    win.dispatchEvent(new Event("focus"));
    win.dispatchEvent(new Event("focus"));
    assert.equal(checks, n + 1);
    assert.equal(wakes, n + 2);
    const release = hold;
    hold = null;
    (release as () => void)();
    await flush();
    n = checks;
    // Frozen without any event: the watchdog's next tick comes late → check.
    clock += 5_000;
    await until(() => checks === n + 1, "the watchdog checked after the gap", 1000);
    // Daisy did not answer: asked again every retryMs while shown …
    answer = "unknown";
    clock += 5_000;
    await until(() => checks === n + 2, "the late tick checked", 1000);
    await flush();
    clock += 150;
    await until(() => checks === n + 3, "asked again", 1000);
    // … until it answers; then only the ways back ask.
    answer = "in";
    await flush();
    clock += 150;
    await until(() => checks === n + 4, "asked again", 1000);
    await flush();
    clock += 150;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(checks, n + 4, "answered: no more retries");
  } finally {
    stop();
  }
  // Stopped: nothing more.
  const before = checks;
  win.dispatchEvent(new Event("focus"));
  clock += 60_000;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(checks, before);
});

test("P5N-8 client.wake(): a socket down in a long back-off reconnects at once; a socket that died without a word (no pong) is noticed within pongMs, not at the next ping", async () => {
  const { d, ext, session, paired } = await setup();
  const watches: { close(): void }[] = [];
  try {
    const a = await paired("A");
    const device: PairedDevice = { id: a.deviceId, secret: a.secret, name: "A", url: ext };
    const k = keeper(device);
    let blocked = true,
      mute = false,
      sockets = 0;
    // A port nothing listens on (the network gone while the page was frozen).
    const dead = await new Promise<number>((ok) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as AddressInfo).port;
        srv.close(() => ok(p));
      });
    });
    class WS extends WebSocketNode {
      constructor(url: string) {
        super(blocked ? url.replace(/:\d+\//, `:${dead}/`) : url);
        sockets++;
      }
      send(data: any) {
        if (!mute) super.send(data);
      }
    }
    const dc = pairedDeviceClient(device, a.token, { keep: k.keep, gone: () => k.gone++, WebSocket: WS as any });
    const states: string[] = [];
    const w = dc.client.watchSession(
      session,
      { data: () => {}, connection: (s) => states.push(s) },
      { pollMs: 60_000, livePollMs: 60_000, pingMs: 60_000, pongMs: 300 },
    );
    watches.push(w);
    // Four failed attempts: the next one is ~4 s away.
    await until(() => sockets >= 4, "four attempts", 8000);
    blocked = false;
    const t0 = Date.now();
    dc.client.wake();
    await until(() => states.at(-1) === "live", "live again after wake", 2000);
    assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms (the back-off was forgotten)`);
    // The socket dies without a word: nothing answers its pings any more.
    mute = true;
    const t1 = Date.now();
    dc.client.wake();
    await until(() => states.at(-1) !== "live", "noticed", 2000);
    assert.ok(Date.now() - t1 < 1500, `${Date.now() - t1} ms`);
    mute = false;
    await until(() => states.at(-1) === "live", "back", 3000);
  } finally {
    for (const w of watches) w.close();
    await d.close();
  }
});
