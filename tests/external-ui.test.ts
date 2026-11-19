/**
 * P2-04 (ADR-115): an external interface connects to the owner's Daisys.
 *
 * An "interface backend" (this test process, playing a host platform's backend)
 * holds one token the fake external issuer signed for the owner and uses
 * the client package (`DaisyConnections`, real fetch + WebSocket over real
 * listeners) to work on two Daisys at once — one through its local face,
 * one through its outside face (D-31). Then: a token that expired is
 * renewed through `credentials()` (HTTP and the live socket); a Daisy that
 * stops does not hold up the other; a visitor's token is refused; and the
 * browser-side rules — the owner's list of allowed interface origins
 * (PIN), the preflight, CORS answers, only the issuer's owner token from
 * such an origin. Refusals first where they are the point.
 *
 * Both feeds are followed with a cursor of their own on each Daisy: the
 * session notifications and (stage-2 merge) P2-03's event outlet —
 * `followEvents`, by sequence number, a stopped Daisy not holding up the
 * other, and reading on from the kept cursor after a restart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import WebSocketNode from "ws";
import {
  DaisyConnections,
  DaisyClient,
  DaisyError,
  type CredentialRequest,
} from "../packages/client/src/index.ts";
import { api } from "../packages/contracts/src/index.ts";
import { daisy, OWNER_SUB, OTHER_SUB, type Daisy } from "./fixtures/daisy-with-issuer.ts";
import { fakeIssuer, type FakeIssuer } from "./fixtures/fake-issuer.ts";
import { notificationWriter } from "../packages/daisy/src/sessions/notifications.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";
import { normalizeUiOrigin, readUiOrigins } from "../packages/daisy/src/access/ui-origins.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";

const now = () => Math.floor(Date.now() / 1000);
const OWNER_SCOPE = "daisy:session:read daisy:session:write daisy:manage daisy:grant daisy:events:read";

/** Wait until `ok()` (polling), or fail saying what was waited for. */
async function until(ok: () => boolean, what: string, ms = 10000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`没等到：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Two Daisys trusting one fake issuer: A on its local face, B on its outside face. */
async function twoDaisys() {
  const iss = await fakeIssuer();
  const A = await daisy({ issuer: iss });
  const B = await daisy({ issuer: iss });
  for (const d of [A, B]) assert.equal((await d.configure()).statusCode, 200);
  await A.ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const urlA = `http://127.0.0.1:${(A.ctx.app.server.address() as any).port}`;
  const on = await B.ctx.app.inject({
    method: "PUT",
    url: "/api/access/external",
    headers: B.withPin(),
    payload: { host: "127.0.0.1", tls: false },
  });
  assert.equal(on.statusCode, 200, on.body);
  const urlB = `http://127.0.0.1:${on.json().external.port}`;
  /**
   * One token for the owner, good at both (`aud` names both Daisys). The
   * interface backend also follows the event outlet, so its token carries
   * `daisy:events:read` (P2-03) next to the owner's four.
   */
  const ownerToken = (o: { ttlS?: number; iat?: number } = {}) =>
    iss.sign({ sub: OWNER_SUB, aud: [A.urn, B.urn], scope: OWNER_SCOPE }, o);
  const close = async () => {
    await A.close();
    await B.close();
    await iss.close();
  };
  return { iss, A, B, urlA, urlB, ownerToken, close };
}

/** A session on `c`'s Daisy (its first workspace and Claude identity). */
async function newSession(c: DaisyClient) {
  const cat = await c.catalog();
  const s = await c.create({
    agent: "claude",
    workspaceId: cat.workspaces[0]!.id,
    profileId: cat.profiles.find((p: any) => p.agent === "claude")!.id,
  });
  return s.id as string;
}

/** A card on `d`'s event outlet (stage 4's write point for a call request). */
const card = (d: Daisy, id: string) =>
  d.ctx.events.opened({ uid: OWNER_ID, kind: "invocation", cardId: `call:${id}`, title: `有人想调用 ${id}` });

/** A notification on `d` (what a turn ending writes), for the feed. */
const notify = (d: Daisy, sessionId: string, key: string) =>
  notificationWriter(d.ctx.store).emit({
    userId: OWNER_ID,
    kind: "ai_failed",
    key,
    title: `出错了 ${key}`,
    sessionId,
    subject: key,
  });

test("P2-04: one interface backend works on two Daisys at once with one issuer token — sessions, messages, live sockets, own cursors", async () => {
  const t = await twoDaisys();
  const pool = new DaisyConnections();
  try {
    const token = await t.ownerToken();
    const asked: CredentialRequest[] = [];
    // A provider shared by both connections (it is told which one asks).
    const credentials = (r: CredentialRequest) => {
      asked.push(r);
      return token;
    };
    const a = pool.add({ id: "a", baseUrl: t.urlA, credentials });
    const b = pool.add({ id: "b", baseUrl: t.urlB, credentials });

    // Who each Daisy takes us for: the owner, through the issuer channel,
    // on the face we came in by.
    const me = await pool.each((c) => c.me());
    assert.deepEqual(
      me.map((r) => (r.ok ? [r.id, r.value.channel, r.value.face] : [r.id, String(r.error)])),
      [
        ["a", "issuer", "local"],
        ["b", "issuer", "external"],
      ],
    );
    assert.deepEqual(
      asked.map((r) => [r.id, r.refresh, r.baseUrl]),
      [
        ["a", false, t.urlA],
        ["b", false, t.urlB],
      ],
    );

    // A session on each, a message on each.
    const sa = await newSession(a);
    const sb = await newSession(b);
    await a.send(sa, "你好 A");
    await b.send(sb, "你好 B");

    // Each conversation followed live on its own Daisy's socket.
    const seen: Record<string, { texts: string[]; states: string[]; versions: number }> = {
      a: { texts: [], states: [], versions: 0 },
      b: { texts: [], states: [], versions: 0 },
    };
    const watch = (id: "a" | "b", sid: string) =>
      pool.watchSession(id, sid, {
        data: (s) => {
          seen[id]!.texts = s.items.map((x: any) => x.text ?? "").filter(Boolean);
        },
        version: () => void seen[id]!.versions++,
        connection: (st) => void seen[id]!.states.push(st),
      }, { pollMs: 60000, livePollMs: 60000 });
    watch("a", sa);
    watch("b", sb);
    await until(() => seen.a!.states.at(-1) === "live" && seen.b!.states.at(-1) === "live", "两个实时通道都连上");
    assert.ok(seen.a!.texts.some((x) => x.includes("你好 A")), JSON.stringify(seen.a));
    assert.ok(seen.b!.texts.some((x) => x.includes("你好 B")), JSON.stringify(seen.b));
    assert.ok(!seen.a!.texts.some((x) => x.includes("你好 B")));

    // A change on A reaches A's socket (and only A's).
    const vb = seen.b!.versions;
    await a.send(sa, "第二条 A", [], undefined, "queue");
    await until(() => seen.a!.texts.some((x) => x.includes("第二条 A")), "A 的实时通道收到第二条");
    assert.equal(seen.b!.versions, vb);

    // The session events, read by sequence number through the route table.
    for (const [c, sid] of [
      [a, sa],
      [b, sb],
    ] as const) {
      const ev = await c.call(api.sessions.events, { params: { id: sid }, query: { after: 0 } });
      assert.ok(ev.events.length > 0);
    }

    // Each Daisy's notifications followed from a cursor of its own.
    const got: Record<string, { keys: string[]; cursor: number }> = {
      a: { keys: [], cursor: 0 },
      b: { keys: [], cursor: 0 },
    };
    for (const id of ["a", "b"] as const)
      pool.followNotifications(id, {
        items: (items, cursor) => {
          got[id]!.keys.push(...items.map((x: any) => x.notificationId ?? x.id));
          got[id]!.cursor = cursor;
        },
      }, { pollMs: 50 });
    notify(t.A, sa, "n-a1");
    notify(t.B, sb, "n-b1");
    notify(t.B, sb, "n-b2");
    await until(() => got.a!.keys.length === 1 && got.b!.keys.length === 2, "两边的通知各自读到");
    assert.ok(got.a!.cursor > 0 && got.b!.cursor > 0);
    // Only what is new after the cursor comes next.
    notify(t.A, sa, "n-a2");
    await until(() => got.a!.keys.length === 2, "A 的第二条通知");
    assert.equal(got.b!.keys.length, 2);

    // P2-03: each Daisy's event outlet followed by its own sequence numbers
    // (a snapshot first, then the long poll), with the issuer's owner token.
    const evs: Record<string, { subjects: string[]; cursor: number; snapshots: number; recipients: string[] }> = {
      a: { subjects: [], cursor: 0, snapshots: 0, recipients: [] },
      b: { subjects: [], cursor: 0, snapshots: 0, recipients: [] },
    };
    card(t.A, "a-open");
    for (const id of ["a", "b"] as const)
      pool.followEvents(id, {
        events: (events, cursor, { snapshot }) => {
          if (snapshot) evs[id]!.snapshots++;
          evs[id]!.subjects.push(...events.map((e) => e.subject));
          evs[id]!.recipients.push(...events.map((e) => e.data.recipient));
          evs[id]!.cursor = cursor;
        },
      }, { waitS: 2 });
    await until(() => evs.a!.snapshots === 1 && evs.b!.snapshots === 1, "两边各取一次快照");
    assert.deepEqual(evs.a!.subjects, ["call:a-open"], "the open card, from A's snapshot");
    assert.deepEqual(evs.b!.subjects, []);
    card(t.B, "b1");
    card(t.A, "a1");
    card(t.B, "b2");
    await until(() => evs.a!.subjects.length === 2 && evs.b!.subjects.length === 2, "两边的事件各自读到");
    assert.deepEqual(evs.a!.subjects, ["call:a-open", "call:a1"]);
    assert.deepEqual(evs.b!.subjects, ["call:b1", "call:b2"]);
    // 给谁: with an external issuer, the owner's subject there.
    assert.ok([...evs.a!.recipients, ...evs.b!.recipients].every((r) => r === OWNER_SUB));
    // Each cursor is its own Daisy's sequence.
    assert.equal(evs.a!.cursor, t.A.ctx.events.lastSeq());
    assert.equal(evs.b!.cursor, t.B.ctx.events.lastSeq());

    // No credential was refused, none renewed.
    assert.ok(asked.every((r) => !r.refresh));
    assert.equal(asked.filter((r) => r.id === "a").length, 1);
    assert.equal(asked.filter((r) => r.id === "b").length, 1);
  } finally {
    pool.close();
    await t.close();
  }
});

test("P2-04: an expired token is renewed through credentials() — an HTTP 401, and the live socket closed at expiry", async () => {
  const t = await twoDaisys();
  const pool = new DaisyConnections();
  try {
    const fresh = await t.ownerToken();
    // Expired five minutes ago (past the 60 s clock skew).
    const expired = await t.ownerToken({ iat: now() - 900, ttlS: 600 });
    const asked: CredentialRequest[] = [];
    let firstA = true;
    const credentials = ({ refresh, id, baseUrl }: CredentialRequest) => {
      asked.push({ refresh, id, baseUrl });
      if (id === "a" && firstA) {
        firstA = false;
        return expired;
      }
      return fresh;
    };
    const a = pool.add({ id: "a", baseUrl: t.urlA, credentials });
    const b = pool.add({ id: "b", baseUrl: t.urlB, credentials });
    // A change: refused (401) before any handler ran, sent again once.
    const sa = await newSession(a);
    const sb = await newSession(b);
    assert.deepEqual(
      asked.map((r) => [r.id, r.refresh]),
      [
        ["a", false],
        ["a", true],
        ["b", false],
      ],
    );
    // Exactly one session was made on A (the refused attempt made none).
    const listed = await a.sessions();
    assert.equal(listed.filter((s: any) => s.id === sa).length, 1);
    assert.equal(listed.length, 1);

    // The live socket: a token good for 3 more seconds. The Daisy closes
    // the socket when it expires (1008); the client asks for a new one
    // and subscribes again.
    const short = await t.ownerToken({ ttlS: 3 });
    let shortGiven = false;
    const socketAsked: boolean[] = [];
    const c = pool.add({
      id: "a-live",
      baseUrl: t.urlA,
      credentials: ({ refresh }) => {
        socketAsked.push(refresh);
        if (!shortGiven) {
          shortGiven = true;
          return short;
        }
        return fresh;
      },
    });
    const states: string[] = [];
    const w = c.watchSession(sa, { data: () => {}, connection: (s) => void states.push(s) }, { pollMs: 60000, livePollMs: 60000 });
    try {
      await until(() => states.at(-1) === "live", "实时通道连上");
      const liveAt = states.length;
      await until(() => states.slice(liveAt).includes("reconnecting"), "令牌到期时 Daisy 关掉实时通道", 8000);
      await until(() => states.at(-1) === "live", "换了新令牌后重新连上", 8000);
      assert.deepEqual(socketAsked, [false, true]);
    } finally {
      w.close();
    }
    void b;
    void sb;
  } finally {
    pool.close();
    await t.close();
  }
});

test("P2-04: one Daisy stopping does not hold up the other", async () => {
  const t = await twoDaisys();
  const pool = new DaisyConnections({ credentials: async () => t.ownerToken() });
  try {
    const a = pool.add({ id: "a", baseUrl: t.urlA });
    const b = pool.add({ id: "b", baseUrl: t.urlB });
    const sa = await newSession(a);
    const sb = await newSession(b);
    const texts: Record<string, string[]> = { a: [], b: [] };
    const states: Record<string, string[]> = { a: [], b: [] };
    for (const [id, sid] of [
      ["a", sa],
      ["b", sb],
    ] as const)
      pool.watchSession(id, sid, {
        data: (s) => void (texts[id] = s.items.map((x: any) => x.text ?? "")),
        connection: (st) => void states[id]!.push(st),
      }, { pollMs: 200, livePollMs: 60000 });
    await until(() => states.a!.at(-1) === "live" && states.b!.at(-1) === "live", "两边都连上");

    // B stops (its outside face and everything).
    await t.B.ctx.app.close();
    await until(() => states.b!.at(-1) !== "live", "B 的实时通道断开");

    const r = await pool.each((c) => c.sessions());
    assert.equal(r[0]!.ok, true);
    assert.equal(r[1]!.ok, false);
    assert.equal(pool.state("a").reachable, true);
    assert.equal(pool.state("b").reachable, false);
    assert.ok(pool.state("b").lastError);

    // A carries on: a message, and its socket brings it.
    await a.send(sa, "B 停了，A 照常");
    await until(() => texts.a!.some((x) => x.includes("B 停了，A 照常")), "A 照常收到");
    assert.equal(states.a!.at(-1), "live");
  } finally {
    pool.close();
    await t.close().catch(() => {});
  }
});

test("P2-03 × P2-04: the event outlets of two Daisys — B stopping does not hold up A's; B restarted, its follower reads on from the kept cursor", async () => {
  const t = await twoDaisys();
  const pool = new DaisyConnections({ credentials: async () => t.ownerToken() });
  let B2: Daisy | undefined;
  try {
    pool.add({ id: "a", baseUrl: t.urlA });
    pool.add({ id: "b", baseUrl: t.urlB });
    const got: Record<string, string[]> = { a: [], b: [] };
    const errors: Record<string, number> = { a: 0, b: 0 };
    const follow = (id: string, after?: number) =>
      pool.followEvents(id, {
        events: (events) => void got[id]!.push(...events.map((e) => e.subject)),
        error: () => void errors[id]!++,
      }, { waitS: 1, pollMs: 50, maxMs: 200, ...(after !== undefined ? { after } : {}) });
    const fa = follow("a");
    const fb = follow("b");
    card(t.A, "a1");
    card(t.B, "b1");
    await until(() => got.a!.length === 1 && got.b!.length === 1, "两边各读到一条");

    // B stops: its follower fails and backs off, keeping its cursor; A's goes on.
    const kept = fb.cursor();
    assert.equal(kept, t.B.ctx.events.lastSeq());
    await t.B.ctx.app.close();
    await until(() => errors.b! >= 2, "B 的跟随器报错并退避");
    card(t.A, "a2");
    await until(() => got.a!.length === 2, "A 照常读到");
    assert.deepEqual(got.a, ["call:a1", "call:a2"]);
    assert.equal(errors.a, 0);
    assert.equal(fb.cursor(), kept, "B 的游标停在读到的地方");
    fb.close();

    // B comes back on the same data (a new address); a follower from the
    // kept cursor gets what was written meanwhile and what comes next —
    // nothing it had already (b1), nothing twice.
    B2 = await daisy({ dir: t.B.dir, issuer: t.iss });
    await B2.ctx.app.listen({ host: "127.0.0.1", port: 0 });
    pool.add({ id: "b2", baseUrl: `http://127.0.0.1:${(B2.ctx.app.server.address() as any).port}` });
    // Written while nobody follows it: the follower must still get it.
    card(B2, "b2-while-away");
    got.b2 = [];
    errors.b2 = 0;
    const resumed = pool.followEvents("b2", {
      events: (events) => void got.b2!.push(...events.map((e) => e.subject)),
    }, { after: fb.cursor(), waitS: 1 });
    await until(() => got.b2!.length === 1, "重启后读到没人跟随时写下的那条");
    card(B2, "b3-after-restart");
    await until(() => got.b2!.length === 2, "接着读到新的");
    assert.deepEqual(got.b2, ["call:b2-while-away", "call:b3-after-restart"]);
    assert.ok(resumed.cursor() > kept);
    void fa;
  } finally {
    pool.close();
    await B2?.close().catch(() => {});
    await t.close().catch(() => {});
  }
});

test("P2-04: a visitor's token (someone else's, or an AI's held for the owner) is refused — HTTP and the live socket — and not renewed", async () => {
  const t = await twoDaisys();
  try {
    const owner = new DaisyClient(t.urlA, await t.ownerToken());
    const sa = await newSession(owner);
    for (const visitor of [
      await t.iss.sign({ sub: OTHER_SUB, aud: [t.A.urn, t.B.urn] }),
      await t.iss.sign({ sub: OWNER_SUB, aud: [t.A.urn, t.B.urn], act: { sub: "agent:x" } }),
    ]) {
      let asked = 0;
      const pool = new DaisyConnections({
        credentials: () => {
          asked++;
          return visitor;
        },
      });
      try {
        pool.add({ id: "a", baseUrl: t.urlA });
        pool.add({ id: "b", baseUrl: t.urlB });
        const r = await pool.each((c) => c.sessions());
        for (const x of r) {
          assert.equal(x.ok, false);
          const e = (x as any).error as DaisyError;
          assert.equal(e.status, 403);
          assert.equal(e.code, "a2a_only");
        }
        // 403 is not 401: the credential is what it is, nothing to renew.
        assert.equal(asked, 2);
      } finally {
        pool.close();
      }
      // The live socket's first frame: closed, never ready.
      const res = await new Promise<string>((ok) => {
        const w = new WebSocketNode(`${t.urlA.replace("http", "ws")}/api/live`);
        w.on("open", () => w.send(JSON.stringify({ type: "subscribe", sessionId: sa, token: visitor })));
        w.on("message", (m) => JSON.parse(String(m)).type === "ready" && ok("ready"));
        w.on("close", (code) => ok("close " + code));
      });
      assert.equal(res, "close 1008");
    }
  } finally {
    await t.close();
  }
});

test("P2-04: a server-side interface needs no Origin setting; a browser-side one only from an origin the owner allowed (PIN), only on the outside face, with CORS, and only with the issuer's owner token", async () => {
  const s = await daisy();
  try {
    assert.equal((await s.configure()).statusCode, 200);
    const owner = await s.tokenFor(OWNER_SUB);
    const UI = "https://ui.example";
    // The local face: in-process requests (and the app's own listener below).
    const local = (headers: Record<string, string>, url = "/api/me", method = "GET") =>
      s.ctx.app.inject({ method: method as any, url, headers });
    // The outside face (plain HTTP on loopback), over a real listener.
    const on = await s.ctx.app.inject({
      method: "PUT",
      url: "/api/access/external",
      headers: s.withPin(),
      payload: { host: "127.0.0.1", tls: false },
    });
    assert.equal(on.statusCode, 200, on.body);
    const extPort = on.json().external.port as number;
    const ext = (headers: Record<string, string>, url = "/api/me", method = "GET", payload?: unknown) =>
      new Promise<{ statusCode: number; headers: Record<string, any>; body: string; json: () => any }>((ok, fail) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: extPort,
            path: url,
            method,
            headers: { ...(payload ? { "content-type": "application/json" } : {}), ...headers },
          },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () =>
              ok({ statusCode: res.statusCode!, headers: res.headers, body, json: () => JSON.parse(body) }),
            );
          },
        );
        req.on("error", fail);
        if (payload) req.write(JSON.stringify(payload));
        req.end();
      });

    // A server process: no Origin, no Sec-Fetch-Site — the token decides, on both faces.
    assert.equal((await local({ authorization: `Bearer ${owner}` })).statusCode, 200);
    assert.equal((await ext({ authorization: `Bearer ${owner}` })).statusCode, 200);

    // A browser page of another origin: refused until the owner allows it.
    const before = await ext({ authorization: `Bearer ${owner}`, origin: UI, "sec-fetch-site": "cross-site" });
    assert.equal(before.statusCode, 403);
    assert.equal(before.json().code, "cross_site");
    assert.equal(before.headers["access-control-allow-origin"], undefined);
    const preflight = (via: typeof ext | typeof local, url = "/api/me", method = "GET", more: Record<string, string> = {}) =>
      via === ext
        ? ext({ origin: UI, "access-control-request-method": method, "access-control-request-headers": "authorization", ...more }, url, "OPTIONS")
        : s.ctx.app.inject({
            method: "OPTIONS",
            url,
            headers: { origin: UI, "access-control-request-method": method, "access-control-request-headers": "authorization", ...more },
          });
    assert.equal((await preflight(ext)).statusCode, 403);

    // Allowing it is 「放别人进来」: the PIN; bad origins are refused.
    const put = (origins: string[], headers: Record<string, string> = s.withPin()) =>
      s.ctx.app.inject({ method: "PUT", url: "/api/access/ui-origins", headers, payload: { origins } });
    assert.equal((await put([UI], s.asCli)).json().code, "pin_required");
    assert.equal((await put([UI], { authorization: `Bearer ${owner}` })).json().code, "pin_required");
    for (const bad of ["http://ui.example", "https://ui.example/app", "*", "null", "https://*.example", "https://u:p@ui.example", "ftp://ui.example", "https://ui.example?x=1"]) {
      const r = await put([bad]);
      assert.equal(r.statusCode, 400, bad);
      assert.equal(r.json().code, "ui_origin_invalid", bad);
    }
    const set = await put(["https://UI.example/", "http://localhost:5173", UI]);
    assert.equal(set.statusCode, 200, set.body);
    assert.deepEqual(set.json().origins, [UI, "http://localhost:5173"]);
    assert.deepEqual(readUiOrigins(s.dir), [UI, "http://localhost:5173"]);
    assert.deepEqual((await local({ authorization: `Bearer ${owner}` }, "/api/access/ui-origins")).json().origins, [UI, "http://localhost:5173"]);

    // D-38: the list is for the outside face only. On the local face an
    // allowed origin is still another site — the request, its preflight
    // (no Private Network Access answer), no CORS headers.
    const loc = await local({ authorization: `Bearer ${owner}`, origin: UI, "sec-fetch-site": "cross-site" });
    assert.equal(loc.statusCode, 403);
    assert.equal(loc.json().code, "cross_site");
    assert.equal(loc.headers["access-control-allow-origin"], undefined);
    const locPre = await preflight(local, "/api/sessions", "POST", { "access-control-request-private-network": "true" });
    assert.equal(locPre.statusCode, 403);
    assert.equal(locPre.headers["access-control-allow-origin"], undefined);
    assert.equal(locPre.headers["access-control-allow-private-network"], undefined);
    assert.equal((await local({ authorization: `Bearer ${owner}`, origin: "http://localhost:5173" })).json().code, "cross_site");

    // The outside face's preflight: what the page may send.
    const pre = await ext(
      {
        origin: UI,
        "access-control-request-method": "POST",
        "access-control-request-headers": `authorization, content-type, ${PIN_GRANT_HEADER}`,
        "access-control-request-private-network": "true",
      },
      "/api/sessions",
      "OPTIONS",
    );
    assert.equal(pre.statusCode, 204);
    assert.equal(pre.headers["access-control-allow-origin"], UI);
    assert.match(String(pre.headers["access-control-allow-methods"]), /POST/);
    assert.match(String(pre.headers["access-control-allow-headers"]), /authorization/);
    assert.match(String(pre.headers["access-control-allow-headers"]), new RegExp(PIN_GRANT_HEADER));
    assert.equal(pre.headers["access-control-allow-private-network"], "true");
    assert.equal(pre.headers["access-control-allow-credentials"], undefined);

    // The request: the owner's issuer token passes, with CORS on the answer.
    const ok = await ext({ authorization: `Bearer ${owner}`, origin: UI, "sec-fetch-site": "cross-site" });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual([ok.json().channel, ok.json().face], ["issuer", "external"]);
    assert.equal(ok.headers["access-control-allow-origin"], UI);
    assert.match(String(ok.headers.vary), /Origin/i);
    // A refusal is readable by the page too (it must see the 401 to renew).
    const bad = await ext({ authorization: "Bearer nope", origin: UI });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.headers["access-control-allow-origin"], UI);
    assert.match(String(bad.headers["access-control-expose-headers"]), /www-authenticate/);
    // From that origin, our own credentials are not taken: an outside web
    // session (one-time code, PIN) works there without an Origin, and is
    // refused from the interface's origin.
    const code = (
      await s.ctx.app.inject({ method: "POST", url: "/api/web/open-code/external", headers: s.withPin() })
    ).json().code;
    const ws = (await ext({}, "/api/web/session", "POST", { code })).json();
    assert.equal(ws.face, "external");
    assert.equal((await ext({ authorization: `Bearer ${ws.token}` })).statusCode, 200);
    const wsFromUi = await ext({ authorization: `Bearer ${ws.token}`, origin: UI });
    assert.equal(wsFromUi.statusCode, 403);
    assert.equal(wsFromUi.json().code, "cross_site");
    // The command line's credential is nothing on the outside face at all.
    assert.equal((await ext({ authorization: `Bearer ${s.cli}`, origin: UI })).statusCode, 401);
    // A visitor stays A2A only.
    assert.equal((await ext({ authorization: `Bearer ${await s.tokenFor(OTHER_SUB)}`, origin: UI })).json().code, "a2a_only");
    // Another origin is still another site.
    assert.equal((await ext({ authorization: `Bearer ${owner}`, origin: "https://evil.example" })).json().code, "cross_site");

    // The live socket from that origin: the outside face, the issuer's owner token only.
    await s.ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const localPort = (s.ctx.app.server.address() as any).port;
    const cat = (await s.ctx.app.inject({ url: "/api/catalog", headers: s.asCli })).json();
    const sid = (
      await s.ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: s.asCli,
        payload: { agent: "claude", workspaceId: cat.workspaces[0].id, profileId: cat.profiles[0].id },
      })
    ).json().id;
    const open = (origin: string, token: string, onReady?: (w: WebSocketNode) => void, port = extPort) =>
      new Promise<string>((ok) => {
        const w = new WebSocketNode(`ws://127.0.0.1:${port}/api/live`, { headers: { origin } });
        w.on("unexpected-response", (q, r) => {
          q.destroy();
          ok("http " + r.statusCode);
        });
        w.on("open", () => w.send(JSON.stringify({ type: "subscribe", sessionId: sid, token })));
        w.on("message", (m) => {
          if (JSON.parse(String(m)).type !== "ready") return;
          if (onReady) onReady(w);
          else {
            w.close();
            ok("ready");
          }
        });
        w.on("close", (code) => ok("close " + code));
        w.on("error", () => ok("error"));
      });
    assert.equal(await open("https://evil.example", owner), "http 403");
    assert.equal(await open(UI, ws.token), "close 1008");
    assert.equal(await open(UI, owner), "ready");
    // D-38: not on the local face.
    assert.equal(await open(UI, owner, undefined, localPort), "http 403");

    // Clearing the list narrows (no PIN): the open socket ends at the next
    // change, new requests from that origin are refused again.
    const closed = open(UI, owner, () => {
      void (async () => {
        const off = await s.ctx.app.inject({ method: "DELETE", url: "/api/access/ui-origins", headers: s.asCli });
        assert.deepEqual(off.json().origins, []);
        await s.ctx.app.inject({
          method: "POST",
          url: `/api/sessions/${sid}/messages`,
          headers: s.asCli,
          payload: { text: "变化", requestId: "req-ui-origin-0001" },
        });
      })();
    });
    assert.equal(await closed, "close 1008");
    assert.equal((await ext({ authorization: `Bearer ${owner}`, origin: UI })).json().code, "cross_site");
    assert.deepEqual(readUiOrigins(s.dir), []);

    // Resetting the PIN takes back every trust that lets others in: the list too.
    assert.equal((await put([UI])).statusCode, 200);
    s.pin.resetLocal();
    assert.deepEqual(readUiOrigins(s.dir), []);
    assert.equal((await local({ authorization: `Bearer ${s.cli}` }, "/api/access/ui-origins")).json().origins.length, 0);
  } finally {
    await s.close();
  }
});

test("P2-04: the issuer's owner socket ends when the owner removes the issuer", async () => {
  const s = await daisy();
  try {
    assert.equal((await s.configure()).statusCode, 200);
    await s.ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${(s.ctx.app.server.address() as any).port}`;
    const c = new DaisyClient(url, await s.tokenFor(OWNER_SUB));
    const sid = await newSession(c);
    const res = await new Promise<string>((ok) => {
      const w = new WebSocketNode(`${url.replace("http", "ws")}/api/live`);
      w.on("open", () => w.send(JSON.stringify({ type: "subscribe", sessionId: sid, token: c.token })));
      w.on("message", (m) => {
        if (JSON.parse(String(m)).type !== "ready") return;
        void (async () => {
          await s.ctx.app.inject({ method: "DELETE", url: "/api/access/issuer", headers: s.asCli });
          await s.ctx.app.inject({
            method: "POST",
            url: `/api/sessions/${sid}/messages`,
            headers: s.asCli,
            payload: { text: "变化", requestId: "req-issuer-gone-01" },
          });
        })();
      });
      w.on("close", (code) => ok("close " + code));
    });
    assert.equal(res, "close 1008");
  } finally {
    await s.close();
  }
});

test("P2-04: allowed-origin rules (unit) — what a browser sends, exactly; a hand-edited file never opens more", () => {
  const ok = (x: string) => {
    const r = normalizeUiOrigin(x);
    return "origin" in r ? r.origin : null;
  };
  assert.equal(ok("https://Host.Example"), "https://host.example");
  assert.equal(ok("https://host.example:443"), "https://host.example");
  assert.equal(ok("https://host.example:8443/"), "https://host.example:8443");
  assert.equal(ok("http://127.0.0.1:8081"), "http://127.0.0.1:8081");
  assert.equal(ok("http://[::1]:8081"), "http://[::1]:8081");
  for (const bad of ["", "null", "*", "http://192.168.1.2", "https://a.example/x", "https://a.example#x", "javascript:alert(1)", "https://a b.example"])
    assert.equal(ok(bad), null, bad);
});

test("P2-04: config.json's uiOrigins — only entries a save would have written count", async () => {
  const s = await daisy();
  try {
    const file = join(s.dir, "config.json");
    let raw: any = {};
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* no config.json yet */
    }
    raw.uiOrigins = ["https://ok.example", "https://UPPER.example", "http://lan.example", "*", 7, "https://ok.example"];
    writeFileSync(file, JSON.stringify(raw));
    assert.deepEqual(readUiOrigins(s.dir), ["https://ok.example"]);
  } finally {
    await s.close();
  }
});

test("P2-04: the outside face over TLS (self-signed) — a backend pins the Daisy's certificate through the connection's fetch / WebSocket", async () => {
  const s = await daisy();
  try {
    assert.equal((await s.configure()).statusCode, 200);
    const on = await s.ctx.app.inject({
      method: "PUT",
      url: "/api/access/external",
      headers: s.withPin(),
      payload: { host: "127.0.0.1", tls: true },
    });
    assert.equal(on.statusCode, 200, on.body);
    const url = on.json().external.url as string;
    assert.match(url, /^https:\/\/127\.0\.0\.1:\d+$/);
    // What the owner hands the interface: the Daisy's certificate (P5's CA
    // certificates are later, ADR-100).
    const ca = readFileSync(join(s.dir, "keys", "tls-cert.pem"), "utf8");
    // A fetch that trusts exactly that certificate (node:https).
    const pinnedFetch = (u: string, init: RequestInit = {}) =>
      new Promise<Response>((ok, fail) => {
        const q = httpsRequest(
          u,
          { method: init.method ?? "GET", headers: init.headers as Record<string, string>, ca },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              ok(new Response(res.statusCode === 204 || res.statusCode === 304 ? null : Buffer.concat(chunks), {
                status: res.statusCode!,
                headers: Object.entries(res.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)] as [string, string]])),
              })),
            );
          },
        );
        q.on("error", fail);
        if (init.body) q.write(init.body as string);
        q.end();
      });
    class PinnedWS extends WebSocketNode {
      constructor(u: string) {
        super(u, { ca });
      }
    }
    const token = await s.tokenFor(OWNER_SUB);
    // Without the certificate: refused by TLS, not by Daisy.
    await assert.rejects(new DaisyClient(url, token).me());
    const c = new DaisyClient(url, "", {
      credentials: () => token,
      fetch: pinnedFetch,
      WebSocket: PinnedWS as unknown as typeof WebSocket,
    });
    const me = await c.me();
    assert.deepEqual([me.channel, me.face], ["issuer", "external"]);
    const sid = await newSession(c);
    const states: string[] = [];
    const w = c.watchSession(sid, { data: () => {}, connection: (st) => void states.push(st) }, { pollMs: 60000, livePollMs: 60000 });
    try {
      await until(() => states.at(-1) === "live", "TLS 上的实时通道连上");
    } finally {
      w.close();
    }
  } finally {
    await s.close();
  }
});

test("P2-04: only the guard's 401 (invalid_token) renews the credential — a handler's own 401 is not sent again", async () => {
  const s = await daisy();
  try {
    assert.equal((await s.configure()).statusCode, 200);
    await s.ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${(s.ctx.app.server.address() as any).port}`;
    const token = await s.tokenFor(OWNER_SUB);
    const asked: boolean[] = [];
    const c = new DaisyClient(url, "", { credentials: ({ refresh }) => (asked.push(refresh), token) });
    // The one-time code exchange answers 401 code_invalid from its handler.
    await assert.rejects(c.webSession("not-a-code-0000000000"), (e: DaisyError) => e.status === 401 && e.code === "code_invalid");
    assert.deepEqual(asked, [false]);
  } finally {
    await s.close();
  }
});
