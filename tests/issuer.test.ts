/**
 * P2-01 (token.md §4.2, ADR-113): trusting an external issuer —
 * X-1, X-2, X-3 with a fake issuer on loopback (no real platform). Refusals first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createHash, createHmac, createPublicKey } from "node:crypto";
import { API_ROUTES, fillPath } from "../packages/contracts/src/index.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { holderOf } from "../packages/daisy/src/access/guard.ts";
import {
  algFits,
  cacheLifetimeMs,
  checkIssuerUrl,
  httpIssuerPolicy,
  metadataCandidates,
  publicKeys,
} from "../packages/daisy/src/access/tokens/external-issuer.ts";
import { TOKEN_LIMITS } from "../packages/contracts/src/limits.ts";
import { daisy, runningTurn, OWNER_SUB, OTHER_SUB } from "./fixtures/daisy-with-issuer.ts";
import { fakeIssuer } from "./fixtures/fake-issuer.ts";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const audits = (s: { ctx: any }) =>
  s.ctx.store.all("SELECT user_id,action,target FROM audit ORDER BY created, rowid") as {
    user_id: string;
    action: string;
    target: string;
  }[];

test("configuring an external issuer lets others in: daisy:grant + PIN, the owner's channels only — never the AI", async () => {
  const s = await daisy();
  try {
    const t = await runningTurn(s);
    // Not yet configured: the issuer's tokens are nobody's.
    const owner = await s.tokenFor(OWNER_SUB);
    assert.equal((await s.get("/api/sessions", owner)).statusCode, 401);
    // No credential, no PIN, the AI (even holding a PIN grant): refused.
    const none = await s.configure({}, {});
    assert.equal(none.statusCode, 401);
    const noPin = await s.configure({}, s.asCli);
    assert.equal(noPin.statusCode, 403);
    assert.equal(noPin.json().code, "pin_required");
    const web = await s.configure({}, { authorization: `Bearer ${s.ctx.issueToken()}` });
    assert.equal(web.json().code, "pin_required");
    const ai = await s.configure({}, { authorization: `Bearer ${t.ai}`, [PIN_GRANT_HEADER]: s.pin.grant("246810", "ai").grant });
    assert.equal(ai.statusCode, 403);
    assert.equal(ai.json().code, "channel_not_allowed");
    // A grant someone else took (the web page's) is not the command line's.
    const webToken = s.ctx.issueToken();
    const webGrant = s.pin.grant("246810", `web:${createHash("sha256").update(webToken).digest("hex")}`).grant;
    const cross = await s.configure({}, { ...s.asCli, [PIN_GRANT_HEADER]: webGrant });
    assert.equal(cross.json().code, "pin_required");
    assert.equal(s.ctx.access.issuer.get(), null);
    // Addresses: https, or http on loopback only; no userinfo.
    const plain = await s.configure({ issuer: "http://10.0.0.1:8080" });
    assert.equal(plain.statusCode, 400);
    assert.equal(plain.json().code, "issuer_invalid");
    // An issuer that cannot be reached is not trusted (nothing saved).
    const dead = await s.configure({ issuer: "http://127.0.0.1:1" });
    assert.equal(dead.statusCode, 502);
    assert.equal(dead.json().code, "issuer_unreachable");
    // Metadata naming another issuer (RFC 8414 §3.3).
    const other = await fakeIssuer();
    try {
      const mismatch = await s.configure({ metadataUrl: `${other.issuer}/.well-known/oauth-authorization-server` });
      assert.equal(mismatch.statusCode, 400);
      assert.equal(mismatch.json().code, "issuer_invalid");
    } finally {
      await other.close();
    }
    // An owner token that is not the owner's.
    const notOwners = await s.configure({ ownerToken: await s.tokenFor(OTHER_SUB) });
    assert.equal(notOwners.statusCode, 400);
    assert.equal(notOwners.json().code, "owner_token_invalid");
    const aiOwners = await s.configure({ ownerToken: await s.tokenFor(OWNER_SUB, { act: { sub: "agent:x" } }) });
    assert.equal(aiOwners.json().code, "owner_token_invalid");
    assert.equal(s.ctx.access.issuer.get(), null);
    assert.equal(existsSync(join(s.dir, "issuer", "jwks.json")), false);
    // The owner, with the PIN: configured.
    const ok = await s.configure({ ownerToken: owner });
    assert.equal(ok.statusCode, 200, ok.body);
    const st = ok.json();
    assert.equal(st.mode, "external");
    assert.equal(st.issuer.issuer, s.iss.issuer);
    assert.equal(st.issuer.ownerSubject, OWNER_SUB);
    assert.equal(st.issuer.audience, s.urn);
    assert.deepEqual(st.issuer.keys.map((k: any) => k.kid).sort(), ["ed-1", "rs-1"]);
    assert.equal(st.issuer.ownerToken.stored, true);
    assert.ok(st.issuer.ownerToken.expiresAt > Date.now() / 1000);
    assert.equal(st.self.urn, s.urn);
    assert.equal(st.self.jwk.kty, "OKP");
    assert.equal(st.self.jwk.d, undefined);
    assert.ok(!ok.body.includes(owner), "the status never carries a token");
    // Audited: who, through which entry; never the token.
    const row = audits(s).find((r) => r.action === "access.issuer.set")!;
    assert.equal(row.user_id, "cli");
    assert.deepEqual(
      { ...JSON.parse(row.target), issuer: undefined },
      { face: "local", channel: "cli", issuer: undefined, ownerSubject: OWNER_SUB, audience: s.urn, ownerToken: true },
    );
    for (const r of audits(s)) assert.ok(!r.target.includes(owner) && !r.user_id.includes(owner));
    // The owner token file is the owner's only.
    if (process.platform !== "win32") assert.equal(statSync(join(s.dir, "keys", "issuer-owner-token")).mode & 0o777, 0o600);
    // Removing it narrows who gets in: no PIN; the AI still cannot.
    assert.equal(
      (await s.ctx.app.inject({ method: "DELETE", url: "/api/access/issuer", headers: { authorization: `Bearer ${t.ai}` } }))
        .statusCode,
      403,
    );
    const rm = await s.ctx.app.inject({ method: "DELETE", url: "/api/access/issuer", headers: s.asCli });
    assert.equal(rm.statusCode, 200);
    assert.equal(rm.json().mode, "self");
    assert.equal(existsSync(join(s.dir, "keys", "issuer-owner-token")), false);
    assert.equal(existsSync(join(s.dir, "issuer")), false);
    // …and the owner's issuer token is nobody's again.
    assert.equal((await s.get("/api/sessions", owner)).statusCode, 401);
  } finally {
    await s.close();
  }
});

test("X-3: a bad signature, an expired token, another audience or issuer, a forbidden algorithm — 401, and nothing said about why", async () => {
  const s = await daisy();
  try {
    assert.equal((await s.configure()).statusCode, 200);
    const good = await s.tokenFor(OWNER_SUB);
    assert.equal((await s.get("/api/sessions", good)).statusCode, 200);
    const [h, p, sig] = good.split(".");
    const now = Math.floor(Date.now() / 1000);
    const skew = TOKEN_LIMITS.clockSkewS;
    const rsa = s.iss.keys.find((k) => k.alg === "RS256")!.jwk;
    const rsaPem = createPublicKey({ key: rsa as any, format: "jwk" }).export({ type: "spki", format: "pem" });
    const hs = (secret: string | Buffer) => {
      const head = b64({ alg: "HS256", typ: "at+jwt", kid: "rs-1" });
      const body = b64({ ...JSON.parse(Buffer.from(p!, "base64url").toString()) });
      return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
    };
    const bad: [string, string][] = [
      ["flipped signature", `${h}.${p}.${sig!.slice(0, -3)}${sig!.endsWith("AAA") ? "BBB" : "AAA"}`],
      ["payload swapped", `${h}.${b64({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), sub: OWNER_SUB, scope: "daisy:grant" })}.${sig}`],
      ["expired", await s.tokenFor(OWNER_SUB, { exp: now - skew - 5 }, { iat: now - 700 })],
      ["issued in the future", await s.tokenFor(OWNER_SUB, {}, { iat: now + skew + 120 })],
      ["another audience", await s.iss.sign({ sub: OWNER_SUB, aud: "urn:another-daisy" })],
      ["no audience", await s.iss.sign({ sub: OWNER_SUB })],
      ["another issuer (same keys)", await s.iss.sign({ sub: OWNER_SUB, aud: s.urn, iss: "https://evil.example" })],
      ["alg none", `${b64({ alg: "none", typ: "at+jwt", kid: "ed-1" })}.${p}.`],
      ["HS256 keyed with the RSA public key (algorithm confusion)", hs(rsaPem as string)],
      ["HS256 keyed with the JWK's n", hs(Buffer.from(String(rsa.n), "base64url"))],
      ["typ JWT (not an access token)", await s.tokenFor(OWNER_SUB, {}, { typ: "JWT" })],
      ["unknown kid", await s.tokenFor(OWNER_SUB, {}, { kid: "nope" })],
      ["a key not in the JWKS under a known kid", await s.iss.signForeign({ sub: OWNER_SUB, aud: s.urn })],
      ["RS256 header on the Ed25519 key's kid", await s.tokenFor(OWNER_SUB, {}, { alg: "RS256", kid: "ed-1" })],
      ["no jti", await s.tokenFor(OWNER_SUB, { jti: undefined })],
      ["no client_id", await s.tokenFor(OWNER_SUB, { client_id: undefined })],
      ["no scope", await s.tokenFor(OWNER_SUB, { scope: undefined })],
      ["act that is not an object", await s.tokenFor(OWNER_SUB, { act: "agent:x" })],
      ["not a JWT", "abc.def"],
      ["garbage in three parts", "eyJhbGciOiJFZERTQSJ9.e30.AAAA"],
    ];
    const before = audits(s).length;
    for (const [what, token] of bad) {
      const r = await s.get("/api/sessions", token);
      assert.equal(r.statusCode, 401, what);
      assert.equal(r.headers["www-authenticate"], 'Bearer error="invalid_token"', what);
      assert.equal(r.json().code, "unauthenticated", what);
      assert.ok(!r.body.includes(token), what);
      // Same for the live socket's first frame.
      const live = API_ROUTES.find((x) => x.id === "system.live")!;
      assert.equal(await s.ctx.access.guard.socketPrincipal({ raw: { socket: {} }, url: live.path, method: "GET" }, live, token), null, what);
    }
    // Every refusal is audited; no token in the audit.
    const rows = audits(s).slice(before);
    assert.ok(rows.filter((r) => r.action === "access.denied").length >= bad.length);
    for (const r of rows) for (const [, token] of bad) if (token.length > 20) assert.ok(!r.target.includes(token));
    // The same good token is still fine: the refusals were about the tokens.
    assert.equal((await s.get("/api/sessions", good)).statusCode, 200);
    // Expired but within the clock skew: still fine.
    assert.equal((await s.get("/api/sessions", await s.tokenFor(OWNER_SUB, { exp: now - 5 }, { iat: now - 600 }))).statusCode, 200);
  } finally {
    await s.close();
  }
});

test("a token asserting the owner lives at most 24 h (exp - iat) — exactly 24 h passes, a second more and no iat are refused; visitors are not bound by it", async () => {
  const s = await daisy();
  try {
    assert.equal(TOKEN_LIMITS.externalOwnerMaxS, 24 * 3600);
    assert.equal((await s.configure()).statusCode, 200);
    const MAX = TOKEN_LIMITS.externalOwnerMaxS;
    const now = Math.floor(Date.now() / 1000);
    const iat = now - 30;
    const live = API_ROUTES.find((x) => x.id === "system.live")!;
    const first = (token: string) =>
      s.ctx.access.guard.socketPrincipal({ raw: { socket: {} }, url: live.path, method: "GET" }, live, token);
    const deniedWhy = () =>
      audits(s)
        .filter((r) => r.action === "access.denied")
        .map((r) => JSON.parse(r.target).why as string)
        .at(-1);

    // Exactly 24 h: the owner (both algorithms), on HTTP and the live socket.
    for (const alg of ["EdDSA", "RS256"] as const) {
      const day = await s.tokenFor(OWNER_SUB, { exp: iat + MAX }, { iat, alg });
      const me = await s.get("/api/me", day);
      assert.equal(me.statusCode, 200, alg);
      assert.equal(me.json().channel, "issuer");
      assert.equal((await first(day))?.kind, "external-owner", alg);
    }
    // 24 h and one second: refused (401, the reason for the audit only).
    const over = await s.tokenFor(OWNER_SUB, { exp: iat + MAX + 1 }, { iat });
    const r = await s.get("/api/me", over);
    assert.equal(r.statusCode, 401);
    assert.equal(r.headers["www-authenticate"], 'Bearer error="invalid_token"');
    assert.ok(!r.body.includes("too_long"));
    assert.equal(deniedWhy(), "invalid_token/too_long");
    assert.equal(await first(over), null);
    // Far longer (a 30-day token): refused all the same.
    assert.equal((await s.get("/api/me", await s.tokenFor(OWNER_SUB, {}, { ttlS: 30 * 24 * 3600 }))).statusCode, 401);
    // No iat (so its lifetime cannot be told): refused, even a short one.
    const noIat = await s.tokenFor(OWNER_SUB, { exp: now + 600 }, { iat: null });
    assert.equal(JSON.parse(Buffer.from(noIat.split(".")[1]!, "base64url").toString()).iat, undefined);
    assert.equal((await s.get("/api/me", noIat)).statusCode, 401);
    assert.equal(deniedWhy(), "invalid_token/bad_claims");
    assert.equal(await first(noIat), null);
    // The owner's subject with `act` (an AI acting for the owner) asserts
    // the owner too: past 24 h it is refused before it is even a visitor.
    const actLong = await s.tokenFor(OWNER_SUB, { act: { sub: "agent:x" }, exp: iat + MAX + 1 }, { iat });
    assert.equal((await s.get("/api/me", actLong)).statusCode, 401);
    // Someone else's token is not the owner's: the cap does not apply — it
    // stays a visitor (A2A only), however long it lives.
    const visitor = await s.tokenFor(OTHER_SUB, {}, { ttlS: 2 * MAX });
    const v = await s.get("/api/sessions", visitor);
    assert.equal(v.statusCode, 403);
    assert.equal(v.json().code, "a2a_only");

    // The owner token kept for token exchange (P2-02) is bound the same:
    // longer than 24 h → not saved; exactly 24 h → saved.
    const longOwner = await s.configure({ ownerToken: await s.tokenFor(OWNER_SUB, { exp: iat + MAX + 1 }, { iat }) });
    assert.equal(longOwner.statusCode, 400);
    assert.equal(longOwner.json().code, "owner_token_invalid");
    const noIatOwner = await s.configure({ ownerToken: noIat });
    assert.equal(noIatOwner.json().code, "owner_token_invalid");
    const dayOwner = await s.configure({ ownerToken: await s.tokenFor(OWNER_SUB, { exp: iat + MAX }, { iat }) });
    assert.equal(dayOwner.statusCode, 200, dayOwner.body);
    assert.equal(dayOwner.json().issuer.ownerToken.stored, true);
    assert.equal(dayOwner.json().issuer.ownerToken.expiresAt, iat + MAX);
  } finally {
    await s.close();
  }
});

test("X-1: the owner's token from the issuer is the owner — no pairing; Ed25519 and RS256; from another machine through the outside face", async () => {
  const s = await daisy();
  try {
    assert.equal((await s.configure()).statusCode, 200);
    for (const alg of ["EdDSA", "RS256"] as const) {
      const token = await s.tokenFor(OWNER_SUB, {}, { alg });
      const me = await s.get("/api/me", token);
      assert.equal(me.statusCode, 200, alg);
      assert.equal(me.json().channel, "issuer");
      assert.equal(me.json().id, "owner");
      assert.equal((await s.get("/api/sessions", token)).statusCode, 200, alg);
    }
    // An owner change goes through and is audited with its entry.
    const owner = await s.tokenFor(OWNER_SUB);
    const cat = (await s.get("/api/catalog", owner)).json();
    const created = await s.ctx.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { authorization: `Bearer ${owner}` },
      payload: { agent: "claude", workspaceId: cat.workspaces[0].id, profileId: cat.profiles.find((p: any) => p.agent === "claude").id },
    });
    assert.equal(created.statusCode, 200, created.body);
    const row = audits(s).find((r) => r.action === "api.session.create")!;
    assert.equal(row.user_id, "issuer");
    assert.equal(JSON.parse(row.target).channel, "issuer");

    // The scope is the token's ∩ the owner's (scopes.md §1 rule 2).
    const readOnly = await s.tokenFor(OWNER_SUB, { scope: "daisy:session:read" });
    assert.equal((await s.get("/api/sessions", readOnly)).statusCode, 200);
    const w = await s.ctx.app.inject({ method: "POST", url: "/api/sessions", headers: { authorization: `Bearer ${readOnly}` }, payload: {} });
    assert.equal(w.statusCode, 403);
    assert.equal(w.json().code, "insufficient_scope");
    assert.equal(w.headers["www-authenticate"], 'Bearer error="insufficient_scope", scope="daisy:session:write"');
    const foreignScopes = await s.tokenFor(OWNER_SUB, { scope: "daisy:tools daisy:invoke tasks:admin" });
    assert.equal((await s.get("/api/sessions", foreignScopes)).json().code, "insufficient_scope");

    // The PIN: a grant is bound to the issuer token that took it
    // (guard.ts holderOf: `issuer:<sha-256>`), good for no other token.
    const pinned = await s.tokenFor(OWNER_SUB);
    const p = await s.ctx.access.guard.identify(pinned, "local");
    assert.equal(p?.kind, "external-owner");
    assert.equal(holderOf(p!), `issuer:${createHash("sha256").update(pinned).digest("hex")}`);
    const g = s.pin.grant("246810", holderOf(p!)).grant;
    const passcode = (token: string) =>
      s.ctx.app.inject({ method: "PUT", url: "/api/access/passcode", headers: { authorization: `Bearer ${token}`, [PIN_GRANT_HEADER]: g }, payload: { mode: "on" } });
    assert.equal((await passcode(await s.tokenFor(OWNER_SUB))).json().code, "pin_required");
    assert.equal((await passcode(pinned)).statusCode, 200);
    // Without one, 「放别人进来」 is refused for the issuer's owner too.
    const noPin = await s.ctx.app.inject({ method: "PUT", url: "/api/access/passcode", headers: { authorization: `Bearer ${owner}` }, payload: { mode: "auto" } });
    assert.equal(noPin.json().code, "pin_required");
    // The local reset is the command line's only.
    const reset = await s.ctx.app.inject({ method: "POST", url: "/api/pin/reset", headers: { authorization: `Bearer ${owner}` }, payload: {} });
    assert.equal(reset.json().code, "channel_not_allowed");

    // From another machine: the outside face (D-31) — the issuer's token
    // is the owner there too, with no pairing and no one-time code.
    const on = await s.ctx.app.inject({ method: "PUT", url: "/api/access/external", headers: s.withPin(), payload: { host: "127.0.0.1", tls: false } });
    assert.equal(on.statusCode, 200, on.body);
    const port = on.json().external.port;
    const ext = (path: string, token: string) =>
      new Promise<{ status: number; json: any; www?: string }>((ok, fail) => {
        const req = httpRequest({ host: "127.0.0.1", port, path, headers: { authorization: `Bearer ${token}` } }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => ok({ status: res.statusCode!, json: b ? JSON.parse(b) : null, www: res.headers["www-authenticate"] as string }));
        });
        req.on("error", fail);
        req.end();
      });
    const there = await ext("/api/me", owner);
    assert.equal(there.status, 200);
    assert.deepEqual([there.json.channel, there.json.face], ["issuer", "external"]);
    // The command line's credential is still local only.
    assert.equal((await ext("/api/me", s.cli)).status, 401);
    // Someone else's valid token, there: A2A only (X-2).
    const stranger = await ext("/api/sessions", await s.tokenFor(OTHER_SUB));
    assert.equal(stranger.status, 403);
    assert.equal(stranger.json.code, "a2a_only");
    // Terminal / commands / folders stay off on the outside face for it too.
    const term = await ext(`/api/sessions/${created.json().id}/terminal`, owner);
    assert.equal(term.json.code, "external_off");
    await s.ctx.app.inject({ method: "DELETE", url: "/api/access/external", headers: s.asCli });
  } finally {
    await s.close();
  }
});

test("X-2: another person's valid token from the same issuer reaches no local route (A2A only); nor does one an AI holds for the owner", async () => {
  const s = await daisy();
  try {
    assert.equal((await s.configure()).statusCode, 200);
    const t = await runningTurn(s);
    const who = {
      someoneElse: await s.tokenFor(OTHER_SUB),
      someoneElseRs: await s.tokenFor(OTHER_SUB, {}, { alg: "RS256" }),
      // Even with every scope written in, and a PIN grant.
      someoneElseAllScopes: await s.tokenFor(OTHER_SUB, { scope: "daisy:session:read daisy:session:write daisy:manage daisy:grant daisy:tools daisy:invoke" }),
      ownerWithAct: await s.tokenFor(OWNER_SUB, { act: { sub: "agent:x" } }),
    };
    // Audited as who they are, not as the owner (one request each first:
    // the refusal audit is capped per minute).
    for (const token of Object.values(who)) await s.get("/api/sessions", token);
    const denied = audits(s).filter((r) => r.action === "access.denied" && JSON.parse(r.target).why === "a2a_only");
    assert.ok(denied.some((r) => r.user_id === `visitor:${OTHER_SUB}`));
    assert.ok(denied.some((r) => r.user_id === "issuer-ai:agent:x"));
    assert.ok(!denied.some((r) => r.user_id === "issuer" || r.user_id === "owner"));
    let tried = 0;
    for (const [name, token] of Object.entries(who)) {
      for (const r of API_ROUTES) {
        // P4-04: the A2A entry is theirs (below); every local route is not.
        if (r.scope === null || r.visitors) continue;
        const params = Object.fromEntries(Object.keys(r.params.shape).map((k) => [k, k === "id" ? t.own : "x-placeholder"]));
        if (r.auth === "socket-first-frame") {
          assert.equal(await s.ctx.access.guard.socketPrincipal({ raw: { socket: {} }, url: r.path, method: "GET" }, r, token), null, `${name} ${r.id}`);
          continue;
        }
        const res = await s.ctx.app.inject({
          method: r.method,
          url: fillPath(r.path, params),
          headers: { authorization: `Bearer ${token}`, [PIN_GRANT_HEADER]: s.pin.grant("246810", "cli").grant },
          ...(r.method === "GET" ? {} : { payload: {} }),
        });
        assert.equal(res.statusCode, 403, `${name} ${r.id}`);
        assert.equal(res.json().code, "a2a_only", `${name} ${r.id}`);
        if (r.scope) assert.equal(res.headers["www-authenticate"], `Bearer error="insufficient_scope", scope="${r.scope}"`);
        tried++;
      }
    }
    assert.ok(tried > 4 * 90);
    // Nothing was changed by any of them.
    assert.deepEqual(audits(s).filter((r) => r.action.startsWith("api.") && !["web", "cli"].includes(r.user_id)).map((r) => [r.user_id, r.action]), []);
    // P4-04: the A2A entry — with daisy:invoke they get through the guard (the
    // directory, empty: no agent is theirs to see); without it, 403.
    const dir = await s.get("/a2a", who.someoneElseAllScopes);
    assert.equal(dir.statusCode, 200, dir.body);
    assert.deepEqual(dir.json(), { agents: [] });
    const noInvoke = await s.get("/a2a", who.someoneElse);
    assert.equal(noInvoke.statusCode, 403);
    assert.equal(noInvoke.json().error.details[0].metadata.code, "insufficient_scope");
  } finally {
    await s.close();
  }
});

test("JWKS: cached in the data directory, verified offline (even after a restart), rotated by kid, refetched at most once a minute", async () => {
  const iss = await fakeIssuer({ cacheControl: "max-age=600" });
  const s = await daisy({ issuer: iss });
  let s2: Awaited<ReturnType<typeof daisy>> | undefined;
  try {
    assert.equal((await s.configure()).statusCode, 200);
    const fetchedOnce = iss.state.jwksFetches;
    assert.equal(fetchedOnce, 1);
    // The cache: the data directory, 0600 in a 0700 directory, public keys only.
    const file = join(s.dir, "issuer", "jwks.json");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    if (process.platform !== "win32") assert.equal(statSync(join(s.dir, "issuer")).mode & 0o777, 0o700);
    const cached = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(cached.keys.map((k: any) => k.kid).sort(), ["ed-1", "rs-1"]);
    assert.ok(cached.keys.every((k: any) => !("d" in k) && !("p" in k)));
    assert.equal(cached.expiresAt - cached.fetchedAt, 600_000);
    // Offline: the issuer goes down — its owner's tokens still work.
    iss.state.down = true;
    const owner = await s.tokenFor(OWNER_SUB);
    assert.equal((await s.get("/api/sessions", owner)).statusCode, 200);
    assert.equal((await s.get("/api/sessions", await s.tokenFor(OWNER_SUB, {}, { alg: "RS256" }))).statusCode, 200);
    // …and after a restart, from the cache on disk.
    await s.ctx.app.close();
    s2 = await daisy({ dir: s.dir, issuer: iss });
    assert.equal((await s2.get("/api/sessions", owner)).statusCode, 200);
    // Past the cache's lifetime with the issuer down: still used, flagged stale.
    const x = s2.ctx.access.issuer.get()!;
    (x as any).cache.expiresAt = Date.now() - 1;
    assert.equal((await s2.get("/api/sessions", owner)).statusCode, 200);
    await new Promise((r) => setTimeout(r, 50));
    const st = (await s2.ctx.app.inject({ url: "/api/access/issuer", headers: s2.asCli })).json();
    assert.equal(st.issuer.stale, true);
    assert.ok(st.issuer.lastError);
    // Rotation: the issuer replaces ed-1 with ed-2. A token under the new
    // kid makes Daisy refetch (the issuer is back) — and ed-1 is gone.
    iss.state.down = false;
    await iss.rotate("ed-2");
    (x as any).lastAttempt = 0;
    const before = iss.state.jwksFetches;
    const rotated = await s2.tokenFor(OWNER_SUB);
    assert.equal((await s2.get("/api/sessions", rotated)).statusCode, 200);
    assert.equal(iss.state.jwksFetches, before + 1);
    assert.equal((await s2.get("/api/sessions", owner)).statusCode, 401, "the dropped key is no longer trusted");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).keys.map((k: any) => k.kid).sort(), ["ed-2", "rs-1"]);
    // Another unknown kid within the minute: no second fetch (no hammering).
    await iss.rotate("ed-3");
    assert.equal((await s2.get("/api/sessions", await s2.tokenFor(OWNER_SUB))).statusCode, 401);
    assert.equal(iss.state.jwksFetches, before + 1);
    // The owner can refetch now (daisy:manage).
    const refresh = await s2.ctx.app.inject({ method: "POST", url: "/api/access/issuer/refresh", headers: s2.asCli });
    assert.equal(refresh.statusCode, 200, refresh.body);
    assert.equal(iss.state.jwksFetches, before + 2);
    assert.equal((await s2.get("/api/sessions", await s2.tokenFor(OWNER_SUB))).statusCode, 200);
    // Refreshing while the issuer is down says so.
    iss.state.down = true;
    const failed = await s2.ctx.app.inject({ method: "POST", url: "/api/access/issuer/refresh", headers: s2.asCli });
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.json().code, "issuer_unreachable");
    iss.state.down = false;
  } finally {
    if (s2) await s2.close();
    else await s.ctx.app.close();
    await iss.close();
  }
});

test("issuer rules: addresses, metadata locations, cache lifetimes, which keys and algorithms are accepted", () => {
  assert.throws(() => checkIssuerUrl("http://issuer.example", "x"), /https/);
  assert.throws(() => checkIssuerUrl("http://10.1.2.3", "x"), /https/);
  assert.throws(() => checkIssuerUrl("https://u:p@issuer.example", "x"), /用户名/);
  assert.throws(() => checkIssuerUrl("https://issuer.example/?a=1", "x", true), /查询串/);
  assert.throws(() => checkIssuerUrl("https://issuer.example/#f", "x"), /片段/);
  assert.throws(() => checkIssuerUrl("not a url", "x"), /不是一个地址/);
  assert.equal(checkIssuerUrl("https://issuer.example", "x"), "https://issuer.example");
  // Review M-3: plain http only on 127.0.0.1 / [::1], only when the policy
  // allows (DAISY_ALLOW_HTTP_ISSUER=1 on a machine with no other accounts).
  const yes = () => ({ allowed: true }),
    no = () => ({ allowed: false, why: "不许" });
  for (const ok of ["http://127.0.0.1:9", "http://[::1]:9/p"]) {
    assert.equal(checkIssuerUrl(ok, "x", false, yes), ok);
    assert.throws(() => checkIssuerUrl(ok, "x", false, no), /不许/);
    assert.throws(() => checkIssuerUrl(ok, "x"), /http/);
  }
  assert.throws(() => checkIssuerUrl("http://localhost:9", "x", false, yes), /https/);
  const shared = { v: false };
  const policy = httpIssuerPolicy(() => shared.v);
  const env = process.env.DAISY_ALLOW_HTTP_ISSUER;
  try {
    process.env.DAISY_ALLOW_HTTP_ISSUER = "1";
    assert.equal(policy().allowed, true);
    shared.v = true;
    assert.equal(policy().allowed, false);
    assert.match(policy().why!, /别人的账户/);
    shared.v = false;
    delete process.env.DAISY_ALLOW_HTTP_ISSUER;
    assert.equal(policy().allowed, false);
    assert.match(policy().why!, /DAISY_ALLOW_HTTP_ISSUER/);
  } finally {
    process.env.DAISY_ALLOW_HTTP_ISSUER = env;
  }
  assert.deepEqual(metadataCandidates("https://a.example"), [
    "https://a.example/.well-known/oauth-authorization-server",
    "https://a.example/.well-known/openid-configuration",
  ]);
  assert.deepEqual(metadataCandidates("https://a.example/tenant/1"), [
    "https://a.example/.well-known/oauth-authorization-server/tenant/1",
    "https://a.example/tenant/1/.well-known/openid-configuration",
  ]);
  const H = 3600_000;
  assert.equal(cacheLifetimeMs(null), H);
  assert.equal(cacheLifetimeMs("public, max-age=7200"), 2 * H);
  assert.equal(cacheLifetimeMs("max-age=10"), 5 * 60_000);
  assert.equal(cacheLifetimeMs("max-age=9999999"), 24 * H);
  assert.equal(cacheLifetimeMs("no-store"), 5 * 60_000);
  assert.equal(cacheLifetimeMs("private"), H);
  const n2048 = Buffer.alloc(256, 1).toString("base64url"),
    n1024 = Buffer.alloc(128, 1).toString("base64url"),
    x32 = Buffer.alloc(32, 2).toString("base64url");
  const kept = publicKeys({
    keys: [
      { kty: "OKP", crv: "Ed25519", x: x32, kid: "ed", d: x32 },
      { kty: "RSA", n: n2048, e: "AQAB", kid: "rs", d: "secret", p: "x" },
      { kty: "RSA", n: n1024, e: "AQAB", kid: "rs-small" },
      { kty: "EC", crv: "P-256", x: x32, y: x32, kid: "ec" },
      { kty: "EC", crv: "P-384", x: x32, y: x32, kid: "ec384" },
      { kty: "oct", k: "c2VjcmV0", kid: "hmac" },
      { kty: "OKP", crv: "Ed25519", x: x32, kid: "enc", use: "enc" },
      { kty: "OKP", crv: "Ed25519", x: x32, kid: "hs-alg", alg: "HS256" },
      { kty: "OKP", crv: "Ed25519", x: x32 },
    ],
  });
  assert.deepEqual(kept.map((k) => k.kid), ["ed", "rs", "ec"]);
  assert.ok(kept.every((k) => !("d" in k) && !("p" in k)));
  assert.throws(() => publicKeys({}), /keys/);
  const [ed, rs, ec] = kept as any[];
  assert.ok(algFits(ed, "EdDSA") && algFits(ed, "Ed25519") && !algFits(ed, "RS256") && !algFits(ed, "ES256"));
  assert.ok(algFits(rs, "RS256") && !algFits(rs, "EdDSA") && !algFits(rs, "HS256") && !algFits(rs, "PS256"));
  assert.ok(algFits(ec, "ES256") && !algFits(ec, "RS256"));
  assert.ok(!algFits({ ...ed, alg: "EdDSA" }, "RS256"));
  assert.ok(algFits({ ...ed, alg: "EdDSA" }, "Ed25519"));
  assert.ok(!algFits({ ...rs, alg: "RS256" }, "none"));
});
