/**
 * P2-02 (token.md §6, 3.7, X-4, ADR-113): Daisy fetches a token for the AI
 * of a running turn — by RFC 8693 token exchange at a fake external issuer,
 * or signed by itself when none is configured. Refusals first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeJwt, decodeProtectedHeader, jwtVerify, createLocalJWKSet } from "jose";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { daisy, runningTurn, OWNER_SUB, type Daisy } from "./fixtures/daisy-with-issuer.ts";

const ask = (s: Daisy, session: string, token: string | null, body: unknown) =>
  s.ctx.app.inject({
    method: "POST",
    url: `/api/sessions/${session}/ai-token`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body as any,
  });
const audits = (s: Daisy) =>
  s.ctx.store.all("SELECT user_id,action,target FROM audit ORDER BY created, rowid") as {
    user_id: string;
    action: string;
    target: string;
  }[];
const TARGET = "https://api.other-system.example";

/** Configure the fake issuer with the owner's token, and register this Daisy's key there. */
async function external(s: Daisy, ownerScope = "daisy:session:read tasks:read tasks:write") {
  const ownerToken = await s.tokenFor(OWNER_SUB, { scope: ownerScope }, { ttlS: 3600 });
  const r = await s.configure({ ownerToken });
  assert.equal(r.statusCode, 200, r.body);
  const st = r.json();
  s.iss.state.clients.set(st.issuer.clientId, st.self.jwk);
  return ownerToken;
}

test("the AI's token: only the AI of a running turn of that session gets one — nobody else, and not after the turn", async () => {
  const s = await daisy();
  try {
    const t = await runningTurn(s);
    const body = { audience: TARGET, scope: "daisy:session:read" };
    // No credential; the owner's channels (「AI 自用的工具」 are the AI's).
    assert.equal((await ask(s, t.own, null, body)).statusCode, 401);
    for (const token of [s.cli, s.ctx.issueToken()]) {
      const r = await ask(s, t.own, token, body);
      assert.equal(r.statusCode, 403);
      assert.equal(r.json().code, "channel_not_allowed");
    }
    // The AI of this turn, for another session: refused.
    const other = await ask(s, t.other, t.ai, body);
    assert.equal(other.statusCode, 403);
    assert.equal(other.json().code, "not_own_session");
    // Not for this Daisy itself (its working credential is for that), never
    // daisy:grant, nothing beyond the owner's.
    const self = await ask(s, t.own, t.ai, { ...body, audience: s.urn });
    assert.equal(self.statusCode, 400);
    assert.equal(self.json().code, "ai_token_audience");
    const grant = await ask(s, t.own, t.ai, { ...body, scope: "daisy:session:read daisy:grant" });
    assert.equal(grant.statusCode, 403);
    assert.equal(grant.json().code, "ai_token_scope");
    for (const scope of ["daisy:tools", "daisy:invoke", "tasks:read"]) {
      const r = await ask(s, t.own, t.ai, { ...body, scope });
      assert.equal(r.statusCode, 403, scope);
      assert.equal(r.json().code, "ai_token_scope", scope);
    }
    assert.equal((await ask(s, t.own, t.ai, { audience: TARGET })).statusCode, 400);
    assert.equal((await ask(s, t.own, t.ai, { ...body, scope: 'a"b' })).statusCode, 400);
    // Refusals are audited as the AI's, without any token.
    const refused = audits(s).filter((r) => r.action === "ai.token.refused");
    assert.deepEqual(
      refused.map((r) => JSON.parse(r.target).why),
      ["self_audience", "grant_scope", "beyond_owner", "beyond_owner", "beyond_owner"],
    );
    assert.ok(refused.every((r) => r.user_id === `ai:${t.own}`));
    // In the turn: a token.
    const ok = await ask(s, t.own, t.ai, body);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.headers["cache-control"], "no-store");
    // The turn ends: the route is closed to it (README 待决 11 option A:
    // the token may live on, the way to get one does not).
    s.ctx.store.run("UPDATE jobs SET status='completed' WHERE id=?", t.job.id);
    const after = await ask(s, t.own, t.ai, body);
    assert.equal(after.statusCode, 401);
  } finally {
    await s.close();
  }
});

test("X-4 standalone: Daisy signs it — the owner and the acting AI written in, scope within the owner's, at most an hour, reused across calls", async () => {
  const s = await daisy();
  try {
    const t = await runningTurn(s);
    const r = await ask(s, t.own, t.ai, { audience: TARGET, scope: "daisy:session:read daisy:manage" });
    assert.equal(r.statusCode, 200, r.body);
    const got = r.json();
    assert.equal(got.mode, "self");
    assert.equal(got.tokenType, "Bearer");
    assert.equal(got.audience, TARGET);
    // It verifies with this Daisy's public key (what the other side would do).
    const st = (await s.ctx.app.inject({ url: "/api/access/issuer", headers: s.asCli })).json();
    assert.equal(st.mode, "self");
    const { payload, protectedHeader } = await jwtVerify(got.token, createLocalJWKSet({ keys: [{ ...st.self.jwk, kid: st.self.kid }] }), {
      issuer: s.urn,
      audience: TARGET,
      typ: "at+jwt",
      algorithms: ["EdDSA"],
    });
    assert.equal(protectedHeader.kid, st.self.kid);
    assert.equal(payload.sub, s.urn, "the owner: this Daisy's identity");
    assert.deepEqual(payload.act, { sub: `agent:${t.own}` }, "the AI actually acting");
    assert.equal(payload.client_id, `ai:${t.own}`);
    assert.equal(payload.scope, "daisy:manage daisy:session:read");
    assert.ok(payload.exp! - payload.iat! <= 3600);
    assert.equal(got.expiresAt, payload.exp);
    // Asked again (same audience and scope): the same token.
    assert.equal((await ask(s, t.own, t.ai, { audience: TARGET, scope: "daisy:manage daisy:session:read" })).json().token, got.token);
    // It is not a key to this Daisy: not its audience, not a working credential.
    assert.equal((await s.get(`/api/sessions/${t.own}`, got.token)).statusCode, 401);
    // Issued is audited by jti, never the token.
    const row = audits(s).find((x) => x.action === "ai.token.issue")!;
    assert.equal(row.user_id, `ai:${t.own}`);
    const d = JSON.parse(row.target);
    assert.equal(d.jti, payload.jti);
    assert.equal(d.mode, "self");
    for (const a of audits(s)) assert.ok(!a.target.includes(got.token) && !a.target.includes(got.token.split(".")[2]!));
  } finally {
    await s.close();
  }
});

test("X-4 external: RFC 8693 exchange at the issuer — sub the owner, act this AI, scope within the owner's, at most an hour; renewed before it runs out", async () => {
  const s = await daisy();
  try {
    const ownerToken = await external(s);
    const t = await runningTurn(s);
    const r = await ask(s, t.own, t.ai, { audience: TARGET, scope: "tasks:read" });
    assert.equal(r.statusCode, 200, r.body);
    const got = r.json();
    assert.equal(got.mode, "external");
    // What Daisy sent (RFC 8693 + RFC 7523).
    assert.equal(s.iss.state.exchanges.length, 1);
    const f = s.iss.state.exchanges[0]!.form;
    assert.equal(f.grant_type, "urn:ietf:params:oauth:grant-type:token-exchange");
    assert.equal(f.subject_token, ownerToken);
    assert.equal(f.subject_token_type, "urn:ietf:params:oauth:token-type:access_token");
    assert.equal(f.actor_token_type, "urn:ietf:params:oauth:token-type:jwt");
    assert.equal(decodeJwt(f.actor_token!).sub, `agent:${t.own}`);
    assert.equal(decodeProtectedHeader(f.actor_token!).typ, "JWT");
    assert.equal(f.client_assertion_type, "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    assert.equal(f.audience, TARGET);
    assert.equal(f.scope, "tasks:read");
    // The token: the issuer's, for the target; owner + AI; scope; ≤ 1 h.
    const { payload } = await jwtVerify(got.token, createLocalJWKSet({ keys: s.iss.keys.map((k) => k.jwk) }), {
      issuer: s.iss.issuer,
      audience: TARGET,
      typ: "at+jwt",
    });
    assert.equal(payload.sub, OWNER_SUB);
    assert.deepEqual(payload.act, { sub: `agent:${t.own}` });
    assert.equal(payload.scope, "tasks:read");
    assert.ok(payload.exp! - payload.iat! <= 3600);
    // Reused while more than 5 minutes are left (across calls, across turns).
    assert.equal((await ask(s, t.own, t.ai, { audience: TARGET, scope: "tasks:read" })).json().token, got.token);
    assert.equal(s.iss.state.exchanges.length, 1);
    // Less than that left: fetched again.
    s.iss.state.misbehave = { ttlS: 200 };
    const short = await ask(s, t.own, t.ai, { audience: TARGET, scope: "tasks:write" });
    assert.equal(short.statusCode, 200, short.body);
    assert.equal(s.iss.state.exchanges.length, 2);
    await ask(s, t.own, t.ai, { audience: TARGET, scope: "tasks:write" });
    assert.equal(s.iss.state.exchanges.length, 3, "a token with < 5 min left is renewed");
    s.iss.state.misbehave = null;
    // Beyond the owner's token's scope: refused before asking the issuer.
    const beyond = await ask(s, t.own, t.ai, { audience: TARGET, scope: "tasks:admin" });
    assert.equal(beyond.statusCode, 403);
    assert.equal(beyond.json().code, "ai_token_scope");
    assert.equal(s.iss.state.exchanges.length, 3);
    // The issuer changes (removed): the old tokens are another mode's.
    await s.ctx.app.inject({ method: "DELETE", url: "/api/access/issuer", headers: s.asCli });
    const self = await ask(s, t.own, t.ai, { audience: TARGET, scope: "daisy:session:read" });
    assert.equal(self.json().mode, "self");
  } finally {
    await s.close();
  }
});

test("X-4 external: a token that breaks a rule is never handed to the AI — wrong owner, no or another act, too long, more scope, another audience, a key not the issuer's", async () => {
  const s = await daisy();
  try {
    await external(s);
    const t = await runningTurn(s);
    const cases: [string, Record<string, unknown>, string][] = [
      ["another subject", { sub: "user:someone-else" }, "not_owner"],
      ["no act", { dropAct: true }, "wrong_actor"],
      ["another actor", { actSub: "agent:another-ai" }, "wrong_actor"],
      ["two hours", { ttlS: 7200 }, "invalid:too_long"],
      ["more scope than asked", { extraScope: "tasks:write" }, "scope_beyond_request"],
      ["another audience", { audience: "https://elsewhere.example" }, "invalid:wrong_audience"],
      ["signed by a key not in the JWKS", { foreignKey: true }, "invalid:bad_signature"],
      ["not a Bearer token", { tokenType: "N_A" }, "wrong_token_type"],
      ["not an access token", { issuedTokenType: "urn:ietf:params:oauth:token-type:jwt" }, "wrong_token_type"],
    ];
    let n = 0;
    for (const [what, misbehave, why] of cases) {
      s.iss.state.misbehave = misbehave as any;
      // A distinct scope set each time, so nothing comes from the cache.
      const scope = n++ % 2 ? "tasks:read" : "daisy:session:read";
      const r = await ask(s, t.own, t.ai, { audience: TARGET, scope: `${scope}` });
      assert.equal(r.statusCode, 502, what);
      assert.equal(r.json().code, "ai_token_unavailable", what);
      assert.ok(!/eyJ/.test(r.body), `${what}: no token in the answer`);
      const last = audits(s).filter((x) => x.action === "ai.token.refused").at(-1)!;
      assert.equal(JSON.parse(last.target).why, why, what);
    }
    s.iss.state.misbehave = null;
    // (Eleven fetches in a minute would pass the per-session bound, review L-3.)
    (s.ctx.access.delegated as any).fetchedAt.clear();
    // The issuer itself refusing, or down: nothing either.
    s.iss.state.clients.clear();
    const noClient = await ask(s, t.own, t.ai, { audience: TARGET, scope: "tasks:read" });
    assert.equal(noClient.statusCode, 502);
    assert.match(noClient.json().error, /401（invalid_client）/);
    s.iss.state.down = true;
    const down = await ask(s, t.own, t.ai, { audience: TARGET, scope: "tasks:read" });
    assert.equal(down.statusCode, 502);
    assert.match(down.json().error, /连不上/);
    s.iss.state.down = false;
    // No token anywhere in the audit.
    for (const a of audits(s)) assert.ok(!/eyJ[\w-]{6,}\.[\w-]{6,}\./.test(a.target), a.action);
  } finally {
    await s.close();
  }
});

test("X-4 external: without the owner's token, or with an expired one, the AI is told why and nothing is asked of the issuer", async () => {
  const s = await daisy();
  try {
    // Configured without an owner token.
    assert.equal((await s.configure()).statusCode, 200);
    const t = await runningTurn(s);
    const none = await ask(s, t.own, t.ai, { audience: TARGET, scope: "daisy:session:read" });
    assert.equal(none.statusCode, 502);
    assert.match(none.json().error, /ownerToken/);
    // An owner token that has run out.
    const now = Math.floor(Date.now() / 1000);
    const x = s.ctx.access.issuer.get()!;
    x.storeOwnerToken(await s.tokenFor(OWNER_SUB, { exp: now - 120 }, { iat: now - 700 }));
    const expired = await ask(s, t.own, t.ai, { audience: TARGET, scope: "daisy:session:read" });
    assert.equal(expired.statusCode, 502);
    assert.match(expired.json().error, /已过期/);
    assert.equal(s.iss.state.exchanges.length, 0);
    // The status says the owner token is not usable.
    const st = (await s.ctx.app.inject({ url: "/api/access/issuer", headers: s.asCli })).json();
    assert.deepEqual(st.issuer.ownerToken, { stored: true, expiresAt: null });
    // Re-configuring with a fresh owner token (PIN) fixes it.
    const fresh = await s.configure({ ownerToken: await s.tokenFor(OWNER_SUB, { scope: "daisy:session:read" }) });
    assert.equal(fresh.statusCode, 200);
    s.iss.state.clients.set(fresh.json().issuer.clientId, fresh.json().self.jwk);
    assert.equal((await ask(s, t.own, t.ai, { audience: TARGET, scope: "daisy:session:read" })).statusCode, 200);
    // Re-configuring needs the PIN, and the AI never can.
    const byAi = await s.configure({}, { authorization: `Bearer ${t.ai}`, [PIN_GRANT_HEADER]: s.pin.grant("246810", "ai").grant });
    assert.equal(byAi.statusCode, 403);
  } finally {
    await s.close();
  }
});
