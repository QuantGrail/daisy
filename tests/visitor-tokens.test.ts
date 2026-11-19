/**
 * P4-12 `daisy token` (总纲 5.6 「第三方 A2A 客户端」, 5.10, 5.11,
 * token.md §7, ADR-132): a token this Daisy signs for an A2A client we did
 * not write — standard Bearer, the A2A entry only, still through the call
 * authorization; issuing and revoking need the PIN; a removed contact, a
 * revocation and a PIN reset each end it.
 *
 * Refusals first: the routes without the PIN / for the AI / for a visitor;
 * the token at the local API; a forged or altered token; then what it can
 * do (over real A2A HTTP with the fake CLIs: a public agent answers it),
 * and the ways it ends. Last, `daisy token` itself against a listening
 * Daisy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, decodeJwt, decodeProtectedHeader, importJWK } from "jose";
import { setup as runnerSetup, until } from "./fixtures/scheduler-harness.ts";
import { pinDouble } from "./fixtures/pin-double.ts";
import { peerDaisy } from "./fixtures/peer-daisy.ts";
import { runningTurn, daisy as issuerDaisy } from "./fixtures/daisy-with-issuer.ts";
import { daisy as cliRun, testIo } from "./cli-fixture.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { api } from "../packages/contracts/src/api/index.ts";
import { fillPath, type AnyRoute } from "../packages/contracts/src/index.ts";
import { TOKEN_LIMITS } from "../packages/contracts/src/limits.ts";
import { createApp } from "../packages/daisy/src/app.ts";
import { runtimeFile } from "../packages/daisy/src/platform/paths.ts";

process.env.DAISY_SIDECAR_BWRAP = "0";
const T = api.tokens;
const V = { "a2a-version": "1.0" };

/** A Daisy with its Runner on the fake CLIs, contact B (whitelisted), a public agent. */
async function world() {
  const pin = pinDouble();
  const h: any = await runnerSetup({}, { pin, sharedHost: () => false, peerIsOwner: () => true });
  const cli = readFileSync(join(h.dir, "keys", "cli-credential"), "utf8").trim();
  const asCli = { authorization: `Bearer ${cli}` };
  const withPin = () => ({ ...asCli, [PIN_GRANT_HEADER]: pin.grant("246810", "cli").grant });
  const b = await peerDaisy("B");
  const imp = await h.ctx.app.inject({ method: "POST", url: api.contacts.contactImport.path, headers: withPin(), payload: { card: b.text, whitelist: true } });
  assert.equal(imp.statusCode, 200, imp.body);
  await until(
    () => h.ctx.store.one("SELECT capabilities FROM nodes WHERE id=?", h.config.nodeId)?.capabilities || "{}",
    (c: string) => JSON.parse(c)?.askSidecar?.version >= 1,
    300,
  );
  const ws = join(realpathSync(h.dir), "ws-研究");
  mkdirSync(ws, { recursive: true });
  const w = await h.c.request("/workspaces", "POST", { nodeId: h.config.nodeId, label: "研究", path: ws });
  const cat = await h.c.catalog();
  const profile = cat.profiles.find((p: any) => p.agent === "claude");
  const s = await h.c.create({ agent: "claude", title: "研究助手", profileId: profile.id, workspaceId: w.id });
  const pub = await h.ctx.app.inject({ method: "PUT", url: fillPath(api.invoke.publicSet.path, { id: s.id }), headers: withPin(), payload: { public: true } });
  assert.equal(pub.statusCode, 200, pub.body);
  const call = (def: AnyRoute, o: { params?: Record<string, string>; body?: unknown; query?: string; headers?: Record<string, string> } = {}) =>
    h.ctx.app.inject({
      method: def.method,
      url: fillPath(def.path, o.params ?? {}) + (o.query ? `?${o.query}` : ""),
      headers: o.headers ?? withPin(),
      ...(def.method === "GET" || def.method === "DELETE" ? {} : { payload: (o.body ?? {}) as any }),
    });
  const issue = async (body: Record<string, unknown>) => {
    const r = await call(T.tokenIssue, { body });
    assert.equal(r.statusCode, 200, r.body);
    return r.json() as { token: string; record: any; warning: string };
  };
  /** What a third-party client does: plain fetch, a Bearer token, no extension. */
  const a2a = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(h.url + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...V, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text, auth: r.headers.get("www-authenticate") };
  };
  let seq = 0;
  const send = (token: string, text: string, immediate = false) =>
    a2a(token, "POST", `/a2a/${s.id}/message:send`, {
      message: { messageId: `tp-${Date.now()}-${++seq}`, role: "ROLE_USER", parts: [{ text }] },
      configuration: immediate ? { returnImmediately: true } : {},
    }).then((r) => ({ ...r, json: r.json?.task ?? r.json }));
  const close = async () => {
    await h.close();
    b.close();
  };
  return { h, b, pin, asCli, withPin, agent: s.id as string, call, issue, a2a, send, close };
}

// ── refusals first ────────────────────────────────────────────────────────

test("daisy token routes: daisy:grant on the owner's channels; issuing and revoking let someone in (PIN), listing takes the PIN on the command line only; never the AI, never a visitor", async () => {
  const s = await issuerDaisy();
  try {
    const t = await runningTurn(s);
    const b = await peerDaisy("B");
    try {
      const routes = Object.values(T) as AnyRoute[];
      assert.deepEqual(
        Object.fromEntries(routes.map((r) => [r.id, r.letsIn])),
        { "grant.tokenIssue": "visitor-token", "grant.tokenList": undefined, "grant.tokenRevoke": "visitor-token" },
      );
      const web = s.ctx.issueToken();
      for (const r of routes) {
        assert.equal(r.scope, "daisy:grant", r.id);
        assert.equal(r.pin, true, r.id);
        assert.deepEqual(r.pinOn, r.method === "GET" ? ["cli"] : undefined, r.id);
        const send = (headers: Record<string, string>) =>
          s.ctx.app.inject({
            method: r.method,
            url: fillPath(r.path, { jti: "x" }),
            headers,
            ...(r.method === "POST" ? { payload: { for: "me" } } : {}),
          });
        assert.equal((await send({})).statusCode, 401, r.id);
        for (const h of [s.asCli, { authorization: `Bearer ${web}` }]) {
          const x = await send(h);
          if (r.method === "GET" && h !== s.asCli) {
            assert.equal(x.statusCode, 200, `${r.id}: ${x.body}`);
            continue;
          }
          assert.equal(x.statusCode, 403, r.id);
          assert.equal(x.json().code, "pin_required", r.id);
        }
        const ai = await send({ authorization: `Bearer ${t.ai}` });
        assert.equal(ai.statusCode, 403, r.id);
        assert.equal(ai.json().code, "channel_not_allowed", r.id);
        // A visitor (a contact's own token) — even if the contact is known.
        const v = await send({ authorization: `Bearer ${await b.token(s.urn)}` });
        assert.equal(v.statusCode, 401, `${r.id}: a stranger's token is nobody`);
      }
      assert.equal(s.ctx.store.one("SELECT COUNT(*) n FROM visitor_tokens").n, 0, "nothing issued");
    } finally {
      b.close();
    }
  } finally {
    await s.close();
  }
});

test("a daisy token is a visitor: refused at every local route (a2a_only) — `--for me` is never the owner", async () => {
  const w = await world();
  try {
    for (const who of [w.b.card.id, "me"]) {
      const { token } = await w.issue({ for: who });
      for (const [method, url] of [
        ["GET", "/api/me"],
        ["GET", "/api/sessions"],
        ["GET", "/api/tokens"],
        ["POST", "/api/tokens"],
        ["GET", "/api/contacts"],
        ["POST", "/api/pin/grant"],
      ] as const) {
        const r = await w.h.ctx.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(method === "POST" ? { payload: { for: "me", pin: "246810" } } : {}) });
        assert.equal(r.statusCode, 403, `${who} ${method} ${url}`);
        assert.equal(r.json().code, "a2a_only", `${who} ${method} ${url}`);
      }
    }
  } finally {
    await w.close();
  }
});

test("a forged, altered, unrecorded or overlong token is nobody (401, no reason given)", async () => {
  const w = await world();
  try {
    const self = w.h.ctx.access.ai.self;
    const urn = w.h.ctx.access.ai.urn;
    const { token, record } = await w.issue({ for: w.b.card.id });
    const sign = (o: Partial<Parameters<typeof self.sign>[0]>) =>
      self.sign({ sub: w.b.self.urn, aud: urn, clientId: `token:${record.jti}`, scope: "daisy:invoke", ttlS: 3600, jti: record.jti, ...o }).then((t: { token: string }) => t.token);
    const bad: [string, string][] = [
      // Signed by this Daisy, but never recorded (no `daisy token issue`).
      ["no record", await self.sign({ sub: w.b.self.urn, aud: urn, clientId: "token:made-up-0001", scope: "daisy:invoke", ttlS: 3600, jti: "made-up-0001" }).then((t: { token: string }) => t.token)],
      // The recorded jti, another person / another expiry / more scope / an actor.
      ["another person", await sign({ sub: urn })],
      ["another expiry", await sign({ ttlS: 7200 })],
      ["more scope", await sign({ scope: "daisy:invoke daisy:grant" })],
      ["an actor", await sign({ act: { sub: "agent:x" } })],
      ["client_id not its jti", await sign({ clientId: "token:someone-else" })],
      // Longer than 90 days.
      ["too long", await self.sign({ sub: w.b.self.urn, aud: urn, clientId: "token:long-0001", scope: "daisy:invoke", ttlS: TOKEN_LIMITS.visitorMaxS + 3600, jti: "long-0001" }).then((t: { token: string }) => t.token)],
      // Another Daisy's key claiming to be this one.
      ["another key", await w.b.self.sign({ sub: w.b.self.urn, aud: urn, clientId: `token:${record.jti}`, scope: "daisy:invoke", ttlS: 3600, jti: record.jti }).then((t: { token: string }) => t.token)],
      ["one byte changed", token.slice(0, -2) + (token.at(-2) === "A" ? "B" : "A") + token.at(-1)],
    ];
    const recorded = w.h.ctx.store.one("SELECT expires_at FROM visitor_tokens WHERE jti=?", record.jti).expires_at;
    for (const [what, t] of bad) {
      // Each bad claim alone: the record's expiry made to match the token's
      // (but for "another expiry"), so nothing else gives it away.
      if (what !== "another expiry")
        w.h.ctx.store.run("UPDATE visitor_tokens SET expires_at=? WHERE jti=?", (decodeJwt(t).exp ?? 0) * 1000, record.jti);
      const r = await w.a2a(t, "GET", "/a2a");
      assert.equal(r.status, 401, what);
      assert.match(String(r.auth), /invalid_token/, what);
      assert.doesNotMatch(r.text, /record|revoked|jti/i, `${what}: the caller is not told why`);
    }
    // The same claims as issued, the record's expiry matched: someone (the checks above are what refused).
    w.h.ctx.store.run("UPDATE visitor_tokens SET expires_at=? WHERE jti=?", (decodeJwt((bad[1] = ["", await sign({})])[1]).exp ?? 0) * 1000, record.jti);
    assert.equal((await w.a2a(bad[1][1], "GET", "/a2a")).status, 200, "a token signed like the issued one passes");
    w.h.ctx.store.run("UPDATE visitor_tokens SET expires_at=? WHERE jti=?", recorded, record.jti);
    // The good one still is someone.
    assert.equal((await w.a2a(token, "GET", "/a2a")).status, 200);
    // Issuing: a TTL past 90 days, an unknown or ambiguous contact.
    for (const [body, code] of [
      [{ for: "me", ttl: "91d" }, 400],
      [{ for: "me", ttl: "30s" }, 400],
      [{ for: "nobody-at-all-xyz" }, 404],
    ] as const) {
      const r = await w.call(T.tokenIssue, { body });
      assert.equal(r.statusCode, code, `${JSON.stringify(body)}: ${r.body}`);
    }
  } finally {
    await w.close();
  }
});

// ── what it does ──────────────────────────────────────────────────────────

test("token.md §7: the claims; shown once; only the record kept (no token in the database, the audit or the list)", async () => {
  const w = await world();
  try {
    const urn = w.h.ctx.access.ai.urn;
    const r = await w.issue({ for: w.b.card.id.slice(0, 12), ttl: "12h", note: "给 CI 用" });
    const h = decodeProtectedHeader(r.token);
    const c = decodeJwt(r.token) as any;
    assert.equal(h.typ, "at+jwt");
    assert.equal(h.alg, "EdDSA");
    assert.equal(c.iss, urn);
    assert.equal(c.aud, urn);
    assert.equal(c.sub, w.b.self.urn);
    assert.equal(c.scope, "daisy:invoke");
    assert.equal(c.client_id, `token:${c.jti}`);
    assert.equal(c.act, undefined);
    assert.equal(c.exp - c.iat, 12 * 3600);
    assert.equal(r.record.jti, c.jti);
    assert.deepEqual(r.record.for, { kind: "contact", contactId: w.b.card.id, name: "B" });
    assert.equal(r.record.note, "给 CI 用");
    assert.equal(r.record.state, "active");
    assert.match(r.warning, /只显示这一次/);
    // Default 7 days; `me`.
    const me = await w.issue({ for: "me" });
    const cm = decodeJwt(me.token) as any;
    assert.equal(cm.sub, urn);
    assert.equal(cm.exp - cm.iat, TOKEN_LIMITS.visitorDefaultS);
    assert.deepEqual(me.record.for, { kind: "me", contactId: null, name: "我自己" });
    // The list: records only.
    const list = await w.call(T.tokenList);
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().tokens.map((t: any) => t.jti).sort(), [c.jti, cm.jti].sort());
    for (const where of [list.body, JSON.stringify(w.h.ctx.store.all("SELECT * FROM visitor_tokens")), JSON.stringify(w.h.ctx.store.all("SELECT * FROM audit"))])
      for (const t of [r.token, me.token]) {
        assert.ok(!where.includes(t), "the token is not kept");
        assert.ok(!where.includes(t.split(".")[2]!), "nor its signature");
      }
    assert.equal(w.h.ctx.store.one("SELECT COUNT(*) n FROM audit WHERE action='visitor-token.issue'").n, 2);
  } finally {
    await w.close();
  }
});

test("A-1 path: a third-party client with a daisy token for contact B calls the public agent as B (whitelisted: straight through); `me` raises a card like anyone, decided 仅本次", async () => {
  const w = await world();
  try {
    const { token } = await w.issue({ for: w.b.card.id });
    const card = await w.a2a(token, "GET", `/a2a/${w.agent}/.well-known/agent-card.json`);
    assert.equal(card.status, 200, card.text);
    const done = await w.send(token, "FX_SAY 第三方客户端问好");
    assert.equal(done.json.status.state, "TASK_STATE_COMPLETED", done.text);
    // The guard's label names the token (jti), never the token.
    const who = w.h.ctx.store.all("SELECT user_id FROM audit WHERE action='a2a.task'").map((r: any) => r.user_id);
    assert.deepEqual(who, [`daisy-token/${(decodeJwt(token) as any).jti}`]);

    // `me`: the owner as a visitor — a card (5.6), on the owner's list like anyone's.
    const mine = await w.issue({ for: "me" });
    const waiting = await w.send(mine.token, "FX_SAY 自己经第三方客户端问", true);
    assert.ok(["TASK_STATE_AUTH_REQUIRED", "TASK_STATE_SUBMITTED"].includes(waiting.json.status.state), waiting.text);
    const reqs = await until(
      async () => (await w.call(api.invoke.requestList)).json().requests,
      (x: any[]) => x.length === 1,
      100,
    );
    assert.equal(reqs[0].caller.name, "我自己（daisy token）");
    assert.equal(reqs[0].caller.contactId, null);
    assert.equal(reqs[0].caller.issuer, null);
    const d = await w.call(api.invoke.requestDecide, { params: { rid: reqs[0].id }, body: { decision: "once" } });
    assert.equal(d.statusCode, 200, d.body);
    const end = await until(
      async () => (await w.a2a(mine.token, "GET", `/a2a/${w.agent}/tasks/${waiting.json.id}`)).json,
      (t: any) => t?.status?.state === "TASK_STATE_COMPLETED",
      300,
    );
    assert.equal(end.status.state, "TASK_STATE_COMPLETED");
    // 仅本次: no standing grant.
    assert.equal((await w.call(api.invoke.grantList)).json().grants.length, 0);
  } finally {
    await w.close();
  }
});

test("it ends: revoked (next request 401, the list says so); its contact removed (revoked with them); the cap on tokens in force", async () => {
  const w = await world();
  try {
    const one = await w.issue({ for: w.b.card.id });
    const two = await w.issue({ for: w.b.card.id });
    const mine = await w.issue({ for: "me" });
    for (const t of [one, two, mine]) assert.equal((await w.a2a(t.token, "GET", "/a2a")).status, 200);
    const rv = await w.call(T.tokenRevoke, { params: { jti: one.record.jti } });
    assert.equal(rv.statusCode, 200, rv.body);
    assert.equal(rv.json().revoked.state, "revoked");
    assert.equal(rv.json().revoked.revokedWhy, "owner");
    assert.equal((await w.a2a(one.token, "GET", "/a2a")).status, 401);
    // Again: the same record; an unknown one: 404.
    assert.equal((await w.call(T.tokenRevoke, { params: { jti: one.record.jti } })).json().revoked.revokedAt, rv.json().revoked.revokedAt);
    assert.equal((await w.call(T.tokenRevoke, { params: { jti: "nope" } })).statusCode, 404);
    // Removing B takes B's tokens (not the owner's own).
    const rm = await w.call(api.contacts.contactRemove, { params: { id: w.b.card.id } });
    assert.equal(rm.statusCode, 200, rm.body);
    assert.equal((await w.a2a(two.token, "GET", "/a2a")).status, 401);
    assert.equal((await w.a2a(mine.token, "GET", "/a2a")).status, 200);
    const all = (await w.call(T.tokenList, { query: "state=all" })).json().tokens;
    assert.deepEqual(
      Object.fromEntries(all.map((t: any) => [t.jti, t.revokedWhy])),
      { [one.record.jti]: "owner", [two.record.jti]: "contact_removed", [mine.record.jti]: null },
    );
    assert.deepEqual((await w.call(T.tokenList)).json().tokens.map((t: any) => t.jti), [mine.record.jti]);
    // The cap: tokens in force at once.
    w.h.ctx.store.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${TOKEN_LIMITS.visitorActiveMax - 1}) INSERT INTO visitor_tokens(jti,subject,name,created_at,expires_at,created_by) SELECT 'fill-'||i,'x','我自己',0,?,'test' FROM n`,
      Date.now() + 3600_000,
    );
    const over = await w.call(T.tokenIssue, { body: { for: "me" } });
    assert.equal(over.statusCode, 409);
    assert.equal(over.json().code, "too_many_tokens");
  } finally {
    await w.close();
  }
});

test("review M-1: each daisy token owns its own tasks — two tokens of one person, or a token and that person's own Daisy, cannot read, list or continue each other's; a revoked token's tasks stay closed to the others", async () => {
  const w = await world();
  try {
    const urn = w.h.ctx.access.ai.urn;
    const tasks = async (token: string) =>
      ((await w.a2a(token, "GET", `/a2a/${w.agent}/tasks`)).json?.tasks ?? []).map((t: any) => t.id).sort();
    const sees = async (token: string, tid: string) => (await w.a2a(token, "GET", `/a2a/${w.agent}/tasks/${tid}`)).status === 200;
    const continues = async (token: string, tid: string, ctx: string) =>
      (
        await w.a2a(token, "POST", `/a2a/${w.agent}/message:send`, {
          message: { messageId: `m1-${Date.now()}-${Math.random()}`, role: "ROLE_USER", parts: [{ text: "FX_SAY 接着说" }], taskId: tid, contextId: ctx },
          configuration: { returnImmediately: true },
        })
      ).text;
    // Two tokens for `me`: each its own caller (tasks wait on the owner's card).
    const a = await w.issue({ for: "me" });
    const b = await w.issue({ for: "me" });
    const ta = await w.send(a.token, "FX_SAY 甲的问题", true);
    const tb = await w.send(b.token, "FX_SAY 乙的问题", true);
    assert.ok(ta.json?.id && tb.json?.id, ta.text + tb.text);
    assert.deepEqual(await tasks(a.token), [ta.json.id]);
    assert.deepEqual(await tasks(b.token), [tb.json.id]);
    assert.equal(await sees(a.token, ta.json.id), true);
    assert.equal(await sees(b.token, ta.json.id), false, "B reads A's task");
    assert.doesNotMatch(await continues(b.token, ta.json.id, ta.json.contextId), /"TASK_STATE_/, "B continues A's task");
    // Still one person to the call authorization: one card for both.
    const reqs = (await w.call(api.invoke.requestList)).json().requests;
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].waiting, 2);
    // A revoked: A is nobody; B still cannot reach A's task.
    assert.equal((await w.call(T.tokenRevoke, { params: { jti: a.record.jti } })).statusCode, 200);
    assert.equal((await w.a2a(a.token, "GET", `/a2a/${w.agent}/tasks`)).status, 401);
    assert.equal(await sees(b.token, ta.json.id), false, "B reads revoked A's task");
    assert.deepEqual(await tasks(b.token), [tb.json.id]);

    // A token for contact B and B's own Daisy (its own signed tokens): apart.
    const forB = await w.issue({ for: w.b.card.id });
    const viaToken = await w.send(forB.token, "FX_SAY 第三方客户端问", true);
    const viaDaisy = await w.a2a(await w.b.token(urn), "POST", `/a2a/${w.agent}/message:send`, {
      message: { messageId: `m1-own-${Date.now()}`, role: "ROLE_USER", parts: [{ text: "FX_SAY B 自己的 Daisy 问" }] },
      configuration: { returnImmediately: true },
    });
    const own = viaDaisy.json?.task ?? viaDaisy.json;
    assert.ok(viaToken.json?.id && own?.id, viaToken.text + viaDaisy.text);
    assert.equal(await sees(forB.token, own.id), false, "a token for B reads B's own Daisy's task");
    assert.deepEqual(await tasks(forB.token), [viaToken.json.id]);
    const bOwn = await w.a2a(await w.b.token(urn), "GET", `/a2a/${w.agent}/tasks/${viaToken.json.id}`);
    assert.equal(bOwn.status === 200, false, "B's own Daisy reads the token's task");
    const bList = await w.a2a(await w.b.token(urn), "GET", `/a2a/${w.agent}/tasks`);
    assert.deepEqual((bList.json?.tasks ?? []).map((t: any) => t.id), [own.id]);
  } finally {
    await w.close();
  }
});

test("review L-1: a token just past its end is refused at once (no clock skew on the record), and a PIN reset revokes it too", async () => {
  const w = await world();
  try {
    const { record } = await w.issue({ for: "me" });
    // A token of this Daisy's that ended 10 seconds ago — inside the 60 s the
    // signature check allows — and its record saying the same.
    const self = w.h.ctx.access.ai.self;
    const jwk = JSON.parse(readFileSync(join(w.h.dir, "keys", "identity-key.json"), "utf8"));
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ client_id: `token:${record.jti}`, scope: "daisy:invoke" })
      .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: self.kid })
      .setIssuer(self.urn)
      .setSubject(self.urn)
      .setAudience(self.urn)
      .setIssuedAt(now - 120)
      .setExpirationTime(now - 10)
      .setJti(record.jti)
      .sign(await importJWK(jwk, "EdDSA"));
    w.h.ctx.store.run("UPDATE visitor_tokens SET expires_at=? WHERE jti=?", (now - 10) * 1000, record.jti);
    assert.equal(await self.verify(token, { audience: self.urn }).then((v: { ok: boolean }) => v.ok), true, "the signature alone still passes (skew)");
    const r = await w.a2a(token, "GET", "/a2a");
    assert.equal(r.status, 401);
    // The reset takes the just-ended one back as well.
    assert.equal(w.h.ctx.access.visitorTokens.revokeAll(), 1);
    assert.equal(w.h.ctx.store.one("SELECT revoked_why FROM visitor_tokens WHERE jti=?", record.jti).revoked_why, "pin_reset");
  } finally {
    await w.close();
  }
});

test("T-9: a PIN reset revokes every daisy token (the visitor-tokens hook; the record says pin_reset)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-vt-reset-"));
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, workspaceRoots: [dir], sharedHost: () => false, peerIsOwner: () => true });
  try {
    const cli = { authorization: `Bearer ${readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim()}` };
    const PIN = "246810";
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/pin", headers: cli, payload: { pin: PIN } })).statusCode, 200);
    const grant = () => ctx.app.inject({ method: "POST", url: "/api/pin/grant", headers: cli, payload: { pin: PIN } }).then((r) => r.json().grant as string);
    const issued = await ctx.app.inject({ method: "POST", url: "/api/tokens", headers: { ...cli, [PIN_GRANT_HEADER]: await grant() }, payload: { for: "me" } });
    assert.equal(issued.statusCode, 200, issued.body);
    const token = issued.json().token;
    const dir_ = () => ctx.app.inject({ url: "/a2a", headers: { authorization: `Bearer ${token}`, ...V } });
    assert.equal((await dir_()).statusCode, 200);
    const reset = await ctx.app.inject({ method: "POST", url: "/api/pin/reset", headers: cli, payload: { confirm: true } });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal((await dir_()).statusCode, 401);
    const row = ctx.store.one("SELECT revoked_why FROM visitor_tokens");
    assert.equal(row.revoked_why, "pin_reset");
    const summary = JSON.parse(ctx.store.one("SELECT target FROM audit WHERE action='pin.reset.revoke'").target);
    assert.equal(summary.revoked["visitor-tokens"], 1);
    assert.ok(!summary.pending.includes("visitor-tokens"));
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daisy token issue / list / revoke against a listening Daisy: the PIN asked for; the token alone on standard output, once; the warning on standard error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-token-cli-"));
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, workspaceRoots: [dir], sharedHost: () => false, peerIsOwner: () => true });
  try {
    ctx.pin.set("246810");
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (ctx.app.server.address() as any).port;
    ctx.access.faces.setLocal(port, "given");
    writeFileSync(
      runtimeFile(dir),
      JSON.stringify({ pid: process.pid, release: null, startedAt: Date.now(), dataDir: dir, local: { url: `http://127.0.0.1:${port}`, port }, external: null, cliCredential: join(dir, "keys", "cli-credential") }),
      { mode: 0o600 },
    );
    // No PIN on standard input: nothing is issued.
    let r = await cliRun(testIo(), dir, "token", "issue", "--for", "me");
    assert.notEqual(r.code, 0);
    assert.equal(ctx.store.one("SELECT COUNT(*) n FROM visitor_tokens").n, 0);
    r = await cliRun(testIo({ input: ["246810"] }), dir, "token", "issue", "--for", "me", "--ttl", "1d", "--note", "给 CI 用");
    assert.equal(r.code, 0, r.err);
    const token = r.out.trim();
    assert.match(token, /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/, "only the token on standard output");
    assert.match(r.err, /只显示这一次/);
    assert.match(r.err, /Authorization: Bearer/);
    assert.ok(!r.err.includes(token), "not repeated on standard error");
    const jti = (decodeJwt(token) as any).jti;
    r = await cliRun(testIo({ input: ["246810"] }), dir, "token", "list");
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).tokens[0].jti, jti);
    assert.ok(!r.out.includes(token));
    r = await cliRun(testIo({ input: ["246810"] }), dir, "token", "revoke", jti);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).revoked.state, "revoked");
    // --help names what it is.
    r = await cliRun(testIo(), dir, "token", "issue", "--help");
    assert.match(r.out, /--for/);
    assert.match(r.out, /--ttl/);
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
