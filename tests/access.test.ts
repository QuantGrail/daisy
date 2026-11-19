/**
 * P1-03 (ADR-110): who gets through, decided in one place from the route
 * table — tested refusals first.
 *
 * The table-driven test tries every route of the table with every kind of
 * caller and compares the guard's decision with 5.11, written out here by
 * hand (EXPECT): the definitions' own `channels` / `scope` / `aiSelf` /
 * `pin` are what is being checked, so they are not used to compute what
 * should happen.
 */
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, importJWK } from "jose";
import { createApp } from "../packages/daisy/src/app.ts";
import {
  API_ROUTES,
  fillPath,
  type AnyRoute,
} from "../packages/contracts/src/index.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { pinDouble } from "./fixtures/pin-double.ts";
import { createHash } from "node:crypto";
/** The PIN holder of a web session (guard.ts holderOf: `web:<sha-256>`). */
const webHolder = (token: string) => `web:${createHash("sha256").update(token).digest("hex")}`;
/** P2-01: an issuer token's PIN holder (`issuer:<sha-256>`). */
const issuerHolder = (token: string) => `issuer:${createHash("sha256").update(token).digest("hex")}`;
import { fakeIssuer } from "./fixtures/fake-issuer.ts";
import { OWNER_SCOPES } from "../packages/daisy/src/access/guard.ts";
import { runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";
import { SelfIssuer } from "../packages/daisy/src/access/tokens/self-issuer.ts";
import { makeCard } from "../packages/daisy/src/contacts/card.ts";
import { PROBES, serveProbes } from "./fixtures/let-in-probes.ts";
import { localDevice } from "./fixtures/device-session.ts";
import { api } from "../packages/contracts/src/api/index.ts";

/** The codes only the guard answers with: anything else got past it. */
const GUARD_CODES = new Set([
  "unauthenticated",
  "channel_not_allowed",
  "not_own_session",
  "insufficient_scope",
  "pin_required",
  "pin_unavailable",
  "external_off",
  "cross_site",
  "host_not_allowed",
  "route_not_defined",
  "a2a_only",
  // P4-04: the A2A entry refuses the owner and the AI.
  "visitors_only",
]);

// ── 5.11, by hand ────────────────────────────────────────────────────────
type Row =
  | "public" //            no credential needed (health; the session exchange checks its own code)
  | "owner" //             主人本人 ✓  命令行 ✓  AI —
  | "aiRead" //            主人本人 ✓  命令行 ✓  AI 只限自己这个会话（读对话记录和事件）
  | "answer" //            替 AI 点头：主人本人 ✓  命令行 —  AI —
  | "grant" //             放别人进来：主人本人 ✓  命令行 ✓  AI —，都要 PIN
  | "webOnly" //           网页会话自己的注销：网页 ✓，命令行和 AI 没有网页会话
  | "socket" //            实时通道：第一帧（主人本人 ✓  命令行 ✓  AI —）
  | "pinGrant" //          输入 PIN 换授权：主人本人 ✓  命令行 ✓  AI —（AI 不知道 PIN）；本身不要授权
  | "cliOnly" //           在本机重置 PIN：只在本机命令行（5.11 PIN 码）
  | "aiOnly" //            AI 自用的工具：主人本人 —  命令行 —  AI ✓（只限自己这个会话；P2-02 替 AI 领令牌）
  | "a2a" //              P4-04 A2A 入口：只有来访者（联系人的跨 Daisy 令牌、外部签发方签给别人的），要 daisy:invoke；主人本人 —  命令行 —  AI —
  | "grantNoPin" //        P4-07 收窄（暂停、关闭、删除常驻 agent）：daisy:grant，主人本人 ✓  命令行 ✓  AI —，不要 PIN
  | "grantRead" //         D-40 ① 调用授权组的读（名片、请求、授权、令牌、agent 列表、常驻 agent）：daisy:grant，主人本人 ✓（不要 PIN）  命令行 ✓（要 PIN）  AI —  来访者 —
  | "managePin" //         P5-06 设置更新来源（会改变以后运行的代码）：daisy:manage + PIN（D-40 ①：写都要 PIN），主人本人 ✓  命令行 ✓  AI —
  | "events" //            事件出口（P2-03，daisy:events:read）：主人本人 ✓  命令行 ✓  外部签发方给主人的 ✓  AI —；只带这一个 scope 的令牌也 ✓
  | "deviceOnly"; //       P5-03 设备取消自己的配对：只有配对设备自己（不要 PIN，只收窄）

const AI_READS = [
  "session.show",
  "session.items",
  "session.events",
  "session.recoveries",
  "session.recoveryEvents",
  "session.queue",
  "session.activity",
  "session.scheduleList",
];
const EXPECT: Record<string, Row> = {
  "system.health": "public",
  // P6-20 (ADR-159 §4): the web UI's language pack (interface text only).
  "system.locales": "public",
  "settings.webSession": "public",
  "system.live": "socket",
  "approval.respond": "answer",
  "session.answerApproval": "answer",
  "settings.externalOn": "grant",
  "settings.passcode": "grant",
  "settings.openCodeExternal": "grant",
  "settings.issuerSet": "grant",
  "settings.uiOriginsSet": "grant",
  // P4-01: the identity card and the contacts — 「添加、移除互认的名片」 (5.11).
  // D-40 ① (phase-4 gate): reading in this group takes no PIN (grantRead).
  "grant.contactExport": "grantRead",
  "grant.contactInspect": "grantRead",
  "grant.contactImport": "grant",
  "grant.contactList": "grantRead",
  "grant.contactShow": "grantRead",
  "grant.contactRemove": "grant",
  "grant.contactWhitelistAdd": "grant",
  "grant.contactWhitelistRemove": "grant",
  // P4-03: call authorization — the cards, the grants, the range (all
  // daisy:grant + PIN; deciding, revoking and the range are letsIn).
  "grant.requestList": "grantRead",
  "grant.requestShow": "grantRead",
  "grant.requestDecide": "grant",
  "grant.grantList": "grantRead",
  "grant.grantRevoke": "grant",
  "grant.audienceShow": "grantRead",
  "grant.audienceSet": "grant",
  // P4-05: 问与办 — reading and setting 是否允许办 / 办的权限模式.
  "grant.actShow": "grantRead",
  "grant.actSet": "grant",
  // P4-06: making a session public or taking it back (PIN); reading is the owner's session.
  "grant.publicSet": "grant",
  // P4-07: resident agents — reading, creating, changing, resuming (PIN);
  // pausing, closing, deleting only take away (daisy:grant, no PIN).
  "grant.residentList": "grantRead",
  "grant.residentShow": "grantRead",
  "grant.residentCreate": "grant",
  "grant.residentSet": "grant",
  "grant.residentResume": "grant",
  "grant.residentPause": "grantNoPin",
  "grant.residentClose": "grantNoPin",
  "grant.residentDelete": "grantNoPin",
  // P4-12 (ADR-132): daisy token (issue / list / revoke) and the agents
  // others may call (one list) — daisy:grant + PIN. 「我的 AI 调用了谁」
  // (session.outgoing*) is the owner's reading, like a conversation.
  "grant.tokenIssue": "grant",
  "grant.tokenList": "grantRead",
  "grant.tokenRevoke": "grant",
  "grant.agentList": "grantRead",
  "session.aiToken": "aiOnly",
  "settings.webLogout": "webOnly",
  "settings.pinGrant": "pinGrant",
  "settings.pinReset": "cliOnly",
  "settings.updateSourceSet": "managePin",
  "events.list": "events",
  "events.snapshot": "events",
  // P4-04: the A2A entry (5.11 「外面来的」) — visitors only.
  ...Object.fromEntries(Object.values(api.a2a).map((r) => [r.id, "a2a" as Row])),
  ...Object.fromEntries(AI_READS.map((id) => [id, "aiRead" as Row])),
  // P4-02: the 「放别人进来」 routes phase 4 / 5 will add, as probes
  // (tests/fixtures/let-in-probes.ts) — 5.11 「要」 rows.
  "grant.allowlistAdd": "grant",
  // P5-03 (ADR-142): pairing — 5.11 「配对新设备、吊销设备」 (PIN); the list
  // is a read (D-40 ①: PIN on the command line only); the device trades
  // its pairing code / credential itself (public, checked by the handler);
  // a device unpairs itself.
  "settings.pair": "grant",
  "settings.deviceRevoke": "grant",
  "settings.deviceList": "grantRead",
  "settings.pairRedeem": "public",
  "settings.deviceSession": "public",
  "settings.deviceForget": "deviceOnly",
  // P5-02 (ADR-144): choosing the relay lets the world reach the outside
  // face; turning it off narrows, and still takes the PIN (5.10). Reading
  // its status is the owner's. The TLS binding claim is public (signed).
  "settings.relaySet": "grant",
  "settings.relayOff": "grant",
  "system.tlsBinding": "public",
};
/** Every other route is the owner's (session, profile, workspace, settings, system). */
const rowOf = (r: AnyRoute): Row => EXPECT[r.id] ?? "owner";

/**
 * P2-01: four more — the configured external issuer's token for the owner
 * (主人本人 from elsewhere, X-1), with a PIN grant bound to it; someone
 * else's valid token from that issuer, and the owner's with `act` (an AI
 * acting for the owner): A2A only, every local route refuses them (X-2).
 * P4-01: two more — a contact's cross-Daisy token (token.md §4.1: a
 * visitor, A2A only) and the same kind of token from a Daisy never added
 * (nobody, T-2).
 */
type Who =
  | "none"
  | "web"
  | "cli"
  | "aiOwn"
  | "aiOther"
  | "webPin"
  | "cliPin"
  | "aiPin"
  | "issuerOwner"
  | "issuerOwnerPin"
  | "issuerOther"
  | "issuerAi"
  | "issuerEvents"
  | "peer"
  | "stranger"
  // P4-04: someone else's token from the external issuer, with daisy:invoke.
  | "issuerInvoke"
  // P4-02: the issuer's token for the owner without daisy:grant, with a
  // live PIN grant bound to it — the PIN alone is not enough.
  | "issuerNoGrantPin"
  // P4-12 review L-2: `daisy token` — one signed for contact B, one `--for me`.
  | "tokenContact"
  | "tokenMe"
  // P5-03: a paired device's session, without and with a PIN grant bound to it.
  | "device"
  | "devicePin";
const WHO: Who[] = [
  "none",
  "web",
  "cli",
  "aiOwn",
  "aiOther",
  "webPin",
  "cliPin",
  "aiPin",
  "issuerOwner",
  "issuerOwnerPin",
  "issuerOther",
  "issuerAi",
  "issuerEvents",
  "peer",
  "stranger",
  "issuerInvoke",
  "issuerNoGrantPin",
  "tokenContact",
  "tokenMe",
  "device",
  "devicePin",
];

function allowed(row: Row, who: Who): boolean {
  if (row === "public") return true;
  if (who === "none") return false;
  // P4-04: the A2A entry is the visitors' with daisy:invoke (a contact's
  // token keeps it; the issuer's for someone else when it carries it) —
  // and nobody else's; every other route refuses every visitor.
  if (row === "a2a") return who === "peer" || who === "issuerInvoke" || who === "tokenContact" || who === "tokenMe";
  if (who === "issuerInvoke") return false;
  // P4-12: a daisy token is a visitor whoever it names (`me` too): A2A only.
  if (who === "tokenContact" || who === "tokenMe") return false;
  if (who === "issuerOther" || who === "issuerAi") return false;
  // P4-01: a contact's token (a visitor, A2A only) and a stranger's (nobody).
  if (who === "peer" || who === "stranger") return false;
  // P2-03: the issuer's token for the owner limited to daisy:events:read
  // (what a notification centre holds): the event outlet and nothing else.
  if (who === "issuerEvents") return row === "events";
  // P4-02: every owner row except those that need daisy:grant (the PIN's
  // own grant route included).
  if (who === "issuerNoGrantPin")
    return allowed(row, "issuerOwnerPin") && row !== "grant" && row !== "grantNoPin" && row !== "grantRead" && row !== "pinGrant";
  const ai = who.startsWith("ai");
  switch (row) {
    case "events":
      return !ai;
    case "owner":
    case "socket":
    case "pinGrant":
    case "grantNoPin":
      return !ai;
    case "grantRead":
      // D-40 ①: the web page and the issuer's token for the owner without a
      // PIN; the command line (maybe the owner's AI) only with one.
      return !ai && who !== "cli";
    case "cliOnly":
      return who === "cli" || who === "cliPin";
    case "aiRead":
      return who !== "aiOther";
    case "aiOnly":
      return who === "aiOwn" || who === "aiPin";
    case "answer":
      // 5.11 / 原则 6: the owner in person — the web page, a paired device.
      // Not the issuer's token for the owner: closed until the stage gate
      // decides (review of P2-01, ADR-113).
      return ["web", "webPin", "device", "devicePin"].includes(who);
    case "webOnly":
      // A web session's own logout — a paired device's session is one too.
      return ["web", "webPin", "device", "devicePin"].includes(who);
    case "deviceOnly":
      return who === "device" || who === "devicePin";
    case "grant":
    case "managePin":
      return who === "webPin" || who === "cliPin" || who === "issuerOwnerPin" || who === "devicePin";
  }
}

async function setup(opts: { pin?: boolean; shared?: boolean; peerIsOwner?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-access-"));
  const pin = pinDouble();
  const ctx = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    sharedHost: () => opts.shared ?? false,
    peerIsOwner: () => opts.peerIsOwner ?? true,
    // The stand-in (grants bound to holders, one-use for the command line),
    // or (`pin: false`) no PinService at all.
    pin: opts.pin === false ? null : pin,
  });
  const cli = readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim();
  const inject = runnerInject(ctx.app, ctx.runnerApi);
  return { dir, ctx, pin, cli, inject };
}

/** A session with a running turn, and the AI credential of that turn. */
async function runningTurn(s: Awaited<ReturnType<typeof setup>>) {
  const { ctx, inject, dir } = s;
  const h = { authorization: `Bearer ${ctx.issueToken()}` };
  const cat = (await inject({ url: "/api/catalog", headers: h })).json();
  const mk = async () =>
    (
      await inject({
        method: "POST",
        url: "/api/sessions",
        headers: h,
        payload: {
          agent: "claude",
          workspaceId: cat.workspaces[0].id,
          profileId: cat.profiles.find((p: any) => p.agent === "claude").id,
        },
      })
    ).json();
  const own = await mk(),
    other = await mk();
  await inject({
    method: "POST",
    url: `/api/sessions/${own.id}/messages`,
    headers: h,
    payload: { text: "hi", requestId: "req-access-0001" },
  });
  const nodeId = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8")).nodeId;
  const claimed = (
    await inject({ method: "POST", url: "/api/runner/claim", payload: {}, headers: runnerHeaders(nodeId) })
  ).json();
  assert.equal(claimed.job.session.id, own.id);
  const file = claimed.job.aiCredential.file;
  const ai = readFileSync(file, "utf8").trim();
  return { own: own.id, other: other.id, ai, file, job: claimed.job, nodeId };
}

test("every route × every caller: the guard decides as 5.11 says", async () => {
  const s = await setup();
  const { ctx, cli, pin } = s;
  // P4-02: the 「放别人进来」 kinds still to come, as their packages will define them.
  serveProbes(ctx.app);
  const ROUTES = [...API_ROUTES, ...PROBES];
  const iss = await fakeIssuer();
  try {
    const t = await runningTurn(s);
    // P2-01: an external issuer, configured as the owner would.
    const conf = await ctx.app.inject({
      method: "PUT",
      url: "/api/access/issuer",
      headers: { authorization: `Bearer ${cli}`, [PIN_GRANT_HEADER]: pin.grant("246810", "cli").grant },
      payload: { issuer: iss.issuer, ownerSubject: "user:owner" },
    });
    assert.equal(conf.statusCode, 200, conf.body);
    const issuer = ctx.access.issuer.get()!;
    const urn = ctx.access.ai.urn;
    // P4-01: a contact (B) and a stranger (C), each with its own key.
    const peerDir = mkdtempSync(join(tmpdir(), "daisy-access-peer-"));
    const strangerDir = mkdtempSync(join(tmpdir(), "daisy-access-stranger-"));
    const peer = await SelfIssuer.open(peerDir);
    const stranger = await SelfIssuer.open(strangerDir);
    const peerCard = await makeCard(peer, { name: "B", addrs: [] });
    const a2a = (k: SelfIssuer) =>
      k.sign({ sub: k.urn, aud: urn, clientId: "a2a", scope: OWNER_SCOPES.join(" ") + " daisy:invoke", ttlS: 300 }).then((t) => t.token);
    // Each caller's grant is bound to its own credential (local-api.md §6.3).
    const grantFor = (token: string | undefined, who: Who) =>
      pin.grant(
        "246810",
        who.startsWith("web") || who.startsWith("device")
          ? webHolder(token!)
          : who.startsWith("cli")
            ? "cli"
            : who.startsWith("issuer")
              ? issuerHolder(token!)
              : "ai",
      ).grant;
    // P4-12 review L-2: daisy tokens, kept while their record stands (a route
    // of the table may revoke them, a PIN reset, removing the contact).
    const daisyTokens: Partial<Record<Who, { token: string; jti: string }>> = {};
    const daisyToken = async (who: "tokenContact" | "tokenMe") => {
      const kept = daisyTokens[who];
      if (kept && !ctx.store.one("SELECT revoked_at FROM visitor_tokens WHERE jti=?", kept.jti)?.revoked_at) return kept.token;
      const vt = ctx.access.visitorTokens;
      const signed = await vt.sign({ for: who === "tokenMe" ? "me" : peerCard.id });
      vt.commit(signed, undefined, "test");
      daisyTokens[who] = { token: signed.token, jti: signed.jti };
      return signed.token;
    };
    // P5-03: a paired device's session, kept while its device and session stand
    // (a route of the table may revoke it — the device itself, a PIN reset).
    let dev: { id: string; token: string } | null = null;
    const deviceToken = () => {
      if (!dev || !ctx.access.devices.active(dev.id, "local") || !ctx.access.web.find(dev.token)) dev = localDevice(ctx);
      return dev.token;
    };
    const tokenOf = async (who: Who) =>
      who === "device" || who === "devicePin"
        ? deviceToken()
        : who === "tokenContact" || who === "tokenMe"
        ? await daisyToken(who)
        : who === "none"
        ? undefined
        : who.startsWith("web")
          ? ctx.issueToken()
          : who.startsWith("cli")
            ? cli
            : who.startsWith("issuerOwner")
              ? await iss.sign({ sub: "user:owner", aud: urn, scope: OWNER_SCOPES.join(" ") })
              : who === "issuerEvents"
                ? await iss.sign({ sub: "user:owner", aud: urn, scope: "daisy:events:read" })
              : who === "peer"
                ? await a2a(peer)
              : who === "stranger"
                ? await a2a(stranger)
              : who === "issuerNoGrantPin"
                ? await iss.sign({ sub: "user:owner", aud: urn, scope: OWNER_SCOPES.filter((x) => x !== "daisy:grant").join(" ") })
              : who === "issuerInvoke"
                ? await iss.sign({ sub: "user:other", aud: urn, scope: "daisy:invoke" })
              : who === "issuerOther"
                ? await iss.sign({ sub: "user:other", aud: urn })
                : who === "issuerAi"
                  ? await iss.sign({ sub: "user:owner", aud: urn, act: { sub: "agent:a1" } })
                  : t.ai;
    let tried = 0;
    const bad: string[] = [];
    for (const r of ROUTES) {
      for (const who of WHO) {
        const expected = allowed(rowOf(r), who);
        // Path parameters: the AI's own session where a session goes
        // (another one for aiOther); placeholders elsewhere.
        const sid = who === "aiOther" ? t.other : t.own;
        const params = Object.fromEntries(
          Object.keys(r.params.shape).map((k) => [k, k === "id" && r.path.startsWith("/api/sessions/:id") ? sid : "x-placeholder"]),
        );
        // A route of the table may have removed the issuer: put it back.
        if (who.startsWith("issuer") && !ctx.access.issuer.get()) {
          issuer.save();
          ctx.access.issuer.set(issuer);
        }
        // …or the contact (the PIN reset removes every contact).
        if ((who === "peer" || who === "tokenContact") && !ctx.access.contacts.get(peerCard.id))
          ctx.access.contacts.put(peerCard, { via: "test" });
        const token = await tokenOf(who);
        let got: boolean;
        if (r.auth === "socket-first-frame") {
          const p = token
            ? await ctx.access.guard.socketPrincipal(
                { raw: { socket: {} }, url: r.path, method: "GET" },
                r,
                token,
              )
            : null;
          got = !!p;
        } else {
          const res = await ctx.app.inject({
            method: r.method,
            url: fillPath(r.path, params),
            headers: {
              ...(token ? { authorization: `Bearer ${token}` } : {}),
              ...(who.endsWith("Pin") ? { [PIN_GRANT_HEADER]: grantFor(token, who) } : {}),
            },
            ...(r.method === "GET" ? {} : { payload: {} }),
          });
          let code: string | undefined;
          try {
            const j = res.json();
            // P4-04: the A2A entry answers A2A errors (the guard's code in the ErrorInfo).
            code = j?.code ?? j?.error?.details?.[0]?.metadata?.code ?? j?.error?.data?.[0]?.metadata?.code;
          } catch {}
          got = !(GUARD_CODES.has(code ?? "") && [401, 403].includes(res.statusCode));
        }
        tried++;
        if (got !== expected)
          bad.push(`${r.id} × ${who}: ${got ? "通过" : "拒绝"}，5.11 要${expected ? "通过" : "拒绝"}`);
      }
    }
    assert.deepEqual(bad, []);
    assert.equal(tried, ROUTES.length * WHO.length);
    // P2-03: the issuer's owner token without daisy:events:read (the four
    // owner scopes only) does not read the event outlet — the scopes are
    // the token's ∩ the owner's.
    const four = await iss.sign({ sub: "user:owner", aud: urn });
    for (const url of ["/api/events", "/api/events/snapshot"]) {
      const r = await ctx.app.inject({ url, headers: { authorization: `Bearer ${four}` } });
      assert.equal(r.statusCode, 403, url);
      assert.equal(r.json().code, "insufficient_scope");
      assert.match(String(r.headers["www-authenticate"]), /daisy:events:read/);
    }
    console.log(`  ${API_ROUTES.length} 条接口 + ${PROBES.length} 个探针 × ${WHO.length} 种身份 = ${tried} 次`);
    // P4-01: the contact was recognised (a visitor: a2a_only), the stranger not (401).
    ctx.access.contacts.put(peerCard, { via: "test" });
    const pr = await ctx.app.inject({ url: "/api/sessions", headers: { authorization: `Bearer ${await a2a(peer)}` } });
    assert.equal(pr.json().code, "a2a_only");
    const sr = await ctx.app.inject({ url: "/api/sessions", headers: { authorization: `Bearer ${await a2a(stranger)}` } });
    assert.equal(sr.statusCode, 401);
    rmSync(peerDir, { recursive: true, force: true });
    rmSync(strangerDir, { recursive: true, force: true });
  } finally {
    await iss.close();
    await ctx.app.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("the 「调用授权」 reads — the web page and the issuer's owner token without a PIN, the command line with one; never the AI, a visitor, or a credential without daisy:grant; the changes still want the PIN", async () => {
  const s = await setup();
  const { ctx, cli } = s;
  const iss = await fakeIssuer();
  const peerDir = mkdtempSync(join(tmpdir(), "daisy-d40-peer-"));
  try {
    const t = await runningTurn(s);
    const urn = ctx.access.ai.urn;
    const g = s.pin.grant("246810", "cli").grant;
    const conf = await ctx.app.inject({ method: "PUT", url: "/api/access/issuer", headers: { authorization: `Bearer ${cli}`, [PIN_GRANT_HEADER]: g }, payload: { issuer: iss.issuer, ownerSubject: "user:owner" } });
    assert.equal(conf.statusCode, 200, conf.body);
    const peer = await SelfIssuer.open(peerDir);
    ctx.access.contacts.put(await makeCard(peer, { name: "B", addrs: [] }), { via: "test" });
    const reads = API_ROUTES.filter((r) => r.group === "grant" && (r.method === "GET" || (r.notLetIn && routeText(r.id, "notLetIn", zh)?.startsWith("只读"))));
    assert.deepEqual(
      reads.map((r) => r.id).sort(),
      ["grant.actShow", "grant.agentList", "grant.audienceShow", "grant.contactExport", "grant.contactInspect", "grant.contactList", "grant.contactShow", "grant.grantList", "grant.requestList", "grant.requestShow", "grant.residentList", "grant.residentShow", "grant.tokenList"],
    );
    const call = async (r: AnyRoute, headers: Record<string, string>) => {
      const res = await ctx.app.inject({
        method: r.method,
        url: fillPath(r.path, Object.fromEntries(Object.keys(r.params.shape).map((k) => [k, "x-placeholder"]))),
        headers,
        ...(r.method === "GET" ? {} : { payload: { card: "daisy-card:1:x" } }),
      });
      let code: string | undefined;
      try {
        code = res.json()?.code;
      } catch {}
      return { status: res.statusCode, code };
    };
    const noGrant = await iss.sign({ sub: "user:owner", aud: urn, scope: OWNER_SCOPES.filter((x) => x !== "daisy:grant").join(" ") });
    const passed = (got: { code?: string }) => !["pin_required", "insufficient_scope", "channel_not_allowed", "a2a_only"].includes(got.code ?? "");
    for (const r of reads) {
      // The owner's own entries — the web page, the issuer's token for the owner — without a PIN grant: through.
      for (const token of [ctx.issueToken(), await iss.sign({ sub: "user:owner", aud: urn, scope: OWNER_SCOPES.join(" ") })]) {
        const got = await call(r, { authorization: `Bearer ${token}` });
        assert.ok(passed(got), `${r.id}: 主人不带 PIN 也能读（${got.status} ${got.code}）`);
      }
      // The command line (its credential may be the owner's AI through Bash): only with the PIN.
      const cliNo = await call(r, { authorization: `Bearer ${cli}` });
      assert.equal(cliNo.code, "pin_required", `${r.id}: 命令行读要 PIN`);
      const cliYes = await call(r, { authorization: `Bearer ${cli}`, [PIN_GRANT_HEADER]: s.pin.grant("246810", "cli").grant });
      assert.ok(passed(cliYes) && cliYes.status !== 500, `${r.id}: 命令行带 PIN 能读（${cliYes.status} ${cliYes.code}）`);
      // The AI's working credential: never (with a PIN grant either).
      for (const h of [{}, { [PIN_GRANT_HEADER]: s.pin.grant("246810", "ai").grant }] as Record<string, string>[]) {
        const ai = await call(r, { authorization: `Bearer ${t.ai}`, ...h });
        assert.equal(ai.status, 403, `${r.id}: AI`);
        assert.equal(ai.code, "channel_not_allowed", `${r.id}: AI`);
      }
      // A visitor: a contact's cross-Daisy token, the issuer's token for someone else.
      const visitor = await peer.sign({ sub: peer.urn, aud: urn, clientId: "a2a", scope: "daisy:invoke", ttlS: 300 });
      assert.equal((await call(r, { authorization: `Bearer ${visitor.token}` })).code, "a2a_only", `${r.id}: 联系人`);
      assert.equal((await call(r, { authorization: `Bearer ${await iss.sign({ sub: "user:other", aud: urn, scope: "daisy:invoke" })}` })).code, "a2a_only", `${r.id}: 别人`);
      // The owner's token without daisy:grant.
      const ns = await call(r, { authorization: `Bearer ${noGrant}` });
      assert.equal(ns.code, "insufficient_scope", `${r.id}: 没有 daisy:grant`);
    }
    // Every change of the group that lets someone in still wants the PIN.
    for (const r of API_ROUTES.filter((r) => r.group === "grant" && r.letsIn)) {
      for (const token of [ctx.issueToken(), cli]) {
        const got = await call(r, { authorization: `Bearer ${token}` });
        assert.equal(got.code, "pin_required", `${r.id}: 写要 PIN`);
      }
    }
  } finally {
    await iss.close();
    await ctx.app.close();
    rmSync(peerDir, { recursive: true, force: true });
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("T-6: the AI's working credential never answers an approval, nor reaches another session", async () => {
  const s = await setup();
  const { ctx } = s;
  try {
    const t = await runningTurn(s);
    const ai = { authorization: `Bearer ${t.ai}` };
    for (const url of [
      `/api/approvals/a1/respond`,
      `/api/sessions/${t.own}/approvals/a1`,
    ]) {
      const r = await ctx.app.inject({ method: "POST", url, headers: ai, payload: { decision: "allow" } });
      assert.equal(r.statusCode, 403, url);
      assert.equal(r.json().code, "channel_not_allowed");
    }
    // Its own session: readable. Another: not. Writing its own: not.
    assert.equal((await ctx.app.inject({ url: `/api/sessions/${t.own}`, headers: ai })).statusCode, 200);
    const other = await ctx.app.inject({ url: `/api/sessions/${t.other}`, headers: ai });
    assert.equal(other.statusCode, 403);
    assert.equal(other.json().code, "not_own_session");
    const send = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${t.own}/messages`,
      headers: ai,
      payload: { text: "x", requestId: "req-ai-00001" },
    });
    assert.equal(send.statusCode, 403);
    // Not even with a PIN grant: 「放别人进来」 is never the AI's.
    const g = s.pin.grant("246810", "ai").grant;
    const ext = await ctx.app.inject({
      method: "PUT",
      url: "/api/access/external",
      headers: { ...ai, [PIN_GRANT_HEADER]: g },
      payload: { host: "127.0.0.1" },
    });
    assert.equal(ext.statusCode, 403);
    // The queue read by the AI writes nothing (review of P1-06).
    assert.equal(
      (await ctx.app.inject({ url: `/api/sessions/${t.own}/queue`, headers: ai })).statusCode,
      200,
    );
  } finally {
    await ctx.app.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("the AI's credential: one turn, one session, signed by this Daisy, at most an hour", async () => {
  const s = await setup();
  const { ctx, dir } = s;
  try {
    const t = await runningTurn(s);
    const get = (token: string) =>
      ctx.app.inject({ url: `/api/sessions/${t.own}`, headers: { authorization: `Bearer ${token}` } });
    assert.equal((await get(t.ai)).statusCode, 200);
    // The file is the owner's only.
    assert.equal(readFileSync(t.file).length > 0, true);
    // Tampered, alg none, another key, too long a life, wrong typ: refused.
    const [h, p, sig] = t.ai.split(".");
    const flip = sig!.slice(0, -2) + (sig!.endsWith("AA") ? "BB" : "AA");
    assert.equal((await get(`${h}.${p}.${flip}`)).statusCode, 401);
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt" })).toString("base64url");
    assert.equal((await get(`${none}.${p}.`)).statusCode, 401);
    const jwk = JSON.parse(readFileSync(join(dir, "keys", "identity-key.json"), "utf8"));
    const key = await importJWK(jwk, "EdDSA");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    const now = Math.floor(Date.now() / 1000);
    const sign = (c: any, hdr: any = {}) =>
      new SignJWT(c)
        .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: ctx.access.ai.kid, ...hdr })
        .sign(key);
    // Same key, same claims: accepted (the check is the claims, not luck).
    assert.equal((await get(await sign(claims))).statusCode, 200);
    // D-40 ④: our own `kid` is the base32 identity number; the same key's
    // base64url thumbprint as `kid` is refused.
    assert.match(ctx.access.ai.kid, /^[a-z2-7]{52}$/);
    assert.equal((await get(await sign(claims, { kid: ctx.access.ai.self.thumbprint }))).statusCode, 401);
    assert.equal((await get(await sign({ ...claims, iat: now, exp: now + 7200 }))).statusCode, 401);
    assert.equal((await get(await sign(claims, { typ: "JWT" }))).statusCode, 401);
    assert.equal((await get(await sign({ ...claims, scope: "daisy:session:read daisy:session:write daisy:tools" }))).statusCode, 401);
    assert.equal((await get(await sign({ ...claims, aud: "urn:someone-else" }))).statusCode, 401);
    assert.equal((await get(await sign({ ...claims, client_id: `ai:${t.other}` }))).statusCode, 401);
    // Another Daisy's key: refused.
    const s2 = await setup();
    try {
      const t2 = await runningTurn(s2);
      assert.equal((await get(t2.ai)).statusCode, 401);
    } finally {
      await s2.ctx.app.close();
      rmSync(s2.dir, { recursive: true, force: true });
    }
    // Not on the outside face (the face test covers the listener itself):
    // the AI's and the command line's credentials are local-only.
    assert.equal(await ctx.access.guard.identify(t.ai, "external"), null);
    assert.equal(await ctx.access.guard.identify(s.cli, "external"), null);
    assert.ok(await ctx.access.guard.identify(t.ai, "local"));
    // The turn ends: the credential is dead at once, the file goes.
    ctx.store.run("UPDATE jobs SET status='completed' WHERE id=?", t.job.id);
    const dead = await get(t.ai);
    assert.equal(dead.statusCode, 401);
    assert.equal(dead.headers["www-authenticate"], 'Bearer error="invalid_token"');
    await ctx.access.ai.sweep(() => false);
    assert.equal(ctx.access.ai.read(t.own), null);
  } finally {
    await ctx.app.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("W-1: another web page's request is refused — Origin, Sec-Fetch-Site, Host (DNS rebinding)", async () => {
  const s = await setup();
  const { ctx } = s;
  try {
    const h = { authorization: `Bearer ${ctx.issueToken()}` };
    const go = (extra: Record<string, string>, method = "GET", url = "/api/sessions") =>
      ctx.app.inject({ method: method as any, url, headers: { ...h, ...extra }, ...(method === "GET" ? {} : { payload: {} }) });
    for (const extra of <Record<string, string>[]>[
      { origin: "http://evil.example" },
      { origin: "http://127.0.0.1:1234" }, // another port: another origin (another Daisy, a dev server)
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ]) {
      const r = await go(extra);
      assert.equal(r.statusCode, 403, JSON.stringify(extra));
      assert.equal(r.json().code, "cross_site");
      const w = await go(extra, "POST", "/api/sessions");
      assert.equal(w.statusCode, 403);
    }
    // Other spellings of /api are API requests too.
    for (const url of ["/%61pi/sessions", "//api/sessions", "/API/sessions", "/api/sessions/"]) {
      const r = await go({ origin: "http://evil.example" }, "GET", url);
      assert.ok([403, 404].includes(r.statusCode), `${url} → ${r.statusCode}`);
    }
    // DNS rebinding: the page's own Origin, but a foreign Host.
    const rebind = await go({ host: "evil.example:80", origin: "http://evil.example:80" });
    assert.equal(rebind.statusCode, 403);
    assert.equal(rebind.json().code, "host_not_allowed");
    // The session exchange and health too (no other site mints a session).
    const mint = await ctx.app.inject({
      method: "POST",
      url: "/api/web/session",
      headers: { origin: "http://evil.example" },
      payload: {},
    });
    assert.equal(mint.statusCode, 403);
    // Pre-flight from another origin: refused (no CORS for anyone else).
    const pre = await ctx.app.inject({
      method: "OPTIONS",
      url: "/api/sessions",
      headers: { origin: "http://evil.example", "access-control-request-method": "POST" },
    });
    assert.equal(pre.statusCode, 403);
    assert.equal(pre.headers["access-control-allow-origin"], undefined);
    // Its own page: through.
    assert.equal((await go({ origin: "http://localhost:80", "sec-fetch-site": "same-origin" })).statusCode, 200);
  } finally {
    await ctx.app.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("W-2: on a shared machine another account gets nothing — no passcode, another Daisy's credentials", async () => {
  const mine = await setup({ shared: true });
  const theirs = await setup({ shared: true });
  try {
    const { ctx } = mine;
    const sessions = (token?: string) =>
      ctx.app.inject({
        url: "/api/sessions",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    // Nothing: refused.
    assert.equal((await sessions()).statusCode, 401);
    // A page asking for a session without the one-time code: refused (the
    // passcode is on because the machine is shared).
    const ask = await ctx.app.inject({
      method: "POST",
      url: "/api/web/session",
      headers: { origin: "http://localhost:80", "sec-fetch-site": "same-origin" },
      payload: {},
    });
    assert.equal(ask.statusCode, 401);
    assert.equal(ask.json().code, "passcode_required");
    // The other account's own Daisy's credentials mean nothing here.
    assert.equal((await sessions(theirs.cli)).statusCode, 401);
    assert.equal((await sessions(theirs.ctx.issueToken())).statusCode, 401);
    const code = (
      await theirs.ctx.app.inject({
        method: "POST",
        url: "/api/web/open-code",
        headers: { authorization: `Bearer ${theirs.cli}` },
      })
    ).json().code;
    const wrong = await ctx.app.inject({ method: "POST", url: "/api/web/session", payload: { code } });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().code, "code_invalid");
    // Guessing: refused, and the guesses are audited.
    for (let i = 0; i < 3; i++)
      assert.equal(
        (await ctx.app.inject({ method: "POST", url: "/api/web/session", payload: { code: "A".repeat(22) } })).statusCode,
        401,
      );
    // The owner: `daisy open` (the command-line credential, 0600) → a link → a session.
    const mineCode = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/web/open-code",
        headers: { authorization: `Bearer ${mine.cli}` },
      })
    ).json();
    assert.match(mineCode.url, /\/#code=/);
    const ok = await ctx.app.inject({ method: "POST", url: "/api/web/session", payload: { code: mineCode.code } });
    assert.equal(ok.statusCode, 200);
    assert.equal((await sessions(ok.json().token)).statusCode, 200);
    // Used once.
    assert.equal(
      (await ctx.app.inject({ method: "POST", url: "/api/web/session", payload: { code: mineCode.code } })).statusCode,
      401,
    );
    // A web session is the web channel: /me says so; a CLI one says cli.
    const me = (t: string) =>
      ctx.app.inject({ url: "/api/me", headers: { authorization: `Bearer ${t}` } }).then((r) => r.json());
    assert.equal((await me(ok.json().token)).channel, "web");
    assert.equal((await me(mine.cli)).channel, "cli");
    // Logout ends it.
    await ctx.app.inject({ method: "DELETE", url: "/api/web/session", headers: { authorization: `Bearer ${ok.json().token}` } });
    assert.equal((await sessions(ok.json().token)).statusCode, 401);
  } finally {
    for (const s of [mine, theirs]) {
      await s.ctx.app.close();
      rmSync(s.dir, { recursive: true, force: true });
    }
  }
});

test("passcode off (a personal machine): the page gets a session without a code — only its own page, only locally", async () => {
  const s = await setup({ shared: false });
  const { ctx } = s;
  try {
    const ask = (headers: Record<string, string>) =>
      ctx.app.inject({ method: "POST", url: "/api/web/session", headers, payload: {} });
    // A script with no Origin: refused.
    assert.equal((await ask({})).statusCode, 401);
    const r = await ask({ origin: "http://localhost:80" });
    assert.equal(r.statusCode, 200);
    const token = r.json().token;
    const h = { authorization: `Bearer ${token}` };
    assert.equal((await ctx.app.inject({ url: "/api/sessions", headers: h })).statusCode, 200);
    // The owner turns the passcode on: that code-less session stops counting.
    const g = s.pin.grant("246810", "cli").grant;
    const on = await ctx.app.inject({
      method: "PUT",
      url: "/api/access/passcode",
      headers: { authorization: `Bearer ${s.cli}`, [PIN_GRANT_HEADER]: g },
      payload: { mode: "on" },
    });
    assert.equal(on.statusCode, 200);
    assert.equal(on.json().passcode.effective, true);
    assert.equal((await ctx.app.inject({ url: "/api/sessions", headers: h })).statusCode, 401);
    assert.equal((await ask({ origin: "http://localhost:80" })).statusCode, 401);
    // Without the PIN the setting does not change.
    const noPin = await ctx.app.inject({
      method: "PUT",
      url: "/api/access/passcode",
      headers: { authorization: `Bearer ${s.cli}` },
      payload: { mode: "off" },
    });
    assert.equal(noPin.statusCode, 403);
    assert.equal(noPin.json().code, "pin_required");
  } finally {
    await ctx.app.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("no PIN service: every 「放别人进来」 route is refused (fails closed)", async () => {
  const s = await setup({ pin: false });
  const { ctx } = s;
  try {
    for (const r of API_ROUTES.filter((x) => x.pin)) {
      const res = await ctx.app.inject({
        method: r.method,
        // P4-01: PIN routes with a path parameter (a contact's id).
        url: fillPath(r.path, Object.fromEntries(Object.keys(r.params.shape).map((k) => [k, "x-placeholder"]))),
        // D-40 ①: a read that wants the PIN on the command line only — asked there.
        headers: { authorization: `Bearer ${r.pinOn ? s.cli : ctx.issueToken()}`, [PIN_GRANT_HEADER]: "anything" },
        payload: r.method === "GET" ? undefined : {},
      });
      assert.equal(res.statusCode, 403, r.id);
      assert.equal(res.json().code, "pin_unavailable", r.id);
    }
  } finally {
    await ctx.app.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("a route outside the table is refused; unknown paths are 404s; the session list needs a credential", async () => {
  const s = await setup();
  const { ctx } = s;
  try {
    // Registered after createApp, under /api, without a definition.
    await ctx.app.close();
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "daisy-access-undef-"));
  const ctx2 = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, sharedHost: () => false });
  try {
    ctx2.app.get("/api/sneaky", async () => ({ secret: true }));
    const r = await ctx2.app.inject({
      url: "/api/sneaky",
      headers: { authorization: `Bearer ${ctx2.issueToken()}` },
    });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().code, "route_not_defined");
    assert.equal((await ctx2.app.inject({ url: "/api/no-such-thing" })).statusCode, 404);
  } finally {
    await ctx2.app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("S-1 / audit: every refusal is recorded (who, face, route, why) and no credential shows up anywhere", async () => {
  const s = await setup();
  const { ctx, cli } = s;
  try {
    const t = await runningTurn(s);
    const web = ctx.issueToken();
    const g = s.pin.grant("246810").grant;
    const replies: string[] = [];
    const go = async (o: any) => {
      const r = await ctx.app.inject(o);
      replies.push(r.body, JSON.stringify(r.headers));
      return r;
    };
    await go({ url: "/api/sessions" });
    await go({ method: "POST", url: "/api/approvals/a/respond", headers: { authorization: `Bearer ${cli}` }, payload: {} });
    await go({ url: `/api/sessions/${t.other}`, headers: { authorization: `Bearer ${t.ai}` } });
    await go({ url: "/api/sessions", headers: { authorization: `Bearer ${web}`, origin: "http://evil.example" } });
    await go({ method: "PUT", url: "/api/access/passcode", headers: { authorization: `Bearer ${web}` }, payload: { mode: "on" } });
    await go({ method: "POST", url: "/api/web/session", payload: { code: "B".repeat(22) } });
    const rows = ctx.store.all("SELECT user_id,action,target FROM audit WHERE action='access.denied'");
    const whys = rows.map((r) => JSON.parse(r.target).why);
    for (const why of ["unauthenticated", "channel_not_allowed", "not_own_session", "cross_site", "pin_required", "code_invalid"])
      assert.ok(whys.includes(why), `没有记下 ${why}`);
    const ai = rows.find((r) => JSON.parse(r.target).why === "not_own_session")!;
    assert.equal(ai.user_id, `ai:${t.own}`);
    assert.deepEqual(
      { ...JSON.parse(ai.target), target: undefined },
      { face: "local", channel: "ai", why: "not_own_session", target: undefined },
    );
    assert.match(JSON.parse(ai.target).target, /^session\.show GET /);
    const cliRow = rows.find((r) => JSON.parse(r.target).why === "channel_not_allowed")!;
    assert.equal(cliRow.user_id, "cli");
    // No credential, grant or code in the audit or in any answer.
    const everything = JSON.stringify(ctx.store.all("SELECT * FROM audit")) + replies.join("\n");
    for (const secret of [cli, web, t.ai, g, "B".repeat(22)])
      assert.ok(!everything.includes(secret), "凭据出现在审计或回答里");
  } finally {
    await ctx.app.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("S-3: credential files are the owner's only; a loose one refuses start-up", async () => {
  const s = await setup();
  const { ctx, dir } = s;
  try {
    await runningTurn(s);
    const mode = (p: string) => (readFileSync(p) && (require_stat(p) & 0o777));
    const keys = join(dir, "keys");
    if (process.platform !== "win32") assert.equal(require_stat(keys) & 0o777, 0o700);
    for (const f of ["cli-credential", "identity-key.json", "web-sessions.json"])
      if (process.platform !== "win32") assert.equal(mode(join(keys, f)), 0o600, f);
    for (const sid of require_dir(join(dir, "run", "ai")))
      if (process.platform !== "win32") assert.equal(mode(join(dir, "run", "ai", sid)), 0o600);
    if (process.platform !== "win32") assert.equal(require_stat(join(dir, "run", "ai")) & 0o777, 0o700);
  } finally {
    await ctx.app.close();
  }
  // Loosened: POSIX mode bits; Windows (P5-05) its ACL — Users may read.
  if (process.platform === "win32")
    execFileSync("icacls", [join(dir, "keys", "cli-credential"), "/grant", "*S-1-5-32-545:(R)"], { stdio: "ignore" });
  else chmodSync(join(dir, "keys", "cli-credential"), 0o644);
  await assert.rejects(
    createApp({ pinGate: false, dataDir: dir, workspaceHome: dir }),
    process.platform === "win32" ? /访问控制过宽/ : /权限 0644 过宽，须为 600 或更严/,
  );
  // A symbolic link in its place: refused (no following links to elsewhere).
  const real = join(dir, "elsewhere");
  writeFileSync(real, readFileSync(join(dir, "keys", "cli-credential")), { mode: 0o600 });
  rmSync(join(dir, "keys", "cli-credential"));
  symlinkSync(real, join(dir, "keys", "cli-credential"));
  await assert.rejects(
    createApp({ pinGate: false, dataDir: dir, workspaceHome: dir }),
    /符号链接/,
  );
  rmSync(join(dir, "keys", "cli-credential"));
  writeFileSync(join(dir, "keys", "cli-credential"), "x", { mode: 0o600 });
  // A credential file replaced with junk: refused, with how to fix it.
  chmodSync(join(dir, "keys", "cli-credential"), 0o600);
  writeFileSync(join(dir, "keys", "cli-credential"), "not-a-credential\n");
  await assert.rejects(
    createApp({ pinGate: false, dataDir: dir, workspaceHome: dir }),
    /删掉它再启动/,
  );
  rmSync(dir, { recursive: true, force: true });
});

import { statSync, readdirSync, symlinkSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { lsofListedAProcess, peerIsOwner, uidOfLoopbackClient } from "../packages/daisy/src/access/peer.ts";
import { translator as zhTranslator } from "../packages/contracts/src/i18n.ts";
import { shippedPacks as zhPacks } from "../packages/contracts/src/i18n-node.ts";
import { exemptText, routeText } from "../packages/contracts/src/api/route.ts";
/** P6-23a: the route table's text is in the packs; these assertions read the Chinese. */
const zh = zhTranslator(zhPacks(), "zh-CN");
const require_stat = (p: string) => statSync(p).mode;
const require_dir = (p: string) => readdirSync(p);

test("review H-1: a code-less session needs the asking process to be the owner's (a service account gets nothing)", async () => {
  const s = await setup({ shared: false, peerIsOwner: false });
  try {
    const r = await s.ctx.app.inject({
      method: "POST",
      url: "/api/web/session",
      headers: { origin: "http://localhost:80", "sec-fetch-site": "same-origin" },
      payload: {},
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "passcode_required");
    const row = s.ctx.store
      .all("SELECT target FROM audit WHERE action='access.denied'")
      .map((x) => JSON.parse(x.target))
      .find((t) => t.why === "passcode_required");
    assert.ok(row);
  } finally {
    await s.ctx.app.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("review H-1: who holds the other end — /proc/net/tcp and lsof readings; a real child process of the owner passes", async () => {
  const table = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:7230 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0",
    "   1: 0100007F:D431 0100007F:7230 01 00000000:00000000 00:00000000 00000000   998        0 2 1 0000000000000000 20 4 30 10 -1",
    "   2: 0100007F:7230 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 3 1 0000000000000000 20 4 30 10 -1",
  ].join("\n");
  // Client port 0xD431 = 54321 → server 0x7230 = 29232: the client end is uid 998.
  assert.equal(uidOfLoopbackClient(table, 54321, 29232), 998);
  assert.equal(uidOfLoopbackClient(table, 54322, 29232), null);
  const t6 = [
    "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid",
    "   0: 0000000000000000FFFF00000100007F:D431 0000000000000000FFFF00000100007F:7230 01 00000000:00000000 00:00000000 00000000  1000 0 9",
  ].join("\n");
  assert.equal(uidOfLoopbackClient(t6, 54321, 29232), 1000);
  assert.equal(lsofListedAProcess("p4242\n"), true);
  assert.equal(lsofListedAProcess(""), false);
  assert.equal(lsofListedAProcess("f12\n"), false);
  // Not a real socket (an in-process request): never the owner.
  assert.equal(peerIsOwner({ raw: { socket: {} } }), false);
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  // The real check: a child process of this account asks over TCP.
  const dir = mkdtempSync(join(tmpdir(), "daisy-peer-"));
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, sharedHost: () => false });
  try {
    await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (ctx.app.server.address() as any).port;
    const code = `const r=require("http").request({host:"127.0.0.1",port:${port},path:"/api/web/session",method:"POST",headers:{"content-type":"application/json",origin:"http://127.0.0.1:${port}"}},(s)=>{console.log(s.statusCode);s.resume()});r.end("{}")`;
    // Asynchronously: this process serves the request meanwhile.
    const child = spawn(process.execPath, ["-e", code]);
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    await new Promise((ok) => child.once("exit", ok));
    assert.equal(out.trim(), "200", err);
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review M-3: a PIN grant works only for the credential that took it; the command line's is used up at once", async () => {
  const s = await setup();
  const { ctx, cli, pin } = s;
  try {
    const put = (token: string, grant: string) =>
      ctx.app.inject({
        method: "PUT",
        url: "/api/access/passcode",
        headers: { authorization: `Bearer ${token}`, [PIN_GRANT_HEADER]: grant },
        payload: { mode: "auto" },
      });
    const web = ctx.issueToken(),
      web2 = ctx.issueToken();
    // A web session's grant, used by the command line: refused — and back.
    const wg = pin.grant("246810", webHolder(web)).grant;
    const x1 = await put(cli, wg);
    assert.equal(x1.statusCode, 403);
    assert.equal(x1.json().code, "pin_required");
    const cg = pin.grant("246810", "cli").grant;
    const x2 = await put(web, cg);
    assert.equal(x2.statusCode, 403);
    assert.equal(x2.json().code, "pin_required");
    // Another web session's grant: refused.
    assert.equal((await put(web2, wg)).statusCode, 403);
    // Its own: through; the web session's grant lasts its few minutes.
    assert.equal((await put(web, wg)).statusCode, 200);
    assert.equal((await put(web, wg)).statusCode, 200);
    // The command line's: once.
    assert.equal((await put(cli, cg)).statusCode, 200);
    const again = await put(cli, cg);
    assert.equal(again.statusCode, 403);
    assert.equal(again.json().code, "pin_required");
  } finally {
    await ctx.app.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
  // A PinService without `consume`: the command line cannot use the PIN at all.
  const dir = mkdtempSync(join(tmpdir(), "daisy-noconsume-"));
  const p = pinDouble();
  delete (p as any).consume;
  const ctx2 = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, pin: p, sharedHost: () => false });
  try {
    const cli2 = readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim();
    const r = await ctx2.app.inject({
      method: "PUT",
      url: "/api/access/passcode",
      headers: { authorization: `Bearer ${cli2}`, [PIN_GRANT_HEADER]: p.grant("246810", "cli").grant },
      payload: { mode: "auto" },
    });
    assert.equal(r.statusCode, 403);
    const web = ctx2.issueToken();
    const ok = await ctx2.app.inject({
      method: "PUT",
      url: "/api/access/passcode",
      headers: { authorization: `Bearer ${web}`, [PIN_GRANT_HEADER]: p.grant("246810", webHolder(web)).grant },
      payload: { mode: "auto" },
    });
    assert.equal(ok.statusCode, 200);
  } finally {
    await ctx2.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review M-2: changes that got through are audited with face and channel, never a credential", async () => {
  const s = await setup();
  const { ctx, cli, pin } = s;
  try {
    const web = ctx.issueToken();
    const cat = (await ctx.app.inject({ url: "/api/catalog", headers: { authorization: `Bearer ${web}` } })).json();
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/sessions?note=x",
      headers: { authorization: `Bearer ${cli}` },
      payload: { agent: "claude", workspaceId: cat.workspaces[0].id, profileId: cat.profiles[0].id },
    });
    assert.equal(created.statusCode, 200);
    const g = pin.grant("246810", webHolder(web)).grant;
    await ctx.app.inject({
      method: "PUT",
      url: "/api/access/passcode",
      headers: { authorization: `Bearer ${web}`, [PIN_GRANT_HEADER]: g },
      payload: { mode: "on" },
    });
    const code = (await ctx.app.inject({ method: "POST", url: "/api/web/open-code", headers: { authorization: `Bearer ${cli}` } })).json().code;
    await ctx.app.inject({ method: "POST", url: "/api/web/session", payload: { code } });
    const rows = ctx.store.all("SELECT user_id,action,target FROM audit");
    const create = rows.find((r) => r.action === "api.session.create")!;
    assert.equal(create.user_id, "cli");
    assert.deepEqual(JSON.parse(create.target), { face: "local", channel: "cli", status: 200 });
    const pass = rows.find((r) => r.action === "api.settings.passcode")!;
    assert.deepEqual(JSON.parse(pass.target), { face: "local", channel: "web", status: 200 });
    const setting = rows.find((r) => r.action === "access.passcode")!;
    assert.equal(setting.user_id, "web");
    assert.deepEqual(JSON.parse(setting.target), { face: "local", channel: "web", mode: "on" });
    // The command line trading a code for a web session (5.11 accepts it)
    // leaves both halves: web.code by cli, web.session.open on the web.
    const wc = rows.find((r) => r.action === "web.code")!;
    assert.equal(wc.user_id, "cli");
    assert.equal(JSON.parse(wc.target).channel, "cli");
    assert.equal(JSON.parse(rows.find((r) => r.action === "web.session.open")!.target).channel, "web");
    // Reads are not audited; nothing secret anywhere.
    assert.ok(!rows.some((r) => r.action === "api.workspace.catalog"));
    const all = JSON.stringify(rows);
    for (const secret of [cli, web, g, code, "note=x"]) assert.ok(!all.includes(secret), secret);
  } finally {
    await ctx.app.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("review L-3 / L-5 / L-7: plugin routes outside the table, stale AI credentials, the session table when full", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-low-"));
  // A stale AI credential from a previous run: gone at start.
  mkdirSync(join(dir, "run", "ai"), { recursive: true });
  writeFileSync(join(dir, "run", "ai", "old-session"), "stale");
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, sharedHost: () => false });
  try {
    assert.equal(existsSync(join(dir, "run", "ai", "old-session")), false);
    // A route registered outside the table, not under /api: refused too.
    ctx.app.get("/plugin-thing", async () => ({ secret: true }));
    const r = await ctx.app.inject({ url: "/plugin-thing" });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().code, "route_not_defined");
    // The terminal page's assets stay public (not a secret).
    assert.notEqual((await ctx.app.inject({ url: "/terminal-assets/nothing.js" })).json?.()?.code, "route_not_defined");
    // Full session table: code-less sessions go before ones made with a code.
    const keep = ctx.access.web.open("local", true).token;
    for (let i = 0; i < 250; i++) ctx.access.web.open("local", false);
    assert.ok(ctx.access.web.find(keep), "用口令换的会话被挤掉了");
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review L-7: failed code-less asks never use up the budget of the link `daisy open` printed", async () => {
  const s = await setup({ shared: true });
  const { ctx, cli } = s;
  try {
    const ask = (payload: any) =>
      ctx.app.inject({ method: "POST", url: "/api/web/session", headers: { origin: "http://localhost:80" }, payload });
    for (let i = 0; i < 25; i++) assert.ok([401, 429].includes((await ask({})).statusCode));
    assert.equal((await ask({})).statusCode, 429, "code-less asks are limited");
    const code = (
      await ctx.app.inject({ method: "POST", url: "/api/web/open-code", headers: { authorization: `Bearer ${cli}` } })
    ).json().code;
    assert.equal((await ask({ code })).statusCode, 200);
  } finally {
    await ctx.app.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});
