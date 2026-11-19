/**
 * P4-12 界面与命令行 (总纲 5.10, 7.5 P4-12 完成标志, ADR-132):
 *
 * 1. 「5.10 表里的命令全部可用」: every command 5.10 names (its table and
 *    the two it adds) is a command of `daisy` — read from the plan
 *    itself, minus the phase 5 build still to come (none left: P5-03's
 *    `daisy pair` and P5-02's `daisy relay` are here), which must not
 *    appear unnoticed.
 * 2. 「每个网页上的操作都有对应的命令（两类例外除外）」: from the route
 *    table — every route the web page may call has a command, except a
 *    pinned list, each entry with its kind: the plan's exception
 *    (answering one's own AI's tool approvals and questions), a local
 *    command doing it, or not an operation of the owner's. And from the
 *    web page's own code: every route it calls is in that table.
 * 3. The two read-only views P4-12 adds: the agents others may call
 *    (`GET /api/agents`, PIN) and what my AIs called (`GET /api/calls`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  API_ROUTES,
  LOCAL_COMMANDS,
  cliCommands,
  fillPath,
  type AnyRoute,
} from "../packages/contracts/src/index.ts";
import { api } from "../packages/contracts/src/api/index.ts";
import { TREE } from "../packages/daisy/src/cli/main.ts";
import { setup as runnerSetup, until } from "./fixtures/scheduler-harness.ts";
import { pinDouble } from "./fixtures/pin-double.ts";
import { peerDaisy } from "./fixtures/peer-daisy.ts";
import { daisy as issuerDaisy, runningTurn } from "./fixtures/daisy-with-issuer.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { agentKindLabel, bashAllowed, callerLine, decisions, grouped, isolationCaveat, tokenStateLabel, waitingLine } from "../packages/ui/src/sharing-view.ts";
import { inUiLang, uiLang } from "./ui-pack.ts";

process.env.DAISY_SIDECAR_BWRAP = "0";
// P6-22: the pages' words are the UI pack's; these assertions read Chinese.
uiLang("zh-CN");

// ── 1. 5.10's commands ───────────────────────────────────────────────────

/** Built in phase 5 (plan 7.6): not yet here — and noticed when they come. */
const PHASE_5: Record<string, string> = {};

// The build plan is a private construction document (ADR-150): not in the public tree.
const PLAN = "docs/DAISY-BUILD-PLAN.md";
test("5.10: every command the plan names is a command of daisy (pair came with P5-03, relay with P5-02)", { skip: !existsSync(PLAN) && "the build plan is not in this tree" }, () => {
  const plan = readFileSync(PLAN, "utf8");
  const sec = plan.slice(plan.indexOf("### 5.10 接口"), plan.indexOf("### 5.11"));
  const named = new Set<string>();
  for (const m of sec.matchAll(/`daisy ([a-z]+)`/g)) named.add(m[1]!);
  // `daisy start` · `stop` · `status`, `daisy update` · `doctor`
  for (const m of sec.matchAll(/^\| `daisy [a-z]+`((?: · `[a-z]+`)+)/gm))
    for (const x of m[1]!.matchAll(/`([a-z]+)`/g)) named.add(x[1]!);
  assert.deepEqual(
    [...named].sort(),
    ["agent", "autostart", "contact", "doctor", "login", "open", "pair", "pin", "relay", "request", "session", "start", "status", "stop", "token", "uninstall", "update"],
    "5.10 的命令表变了：更新这条测试",
  );
  const top = new Set([...LOCAL_COMMANDS, ...TREE.children.map((c) => c.name)]);
  for (const name of named) {
    if (name in PHASE_5) {
      assert.ok(!top.has(name), `daisy ${name} 已经有了（${PHASE_5[name]}）：从 PHASE_5 里去掉`);
      continue;
    }
    assert.ok(top.has(name), `5.10 的 daisy ${name} 不存在`);
  }
});

test("P4-12's commands: contact, request, grant, agent (three kinds, range, 问与办, residents), token, call", () => {
  const have = new Set(cliCommands(API_ROUTES).map((c) => c.path.join(" ")));
  for (const c of [
    "contact export", "contact inspect", "contact import", "contact list", "contact show", "contact remove", "contact whitelist add", "contact whitelist remove",
    "request list", "request show", "request decide",
    "grant list", "grant revoke",
    "agent list", "agent public show", "agent public set", "agent audience show", "agent audience set", "agent act show", "agent act set",
    "agent resident list", "agent resident show", "agent resident create", "agent resident set", "agent resident pause", "agent resident resume", "agent resident close", "agent resident delete",
    "token issue", "token list", "token revoke",
    "call list", "call show",
  ])
    assert.ok(have.has(c), `daisy ${c}`);
  // token.md §7's spelling: daisy token issue --for <联系人|me> [--ttl 7d] [--note …]; revoke <jti>.
  const issue = cliCommands(API_ROUTES).find((c) => c.path.join(" ") === "token issue")!;
  assert.deepEqual(issue.options.map((o) => o.flag).sort(), ["--for", "--note", "--ttl"]);
  assert.equal(issue.pin, true);
  assert.deepEqual(cliCommands(API_ROUTES).find((c) => c.path.join(" ") === "token revoke")!.args.map((a) => a.name), ["jti"]);
});

// ── 2. every web operation has a command ────────────────────────────────

/**
 * The routes the web page may call that have no command — every one, by
 * kind. A new one fails here until it is a command or added with a kind.
 */
const NO_COMMAND: Record<string, "answer-ai" | `local:${string}` | "not-an-operation"> = {
  // The plan's exception (5.10 「只有一类例外」, 5.11 「替 AI 点头」): answering
  // one's own AI's tool approvals, and its questions — web and paired devices only.
  "approval.respond": "answer-ai",
  "session.answerApproval": "answer-ai",
  // A local command does it (it works while Daisy is not running, or makes several calls).
  "settings.autostartStatus": "local:autostart",
  "settings.autostartSet": "local:autostart",
  "settings.openCode": "local:open",
  "settings.openCodeExternal": "local:open",
  "system.health": "local:status",
  // P5-06 (ADR-145): `daisy update --check / --apply` (also while Daisy is not running).
  "settings.updateCheck": "local:update",
  "settings.updateApply": "local:update",
  "settings.updateSourceSet": "local:update",
  // Not an operation of the owner's: the web page's own session, the PIN
  // traded for a grant (every PIN command does it itself), the live socket,
  // a second spelling, plumbing for an embedding platform / push sender.
  "settings.webSession": "not-an-operation",
  "settings.webLogout": "not-an-operation",
  "settings.pinGrant": "not-an-operation",
  // P5-03: the other device trading its pairing code / device credential
  // (the command line has its own credential, it pairs nothing of its own).
  "settings.pairRedeem": "not-an-operation",
  "settings.deviceSession": "not-an-operation",
  "system.live": "not-an-operation",
  // P6-20 (ADR-159 §4): the web page's own language pack.
  "system.locales": "not-an-operation",
  "settings.notificationsPatch": "not-an-operation",
  "settings.notificationsMirror": "not-an-operation",
  "settings.notificationsRelease": "not-an-operation",
  "settings.notificationsCheck": "not-an-operation",
};

test("every route the web page may call has a command — except the pinned list (the plan's exception, a local command, not an operation)", () => {
  const commands = new Map(cliCommands(API_ROUTES).map((c) => [c.route, c]));
  const without = API_ROUTES.filter((r) => r.channels.includes("web") && !commands.has(r.id)).map((r) => r.id);
  assert.deepEqual(without.sort(), Object.keys(NO_COMMAND).sort(), "网页能调用、却没有命令的接口变了：做成命令，或在 NO_COMMAND 里写明是哪一类例外");
  for (const [id, kind] of Object.entries(NO_COMMAND)) {
    const r = API_ROUTES.find((x) => x.id === id)!;
    if (kind === "answer-ai") assert.deepEqual([...r.channels].sort(), ["device", "web"], `${id}: 命令行不提供`);
    else if (kind.startsWith("local:")) {
      const local = kind.slice("local:".length);
      assert.ok((LOCAL_COMMANDS as readonly string[]).includes(local), `${id}: daisy ${local}`);
    }
  }
  // Exactly two routes are the plan's exception.
  assert.deepEqual(Object.entries(NO_COMMAND).filter(([, k]) => k === "answer-ai").map(([id]) => id).sort(), ["approval.respond", "session.answerApproval"]);
  // Every change the web page can make (not a GET) that is a command can be made from the command line.
  for (const r of API_ROUTES)
    if (r.channels.includes("web") && commands.has(r.id)) assert.ok(r.channels.includes("cli"), `${r.id}: 有命令，命令行却不能调用`);
});

/** Every `api.<file>.<route>` the web page's code (packages/ui, packages/client) names. */
function routesTheWebCalls(): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  walk("packages/ui/src");
  walk("packages/client/src");
  const ids = new Set<string>();
  for (const f of files)
    for (const m of readFileSync(f, "utf8").matchAll(/\bapi\.([a-zA-Z0-9]+)\.([a-zA-Z0-9]+)\b/g)) {
      const group = (api as Record<string, Record<string, AnyRoute>>)[m[1]!];
      // Not a route file (`api.example.com` in a placeholder).
      if (!group || !Object.hasOwn(api, m[1]!)) continue;
      const r = group[m[2]!];
      assert.ok(r, `${f}: api.${m[1]}.${m[2]} 不在接口表里`);
      ids.add(r.id);
    }
  return [...ids];
}

test("the web page's own code: each route it calls by definition has a command, or is in the pinned list", () => {
  const commands = new Set(cliCommands(API_ROUTES).map((c) => c.route));
  const used = routesTheWebCalls();
  // The P4-12 pages are among them (contacts, requests, grants, agents, residents, tokens, calls).
  for (const id of [
    "grant.contactExport", "grant.contactInspect", "grant.contactImport", "grant.contactList", "grant.contactRemove", "grant.contactWhitelistAdd", "grant.contactWhitelistRemove",
    "grant.requestList", "grant.requestDecide", "grant.grantList", "grant.grantRevoke",
    "grant.agentList", "grant.audienceShow", "grant.audienceSet", "grant.actShow", "grant.actSet", "grant.publicSet",
    "grant.residentShow", "grant.residentCreate", "grant.residentSet", "grant.residentPause", "grant.residentResume", "grant.residentClose", "grant.residentDelete",
    "grant.tokenIssue", "grant.tokenList", "grant.tokenRevoke",
    "session.outgoingList",
  ])
    assert.ok(used.includes(id), `网页没有用到 ${id}`);
  // P5-03: what only a paired device does to itself (unpairing) — not the
  // web page's or the command line's: no command, by its channels.
  const DEVICE_ONLY = ["settings.deviceForget"];
  for (const id of DEVICE_ONLY) assert.deepEqual(API_ROUTES.find((r) => r.id === id)!.channels, ["device"], id);
  for (const id of used) assert.ok(commands.has(id) || id in NO_COMMAND || DEVICE_ONLY.includes(id), `网页调用的 ${id} 没有命令`);
});

// ── 3. the two read-only views ───────────────────────────────────────────

test("GET /api/calls (我的 AI 调用了谁): the owner reads it; the AI and a visitor do not; newest first, filters, the answer cut in the list and whole in show", async () => {
  const s = await issuerDaisy();
  const b = await peerDaisy("B");
  try {
    const t = await runningTurn(s);
    const web = { authorization: `Bearer ${s.ctx.issueToken()}` };
    // Refusals first.
    for (const [h, status, code] of [
      [{}, 401, "unauthenticated"],
      [{ authorization: `Bearer ${t.ai}` }, 403, "channel_not_allowed"],
    ] as const) {
      const r = await s.ctx.app.inject({ url: "/api/calls", headers: h });
      assert.equal(r.statusCode, status);
      assert.equal(r.json().code, code);
    }
    const sid = t.own;
    const add = (id: string, o: Record<string, unknown>) =>
      s.ctx.store.run(
        "INSERT INTO a2a_calls(id,session_id,contact_id,contact_name,agent_id,agent_name,mode,message_id,message,state,trace_id,depth,created,updated,answer,files,status_text) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        o.session ?? sid,
        o.contact ?? "c-b",
        "B",
        "research",
        "研究助手",
        o.mode ?? "ask",
        `m-${id}`,
        JSON.stringify({ message: { messageId: `m-${id}`, role: "ROLE_USER", parts: [{ text: `问题 ${id}` }] } }),
        o.state ?? "TASK_STATE_COMPLETED",
        "0af7651916cd43dd8448eb211c80319c",
        1,
        o.at,
        o.at,
        o.answer ?? null,
        o.files ?? null,
        o.statusText ?? null,
      );
    add("c1", { at: 1000, answer: "答".repeat(3000), files: JSON.stringify(["报告.pdf"]) });
    add("c2", { at: 2000, state: "TASK_STATE_WORKING", mode: "act", contact: "c-c" });
    add("c3", { at: 3000, state: "error", statusText: "对方不在线" });
    const list = await s.ctx.app.inject({ url: "/api/calls", headers: web });
    assert.equal(list.statusCode, 200, list.body);
    const calls = list.json().calls;
    assert.deepEqual(calls.map((c: any) => c.id), ["c3", "c2", "c1"]);
    const c1 = calls[2];
    assert.equal(c1.text, "问题 c1");
    assert.equal(c1.stateLabel, "已完成");
    assert.deepEqual(c1.files, ["报告.pdf"]);
    assert.equal([...c1.answer].length, 2000, "cut in the list");
    assert.equal(c1.session.id, sid);
    assert.equal(calls[1].mode, "act");
    assert.equal(calls[0].stateLabel, "没有完成");
    assert.equal(calls[0].statusText, "对方不在线");
    const open = await s.ctx.app.inject({ url: "/api/calls?state=open", headers: s.asCli });
    assert.deepEqual(open.json().calls.map((c: any) => c.id), ["c2"]);
    const byContact = await s.ctx.app.inject({ url: "/api/calls?contact=c-c", headers: s.asCli });
    assert.deepEqual(byContact.json().calls.map((c: any) => c.id), ["c2"]);
    const show = await s.ctx.app.inject({ url: "/api/calls/c1", headers: s.asCli });
    assert.equal([...show.json().answer].length, 3000, "whole in show");
    assert.equal((await s.ctx.app.inject({ url: "/api/calls/nope", headers: s.asCli })).json().code, "call_not_found");
    // No PIN asked, nothing audited (a read).
    assert.equal(s.ctx.store.one("SELECT COUNT(*) n FROM audit WHERE action LIKE '%outgoing%'").n, 0);
  } finally {
    b.close();
    await s.close();
  }
});

test("GET /api/agents: the agents others may call — public sessions and residents, with range, 办, cards and grants; the PIN on the command line only; private sessions not listed", async () => {
  const pin = pinDouble();
  const h: any = await runnerSetup({}, { pin, sharedHost: () => false, peerIsOwner: () => true });
  const b = await peerDaisy("B");
  try {
    const asCli = { authorization: `Bearer ${readFileSync(join(h.dir, "keys", "cli-credential"), "utf8").trim()}` };
    const withPin = () => ({ ...asCli, [PIN_GRANT_HEADER]: pin.grant("246810", "cli").grant });
    const call = (r: AnyRoute, o: { params?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {}) =>
      h.ctx.app.inject({ method: r.method, url: fillPath(r.path, o.params ?? {}), headers: o.headers ?? withPin(), ...(o.body !== undefined ? { payload: o.body } : {}) });
    // D-40 ①: the command line reads with the PIN only (its credential may be
    // the owner's AI); the web page without (the AI's credential is refused —
    // the matrix in tests/access.test.ts).
    const noPin = await call(api.agents.agentList, { headers: asCli });
    assert.equal(noPin.json().code, "pin_required");
    const web = await call(api.agents.agentList, { headers: { authorization: `Bearer ${h.ctx.issueToken()}` } });
    assert.equal(web.statusCode, 200, web.body);
    assert.deepEqual(web.json().agents, []);
    assert.equal((await call(api.contacts.contactImport, { body: { card: b.text } })).statusCode, 200);
    await until(
      () => h.ctx.store.one("SELECT capabilities FROM nodes WHERE id=?", h.config.nodeId)?.capabilities || "{}",
      (x: string) => !!JSON.parse(x)?.agentFeatures,
      300,
    );
    const ws = join(realpathSync(h.dir), "ws-agents");
    mkdirSync(ws, { recursive: true });
    const w = await h.c.request("/workspaces", "POST", { nodeId: h.config.nodeId, label: "agents", path: ws });
    const cat = await h.c.catalog();
    const profile = cat.profiles.find((p: any) => p.agent === "claude").id;
    const priv = await h.c.create({ agent: "claude", title: "私人助手", profileId: profile, workspaceId: w.id });
    const pub = await h.c.create({ agent: "claude", title: "研究助手", profileId: profile, workspaceId: w.id });
    assert.equal((await call(api.invoke.publicSet, { params: { id: pub.id }, body: { public: true } })).statusCode, 200);
    assert.equal((await call(api.invoke.audienceSet, { params: { aid: pub.id }, body: { openTo: "listed", listed: [b.card.id] } })).statusCode, 200);
    assert.equal((await call(api.invoke.actSet, { params: { aid: pub.id }, body: { act: false } })).statusCode, 200);
    const res = await call(api.residents.residentCreate, { body: { name: "客服", harness: "claude", workspaceId: w.id, profileId: profile } });
    assert.equal(res.statusCode, 200, res.body);
    // A card waiting on the resident (B is not whitelisted; open to all).
    const card = h.ctx.access.invoke.check(await h.ctx.access.guard.identify(await b.token(h.ctx.access.ai.urn), "external"), res.json().id);
    assert.equal(card.outcome, "pending");
    const r = await call(api.agents.agentList);
    assert.equal(r.statusCode, 200, r.body);
    const agents = r.json().agents;
    assert.deepEqual(agents.map((a: any) => [a.kind, a.name]), [["public", "研究助手"], ["resident", "客服"]]);
    assert.ok(!agents.some((a: any) => a.id === priv.id), "a private session is not listed");
    assert.deepEqual(
      { openTo: agents[0].openTo, listed: agents[0].listed, act: agents[0].act, sessionId: agents[0].sessionId, state: agents[0].state },
      { openTo: "listed", listed: 1, act: false, sessionId: pub.id, state: "running" },
    );
    assert.deepEqual(
      { openTo: agents[1].openTo, pending: agents[1].pending, grants: agents[1].grants, act: agents[1].act, state: agents[1].state },
      { openTo: "all", pending: 1, grants: 0, act: null, state: "running" },
    );
    // A closed resident stays listed (as closed) until deleted.
    assert.equal((await call(api.residents.residentClose, { params: { aid: res.json().id }, headers: asCli })).statusCode, 200);
    const after = (await call(api.agents.agentList)).json().agents;
    assert.equal(after.find((a: any) => a.kind === "resident").state, "closed");
  } finally {
    await h.close();
    b.close();
  }
});

// ── the pages' words ─────────────────────────────────────────────────────

test("the pages' words: a card's waiting count and its AIs, the issuer marked, the isolation caveat when Bash is allowed", () => {
  assert.equal(waitingLine({ waiting: 2, calls: 3, actors: ["agent:a", "agent:b"] }), "在等 2 次调用，共 3 次，来自 2 个 AI：agent:a、agent:b");
  assert.equal(waitingLine({ waiting: 1, calls: 1, actors: [] }), "在等 1 次调用，对方没有说是哪个 AI");
  assert.match(callerLine({ name: "x（外部签发方）", issuer: "https://login.example", contactId: null }), /由外部签发方 https:\/\/login.example 担保，不是你通讯录里的人/);
  assert.equal(callerLine({ name: "B", issuer: null, contactId: "abcd" }), "B · 互认的联系人");
  assert.equal(callerLine({ name: "我自己（daisy token）", issuer: null, contactId: null }), "我自己（daisy token）");
  // ADR-126 decision 8: the harness's default tools include Bash; `*` too; read-only tools do not.
  for (const [tools, on] of [[null, true], [["*"], true], [["Read", "Bash(git:*)"], true], [["Read", "Grep", "Glob"], false]] as const)
    assert.equal(bashAllowed({ tools: tools as any, harness: "claude" }), on, JSON.stringify(tools));
  assert.match(isolationCaveat(), /共用这个 agent 的工作区/);
  assert.equal(grouped("abcdefghij"), "abcd efgh ij");
});

test("P6-22: the pages' words in English (the UI pack switched)", async () => {
  await inUiLang("en", () => {
    assert.equal(waitingLine({ waiting: 2, calls: 3, actors: ["agent:a", "agent:b"] }), "Calls waiting: 2 of 3; from 2 AI(s): agent:a, agent:b");
    assert.match(waitingLine({ waiting: 1, calls: 1, actors: [] }), /did not say which AI/);
    assert.match(callerLine({ name: "x", issuer: "https://login.example", contactId: null }), /external issuer https:\/\/login.example/);
    assert.equal(callerLine({ name: "B", issuer: null, contactId: "abcd" }), "B · contact");
    assert.match(isolationCaveat(), /share this agent's workspace/);
    assert.deepEqual(decisions().map((d) => d.label), ["Always allow", "Just this once", "Reject"]);
    assert.equal(agentKindLabel({ kind: "resident", state: "paused" } as any), "Resident agent · paused");
    assert.equal(tokenStateLabel({ state: "revoked", revokedWhy: "pin_reset" } as any), "Void (PIN reset)");
  });
  // Back in Chinese.
  assert.deepEqual(decisions().map((d) => d.label), ["永久通过", "仅本次", "拒绝"]);
});
