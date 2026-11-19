/**
 * P4-05 问与办 (总纲 5.7, 5.8, D-28, a2a-usage.md §8.1 / §13, ADR-124) over
 * real A2A HTTP: a Daisy with its in-process Runner on the fake CLIs
 * (tests/fixtures/agent.cjs for Claude Code / Codex, acp-agent.cjs for the
 * ACP harnesses), B a whitelisted contact signing its own cross-Daisy
 * tokens. Public agents do not exist before P4-06: a fixture resolver
 * says which sessions are public (`kind: "public"`, the session behind).
 *
 * Refusals first (办 off → ACT_DISABLED, no read-only → ASK_NOT_SUPPORTED,
 * the settings need the PIN); then A-11 (问 on a branch while the owner's
 * turn runs; one sentence on the main line), A-12 (问 cannot write),
 * A-8 (办 queued behind the owner's turn), A-13 (问 then 办 in one
 * conversation), A-17 (no side question / fork: the main line, read-only,
 * said so), input-required, cancel, the card's params.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setup as runnerSetup, until, delay } from "./fixtures/scheduler-harness.ts";
import { pinDouble } from "./fixtures/pin-double.ts";
import { peerDaisy, type PeerDaisy } from "./fixtures/peer-daisy.ts";
import { fakeAcpCommand, recorded } from "./fixtures/acp-scenario.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { api } from "../packages/contracts/src/api/index.ts";
import { fillPath } from "../packages/contracts/src/index.ts";
import { A2A_EXT, weakReadOnlyNote } from "../packages/contracts/src/a2a.ts";
import { askSeparator } from "../packages/contracts/src/ask-sidecar.ts";
import { needsInput } from "../packages/daisy/src/a2a/ask-act-prompt.ts";
// P6-24: the markers in the language these sessions speak (zh-CN in tests).
const ASK_SEPARATOR = askSeparator("zh-CN");
const NEEDS_INPUT = needsInput("zh-CN");
import { safeName } from "../packages/daisy/src/a2a/ask-act.ts";
import type { AgentInfo } from "../packages/daisy/src/invoke/invoke-access.ts";

process.env.DAISY_SIDECAR_BWRAP = "0";
const V = { "a2a-version": "1.0" };
const ACT = { ...V, "a2a-extensions": A2A_EXT.act };

async function world() {
  const pin = pinDouble();
  const h: any = await runnerSetup({}, { pin, sharedHost: () => false, peerIsOwner: () => true });
  const cli = readFileSync(join(h.dir, "keys", "cli-credential"), "utf8").trim();
  const asCli = { authorization: `Bearer ${cli}` };
  const withPin = () => ({ ...asCli, [PIN_GRANT_HEADER]: pin.grant("246810", "cli").grant });
  const b = await peerDaisy("B");
  const imp = await h.ctx.app.inject({
    method: "POST",
    url: api.contacts.contactImport.path,
    headers: withPin(),
    payload: { card: b.text, whitelist: true },
  });
  assert.equal(imp.statusCode, 200, imp.body);
  // The fixture resolver (P4-06 registers the real one): these sessions are public.
  const pub = new Map<string, AgentInfo>();
  h.ctx.access.invoke.agents.add((id: string) => pub.get(id) ?? null);
  h.ctx.a2a.directory.add(() => [...pub.keys()]);
  const urn = h.ctx.access.ai.urn;
  /** The Runner has reported what it runs (「只问」 sidecars, P4-11 features). */
  const reported = () =>
    until(
      () => h.ctx.store.one("SELECT capabilities FROM nodes WHERE id=?", h.config.nodeId)?.capabilities || "{}",
      (c: string) => JSON.parse(c)?.askSidecar?.version >= 1,
      300,
    );
  await reported();
  const makePublic = (sid: string, name = "研究助手") => pub.set(sid, { id: sid, kind: "public", name, sessionId: sid });
  /** A session of `agent` in its own workspace directory. */
  const session = async (agent: string, title: string) => {
    const ws = join(realpathSync(h.dir), `ws-${title}`);
    mkdirSync(ws, { recursive: true });
    const w = await h.c.request("/workspaces", "POST", { nodeId: h.config.nodeId, label: title, path: ws });
    const cat = await h.c.catalog();
    const profile = cat.profiles.find((p: any) => p.agent === agent);
    assert.ok(profile, `an identity of ${agent}`);
    const s = await h.c.create({ agent, title, profileId: profile.id, workspaceId: w.id });
    makePublic(s.id, title);
    return { id: s.id as string, ws };
  };
  let seq = 0;
  const msg = (text: string, more: Record<string, unknown> = {}) => ({
    messageId: `m-${Date.now()}-${++seq}`,
    role: "ROLE_USER",
    parts: [{ text }],
    ...more,
  });
  const actMsg = (text: string, more: Record<string, unknown> = {}) =>
    msg(text, { extensions: [A2A_EXT.act], metadata: { [A2A_EXT.act]: { mode: "act" } }, ...more });
  async function req(who: PeerDaisy, method: string, path: string, body?: unknown, headers: Record<string, string> = V) {
    const r = await fetch(h.url + path, {
      method,
      headers: {
        authorization: `Bearer ${await who.token(urn)}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text };
  }
  /** SendMessage over HTTP+JSON; blocking unless `immediate`. */
  const send = async (aid: string, message: any, o: { headers?: Record<string, string>; immediate?: boolean } = {}) => {
    const r = await req(b, "POST", `/a2a/${aid}/message:send`, { message, configuration: o.immediate ? { returnImmediately: true } : {} }, o.headers ?? V);
    return { ...r, json: r.json?.task ?? r.json };
  };
  const rpc = (aid: string, method: string, params: unknown, headers: Record<string, string> = V) =>
    req(b, "POST", `/a2a/${aid}/jsonrpc`, { jsonrpc: "2.0", id: ++seq, method, params }, headers);
  const getTask = (aid: string, tid: string) => req(b, "GET", `/a2a/${aid}/tasks/${tid}`);
  const waitTask = (aid: string, tid: string, ok: (t: any) => boolean) =>
    until(
      async () => (await getTask(aid, tid)).json,
      (t: any) => !!t && ok(t),
      300,
    );
  const setAct = (aid: string, body: Record<string, unknown>, headers: Record<string, string> = withPin()) =>
    h.ctx.app.inject({ method: "PUT", url: fillPath(api.invoke.actSet.path, { aid }), headers, payload: body });
  const showAct = (aid: string) => h.ctx.app.inject({ url: fillPath(api.invoke.actShow.path, { aid }), headers: withPin() });
  /** The owner's own message (the main line's current turn). */
  const ownerSays = (sid: string, text: string) => h.c.send(sid, text);
  const pendingApproval = (sid: string) =>
    until(
      () => h.c.snapshot(sid),
      (x: any) => x.approvals.some((a: any) => a.status === "pending"),
      300,
    );
  const answer = (t: any) => t?.artifacts?.find((a: any) => a.artifactId === "answer")?.parts?.map((p: any) => p.text) ?? [];
  const ext = (t: any) => t?.metadata?.[A2A_EXT.act];
  const close = async () => {
    await h.close();
    b.close();
  };
  return { reported, h, b, pin, asCli, withPin, session, msg, actMsg, send, rpc, getTask, waitTask, setAct, showAct, ownerSays, pendingApproval, answer, ext, makePublic, close };
}
type World = Awaited<ReturnType<typeof world>>;
const jobsOf = (w: World, sid: string) =>
  w.h.ctx.store.all("SELECT id,status,request_id,cancel FROM jobs WHERE session_id=? ORDER BY created,rowid", sid) as any[];

// ── refusals first ────────────────────────────────────────────────────────

test("settings are the owner's, with the PIN (agent-exposure): without it 403; the AI and a visitor never; bypass modes refused", async () => {
  const w = await world();
  try {
    const s = await w.session("claude", "设置");
    // No PIN grant: 403 pin_required, nothing saved.
    const noPin = await w.setAct(s.id, { act: false }, w.asCli);
    assert.equal(noPin.statusCode, 403, noPin.body);
    assert.equal(noPin.json().code, "pin_required");
    assert.equal(w.h.ctx.store.one("SELECT COUNT(*) n FROM agent_act").n, 0);
    // A visitor (B's cross-Daisy token) on the local API: a2a_only.
    const visitor = await w.h.ctx.app.inject({
      method: "PUT",
      url: fillPath(api.invoke.actSet.path, { aid: s.id }),
      headers: { authorization: `Bearer ${await w.b.token(w.h.ctx.access.ai.urn)}` },
      payload: { act: true },
    });
    assert.equal(visitor.statusCode, 403);
    // Defaults: 办 accepted, auto; 问 on a branch, strong.
    const d = (await w.showAct(s.id)).json();
    assert.equal(d.act, true);
    assert.equal(d.permissionMode, "auto");
    assert.equal(d.set, false);
    assert.deepEqual(d.ask, { readOnly: "strong", ranOn: "branch", why: null });
    assert.ok(!d.modes.includes("bypassPermissions"));
    // A mode that skips every confirmation: refused.
    const bad = await w.setAct(s.id, { permissionMode: "bypassPermissions" });
    assert.equal(bad.statusCode, 400, bad.body);
    assert.equal(bad.json().code, "mode_not_allowed");
    const ok = await w.setAct(s.id, { permissionMode: "acceptEdits" });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().permissionMode, "acceptEdits");
    const back = await w.setAct(s.id, { permissionMode: "session" });
    assert.equal(back.json().permissionMode, null);
    const unknown = await w.showAct("no-such-agent");
    assert.equal(unknown.statusCode, 404);
    // Audited, without secrets.
    const audit = w.h.ctx.store.all("SELECT action FROM audit WHERE action='a2a.act.set'");
    assert.equal(audit.length, 2);
  } finally {
    await w.close();
  }
});

test("A-10: 办 turned off → a call marked 办 is rejected ACT_DISABLED; 问 still answers; the owner's own turns are untouched", async () => {
  const w = await world();
  try {
    const s = await w.session("claude", "关办");
    const off = await w.setAct(s.id, { act: false });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(off.json().act, false);
    const r = await w.send(s.id, w.actMsg("FX_SAY 办好了"), { headers: ACT });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status.state, "TASK_STATE_REJECTED");
    assert.equal(r.json.status.message.parts[1].data.reason, "ACT_DISABLED");
    assert.equal(jobsOf(w, s.id).length, 0, "nothing reached the main line");
    // The card says so.
    const card = await (await fetch(`${w.h.url}/a2a/${s.id}/.well-known/agent-card.json`, {
      headers: { authorization: `Bearer ${await w.b.token(w.h.ctx.access.ai.urn)}` },
    })).json();
    const actExt = card.capabilities.extensions.find((e: any) => e.uri === A2A_EXT.act);
    assert.deepEqual(actExt.params, { act: false, readOnly: "strong" });
    assert.equal(actExt.required, false);
    // 问 still works (a branch).
    const ask = await w.send(s.id, w.msg(`FX_SAY 只读的回答\\n${ASK_SEPARATOR}\\n有人问了进度，答了。`));
    assert.equal(ask.json.status.state, "TASK_STATE_COMPLETED", ask.text);
    assert.equal(w.answer(ask.json)[0], "只读的回答");
    // The owner's own turn runs as before.
    await w.h.turn(s.id, "FX_SAY 主人的这一轮");
    const mine = jobsOf(w, s.id).filter((j) => !j.request_id.startsWith("a2a:"));
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, "completed");
  } finally {
    await w.close();
  }
});

test("no read-only mode (Antigravity over ACP): 问 → ASK_NOT_SUPPORTED, the card says readOnly none; 办 still possible", async () => {
  const w = await world();
  process.env.DAISY_ANTIGRAVITY_BIN = fakeAcpCommand(w.h.dir, "antigravity");
  try {
    // The Runner reports the newly configured binary on its next heartbeat.
    await w.h.restartRunner();
    await until(
      () => w.h.ctx.store.one("SELECT capabilities FROM nodes WHERE id=?", w.h.config.nodeId)?.capabilities || "{}",
      (c: string) => !!JSON.parse(c)?.agentFeatures?.antigravity,
      300,
    );
    const s = await w.session("antigravity", "无只读");
    const r = await w.send(s.id, w.msg("FX_WRITE a.txt x"));
    assert.equal(r.json.status.state, "TASK_STATE_REJECTED", r.text);
    assert.equal(r.json.status.message.parts[1].data.reason, "ASK_NOT_SUPPORTED");
    assert.equal(jobsOf(w, s.id).length, 0);
    assert.equal(existsSync(join(s.ws, "a.txt")), false);
    const v = (await w.showAct(s.id)).json();
    assert.equal(v.ask.readOnly, "none");
    assert.equal(v.ask.ranOn, null);
    const card = await (await fetch(`${w.h.url}/a2a/${s.id}/.well-known/agent-card.json`, {
      headers: { authorization: `Bearer ${await w.b.token(w.h.ctx.access.ai.urn)}` },
    })).json();
    assert.equal(card.capabilities.extensions.find((e: any) => e.uri === A2A_EXT.act).params.readOnly, "none");
    assert.match(card.description, /只接受“办”/);
    // 办 runs (Antigravity has no permission modes: the session's own).
    const act = await w.send(s.id, w.actMsg("FX_SAY 办完了"), { headers: ACT });
    assert.equal(act.json.status.state, "TASK_STATE_COMPLETED", act.text);
    assert.equal(w.answer(act.json)[0], "办完了");
    assert.deepEqual(w.ext(act.json), { mode: "act" });
  } finally {
    delete process.env.DAISY_ANTIGRAVITY_BIN;
    await w.close();
  }
});

// ── 问 ─────────────────────────────────────────────────────────────────────

test("A-11: 问 while the owner's turn runs — answered at once on a read-only branch; the owner's turn is not interrupted; the main line gets one sentence, once", async () => {
  const w = await world();
  try {
    const s = await w.session("claude", "主线");
    await w.ownerSays(s.id, "主人的长任务");
    await w.pendingApproval(s.id); // the owner's turn is running (waiting on her card)
    const ownerJob = jobsOf(w, s.id)[0];
    assert.equal(ownerJob.status, "running");
    const r = await w.send(s.id, w.msg(`进度如何？\nFX_SAY 支线回答：进度 3/5\\n${ASK_SEPARATOR}\\n问了进度，答了 3/5，主线无须处理。`));
    assert.equal(r.json.status.state, "TASK_STATE_COMPLETED", r.text);
    assert.deepEqual(w.answer(r.json), ["支线回答：进度 3/5"]);
    assert.deepEqual(w.ext(r.json), { mode: "ask", readOnly: "strong", ranOn: "branch" });
    // The owner's turn: still running, never stopped, nothing of the ask in its line.
    const now = jobsOf(w, s.id);
    assert.equal(now.length, 1, "no turn was added to the main line");
    assert.equal(now[0].status, "running");
    assert.equal(now[0].cancel, 0);
    const snap = await w.h.c.snapshot(s.id);
    assert.ok(!snap.items.some((i: any) => String(i.text || "").includes("进度如何")), "the question is not in the main line");
    // The branch is a hidden 「只问」 sidecar of this session.
    const turn = w.h.ctx.store.one("SELECT * FROM a2a_turns WHERE task_id=?", r.json.id);
    assert.equal(turn.kind, "branch");
    assert.notEqual(turn.session_id, s.id);
    assert.equal(w.h.ctx.store.session(turn.session_id).sidecar.parent, s.id);
    // The owner finishes her turn; her next turn carries exactly one summary.
    await w.h.settle(s.id);
    await w.h.turn(s.id, "FX_SAY 第二轮");
    await w.h.turn(s.id, "FX_SAY 第三轮");
    const prompts = w.h.lines(w.h.record).map((x: any) => String(x.text || ""));
    const second = prompts.find((t: string) => t.includes("FX_SAY 第二轮"))!;
    const third = prompts.find((t: string) => t.includes("FX_SAY 第三轮"))!;
    assert.match(second, /支线回答摘要（1 条）/);
    assert.match(second, /问了进度，答了 3\/5，主线无须处理。/);
    assert.equal((second.match(/<external_message>/g) || []).length, 1, "one sentence, quoted as external material");
    assert.doesNotMatch(third, /支线回答摘要/, "carried once");
  } finally {
    await w.close();
  }
});

test("A-12: asked in a 问 to change files — nothing is changed (Claude Code: only Read / Grep / Glob; Codex: read-only sandbox)", async () => {
  const w = await world();
  try {
    const c = await w.session("claude", "改文件c");
    const r = await w.send(c.id, w.msg("请把 hack.txt 写成 pwned\nFX_WRITE hack.txt pwned"));
    assert.equal(r.json.status.state, "TASK_STATE_COMPLETED", r.text);
    assert.match(w.answer(r.json)[0], /refused hack\.txt/);
    assert.equal(existsSync(join(c.ws, "hack.txt")), false);
    const spawns = w.h.lines(w.h.spawns).map((x: any) => x.argv as string[]);
    const branch = spawns.find((a: string[]) => a.includes("--tools"));
    assert.ok(branch, "the branch was launched with a tool list");
    assert.equal(branch![branch!.indexOf("--tools") + 1], "Read,Grep,Glob");
    assert.equal(branch![branch!.indexOf("--permission-mode") + 1], "dontAsk");
    const x = await w.session("codex", "改文件x");
    const r2 = await w.send(x.id, w.msg("FX_PATCH hack.txt pwned"));
    assert.equal(r2.json.status.state, "TASK_STATE_COMPLETED", r2.text);
    assert.equal(existsSync(join(x.ws, "hack.txt")), false);
    const threads = w.h.lines(w.h.thread).filter((t: any) => ["thread/start", "thread/fork"].includes(t.via));
    assert.ok(threads.some((t: any) => t.sandbox === "read-only"), JSON.stringify(threads));
    // The owner's own Codex turn does write (the fake honours only the sandbox).
    await w.h.turn(x.id, "FX_PATCH mine.txt ok");
    assert.equal(existsSync(join(x.ws, "mine.txt")), true);
  } finally {
    await w.close();
  }
});

test("P4N-4: a Codex 问 branch forked from a thread with Daisy's tools — calling one is refused in words that keep reading open (its own commands), and nothing runs", async () => {
  const w = await world();
  try {
    const x = await w.session("codex", "支线工具");
    // The main line has a thread, started with Daisy's tools.
    await w.h.turn(x.id, "你好");
    const r = await w.send(
      x.id,
      w.msg(`看看工作目录里有什么\nDAISY_TOOL ${JSON.stringify({ tool: "bash", arguments: { command: "ls", description: "列目录" } })}`),
    );
    assert.equal(r.json.status.state, "TASK_STATE_COMPLETED", r.text);
    const fork = w.h.lines(w.h.thread).filter((t: any) => t.via === "thread/fork").at(-1);
    assert.equal(fork?.sandbox, "read-only");
    const refused = w.h.toolResults().at(-1);
    assert.equal(refused.tool, "bash");
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.text, /只问支线里不能用/);
    assert.match(refused.result.text, /只读不等于不能读：读文件、列目录、搜索请直接用你自己的命令/);
    // Daisy ran nothing for it.
    assert.deepEqual(await w.h.schedules(x.id), []);
  } finally {
    await w.close();
  }
});

test("A-17: a harness with no side question or fork (Kimi Code over ACP) — 问 queues on the main line, read-only (plan), says so; nothing written; the next owner turn is back to her mode", async () => {
  const w = await world();
  process.env.DAISY_KIMI_BIN = fakeAcpCommand(w.h.dir, "kimi");
  try {
    await w.h.restartRunner();
    const s = await w.session("kimi", "无支线");
    const v = (await w.showAct(s.id)).json();
    assert.equal(v.ask.ranOn, "main-queue");
    assert.equal(v.ask.readOnly, "weak");
    const card = await (await fetch(`${w.h.url}/a2a/${s.id}/.well-known/agent-card.json`, {
      headers: { authorization: `Bearer ${await w.b.token(w.h.ctx.access.ai.urn)}` },
    })).json();
    assert.ok(card.description.endsWith(weakReadOnlyNote()), card.description);
    assert.equal(card.capabilities.extensions.find((e: any) => e.uri === A2A_EXT.act).params.readOnly, "weak");
    // The owner's turn runs (its tool waits for her card).
    await w.ownerSays(s.id, "主人的一轮");
    await w.pendingApproval(s.id);
    const r = await w.send(s.id, w.msg("把 notes.txt 改掉\nFX_WRITE notes.txt changed"), { immediate: true });
    const tid = r.json.id;
    await w.waitTask(s.id, tid, (t) => t.status.state === "TASK_STATE_SUBMITTED");
    assert.equal(jobsOf(w, s.id)[0].status, "running", "the owner's turn goes on");
    await w.h.settle(s.id);
    const done = await w.waitTask(s.id, tid, (t) => t.status.state === "TASK_STATE_COMPLETED");
    assert.deepEqual(w.ext(done), { mode: "ask", readOnly: "weak", ranOn: "main-queue" });
    const [ans, note] = w.answer(done);
    assert.match(ans, /refused notes\.txt \(plan\)/);
    assert.match(note, /不支持旁问和分叉.*回落到主线上排队执行，仍然是只读的/);
    assert.equal(existsSync(join(s.ws, "notes.txt")), false);
    // Read-only by set_mode plan, and the owner's next turn back to the default.
    await w.h.turn(s.id, "FX_WRITE owner.txt mine");
    assert.equal(existsSync(join(s.ws, "owner.txt")), true);
    // The 问's turn: set_mode plan, then its prompt (same process). The
    // owner's next turn: a fresh process (the mode is part of what an ACP
    // process is launched with) or set_mode back — never still in plan.
    const rec = recorded(w.h.dir).filter((x: any) => x.method === "session/set_mode" || x.method === "session/prompt");
    const plan = rec.findIndex((x: any) => x.method === "session/set_mode" && x.params.modeId === "plan");
    assert.ok(plan >= 0, JSON.stringify(rec));
    assert.equal(rec[plan + 1].method, "session/prompt");
    assert.equal(rec[plan + 1].pid, rec[plan].pid);
    const last = rec.at(-1);
    const between = rec.slice(plan + 2, -1);
    assert.ok(
      last.pid !== rec[plan].pid || between.some((x: any) => x.method === "session/set_mode" && x.params.modeId === "default"),
      JSON.stringify(rec.slice(plan)),
    );
  } finally {
    delete process.env.DAISY_KIMI_BIN;
    await w.close();
  }
});

test("input-required: the branch asks the caller; the reply (same taskId) continues on the same branch and completes", async () => {
  const w = await world();
  try {
    const s = await w.session("claude", "补充");
    const r = await w.send(s.id, w.msg(`哪个分支的进度？\nFX_SAY ${NEEDS_INPUT}\\n你说的是哪个分支？`));
    assert.equal(r.json.status.state, "TASK_STATE_INPUT_REQUIRED", r.text);
    assert.equal(r.json.status.message.parts[0].text, "你说的是哪个分支？");
    const more = await w.send(s.id, w.msg("main 分支\nFX_SAY main 分支 5/5", { taskId: r.json.id, contextId: r.json.contextId }));
    assert.equal(more.json.status.state, "TASK_STATE_COMPLETED", more.text);
    assert.equal(more.json.id, r.json.id);
    assert.deepEqual(w.answer(more.json), ["main 分支 5/5"]);
    const turns = w.h.ctx.store.all("SELECT kind,session_id FROM a2a_turns WHERE task_id=? ORDER BY created", r.json.id);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].session_id, turns[1].session_id, "the same branch");
    const second = w.h.ctx.store.one("SELECT text FROM jobs WHERE id=(SELECT job_id FROM a2a_turns WHERE task_id=? ORDER BY created DESC LIMIT 1)", r.json.id).text;
    assert.match(second, /这个任务到现在的往来/);
    assert.match(second, /你说的是哪个分支/);
  } finally {
    await w.close();
  }
});

// ── 办 ─────────────────────────────────────────────────────────────────────

test("A-8: 办 while the owner's turn runs — queued behind it (SUBMITTED), her turn not interrupted; then it runs (WORKING) in the 办 mode and completes", async () => {
  const w = await world();
  try {
    const s = await w.session("claude", "办");
    await w.ownerSays(s.id, "主人的长任务");
    await w.pendingApproval(s.id);
    const r = await w.send(s.id, w.actMsg("FX_SAY 办好了"), { headers: ACT, immediate: true });
    const tid = r.json.id;
    await w.waitTask(s.id, tid, (t) => t.status.state === "TASK_STATE_SUBMITTED");
    let jobs = jobsOf(w, s.id);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].status, "running");
    assert.equal(jobs[0].cancel, 0);
    assert.equal(jobs[1].status, "pending", "behind the owner's turn");
    assert.match(jobs[1].request_id, /^a2a:/);
    await w.h.settle(s.id);
    const done = await w.waitTask(s.id, tid, (t) => t.status.state === "TASK_STATE_COMPLETED");
    assert.deepEqual(w.answer(done), ["办好了"]);
    assert.deepEqual(w.ext(done), { mode: "act" });
    jobs = jobsOf(w, s.id);
    assert.deepEqual(jobs.map((j) => j.status), ["completed", "completed"]);
    // The owner's turn ended normally (her card answered), not stopped.
    const end = w.h.ctx.store.one("SELECT data FROM items WHERE session_id=? AND id=?", s.id, `${jobs[0].id}:turn-end`);
    assert.equal(end, undefined, "no stop / interruption notice on her turn");
    // 办 ran with the owner's 办 mode (default auto), never bypass.
    assert.equal(w.h.ctx.store.one("SELECT permission_mode FROM a2a_turns WHERE job_id=?", jobs[1].id).permission_mode, "auto");
    const spawned = w.h.lines(w.h.spawns).map((x: any) => x.argv as string[]);
    const modes = spawned.filter((a: string[]) => a.includes("--permission-mode")).map((a: string[]) => a[a.indexOf("--permission-mode") + 1]);
    const live = w.h.lines(w.h.record).filter((t: any) => t.via === "set_permission_mode").map((t: any) => t.text);
    assert.ok(modes.includes("auto") || live.includes("auto"), JSON.stringify({ modes, live }));
    // The whole exchange stays in the main line (5.7).
    const snap = await w.h.c.snapshot(s.id);
    assert.ok(snap.items.some((i: any) => i.kind === "user" && i.origin?.place === "A2A · 办"));
  } finally {
    await w.close();
  }
});

test("A-13: one conversation — 问 first, then 办: the 办 runs on the main line, same contextId, and the AI is told what was asked before", async () => {
  const w = await world();
  try {
    const s = await w.session("claude", "先问后办");
    const ask = await w.send(s.id, w.msg(`README 的安装步骤在哪？\nFX_SAY 在 docs/install.md\\n${ASK_SEPARATOR}\\n问了安装步骤的位置，答在 docs/install.md。`));
    assert.equal(ask.json.status.state, "TASK_STATE_COMPLETED", ask.text);
    const ctxId = ask.json.contextId;
    const act = await w.send(s.id, w.actMsg("那就把它更新一下\nFX_SAY 已更新", { contextId: ctxId }), { headers: ACT });
    assert.equal(act.json.status.state, "TASK_STATE_COMPLETED", act.text);
    assert.equal(act.json.contextId, ctxId);
    assert.notEqual(act.json.id, ask.json.id);
    const turn = w.h.ctx.store.one("SELECT * FROM a2a_turns WHERE task_id=?", act.json.id);
    assert.equal(turn.kind, "act");
    assert.equal(turn.session_id, s.id, "on the main line");
    const job = w.h.ctx.store.one("SELECT text,preamble FROM jobs WHERE id=?", turn.job_id);
    // What was asked and answered before, as quoted material …
    assert.match(job.text, /这段对话之前的请求与回答/);
    assert.match(job.text, /README 的安装步骤在哪/);
    assert.match(job.text, /在 docs\/install\.md/);
    // … and the branch's one sentence rode this main-line turn.
    assert.match(job.preamble, /问了安装步骤的位置/);
  } finally {
    await w.close();
  }
});

test("cancel: a 办 still queued is withdrawn (the owner's turn untouched); turning 办 off withdraws the waiting ones as ACT_DISABLED", async () => {
  const w = await world();
  try {
    const s = await w.session("claude", "取消");
    await w.ownerSays(s.id, "主人的长任务");
    await w.pendingApproval(s.id);
    const one = (await w.send(s.id, w.actMsg("FX_SAY 一"), { headers: ACT, immediate: true })).json;
    await w.waitTask(s.id, one.id, (t) => t.status.state === "TASK_STATE_SUBMITTED");
    const c = await w.rpc(s.id, "CancelTask", { id: one.id });
    assert.equal(c.json.result.status.state, "TASK_STATE_CANCELED", c.text);
    await until(
      () => jobsOf(w, s.id),
      (j) => j[1]?.status === "interrupted",
    );
    assert.equal(jobsOf(w, s.id)[0].status, "running");
    assert.equal(jobsOf(w, s.id)[0].cancel, 0);
    // Another 办 waits; the owner turns 办 off: it is withdrawn, ACT_DISABLED.
    const two = (await w.send(s.id, w.actMsg("FX_SAY 二"), { headers: ACT, immediate: true })).json;
    await w.waitTask(s.id, two.id, (t) => t.status.state === "TASK_STATE_SUBMITTED");
    const off = await w.setAct(s.id, { act: false });
    assert.equal(off.json().withdrawn, 1, off.body);
    const t2 = await w.waitTask(s.id, two.id, (t) => t.status.state === "TASK_STATE_REJECTED");
    assert.equal(t2.status.message.parts[1].data.reason, "ACT_DISABLED");
    assert.equal(jobsOf(w, s.id)[0].status, "running", "her turn still runs");
    await w.h.settle(s.id);
    assert.equal(jobsOf(w, s.id)[0].status, "completed");
  } finally {
    await w.close();
  }
});

test("safeName: a caller's file name never names a directory", () => {
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("..\\..\\x.txt"), "x.txt");
  assert.equal(safeName("..."), "file");
  assert.equal(safeName("a\u0000b<c>.md"), "a_b_c_.md");
});
