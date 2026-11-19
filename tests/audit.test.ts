/**
 * P1-11 (原则 7, S-4, trace.md): every action is audited — who, which way
 * in (face, channel), on what (route, object), the outcome, the trace id —
 * and one trace id follows an action into the turn it starts and that
 * turn's tool actions. The owner reads the audit and the logs; the AI
 * cannot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import {
  cliTree,
  API_ROUTES,
  type AuditRecord,
} from "../packages/contracts/src/index.ts";
import { cliCommandOf } from "../packages/contracts/src/api/index.ts";
import {
  formatTraceparent,
  newSpanId,
  newTraceId,
  parseTraceparent,
} from "../packages/daisy/src/observe/trace.ts";
import { onLog, log } from "../packages/daisy/src/observe/log.ts";
import { pinDouble } from "./fixtures/pin-double.ts";
import { runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";

const HEX32 = /^[0-9a-f]{32}$/;

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "daisy-audit-"));
  const pin = pinDouble();
  const ctx = await createApp({
    pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    sharedHost: () => false,
    pin,
  });
  const cli = readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim();
  const inject = runnerInject(ctx.app, ctx.runnerApi);
  const web = ctx.issueToken();
  const nodeId = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8")).nodeId;
  const auditOf = async (query: Record<string, string> = {}, token = cli) => {
    const r = await ctx.app.inject({
      url: "/api/audit?" + new URLSearchParams(query),
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json() as { records: AuditRecord[]; next: string | null };
  };
  const close = async () => {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, ctx, pin, cli, web, inject, nodeId, auditOf, close };
}

type S = Awaited<ReturnType<typeof setup>>;

async function newSession(s: S, token = s.web, headers: Record<string, string> = {}) {
  const h = { authorization: `Bearer ${token}`, ...headers };
  const cat = (await s.inject({ url: "/api/catalog", headers: h })).json();
  const r = await s.inject({
    method: "POST",
    url: "/api/sessions",
    headers: h,
    payload: {
      agent: "claude",
      workspaceId: cat.workspaces[0].id,
      profileId: cat.profiles.find((p: any) => p.agent === "claude").id,
    },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}

test("traceparent: W3C format, accepted only when well-formed", () => {
  const t = newTraceId(),
    p = newSpanId();
  assert.match(t, HEX32);
  assert.match(p, /^[0-9a-f]{16}$/);
  assert.deepEqual(parseTraceparent(formatTraceparent(t, p)), { traceId: t, parentId: p, flags: "00" });
  assert.equal(parseTraceparent(`00-${t}-${p}-01`)?.traceId, t);
  // A later version may carry more fields; version ff is invalid.
  assert.equal(parseTraceparent(`01-${t}-${p}-00-more`)?.traceId, t);
  for (const bad of [
    undefined,
    "",
    `00-${t}-${p}-00-extra`,
    `ff-${t}-${p}-00`,
    `00-${"0".repeat(32)}-${p}-00`,
    `00-${t}-${"0".repeat(16)}-00`,
    `00-${t.toUpperCase()}-${p}-00`,
    `00-${t.slice(1)}-${p}-00`,
    ["a", "b"],
  ])
    assert.equal(parseTraceparent(bad), null, String(bad));
});

test("S-4: an action by the owner is audited — who, face, channel, route, object, outcome, trace; the handler's own row shares the trace", async () => {
  const s = await setup();
  try {
    const trace = newTraceId();
    const sess = await newSession(s, s.web, { traceparent: formatTraceparent(trace, newSpanId()) });
    const { records } = await s.auditOf({ trace });
    const req = records.find((r) => r.action === "api.session.create")!;
    assert.ok(req, "没有这次请求的审计");
    assert.equal(req.actor, "owner");
    assert.equal(req.face, "local");
    assert.equal(req.channel, "web");
    assert.equal(req.route, "session.create");
    assert.equal(req.object, sess.id, "新建的对象记下它的 id");
    assert.equal(req.outcome, "ok");
    assert.equal(req.status, 200);
    assert.equal(req.trace, trace, "入站的 traceparent 沿用");
    // P1-03 review M-2's shape of the row's target.
    assert.deepEqual(JSON.parse(req.target), { face: "local", channel: "web", status: 200 });
    const domain = records.find((r) => r.action === "session.create")!;
    assert.ok(domain, "处理函数自己的领域审计");
    assert.equal(domain.object, sess.id);
    assert.equal(domain.channel, "web");
    assert.equal(domain.route, "session.create");
    // The command line: actor cli; a new trace when none is sent.
    const r = await s.inject({
      method: "PATCH",
      url: `/api/sessions/${sess.id}`,
      headers: { authorization: `Bearer ${s.cli}` },
      payload: { title: "renamed" },
    });
    assert.equal(r.statusCode, 200, r.body);
    const cliRow = (await s.auditOf({ route: "session.update" })).records[0]!;
    assert.equal(cliRow.actor, "cli");
    assert.equal(cliRow.channel, "cli");
    assert.equal(cliRow.object, sess.id);
    assert.match(cliRow.trace!, HEX32);
    assert.notEqual(cliRow.trace, trace);
    // A refusal by the handler (not found): recorded with its code.
    await s.inject({
      method: "POST",
      url: "/api/sessions/no-such/cancel",
      headers: { authorization: `Bearer ${s.cli}` },
      payload: {},
    });
    const miss = (await s.auditOf({ route: "session.cancel" })).records[0]!;
    assert.equal(miss.outcome, "error");
    assert.equal(miss.object, "no-such");
    assert.equal(miss.status, 404);
    assert.ok(miss.reason);
    // Reads are not audited (only refusals and the reads that say so).
    await s.inject({ url: `/api/sessions/${sess.id}`, headers: { authorization: `Bearer ${s.cli}` } });
    assert.equal((await s.auditOf({ route: "session.show" })).records.length, 0);
  } finally {
    await s.close();
  }
});

test("S-4: a malformed traceparent counts as none — a new trace and one warning", async () => {
  const s = await setup();
  const lines: string[] = [];
  const off = onLog((l) => lines.push(l.text));
  try {
    const r = await s.inject({
      method: "POST",
      url: "/api/web/open-code",
      headers: { authorization: `Bearer ${s.cli}`, traceparent: "00-NOT-A-TRACE-00" },
      payload: {},
    });
    assert.equal(r.statusCode, 200);
    const row = (await s.auditOf({ route: "settings.openCode" })).records.find((x) => x.action === "api.settings.openCode")!;
    assert.match(row.trace!, HEX32);
    assert.ok(lines.some((l) => /traceparent/.test(l)), "没有记下警告");
  } finally {
    off();
    await s.close();
  }
});

test("S-4: refusals carry who and why under the request's trace; PIN-guarded actions record success and refusal", async () => {
  const s = await setup();
  try {
    const trace = newTraceId();
    await s.inject({
      method: "PUT",
      url: "/api/access/passcode",
      headers: { authorization: `Bearer ${s.web}`, traceparent: formatTraceparent(trace, newSpanId()) },
      payload: { mode: "on" },
    });
    const denied = (await s.auditOf({ trace })).records;
    assert.equal(denied.length, 1, "一次拒绝只记一条");
    assert.equal(denied[0]!.action, "access.denied");
    assert.equal(denied[0]!.outcome, "denied");
    assert.equal(denied[0]!.reason, "pin_required");
    assert.equal(denied[0]!.route, "settings.passcode");
    assert.equal(denied[0]!.actor, "owner");
    assert.equal(denied[0]!.channel, "web");
    const g = s.pin.grant("246810", `web:${createHash("sha256").update(s.web).digest("hex")}`).grant;
    const ok = await s.inject({
      method: "PUT",
      url: "/api/access/passcode",
      headers: { authorization: `Bearer ${s.web}`, [PIN_GRANT_HEADER]: g },
      payload: { mode: "on" },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    const rows = (await s.auditOf({ route: "settings.passcode", outcome: "ok" })).records;
    assert.deepEqual(rows.map((r) => r.action).sort(), ["access.passcode", "api.settings.passcode"]);
    assert.equal(rows[0]!.trace, rows[1]!.trace);
    // Nobody at all: anonymous, channel none.
    await s.inject({ method: "POST", url: "/api/sessions", payload: {} });
    const anon = (await s.auditOf({ actor: "anonymous", route: "session.create" })).records[0]!;
    assert.equal(anon.reason, "unauthenticated");
    assert.equal(anon.channel, "none");
  } finally {
    await s.close();
  }
});

test("trace: a message's turn records the trace; the AI's requests and its harness tools continue it; S-4 for the AI (session and turn)", async () => {
  const s = await setup();
  try {
    const sess = await newSession(s);
    const trace = newTraceId();
    const sent = await s.inject({
      method: "POST",
      url: `/api/sessions/${sess.id}/messages`,
      headers: { authorization: `Bearer ${s.web}`, traceparent: formatTraceparent(trace, newSpanId()) },
      payload: { text: "hi", requestId: "req-audit-0001" },
    });
    assert.equal(sent.statusCode, 200, sent.body);
    const job = s.ctx.store.one("SELECT id,trace FROM jobs WHERE session_id=?", sess.id);
    assert.equal(job.trace, trace, "这一轮记下链路号");
    const claimed = (
      await s.inject({ method: "POST", url: "/api/runner/claim", payload: {}, headers: runnerHeaders(s.nodeId) })
    ).json();
    assert.equal(claimed.job.id, job.id);
    const ai = readFileSync(claimed.job.aiCredential.file, "utf8").trim();
    // The harness's tool (in process): audited as the AI of that session
    // and turn, same trace.
    const call = s.ctx.runnerApi(s.nodeId);
    const made = await call(`/sessions/${sess.id}/schedules`, {
      jobId: job.id,
      kind: "wakeup",
      delaySeconds: 600,
      prompt: "check again",
    });
    await call(`/sessions/${sess.id}/schedules/list`, {});
    await call(`/sessions/${sess.id}/schedules/${made.schedule.id}/cancel`, {});
    const tools = (await s.auditOf({ trace, actor: "ai" })).records;
    const byRoute = Object.fromEntries(tools.map((r) => [r.route, r]));
    for (const t of ["tool.wakeup", "tool.schedules", "tool.cancel"]) {
      const r = byRoute[t];
      assert.ok(r, `没有 ${t} 的审计`);
      assert.equal(r.action, t);
      assert.equal(r.channel, "ai");
      assert.equal(r.face, "internal");
      assert.equal(r.sessionId, sess.id);
      assert.equal(r.turnId, job.id);
      assert.equal(r.outcome, "ok");
    }
    assert.equal(byRoute["tool.wakeup"]!.object, made.schedule.id);
    // The AI's working credential: a refused request is the AI's, of that
    // session and turn, under the turn's trace (trace.md §3).
    const other = await newSession(s);
    await s.inject({ url: `/api/sessions/${other.id}`, headers: { authorization: `Bearer ${ai}` } });
    await s.inject({ url: "/api/audit", headers: { authorization: `Bearer ${ai}` } });
    const aiRows = (await s.auditOf({ trace, action: "access.denied" })).records;
    const own = aiRows.find((r) => r.reason === "not_own_session")!;
    assert.ok(own, "AI 读别的会话：没有记下");
    assert.equal(own.actor, "ai");
    assert.equal(own.who, `ai:${sess.id}`);
    assert.equal(own.sessionId, sess.id);
    assert.equal(own.turnId, job.id);
    assert.equal(own.object, other.id);
    // 5.11: the AI cannot read the audit.
    const audit = aiRows.find((r) => r.route === "system.auditList")!;
    assert.equal(audit.reason, "channel_not_allowed");
  } finally {
    await s.close();
  }
});

test("5.11 「查看日志和审计」: the owner (web, command line) reads both, paged and filtered; the AI cannot; reading is itself audited", async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 5; i++)
      await s.inject({
        method: "POST",
        url: "/api/web/open-code",
        headers: { authorization: `Bearer ${s.cli}` },
        payload: {},
      });
    const first = await s.auditOf({ limit: "3", route: "settings.openCode", action: "api.settings.openCode" });
    assert.equal(first.records.length, 3);
    assert.ok(first.next);
    const second = await s.auditOf({ limit: "3", route: "settings.openCode", action: "api.settings.openCode", before: first.next! });
    assert.equal(second.records.length, 2);
    assert.equal(second.next, null);
    const ids = new Set([...first.records, ...second.records].map((r) => r.id));
    assert.equal(ids.size, 5, "翻页不重不漏");
    for (const r of [...first.records, ...second.records]) assert.ok(r.at <= first.records[0]!.at);
    // Filters: channel, time.
    assert.ok((await s.auditOf({ channel: "cli" })).records.every((r) => r.channel === "cli"));
    assert.equal((await s.auditOf({ since: String(Date.now() + 60_000) })).records.length, 0);
    assert.equal((await s.auditOf({ until: "1" })).records.length, 0);
    // The web page reads it too; reading is audited.
    const viaWeb = await s.auditOf({ limit: "1" }, s.web);
    assert.equal(viaWeb.records.length, 1);
    const reads = (await s.auditOf({ route: "system.auditList" })).records;
    assert.ok(reads.some((r) => r.channel === "web" && r.outcome === "ok"));
    // Bad filters: 400.
    const bad = await s.ctx.app.inject({ url: "/api/audit?channel=telepathy", headers: { authorization: `Bearer ${s.cli}` } });
    assert.equal(bad.statusCode, 400);
    // Logs: the owner reads the recent lines; a line logged in a request carries its trace.
    const trace = newTraceId();
    const { runInTrace, systemTrace } = await import("../packages/daisy/src/observe/trace.ts");
    runInTrace({ ...systemTrace(), traceId: trace }, () => log.warn("tagged line"));
    const logs = await s.ctx.app.inject({ url: `/api/logs?trace=${trace}`, headers: { authorization: `Bearer ${s.cli}` } });
    assert.equal(logs.statusCode, 200, logs.body);
    const lines = logs.json().lines;
    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, "tagged line");
    assert.equal(lines[0].trace, trace);
    const aiDenied = await s.ctx.app.inject({ url: "/api/logs", headers: { authorization: "Bearer eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln" } });
    assert.equal(aiDenied.statusCode, 401);
  } finally {
    await s.close();
  }
});

test("the audit routes are in the table: `daisy audit list` / `daisy audit logs`, owner channels only, audited reads", () => {
  const list = API_ROUTES.find((r) => r.id === "system.auditList")!;
  const logs = API_ROUTES.find((r) => r.id === "system.logs")!;
  for (const r of [list, logs]) {
    assert.equal(r.scope, "daisy:manage");
    // P2-01: the owner's channels include the external issuer's token for the owner.
    assert.deepEqual([...r.channels], ["web", "device", "cli", "issuer"]);
    assert.equal(r.audit, true);
  }
  assert.deepEqual(cliCommandOf(list)!.path, ["audit", "list"]);
  assert.deepEqual(cliCommandOf(logs)!.path, ["audit", "logs"]);
  const opts = cliCommandOf(list)!.options.map((o) => o.flag);
  for (const f of ["--limit", "--before", "--since", "--until", "--channel", "--route", "--trace"])
    assert.ok(opts.includes(f), f);
  assert.ok(cliTree);
  // Every action but terminal keystrokes and a POST-shaped query is audited.
  const quiet = API_ROUTES.filter((r) => r.method !== "GET" && !r.audit).map((r) => r.id);
  assert.deepEqual(quiet.sort(), ["session.terminalInput", "settings.notificationsCheck"]);
});

test("schema step 3 (P1-11): a version-2 database gains audit_context, two indexes and jobs.trace — nothing else, nothing taken away", async () => {
  const { MIGRATIONS } = await import("../packages/daisy/src/store/schema.ts");
  const { openDatabase } = await import("../packages/daisy/src/store/open.ts");
  const dir = mkdtempSync(join(tmpdir(), "daisy-audit-v2-"));
  try {
    const step = MIGRATIONS.find((m) => m.version === 3)!;
    assert.ok(step, "第 3 步");
    assert.equal(step.breaking, undefined);
    const objects = (db: any) =>
      db
        .prepare("SELECT type||':'||name n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY n")
        .all()
        .map((r: any) => r.n);
    const v2 = openDatabase(dir, { migrations: MIGRATIONS.slice(0, 2) });
    v2.db.prepare("INSERT INTO audit VALUES('a1','owner','old','x',1)").run();
    const before = objects(v2.db);
    const jobCols = v2.db.prepare("PRAGMA table_info(jobs)").all().map((c: any) => c.name);
    v2.db.close();
    // Up to step 3 only (P2-03 added a step 4 of its own).
    const v3 = openDatabase(dir, { migrations: MIGRATIONS.slice(0, 3) });
    const store = {
      db: v3.db,
      all: (sql: string) => v3.db.prepare(sql).all() as any[],
      one: (sql: string) => v3.db.prepare(sql).get() as any,
      close: () => v3.db.close(),
    };
    try {
      const after = objects(store.db);
      assert.deepEqual(
        after.filter((n: string) => !before.includes(n)).sort(),
        ["index:audit_context_trace", "index:audit_created", "table:audit_context"],
      );
      assert.deepEqual(before.filter((n: string) => !after.includes(n)), []);
      const cols = store.all("PRAGMA table_info(jobs)").map((c) => c.name);
      assert.deepEqual(cols.filter((c) => !jobCols.includes(c)), ["trace"]);
      // A row written before step 3 is still read (no context: defaults).
      assert.equal(store.one("SELECT target FROM audit WHERE id='a1'").target, "x");
      // The audit's own columns are unchanged (released code inserts positionally).
      assert.equal(store.all("PRAGMA table_info(audit)").length, 5);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
