/**
 * P4-06 公开 agent (总纲 5.2, 5.7, 5.11, D-18, A-4, A-9, ADR-125) over real
 * A2A HTTP: a Daisy with its in-process Runner on the fake CLIs, B a
 * whitelisted contact signing its own cross-Daisy tokens. Sessions are made
 * public with the real route (`PUT /api/sessions/:id/public`, PIN) — no
 * fixture resolver.
 *
 * Refusals first (no PIN, a visitor, archived, an identity in bypass, no
 * read-only mode with 办 off; a private session is invisible), then making
 * it public (directory, card, the bypass rule now applies), A-9 (the source in the
 * prompt; each tool action of the turn audited with its task), A-4 (办 in
 * auto mode: tools run without the owner; the one confirmation auto mode
 * still asks goes to her, the caller sees WORKING), taking it back (calls
 * stop, queued turns withdrawn, settings forgotten), deleting the session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setup as runnerSetup, until } from "./fixtures/scheduler-harness.ts";
import { pinDouble } from "./fixtures/pin-double.ts";
import { peerDaisy } from "./fixtures/peer-daisy.ts";
import { fakeAcpCommand } from "./fixtures/acp-scenario.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { api } from "../packages/contracts/src/api/index.ts";
import { fillPath } from "../packages/contracts/src/index.ts";
import { A2A_EXT } from "../packages/contracts/src/a2a.ts";
import { crossTalkNote } from "../packages/contracts/src/api/invoke.ts";
import { needsInput } from "../packages/daisy/src/a2a/ask-act-prompt.ts";
// P6-24: the marker in the language these sessions speak (zh-CN in tests).
const NEEDS_INPUT = needsInput("zh-CN");

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
  const urn = h.ctx.access.ai.urn;
  await until(
    () => h.ctx.store.one("SELECT capabilities FROM nodes WHERE id=?", h.config.nodeId)?.capabilities || "{}",
    (c: string) => JSON.parse(c)?.askSidecar?.version >= 1,
    300,
  );
  /** A private session of `agent` in its own workspace directory. */
  const session = async (agent: string, title: string) => {
    const ws = join(realpathSync(h.dir), `ws-${title}`);
    mkdirSync(ws, { recursive: true });
    const w = await h.c.request("/workspaces", "POST", { nodeId: h.config.nodeId, label: title, path: ws });
    const cat = await h.c.catalog();
    const profile = cat.profiles.find((p: any) => p.agent === agent);
    assert.ok(profile, `an identity of ${agent}`);
    const s = await h.c.create({ agent, title, profileId: profile.id, workspaceId: w.id });
    return { id: s.id as string, ws, profileId: profile.id as string };
  };
  const setPublic = (sid: string, on: boolean, headers: Record<string, string> = withPin()) =>
    h.ctx.app.inject({ method: "PUT", url: fillPath(api.invoke.publicSet.path, { id: sid }), headers, payload: { public: on } });
  const showPublic = (sid: string) =>
    h.ctx.app.inject({ url: fillPath(api.sessions.publicShow.path, { id: sid }), headers: asCli });
  const publicSession = async (agent: string, title: string) => {
    const s = await session(agent, title);
    const r = await setPublic(s.id, true);
    assert.equal(r.statusCode, 200, r.body);
    return s;
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
  async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = V) {
    const r = await fetch(h.url + path, {
      method,
      headers: {
        authorization: `Bearer ${await b.token(urn)}`,
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
  const send = async (aid: string, message: any, o: { headers?: Record<string, string>; immediate?: boolean } = {}) => {
    const r = await req("POST", `/a2a/${aid}/message:send`, { message, configuration: o.immediate ? { returnImmediately: true } : {} }, o.headers ?? V);
    return { ...r, json: r.json?.task ?? r.json };
  };
  const getTask = (aid: string, tid: string) => req("GET", `/a2a/${aid}/tasks/${tid}`);
  const waitTask = (aid: string, tid: string, ok: (t: any) => boolean) =>
    until(
      async () => (await getTask(aid, tid)).json,
      (t: any) => !!t && ok(t),
      300,
    );
  const card = (aid: string) => req("GET", `/a2a/${aid}/.well-known/agent-card.json`);
  const directory = () => req("GET", "/a2a");
  const setAct = (aid: string, body: Record<string, unknown>) =>
    h.ctx.app.inject({ method: "PUT", url: fillPath(api.invoke.actSet.path, { aid }), headers: withPin(), payload: body });
  const pendingApproval = (sid: string) =>
    until(
      () => h.c.snapshot(sid),
      (x: any) => x.approvals.some((a: any) => a.status === "pending"),
      300,
    );
  const answer = (t: any) => t?.artifacts?.find((a: any) => a.artifactId === "answer")?.parts?.map((p: any) => p.text) ?? [];
  const reason = (t: any) => t?.status?.message?.parts?.[1]?.data?.reason;
  const close = async () => {
    await h.close();
    b.close();
  };
  return { h, b, pin, asCli, withPin, session, setPublic, showPublic, publicSession, msg, actMsg, send, getTask, waitTask, card, directory, setAct, pendingApproval, answer, reason, close };
}
type World = Awaited<ReturnType<typeof world>>;
const jobsOf = (w: World, sid: string) =>
  w.h.ctx.store.all("SELECT id,status,request_id,cancel FROM jobs WHERE session_id=? ORDER BY created,rowid", sid) as any[];
const toolAudit = (w: World, tid: string) =>
  w.h.ctx.store.all(
    "SELECT a.action,a.target,c.* FROM audit a JOIN audit_context c ON c.audit_id=a.id WHERE a.action='a2a.tool' AND c.object=? ORDER BY a.created,a.rowid",
    `task:${tid}`,
  ) as any[];

// ── refusals first ────────────────────────────────────────────────────────

test("making a session public needs the PIN (agent-exposure); a visitor never; a private session is nobody's to call", async () => {
  const w = await world();
  try {
    const s = await w.session("claude", "私有");
    // Private: no card, no call, not in the directory.
    assert.equal((await w.card(s.id)).status, 404);
    assert.equal((await w.send(s.id, w.msg("你好"))).status, 404);
    assert.deepEqual((await w.directory()).json?.agents ?? [], []);
    // No PIN grant: 403 pin_required, nothing saved.
    const noPin = await w.setPublic(s.id, true, w.asCli);
    assert.equal(noPin.statusCode, 403, noPin.body);
    assert.equal(noPin.json().code, "pin_required");
    // A visitor's token on the local API: refused.
    const visitor = await w.setPublic(s.id, true, { authorization: `Bearer ${await w.b.token(w.h.ctx.access.ai.urn)}` });
    assert.equal(visitor.statusCode, 403);
    assert.equal(w.h.ctx.store.one("SELECT COUNT(*) n FROM public_agents").n, 0);
    // Reading is the owner's (no PIN): private, can be made public, and what it means.
    const v = w.showPublic(s.id);
    const shown = (await v).json();
    assert.equal(shown.public, false);
    assert.equal(shown.blocked, null);
    assert.equal(shown.crossTalk, crossTalkNote());
    assert.match(shown.crossTalk, /会串话/);
    assert.equal(shown.act, true);
    // An archived session: refused.
    const arch = await w.session("claude", "归档");
    await w.h.c.request(`/sessions/${arch.id}`, "PATCH", { archived: true });
    const r = await w.setPublic(arch.id, true);
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().code, "session_archived");
    assert.match((await w.showPublic(arch.id)).json().blocked, /归档/);
    // Unknown session: 404.
    assert.equal((await w.setPublic("no-such-session", true)).statusCode, 404);
  } finally {
    await w.close();
  }
});

test("an identity that skips every confirmation cannot be made public; once public, its identity cannot be switched to one", async () => {
  const w = await world();
  try {
    // Codex: never + danger-full-access is its bypass (Claude Code's cannot even be chosen through the API).
    const s = await w.session("codex", "绕过");
    const prof = w.h.ctx.store.one("SELECT data FROM profiles WHERE id=?", s.profileId);
    const data = JSON.parse(prof.data);
    const bypass = { permissionMode: "never", sandboxMode: "danger-full-access" };
    // The identity in bypass: refused, not public.
    w.h.ctx.store.run("UPDATE profiles SET data=? WHERE id=?", JSON.stringify({ ...data, ...bypass }), s.profileId);
    const r = await w.setPublic(s.id, true);
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().code, "bypass_not_private");
    assert.match((await w.showPublic(s.id)).json().blocked, /bypassPermissions/);
    assert.equal(w.h.ctx.store.one("SELECT COUNT(*) n FROM public_agents").n, 0);
    // Back to its default: public now — and from then on the identity may not go to bypass (isPrivate is false).
    w.h.ctx.store.run("UPDATE profiles SET data=? WHERE id=?", JSON.stringify(data), s.profileId);
    assert.equal((await w.setPublic(s.id, true)).statusCode, 200);
    const patch = () =>
      w.h.ctx.app.inject({
        method: "PATCH",
        url: `/api/profiles/${s.profileId}`,
        headers: w.asCli,
        payload: { model: data.model ?? "", ...bypass },
      });
    const save = await patch();
    assert.equal(save.statusCode, 409, save.body);
    assert.match(save.json().error, /可被别人发现或调用/);
    // Private again: allowed.
    assert.equal((await w.setPublic(s.id, false)).statusCode, 200);
    const again = await patch();
    assert.equal(again.statusCode, 200, again.body);
  } finally {
    await w.close();
  }
});

test("5.7: a harness with no read-only mode (Antigravity) is public only while 办 is allowed — publishing with 办 off, or turning 办 off while public, is refused", async () => {
  const w = await world();
  process.env.DAISY_ANTIGRAVITY_BIN = fakeAcpCommand(w.h.dir, "antigravity");
  try {
    await w.h.restartRunner();
    await until(
      () => w.h.ctx.store.one("SELECT capabilities FROM nodes WHERE id=?", w.h.config.nodeId)?.capabilities || "{}",
      (c: string) => !!JSON.parse(c)?.agentFeatures?.antigravity,
      300,
    );
    const s = await w.session("antigravity", "无只读");
    assert.equal((await w.setAct(s.id, { act: false })).statusCode, 200, "while private, the owner may set it as she likes");
    const v = (await w.showPublic(s.id)).json();
    assert.equal(v.ask.readOnly, "none");
    assert.match(v.blocked, /允许“办”/);
    const r = await w.setPublic(s.id, true);
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().code, "act_required");
    assert.equal(w.h.ctx.store.one("SELECT COUNT(*) n FROM public_agents").n, 0);
    // 办 on → public.
    assert.equal((await w.setAct(s.id, { act: true })).statusCode, 200);
    assert.equal((await w.setPublic(s.id, true)).statusCode, 200);
    // Now turning 办 off is refused (it would answer nothing).
    const off = await w.setAct(s.id, { act: false });
    assert.equal(off.statusCode, 409, off.body);
    assert.equal(off.json().code, "act_required");
    // 问 is refused as before (P4-05), 办 runs.
    const ask = await w.send(s.id, w.msg("FX_SAY 不该回答"));
    assert.equal(w.reason(ask.json), "ASK_NOT_SUPPORTED");
    const act = await w.send(s.id, w.actMsg("FX_SAY 办完了"), { headers: ACT });
    assert.equal(act.json.status.state, "TASK_STATE_COMPLETED", act.text);
  } finally {
    delete process.env.DAISY_ANTIGRAVITY_BIN;
    await w.close();
  }
});

// ── public ────────────────────────────────────────────────────────────────

test("public: listed, its card readable, callable (问 on a branch); audited; doing it twice changes nothing", async () => {
  const w = await world();
  try {
    const s = await w.session("claude", "研究助手");
    const r = await w.setPublic(s.id, true);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().public, true);
    assert.ok(r.json().since > 0);
    assert.equal(r.json().crossTalk, crossTalkNote());
    const again = await w.setPublic(s.id, true);
    assert.equal(again.json().since, r.json().since, "the same, not made public twice");
    assert.equal(w.h.ctx.access.invoke.agents.resolve(s.id).kind, "public");
    const dir = await w.directory();
    assert.equal(dir.status, 200, dir.text);
    assert.match(dir.text, new RegExp(s.id));
    const c = await w.card(s.id);
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.name, "研究助手");
    const ask = await w.send(s.id, w.msg("FX_SAY 在 docs 里"));
    assert.equal(ask.json.status.state, "TASK_STATE_COMPLETED", ask.text);
    assert.deepEqual(w.answer(ask.json), ["在 docs 里"]);
    const audit = w.h.ctx.store.all("SELECT action,target FROM audit WHERE action IN ('agent.public','agent.private')");
    assert.equal(audit.length, 1);
    assert.doesNotMatch(JSON.stringify(audit), /246810/);
  } finally {
    await w.close();
  }
});

test("A-9: the AI is told where the task came from; every tool action of that turn is audited with the task that caused it — the owner's own turns are not", async () => {
  const w = await world();
  try {
    const s = await w.publicSession("claude", "外来来源");
    const act = await w.send(s.id, w.actMsg("整理一下\nFX_TOOL Read README.md\nFX_TOOL Grep TODO\nFX_TOOL Bash ls\nFX_SAY 整理好了"), { headers: ACT });
    assert.equal(act.json.status.state, "TASK_STATE_COMPLETED", act.text);
    const tid = act.json.id;
    const task = w.h.ctx.store.one("SELECT trace_id,depth FROM a2a_tasks WHERE id=?", tid);
    const turn = w.h.ctx.store.one("SELECT job_id FROM a2a_turns WHERE task_id=?", tid);
    // The source, in what the AI was given (D-18).
    const prompt = w.h.ctx.store.one("SELECT text,trace,depth FROM jobs WHERE id=?", turn.job_id);
    assert.match(prompt.text, /【外来任务 · 办】来自 B（你的主人互认的联系人）/);
    assert.match(prompt.text, /经 A2A 调用你这个公开 agent「外来来源」/);
    assert.match(prompt.text, /对方在你主人的白名单上，直接放行/);
    assert.ok(prompt.text.includes(`任务 ${tid}`));
    assert.ok(prompt.text.includes(`链路 ${task.trace_id} 第 ${task.depth} 层`));
    assert.match(prompt.text, /不是你的主人亲自下的指令/);
    // The turn is on the task's trace and depth (P4-08: jobs.trace / jobs.depth).
    assert.equal(prompt.trace, task.trace_id);
    assert.equal(prompt.depth, task.depth);
    // Each tool action: one row, naming the task, on the turn and the task's trace.
    const rows = await until(
      () => toolAudit(w, tid),
      (r) => r.length >= 3,
      300,
    );
    assert.deepEqual(rows.map((r) => r.route), ["tool.Read", "tool.Grep", "tool.Bash"]);
    for (const r of rows) {
      assert.equal(r.job_id, turn.job_id);
      assert.equal(r.session_id, s.id);
      assert.equal(r.trace_id, task.trace_id);
      assert.equal(r.depth, task.depth);
      assert.equal(r.actor, "ai");
      assert.equal(JSON.parse(r.target).task, tid);
      assert.equal(JSON.parse(r.target).agent, s.id);
    }
    // Reported again (an update of the same item): still one row each.
    assert.equal(toolAudit(w, tid).length, 3);
    // The owner's own turn with tools: no a2a.tool rows.
    const before = w.h.ctx.store.one("SELECT COUNT(*) n FROM audit WHERE action='a2a.tool'").n;
    await w.h.turn(s.id, "FX_TOOL Bash pwd\nFX_SAY 主人的");
    assert.equal(w.h.ctx.store.one("SELECT COUNT(*) n FROM audit WHERE action='a2a.tool'").n, before);
  } finally {
    await w.close();
  }
});

test("A-4: 办 in auto mode — tools run without the owner approving each; the one action auto mode still asks about goes to her as a card, the caller sees WORKING; she answers, it completes", async () => {
  const w = await world();
  try {
    const s = await w.publicSession("claude", "自动办");
    const r = await w.send(s.id, w.actMsg("清理构建目录\nFX_TOOL Read Makefile\nFX_TOOL Bash make -n clean\nFX_SAY 清理完了\nFX_CONFIRM rm -rf build"), {
      headers: ACT,
      immediate: true,
    });
    assert.equal(r.status, 200, r.text);
    const tid = r.json.id;
    // The card reaches the owner.
    const snap = await w.pendingApproval(s.id);
    const cards = snap.approvals.filter((a: any) => a.status === "pending");
    assert.equal(cards.length, 1, "exactly one card: the tools before it needed none");
    assert.match(JSON.stringify(cards[0]), /rm -rf build/);
    const inbox = await w.h.ctx.app.inject({ url: api.approvals.list.path, headers: w.asCli });
    assert.ok(JSON.stringify(inbox.json()).includes(cards[0].id), "in her 「审批」 list");
    // The caller sees WORKING — not AUTH_REQUIRED, not INPUT_REQUIRED — while she decides.
    const t = (await w.getTask(s.id, tid)).json;
    assert.equal(t.status.state, "TASK_STATE_WORKING");
    // The tools before the card ran (and are audited with the task).
    assert.deepEqual(toolAudit(w, tid).map((x) => x.route).slice(0, 2), ["tool.Read", "tool.Bash"]);
    // Auto mode: the turn's mode, never bypass.
    const turn = w.h.ctx.store.one("SELECT job_id,permission_mode FROM a2a_turns WHERE task_id=?", tid);
    assert.equal(turn.permission_mode, "auto");
    const spawned = w.h.lines(w.h.spawns).map((x: any) => x.argv as string[]);
    const modes = spawned.filter((a: string[]) => a.includes("--permission-mode")).map((a: string[]) => a[a.indexOf("--permission-mode") + 1]);
    const live = w.h.lines(w.h.record).filter((x: any) => x.via === "set_permission_mode").map((x: any) => x.text);
    assert.ok(modes.includes("auto") || live.includes("auto"), JSON.stringify({ modes, live }));
    assert.ok(!modes.includes("bypassPermissions"));
    // Still WORKING a moment later (nothing times it out into another state).
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await w.getTask(s.id, tid)).json.status.state, "TASK_STATE_WORKING");
    // She answers: the task completes with the answer.
    await w.h.c.approve(s.id, cards[0].id, cards[0].options[0].id);
    const done = await w.waitTask(s.id, tid, (x) => x.status.state === "TASK_STATE_COMPLETED");
    assert.deepEqual(w.answer(done), ["清理完了"]);
    // The confirmed action is audited with the task too.
    const routes = toolAudit(w, tid).map((x) => x.route);
    assert.equal(routes.filter((x) => x === "tool.Bash").length, 2, JSON.stringify(routes));
  } finally {
    await w.close();
  }
});

// ── taking it back ────────────────────────────────────────────────────────

test("taken back to private: a queued 办 is withdrawn and a task waiting on the caller ends (REJECTED, said why); its range and 办 settings are forgotten; nobody can call it; the owner's turn runs on", async () => {
  const w = await world();
  try {
    const s = await w.publicSession("claude", "收回");
    // Settings kept for the agent: a range, a 办 mode.
    const aud = await w.h.ctx.app.inject({
      method: "PUT",
      url: fillPath(api.invoke.audienceSet.path, { aid: s.id }),
      headers: w.withPin(),
      payload: { openTo: "all" },
    });
    assert.equal(aud.statusCode, 200, aud.body);
    assert.equal((await w.setAct(s.id, { permissionMode: "acceptEdits" })).statusCode, 200);
    // A 问 waiting on the caller (input-required) …
    const asked = await w.send(s.id, w.msg(`FX_SAY ${NEEDS_INPUT}\\n哪个分支？`));
    assert.equal(asked.json.status.state, "TASK_STATE_INPUT_REQUIRED", asked.text);
    // … the owner's turn running (waiting on her card), a 办 queued behind it.
    await w.h.c.send(s.id, "主人的长任务");
    await w.pendingApproval(s.id);
    const queued = (await w.send(s.id, w.actMsg("FX_SAY 不会跑"), { headers: ACT, immediate: true })).json;
    await w.waitTask(s.id, queued.id, (t) => t.status.state === "TASK_STATE_SUBMITTED");
    assert.equal(jobsOf(w, s.id).length, 2);
    // Take it back.
    const r = await w.setPublic(s.id, false);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().public, false);
    assert.ok(r.json().stopped >= 2, r.body);
    for (const tid of [asked.json.id, queued.id]) {
      const t = await until(
        () => w.h.ctx.store.one("SELECT state,status_message FROM a2a_tasks WHERE id=?", tid),
        (x: any) => x.state === "TASK_STATE_REJECTED",
        300,
      );
      assert.match(t.status_message, /收回了私有/);
    }
    // The queued 办 never ran; the owner's turn is untouched.
    await until(
      () => jobsOf(w, s.id),
      (j) => j[1]?.status === "interrupted",
      300,
    );
    assert.equal(jobsOf(w, s.id)[0].status, "running");
    assert.equal(jobsOf(w, s.id)[0].cancel, 0);
    // Forgotten: range, 办 settings; private everywhere.
    assert.equal(w.h.ctx.store.one("SELECT COUNT(*) n FROM invoke_audiences WHERE agent_id=?", s.id).n, 0);
    assert.equal(w.h.ctx.store.one("SELECT COUNT(*) n FROM agent_act WHERE agent_id=?", s.id).n, 0);
    assert.equal(w.h.ctx.access.invoke.agents.resolve(s.id).kind, "private");
    assert.equal((await w.card(s.id)).status, 404);
    assert.equal((await w.send(s.id, w.msg("还在吗"))).status, 404);
    assert.doesNotMatch((await w.directory()).text, new RegExp(s.id));
    await w.h.settle(s.id);
    assert.equal(jobsOf(w, s.id)[0].status, "completed");
    // Public again: starts over with the defaults.
    assert.equal((await w.setPublic(s.id, true)).statusCode, 200);
    const v = await w.h.ctx.app.inject({ url: fillPath(api.invoke.actShow.path, { aid: s.id }), headers: w.withPin() });
    assert.equal(v.json().permissionMode, "auto");
    assert.equal(v.json().set, false);
  } finally {
    await w.close();
  }
});

test("a public session deleted: its row, its 办 settings and its open tasks go with it", async () => {
  const w = await world();
  try {
    const s = await w.publicSession("claude", "删除");
    assert.equal((await w.setAct(s.id, { permissionMode: "acceptEdits" })).statusCode, 200);
    const asked = await w.send(s.id, w.msg(`FX_SAY ${NEEDS_INPUT}\\n哪个？`));
    assert.equal(asked.json.status.state, "TASK_STATE_INPUT_REQUIRED", asked.text);
    const del = await w.h.ctx.app.inject({ method: "DELETE", url: `/api/sessions/${s.id}`, headers: w.asCli });
    assert.equal(del.statusCode, 200, del.body);
    assert.equal(w.h.ctx.store.one("SELECT COUNT(*) n FROM public_agents").n, 0);
    assert.equal(w.h.ctx.store.one("SELECT COUNT(*) n FROM agent_act").n, 0);
    await until(
      () => w.h.ctx.store.one("SELECT state FROM a2a_tasks WHERE id=?", asked.json.id).state,
      (st: string) => st === "TASK_STATE_REJECTED",
      300,
    );
    assert.equal(w.h.ctx.access.invoke.agents.resolve(s.id), null);
  } finally {
    await w.close();
  }
});
