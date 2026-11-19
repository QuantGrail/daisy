/**
 * P2-01 / P2-02 security review (one round, D-37): each finding with its
 * test — H-1 PIN reset, M-1 live socket, M-2 stale JWKS, M-3 loopback
 * http, M-4 the stored owner token, the approvals default, L-1, L-3, L-4,
 * L-5, the default client id.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createApp } from "../packages/daisy/src/app.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { TOKEN_LIMITS } from "../packages/contracts/src/limits.ts";
import { daisy, runningTurn, OWNER_SUB } from "./fixtures/daisy-with-issuer.ts";
import { fakeIssuer } from "./fixtures/fake-issuer.ts";

const audits = (ctx: any) =>
  ctx.store.all("SELECT user_id,action,target FROM audit ORDER BY created, rowid") as {
    user_id: string;
    action: string;
    target: string;
  }[];
const deniedWhy = (ctx: any) =>
  audits(ctx)
    .filter((r) => r.action === "access.denied")
    .map((r) => JSON.parse(r.target).why as string);

test("review H-1: resetting the PIN takes back the external issuer and the stored owner token (real PinService)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-h1-"));
  const iss = await fakeIssuer();
  const ctx = await createApp({
    pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    sharedHost: () => false,
    peerIsOwner: () => true,
  });
  try {
    const cli = { authorization: `Bearer ${readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim()}` };
    const web = { authorization: `Bearer ${ctx.issueToken()}` };
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/pin", headers: web, payload: { pin: "135791" } })).statusCode, 200);
    const grant = (await ctx.app.inject({ method: "POST", url: "/api/pin/grant", headers: web, payload: { pin: "135791" } })).json().grant;
    const urn = ctx.access.ai.urn;
    const ownerToken = await iss.sign({ sub: OWNER_SUB, aud: urn });
    const conf = await ctx.app.inject({
      method: "PUT",
      url: "/api/access/issuer",
      headers: { ...web, [PIN_GRANT_HEADER]: grant },
      payload: { issuer: iss.issuer, ownerSubject: OWNER_SUB, ownerToken },
    });
    assert.equal(conf.statusCode, 200, conf.body);
    const owner = await iss.sign({ sub: OWNER_SUB, aud: urn });
    assert.equal((await ctx.app.inject({ url: "/api/me", headers: { authorization: `Bearer ${owner}` } })).statusCode, 200);
    assert.ok(existsSync(join(dir, "issuer", "jwks.json")));
    assert.ok(existsSync(join(dir, "keys", "issuer-owner-token")));
    // The local reset (command line only).
    const reset = await ctx.app.inject({ method: "POST", url: "/api/pin/reset", headers: cli, payload: { confirm: true } });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal(ctx.access.issuer.get(), null);
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.equal("issuer" in cfg, false);
    assert.equal(existsSync(join(dir, "issuer")), false);
    assert.equal(existsSync(join(dir, "keys", "issuer-owner-token")), false);
    // The owner's issuer token is nobody's now — not even to set a new PIN.
    assert.equal((await ctx.app.inject({ url: "/api/me", headers: { authorization: `Bearer ${owner}` } })).statusCode, 401);
    const setPin = await ctx.app.inject({ method: "POST", url: "/api/pin", headers: { authorization: `Bearer ${owner}` }, payload: { pin: "246802" } });
    assert.equal(setPin.statusCode, 401);
    assert.equal((await ctx.app.inject({ url: "/api/access/issuer", headers: cli })).json().mode, "self");
    // A second reset is harmless (the hook can run again).
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/pin/reset", headers: cli, payload: { confirm: true } })).statusCode, 200);
  } finally {
    await ctx.app.close();
    await iss.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review H-1: the same through the PIN stand-in's reset (the hook is on whatever PinService the guard uses)", async () => {
  const s = await daisy();
  try {
    assert.equal((await s.configure({ ownerToken: await s.tokenFor(OWNER_SUB) })).statusCode, 200);
    s.pin.resetLocal();
    assert.equal(s.ctx.access.issuer.get(), null);
    assert.equal(existsSync(join(s.dir, "keys", "issuer-owner-token")), false);
    assert.equal((await s.get("/api/me", await s.tokenFor(OWNER_SUB))).statusCode, 401);
  } finally {
    await s.close();
  }
});

test("review M-1: a live socket opened with the issuer's owner token gets its changes, and closes once the issuer goes or the token runs out", async () => {
  const s = await daisy();
  try {
    assert.equal((await s.configure()).statusCode, 200);
    const url = await s.ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const cat = (await s.ctx.app.inject({ url: "/api/catalog", headers: s.asCli })).json();
    const sess = (
      await s.ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: s.asCli,
        payload: { agent: "claude", workspaceId: cat.workspaces[0].id, profileId: cat.profiles.find((p: any) => p.agent === "claude").id },
      })
    ).json();
    const rename = (title: string) =>
      s.ctx.app.inject({ method: "PATCH", url: `/api/sessions/${sess.id}`, headers: s.asCli, payload: { title } });
    const open = async (token: string) => {
      const ws = new WebSocket(url.replace(/^http/, "ws") + "/api/live");
      const frames: any[] = [];
      let closed: number | null = null;
      ws.on("message", (m) => frames.push(JSON.parse(String(m))));
      ws.on("close", (code) => (closed = code));
      await new Promise((ok, fail) => (ws.once("open", ok), ws.once("error", fail)));
      ws.send(JSON.stringify({ type: "subscribe", token, sessionId: sess.id }));
      const until = async (f: () => boolean) => {
        for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
        assert.ok(f());
      };
      await until(() => frames.some((f) => f.type === "ready"));
      return { ws, frames, closed: () => closed, until };
    };
    // 1. The issuer is removed: the next push closes the socket.
    const a = await open(await s.tokenFor(OWNER_SUB));
    await rename("one");
    await a.until(() => a.frames.some((f) => f.type === "changed"));
    assert.equal(a.closed(), null, "the issuer's owner stays connected");
    // 2. Its token runs out: likewise.
    const now = Math.floor(Date.now() / 1000);
    const b = await open(await s.tokenFor(OWNER_SUB, { exp: now + 2 }, { iat: now }));
    await rename("two");
    await b.until(() => b.frames.some((f) => f.type === "changed"));
    await new Promise((r) => setTimeout(r, 2200));
    await rename("three");
    await b.until(() => b.closed() === 1008);
    assert.equal(a.closed(), null);
    await s.ctx.app.inject({ method: "DELETE", url: "/api/access/issuer", headers: s.asCli });
    await rename("four");
    await a.until(() => a.closed() === 1008);
  } finally {
    await s.close();
  }
});

test("review M-2 / L-5: a cache that cannot be refetched is used for a day past its lifetime, then refused; stale and refreshing are shown", async () => {
  const s = await daisy();
  try {
    assert.equal((await s.configure()).statusCode, 200);
    const x = s.ctx.access.issuer.get()! as any;
    const owner = await s.tokenFor(OWNER_SUB);
    const show = async () => (await s.ctx.app.inject({ url: "/api/access/issuer", headers: s.asCli })).json().issuer;
    // L-5: past its lifetime, no refetch tried yet: stale already.
    x.cache.expiresAt = Date.now() - 1000;
    x.lastAttempt = Date.now();
    let st = await show();
    assert.deepEqual([st.stale, st.expired, st.refreshing, st.lastError], [true, false, false, null]);
    // Down, within the allowance: still valid.
    s.iss.state.down = true;
    assert.equal((await s.get("/api/sessions", owner)).statusCode, 200);
    // Down, past the allowance (the clock moved past it): every token refused.
    x.cache.expiresAt = Date.now() - TOKEN_LIMITS.jwksMaxStaleMs - 1000;
    x.lastAttempt = 0;
    const r = await s.get("/api/sessions", owner);
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "unauthenticated");
    assert.equal(deniedWhy(s.ctx).at(-1), "invalid_token/unknown_key");
    st = await show();
    assert.equal(st.expired, true);
    assert.ok(st.lastError);
    // The issuer answers again: fresh keys, accepted.
    s.iss.state.down = false;
    x.lastAttempt = 0;
    assert.equal((await s.get("/api/sessions", owner)).statusCode, 200);
    st = await show();
    assert.deepEqual([st.stale, st.expired], [false, false]);
  } finally {
    await s.close();
  }
});

test("review M-3: a loopback http issuer needs DAISY_ALLOW_HTTP_ISSUER=1 and a machine nobody else has an account on — when configuring and before every fetch", async () => {
  const iss = await fakeIssuer();
  const dir = mkdtempSync(join(tmpdir(), "daisy-m3-"));
  const shared = { v: true };
  const { pinDouble } = await import("./fixtures/pin-double.ts");
  const pin = pinDouble();
  const ctx = await createApp({
    pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    sharedHost: () => shared.v,
    peerIsOwner: () => true,
    pin,
  });
  const env = process.env.DAISY_ALLOW_HTTP_ISSUER;
  try {
    const cli = { authorization: `Bearer ${readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim()}` };
    const conf = (body: any = {}) =>
      ctx.app.inject({
        method: "PUT",
        url: "/api/access/issuer",
        headers: { ...cli, [PIN_GRANT_HEADER]: pin.grant("246810", "cli").grant },
        payload: { issuer: iss.issuer, ownerSubject: OWNER_SUB, ...body },
      });
    // A shared machine: refused even with the switch.
    let r = await conf();
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().code, "issuer_invalid");
    assert.match(r.json().error, /别人的账户/);
    // Not shared, switch off: refused.
    shared.v = false;
    delete process.env.DAISY_ALLOW_HTTP_ISSUER;
    r = await conf();
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /DAISY_ALLOW_HTTP_ISSUER/);
    // `localhost` is never allowed (a name, not the loopback address).
    process.env.DAISY_ALLOW_HTTP_ISSUER = "1";
    r = await conf({ issuer: iss.issuer.replace("127.0.0.1", "localhost") });
    assert.equal(r.statusCode, 400);
    assert.equal(iss.state.jwksFetches, 0);
    // Not shared, switch on: configured.
    assert.equal((await conf()).statusCode, 200);
    const urn = ctx.access.ai.urn;
    // Another account appears: no more fetches over http (refresh, new kid).
    shared.v = true;
    const before = iss.state.jwksFetches;
    const ref = await ctx.app.inject({ method: "POST", url: "/api/access/issuer/refresh", headers: cli });
    assert.equal(ref.statusCode, 400);
    assert.equal(ref.json().code, "issuer_invalid");
    await iss.rotate("ed-9");
    (ctx.access.issuer.get() as any).lastAttempt = 0;
    const t = await iss.sign({ sub: OWNER_SUB, aud: urn });
    assert.equal((await ctx.app.inject({ url: "/api/me", headers: { authorization: `Bearer ${t}` } })).statusCode, 401);
    assert.equal(iss.state.jwksFetches, before);
  } finally {
    process.env.DAISY_ALLOW_HTTP_ISSUER = env;
    await ctx.app.close();
    await iss.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review M-4: the owner token kept for token exchange is not a login; another token of the owner still is", async () => {
  const s = await daisy();
  try {
    const kept = await s.tokenFor(OWNER_SUB);
    assert.equal((await s.configure({ ownerToken: kept })).statusCode, 200);
    const r = await s.get("/api/me", kept);
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "unauthenticated");
    assert.equal(deniedWhy(s.ctx).at(-1), "owner_token_as_bearer");
    // After a restart too (the hash is read back from the file).
    s.ctx.access.issuer.set(null);
    const { ExternalIssuer } = await import("../packages/daisy/src/access/tokens/external-issuer.ts");
    s.ctx.access.issuer.set(ExternalIssuer.load(s.dir, s.ctx.access.httpIssuer));
    assert.equal((await s.get("/api/me", kept)).statusCode, 401);
    assert.equal((await s.get("/api/me", await s.tokenFor(OWNER_SUB))).statusCode, 200);
  } finally {
    await s.close();
  }
});

test("review (approvals): the issuer's token for the owner does not answer the AI's approvals or questions until the stage gate says so", async () => {
  const s = await daisy();
  try {
    assert.equal((await s.configure()).statusCode, 200);
    const t = await runningTurn(s);
    const owner = { authorization: `Bearer ${await s.tokenFor(OWNER_SUB)}` };
    for (const url of ["/api/approvals/a1/respond", `/api/sessions/${t.own}/approvals/a1`]) {
      const r = await s.ctx.app.inject({ method: "POST", url, headers: owner, payload: { decision: "allow" } });
      assert.equal(r.statusCode, 403, url);
      assert.equal(r.json().code, "channel_not_allowed");
    }
  } finally {
    await s.close();
  }
});

test("review L-1: the reason a token was refused is in the audit, never in the answer", async () => {
  const s = await daisy();
  try {
    assert.equal((await s.configure()).statusCode, 200);
    const now = Math.floor(Date.now() / 1000);
    const cases: [string, string][] = [
      [await s.tokenFor(OWNER_SUB, { exp: now - 300 }, { iat: now - 900 }), "invalid_token/expired"],
      [await s.iss.sign({ sub: OWNER_SUB, aud: "urn:another" }), "invalid_token/wrong_audience"],
      [await s.tokenFor(OWNER_SUB, {}, { kid: "nope" }), "invalid_token/unknown_key"],
    ];
    for (const [token, why] of cases) {
      const r = await s.get("/api/sessions", token);
      assert.equal(r.statusCode, 401);
      assert.deepEqual(r.json().code, "unauthenticated");
      assert.ok(!r.body.includes(why.split("/")[1]!), "the caller is not told which");
      assert.equal(deniedWhy(s.ctx).at(-1), why);
    }
  } finally {
    await s.close();
  }
});

test("review L-3: per session at most 10 new tokens a minute (429) and 16 kept", async () => {
  const s = await daisy();
  try {
    const t = await runningTurn(s);
    const ask = (audience: string) =>
      s.ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${t.own}/ai-token`,
        headers: { authorization: `Bearer ${t.ai}` },
        payload: { audience, scope: "daisy:session:read" },
      });
    for (let i = 0; i < 10; i++) assert.equal((await ask(`https://a${i}.example`)).statusCode, 200);
    // A kept one is not a new fetch.
    assert.equal((await ask("https://a0.example")).statusCode, 200);
    const over = await ask("https://a10.example");
    assert.equal(over.statusCode, 429);
    assert.equal(over.json().code, "ai_token_rate_limited");
    const d = s.ctx.access.delegated as any;
    for (let i = 10; i < 30; i++) {
      if ((i - 10) % 9 === 0) d.fetchedAt.clear();
      assert.equal((await ask(`https://a${i}.example`)).statusCode, 200, String(i));
    }
    assert.equal([...d.held.values()].filter((h: any) => h.sessionId === t.own).length, 16);
  } finally {
    await s.close();
  }
});

test("review L-4 and the default client id: a changed audience or client drops the old owner token; the client id is not the Daisy's own URN", async () => {
  const s = await daisy();
  try {
    const st = (await s.configure({ ownerToken: await s.tokenFor(OWNER_SUB) })).json();
    assert.equal(st.issuer.clientId, `${s.urn}#client`);
    assert.ok(existsSync(join(s.dir, "keys", "issuer-owner-token")));
    // Same issuer and owner, same audience and client: kept.
    assert.equal((await s.configure()).statusCode, 200);
    assert.ok(existsSync(join(s.dir, "keys", "issuer-owner-token")));
    // Another client id: dropped.
    assert.equal((await s.configure({ clientId: "daisy-other-client" })).statusCode, 200);
    assert.equal(existsSync(join(s.dir, "keys", "issuer-owner-token")), false);
    // Another audience: dropped as well.
    assert.equal((await s.configure({ ownerToken: await s.tokenFor(OWNER_SUB) })).statusCode, 200);
    assert.equal((await s.configure({ audience: "urn:daisy:other-name" })).statusCode, 200);
    assert.equal(existsSync(join(s.dir, "keys", "issuer-owner-token")), false);
  } finally {
    await s.close();
  }
});
