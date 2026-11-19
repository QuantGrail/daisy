/**
 * P4-01 (5.6 公钥互认, 5.10 `daisy contact`, 5.11, D-15, ADR-120,
 * docs/contracts/identity-card.md, token.md §4.1): identity cards and the
 * contacts. Refusals first; then the card's format, import's checks,
 * recognition of contacts' tokens and its end at removal — T-2, T-10.
 *
 * A, B and C are three Daisies, each with its own data directory and
 * Ed25519 identity key. A is a running app; B and C sign their own cards
 * and their own cross-Daisy tokens (token.md §3 `a2a`) as P4-08 will.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, createPrivateKey } from "node:crypto";
import { CompactSign, SignJWT, calculateJwkThumbprint } from "jose";
import { api } from "../packages/contracts/src/api/index.ts";
import { fillPath, type AnyRoute } from "../packages/contracts/src/index.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { SelfIssuer } from "../packages/daisy/src/access/tokens/self-issuer.ts";
import { THUMBPRINT_URN } from "../packages/daisy/src/access/tokens/common.ts";
import { makeCard, cardText, readCard, cardReader } from "../packages/daisy/src/contacts/card.ts";
import {
  base32,
  unbase32,
  identityId,
  keyRefBytes,
  formsOfKey,
  groupedId,
} from "../packages/daisy/src/contacts/identity.ts";
import { admit } from "../packages/daisy/src/contacts/admission.ts";
import { createApp } from "../packages/daisy/src/app.ts";
import { runtimeFile } from "../packages/daisy/src/platform/paths.ts";
import { daisy as cliRun, testIo } from "./cli-fixture.ts";
import { daisy, runningTurn, type Daisy } from "./fixtures/daisy-with-issuer.ts";

const C = api.contacts;
const webHolder = (token: string) => `web:${createHash("sha256").update(token).digest("hex")}`;

/** Another Daisy: its own data directory and identity key. */
async function other(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `daisy-peer-${name}-`));
  const self = await SelfIssuer.open(dir);
  const card = await makeCard(self, { name, addrs: [{ kind: "direct", url: `https://${name.toLowerCase()}.example.net:29600` }] });
  /** A cross-Daisy access token for `aud` (token.md §3: client_id a2a, sub = iss). */
  const token = (aud: string, o: { ttlS?: number; sub?: string; clientId?: string; scope?: string; act?: boolean } = {}) =>
    self
      .sign({
        sub: o.sub ?? self.urn,
        aud,
        clientId: o.clientId ?? "a2a",
        scope: o.scope ?? "daisy:invoke",
        ttlS: o.ttlS ?? 300,
        ...(o.act === false ? {} : { act: { sub: "agent:s-1", name: "研究助手" } }),
      })
      .then((t) => t.token);
  return { dir, self, card, text: cardText(card), token, close: () => rmSync(dir, { recursive: true, force: true }) };
}
type Other = Awaited<ReturnType<typeof other>>;

const call = (
  s: Daisy,
  def: AnyRoute,
  o: { params?: Record<string, string>; body?: unknown; query?: string; headers?: Record<string, string> } = {},
) =>
  s.ctx.app.inject({
    method: def.method,
    url: fillPath(def.path, o.params ?? {}) + (o.query ? `?${o.query}` : ""),
    headers: o.headers ?? s.withPin(),
    ...(def.method === "GET" || def.method === "DELETE" ? {} : { payload: (o.body ?? {}) as any }),
  });
const importCard = (s: Daisy, card: string, more: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  call(s, C.contactImport, { body: { card, ...more }, ...(headers ? { headers } : {}) });
/** Rows that would be "A received a card": approvals of any kind, event outlet rows. */
const cardsRaised = (s: Daisy) =>
  (s.ctx.store.one("SELECT COUNT(*) n FROM approvals").n as number) +
  (s.ctx.store.one("SELECT COUNT(*) n FROM owner_approvals").n as number) +
  (s.ctx.store.one("SELECT COUNT(*) n FROM event_outbox").n as number);
const audits = (s: Daisy) =>
  s.ctx.store.all("SELECT user_id,action,target FROM audit ORDER BY created, rowid") as { user_id: string; action: string; target: string }[];

/** Sign anything as a card would be signed, with a key of our own. */
function forger() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const key = { kty: "OKP", crv: "Ed25519", x: jwk.x };
  const id = identityId(key);
  const sign = (payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "EdDSA", typ: "daisy-card+jwt" }) =>
    new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader(header as any).sign(privateKey);
  const base = (more: Record<string, unknown> = {}) => ({
    v: 1,
    id,
    key,
    name: "伪造者",
    addrs: [],
    iat: Math.floor(Date.now() / 1000),
    ...more,
  });
  return { privateKey, key, id, sign, base };
}

// ── refusals first ────────────────────────────────────────────────────────

test("contact routes: daisy:grant on the owner's channels only — never the AI, never a visitor; the changes take the PIN, the reads only on the command line", async () => {
  const s = await daisy();
  const b = await other("B");
  try {
    const t = await runningTurn(s);
    const web = s.ctx.issueToken();
    const grantRoutes = Object.values(C);
    assert.equal(grantRoutes.length, 8);
    // D-40 ①: reading (export, inspect, list, show) is not letting in.
    const READS = ["grant.contactExport", "grant.contactInspect", "grant.contactList", "grant.contactShow"];
    for (const r of grantRoutes) {
      assert.equal(r.scope, "daisy:grant", r.id);
      assert.match(r.path, /^\/api\/contacts(\/|$)/, r.id);
      assert.ok(!r.channels.includes("ai"), r.id);
      if (READS.includes(r.id)) {
        assert.equal(r.pin, true, r.id);
        assert.deepEqual(r.pinOn, ["cli"], r.id);
        assert.equal(r.letsIn, undefined, r.id);
      } else {
        assert.equal(r.pin, true, r.id);
        // P4-02: 5.11 「添加、移除互认的名片」, at the place reserved for it.
        assert.equal(r.letsIn, "contact", r.id);
      }
    }
    // A known contact, so the visitor below is a recognised one.
    assert.equal((await importCard(s, b.text)).statusCode, 200);
    // A fresh cross-Daisy token per request (each is good once, P4-04).
    const visitor = () => b.token(s.urn);
    const params = { id: b.card.id };
    for (const r of grantRoutes) {
      const read = READS.includes(r.id);
      const body = ["grant.contactImport", "grant.contactInspect"].includes(r.id) ? { card: b.text } : {};
      const try_ = (headers: Record<string, string>) => call(s, r, { params, body, headers });
      // No credential.
      assert.equal((await try_({})).statusCode, 401, r.id);
      // Without a PIN grant: a change is refused everywhere; a read goes
      // through on the web page, and on the command line (maybe the owner's
      // AI through Bash) is refused too (D-40 ①).
      for (const h of [s.asCli, { authorization: `Bearer ${web}` }]) {
        const x = await try_(h);
        if (read && h !== s.asCli) assert.equal(x.statusCode, 200, `${r.id}: ${x.body}`);
        else {
          assert.equal(x.statusCode, 403, r.id);
          assert.equal(x.json().code, "pin_required", r.id);
        }
      }
      // The web page's grant is not the command line's (local-api.md §6.3).
      const crossed = await try_({ ...s.asCli, [PIN_GRANT_HEADER]: s.pin.grant("246810", webHolder(web)).grant });
      assert.equal(crossed.json().code, "pin_required", r.id);
      // A read on the command line with its own grant: through.
      if (read) assert.equal((await try_(s.withPin())).statusCode, 200, r.id);
      // The AI, without and with a grant: never.
      for (const h of [{}, { [PIN_GRANT_HEADER]: s.pin.grant("246810", "ai").grant }] as Record<string, string>[]) {
        const ai = await try_({ authorization: `Bearer ${t.ai}`, ...h });
        assert.equal(ai.statusCode, 403, r.id);
        assert.equal(ai.json().code, "channel_not_allowed", r.id);
      }
      // A contact's own token: A2A only (X-2's rule, token.md §4.1 step 9).
      const v = await try_({ authorization: `Bearer ${await visitor()}` });
      assert.equal(v.statusCode, 403, r.id);
      assert.equal(v.json().code, "a2a_only", r.id);
    }
    // Nothing changed by any of those.
    assert.equal(s.ctx.access.contacts.list().length, 1);
    // Inspect tells whose card it is (nothing stored), no PIN on the web page.
    const ok = await call(s, C.contactInspect, { body: { card: b.text }, headers: { authorization: `Bearer ${web}` } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().card.id, b.card.id);
    assert.equal(ok.json().self, false);
    // The web page lists without a grant.
    const wl = await call(s, C.contactList, { headers: { authorization: `Bearer ${web}` } });
    assert.equal(wl.statusCode, 200);
    assert.equal(wl.json().contacts.length, 1);
    // The command line's grant is good for one request only (review M-3).
    const g = s.withPin();
    assert.equal((await call(s, C.contactWhitelistAdd, { params, headers: g })).statusCode, 200);
    assert.equal((await call(s, C.contactWhitelistAdd, { params, headers: g })).json().code, "pin_required");
  } finally {
    b.close();
    await s.close();
  }
});

test("T-2: C never added — its calls are refused and A gets no card; its card known to B means nothing to A (不传递)", async () => {
  const a = await daisy();
  const b = await other("B");
  const c = await other("C");
  try {
    assert.equal((await importCard(a, b.text, { whitelist: true })).statusCode, 200);
    const before = cardsRaised(a);
    // C signs a well-formed cross-Daisy token for A.
    const ct = await c.token(a.urn);
    // At the guard: nobody (401, invalid_token, nothing said about why).
    for (const url of ["/api/sessions", "/api/contacts", "/api/me"]) {
      const r = await a.get(url, ct);
      assert.equal(r.statusCode, 401, url);
      assert.equal(r.json().code, "unauthenticated");
      assert.match(String(r.headers["www-authenticate"]), /invalid_token/);
    }
    // The audit says why (the caller is not told).
    const denied = audits(a).filter((x) => x.action === "access.denied").map((x) => JSON.parse(x.target).why);
    assert.ok(denied.includes("invalid_token/unknown_issuer"), denied.join(","));
    // At admission, for every kind of agent: refused, no card.
    const p = await a.ctx.access.guard.identify(ct, "external");
    assert.equal(p, null);
    for (const agent of [{ openTo: "all" as const }, { openTo: "listed" as const, listed: [c.card.id] }, { openTo: "private" as const }])
      assert.deepEqual(admit(p, agent, a.ctx.access.contacts), { outcome: "refused", reason: "not_recognised" });
    // Not transitive: B (a contact, whitelisted) signs a token naming C as the person.
    const relayed = await b.token(a.urn, { sub: c.self.urn });
    assert.equal((await a.get("/api/sessions", relayed)).statusCode, 401);
    assert.equal(await a.ctx.access.guard.identify(relayed, "external"), null);
    // C's card on its own (no import) recognises no one.
    const insp = await call(a, C.contactInspect, { body: { card: c.text } });
    assert.equal(insp.statusCode, 200);
    assert.equal(await a.ctx.access.guard.identify(ct, "external"), null);
    // A received no card of any kind.
    assert.equal(cardsRaised(a), before);
  } finally {
    b.close();
    c.close();
    await a.close();
  }
});

test("T-10: A adds B's card with 加进白名单 — B's first call is admitted with no card; without it the owner is asked", async () => {
  const a = await daisy();
  const b = await other("B");
  const d = await other("D");
  try {
    const before = cardsRaised(a);
    const r = await importCard(a, b.text, { whitelist: true });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().result, "added");
    assert.equal(r.json().contact.whitelisted, true);
    // B's first call: recognised as B (and its AI), admitted by the whitelist.
    const bt = await b.token(a.urn);
    const p = await a.ctx.access.guard.identify(bt, "external");
    assert.ok(p);
    assert.equal(p.kind, "visitor");
    assert.equal(p.channel, "a2a");
    assert.equal(p.contactId, b.card.id);
    assert.equal(p.subject, b.self.urn);
    assert.equal(p.actor, "agent:s-1");
    assert.deepEqual(p.scopes, ["daisy:invoke"]);
    assert.deepEqual(admit(p, { openTo: "all" }, a.ctx.access.contacts), {
      outcome: "allowed",
      via: "whitelist",
      contactId: b.card.id,
    });
    assert.equal(cardsRaised(a), before, "no card");
    // The whitelist covers agents open to all contacts only (5.6): a private
    // agent, or one listing others, still refuses (no card either).
    assert.equal(admit(p, { openTo: "private" }, a.ctx.access.contacts).outcome, "refused");
    assert.equal(admit(p, { openTo: "listed", listed: [d.card.id] }, a.ctx.access.contacts).outcome, "refused");
    assert.equal(admit(p, { openTo: "listed", listed: [b.card.id] }, a.ctx.access.contacts).outcome, "allowed");
    // D added without the whitelist: recognised, but the owner decides
    // (P4-03 raises the card here).
    assert.equal((await importCard(a, d.text)).json().contact.whitelisted, false);
    const pd = await a.ctx.access.guard.identify(await d.token(a.urn), "external");
    assert.deepEqual(admit(pd, { openTo: "all" }, a.ctx.access.contacts), {
      outcome: "ask_owner",
      contactId: d.card.id,
      subject: d.self.urn,
    });
    // Whitelisting afterwards (PIN) admits D's next call; taking B off asks again.
    assert.equal((await call(a, C.contactWhitelistAdd, { params: { id: d.card.id } })).json().contact.whitelisted, true);
    assert.equal(admit(pd, { openTo: "all" }, a.ctx.access.contacts).outcome, "allowed");
    assert.equal((await call(a, C.contactWhitelistRemove, { params: { id: b.card.id } })).json().contact.whitelisted, false);
    assert.equal(admit(p, { openTo: "all" }, a.ctx.access.contacts).outcome, "ask_owner");
    // Recorded: who, through which entry.
    const add = audits(a).find((x) => x.action === "contact.add")!;
    assert.equal(add.user_id, "cli");
    assert.deepEqual(JSON.parse(add.target), { face: "local", channel: "cli", id: b.card.id, name: "B", whitelisted: true });
  } finally {
    b.close();
    d.close();
    await a.close();
  }
});

test("removing a contact: not recognised from the very next request — whitelist gone, listeners told, an earlier principal no longer admitted", async () => {
  const a = await daisy();
  const b = await other("B");
  try {
    await importCard(a, b.text, { whitelist: true });
    const told: string[] = [];
    a.ctx.access.contacts.onRemoved((c) => told.push(c.id));
    // Each cross-Daisy token is good once (P4-04): one per request.
    const bt = await b.token(a.urn);
    // Recognised (a visitor: local routes refuse it with a2a_only, not 401).
    assert.equal((await a.get("/api/sessions", await b.token(a.urn))).json().code, "a2a_only");
    const p = await a.ctx.access.guard.identify(await b.token(a.urn), "external");
    assert.equal(admit(p, { openTo: "all" }, a.ctx.access.contacts).outcome, "allowed");
    // Removed by a unique prefix of its number, with the PIN.
    const rm = await call(a, C.contactRemove, { params: { id: b.card.id.slice(0, 10).toUpperCase() } });
    assert.equal(rm.statusCode, 200, rm.body);
    assert.equal(rm.json().removed.id, b.card.id);
    assert.deepEqual(told, [b.card.id]);
    // A token signed before the removal, never used, and a fresh one: nobody.
    const after = await a.get("/api/sessions", bt);
    assert.equal(after.statusCode, 401);
    assert.equal(await a.ctx.access.guard.identify(await b.token(a.urn), "external"), null);
    // The principal from before the removal is not admitted any more.
    assert.deepEqual(admit(p, { openTo: "all" }, a.ctx.access.contacts), { outcome: "refused", reason: "not_recognised" });
    assert.equal(a.ctx.access.contacts.isWhitelisted(b.card.id), false);
    // Gone from the list; removing again says so.
    assert.equal((await call(a, C.contactList)).json().contacts.length, 0);
    const again = await call(a, C.contactRemove, { params: { id: b.card.id } });
    assert.equal(again.statusCode, 404);
    assert.equal(again.json().code, "contact_not_found");
    assert.ok(audits(a).some((x) => x.action === "contact.remove" && JSON.parse(x.target).id === b.card.id));
    // Re-imported: recognised again, but the whitelist is not back by itself.
    const back = await importCard(a, b.text);
    assert.equal(back.json().result, "added");
    assert.equal(back.json().contact.whitelisted, false);
    assert.equal((await a.get("/api/sessions", await b.token(a.urn))).json().code, "a2a_only");
    // A listener that throws undoes the removal (it runs in the transaction).
    a.ctx.access.contacts.onRemoved(() => {
      throw new Error("could not stop the calls");
    });
    assert.equal((await call(a, C.contactRemove, { params: { id: b.card.id } })).statusCode, 500);
    assert.ok(a.ctx.access.contacts.get(b.card.id));
  } finally {
    b.close();
    await a.close();
  }
});

test("T-9 (contacts): resetting the PIN on this machine makes every imported contact unrecognised, whitelist and all, and says so in the record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-contact-t9-"));
  const b = await other("B");
  const c = await other("C");
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, workspaceRoots: [dir], sharedHost: () => false, peerIsOwner: () => true });
  try {
    // The real PIN service (not the stand-in), through the routes.
    const cli = { authorization: `Bearer ${readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim()}` };
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/pin", headers: cli, payload: { pin: "246810" } })).statusCode, 200);
    const withPin = async () => ({
      ...cli,
      [PIN_GRANT_HEADER]: (await ctx.app.inject({ method: "POST", url: "/api/pin/grant", headers: cli, payload: { pin: "246810" } })).json().grant,
    });
    for (const [x, wl] of [[b, true], [c, false]] as const) {
      const r = await ctx.app.inject({ method: "POST", url: "/api/contacts", headers: await withPin(), payload: { card: x.text, whitelist: wl } });
      assert.equal(r.statusCode, 200, r.body);
    }
    const urn = ctx.access.ai.urn;
    const bt = await b.token(urn);
    assert.equal((await ctx.app.inject({ url: "/api/sessions", headers: { authorization: `Bearer ${bt}` } })).json().code, "a2a_only");
    const reset = await ctx.app.inject({ method: "POST", url: "/api/pin/reset", headers: cli, payload: { confirm: true } });
    assert.equal(reset.statusCode, 200, reset.body);
    // Nobody any more: the same token is 401, the address book and its whitelist are empty.
    assert.equal((await ctx.app.inject({ url: "/api/sessions", headers: { authorization: `Bearer ${bt}` } })).statusCode, 401);
    assert.equal(await ctx.access.guard.identify(bt, "external"), null);
    assert.equal(ctx.store.one("SELECT COUNT(*) n FROM contacts").n, 0);
    assert.equal(ctx.access.contacts.isWhitelisted(b.card.id), false);
    const summary = JSON.parse(ctx.store.one("SELECT target FROM audit WHERE action='pin.reset.revoke'").target);
    assert.equal(summary.revoked.contacts, 2);
    assert.ok(!summary.pending.includes("contacts"));
    assert.deepEqual(ctx.access.revocations.namesOf("contacts").length, 1);
  } finally {
    await ctx.app.close();
    b.close();
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an import let through before a PIN reset writes nothing once the reset happened during its await (P4-02 review M-1, commitLetIn)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-contact-epoch-"));
  const b = await other("B");
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, workspaceRoots: [dir], sharedHost: () => false, peerIsOwner: () => true });
  const orig = cardReader.read;
  try {
    const cli = { authorization: `Bearer ${readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim()}` };
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/pin", headers: cli, payload: { pin: "246810" } })).statusCode, 200);
    const grant = (await ctx.app.inject({ method: "POST", url: "/api/pin/grant", headers: cli, payload: { pin: "246810" } })).json().grant;
    // Hold the import inside its await (verifying the card).
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (release = r));
    cardReader.read = async (t) => {
      const card = await orig(t);
      entered();
      await gate;
      return card;
    };
    const pending = ctx.app.inject({ method: "POST", url: "/api/contacts", headers: { ...cli, [PIN_GRANT_HEADER]: grant }, payload: { card: b.text, whitelist: true } });
    await inside;
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/pin/reset", headers: cli, payload: { confirm: true } })).statusCode, 200);
    release();
    const late = await pending;
    assert.equal(late.statusCode, 409, late.body);
    assert.equal(late.json().code, "pin_changed");
    assert.equal(ctx.store.one("SELECT COUNT(*) n FROM contacts").n, 0, "名片没有被写回");
    assert.equal((await ctx.app.inject({ url: "/api/sessions", headers: { authorization: `Bearer ${await b.token(ctx.access.ai.urn)}` } })).statusCode, 401);
  } finally {
    cardReader.read = orig;
    await ctx.app.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resetting the PIN removes every contact (the stand-in PIN's reset runs the same hook)", async () => {
  const a = await daisy();
  const b = await other("B");
  const c = await other("C");
  try {
    await importCard(a, b.text, { whitelist: true });
    await importCard(a, c.text);
    assert.equal(a.ctx.access.contacts.list().length, 2);
    const bt = await b.token(a.urn);
    a.pin.resetLocal();
    assert.equal(a.ctx.access.contacts.list().length, 0);
    assert.equal((await a.get("/api/sessions", bt)).statusCode, 401);
  } finally {
    b.close();
    c.close();
    await a.close();
  }
});

test("a contact's token is checked as token.md §4.1 says: audience, lifetime, times, sub, client_id, kid, algorithm", async () => {
  const a = await daisy();
  const b = await other("B");
  try {
    await importCard(a, b.text);
    const ok = await b.token(a.urn);
    assert.equal((await a.get("/api/sessions", ok)).json().code, "a2a_only");
    // An AI-less token (the person's Daisy itself) is recognised too.
    assert.equal((await a.get("/api/sessions", await b.token(a.urn, { act: false }))).json().code, "a2a_only");
    const now = Math.floor(Date.now() / 1000);
    const pk = createPrivateKey({ key: JSON.parse(readFileSync(join(b.dir, "keys", "identity-key.json"), "utf8")), format: "jwk" });
    const raw = (claims: Record<string, unknown>, header: Record<string, unknown> = {}) =>
      new SignJWT({ client_id: "a2a", scope: "daisy:invoke", jti: "j-" + Math.random(), ...claims })
        .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: b.self.kid, ...header } as any)
        .sign(pk);
    const base = { iss: b.self.urn, sub: b.self.urn, aud: a.urn, iat: now, exp: now + 120 };
    const bad: [string, string][] = [
      ["another audience", await b.token(THUMBPRINT_URN + "x".repeat(43))],
      ["longer than 5 minutes", await b.token(a.urn, { ttlS: 301 })],
      ["sub is someone else", await b.token(a.urn, { sub: THUMBPRINT_URN + "y".repeat(43) })],
      ["client_id not a2a", await b.token(a.urn, { clientId: "cli" })],
      ["expired", await raw({ ...base, iat: now - 600, exp: now - 300 })],
      ["iat in the future", await raw({ ...base, iat: now + 600, exp: now + 700 })],
      ["kid of another key", await raw(base, { kid: "z".repeat(43) })],
      ["typ JWT", await raw(base, { typ: "JWT" })],
      // P4-04 (P4-01 review): `aud` is this Daisy alone — a list with another is refused.
      ["aud a list with another Daisy", await raw({ ...base, aud: [a.urn, THUMBPRINT_URN + "w".repeat(43)] })],
      ["no jti", await new SignJWT({ client_id: "a2a", scope: "daisy:invoke", ...base }).setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: b.self.kid }).sign(pk)],
    ];
    // Another key claiming B's issuer.
    const { privateKey: stranger } = generateKeyPairSync("ed25519");
    bad.push(["signed by another key", await new SignJWT({ client_id: "a2a", scope: "daisy:invoke", jti: "x1", ...base }).setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: b.self.kid }).sign(stranger)]);
    // alg none.
    const h64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    bad.push(["alg none", `${h64({ alg: "none", typ: "at+jwt", kid: b.self.kid })}.${h64({ ...base, client_id: "a2a", scope: "daisy:invoke", jti: "n" })}.`]);
    for (const [why, token] of bad) {
      const r = await a.get("/api/sessions", token);
      assert.equal(r.statusCode, 401, why);
      assert.ok(!r.body.includes(token), why);
    }
    // P4-04 (P4-01 review): a token is good once — the same one again is refused
    // (its jti is kept until exp + skew; the audit says why, the caller only 401).
    const once = await b.token(a.urn);
    assert.equal((await a.get("/api/sessions", once)).json().code, "a2a_only");
    const replay = await a.get("/api/sessions", once);
    assert.equal(replay.statusCode, 401);
    assert.ok(a.ctx.store.one("SELECT COUNT(*) n FROM audit WHERE target LIKE '%invalid_token/replayed%'").n >= 1);
    // D-40 ④: `kid` is the identity number (base32, identity-card.md §3) —
    // and only that: the same key's base64url thumbprint is refused.
    assert.equal(b.self.kid, b.card.id);
    assert.equal((await a.get("/api/sessions", await raw(base, { kid: b.card.id }))).json().code, "a2a_only");
    const b64Kid = await raw(base, { kid: b.self.thumbprint });
    assert.match(b.self.thumbprint, /^[A-Za-z0-9_-]{43}$/);
    const refused = await a.get("/api/sessions", b64Kid);
    assert.equal(refused.statusCode, 401, "base64url 指纹写的 kid 不再认");
    assert.ok(a.ctx.store.one("SELECT COUNT(*) n FROM audit WHERE target LIKE '%invalid_token/unknown_key%'").n >= 1);
    // Scopes other than daisy:invoke are dropped (a visitor is A2A only).
    const wide = await b.token(a.urn, { scope: "daisy:invoke daisy:grant daisy:manage" });
    assert.deepEqual((await a.ctx.access.guard.identify(wide, "external"))!.scopes, ["daisy:invoke"]);
    // No token in any audit row.
    for (const r of audits(a)) for (const [, t] of bad) assert.ok(!r.target.includes(t));
  } finally {
    b.close();
    await a.close();
  }
});

// ── the card ─────────────────────────────────────────────────────────────

test("export: the card is identity-card.md §1–§3 — fields, text, identity number, self-signed; never a credential", async () => {
  const a = await daisy();
  try {
    const r = await call(a, C.contactExport, { query: "name=%E5%BC%A0%E4%B8%89&note=%E5%85%AC%E5%8F%B8%E9%82%A3%E5%8F%B0&direct=https://10.0.0.5:29600&relay=https://zs.relay.example.org" });
    assert.equal(r.statusCode, 200, r.body);
    const v = r.json();
    // §3: base32 lowercase, no padding, 52 characters, of the RFC 7638 thumbprint.
    const jwk = a.ctx.access.ai.self.publicJwk;
    assert.match(v.id, /^[a-z2-7]{52}$/);
    const tp = await calculateJwkThumbprint(jwk as any, "sha256");
    assert.equal(v.id, base32(Buffer.from(tp, "base64url")));
    assert.equal(v.urn, a.urn);
    assert.equal(v.urn, THUMBPRINT_URN + tp);
    assert.equal(v.grouped.replace(/ /g, ""), v.id);
    assert.match(v.grouped, /^([a-z2-7]{4} ){12}[a-z2-7]{4}$/);
    // §2: the text.
    const lines = v.text.split("\n");
    assert.deepEqual(lines.slice(0, -1), [
      "Daisy 身份名片",
      "名字：张三",
      `编号：${v.grouped}`,
      "地址：https://10.0.0.5:29600",
      "地址：https://zs.relay.example.org",
      "备注：公司那台",
    ]);
    const m = /^daisy-card:1:(.+)$/.exec(lines.at(-1));
    assert.ok(m);
    const [h, p] = m[1].split(".");
    assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "EdDSA", typ: "daisy-card+jwt" });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    assert.deepEqual(Object.keys(payload).sort(), ["addrs", "iat", "id", "key", "name", "note", "v"]);
    assert.equal(payload.v, 1);
    assert.equal(payload.id, v.id);
    assert.deepEqual(payload.key, { kty: "OKP", crv: "Ed25519", x: jwk.x });
    assert.deepEqual(payload.addrs, [
      { kind: "direct", url: "https://10.0.0.5:29600" },
      { kind: "relay", url: "https://zs.relay.example.org" },
    ]);
    assert.ok(Math.abs(payload.iat - Date.now() / 1000) < 60);
    assert.ok(m[1].length < 1000);
    // It verifies (self-signed) and reads back the same.
    const back = await readCard(v.text);
    assert.equal(back.id, v.id);
    assert.equal(back.note, "公司那台");
    // Defaults: the account name, no address while the outside face is off, no note.
    const d = (await call(a, C.contactExport)).json();
    assert.ok(d.name.length >= 1);
    assert.deepEqual(d.addrs, []);
    assert.equal(d.note, null);
    assert.ok(!d.text.includes("地址："));
    // Bad fields are refused (and so never exported).
    for (const q of ["direct=ftp://x.example", "relay=http://plain.example", "direct=https://u:p@x.example", "name=%0Aevil"]) {
      const x = await call(a, C.contactExport, { query: q });
      assert.equal(x.statusCode, 400, q);
    }
    // A card is never a credential.
    assert.equal((await a.get("/api/sessions", m[1])).statusCode, 401);
    assert.equal((await a.get("/api/sessions", lines.at(-1))).statusCode, 401);
    // The private key appears nowhere.
    const priv = JSON.parse(readFileSync(join(a.dir, "keys", "identity-key.json"), "utf8")).d;
    assert.ok(!r.body.includes(priv));
    // Its own card cannot be added.
    const self = await importCard(a, v.text);
    assert.equal(self.statusCode, 400);
    assert.equal(self.json().code, "contact_self");
    assert.equal((await call(a, C.contactInspect, { body: { card: v.text } })).json().self, true);
  } finally {
    await a.close();
  }
});

test("import verifies the card (identity-card.md §4): signature, number, version, people's lines — and says what is wrong", async () => {
  const a = await daisy();
  const b = await other("B");
  const f = forger();
  try {
    const expectInvalid = async (card: string, re: RegExp, code = "card_invalid") => {
      const r = await importCard(a, card);
      assert.equal(r.statusCode, 400, `${card.slice(0, 80)}: ${r.body}`);
      assert.equal(r.json().code, code);
      assert.match(r.json().error, re);
    };
    const [h, p, sig] = b.card.jws.split(".");
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    // A changed payload under the original signature.
    await expectInvalid(`daisy-card:1:${h}.${b64({ ...payload, name: "Mallory" })}.${sig}`, /签名不对/);
    // People's lines that disagree with the payload — each named.
    await expectInvalid(b.text.replace("名字：B", "名字：Bob"), /“名字”一行/);
    await expectInvalid(b.text.replace(/编号：(\w)/, (_m, c) => `编号：${c === "a" ? "b" : "a"}`), /像编号的字符.*不一样/);
    await expectInvalid(b.text.replace("地址：https://b.example.net:29600", "地址：https://evil.example"), /“地址”一行/);
    // A newer major version; a garbled one.
    await expectInvalid(b.text.replace("daisy-card:1:", "daisy-card:2:"), /需要更新版本/, "card_version");
    await expectInvalid(b.text.replace("daisy-card:1:", "daisy-card:x:"), /版本号/);
    // No card at all; two cards; truncated.
    await expectInvalid("你好", /找不到 daisy-card:/);
    await expectInvalid(`${b.text}\n${b.text}`, /不止一张/);
    await expectInvalid(b.text.slice(0, -20).replace(/\.[^.]*$/, ""), /完整|签名不对/);
    // The header: typ, alg.
    await expectInvalid(`daisy-card:1:${await f.sign(f.base(), { alg: "EdDSA", typ: "JWT" })}`, /类型/);
    await expectInvalid(`daisy-card:1:${await f.sign(f.base(), { alg: "EdDSA", typ: "daisy-card+jwt", jwk: f.key })}`, /不认识的成员/);
    const none = `${b64({ alg: "none", typ: "daisy-card+jwt" })}.${b64(f.base())}.`;
    await expectInvalid(`daisy-card:1:${none}x`, /EdDSA/);
    // The number is not this key's; the key carries a private part; not Ed25519.
    await expectInvalid(`daisy-card:1:${await f.sign(f.base({ id: b.card.id }))}`, /编号不是这把公钥算出来的/);
    await expectInvalid(`daisy-card:1:${await f.sign(f.base({ key: { ...f.key, d: "A".repeat(43) } }))}`, /私钥/);
    await expectInvalid(`daisy-card:1:${await f.sign(f.base({ key: { kty: "EC", crv: "P-256", x: f.key.x } }))}`, /Ed25519/);
    // Fields: name, note, addresses, v, iat.
    await expectInvalid(`daisy-card:1:${await f.sign(f.base({ name: "" }))}`, /名字不能为空/);
    await expectInvalid(`daisy-card:1:${await f.sign(f.base({ name: "x".repeat(65) }))}`, /最多 64/);
    await expectInvalid(`daisy-card:1:${await f.sign(f.base({ name: "a\nb" }))}`, /控制字符/);
    await expectInvalid(`daisy-card:1:${await f.sign(f.base({ note: "n".repeat(201) }))}`, /最多 200/);
    await expectInvalid(`daisy-card:1:${await f.sign(f.base({ addrs: [{ kind: "relay", url: "http://r.example" }] }))}`, /https/);
    await expectInvalid(`daisy-card:1:${await f.sign(f.base({ addrs: "x" }))}`, /数组/);
    await expectInvalid(`daisy-card:1:${await f.sign(f.base({ v: 2 }))}`, /版本 v/);
    await expectInvalid(`daisy-card:1:${await f.sign(f.base({ iat: "now" }))}`, /iat/);
    // Too big to be a card.
    assert.equal((await importCard(a, "x".repeat(17 * 1024) + b.text)).statusCode, 400);
    await assert.rejects(readCard("x".repeat(17 * 1024) + b.text), /字节/);
    assert.equal(a.ctx.access.contacts.list().length, 0);
    // Whitespace a chat program put in, the machine line alone, a file: all fine.
    const machine = b.text.split("\n").at(-1)!;
    const broken = machine.replace(/(.{70})/g, "$1\n  ");
    const insp = await call(a, C.contactInspect, { body: { card: broken } });
    assert.equal(insp.statusCode, 200, insp.body);
    assert.equal(insp.json().card.name, "B");
    assert.match(insp.json().card.verify, /核对编号/);
    assert.equal((await call(a, C.contactInspect, { body: { card: machine } })).statusCode, 200);
    const file = await call(a, C.contactInspect, { body: { cardFile: Buffer.from(b.text).toString("base64") } });
    assert.equal(file.json().card.id, b.card.id);
    // Neither or both: a clear 400.
    assert.equal((await call(a, C.contactInspect, { body: {} })).statusCode, 400);
    // Unknown payload fields (a later minor version) are ignored; an unknown address kind refused.
    assert.equal((await call(a, C.contactInspect, { body: { card: `daisy-card:1:${await f.sign(f.base({ future: 1 }))}` } })).statusCode, 200);
    // expectId: the number the owner checked with B.
    const mismatch = await importCard(a, b.text, { expectId: f.id.slice(0, 16) });
    assert.equal(mismatch.json().code, "id_mismatch");
    assert.equal((await importCard(a, b.text, { expectId: b.card.id.slice(0, 15) })).json().code, "id_mismatch");
    const ok = await importCard(a, broken, { expectId: groupedId(b.card.id) });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().result, "added");
    assert.match(ok.json().verify, /核对编号/);
  } finally {
    b.close();
    await a.close();
  }
});

test("a known contact's card: the same again changes nothing; a newer one needs update and shows what changed; an older one is refused", async () => {
  const a = await daisy();
  const b = await other("B");
  try {
    assert.equal((await importCard(a, b.text, { whitelist: true })).json().result, "added");
    const same = await importCard(a, b.text);
    assert.equal(same.json().result, "unchanged");
    assert.equal(same.json().contact.whitelisted, true);
    // A newer card (moved to a relay, renamed).
    await new Promise((r) => setTimeout(r, 1100));
    const newer = await makeCard(b.self, { name: "B 的服务器", addrs: [{ kind: "relay", url: "https://b.relay.example.org" }], note: "换了中转" });
    const nt = cardText(newer);
    const held = await importCard(a, nt);
    assert.equal(held.statusCode, 409);
    assert.equal(held.json().code, "contact_exists");
    assert.ok(held.json().details.some((d: string) => d.startsWith("name:")));
    assert.ok(held.json().details.some((d: string) => d.startsWith("addrs:")));
    assert.equal(a.ctx.access.contacts.get(b.card.id)!.name, "B");
    const up = await importCard(a, nt, { update: true });
    assert.equal(up.statusCode, 200, up.body);
    assert.equal(up.json().result, "updated");
    assert.deepEqual(up.json().changes.map((c: any) => c.field).sort(), ["addrs", "name", "note"]);
    // The whitelist stays as it was unless said; the key (and identity) never changes.
    assert.equal(up.json().contact.whitelisted, true);
    assert.equal(up.json().contact.id, b.card.id);
    const shown = (await call(a, C.contactShow, { params: { id: groupedId(b.card.id) } })).json();
    assert.equal(shown.contact.name, "B 的服务器");
    assert.equal(shown.text, nt);
    // The old card replayed (would take the address back): refused.
    const old = await importCard(a, b.text, { update: true });
    assert.equal(old.statusCode, 409);
    assert.equal(old.json().code, "card_older");
    assert.equal(a.ctx.access.contacts.get(b.card.id)!.addrs[0]!.kind, "relay");
    // Tokens keep working across the update (same key).
    assert.equal((await a.get("/api/sessions", await b.token(a.urn))).json().code, "a2a_only");
    assert.ok(audits(a).some((x) => x.action === "contact.update"));
  } finally {
    b.close();
    await a.close();
  }
});

// ── security review of P4-01 (M-1, M-2, L-1) ────────────────────────────

test("review M-1: look-alike labels and stray numbers in the people's lines cannot show a different identity number", async () => {
  const a = await daisy();
  const b = await other("B");
  const f = forger();
  try {
    const machine = b.text.split("\n").at(-1)!;
    const wrong = groupedId(f.id);
    const refused = async (head: string, why: string) => {
      const r = await importCard(a, `${head}\n${machine}`);
      assert.equal(r.statusCode, 400, `${why}: ${r.body}`);
      assert.equal(r.json().code, "card_invalid", why);
    };
    // Verified bypasses: a zero-width space before the label, ratio colon,
    // small colon, traditional characters — each showing another number.
    await refused(`​编号：${wrong}`, "U+200B before 编号");
    await refused(`编号∶${wrong}`, "U+2236 ratio");
    await refused(`编号﹕${wrong}`, "U+FE55 small colon");
    await refused(`編號：${wrong}`, "traditional 編號");
    await refused(`﻿名字：Mallory`, "BOM before 名字");
    await refused(`名稱：Mallory`, "名稱 for 名字");
    // Fullwidth letters fold to ASCII (NFKC) and are compared too.
    await refused(`编号：${wrong.toUpperCase().replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))}`, "fullwidth number");
    // Any 52-character base32 run that is not this card's id, whatever the label.
    await refused(`对方的号码是 ${wrong}`, "unlabelled number");
    await refused(`编码：${f.id}`, "another label");
    // This card's own number, however it is labelled or spaced, is fine.
    for (const head of [`​编号：${groupedId(b.card.id)}`, `編號：${b.card.id}`, `号码 ${groupedId(b.card.id).toUpperCase()}`]) {
      const r = await call(a, C.contactInspect, { body: { card: `${head}\n${machine}` } });
      assert.equal(r.statusCode, 200, `${head}: ${r.body}`);
    }
    assert.equal(a.ctx.access.contacts.list().length, 0);
  } finally {
    b.close();
    await a.close();
  }
});

test("review M-2: bidi and invisible characters are refused in a card; a token's act / sub with control or bidi characters is nobody's", async () => {
  const a = await daisy();
  const b = await other("B");
  const f = forger();
  try {
    for (const name of ["Bob‮evil​", "A‍b", "x⁦y⁩", "﻿Bob", "a؜b"]) {
      const r = await importCard(a, `daisy-card:1:${await f.sign(f.base({ name }))}`);
      assert.equal(r.statusCode, 400, JSON.stringify(name));
      assert.equal(r.json().code, "card_invalid", JSON.stringify(name));
    }
    for (const note of ["‪good", "ok⁠"]) {
      const r = await importCard(a, `daisy-card:1:${await f.sign(f.base({ note }))}`);
      assert.equal(r.json().code, "card_invalid", JSON.stringify(note));
    }
    // A contact's token whose act carries ESC / bidi: refused (401), and
    // nothing of it reaches the audit.
    await importCard(a, b.text);
    const pk = createPrivateKey({ key: JSON.parse(readFileSync(join(b.dir, "keys", "identity-key.json"), "utf8")), format: "jwk" });
    const now = Math.floor(Date.now() / 1000);
    const signed = (act: Record<string, unknown>) =>
      new SignJWT({ client_id: "a2a", scope: "daisy:invoke", jti: "j" + Math.random(), act })
        .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: b.self.kid })
        .setIssuer(b.self.urn)
        .setSubject(b.self.urn)
        .setAudience(a.urn)
        .setIssuedAt(now)
        .setExpirationTime(now + 120)
        .sign(pk);
    for (const act of [{ sub: "agent:\u001b[31mred" }, { sub: "agent:‮evil" }, { sub: "agent:ok", name: "研究​助手" }, { sub: "agent:\u0007" }]) {
      const t = await signed(act);
      assert.equal((await a.get("/api/sessions", t)).statusCode, 401, JSON.stringify(act));
      assert.equal(await a.ctx.access.guard.identify(t, "external"), null, JSON.stringify(act));
    }
    // A long but clean act.sub is kept, capped.
    const long = await a.ctx.access.guard.identify(await signed({ sub: "agent:" + "x".repeat(500) }), "external");
    assert.ok(long && long.actor!.length <= 200);
    for (const r of audits(a)) assert.ok(!/[\u001b‮\u0007]/.test(r.target + r.user_id));
    // The external issuer's tokens: the same rules, and capped too.
    assert.equal((await a.configure()).statusCode, 200);
    for (const extra of [{ act: { sub: "agent:\u001b]0;x" } }, { act: { sub: "a", name: "‮b" } }]) {
      const t = await a.tokenFor("user:other", extra);
      assert.equal(await a.ctx.access.guard.identify(t, "external"), null, JSON.stringify(extra));
    }
    assert.equal(await a.ctx.access.guard.identify(await a.tokenFor("user:‮other"), "external"), null);
    const p = await a.ctx.access.guard.identify(await a.tokenFor("user:" + "o".repeat(400), { act: { sub: "agent:" + "y".repeat(400) } }), "external");
    assert.ok(p && p.kind === "visitor");
    assert.ok(p.actor!.length <= 200 && p.subject!.length <= 200);
  } finally {
    b.close();
    await a.close();
  }
});

test("review L-1: a card made more than a day in the future is refused (it would lock out every later update)", async () => {
  const a = await daisy();
  const f = forger();
  try {
    const now = Math.floor(Date.now() / 1000);
    const far = await importCard(a, `daisy-card:1:${await f.sign(f.base({ iat: now + 2 * 86400 }))}`);
    assert.equal(far.statusCode, 400);
    assert.equal(far.json().code, "card_invalid");
    assert.match(far.json().error, /将来|时间/);
    // Within a day (clocks differ): fine.
    const near = await importCard(a, `daisy-card:1:${await f.sign(f.base({ iat: now + 3600 }))}`);
    assert.equal(near.statusCode, 200, near.body);
  } finally {
    await a.close();
  }
});

test("identity numbers: RFC 4648 base32, the three forms convert, lookups take any of them", async () => {
  // RFC 4648 §10 test vectors (lowercase, no padding).
  const enc = (s: string) => base32(new TextEncoder().encode(s));
  assert.deepEqual(["", "f", "fo", "foo", "foob", "fooba", "foobar"].map(enc), ["", "my", "mzxq", "mzxw6", "mzxw6yq", "mzxw6ytb", "mzxw6ytboi"]);
  assert.equal(Buffer.from(unbase32("MZXW6YTBOI")!).toString(), "foobar");
  assert.equal(unbase32("mzxw6ytboj"), null, "non-canonical trailing bits");
  assert.equal(unbase32("0abc"), null);
  const f = forger();
  const forms = formsOfKey(f.key);
  assert.equal(forms.id, f.id);
  assert.equal(forms.id.length, 52);
  for (const ref of [forms.id, forms.id.toUpperCase(), forms.id.replace(/(.{4})/g, "$1 "), forms.thumbprint, forms.urn])
    assert.equal(Buffer.from(keyRefBytes(ref)!).toString("base64url"), forms.thumbprint, ref);
  for (const bad of ["", "abc", forms.id.slice(1), forms.thumbprint + "A", "urn:x:" + forms.thumbprint]) assert.equal(keyRefBytes(bad), null, bad);
});

test("daisy contact: export prints the card's text; every command asks for the PIN in the terminal (the command line's reads too)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-contact-cli-"));
  const b = await other("B");
  const ctx = await createApp({
    pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    sharedHost: () => false,
    peerIsOwner: () => true,
  });
  try {
    ctx.pin.set("246810");
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (ctx.app.server.address() as any).port;
    ctx.access.faces.setLocal(port, "given");
    writeFileSync(
      runtimeFile(dir),
      JSON.stringify({
        pid: process.pid,
        release: null,
        startedAt: Date.now(),
        dataDir: dir,
        local: { url: `http://127.0.0.1:${port}`, port },
        external: null,
        cliCredential: join(dir, "keys", "cli-credential"),
      }),
      { mode: 0o600 },
    );
    // Export: the text itself, ready to copy (after the PIN: on the command
    // line the reads take it too — D-40 ①, its credential may be the AI).
    let io = testIo({ input: ["246810"] });
    let r = await cliRun(io, dir, "contact", "export", "--name", "主人");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Daisy 身份名片\n名字：主人\n编号：[a-z2-7 ]{64}\ndaisy-card:1:\S+$/);
    // Without the PIN on standard input: refused before any request — a read, a change.
    for (const args of [["contact", "list"], ["contact", "whitelist", "add", "abcdefgh"]]) {
      io = testIo();
      r = await cliRun(io, dir, ...args);
      assert.notEqual(r.code, 0, args.join(" "));
      assert.match(r.err, /PIN/, args.join(" "));
    }
    // Import B's card from its file (.daisycard), whitelisted.
    const cardFile = join(dir, "b.daisycard");
    writeFileSync(cardFile, b.text);
    io = testIo({ input: ["246810"] });
    // Review M-1: whose card it is — name, whole number, the hint — is shown
    // before the PIN is asked for.
    let beforePin = "";
    const ask = io.readSecret;
    io.readSecret = async (prompt) => {
      if (!beforePin) beforePin = io.stderr.join("\n");
      return ask(prompt);
    };
    r = await cliRun(io, dir, "contact", "import", "--card-file", cardFile, "--whitelist");
    assert.equal(r.code, 0, r.err);
    assert.match(beforePin, /名片：B/);
    assert.ok(beforePin.includes(`编号：${groupedId(b.card.id)}`), beforePin);
    assert.match(beforePin, /核对/);
    assert.ok(beforePin.includes(`--expect-id ${b.card.id.slice(0, 16)}`), beforePin);
    assert.equal(JSON.parse(r.out).result, "added");
    // A card that does not verify stops before the PIN (nothing read from input).
    io = testIo({ input: ["246810"] });
    r = await cliRun(io, dir, "contact", "import", b.text.replace("名字：B", "名字：Bob"));
    assert.notEqual(r.code, 0);
    assert.match(r.err, /“名字”一行/);
    assert.equal(await io.readSecret("x"), "246810", "PIN 没被读走");
    // Inspect, list, whitelist remove, remove (each asks for the PIN).
    io = testIo({ input: ["246810"] });
    r = await cliRun(io, dir, "contact", "inspect", b.text.split("\n").at(-1)!);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).card.id, b.card.id);
    io = testIo({ input: ["246810"] });
    r = await cliRun(io, dir, "contact", "list");
    assert.equal(JSON.parse(r.out).contacts[0].whitelisted, true);
    io = testIo({ input: ["246810"] });
    r = await cliRun(io, dir, "contact", "whitelist", "remove", b.card.id.slice(0, 12));
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).contact.whitelisted, false);
    io = testIo({ input: ["246810"] });
    r = await cliRun(io, dir, "contact", "remove", b.card.id);
    assert.equal(r.code, 0, r.err);
    io = testIo({ input: ["246810"] });
    r = await cliRun(io, dir, "contact", "show", b.card.id);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /通讯录里没有/);
    // A wrong PIN: nothing happens.
    io = testIo({ input: ["999999"] });
    r = await cliRun(io, dir, "contact", "import", b.text.split("\n").at(-1)!);
    assert.notEqual(r.code, 0);
    assert.equal(ctx.access.contacts.list().length, 0);
  } finally {
    await ctx.app.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
