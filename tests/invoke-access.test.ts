/**
 * P4-03 调用授权 (总纲 5.2 开放范围, 5.4 「被别的智能体调用」, 5.6, 5.11, D-15,
 * D-19, ADR-122): who may call which agent, the owner's card (永久通过 /
 * 仅本次 / 拒绝, 7 days), grants per agent × person, and taking them back
 * — which stops calls in progress. T-1, T-3, T-4, T-5 at the admission /
 * grant layer (end to end over A2A is P4-04's).
 *
 * Refusals first. A is a running app (createApp, a PIN stand-in); B, C and
 * D are other Daisies that sign their own cross-Daisy tokens; A's agents
 * come from a stub resolver (P4-06 / P4-07 register the real ones):
 * 研究助手 public (open to all contacts unless set otherwise), 代码助手
 * public, 私人助手 private.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { api } from "../packages/contracts/src/api/index.ts";
import { fillPath, type AnyRoute } from "../packages/contracts/src/index.ts";
import { CARD_LIMITS } from "../packages/contracts/src/limits.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { createApp } from "../packages/daisy/src/app.ts";
import { runtimeFile } from "../packages/daisy/src/platform/paths.ts";
import { issuerPersonKey, type AgentInfo, type StopReason } from "../packages/daisy/src/invoke/invoke-access.ts";
import { daisy as cliRun, testIo } from "./cli-fixture.ts";
import { daisy, runningTurn, OWNER_SUB, type Daisy } from "./fixtures/daisy-with-issuer.ts";
import { fakeIssuer } from "./fixtures/fake-issuer.ts";
import { peerDaisy, type PeerDaisy } from "./fixtures/peer-daisy.ts";

const I = api.invoke;
const DAY = 24 * 3600_000;
const webHolder = (token: string) => `web:${createHash("sha256").update(token).digest("hex")}`;

const AGENTS: Record<string, AgentInfo> = {
  research: { id: "research", kind: "public", name: "研究助手", sessionId: null },
  code: { id: "code", kind: "public", name: "代码助手", sessionId: null },
  secret: { id: "secret", kind: "private", name: "私人助手", sessionId: null },
};

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

/** Everything that would be "A received a card": call cards, their notices and outlet events. */
const cardsRaised = (s: Daisy) =>
  (s.ctx.store.one("SELECT COUNT(*) n FROM invoke_requests").n as number) +
  (s.ctx.store.one("SELECT COUNT(*) n FROM event_outbox").n as number) +
  (s.ctx.store.one("SELECT COUNT(*) n FROM notification_events").n as number);

async function setup(o: { whitelist?: boolean } = {}) {
  const a = await daisy();
  const b = await peerDaisy("B");
  const c = await peerDaisy("C");
  const d = await peerDaisy("D");
  const inv = a.ctx.access.invoke;
  inv.agents.add((id) => AGENTS[id] ?? null);
  for (const p of [b, d]) {
    const r = await call(a, api.contacts.contactImport, { body: { card: p.text, ...(o.whitelist && p === b ? { whitelist: true } : {}) } });
    assert.equal(r.statusCode, 200, r.body);
  }
  /** The principal the guard makes of this peer's token (what P4-04 will hand `check`). */
  const who = async (p: PeerDaisy) => (await a.ctx.access.guard.identify(await p.token(a.urn), "external"))!;
  const close = async () => {
    await a.close();
    for (const p of [b, c, d]) p.close();
  };
  return { a, b, c, d, inv, who, close };
}

/** A settlement that should already have arrived: fail rather than hang. */
const soon = <T>(p: Promise<T>) =>
  Promise.race([p, new Promise<T>((_, no) => (setTimeout(() => no(new Error("还在等：卡片没有了结")), 2000) as any).unref())]);

/** A stand-in for P4-04's running call: begins through the authorization (checked now), records being stopped. */
function running(inv: any, p: any, agentId: string, ticket?: string) {
  const stopped: StopReason[] = [];
  const h = inv.begin(p, agentId, { ...(ticket ? { ticket } : {}), stop: (why: StopReason) => stopped.push(why) });
  return { h, stopped };
}

// ── refusals first ────────────────────────────────────────────────────────

test("invoke routes: daisy:grant on the owner's channels only — never the AI, never a visitor; deciding, revoking and the range are letsIn (PIN), reading takes the PIN on the command line only", async () => {
  const s = await setup();
  try {
    const { a, b } = s;
    const t = await runningTurn(a);
    const web = a.ctx.issueToken();
    const routes = Object.values(I);
    // P4-05 adds 是否允许办 / 办的权限模式 to the group (ADR-124), P4-06 公开 (ADR-125).
    assert.equal(routes.length, 10);
    const letsIn: Record<string, string | undefined> = Object.fromEntries(routes.map((r) => [r.id, r.letsIn]));
    assert.deepEqual(letsIn, {
      "grant.requestList": undefined,
      "grant.requestShow": undefined,
      "grant.requestDecide": "invoke-request",
      "grant.grantList": undefined,
      "grant.grantRevoke": "invoke-grant",
      "grant.audienceShow": undefined,
      "grant.audienceSet": "agent-audience",
      "grant.actShow": undefined,
      "grant.actSet": "agent-exposure",
      "grant.publicSet": "agent-exposure",
    });
    for (const r of routes) {
      assert.equal(r.scope, "daisy:grant", r.id);
      // D-40 ①: the changes take the PIN everywhere, the reads on the command line only.
      assert.equal(r.pin, true, r.id);
      assert.deepEqual(r.pinOn, r.method === "GET" ? ["cli"] : undefined, r.id);
      assert.ok(!r.channels.includes("ai"), r.id);
    }
    // Something to act on: a card, a grant.
    const card = s.inv.check(await s.who(b), "research");
    assert.equal(card.outcome, "pending");
    const rid = (card as any).requestId as string;
    const before = JSON.stringify([
      a.ctx.store.all("SELECT id,status FROM invoke_requests"),
      a.ctx.store.all("SELECT * FROM invoke_grants"),
      a.ctx.store.all("SELECT * FROM invoke_audiences"),
    ]);
    // A fresh cross-Daisy token per request (each is good once, P4-04).
    const visitor = () => b.token(a.urn);
    const params = { rid, gid: "g-1", aid: "research", id: "research" };
    const bodyOf = (r: AnyRoute) =>
      r.id === "grant.requestDecide" ? { decision: "always" } : r.id === "grant.audienceSet" ? { openTo: "listed", listed: [] } : r.id === "grant.actSet" ? { act: false } : r.id === "grant.publicSet" ? { public: true } : {};
    for (const r of routes) {
      const try_ = (headers: Record<string, string>) => call(a, r, { params, body: bodyOf(r), headers });
      assert.equal((await try_({})).statusCode, 401, r.id);
      const read = r.method === "GET";
      for (const h of [a.asCli, { authorization: `Bearer ${web}` }]) {
        const x = await try_(h);
        if (read && h !== a.asCli) {
          // D-40 ①: the web page reads without a PIN (an unknown id is the handler's 404).
          assert.ok(![401, 403].includes(x.statusCode), `${r.id}: ${x.statusCode} ${x.body}`);
          continue;
        }
        assert.equal(x.statusCode, 403, r.id);
        assert.equal(x.json().code, "pin_required", r.id);
      }
      // The web page's grant is not the command line's.
      const crossed = await try_({ ...a.asCli, [PIN_GRANT_HEADER]: a.pin.grant("246810", webHolder(web)).grant });
      assert.equal(crossed.json().code, "pin_required", r.id);
      // A read on the command line with its own grant: through (not a 500 — reads persist nothing).
      if (read) {
        const x = await try_({ ...a.asCli, [PIN_GRANT_HEADER]: a.pin.grant("246810", "cli").grant });
        assert.ok(![401, 403, 500].includes(x.statusCode), `${r.id}: ${x.statusCode} ${x.body}`);
      }
      // The AI, without and with a grant (T-6's rule, 5.11 「放别人进来」 never the AI's; D-40: nor reading).
      for (const h of [{}, { [PIN_GRANT_HEADER]: a.pin.grant("246810", "ai").grant }] as Record<string, string>[]) {
        const ai = await try_({ authorization: `Bearer ${t.ai}`, ...h });
        assert.equal(ai.statusCode, 403, r.id);
        assert.equal(ai.json().code, "channel_not_allowed", r.id);
      }
      // The caller itself (a contact's cross-Daisy token): A2A only.
      const v = await try_({ authorization: `Bearer ${await visitor()}` });
      assert.equal(v.statusCode, 403, r.id);
      assert.equal(v.json().code, "a2a_only", r.id);
    }
    // Nothing changed.
    assert.equal(
      JSON.stringify([
        a.ctx.store.all("SELECT id,status FROM invoke_requests"),
        a.ctx.store.all("SELECT * FROM invoke_grants"),
        a.ctx.store.all("SELECT * FROM invoke_audiences"),
      ]),
      before,
    );
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM agent_act").n, 0, "办 settings untouched"
    );
    // The 「审批」 page's answer route does not decide a call card, even for the owner on the web page.
    const resp = await a.ctx.app.inject({
      method: "POST",
      url: `/api/approvals/${encodeURIComponent(rid)}/respond`,
      headers: { authorization: `Bearer ${web}` },
      payload: { decision: "always" },
    });
    assert.equal(resp.statusCode, 403, resp.body);
    assert.equal(resp.json().code, "request_needs_pin");
    assert.match(resp.json().error, /PIN/);
    assert.equal(s.inv.request(rid).status, "pending");
  } finally {
    await s.close();
  }
});

test("T-2 / T-3: strangers, private agents and people outside the range are refused outright — no card, no notice, no event", async () => {
  const s = await setup();
  try {
    const { a, b, c, d, inv } = s;
    const before = cardsRaised(a);
    // C never added (a stranger): its token is nobody's; an unknown agent says nothing more.
    const pc = await a.ctx.access.guard.identify(await c.token(a.urn), "external");
    assert.equal(pc, null);
    for (const agent of ["research", "code", "secret", "nope"]) {
      const r = inv.check(pc, agent);
      assert.equal(r.outcome, "refused", agent);
      assert.equal((r as any).reason, "not_recognised", agent);
    }
    // B, recognised: a private agent → refused (5.6 私人助手).
    const pb = await s.who(b);
    // Review L-6: a private agent reads like a missing one.
    assert.deepEqual(inv.check(pb, "secret"), { outcome: "refused", reason: "agent_unknown", message: "没有这个 agent，或它不对你开放" });
    // An agent that does not exist.
    assert.equal((inv.check(pb, "nope") as any).reason, "agent_unknown");
    // 代码助手 open to listed people only, D listed, B not → refused (T-3).
    const set = await call(a, I.audienceSet, { params: { aid: "code" }, body: { openTo: "listed", listed: [d.card.id.slice(0, 12)] } });
    assert.equal(set.statusCode, 200, set.body);
    assert.deepEqual(set.json().listed.map((p: any) => p.contactId), [d.card.id]);
    assert.equal((inv.check(pb, "code") as any).reason, "not_listed");
    // … even with a standing grant from before the range narrowed, or on the whitelist.
    a.ctx.store.run("INSERT INTO invoke_grants(id,agent_id,person,contact_id,subject,name,granted_at) VALUES('g-old','code',?,?,?,?,0)", b.card.id, b.card.id, b.self.urn, "B");
    a.ctx.access.contacts.setWhitelist(b.card.id, true);
    assert.equal((inv.check(pb, "code") as any).reason, "not_listed");
    a.ctx.access.contacts.setWhitelist(b.card.id, false);
    // The owner's own AI (its working credential) is not a caller here.
    const t = await runningTurn(a);
    const ai = await a.ctx.access.guard.identify(t.ai, "local");
    assert.equal((inv.check(ai, "research") as any).reason, "not_recognised");
    // None of it raised a card, a notice or an outlet event.
    assert.equal(cardsRaised(a), before);
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_requests").n, 0);
    // The agent card (5.11 外面来的): seen by those in range only.
    assert.equal(inv.canSee(pc, "research"), false);
    assert.equal(inv.canSee(pb, "research"), true);
    assert.equal(inv.canSee(pb, "code"), false);
    assert.equal(inv.canSee(await s.who(d), "code"), true);
    assert.equal(inv.canSee(pb, "secret"), false);
    assert.equal(cardsRaised(a), before, "canSee never raises a card");
  } finally {
    await s.close();
  }
});

test("T-4: a granted caller still cannot read A's AI's conversation, workspace or settings — the grant is only the call", async () => {
  const s = await setup();
  try {
    const { a, b, inv } = s;
    const t = await runningTurn(a);
    // B gets a permanent grant for 研究助手 (the owner, with the PIN).
    const r = inv.check(await s.who(b), "research");
    const ok = await call(a, I.requestDecide, { params: { rid: (r as any).requestId }, body: { decision: "always" } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(inv.check(await s.who(b), "research").outcome, "allowed");
    // A fresh token per request (each is good once, P4-04).
    const bt = async () => ({ authorization: `Bearer ${await b.token(a.urn)}` });
    // Every local route — the conversation, its events, the workspace, the settings, the grants — refuses B.
    const reads = [
      `/api/sessions/${t.own}`,
      `/api/sessions/${t.own}/items?before=x`,
      `/api/sessions/${t.own}/events`,
      `/api/sessions`,
      `/api/catalog`,
      `/api/approvals`,
      `/api/grants`,
      `/api/requests`,
      `/api/contacts`,
      `/api/agents/research/audience`,
    ];
    for (const url of reads) {
      const x = await a.ctx.app.inject({ url, headers: await bt() });
      assert.equal(x.statusCode, 403, url);
      assert.equal(x.json().code, "a2a_only", url);
    }
    // The grant itself holds nothing but agent × person (D-19 只含调用).
    assert.deepEqual(Object.keys(a.ctx.store.one("SELECT * FROM invoke_grants")).sort(), [
      "agent_id",
      "contact_id",
      "granted_at",
      "id",
      "issuer",
      "name",
      "person",
      "request_id",
      "subject",
    ]);
    // Not for another agent (粒度：每个 agent 乘每个人).
    assert.equal(inv.check(await s.who(b), "code").outcome, "pending");
  } finally {
    await s.close();
  }
});

// ── T-1: the card ─────────────────────────────────────────────────────────

test("T-1: B calls an agent open to all contacts — A gets one card (7 days, 永久通过 / 仅本次 / 拒绝); 永久通过 runs the waiting calls; B's next call needs no card", async () => {
  const s = await setup();
  try {
    const { a, b, inv } = s;
    const pb = await s.who(b);
    const first = inv.check(pb, "research");
    assert.equal(first.outcome, "pending");
    assert.equal((first as any).raised, true);
    const rid = (first as any).requestId as string;
    assert.match(rid, /^call:[0-9a-f-]{36}$/);
    const w1 = inv.wait(first as any);
    // A second call while it waits joins the same card (one per agent × person).
    const second = inv.check(pb, "research");
    assert.deepEqual([second.outcome, (second as any).requestId, (second as any).raised], ["pending", rid, false]);
    const w2 = inv.wait(second as any);
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_requests").n, 1);
    // The card, as the owner sees it (with the PIN): who, which agent, 7 days, three choices.
    const list = await call(a, I.requestList);
    assert.equal(list.statusCode, 200, list.body);
    const [card] = list.json().requests;
    assert.equal(card.id, rid);
    assert.equal(card.status, "pending");
    assert.deepEqual(card.agent, { id: "research", name: "研究助手", sessionId: null });
    assert.equal(card.caller.contactId, b.card.id);
    assert.equal(card.caller.name, "B");
    assert.equal(card.caller.actor, "agent:s-1");
    assert.equal(card.calls, 2);
    assert.equal(card.expiresAt - card.created, 7 * DAY);
    assert.equal(CARD_LIMITS.callCardTtlMs, 7 * DAY);
    assert.deepEqual(card.options, [
      { key: "always", label: "永久通过" },
      { key: "once", label: "仅本次" },
      { key: "reject", label: "拒绝" },
    ]);
    // … in the 「审批」 list (no PIN to read), as kind "call", with where to decide it.
    const web = { authorization: `Bearer ${a.ctx.issueToken()}` };
    const inbox = (await a.ctx.app.inject({ url: "/api/approvals", headers: web })).json().items;
    const item = inbox.find((x: any) => x.id === rid);
    assert.ok(item, "the call card is in the approvals list");
    assert.equal(item.kind, "call");
    assert.equal(item.status, "pending");
    assert.equal(item.expiresAt, card.expiresAt);
    // Review M-3: how many calls wait, shown on the card.
    assert.equal(item.title, "B 请求调用「研究助手」（2 次调用在等）");
    assert.equal(item.waiting, 2);
    assert.equal(item.calls, 2);
    assert.deepEqual(item.actors, ["agent:s-1"]);
    assert.deepEqual(item.options.map((o: any) => [o.key, o.label]), [
      ["always", "永久通过"],
      ["once", "仅本次"],
      ["reject", "拒绝"],
    ]);
    assert.deepEqual(item.respondVia, { method: "POST", path: `/api/requests/${encodeURIComponent(rid)}/decision`, pin: true });
    assert.equal(item.caller.contactId, b.card.id);
    // … a notice for the owner, and one 「有人想调用」 event on the outlet (P2-03), with the 7 days.
    // (One notice item — renewed when the second call joined, so one or two revisions.)
    const n = a.ctx.store.all("SELECT DISTINCT item_key FROM notification_events WHERE subject=?", rid);
    assert.equal(n.length, 1);
    const ev = a.ctx.store.all("SELECT * FROM event_outbox");
    assert.equal(ev.length, 1);
    assert.match(ev[0].type ?? JSON.stringify(ev[0]), /invocation|invoke|call/);
    // 永久通过 (with the PIN): both waiting calls run; a grant is written.
    const ok = await call(a, I.requestDecide, { params: { rid }, body: { decision: "always", note: "合作项目" } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().status, "approved");
    assert.equal(ok.json().decision.choice, "always");
    assert.deepEqual(await w1, { outcome: "allowed", via: "grant" });
    assert.deepEqual(await w2, { outcome: "allowed", via: "grant" });
    // The same decision again answers the card as it stands; another is refused.
    assert.equal((await call(a, I.requestDecide, { params: { rid }, body: { decision: "always" } })).statusCode, 200);
    const other = await call(a, I.requestDecide, { params: { rid }, body: { decision: "reject" } });
    assert.equal(other.statusCode, 409);
    assert.equal(other.json().code, "request_closed");
    // B calls again: straight through, no new card.
    const before = cardsRaised(a);
    const again = inv.check(pb, "research");
    assert.equal(again.outcome, "allowed");
    assert.equal((again as any).via, "grant");
    assert.equal(cardsRaised(a), before);
    const grants = (await call(a, I.grantList)).json().grants;
    assert.equal(grants.length, 1);
    assert.deepEqual([grants[0].agent.id, grants[0].person.contactId, grants[0].requestId], ["research", b.card.id, rid]);
    // The card closed everywhere: the approvals list, the notice, the outlet.
    const closed = (await a.ctx.app.inject({ url: `/api/approvals/${encodeURIComponent(rid)}`, headers: web })).json();
    assert.equal(closed.status, "approved");
    assert.equal(closed.decision.label, "永久通过");
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM event_outbox").n, 2);
    // The audit: raised by the system, decided by the command line.
    const audit = a.ctx.store.all("SELECT user_id,action FROM audit WHERE action LIKE 'invoke.%' ORDER BY created, rowid");
    assert.deepEqual(audit.map((x) => [x.user_id, x.action]), [
      ["system", "invoke.request"],
      ["cli", "invoke.request.always"],
    ]);
  } finally {
    await s.close();
  }
});

test("仅本次 lets the waiting call through and asks again next time; 拒绝 refuses it, and the same person is refused outright for 10 minutes", async () => {
  const s = await setup();
  try {
    const { a, b, d, inv } = s;
    const pb = await s.who(b);
    const r1 = inv.check(pb, "research") as any;
    const w = inv.wait(r1);
    assert.equal((await call(a, I.requestDecide, { params: { rid: r1.requestId }, body: { decision: "once" } })).statusCode, 200);
    assert.deepEqual(await w, { outcome: "allowed", via: "once" });
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_grants").n, 0, "仅本次 writes no grant");
    const r2 = inv.check(pb, "research") as any;
    assert.equal(r2.outcome, "pending");
    assert.equal(r2.raised, true);
    assert.notEqual(r2.requestId, r1.requestId);
    // 拒绝 (the bare id works too).
    const w2 = inv.wait(r2);
    const no = await call(a, I.requestDecide, { params: { rid: r2.requestId.slice(5) }, body: { decision: "reject" } });
    assert.equal(no.statusCode, 200, no.body);
    assert.equal(no.json().status, "rejected");
    assert.deepEqual(await w2, { outcome: "refused", reason: "rejected", message: "主人拒绝了这次调用" });
    // Right after: refused without a card (不会重试).
    const before = cardsRaised(a);
    assert.equal((inv.check(pb, "research") as any).reason, "rejected_recently");
    assert.equal(cardsRaised(a), before);
    // Another agent, another person: not affected.
    assert.equal(inv.check(pb, "code").outcome, "pending");
    assert.equal(inv.check(await s.who(d), "research").outcome, "pending");
    // Ten minutes later: a new card.
    a.ctx.store.run("UPDATE invoke_requests SET decided_at=decided_at-? WHERE decision='reject'", CARD_LIMITS.callCooldownMs);
    assert.equal(inv.check(pb, "research").outcome, "pending");
  } finally {
    await s.close();
  }
});

test("a card nobody answers expires after 7 days: the waiting calls are refused, it cannot be decided any more", async () => {
  const s = await setup();
  try {
    const { a, b, inv } = s;
    const r = inv.check(await s.who(b), "research") as any;
    const w = inv.wait(r);
    a.ctx.store.run("UPDATE invoke_requests SET created=created-?, expires_at=expires_at-?", 7 * DAY, 7 * DAY);
    assert.equal(inv.sweep(), 1);
    assert.deepEqual(await w, { outcome: "refused", reason: "expired", message: "主人七天没有处理这次调用请求，已过期" });
    const x = await call(a, I.requestDecide, { params: { rid: r.requestId }, body: { decision: "always" } });
    assert.equal(x.statusCode, 409);
    assert.equal(x.json().code, "request_closed");
    assert.match(x.json().error, /过期/);
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_grants").n, 0);
    const item = (await a.ctx.app.inject({ url: `/api/approvals?status=all`, headers: { authorization: `Bearer ${a.ctx.issueToken()}` } }))
      .json()
      .items.find((i: any) => i.id === r.requestId);
    assert.equal(item.status, "expired");
    // Waiting after it ended answers at once; the next call raises a new card.
    assert.equal((await inv.wait(r)).outcome, "refused");
    assert.equal((inv.check(await s.who(b), "research") as any).raised, true);
    assert.ok(a.ctx.store.all("SELECT action FROM audit").some((x) => x.action === "invoke.request.expired"));
  } finally {
    await s.close();
  }
});

test("T-10 with grants: a whitelisted contact is admitted with no card; a card whose situation changed cannot be approved", async () => {
  const s = await setup({ whitelist: true });
  try {
    const { a, b, d, inv } = s;
    const before = cardsRaised(a);
    assert.deepEqual(
      (({ outcome, via }) => ({ outcome, via }))(inv.check(await s.who(b), "research") as any),
      { outcome: "allowed", via: "whitelist" },
    );
    assert.equal(cardsRaised(a), before);
    // D's card is pending; then A makes 研究助手 listed-only without D: the card is void.
    const r = inv.check(await s.who(d), "research") as any;
    const w = inv.wait(r);
    const set = await call(a, I.audienceSet, { params: { aid: "research" }, body: { openTo: "listed", listed: [b.card.id] } });
    assert.equal(set.statusCode, 200, set.body);
    const settled = await w;
    assert.equal(settled.outcome, "refused");
    assert.equal((settled as any).reason, "canceled");
    assert.equal(inv.request(r.requestId).status, "canceled");
    // A card raised, then the person removed before the owner decides: 409 request_stale on approve.
    await call(a, I.audienceSet, { params: { aid: "research" }, body: { openTo: "all" } });
    const r2 = inv.check(await s.who(d), "research") as any;
    assert.equal(r2.outcome, "pending");
    a.ctx.store.run("DELETE FROM contacts WHERE id=?", d.card.id); // bypassing onRemoved: the decide-time check
    const x = await call(a, I.requestDecide, { params: { rid: r2.requestId }, body: { decision: "always" } });
    assert.equal(x.statusCode, 409, x.body);
    assert.equal(x.json().code, "request_stale");
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_grants").n, 0);
  } finally {
    await s.close();
  }
});

// ── T-5: taking it back stops the call ────────────────────────────────────

test("T-5: A revokes B's grant while B's call runs — the call is stopped; B's next call needs approval again", async () => {
  const s = await setup();
  try {
    const { a, b, inv } = s;
    const pb = await s.who(b);
    const r = inv.check(pb, "research") as any;
    await call(a, I.requestDecide, { params: { rid: r.requestId }, body: { decision: "always" } });
    const ok = inv.check(pb, "research") as any;
    assert.equal(ok.via, "grant");
    // Two calls of B in progress (研究助手 by the grant, 代码助手 by 仅本次), and D's.
    const mine = running(inv, pb, "research");
    const r2 = inv.check(pb, "code") as any;
    await call(a, I.requestDecide, { params: { rid: r2.requestId }, body: { decision: "once" } });
    const onCode = running(inv, pb, "code", r2.ticket);
    const pd = await s.who(s.d);
    const rd = inv.check(pd, "research") as any;
    await call(a, I.requestDecide, { params: { rid: rd.requestId }, body: { decision: "always" } });
    const theirs = running(inv, pd, "research");
    assert.equal(inv.calls.size, 3);
    // Revoking needs the PIN.
    const gid = (await call(a, I.grantList, { query: `contact=${b.card.id}` })).json().grants[0].id;
    const noPin = await call(a, I.grantRevoke, { params: { gid }, headers: a.asCli });
    assert.equal(noPin.json().code, "pin_required");
    assert.equal(mine.stopped.length, 0);
    const rev = await call(a, I.grantRevoke, { params: { gid } });
    assert.equal(rev.statusCode, 200, rev.body);
    assert.equal(rev.json().stopped, 1);
    // B's call on 研究助手 is stopped, and told why; the others run on.
    assert.deepEqual(mine.stopped, [{ code: "grant_revoked", message: "主人撤销了你调用这个 agent 的授权" }]);
    assert.equal(mine.h.active, false);
    assert.equal(onCode.stopped.length, 0);
    assert.equal(theirs.stopped.length, 0);
    assert.equal(inv.calls.size, 2);
    // A 仅本次 call stands on its own: re-asking about 代码助手 (no grant there) leaves it running.
    assert.equal((await call(a, I.audienceSet, { params: { aid: "code" }, body: { openTo: "all" } })).json().stopped, 0);
    assert.equal(onCode.stopped.length, 0);
    // B's next call asks again (a new card).
    const next = inv.check(pb, "research") as any;
    assert.equal(next.outcome, "pending");
    assert.equal(next.raised, true);
    // Revoking a grant twice: 404.
    assert.equal((await call(a, I.grantRevoke, { params: { gid } })).json().code, "grant_not_found");
    assert.ok(a.ctx.store.all("SELECT action FROM audit").some((x) => x.action === "invoke.grant.revoke"));
  } finally {
    await s.close();
  }
});

test("taking back in other ways stops calls too: off the whitelist, a narrower range, the contact removed (in the removal's transaction), the agent made private", async () => {
  const s = await setup({ whitelist: true });
  try {
    const { a, b, d, inv } = s;
    const pb = await s.who(b);
    const pd = await s.who(d);
    // B by the whitelist, then taken off it.
    const viaList = running(inv, pb, "research");
    const off = await call(a, api.contacts.contactWhitelistRemove, { params: { id: b.card.id } });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(viaList.stopped.length, 1);
    assert.equal(viaList.stopped[0].code, "not_admitted");
    // … but a call by a grant survives taking someone off the whitelist.
    const r = inv.check(pb, "research") as any;
    await call(a, I.requestDecide, { params: { rid: r.requestId }, body: { decision: "always" } });
    await call(a, api.contacts.contactWhitelistAdd, { params: { id: b.card.id } });
    const byGrant = running(inv, pb, "research");
    await call(a, api.contacts.contactWhitelistRemove, { params: { id: b.card.id } });
    assert.equal(byGrant.stopped.length, 0);
    // A narrower range: 研究助手 only for D — B's call stops, D's (listed) runs.
    const rd = inv.check(pd, "research") as any;
    await call(a, I.requestDecide, { params: { rid: rd.requestId }, body: { decision: "once" } });
    const dOnce = running(inv, pd, "research", rd.ticket);
    const set = await call(a, I.audienceSet, { params: { aid: "research" }, body: { openTo: "listed", listed: [d.card.id] } });
    assert.equal(set.json().stopped, 1);
    assert.equal(byGrant.stopped.length, 1);
    assert.equal(dOnce.stopped.length, 0);
    // Removing D: their calls stop, their grants / list places / cards go — in the removal.
    const dCode = inv.check(pd, "code") as any;
    const wait = inv.wait(dCode);
    await call(a, I.requestDecide, { params: { rid: dCode.requestId }, body: { decision: "always" } });
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_grants WHERE person=?", d.card.id).n, 1);
    const dRun = running(inv, pd, "code");
    assert.equal(inv.check(pd, "research").outcome, "allowed"); // listed
    // A card of D's still pending (on an agent B's grant does not cover).
    const dLater = inv.check(pd, "fresh");
    assert.equal(dLater.outcome, "refused");
    const rm = await call(a, api.contacts.contactRemove, { params: { id: d.card.id } });
    assert.equal(rm.statusCode, 200, rm.body);
    assert.equal(dOnce.stopped[0]?.code, "contact_removed");
    assert.equal(dRun.stopped[0]?.code, "contact_removed");
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_grants WHERE person=?", d.card.id).n, 0);
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_audience_members WHERE person=?", d.card.id).n, 0);
    assert.deepEqual(await wait, { outcome: "allowed", via: "grant" }, "decided before the removal");
    // A listener that throws undoes the removal — and the grants with it (one transaction).
    const e = await peerDaisy("E");
    try {
      await call(a, api.contacts.contactImport, { body: { card: e.text } });
      const pe = (await a.ctx.access.guard.identify(await e.token(a.urn), "external"))!;
      const re = inv.check(pe, "code") as any;
      await call(a, I.requestDecide, { params: { rid: re.requestId }, body: { decision: "always" } });
      let boom = true;
      a.ctx.access.contacts.onRemoved(() => {
        if (boom) throw new Error("no");
      });
      assert.throws(() => a.ctx.access.contacts.remove(e.card.id));
      assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_grants WHERE person=?", e.card.id).n, 1);
      boom = false;
    } finally {
      e.close();
    }
    // The agent made private (P4-06 will call recheck after it does).
    a.ctx.access.contacts.setWhitelist(b.card.id, true);
    const bAgain = running(inv, pb, "code");
    AGENTS.code = { ...AGENTS.code, kind: "private" };
    try {
      assert.equal(inv.recheck({ agentId: "code" }), 1);
      assert.equal(bAgain.stopped.length, 1);
    } finally {
      AGENTS.code = { ...AGENTS.code, kind: "public" };
    }
  } finally {
    await s.close();
  }
});

// ── the range ────────────────────────────────────────────────────────────

test("开放范围: two choices; the default is all contacts; listed people by identity number or prefix; a typo changes nothing", async () => {
  const s = await setup();
  try {
    const { a, b, d } = s;
    const show = await call(a, I.audienceShow, { params: { aid: "research" } });
    assert.equal(show.statusCode, 200, show.body);
    assert.deepEqual(show.json(), { agentId: "research", kind: "public", openTo: "all", listed: [], set: false, updatedAt: null });
    assert.equal((await call(a, I.audienceShow, { params: { aid: "nope" } })).json().code, "agent_not_found");
    assert.equal((await call(a, I.audienceSet, { params: { aid: "nope" }, body: { openTo: "all" } })).json().code, "agent_not_found");
    const bad = await call(a, I.audienceSet, { params: { aid: "research" }, body: { openTo: "listed", listed: [b.card.id, "zzzzzzzzzz"] } });
    assert.equal(bad.statusCode, 404);
    assert.equal(bad.json().code, "contact_not_found");
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_audiences").n, 0, "nothing changed");
    assert.equal((await call(a, I.audienceSet, { params: { aid: "research" }, body: { openTo: "everyone" } })).statusCode, 400);
    const ok = await call(a, I.audienceSet, { params: { aid: "research" }, body: { openTo: "listed", listed: [b.card.id, d.card.id.slice(0, 10), b.card.id] } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(ok.json().listed.map((p: any) => p.name), ["B", "D"]);
    // Back to all: the list is kept (for next time), not used.
    const all = await call(a, I.audienceSet, { params: { aid: "research" }, body: { openTo: "all" } });
    assert.equal(all.json().openTo, "all");
    assert.equal(all.json().listed.length, 2);
    assert.equal(s.inv.check(await s.who(b), "research").outcome, "pending");
    // A private agent: the range can be set (for when it is made public), it is still refused.
    assert.equal((await call(a, I.audienceSet, { params: { aid: "secret" }, body: { openTo: "listed", listed: [b.card.id] } })).statusCode, 200);
    assert.equal((s.inv.check(await s.who(b), "secret") as any).reason, "agent_unknown");
    // A session is an agent id by default (private until P4-06).
    const t = await runningTurn(a);
    const ss = await call(a, I.audienceShow, { params: { aid: t.own } });
    assert.equal(ss.statusCode, 200, ss.body);
    assert.equal(ss.json().kind, "private");
    assert.ok(a.ctx.store.all("SELECT action FROM audit").some((x) => x.action === "invoke.audience"));
  } finally {
    await s.close();
  }
});

// ── T-9: the PIN reset ───────────────────────────────────────────────────

test("T-9 (P4-03's part): resetting the PIN takes back every grant, named list, whitelist flag and pending card, and stops every call", async () => {
  const s = await setup({ whitelist: true });
  try {
    const { a, b, d, inv } = s;
    const pb = await s.who(b);
    const pd = await s.who(d);
    const r = inv.check(pb, "code") as any; // B whitelisted: 代码助手 open to all → allowed; make a grant on 研究助手 instead
    assert.equal(r.outcome, "allowed");
    await call(a, I.audienceSet, { params: { aid: "code" }, body: { openTo: "listed", listed: [d.card.id] } });
    const rd = inv.check(pd, "research") as any;
    await call(a, I.requestDecide, { params: { rid: rd.requestId }, body: { decision: "always" } });
    const pending = inv.check(pd, "secret"); // refused (private): no card
    assert.equal(pending.outcome, "refused");
    a.ctx.access.contacts.setWhitelist(b.card.id, false);
    const card = inv.check(pb, "research") as any;
    const w = inv.wait(card);
    a.ctx.access.contacts.setWhitelist(d.card.id, true);
    const c1 = running(inv, pd, "research");
    const c2 = running(inv, pd, "code");
    assert.equal(a.ctx.access.revocations.namesOf("invoke-grants").length, 2);
    a.pin.resetLocal();
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_grants").n, 0);
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_audience_members").n, 0);
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_requests WHERE status='pending'").n, 0);
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM contacts").n, 0);
    assert.equal(inv.calls.size, 0);
    assert.equal(c1.stopped.length + c2.stopped.length, 2);
    // Stopped by the contacts' removal (its hook runs in the transaction) or, at the latest, by the reset's own.
    for (const x of [...c1.stopped, ...c2.stopped]) assert.ok(["contact_removed", "reset"].includes(x.code), x.code);
    const settled = await w;
    assert.equal((settled as any).reason, "canceled");
    const row = a.ctx.store.one("SELECT target FROM audit WHERE action='pin.reset.revoke'");
    const summary = JSON.parse(row.target);
    // 1 grant + 1 list place + 1 whitelist flag + 1 pending card.
    assert.equal(summary.revoked["invoke-grants"], 4);
    assert.equal(summary.revoked.contacts, 2);
    assert.ok(!summary.pending.includes("invoke-grants"));
  } finally {
    await s.close();
  }
});

// ── the command line ─────────────────────────────────────────────────────

test("daisy request / grant / agent audience: list and decide over a real listener, each with the PIN (the command line's reads too)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-invoke-cli-"));
  const b = await peerDaisy("B");
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
    ctx.access.invoke.agents.add((id) => AGENTS[id] ?? null);
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
    let io = testIo({ input: ["246810"] });
    let r = await cliRun(io, dir, "contact", "import", b.text.split("\n").at(-1)!);
    assert.equal(r.code, 0, r.err);
    const p = (await ctx.access.guard.identify(await b.token(ctx.access.ai.urn), "external"))!;
    const card = ctx.access.invoke.check(p, "research") as any;
    const w = ctx.access.invoke.wait(card);
    // Without the PIN: refused before any request — listing too (D-40 ①:
    // the command line's credential may be the owner's AI).
    io = testIo();
    r = await cliRun(io, dir, "request", "list");
    assert.notEqual(r.code, 0);
    assert.match(r.err, /PIN/);
    io = testIo({ input: ["246810"] });
    r = await cliRun(io, dir, "request", "list");
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).requests[0].id, card.requestId);
    // Deciding without the PIN: refused before any request.
    io = testIo();
    r = await cliRun(io, dir, "request", "decide", card.requestId, "always");
    assert.notEqual(r.code, 0);
    assert.match(r.err, /PIN/);
    assert.equal(ctx.access.invoke.request(card.requestId).status, "pending");
    // A wrong PIN decides nothing.
    io = testIo({ input: ["999999"] });
    r = await cliRun(io, dir, "request", "decide", card.requestId, "always");
    assert.notEqual(r.code, 0);
    assert.equal(ctx.access.invoke.request(card.requestId).status, "pending");
    io = testIo({ input: ["246810"] });
    r = await cliRun(io, dir, "request", "decide", card.requestId, "always");
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).status, "approved");
    assert.deepEqual(await w, { outcome: "allowed", via: "grant" });
    io = testIo({ input: ["246810"] });
    r = await cliRun(io, dir, "grant", "list");
    const gid = JSON.parse(r.out).grants[0].id;
    io = testIo({ input: ["246810"] });
    r = await cliRun(io, dir, "grant", "revoke", gid);
    assert.equal(r.code, 0, r.err);
    io = testIo({ input: ["246810"] });
    r = await cliRun(io, dir, "agent", "audience", "set", "research", "--open-to", "listed", "--listed", b.card.id);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).openTo, "listed");
    io = testIo({ input: ["246810"] });
    r = await cliRun(io, dir, "agent", "audience", "show", "research");
    assert.equal(JSON.parse(r.out).listed[0].contactId, b.card.id);
  } finally {
    await ctx.app.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review M-2 / L-1 / L-3: an external issuer's person is that issuer's — marked on the card, keyed on the issuer and the whole sub; removing or replacing the issuer takes their grants, cards and calls", async () => {
  const s = await setup();
  const y = await fakeIssuer();
  try {
    const { a, inv } = s;
    assert.equal((await a.configure()).statusCode, 200);
    const X = a.iss.issuer;
    const visitor = async (sub: string, iss = a.iss) =>
      (await a.ctx.access.guard.identify(await iss.sign({ sub, aud: a.urn, scope: "daisy:invoke" }), "external"))!;
    const p = await visitor("user:someone-else");
    assert.equal(p.kind, "visitor");
    const r = inv.check(p, "research") as any;
    assert.equal(r.outcome, "pending");
    assert.deepEqual(r.person, {
      key: issuerPersonKey(X, createHash("sha256").update("user:someone-else").digest("base64url")),
      contactId: null,
      issuer: X,
      subject: "user:someone-else",
      name: "user:someone-else（外部签发方）",
    });
    // L-3: the card says it is the issuer's person.
    assert.equal(inv.request(r.requestId).caller.name, "user:someone-else（外部签发方）");
    // Not a contact: never on a named list; a private agent reads as missing (L-6).
    assert.equal((inv.check(p, "secret") as any).reason, "agent_unknown");
    assert.equal((await call(a, I.requestDecide, { params: { rid: r.requestId }, body: { decision: "always" } })).statusCode, 200);
    assert.equal((inv.check(p, "research") as any).via, "grant");
    assert.equal(inv.check(p, "code").outcome, "pending");
    // L-1: two subjects the same in their first 200 characters are two people.
    const long = "user:" + "x".repeat(240);
    const p1 = await visitor(long + "1");
    const p2 = await visitor(long + "2");
    assert.equal(p1.subject, p2.subject, "the principal's subject is cut");
    const r1 = inv.check(p1, "research") as any;
    await call(a, I.requestDecide, { params: { rid: r1.requestId }, body: { decision: "always" } });
    assert.equal((inv.check(p1, "research") as any).via, "grant");
    assert.equal(inv.check(p2, "research").outcome, "pending", "the other long subject has no grant");
    // A call in progress under X's grant.
    const live = running(inv, p, "research");
    // M-2: the issuer replaced by Y — the same sub there is someone else.
    const conf = await a.ctx.app.inject({
      method: "PUT",
      url: "/api/access/issuer",
      headers: a.withPin(),
      payload: { issuer: y.issuer, ownerSubject: OWNER_SUB },
    });
    assert.equal(conf.statusCode, 200, conf.body);
    assert.deepEqual(live.stopped.map((x) => x.code), ["issuer_changed"]);
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_grants WHERE issuer IS NOT NULL").n, 0);
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_requests WHERE status='pending' AND issuer IS NOT NULL").n, 0);
    // X's principal from before is nobody now.
    assert.equal((inv.check(p, "research") as any).reason, "not_recognised");
    assert.throws(() => running(inv, p, "research"), /不认得你/);
    // Y's person with the same sub: a new card, not X's grant.
    const py = await visitor("user:someone-else", y);
    assert.notEqual(inv.check(py, "research").outcome, "allowed");
    assert.notEqual((inv.check(py, "research") as any).person.key, r.person.key);
    // Removed altogether: Y's grants go too.
    const ry = inv.check(py, "code") as any;
    await call(a, I.requestDecide, { params: { rid: ry.requestId }, body: { decision: "always" } });
    assert.equal((await a.ctx.app.inject({ method: "DELETE", url: "/api/access/issuer", headers: a.asCli })).statusCode, 200);
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_grants").n, 0);
    assert.equal((inv.check(py, "code") as any).reason, "not_recognised");
  } finally {
    await y.close();
    await s.close();
  }
});

test("review M-1: a call is checked again when it begins — a revoked grant, a removed contact or a used 仅本次 does not start, whatever wait said", async () => {
  const s = await setup();
  try {
    const { a, b, inv } = s;
    const pb = await s.who(b);
    // 永久通过 → allowed → the grant revoked before the call begins → it does not begin.
    const r = inv.check(pb, "research") as any;
    const w = inv.wait(r);
    await call(a, I.requestDecide, { params: { rid: r.requestId }, body: { decision: "always" } });
    assert.deepEqual(await w, { outcome: "allowed", via: "grant" });
    const gid = inv.grants()[0].id;
    await call(a, I.grantRevoke, { params: { gid } });
    assert.throws(() => running(inv, pb, "research", r.ticket), (e: any) => e.code === "not_admitted");
    assert.equal(inv.calls.size, 0);
    // … and waiting again on that card says so (re-asked, not the old answer).
    const again = await inv.wait(r);
    assert.equal(again.outcome, "refused");
    assert.match((again as any).message, /授权已被撤销/);
    // 仅本次: one call begins with its ticket; a second begin with the same ticket does not.
    a.ctx.store.run("DELETE FROM invoke_requests"); // a fresh start for B on 研究助手
    const r2 = inv.check(pb, "research") as any;
    await call(a, I.requestDecide, { params: { rid: r2.requestId }, body: { decision: "once" } });
    assert.deepEqual(await inv.wait(r2), { outcome: "allowed", via: "once" });
    const one = running(inv, pb, "research", r2.ticket);
    assert.equal(one.h.active, true);
    assert.throws(() => running(inv, pb, "research", r2.ticket), (e: any) => e.code === "not_admitted");
    assert.throws(() => running(inv, pb, "research"), /要等主人批准/);
    // Another person cannot use B's ticket.
    const pd = await s.who(s.d);
    const r3 = inv.check(pd, "research") as any;
    await call(a, I.requestDecide, { params: { rid: r3.requestId }, body: { decision: "once" } });
    assert.throws(() => running(inv, pb, "research", r3.ticket), (e: any) => e.code === "not_admitted");
    // 仅本次 approved, then the contact removed: waiting says refused, begin refuses.
    await call(a, api.contacts.contactRemove, { params: { id: s.d.card.id } });
    assert.equal((await inv.wait(r3)).outcome, "refused");
    assert.throws(() => running(inv, pd, "research", r3.ticket), (e: any) => e.code === "not_admitted");
    // A stranger never begins.
    assert.throws(() => running(inv, null, "research"), /不认得你/);
  } finally {
    await s.close();
  }
});

test("review M-3 / L-2: 仅本次 lets only the raising call through — the others go to a new card; waiting calls and pending cards are bounded", async () => {
  const s = await setup();
  try {
    const { a, b, inv } = s;
    const pb = await s.who(b);
    const first = inv.check(pb, "research") as any;
    const pOther = (await a.ctx.access.guard.identify(await b.token(a.urn, { actor: "agent:s-2" }), "external"))!;
    const second = inv.check(pOther, "research") as any;
    const third = inv.check(pb, "research") as any;
    const [w1, w2, w3] = [inv.wait(first), inv.wait(second), inv.wait(third)];
    const card = inv.request(first.requestId);
    assert.equal(card.waiting, 3);
    assert.deepEqual(card.actors, ["agent:s-1", "agent:s-2"]);
    const listed = (await a.ctx.app.inject({ url: "/api/approvals", headers: { authorization: `Bearer ${a.ctx.issueToken()}` } }))
      .json()
      .items.find((x: any) => x.id === first.requestId);
    assert.equal(listed.title, "B 请求调用「研究助手」（3 次调用在等，来自 2 个 AI）");
    assert.deepEqual([listed.calls, listed.waiting, listed.actors], [3, 3, ["agent:s-1", "agent:s-2"]]);
    // The owner's notice is renewed as calls join (its title carries the count; renewals
    // within one millisecond share a key and coalesce, notifications.ts).
    assert.ok(
      a.ctx.store
        .all("SELECT title FROM notification_events WHERE subject=?", first.requestId)
        .some((x: any) => /^B 请求调用「研究助手」（[23] 次调用在等，来自 2 个 AI）$/.test(x.title)) ||
        a.ctx.store.one("SELECT COUNT(*) n FROM notification_events WHERE subject=?", first.requestId).n === 1,
    );
    await call(a, I.requestDecide, { params: { rid: first.requestId }, body: { decision: "once" } });
    assert.deepEqual(await w1, { outcome: "allowed", via: "once" });
    // The two that joined wait on a new card (one notice, one outlet event for it).
    const moved = inv.requests("pending");
    assert.equal(moved.length, 1);
    assert.notEqual(moved[0].id, first.requestId);
    assert.equal(moved[0].waiting, 2);
    let settled = false;
    void Promise.race([w2, w3]).then(() => (settled = true));
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, "the joined calls still wait");
    await call(a, I.requestDecide, { params: { rid: moved[0].id }, body: { decision: "always" } });
    assert.deepEqual(await w2, { outcome: "allowed", via: "grant" });
    assert.deepEqual(await w3, { outcome: "allowed", via: "grant" });
    // At most CARD_LIMITS.callCardMaxWaiting calls wait on one card.
    const pd = await s.who(s.d);
    const waits: any[] = [];
    for (let i = 0; i < CARD_LIMITS.callCardMaxWaiting; i++) waits.push(inv.check(pd, "research"));
    assert.ok(waits.every((x) => x.outcome === "pending"));
    const over = inv.check(pd, "research") as any;
    assert.equal(over.reason, "too_many_waiting");
    // A pending-card flood from one issuer's people stops at the per-issuer cap; genuine cards still show.
    assert.equal((await a.configure()).statusCode, 200);
    const flood = async (i: number) =>
      (await a.ctx.access.guard.identify(await a.iss.sign({ sub: `user:f${i}`, aud: a.urn, scope: "daisy:invoke" }), "external"))!;
    let refused = 0;
    for (let i = 0; i < CARD_LIMITS.callCardsPendingPerIssuer + 3; i++) {
      const x = inv.check(await flood(i), "code");
      if (x.outcome === "refused") {
        assert.equal(x.reason, "too_many_requests");
        refused++;
      }
    }
    assert.equal(refused, 3);
    const web = { authorization: `Bearer ${a.ctx.issueToken()}` };
    const inbox = (await a.ctx.app.inject({ url: "/api/approvals", headers: web })).json().items;
    assert.ok(inbox.some((x: any) => x.id === waits[0].requestId), "D's card is still in the list");
  } finally {
    await s.close();
  }
});

test("review L-4 / L-5: deleting an agent takes its grants, range and cards and stops its calls; a pending card is settled as let in once the person is let in outright", async () => {
  const s = await setup();
  try {
    const { a, b, inv } = s;
    const t = await runningTurn(a);
    const sid = t.other;
    const pb = await s.who(b);
    // The session made callable for the test (P4-06 will register the real resolver).
    inv.agents.add((id) => (id === sid ? { id, kind: "public", name: "会话", sessionId: id } : null));
    const r = inv.check(pb, sid) as any;
    await call(a, I.requestDecide, { params: { rid: r.requestId }, body: { decision: "always" } });
    await call(a, I.audienceSet, { params: { aid: sid }, body: { openTo: "all" } });
    const live = running(inv, pb, sid);
    const pd = await s.who(s.d);
    const rd = inv.check(pd, sid) as any;
    const wd = inv.wait(rd);
    const del = await a.ctx.app.inject({ method: "DELETE", url: `/api/sessions/${sid}`, headers: { authorization: `Bearer ${a.ctx.issueToken()}` } });
    assert.equal(del.statusCode, 200, del.body);
    assert.deepEqual(live.stopped.map((x) => x.code), ["agent_gone"]);
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_grants WHERE agent_id=?", sid).n, 0);
    assert.equal(a.ctx.store.one("SELECT COUNT(*) n FROM invoke_audiences WHERE agent_id=?", sid).n, 0);
    assert.equal((await wd).outcome, "refused");
    // L-5: B's card on 研究助手 pending, then B whitelisted → settled as let in, the card closed.
    const rb = inv.check(pb, "research") as any;
    const wb = inv.wait(rb);
    await call(a, api.contacts.contactWhitelistAdd, { params: { id: b.card.id } });
    assert.deepEqual(await soon(wb), { outcome: "allowed", via: "whitelist" });
    assert.equal(inv.request(rb.requestId).status, "canceled");
    assert.match(inv.request(rb.requestId).closedWhy!, /不用批准/);
    assert.equal(inv.requests("pending").length, 0);
  } finally {
    await s.close();
  }
});

test("what a caller controls is shown on the card without control / bidi / zero-width characters, and bounded", async () => {
  const { shown } = await import("../packages/daisy/src/invoke/invoke-access.ts");
  assert.equal(shown("Bob‮​gnp.exe\u0007\n", 64), "Bobgnp.exe");
  assert.equal([...shown("长".repeat(300), 64)].length, 64);
  assert.ok(shown("长".repeat(300), 64).endsWith("…"));
});
