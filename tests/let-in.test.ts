/**
 * P4-02 (5.11 「放别人进来」, D-11, 原则 1 / 6, T-8, T-9, ADR-121): every
 * operation that lets someone in needs `daisy:grant` and the PIN — on
 * every entry, the command line first — and resetting the PIN takes back
 * everything that let anyone in, leaving a record.
 *
 * Refusals first. T-8 tries each kind of operation once: the ones built
 * (the outside face, its one-time code, the passcode, the external issuer,
 * the external interface origins) through their real routes; the ones
 * phase 4 / 5 will add (contacts, invocation requests, grants and the
 * allowlist, public / resident agents and who may call them, devices,
 * the relay, tokens for third-party clients) through probe routes defined
 * the way those packages will define theirs — only `letsIn` — to show the
 * table, the server and the guard force them to daisy:grant + PIN.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { createApp } from "../packages/daisy/src/app.ts";
import { serve } from "../packages/daisy/src/app/serve.ts";
import {
  API_ROUTES,
  LET_IN,
  LET_IN_KINDS,
  REVOCATION_KINDS,
  fillPath,
  letsSomeoneIn,
  type AnyRoute,
  type LetInKind,
} from "../packages/contracts/src/index.ts";
import { exempt, group, json, pinFor, route, websocket } from "../packages/contracts/src/api/route.ts";
import { PROBES, probes, serveProbes } from "./fixtures/let-in-probes.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { OWNER_SCOPES } from "../packages/daisy/src/access/guard.ts";
import { fakeIssuer } from "./fixtures/fake-issuer.ts";
import { pinDouble } from "./fixtures/pin-double.ts";
import { ExternalIssuer } from "../packages/daisy/src/access/tokens/external-issuer.ts";
import { Revocations } from "../packages/daisy/src/access/revocations.ts";
import { commitLetIn, sealLetIn } from "../packages/daisy/src/access/let-in-commit.ts";
import { translator as zhTranslator } from "../packages/contracts/src/i18n.ts";
import { shippedPacks as zhPacks } from "../packages/contracts/src/i18n-node.ts";
import { exemptText, routeText } from "../packages/contracts/src/api/route.ts";
/** P6-23a: the route table's text is in the packs; these assertions read the Chinese. */
const zh = zhTranslator(zhPacks(), "zh-CN");

const PIN = "862413";
const OWNER_SUB = "user:owner";
const issuerHolder = (token: string) => `issuer:${createHash("sha256").update(token).digest("hex")}`;

/**
 * 5.11's 「要」 rows (and the three of D-31 / D-09 / D-38) → the routes
 * that do it today. A package that adds a route of a kind adds it here
 * (and drops the kind from PENDING_ROUTES).
 */
const ROUTES_OF: Record<LetInKind, string[]> = {
  // P4-03 (ADR-122): deciding a call card, revoking a grant, the range.
  "invoke-request": ["grant.requestDecide"],
  // P4-05 (ADR-124): 设置是否允许办; P4-06 (ADR-125): 把会话设为公开.
  // P4-07 (ADR-126): 创建、修改常驻 agent; resuming one lets callers in again.
  "agent-exposure": ["grant.actSet", "grant.publicSet", "grant.residentCreate", "grant.residentSet", "grant.residentResume"],
  "agent-audience": ["grant.audienceSet"],
  "invoke-grant": ["grant.grantRevoke"],
  // D-40 ①: reading (export, inspect, list, show) is not letting in.
  contact: [
    "grant.contactImport",
    "grant.contactRemove",
    "grant.contactWhitelistAdd",
    "grant.contactWhitelistRemove",
  ],
  // P5-03 (ADR-142): daisy pair, revoking a device.
  device: ["settings.pair", "settings.deviceRevoke"],
  issuer: ["settings.issuerSet"],
  // P5-02 (ADR-144): choosing a relay.
  relay: ["settings.relaySet"],
  // P4-12 (ADR-132): daisy token issue / revoke.
  "visitor-token": ["grant.tokenIssue", "grant.tokenRevoke"],
  face: ["settings.openCodeExternal", "settings.externalOn", "settings.passcode"],
  "ui-origin": ["settings.uiOriginsSet"],
};

// ── the table ──────────────────────────────────────────────────────────

test("5.11: every 「要」 row has a kind; each route of a kind is daisy:grant + PIN, never the AI; nothing that lets anyone in is undeclared", () => {
  // Every kind is accounted for: built (its routes), or still to come.
  assert.deepEqual(Object.keys(ROUTES_OF).sort(), [...LET_IN_KINDS].sort());
  for (const kind of LET_IN_KINDS) {
    const ids = API_ROUTES.filter((r) => r.letsIn === kind).map((r) => r.id).sort();
    assert.deepEqual(ids, [...ROUTES_OF[kind]].sort(), `${kind}（${zh.dynamic(`api.letIn.${kind}`)}）`);
  }
  for (const r of [...API_ROUTES, ...PROBES]) {
    if (!r.letsIn) continue;
    assert.equal(r.scope, "daisy:grant", `${r.id}: scope`);
    assert.equal(r.pin, true, `${r.id}: PIN`);
    assert.equal(r.aiSelf, undefined, `${r.id}: aiSelf`);
    assert.ok(!r.channels.includes("ai"), `${r.id}: AI`);
    // 5.11: 主人本人 ✓ 命令行 ✓ — and the PIN on both.
    for (const c of ["web", "device", "cli"] as const)
      assert.ok(r.channels.includes(c), `${r.id}: ${c}`);
  }
  // Nothing in the table lets anyone in without saying which kind.
  for (const r of API_ROUTES)
    if (letsSomeoneIn(r)) assert.ok(r.letsIn, `${r.id}: 放别人进来却没写 letsIn`);
  // A daisy:grant change goes with the PIN, except those that say why
  // (the PIN's own two routes, narrowing, a read-only inspect — shown in
  // the docs).
  for (const r of API_ROUTES)
    if (r.scope === "daisy:grant" && !r.pin && r.method !== "GET")
      assert.ok(r.notLetIn && (routeText(r.id, "notLetIn", zh) ?? "").length >= 6, `${r.id}: grant 没要 PIN，也没写理由`);
  // D-40 ① (phase-4 gate): reading lets nobody in — no GET of the table
  // declares a kind; a GET that wants the PIN wants it on the command line
  // only (PIN_ON_CLI); the 「调用授权」 reads keep daisy:grant, stay off the
  // AI's channel and take the PIN on the command line.
  for (const r of API_ROUTES) {
    if (r.method !== "GET" || r.output.kind === "websocket") continue;
    assert.equal(r.letsIn, undefined, `${r.id}: 只读的接口不写 letsIn`);
    if (r.pin) assert.deepEqual(r.pinOn, ["cli"], `${r.id}: 只读的接口只在命令行要 PIN（D-40）`);
    if (r.group === "grant") {
      assert.equal(r.scope, "daisy:grant", `${r.id}: 调用授权组的读仍要 daisy:grant`);
      assert.ok(!r.channels.includes("ai"), `${r.id}: AI 读不到`);
      assert.ok(pinFor(r, "cli") && !pinFor(r, "web") && !pinFor(r, "issuer") && !pinFor(r, "device"), `${r.id}: 网页等不要 PIN，命令行要`);
    }
  }
  // pinOn is for reads: anything that lets someone in takes the PIN everywhere.
  for (const r of API_ROUTES) if (r.letsIn) assert.equal(r.pinOn, undefined, r.id);
  assert.equal(letsSomeoneIn(API_ROUTES.find((r) => r.id === "grant.contactInspect")!), false);
  assert.match(routeText("grant.contactInspect", "notLetIn", zh)!, /^只读/);
  assert.deepEqual(API_ROUTES.find((r) => r.id === "grant.contactInspect")!.pinOn, ["cli"]);
  // Review M-2: every change in the settings and 「调用授权」 groups says
  // what it is; the routes that say "not letting anyone in" are pinned
  // here (a new one is a reviewed change of this list).
  for (const r of API_ROUTES)
    if (["settings", "grant"].includes(r.group) && r.method !== "GET")
      assert.ok(r.letsIn || r.notLetIn, `${r.id}: 设置 / 调用授权组的改动要写 letsIn 或 notLetIn`);
  assert.deepEqual(
    API_ROUTES.filter((r) => r.notLetIn).map((r) => r.id).sort(),
    [
      // D-40 ①: inspecting a card only parses the text it is given.
      "grant.contactInspect",
      // P4-07 (ADR-126 §6): pausing, closing, deleting a resident only take away.
      "grant.residentClose",
      "grant.residentDelete",
      "grant.residentPause",
      "session.aiToken",
      "settings.autostartSet",
      // P5-03 (ADR-142): a device trading its pairing code / credential (the
      // code is made with the PIN), a device unpairing itself (narrowing).
      "settings.deviceForget",
      "settings.deviceSession",
      "settings.externalOff",
      "settings.issuerRefresh",
      "settings.issuerRemove",
      // P6-20 (ADR-159 §2): the display language lets nobody in.
      "settings.languageSet",
      "settings.layersApplyCancel",
      "settings.layersApplyNow",
      "settings.layersForgetNode",
      "settings.layersSet",
      "settings.mineSet",
      "settings.notificationsCheck",
      "settings.notificationsMirror",
      "settings.notificationsPatch",
      "settings.notificationsRelease",
      "settings.notificationsSet",
      "settings.openCode",
      "settings.pairRedeem",
      "settings.pinGrant",
      "settings.pinReset",
      "settings.pinSet",
      // P5-02 (ADR-144): turning the relay off only narrows — and still takes the PIN (5.10).
      "settings.relayOff",
      "settings.uiOriginsClear",
      "settings.updateApply",
      "settings.updateCancel",
      "settings.updateCheck",
      "settings.updateRestart",
      "settings.updateSourceSet",
      "settings.webLogout",
      "settings.webSession",
    ],
  );
  // scopes.md §2: the 「调用授权」 group is daisy:grant throughout.
  for (const r of API_ROUTES)
    if (r.group === "grant") assert.equal(r.scope, "daisy:grant", r.id);
  // Every kind's revocation exists (let-in.ts ↔ the registry).
  for (const k of LET_IN_KINDS) {
    const back = LET_IN[k].revokes;
    if (back) assert.ok(REVOCATION_KINDS.includes(back), `${k}: ${back}`);
  }
});

test("a route at a 「放别人进来」 place cannot be defined, served or reached without daisy:grant + PIN", async () => {
  const out = { output: json<{ ok: true }>("{ ok: true }"), cli: exempt() };
  const bad: [string, () => unknown, RegExp][] = [
    // Undeclared, at each place kept for a kind still to come.
    ["POST /api/contacts", () => group("settings", { x: route({ method: "POST", path: "/api/contacts", scope: "daisy:manage", ...out }) }), /set letsIn/],
    ["DELETE /api/devices/:id", () => group("settings", { x: route({ method: "DELETE", path: "/api/devices/:id", scope: "daisy:manage", ...out }) }), /set letsIn/],
    ["PUT /api/relay", () => group("settings", { x: route({ method: "PUT", path: "/api/relay", scope: "daisy:grant", pin: true, ...out }) }), /set letsIn/],
    ["POST /api/tokens", () => group("settings", { x: route({ method: "POST", path: "/api/tokens", scope: "daisy:grant", pin: true, ...out }) }), /set letsIn/],
    ["PUT /api/sessions/:id/visibility", () => group("session", { x: route({ method: "PUT", path: "/api/sessions/:id/visibility", scope: "daisy:session:write", ...out }) }), /set letsIn/],
    // Anything that changes something in the 「调用授权」 group.
    ["the grant group", () => group("grant", { x: route({ method: "POST", path: "/api/whatever", scope: "daisy:grant", pin: true, ...out }) }), /set letsIn/],
    // A daisy:grant change anywhere that says neither.
    ["daisy:grant elsewhere", () => group("settings", { x: route({ method: "POST", path: "/api/somewhere", scope: "daisy:grant", pin: true, ...out }) }), /set letsIn/],
    // Declared, but with the wrong scope, without the PIN, open to the AI, at another kind's place.
    ["wrong scope", () => group("grant", { x: route({ method: "POST", path: "/api/contacts", scope: "daisy:manage", letsIn: "contact", ...out }) }), /must have scope daisy:grant/],
    ["no PIN", () => group("grant", { x: route({ method: "POST", path: "/api/contacts", scope: "daisy:grant", pin: false, letsIn: "contact", ...out }) }), /must need the PIN/],
    ["the AI", () => group("session", { x: route({ method: "PUT", path: "/api/sessions/:id/public", scope: "daisy:grant", aiSelf: "id", letsIn: "agent-exposure", ...out }) }), /cannot be open to the AI/],
    ["another kind's place", () => group("grant", { x: route({ method: "POST", path: "/api/relay", scope: "daisy:grant", letsIn: "contact", ...out }) }), /is kept for relay/],
    // Paths the first rules missed (paths of earlier designs, other
    // spellings) — undeclared, in a group with no rule of its own.
    ...([
      ["POST", "/api/residents"],
      ["PATCH", "/api/sessions/:id/resident"],
      ["PUT", "/api/sessions/:id/resident/prompt"],
      ["POST", "/api/invoke-approvals/:aid/respond"],
      ["PUT", "/api/communication/allowlist"],
      ["PUT", "/api/communication/sessions/:sid/access"],
      ["POST", "/api/contact"],
      ["POST", "/api/cards/import"],
      ["POST", "/api/settings/contacts"],
      ["POST", "/api/pairing-codes"],
      ["POST", "/api/pair-code"],
      ["PUT", "/api/relay-config"],
      ["POST", "/api/a2a/tokens"],
      ["PUT", "/api/sessions/:id/share"],
      ["PUT", "/api/sessions/:id(^[a-z0-9-]+$)/public"],
      ["POST", "/api/Contacts"],
    ] as const).map(([method, path]): [string, () => unknown, RegExp] => [
      `${method} ${path}`,
      () => group("system", { x: route({ method, path, scope: "daisy:manage", ...out }) }),
      /set letsIn/,
    ]),
    // Any change in the settings group says what it is.
    ["the settings group", () => group("settings", { x: route({ method: "PUT", path: "/api/theme", scope: "daisy:manage", ...out }) }), /set letsIn/],
    // Review L-3: a socket is a GET, but at a kept place it still says what it is.
    ["a socket at a kept place", () => group("system", { x: route({ method: "GET", path: "/api/contacts/live", scope: "daisy:manage", output: websocket("x"), cli: exempt() }) }), /set letsIn/],
    // D-40 ①: a read never declares a kind (it would force the PIN on it).
    ["a GET with letsIn", () => group("grant", { x: route({ method: "GET", path: "/api/contacts", scope: "daisy:grant", letsIn: "contact", ...out }) }), /a read \(GET\) lets nobody in: no letsIn/],
    // pinOn never narrows the PIN of a route that lets someone in, and goes with pin: true.
    ["letsIn with pinOn", () => group("grant", { x: route({ method: "POST", path: "/api/contacts", scope: "daisy:grant", letsIn: "contact", pinOn: ["cli"], ...out }) }), /no pinOn/],
    ["pinOn without pin", () => group("grant", { x: route({ method: "GET", path: "/api/contacts", scope: "daisy:grant", pinOn: ["cli"], ...out }) }), /pinOn goes with pin: true/],
  ];
  assert.equal(bad.length, 32);
  for (const [what, fn, msg] of bad) assert.throws(fn, msg, what);
  // …and a socket there that says it lets nobody in is fine.
  group("system", { x: route({ method: "GET", path: "/api/contacts/live", scope: "daisy:manage", notLetIn: true, output: websocket("x"), cli: exempt() }) });
  // A GET (reading the list) is not letting anyone in (D-40 ①: no PIN either).
  group("grant", { x: route({ method: "GET", path: "/api/contacts", scope: "daisy:grant", ...out }) });
  // A read-only change at a kept place says so (inspecting a card, D-40 ①).
  group("grant", { x: route({ method: "POST", path: "/api/contacts/inspect", scope: "daisy:grant", notLetIn: true, ...out }) });
  // The table puts the PIN on (the probes never wrote `pin`).
  for (const p of PROBES) assert.equal(p.pin, true, p.id);

  // The server refuses to register a definition built by hand that breaks
  // the rule (one not made by `group`).
  const app = Fastify();
  const hand = (over: Partial<AnyRoute>): AnyRoute =>
    ({ ...probes.allowlistAdd, id: "grant.hand", ...over }) as AnyRoute;
  assert.throws(() => serve(app, hand({ pin: false }), async () => ({})), /must want the PIN/);
  assert.throws(() => serve(app, hand({ scope: "daisy:manage" }), async () => ({})), /daisy:grant/);
  assert.throws(() => serve(app, hand({ channels: ["web", "cli", "ai"] }), async () => ({})), /must not be open to the AI/);
  assert.throws(
    () => serve(app, hand({ letsIn: undefined, scope: "daisy:manage", pin: false }), async () => ({})),
    /set letsIn/,
  );
  await app.close();

  // And should one get past both (registered bare), the guard still asks
  // for daisy:grant and the PIN.
  const dir = mkdtempSync(join(tmpdir(), "daisy-letin-guard-"));
  const iss = await fakeIssuer();
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, workspaceRoots: [dir], sharedHost: () => false, peerIsOwner: () => true });
  try {
    const sneaky = { ...probes.allowlistAdd, id: "grant.sneaky", path: "/api/contacts/import", letsIn: undefined, scope: "daisy:manage", pin: false } as AnyRoute;
    ctx.app.route({ method: "POST", url: sneaky.path, config: { api: sneaky }, handler: async () => ({ ok: true }) } as any);
    const cli = { authorization: `Bearer ${readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim()}` };
    const web = { authorization: `Bearer ${ctx.issueToken()}` };
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/pin", headers: web, payload: { pin: PIN } })).statusCode, 200);
    for (const h of [cli, web]) {
      const r = await ctx.app.inject({ method: "POST", url: sneaky.path, headers: h, payload: {} });
      assert.equal(r.statusCode, 403);
      assert.equal(r.json().code, "pin_required");
    }
    // The issuer's token for the owner without daisy:grant, with a grant bound to it.
    const grant = (await ctx.app.inject({ method: "POST", url: "/api/pin/grant", headers: web, payload: { pin: PIN } })).json().grant;
    assert.equal((await ctx.app.inject({ method: "PUT", url: "/api/access/issuer", headers: { ...web, [PIN_GRANT_HEADER]: grant }, payload: { issuer: iss.issuer, ownerSubject: OWNER_SUB } })).statusCode, 200);
    const noGrant = await iss.sign({ sub: OWNER_SUB, aud: ctx.access.ai.urn, scope: "daisy:session:read daisy:manage" });
    const g = ctx.pin.grant(PIN, issuerHolder(noGrant)).grant;
    const r = await ctx.app.inject({ method: "POST", url: sneaky.path, headers: { authorization: `Bearer ${noGrant}`, [PIN_GRANT_HEADER]: g }, payload: {} });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().code, "insufficient_scope");
    assert.match(String(r.headers["www-authenticate"]), /scope="daisy:grant"/);
    // With both: through.
    const ok = await ctx.app.inject({ method: "POST", url: sneaky.path, headers: { ...web, [PIN_GRANT_HEADER]: grant }, payload: {} });
    assert.equal(ok.statusCode, 200, ok.body);
  } finally {
    await ctx.app.close();
    await iss.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── T-8 ────────────────────────────────────────────────────────────────

/** A request body that gets each built route past its own checks (or into them: past the guard either way). */
function payloadOf(r: AnyRoute, issuer: string): unknown {
  switch (r.id) {
    case "settings.issuerSet":
      return { issuer, ownerSubject: OWNER_SUB };
    case "settings.passcode":
      return { mode: "on" };
    case "settings.uiOriginsSet":
      return { origins: ["https://ui.example"] };
    case "settings.externalOn":
      // Past the guard into the handler's own check (no listener is opened).
      return { host: "" };
    case "settings.relaySet":
      // P5-02: past the guard into the handler's own check (nothing connects).
      return { url: "https://127.0.0.1", acme: false };
    case "grant.tokenIssue":
      // P4-12: a token for the owner as a visitor (no contact needed).
      return { for: "me" };
    default:
      return r.method === "GET" || r.method === "DELETE" ? undefined : {};
  }
}
/** The codes only the guard answers with. */
const GUARD = new Set(["unauthenticated", "channel_not_allowed", "not_own_session", "insufficient_scope", "pin_required", "pin_unavailable", "a2a_only"]);
const passedGuard = (res: { statusCode: number; json(): any }) => {
  let code: string | undefined;
  try {
    code = res.json()?.code;
  } catch {}
  return !([401, 403].includes(res.statusCode) && GUARD.has(code ?? ""));
};

test("T-8: each 「放别人进来」 operation — refused without the PIN (command line and web), without daisy:grant, with a wrong PIN (counted, then locked); allowed with both", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-t8-"));
  const iss = await fakeIssuer();
  // The real PinService (createApp's own): scrypt, counting, the lock.
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, workspaceRoots: [dir], sharedHost: () => false, peerIsOwner: () => true });
  serveProbes(ctx.app);
  try {
    const cli = { authorization: `Bearer ${readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim()}` };
    const web = { authorization: `Bearer ${ctx.issueToken()}` };
    const inject = (r: AnyRoute, headers: Record<string, string>, grant?: string) =>
      ctx.app.inject({
        method: r.method,
        url: fillPath(r.path, Object.fromEntries(Object.keys(r.params.shape).map((k) => [k, `x-${k}`]))),
        headers: { ...headers, ...(grant ? { [PIN_GRANT_HEADER]: grant } : {}) },
        ...(payloadOf(r, iss.issuer) === undefined ? {} : { payload: payloadOf(r, iss.issuer) as any }),
      });
    const enter = (headers: Record<string, string>, pin: string) =>
      ctx.app.inject({ method: "POST", url: "/api/pin/grant", headers, payload: { pin } });
    const failures = () => ctx.store.one("SELECT failures FROM pin WHERE id=1").failures as number;

    // No PIN set yet: a grant cannot be had, so nothing gets through.
    assert.equal((await enter(cli, PIN)).json().code, "pin_not_set");
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/pin", headers: cli, payload: { pin: PIN } })).statusCode, 200);
    // The external issuer (so its token for the owner can come without daisy:grant).
    const wg = (await enter(web, PIN)).json().grant;
    const conf = await ctx.app.inject({ method: "PUT", url: "/api/access/issuer", headers: { ...web, [PIN_GRANT_HEADER]: wg }, payload: { issuer: iss.issuer, ownerSubject: OWNER_SUB } });
    assert.equal(conf.statusCode, 200, conf.body);
    const urn = ctx.access.ai.urn;
    const noGrantScope = await iss.sign({
      sub: OWNER_SUB,
      aud: urn,
      scope: OWNER_SCOPES.filter((s) => s !== "daisy:grant").join(" "),
    });
    // A grant bound to that token — one it could never buy itself (the
    // grant route is daisy:grant too): the scope is checked on its own.
    const noScopeGrant = ctx.pin.grant(PIN, issuerHolder(noGrantScope)).grant;
    assert.equal((await enter({ authorization: `Bearer ${noGrantScope}` }, PIN)).json().code, "insufficient_scope");

    const ops: AnyRoute[] = [
      ...API_ROUTES.filter((r) => r.letsIn),
      ...PROBES,
    ];
    // Each kind is tried at least once.
    assert.deepEqual([...new Set(ops.map((r) => r.letsIn!))].sort(), [...LET_IN_KINDS].sort());
    const tried: string[] = [];
    for (const op of ops) {
      const what = `${op.id}（${zh.dynamic(`api.letIn.${op.letsIn!}`)}）`;
      // 1. No PIN: the command line's credential, the web page's.
      for (const h of [cli, web]) {
        const r = await inject(op, h);
        assert.equal(r.statusCode, 403, `${what}: 没带 PIN 授权`);
        assert.equal(r.json().code, "pin_required", what);
      }
      // 2. No daisy:grant (a live PIN grant bound to that very token).
      const ns = await inject(op, { authorization: `Bearer ${noGrantScope}` }, noScopeGrant);
      assert.equal(ns.statusCode, 403, `${what}: 没有 daisy:grant`);
      assert.equal(ns.json().code, "insufficient_scope", what);
      assert.match(String(ns.headers["www-authenticate"]), /scope="daisy:grant"/, what);
      // 3. A wrong PIN: refused and counted; a made-up grant gets nowhere.
      const before = failures();
      const w = await enter(cli, "000000");
      assert.equal(w.statusCode, 403, what);
      assert.equal(w.json().code, "pin_wrong", what);
      assert.equal(failures(), before + 1, `${what}: 输错计数`);
      const forged = await inject(op, cli, "A".repeat(43));
      assert.equal(forged.json().code, "pin_required", `${what}: 伪造的授权`);
      // The web page's grant is not the command line's (bound to its holder).
      const other = await inject(op, cli, wg);
      assert.equal(other.json().code, "pin_required", `${what}: 别的凭据的授权`);
      // 4. The right PIN: the count clears, the operation goes through —
      // once: the command line's grant is used up by it.
      const g = (await enter(cli, PIN)).json().grant;
      assert.equal(failures(), 0, what);
      const ok = await inject(op, cli, g);
      assert.ok(passedGuard(ok), `${what}: PIN 和 daisy:grant 都有却被拒绝：${ok.statusCode} ${ok.body}`);
      if (PROBES.includes(op)) assert.equal(ok.statusCode, 200, what);
      if (["settings.passcode", "settings.uiOriginsSet", "settings.issuerSet"].includes(op.id))
        assert.equal(ok.statusCode, 200, `${what}: ${ok.body}`);
      const again = await inject(op, cli, g);
      assert.equal(again.json().code, "pin_required", `${what}: 命令行的授权只能用一次`);
      tried.push(op.id);
    }
    assert.equal(tried.length, ops.length);

    // The lock: the 5th wrong PIN in a row locks entry — the right one too
    // — and nothing that lets anyone in can be done meanwhile.
    const op = probes.allowlistAdd;
    for (let i = 1; i <= 4; i++) {
      const w = await enter(cli, "111111");
      assert.equal(w.json().code, "pin_wrong");
      assert.equal(failures(), i);
    }
    const locked = await enter(cli, "111111");
    assert.equal(locked.statusCode, 423);
    assert.equal(locked.json().code, "pin_locked");
    assert.equal((await enter(cli, PIN)).statusCode, 423, "锁定期间输对也不行");
    assert.equal((await enter(web, PIN)).statusCode, 423, "锁定对所有入口都有效");
    assert.equal((await inject(op, cli)).json().code, "pin_required");
    assert.ok(ctx.pin.status().lockedUntil! > Date.now());
    // The audit has the wrong entries and the lock — never a PIN or a grant.
    const audit = JSON.stringify(ctx.store.all("SELECT * FROM audit"));
    assert.ok(audit.includes("pin.grant.wrong") && audit.includes("pin.locked"));
    for (const s of [PIN, wg, noScopeGrant]) assert.ok(!audit.includes(s));
    // As after 15 minutes: open again.
    ctx.store.run("UPDATE pin SET locked_until=0 WHERE id=1");
    const g = (await enter(cli, PIN)).json().grant;
    assert.equal((await inject(op, cli, g)).statusCode, 200);
    console.log(`  T-8：${ops.length} 种操作（${LET_IN_KINDS.length} 类）× 无 PIN / 无 daisy:grant / 错 PIN / 都有`);
  } finally {
    await ctx.app.close();
    await iss.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── T-9 ────────────────────────────────────────────────────────────────

/** The kinds whose store does not exist yet — the package that builds one registers its hook and removes it here. */
const PENDING_REVOCATIONS: string[] = [];

test("T-9: resetting the PIN takes back the issuer, the interface origins, the AI's tokens and every store's grants (the hooks of P4-01 / P4-03 / P5-03 / daisy token), and leaves a record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-t9-"));
  const iss = await fakeIssuer();
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, workspaceRoots: [dir], sharedHost: () => false, peerIsOwner: () => true });
  try {
    const cli = { authorization: `Bearer ${readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim()}` };
    const web = { authorization: `Bearer ${ctx.issueToken()}` };
    // The stores phase 4 / 5 will add, as their packages will hook them in:
    // in the database (inside the reset's transaction).
    ctx.store.db.exec("CREATE TABLE t9_contacts(id TEXT); CREATE TABLE t9_grants(id TEXT); CREATE TABLE t9_devices(id TEXT); CREATE TABLE t9_tokens(id TEXT)");
    const tables = { contacts: "t9_contacts", "invoke-grants": "t9_grants", devices: "t9_devices", "visitor-tokens": "t9_tokens" } as const;
    for (const [kind, t] of Object.entries(tables)) {
      ctx.store.run(`INSERT INTO ${t}(id) VALUES('a'),('b')`);
      ctx.access.revocations.register(kind as keyof typeof tables, `test: ${t}`, () => Number(ctx.store.run(`DELETE FROM ${t}`).changes));
    }
    const rows = (t: string) => ctx.store.one(`SELECT COUNT(*) n FROM ${t}`).n;
    assert.deepEqual(ctx.access.revocations.registered().sort(), [...REVOCATION_KINDS].sort());

    // What lets others in today: the PIN and a grant, the external issuer
    // with its owner token, an allowed interface origin, a token fetched
    // for an AI.
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/pin", headers: web, payload: { pin: PIN } })).statusCode, 200);
    const wg = (await ctx.app.inject({ method: "POST", url: "/api/pin/grant", headers: web, payload: { pin: PIN } })).json().grant;
    const urn = ctx.access.ai.urn;
    const put = (url: string, payload: unknown) =>
      ctx.app.inject({ method: "PUT", url, headers: { ...web, [PIN_GRANT_HEADER]: wg }, payload: payload as any });
    const conf = await put("/api/access/issuer", { issuer: iss.issuer, ownerSubject: OWNER_SUB, ownerToken: await iss.sign({ sub: OWNER_SUB, aud: urn }) });
    assert.equal(conf.statusCode, 200, conf.body);
    // P2-02: a token exchanged at the issuer for an AI (the owner registered this Daisy as a client there).
    iss.state.clients.set(conf.json().issuer.clientId, conf.json().self.jwk);
    const aiToken = await ctx.access.delegated.get("s-t9", "urn:example:elsewhere", "daisy:session:read");
    assert.equal(ctx.access.delegated.size, 1);
    assert.equal((await put("/api/access/ui-origins", { origins: ["https://ui.example", "https://ui2.example"] })).statusCode, 200);
    const owner = await iss.sign({ sub: OWNER_SUB, aud: urn });
    assert.equal((await ctx.app.inject({ url: "/api/me", headers: { authorization: `Bearer ${owner}` } })).statusCode, 200);

    // A database hook that refuses undoes the reset: the PIN, its grants,
    // every store and the outside ones (they run last) are untouched.
    let refuse = true;
    ctx.access.revocations.register("contacts", "test: refuses once", () => {
      if (refuse) throw new Error("disk full");
      return 0;
    });
    const failed = await ctx.app.inject({ method: "POST", url: "/api/pin/reset", headers: cli, payload: { confirm: true } });
    assert.equal(failed.statusCode, 500);
    assert.ok(ctx.pin.status().set);
    assert.ok(ctx.pin.check(wg, `web:${createHash("sha256").update(web.authorization.slice(7)).digest("hex")}`));
    for (const t of Object.values(tables)) assert.equal(rows(t), 2, t);
    assert.ok(ctx.access.issuer.get());
    assert.equal(ctx.access.uiOrigins.get().length, 2);
    assert.equal(ctx.access.delegated.size, 1);
    refuse = false;

    // Not from the web page, nor with the PIN: the command line on this machine only.
    const fromWeb = await ctx.app.inject({ method: "POST", url: "/api/pin/reset", headers: { ...web, [PIN_GRANT_HEADER]: wg }, payload: { confirm: true } });
    assert.equal(fromWeb.json().code, "channel_not_allowed");

    const reset = await ctx.app.inject({ method: "POST", url: "/api/pin/reset", headers: cli, payload: { confirm: true } });
    assert.equal(reset.statusCode, 200, reset.body);
    // Everything that let anyone in is gone.
    assert.equal(ctx.pin.status().set, false);
    assert.equal(ctx.store.one("SELECT COUNT(*) n FROM pin_grants").n, 0);
    for (const t of Object.values(tables)) assert.equal(rows(t), 0, t);
    assert.equal(ctx.access.issuer.get(), null);
    assert.equal(existsSync(join(dir, "keys", "issuer-owner-token")), false);
    assert.deepEqual(ctx.access.uiOrigins.get(), []);
    assert.equal(ctx.access.delegated.size, 0);
    // … and does not work any more.
    assert.equal((await ctx.app.inject({ url: "/api/me", headers: { authorization: `Bearer ${owner}` } })).statusCode, 401);
    const old = await put("/api/access/passcode", { mode: "off" });
    assert.equal(old.json().code, "pin_required", "旧的 PIN 授权失效");
    const again = await ctx.access.delegated.get("s-t9", "urn:example:elsewhere", "daisy:session:read");
    assert.notEqual(again.token, aiToken.token, "AI 的令牌不再被交出去");

    // The record: the reset, and what it took back (per kind, how many).
    const rec = ctx.store.all("SELECT a.action,a.target,c.actor,c.channel FROM audit a JOIN audit_context c ON c.audit_id=a.id WHERE a.action LIKE 'pin.reset%' ORDER BY a.created");
    assert.deepEqual(rec.map((r) => r.action).sort(), ["pin.reset", "pin.reset.revoke"]);
    const revoke = rec.find((r) => r.action === "pin.reset.revoke")!;
    assert.equal(revoke.actor, "cli");
    assert.equal(revoke.channel, "cli");
    const summary = JSON.parse(revoke.target);
    assert.deepEqual(summary.pending, []);
    assert.deepEqual(summary.revoked, {
      issuer: 1,
      "ui-origins": 2,
      "ai-tokens": 1,
      "invoke-grants": 2,
      contacts: 2,
      devices: 2,
      "visitor-tokens": 2,
      "external-face": 0,
    });
    const audit = JSON.stringify(ctx.store.all("SELECT * FROM audit"));
    for (const s of [PIN, wg, owner, aiToken.token]) assert.ok(!audit.includes(s), "a secret in the audit");
    // D-36: the owner is told when and through which entry.
    assert.equal(ctx.pin.status().resetVia, "cli");
  } finally {
    await ctx.app.close();
    await iss.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-9: what is not built yet is recorded as pending — and once a kind's routes exist, its store must take part in the reset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-t9b-"));
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, workspaceRoots: [dir], sharedHost: () => false, peerIsOwner: () => true });
  try {
    const registered = ctx.access.revocations.registered();
    // A kind whose routes exist (let people in) must have its hook — so a
    // package that adds contacts / grants / devices / tokens cannot forget
    // to have the reset take them back.
    for (const r of API_ROUTES) {
      const back = r.letsIn && LET_IN[r.letsIn].revokes;
      if (back) assert.ok(registered.includes(back), `${r.id}（${r.letsIn}）: 重置 PIN 时没人吊销 ${back}`);
    }
    // Built today: the issuer, the interface origins, the AI's tokens, the contacts (P4-01), the invoke grants (P4-03).
    assert.deepEqual(
      REVOCATION_KINDS.filter((k) => !registered.includes(k)).sort(),
      PENDING_REVOCATIONS,
      "P4-01 / P4-03 / P5-03 / daisy token：注册了吊销钩子就把种类从 PENDING_REVOCATIONS 里去掉",
    );
    const cli = { authorization: `Bearer ${readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim()}` };
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/pin", headers: cli, payload: { pin: PIN } })).statusCode, 200);
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/pin/reset", headers: cli, payload: { confirm: true } })).statusCode, 200);
    const row = ctx.store.one("SELECT target FROM audit WHERE action='pin.reset.revoke'");
    const summary = JSON.parse(row.target);
    assert.deepEqual([...summary.pending].sort(), PENDING_REVOCATIONS);
    assert.deepEqual(summary.revoked, { issuer: 0, "ui-origins": 0, "ai-tokens": 0, "external-face": 0, "invoke-grants": 0, contacts: 0, "visitor-tokens": 0, devices: 0 });
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the security review of P4-02 ───────────────────────────────────────

const daisyApp = async (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, workspaceRoots: [dir], sharedHost: () => false, peerIsOwner: () => true });
  const cli = { authorization: `Bearer ${readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim()}` };
  const web = { authorization: `Bearer ${ctx.issueToken()}` };
  const call = (method: any, url: string, headers: Record<string, string>, payload?: unknown) =>
    ctx.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as any }) });
  const grant = async (h: Record<string, string>) => (await call("POST", "/api/pin/grant", h, { pin: PIN })).json().grant as string;
  return { dir, ctx, cli, web, call, grant, done: async () => { await ctx.app.close(); rmSync(dir, { recursive: true, force: true }); } };
};

test("review H-1: a reset turns the outside face off and voids its web sessions and unused codes; after it, only this machine's command line may set the new PIN", async () => {
  const s = await daisyApp("daisy-h1-");
  try {
    const { ctx, cli, web, call } = s;
    assert.equal((await call("POST", "/api/pin", web, { pin: PIN })).statusCode, 200, "first PIN: any owner entry (D-36)");
    const on = await call("PUT", "/api/access/external", { ...web, [PIN_GRANT_HEADER]: await s.grant(web) }, { host: "127.0.0.1", tls: false });
    assert.equal(on.statusCode, 200, on.body);
    assert.ok(ctx.access.faces.externalListening);
    // From elsewhere: a web session of the outside face, and a code not used yet.
    const ext = ctx.issueToken("external");
    const code = ctx.access.web.issueCode("external").code;
    assert.ok(await ctx.access.guard.identify(ext, "external"));

    assert.equal((await call("POST", "/api/pin/reset", cli, { confirm: true })).statusCode, 200);
    assert.equal(ctx.access.faces.externalListening, false, "对外面关掉");
    assert.equal(ctx.access.config().external.enabled, false, "保存为关闭");
    assert.equal(await ctx.access.guard.identify(ext, "external"), null, "对外面的网页会话作废");
    assert.equal(ctx.access.web.takeCode(code, "external"), false, "没用过的一次性口令作废");
    // Nobody but this machine's command line sets the next PIN.
    const fromWeb = await call("POST", "/api/pin", web, { pin: "999111" });
    assert.equal(fromWeb.statusCode, 403);
    assert.equal(fromWeb.json().code, "pin_set_local_only");
    assert.equal(ctx.pin.status().set, false);
    assert.equal((await call("POST", "/api/pin", cli, { pin: "999111" })).statusCode, 200);
    const row = JSON.parse(ctx.store.one("SELECT target FROM audit WHERE action='pin.reset.revoke'").target);
    assert.equal(row.revoked["external-face"], 1);
  } finally {
    await s.done();
  }
});

test("review M-1: a 「放别人进来」 request still running when the PIN is reset (or changed) writes nothing", async () => {
  const s = await daisyApp("daisy-m1-");
  const iss = await fakeIssuer();
  const orig = ExternalIssuer.configure;
  try {
    const { ctx, cli, web, call } = s;
    assert.equal((await call("POST", "/api/pin", web, { pin: PIN })).statusCode, 200);
    const wg = await s.grant(web);
    // The issuer's keys take a while to fetch (here: until released).
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>((ok) => (entered = ok));
    const gate = new Promise<void>((ok) => (release = ok));
    ExternalIssuer.configure = (async (...args: Parameters<typeof orig>) => {
      entered();
      await gate;
      return orig.apply(ExternalIssuer, args);
    }) as typeof orig;
    const pending = call("PUT", "/api/access/issuer", { ...web, [PIN_GRANT_HEADER]: wg }, { issuer: iss.issuer, ownerSubject: OWNER_SUB });
    await inside;
    // Meanwhile: the owner resets the PIN on this machine.
    assert.equal((await call("POST", "/api/pin/reset", cli, { confirm: true })).statusCode, 200);
    release();
    const late = await pending;
    assert.equal(late.statusCode, 409, late.body);
    assert.equal(late.json().code, "pin_changed");
    assert.equal(ctx.access.issuer.get(), null, "签发方没有被写回");
    assert.equal(existsSync(join(s.dir, "issuer")), false);
    const owner = await iss.sign({ sub: OWNER_SUB, aud: ctx.access.ai.urn });
    assert.equal((await call("GET", "/api/me", { authorization: `Bearer ${owner}` })).statusCode, 401);
  } finally {
    ExternalIssuer.configure = orig;
    await iss.close();
    await s.done();
  }
  // The seal itself: a PIN change ends it too; a commit is synchronous.
  const pin = pinDouble();
  const req: any = {};
  sealLetIn(req, pin);
  assert.equal(commitLetIn(req, () => 7), 7);
  pin.set("135799", "246810");
  assert.throws(() => commitLetIn(req, () => 1), (e: any) => e.code === "pin_changed");
  const req2: any = {};
  sealLetIn(req2, pin);
  assert.throws(() => commitLetIn(req2, () => Promise.resolve(1)), /synchronous/);
  // A PinService without an epoch: nothing is committed (fails closed).
  const old: any = { ...pinDouble(), epoch: undefined };
  const req3: any = {};
  sealLetIn(req3, old);
  assert.throws(() => commitLetIn(req3, () => 1), (e: any) => e.code === "pin_changed");
});

test("review M-1: a PIN route whose handler does not commit through commitLetIn fails (500), it never answers success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-m1b-"));
  const pin = pinDouble();
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, workspaceRoots: [dir], sharedHost: () => false, peerIsOwner: () => true, pin });
  try {
    const forgot = { ...probes.allowlistAdd, id: "grant.forgot", path: "/api/allowlist/forgot" } as AnyRoute;
    serve(ctx.app, forgot, async () => ({ ok: true }));
    // D-40 ①: a read of the grant group takes no PIN, so it has nothing to
    // commit — `serve` asks commitLetIn of PIN routes only.
    const read = { ...probes.allowlistAdd, id: "grant.readProbe", method: "GET", path: "/api/allowlist/read-probe", letsIn: undefined, pin: false } as AnyRoute;
    serve(ctx.app, read, async () => ({ ok: true }));
    const web = { authorization: `Bearer ${ctx.issueToken()}` };
    const holder = `web:${createHash("sha256").update(web.authorization.slice(7)).digest("hex")}`;
    const r = await ctx.app.inject({ method: "POST", url: forgot.path, headers: { ...web, [PIN_GRANT_HEADER]: pin.grant("246810", holder).grant }, payload: {} });
    assert.equal(r.statusCode, 500);
    // The real reads answer the web page without a grant (and without
    // commitLetIn, which would 409); the command line with its grant —
    // still outside commitLetIn, and `serve` does not ask it of them (no 500).
    assert.equal((await ctx.app.inject({ url: read.path, headers: web })).statusCode, 200);
    const cli = { authorization: `Bearer ${readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim()}` };
    for (const url of ["/api/contacts", "/api/contacts/me", "/api/requests", "/api/grants", "/api/agents", "/api/residents", "/api/tokens"]) {
      const g = await ctx.app.inject({ url, headers: web });
      assert.equal(g.statusCode, 200, `${url}: ${g.body}`);
      const c = await ctx.app.inject({ url, headers: { ...cli, [PIN_GRANT_HEADER]: pin.grant("246810", "cli").grant } });
      assert.equal(c.statusCode, 200, `${url}（命令行带 PIN）: ${c.body}`);
      assert.equal((await ctx.app.inject({ url, headers: cli })).json().code, "pin_required", `${url}（命令行不带 PIN）`);
    }
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review L-1 / L-2: outside hooks that already ran are recorded when a later one fails; the issuer's files go before memory; a hook is synchronous", async () => {
  // L-2: a hook that returns a thenable is refused.
  const r = new Revocations();
  r.register("contacts", "test: async", (() => Promise.resolve(1)) as any);
  assert.throws(() => r.runAll(), /synchronous/);
  assert.deepEqual(r.failure(), { failed: "contacts", outsideDone: [] });

  const s = await daisyApp("daisy-l1-");
  const iss = await fakeIssuer();
  try {
    const { ctx, cli, web, call } = s;
    assert.equal((await call("POST", "/api/pin", web, { pin: PIN })).statusCode, 200);
    const wg = await s.grant(web);
    assert.equal((await call("PUT", "/api/access/issuer", { ...web, [PIN_GRANT_HEADER]: wg }, { issuer: iss.issuer, ownerSubject: OWNER_SUB })).statusCode, 200);
    // The issuer's files cannot be removed: its hook fails — and memory
    // still trusts it no less than the disk (files first, then memory).
    if (process.platform !== "win32") {
      chmodSync(join(s.dir, "issuer"), 0o500);
      try {
        const failed = await call("POST", "/api/pin/reset", cli, { confirm: true });
        assert.equal(failed.statusCode, 500);
      } finally {
        chmodSync(join(s.dir, "issuer"), 0o700);
      }
      assert.ok(ctx.access.issuer.get(), "文件还在，内存里也还在");
      assert.ok(ctx.pin.status().set);
      const partial = ctx.store.one("SELECT target FROM audit WHERE action='pin.reset.partial'");
      assert.deepEqual(JSON.parse(partial.target), { failed: "issuer", outsideDone: ["ai-tokens"] });
      ctx.store.run("DELETE FROM audit WHERE action='pin.reset.partial'");
    }
    // An outside hook after the built-in ones fails: those already ran
    // (not undone) are named in a row written after the rollback.
    ctx.access.revocations.register("visitor-tokens", "test: fails outside", () => {
      throw new Error("token file locked");
    }, { outside: true });
    const failed = await call("POST", "/api/pin/reset", cli, { confirm: true });
    assert.equal(failed.statusCode, 500);
    assert.ok(ctx.pin.status().set, "PIN 没有重置");
    const partial = ctx.store.one("SELECT a.target, c.channel FROM audit a JOIN audit_context c ON c.audit_id=a.id WHERE a.action='pin.reset.partial'");
    assert.ok(partial, "留下记录");
    assert.equal(partial.channel, "cli");
    const f = JSON.parse(partial.target);
    assert.equal(f.failed, "visitor-tokens");
    // P4-03: calls in progress were stopped (cannot be undone) — named too.
    // P5-03: the devices' sessions, codes and sockets were dropped too.
    assert.deepEqual([...f.outsideDone].sort(), ["ai-tokens", "devices", "external-face", "invoke-grants", "issuer", "ui-origins"]);
    assert.equal(ctx.access.issuer.get(), null);
    assert.equal(ctx.store.one("SELECT COUNT(*) n FROM audit WHERE action='pin.reset.revoke'").n, 0, "回滚了的不算");
  } finally {
    await iss.close();
    await s.done();
  }
});
