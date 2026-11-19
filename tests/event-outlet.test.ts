// P2-03 (5.10 「事件出口」, docs/contracts/events.md, ADR-114) — E-1: AI 请求
// 授权、AI 提问、有人想调用 each make one event on the outlet; read by
// sequence number, nothing lost or repeated; their 「了结」; the long poll;
// a cursor that cannot be continued; who may read (daisy:events:read — the
// AI may not, a token with only it reads no conversation); no credential
// in an event or a log line (S-1); the command line (`daisy events …`,
// `daisy watch`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";
import { Store } from "../packages/daisy/src/store/index.ts";
import { eventOutlet, cardKindOf } from "../packages/daisy/src/sessions/event-outlet.ts";
import { MASK, registerSecret } from "../packages/daisy/src/observe/redact.ts";
import { onLog } from "../packages/daisy/src/observe/log.ts";
import {
  API_ROUTES,
  DAISY_EVENT_TYPES,
  EVENT_LIMITS,
  SCOPES,
  cliCommands,
  fillPath,
} from "../packages/contracts/src/index.ts";
import { OWNER_SCOPES } from "../packages/daisy/src/access/guard.ts";
import { ownNode, runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";
import { daisy, fakeDaisy, testIo } from "./cli-fixture.ts";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const RESPOND_TRACE = "0af7651916cd43dd8448eb211c80319c";
const traceOf = (tp: string) => tp.split("-")[1];

const options = (dir: string) => ({
  pinGate: false,
  dataDir: dir,
  bootstrap: false,
  workspaceHome: dir,
  workspaceRoots: [dir],
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "daisy-events-"));
  const f: any = { dir };
  const open = async () => {
    f.ctx = await createApp(options(dir));
    f.inject = runnerInject(f.ctx.app, f.ctx.runnerApi);
    f.web = f.ctx.issueToken();
    f.h = { authorization: "Bearer " + f.web };
  };
  await open();
  f.call = (method: any, url: string, payload?: any, headers: any = f.h) =>
    f.inject({ method, url: "/api" + url, payload, headers });
  f.read = async (q = "") => {
    const r = await f.call("GET", "/events" + q);
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  f.restart = async () => {
    await f.ctx.app.close();
    await open();
  };
  f.close = async () => {
    await f.ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return f;
}

/** A session of the owner with a running turn (its Runner claimed it). */
async function runningTurn(f: any, key = "evt-work-0001") {
  const node = ownNode(f.ctx.store, OWNER_ID, "alice", "remote");
  const nh = runnerHeaders(node.nodeId);
  await f.call("POST", "/runner/sync", { capabilities: {} }, nh);
  const w = (await f.call("POST", "/workspaces", { nodeId: node.id, label: "work", path: f.dir })).json();
  const p = (
    await f.call("POST", "/profiles", { nodeId: node.id, agent: "codex", label: "local", authMode: "subscription" })
  ).json();
  const s = (
    await f.call("POST", "/sessions", { title: "研究助手", agent: "codex", workspaceId: w.id, profileId: p.id })
  ).json();
  // The owner's action that starts the turn carries its own trace.
  await f.call("POST", `/sessions/${s.id}/messages`, { requestId: key, text: "work" }, {
    ...f.h,
    traceparent: `00-${TRACE}-00f067aa0ba902b7-01`,
  });
  const job = (await f.call("POST", "/runner/claim", {}, nh)).json().job;
  assert.equal(job.session.id, s.id);
  const jh = { ...nh, "x-lease": job.lease };
  const post = (events: any[]) => f.call("POST", `/runner/jobs/${job.id}/events`, { events }, jh);
  return { s, job, jh, nh, post };
}

const perm = (n: string, title = "Bash") => ({
  id: `evt-perm-${n}`,
  type: "approval",
  data: {
    id: `perm-${n}`,
    title,
    input: { command: "rm -rf build" },
    options: [
      { id: "allow", label: "允许本次" },
      { id: "deny", label: "拒绝" },
    ],
    category: "permission",
  },
});
const question = (n: string) => ({
  id: `evt-q-${n}`,
  type: "approval",
  data: {
    id: `q-${n}`,
    title: "Codex 需要你的回答",
    input: { questions: [{ question: "发布到哪个分支？" }] },
    options: [{ id: "ok", label: "提交" }],
    category: "question",
  },
});

test("E-1: each of the three kinds makes one event; read by sequence, nothing lost or repeated; then their 了结", async () => {
  const f = await fixture();
  try {
    const t = await runningTurn(f);
    const urn = f.ctx.access.ai.urn;
    // AI 请求授权 and AI 提问, reported by the Runner (twice: a resend is not new).
    assert.equal((await t.post([perm("0001"), question("0001")])).statusCode, 200);
    assert.equal((await t.post([perm("0001"), question("0001")])).statusCode, 200);
    // 有人想调用，待批准: stage 4's write point, called directly.
    const week = Date.now() + 7 * 86400_000;
    f.ctx.events.opened({
      uid: OWNER_ID,
      kind: "invocation",
      cardId: "call:c-0001",
      title: "李四的「代码助手」想调用你的「研究助手」",
      sessionId: t.s.id,
      expiresAt: week,
      context: { callerName: "李四" },
    });
    // Raising an open card again is not a second 「出现」.
    assert.equal(
      f.ctx.events.opened({ uid: OWNER_ID, kind: "invocation", cardId: "call:c-0001", title: "x" }),
      null,
    );

    const all = await f.read();
    assert.equal(all.hasMore, false);
    assert.deepEqual(
      all.events.map((e: any) => [e.type, e.subject]),
      [
        ["agent.permission.requested", "perm:perm-0001"],
        ["agent.question.asked", "question:q-0001"],
        ["agent.invocation.requested", "call:c-0001"],
      ],
    );
    // CloudEvents 1.0, 5.10's eight fields.
    const [p, q, inv] = all.events;
    for (const e of all.events) {
      assert.equal(e.specversion, "1.0");
      assert.match(e.id, /^evt_[0-9a-f-]{36}$/);
      assert.equal(e.source, urn);
      assert.equal(e.datacontenttype, "application/json");
      assert.equal(e.data.recipient, urn, "standalone: the owner is this Daisy's URN");
      assert.equal(e.data.actionRequired, true);
      assert.match(e.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
      assert.match(e.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
      assert.ok(e.data.title.length > 0 && [...e.data.title].length <= EVENT_LIMITS.titleMax);
      assert.ok(DAISY_EVENT_TYPES.includes(e.type));
      // Nothing of the conversation or the tool's arguments.
      assert.doesNotMatch(JSON.stringify(e), /rm -rf|发布到哪个分支/);
    }
    assert.ok(p.seq < q.seq && q.seq < inv.seq);
    assert.equal(all.cursor, inv.seq);
    assert.match(p.data.title, /请求权限：Bash/);
    assert.equal(p.data.link, `/approvals?card=${encodeURIComponent("perm:perm-0001")}`);
    assert.equal(p.data.context.agentName, "研究助手");
    assert.equal(q.data.link, `/sessions/${t.s.id}?card=${encodeURIComponent("question:q-0001")}`);
    assert.equal(inv.data.expiresAt, new Date(week).toISOString());
    assert.equal(inv.data.context.callerName, "李四");
    // 链路号: the owner's message that started the turn the card came from.
    assert.equal(traceOf(p.traceparent), TRACE);
    assert.equal(traceOf(q.traceparent), TRACE);

    // One at a time, following `cursor` while `hasMore`: the same three, once each.
    const seen: string[] = [];
    let after = 0;
    for (let i = 0; i < 10; i++) {
      const pg = await f.read(`?after=${after}&limit=1`);
      seen.push(...pg.events.map((e: any) => e.id));
      after = pg.cursor;
      if (!pg.hasMore) break;
    }
    assert.deepEqual(seen, all.events.map((e: any) => e.id));
    assert.deepEqual(await f.read(`?after=${after}`), { events: [], cursor: after, hasMore: false });

    // The snapshot: the three open cards, and where to read on.
    const snap = (await f.call("GET", "/events/snapshot")).json();
    assert.equal(snap.snapshot, true);
    assert.equal(snap.cursor, inv.seq);
    assert.deepEqual(snap.events.map((e: any) => e.id), seen);

    // 了结: the permission answered on 「审批」 (the owner's action, its own trace) …
    const ok = await f.call("POST", "/approvals/perm:perm-0001/respond", { decision: "allow" }, {
      ...f.h,
      traceparent: `00-${RESPOND_TRACE}-b7ad6b7169203331-01`,
    });
    assert.equal(ok.statusCode, 200, ok.body);
    // … the question answered in its conversation …
    const ans = await f.call("POST", `/sessions/${t.s.id}/approvals/q-0001`, { optionId: "ok" });
    assert.equal(ans.statusCode, 200, ans.body);
    // … the call request withdrawn (stage 4's write point).
    f.ctx.events.resolved({ uid: OWNER_ID, cardId: "call:c-0001", state: "canceled" });
    // Resolving what is not open does nothing.
    assert.equal(f.ctx.events.resolved({ uid: OWNER_ID, cardId: "call:c-0001", state: "handled" }), null);

    const next = await f.read(`?after=${after}`);
    assert.deepEqual(
      next.events.map((e: any) => [e.type, e.subject, e.data.state, e.data.actionRequired]),
      [
        ["agent.permission.resolved", "perm:perm-0001", "handled", false],
        ["agent.question.resolved", "question:q-0001", "handled", false],
        ["agent.invocation.resolved", "call:c-0001", "canceled", false],
      ],
    );
    assert.equal(traceOf(next.events[0].traceparent), RESPOND_TRACE);
    assert.equal(next.events[2].data.link, inv.data.link);
    const after2 = next.cursor;
    // Nothing is open now.
    const empty = (await f.call("GET", "/events/snapshot")).json();
    assert.deepEqual(empty.events, []);
    assert.equal(empty.cursor, after2);

    // An auto-mode interception (permission) and a prompt left open when the turn ends (expired).
    const denied = {
      id: "evt-deny-0001",
      type: "item",
      data: {
        id: `${t.job.id}:denied:toolu_1`,
        kind: "tool",
        category: "interception",
        name: "Bash",
        text: "Permission denied by auto mode",
        status: "error",
        input: { toolName: "Bash", reason: "会访问外网", message: "denied", request: { command: "curl x" } },
      },
    };
    await t.post([denied, perm("0002", "Write")]);
    const blockId = (await f.call("GET", "/approvals?status=pending")).json().items.find(
      (x: any) => x.kind === "interception",
    ).id;
    const d = await f.call("POST", `/approvals/${blockId}/respond`, { decision: "dismiss" });
    assert.equal(d.statusCode, 200, d.body);
    const done = await f.call("POST", `/runner/jobs/${t.job.id}/complete`, { status: "idle" }, t.jh);
    assert.equal(done.statusCode, 200, done.body);
    const last = await f.read(`?after=${after2}`);
    assert.deepEqual(
      last.events.map((e: any) => [e.type, e.subject, e.data.state ?? null]),
      [
        ["agent.permission.requested", blockId, null],
        ["agent.permission.requested", "perm:perm-0002", null],
        ["agent.permission.resolved", blockId, "handled"],
        ["agent.permission.resolved", "perm:perm-0002", "expired"],
      ],
    );

    // 断线续读 across a restart: the sequence goes on from where it was.
    const cursor = last.cursor;
    await f.restart();
    assert.deepEqual(await f.read(`?after=${cursor}`), { events: [], cursor, hasMore: false });
    f.ctx.events.opened({ uid: OWNER_ID, kind: "invocation", cardId: "call:c-0002", title: "王五想调用" });
    const resumed = await f.read(`?after=${cursor}`);
    assert.equal(resumed.events.length, 1);
    assert.ok(resumed.events[0].seq > cursor);
    // Every id once, ever.
    const ids = (await f.read("?after=0")).events.map((e: any) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, 11);
  } finally {
    await f.close();
  }
});

test("long poll: answered as soon as an event is written; empty after `wait`; at once when the server closes", async () => {
  const f = await fixture();
  try {
    const cursor = (await f.read()).cursor;
    let t0 = Date.now();
    const pending = f.call("GET", `/events?after=${cursor}&wait=20`);
    setTimeout(() => {
      f.ctx.events.opened({ uid: OWNER_ID, kind: "invocation", cardId: "call:lp-1", title: "有人想调用" });
    }, 150);
    const r = await pending;
    const waited = Date.now() - t0;
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().events.map((e: any) => e.subject), ["call:lp-1"]);
    assert.ok(waited >= 100 && waited < 3000, `waited ${waited} ms`);
    // Nothing new: the full wait, then an empty page at the same cursor.
    t0 = Date.now();
    const empty = await f.call("GET", `/events?after=${r.json().cursor}&wait=1`);
    assert.deepEqual(empty.json(), { events: [], cursor: r.json().cursor, hasMore: false });
    assert.ok(Date.now() - t0 >= 900, "waited its second");
    // Over the bound: refused by the definition.
    assert.equal((await f.call("GET", `/events?wait=${EVENT_LIMITS.waitMaxS + 1}`)).statusCode, 400);
    // Closing answers a waiting reader now, not after its 30 s.
    t0 = Date.now();
    const held = f.call("GET", `/events?after=${r.json().cursor}&wait=30`);
    await new Promise((res) => setTimeout(res, 100));
    await f.ctx.app.close();
    const h = await held;
    assert.equal(h.statusCode, 200);
    assert.deepEqual(h.json().events, []);
    assert.ok(Date.now() - t0 < 5000);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a cursor that cannot go on: older than the retention, or beyond what was written — 410 cursor_reset, take a snapshot; open cards are kept", async () => {
  const f = await fixture();
  try {
    const ev = f.ctx.events;
    ev.opened({ uid: OWNER_ID, kind: "permission", cardId: "perm:old", title: "旧的，已处理" });
    ev.opened({ uid: OWNER_ID, kind: "question", cardId: "question:open", title: "还没回答" });
    ev.resolved({ uid: OWNER_ID, cardId: "perm:old", state: "handled" });
    const before = await f.read();
    assert.equal(before.events.length, 3);
    // Nothing subscribed for 31 days: the sweep drops what is past the retention …
    const later = Date.now() + EVENT_LIMITS.retentionMs + 86400_000;
    assert.equal(ev.sweep(later, true), 2);
    // … but not the open card's 「出现」.
    const snap = (await f.call("GET", "/events/snapshot")).json();
    assert.deepEqual(snap.events.map((e: any) => e.subject), ["question:open"]);
    assert.equal(snap.cursor, before.cursor);
    // A subscriber that read up to the first event lost the third: told so.
    for (const after of [0, before.events[0].seq, before.cursor + 5]) {
      const r = await f.call("GET", `/events?after=${after}`);
      assert.equal(r.statusCode, 410, `after=${after}`);
      assert.deepEqual(
        { ...r.json(), error: undefined },
        { error: undefined, code: "cursor_reset", events: [], cursor: 0, hasMore: false, reset: true },
      );
      assert.match(r.json().error, /先取快照/);
    }
    // From the snapshot's cursor it goes on.
    assert.deepEqual(await f.read(`?after=${snap.cursor}`), { events: [], cursor: snap.cursor, hasMore: false });
    ev.resolved({ uid: OWNER_ID, cardId: "question:open", state: "expired" });
    const r = await f.read(`?after=${snap.cursor}`);
    assert.deepEqual(r.events.map((e: any) => [e.type, e.data.state]), [["agent.question.resolved", "expired"]]);
    // The sweep is throttled (once an hour) unless forced.
    assert.equal(ev.sweep(later), 0);
  } finally {
    await f.close();
  }
});

test("who reads the outlet: the owner's web page and command line; never the AI; a daisy:events:read-only token reads no conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-events-access-"));
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, workspaceRoots: [dir], sharedHost: () => false, peerIsOwner: () => true });
  const inject = runnerInject(ctx.app, ctx.runnerApi);
  try {
    assert.ok(SCOPES.includes("daisy:events:read"));
    assert.ok(OWNER_SCOPES.includes("daisy:events:read"), "the owner's credentials carry it");
    const web = { authorization: `Bearer ${ctx.issueToken()}` };
    const cli = { authorization: `Bearer ${readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim()}` };
    for (const h of [web, cli])
      for (const url of ["/api/events", "/api/events/snapshot"])
        assert.equal((await ctx.app.inject({ url, headers: h })).statusCode, 200, url);
    // A running turn's AI working credential.
    const cat = (await inject({ url: "/api/catalog", headers: web })).json();
    const s = (
      await inject({
        method: "POST",
        url: "/api/sessions",
        headers: web,
        payload: { agent: "claude", workspaceId: cat.workspaces[0].id, profileId: cat.profiles.find((p: any) => p.agent === "claude").id },
      })
    ).json();
    await inject({ method: "POST", url: `/api/sessions/${s.id}/messages`, headers: web, payload: { text: "hi", requestId: "req-evt-acc-01" } });
    const nodeId = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8")).nodeId;
    const job = (await inject({ method: "POST", url: "/api/runner/claim", payload: {}, headers: runnerHeaders(nodeId) })).json().job;
    const ai = { authorization: `Bearer ${readFileSync(job.aiCredential.file, "utf8").trim()}` };
    assert.equal((await ctx.app.inject({ url: `/api/sessions/${s.id}`, headers: ai })).statusCode, 200, "it is a live credential");
    for (const url of ["/api/events", "/api/events/snapshot", "/api/events?wait=1"]) {
      const r = await ctx.app.inject({ url, headers: ai });
      assert.equal(r.statusCode, 403, url);
      assert.equal(r.json().code, "channel_not_allowed");
    }
    // A principal holding only daisy:events:read (what an outside token
    // limited to it becomes — P2-01 maps the token, the guard decides).
    const only = {
      kind: "owner" as const,
      channel: "web" as const,
      face: "external" as const,
      label: "events-only",
      scopes: ["daisy:events:read" as const],
    };
    const passed: string[] = [];
    for (const r of API_ROUTES) {
      if (r.scope === null) continue;
      const params = Object.fromEntries(Object.keys(r.params.shape).map((k) => [k, "x"]));
      const no = ctx.access.guard.authorize(only, r, params, {});
      if (!no) passed.push(r.id);
      else if (!r.external && r.channels.includes("web")) assert.equal(no.code, "insufficient_scope", r.id);
    }
    assert.deepEqual(passed.sort(), ["events.list", "events.snapshot"]);
    // The event routes need exactly that scope; no other route uses it.
    for (const r of API_ROUTES)
      assert.equal(r.scope === "daisy:events:read", r.group === "events", r.id);
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S-1: no credential in an event or a log line", async () => {
  const f = await fixture();
  const lines: string[] = [];
  const off = onLog((l) => lines.push(l.text));
  try {
    const t = await runningTurn(f, "evt-s1-00000001");
    const apiKey = "sk-ant-api03-" + "Q".repeat(40);
    registerSecret(apiKey);
    const bearer = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
    // A harness that puts secrets into what becomes a card's title.
    await t.post([perm("0009", `curl -H 'Authorization: ${bearer}' ${apiKey} ${f.web}`)]);
    f.ctx.events.opened({
      uid: OWNER_ID,
      kind: "invocation",
      cardId: "call:s1",
      title: `调用 token=${apiKey}`,
      context: { callerName: `李四 ${f.web}` },
    });
    await f.read("?wait=0");
    const everything = JSON.stringify(f.ctx.store.all("SELECT * FROM event_outbox")) + JSON.stringify(await f.read());
    for (const secret of [apiKey, f.web, "abcdefghijklmnopqrstuvwxyz0123456789"])
      assert.ok(!everything.includes(secret), "no secret in the outlet");
    assert.ok(everything.includes(MASK), "masked, not dropped");
    for (const l of lines)
      for (const secret of [apiKey, f.web]) assert.ok(!l.includes(secret), l);
  } finally {
    off();
    await f.close();
  }
});

test("writer units: card kinds by id; one 出现 per open card; recipient and source as configured", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-events-unit-"));
  const store = new Store(dir);
  try {
    assert.deepEqual(
      ["perm:a", "block:b", "ask:c", "question:d", "call:e", "wake:f", "inv-1", "x:y"].map(cardKindOf),
      ["permission", "permission", "permission", "question", "invocation", "invocation", null, null],
    );
    const ev = eventOutlet(store, { source: () => "urn:test:daisy", recipient: (uid) => `sub:${uid}` });
    assert.equal(ev.card("u1", "inv-1", "pending", "未知前缀"), null, "not an outlet card");
    assert.ok(ev.card("u1", "perm:a", "pending", "x"));
    assert.equal(ev.card("u1", "perm:a", "pending", "again"), null);
    assert.ok(ev.card("u1", "perm:a", "rejected", "已拒绝"));
    assert.ok(ev.card("u1", "perm:a", "pending", "reopened"), "a resolved card may open again");
    const p = ev.page("u1");
    assert.ok(!("reset" in p));
    if ("reset" in p) return;
    assert.deepEqual(p.events.map((e) => [e.type, e.data.state ?? null]), [
      ["agent.permission.requested", null],
      ["agent.permission.resolved", "handled"],
      ["agent.permission.requested", null],
    ]);
    assert.equal(p.events[0]!.source, "urn:test:daisy");
    assert.equal(p.events[0]!.data.recipient, "sub:u1");
    assert.equal(p.events[1]!.data.title, "已拒绝");
    // Another recipient's events are not in this one's pages.
    ev.card("u2", "perm:z", "pending", "别人的");
    const mine = ev.page("u1", p.cursor);
    assert.ok(!("reset" in mine) && mine.events.length === 0);
    // Same transaction as the card: the card's change rolled back, no event.
    assert.throws(() =>
      store.atomic(() => {
        ev.opened({ uid: "u1", kind: "permission", cardId: "perm:rolled-back", title: "x" });
        throw new Error("the card's own write failed");
      }),
    );
    const none = ev.page("u1", p.cursor);
    assert.ok(!("reset" in none) && none.events.length === 0);
    assert.equal(ev.snapshot("u1").events.some((e) => e.subject === "perm:rolled-back"), false);
    // A long title is cut to 200 characters.
    ev.opened({ uid: "u1", kind: "question", cardId: "question:long", title: "问".repeat(500) });
    const long = ev.page("u1", p.cursor);
    if (!("reset" in long)) assert.equal([...long.events[0]!.data.title].length, EVENT_LIMITS.titleMax);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command line: `daisy events list / snapshot` from the table; `daisy watch` follows, resets, resumes from a cursor file", async () => {
  const cmds = cliCommands(API_ROUTES).map((c) => [c.path.join(" "), c.route]);
  assert.ok(cmds.some(([p, r]) => p === "events list" && r === "events.list"));
  assert.ok(cmds.some(([p, r]) => p === "events snapshot" && r === "events.snapshot"));
  const list = cliCommands(API_ROUTES).find((c) => c.route === "events.list")!;
  assert.deepEqual(list.options.map((o) => o.flag).sort(), ["--after", "--limit", "--wait"]);

  const event = (seq: number, subject = `perm:${seq}`) => ({
    specversion: "1.0",
    id: `evt_${seq}`,
    seq,
    type: "agent.permission.requested",
    subject,
    data: { title: `#${seq}` },
  });
  let resetOnce = true;
  const d = await fakeDaisy((r) => {
    if (r.path === "/api/events/snapshot") return { json: { events: [event(3, "perm:open")], cursor: 5, snapshot: true } };
    if (r.path === "/api/events") {
      const after = Number(r.query.get("after"));
      if (after === 99 && resetOnce) {
        resetOnce = false;
        return { status: 410, json: { error: "接不上", code: "cursor_reset", events: [], cursor: 0, hasMore: false, reset: true } };
      }
      if (after === 5) return { json: { events: [event(6), event(7)], cursor: 7, hasMore: false } };
      if (after === 7) return { json: { events: [event(8)], cursor: 8, hasMore: false } };
      return { json: { events: [], cursor: after, hasMore: false } };
    }
    return undefined;
  });
  try {
    // From a snapshot, then the long poll; one JSON line per event.
    let io = testIo();
    let r = await daisy(io, d.dataDir, "watch", "--max", "3", "--wait", "5");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(io.stdout.map((l) => JSON.parse(l).seq), [3, 6, 7]);
    assert.match(r.err, /快照：1 张没了结的卡片，从序号 5 接着读/);
    const lp = d.requests.find((x) => x.path === "/api/events")!;
    assert.equal(lp.query.get("after"), "5");
    assert.equal(lp.query.get("wait"), "5");
    // A cursor file: written after each page, read back next time.
    const file = join(d.root, "cursor");
    io = testIo();
    r = await daisy(io, d.dataDir, "watch", "--after", "5", "--cursor-file", file, "--max", "2");
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(file, "utf8").trim(), "7");
    io = testIo();
    r = await daisy(io, d.dataDir, "watch", "--cursor-file", file, "--max", "1");
    assert.deepEqual(io.stdout.map((l) => JSON.parse(l).seq), [8]);
    assert.equal(readFileSync(file, "utf8").trim(), "8");
    // Stopping inside a page keeps the last printed event's sequence.
    io = testIo();
    r = await daisy(io, d.dataDir, "watch", "--after", "5", "--cursor-file", file, "--max", "1");
    assert.equal(readFileSync(file, "utf8").trim(), "6");
    // A cursor that cannot go on: a new snapshot, then on from its cursor.
    io = testIo();
    r = await daisy(io, d.dataDir, "watch", "--after", "99", "--max", "2");
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /序号 99 接不上了/);
    assert.deepEqual(io.stdout.map((l) => JSON.parse(l).seq), [3, 6]);
    // Help and bad options.
    io = testIo();
    r = await daisy(io, d.dataDir, "watch", "--help");
    assert.match(r.out, /持续读事件出口/);
    r = await daisy(testIo(), d.dataDir, "watch", "--wait", "99");
    assert.equal(r.code, 2);
    assert.ok(!existsSync(join(d.root, "cursor.tmp")));
  } finally {
    await d.close();
  }
});

test("the event routes are in the table: daisy:events:read, the owner's channels (with the external issuer's, P2-01), documented", () => {
  const ids = API_ROUTES.filter((r) => r.group === "events").map((r) => [r.id, r.method, r.path, r.scope, r.channels.join(",")]);
  assert.deepEqual(ids, [
    ["events.list", "GET", "/api/events", "daisy:events:read", "web,device,cli,issuer"],
    ["events.snapshot", "GET", "/api/events/snapshot", "daisy:events:read", "web,device,cli,issuer"],
  ]);
  assert.equal(fillPath("/api/events"), "/api/events");
});

test("schema step 4 (P2-03): a version-3 database gains the outbox and its state — nothing else, nothing taken away", async () => {
  const { MIGRATIONS } = await import("../packages/daisy/src/store/schema.ts");
  const { openDatabase } = await import("../packages/daisy/src/store/open.ts");
  const dir = mkdtempSync(join(tmpdir(), "daisy-events-v3-"));
  try {
    const step = MIGRATIONS.find((m) => m.version === 4)!;
    assert.ok(step, "第 4 步");
    assert.equal(step.breaking, undefined);
    const objects = (db: any) =>
      db
        .prepare("SELECT type||':'||name n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY n")
        .all()
        .map((r: any) => r.n);
    const v3 = openDatabase(dir, { migrations: MIGRATIONS.slice(0, 3) });
    const before = objects(v3.db);
    v3.db.close();
    const v4 = openDatabase(dir, { migrations: MIGRATIONS.slice(0, 4) });
    try {
      const after = objects(v4.db);
      assert.deepEqual(after.filter((n: string) => !before.includes(n)).sort(), [
        "index:event_outbox_recipient",
        "index:event_outbox_subject",
        "index:event_outbox_time",
        "table:event_outbox",
        "table:event_outbox_state",
      ]);
      assert.deepEqual(before.filter((n: string) => !after.includes(n)), []);
    } finally {
      v4.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
