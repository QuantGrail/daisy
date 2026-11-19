/**
 * P4-05 (总纲 5.7 问与办, 5.8, D-28, a2a-usage.md §8.1 / §13, ADR-124): the
 * executor of the public agents' A2A tasks (ADR-123 §5), and the two
 * settings the owner has per agent (是否允许办, 办的权限模式).
 *
 *   问 (the default — no act extension, or `mode` not `act`):
 *     - a read-only side branch of the main line, at once: the
 *       「只问」 sidecar machinery (Claude Code's side question on
 *       the live main process, else a fork with only Read / Grep / Glob;
 *       Codex a read-only fork) — one sidecar per visiting conversation;
 *       its answer is the task's result, the main line's next turn gets
 *       one sentence (sidecars.keep / carry);
 *     - a harness with no side question / fork (P4-11 `askOnly` none, an
 *       older Runner, the owner turned sidecars off): the main line,
 *       queued behind the owner's turn, in the harness's read-only mode
 *       (Kimi Code / OpenCode `plan`, Claude Code `plan`) — the result
 *       says so (`ranOn: "main-queue"`, a note);
 *     - no read-only mode at all (Antigravity, DeepSeek Harness over ACP):
 *       rejected `ASK_NOT_SUPPORTED`.
 *   办 (`job.mode === "act"`): the main line, queued behind the owner's
 *     current turn (`queued()` while it waits, `working()` once it runs),
 *     with the permission mode the owner chose for 办 (default `auto` where
 *     the harness has it); rejected `ACT_DISABLED` when she turned 办 off.
 *
 * The answer is the turn's last assistant text. A line `NEEDS_INPUT`
 * followed by a question maps to TASK_STATE_INPUT_REQUIRED; the caller's
 * reply runs another turn on the same line. Cancel withdraws a turn still
 * waiting and stops a running one; side effects are not rolled back.
 */
import { ownerT, inSessionT } from "../platform/language.ts";
import { basename } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../../../contracts/src/index.ts";
import type { AgentAskAct } from "../../../contracts/src/api/invoke.ts";
import { A2A_EXT } from "../../../contracts/src/a2a.ts";
import { featuresFor, harnessName } from "../../../contracts/src/agent-features.ts";
import { acpHarness, permissionModes, readOnlySupport } from "../../../contracts/src/acp-harnesses.ts";
import { bypassMode } from "../../../contracts/src/approvals.ts";
import { id as newId } from "../store/index.ts";
import { nodeCapabilities } from "../sessions/features.ts";
import { dropQueuedJob } from "../sessions/native-append.ts";
import { log } from "../observe/log.ts";
import type { AppContext } from "../app/context.ts";
import type { FastifyInstance } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import { serve } from "../app/serve.ts";
import { HttpError } from "../app/errors.ts";
import type { Principal } from "../access/guard.ts";
import { commitLetIn } from "../access/let-in-commit.ts";
import { InvokeError, type AgentInfo, type InvokeAccess } from "../invoke/invoke-access.ts";
import type { A2AExecutor, A2AFile, A2AJob, A2AOutcome } from "./executors.ts";
import { askActPrompt, oneLineSummary, readAnswer, type TurnKind } from "./ask-act-prompt.ts";
import { sessionLang } from "../../../contracts/src/prompt-i18n.ts";

export type ReadOnlyStrength = "strong" | "weak" | "none";
/** How a 「问」 runs on a session now (a2a-usage.md §8.1 `readOnly`, `ranOn`). */
export interface AskRoute {
  readOnly: ReadOnlyStrength;
  ranOn: "branch" | "main-queue" | null;
  /** The permission mode of a read-only main-line turn. */
  mode: string | null;
  why: string | null;
}
/** What the agent card declares (a2a-usage.md §8.1 名片里, §13). */
export interface AskActCard {
  act: boolean;
  readOnly: ReadOnlyStrength;
}

/** Jobs that waited behind others, at most per session (as a message, messages.ts). */
const MAX_PENDING = 20;
/** A safety net for a missed change signal (the wait is driven by the signals). */
const RECHECK_MS = 2000;

const ended = (st: string) => ["completed", "error", "interrupted"].includes(st);

export class AskAct {
  /** Jobs withdrawn because the owner turned 办 off (their tasks: ACT_DISABLED). */
  private withdrawnForAct = new Set<string>();
  readonly executor: A2AExecutor;

  constructor(
    private ctx: AppContext,
    private invoke: InvokeAccess,
  ) {
    this.executor = {
      run: (job) => this.run(job),
      describe: (agent) => this.describe(agent),
    };
    // P4-06 (ADR-125): an agent taken back or deleted starts over with the defaults.
    invoke.onAgentGone((agentId) => void ctx.store.run("DELETE FROM agent_act WHERE agent_id=?", agentId));
  }

  /** Public agents with a session behind them (P4-06 resolves them; tests use a fixture). */
  handles(agent: AgentInfo): boolean {
    return agent.kind === "public" && !!agent.sessionId;
  }

  // ── settings ────────────────────────────────────────────────────────────
  /** The modes 办 may run with on `agent` (never one that skips every confirmation). */
  modes(agent: string): string[] {
    return permissionModes(agent).values.filter((v) => !bypassMode({ agent, permissionMode: v }));
  }
  /** No row: 办 accepted, `auto` where the harness has it (5.8 “默认自动”), else the session's. */
  private defaultMode(agent: string): string | null {
    return this.modes(agent).includes("auto") ? "auto" : null;
  }
  private row(agentId: string) {
    return this.ctx.store.one("SELECT * FROM agent_act WHERE agent_id=?", agentId) as
      | { act: number; permission_mode: string | null; updated_at: number }
      | undefined;
  }
  /** 是否允许办 and its mode, for agent `agentId` whose session runs `harness`. */
  settings(agentId: string, harness: string): { act: boolean; permissionMode: string | null; set: boolean; updatedAt: number | null } {
    const r = this.row(agentId);
    if (!r) return { act: true, permissionMode: this.defaultMode(harness), set: false, updatedAt: null };
    const mode = r.permission_mode && this.modes(harness).includes(r.permission_mode) ? r.permission_mode : null;
    return { act: !!r.act, permissionMode: mode, set: true, updatedAt: r.updated_at };
  }
  private agentOr404(agentId: string): { agent: AgentInfo; session: Session | null } {
    const agent = this.invoke.agents.resolve(agentId);
    if (!agent) throw new InvokeError(404, say("noAgent"), "agent_not_found");
    const s = agent.sessionId ? this.ctx.store.session(agent.sessionId) : null;
    return { agent, session: s && !s.deleting ? s : null };
  }
  view(agentId: string): AgentAskAct {
    const { agent, session } = this.agentOr404(agentId);
    const harness = session?.agent ?? "";
    const st = this.settings(agent.id, harness);
    const route: AskRoute = session
      ? this.askRoute(session)
      : { readOnly: "none", ranOn: null, mode: null, why: say("noSession") };
    return {
      agentId: agent.id,
      kind: agent.kind,
      act: st.act,
      permissionMode: st.permissionMode,
      modes: harness ? this.modes(harness) : [],
      ask: { readOnly: route.readOnly, ranOn: route.ranOn, why: route.why },
      set: st.set,
      updatedAt: st.updatedAt,
    };
  }
  /**
   * The owner (with the PIN; the route checks and seals it) sets 是否允许办
   * / 办的权限模式. Synchronous (it runs inside `commitLetIn`). Turning 办
   * off withdraws the 办 turns still waiting (their tasks: ACT_DISABLED).
   */
  set(agentId: string, b: { act?: boolean; permissionMode?: string }, by: string): AgentAskAct & { withdrawn: number } {
    const { agent, session } = this.agentOr404(agentId);
    const harness = session?.agent ?? "";
    const cur = this.settings(agent.id, harness);
    let mode = cur.permissionMode;
    if (b.permissionMode !== undefined) {
      if (b.permissionMode === "session") mode = null;
      else if (!this.modes(harness).includes(b.permissionMode))
        throw new InvokeError(
          400,
          bypassMode({ agent: harness, permissionMode: b.permissionMode })
            ? say("bypassMode", { mode: b.permissionMode })
            : say("noSuchMode", { harness: harnessName(harness, ownerT()), mode: b.permissionMode, modes: [...this.modes(harness), "session"].join(say("listSeparator")) }),
          "mode_not_allowed",
        );
      else mode = b.permissionMode;
    }
    const act = b.act ?? cur.act;
    // 5.7 (P4-06): an agent with no read-only mode is public only while it
    // accepts 办 — turning 办 off would leave it answering nothing.
    if (!act && agent.kind === "public" && session && this.askRoute(session).readOnly === "none")
      throw new InvokeError(
        409,
        say("actRequired", { harness: harnessName(harness, ownerT()) }),
        "act_required",
      );
    const at = Date.now();
    const store = this.ctx.store;
    const withdrawn = store.atomic(() => {
      store.run(
        "INSERT INTO agent_act(agent_id,act,permission_mode,updated_at) VALUES(?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET act=excluded.act,permission_mode=excluded.permission_mode,updated_at=excluded.updated_at",
        agent.id,
        act ? 1 : 0,
        mode,
        at,
      );
      store.audit(by, "a2a.act.set", JSON.stringify({ agent: agent.id, act, permissionMode: mode ?? "session" }), {
        object: `agent:${agent.id}`,
      });
      return act ? 0 : this.withdrawActs(agent.id);
    });
    return { ...this.view(agent.id), withdrawn };
  }
  /** 办 turns of `agentId` that have not started: out of the queue (in a transaction). */
  private withdrawActs(agentId: string): number {
    const store = this.ctx.store;
    let n = 0;
    for (const j of store.all(
      "SELECT j.* FROM a2a_turns t JOIN jobs j ON j.id=t.job_id WHERE t.agent_id=? AND t.kind='act' AND (j.status='pending' OR (j.status='queued' AND j.lease IS NULL))",
      agentId,
    )) {
      this.withdrawnForAct.add(j.id);
      this.dropJob(j, inSessionT(store.session(j.session_id))("server-a2a.askAct.actTurnedOff"));
      n++;
    }
    return n;
  }

  // ── how 问 runs here ────────────────────────────────────────────────────
  /** 5.7 / D-28 / §13: branch, main line read-only, or not at all — from the declaration. */
  askRoute(main: Session): AskRoute {
    const caps = nodeCapabilities(this.ctx.store, main.nodeId);
    const f = featuresFor(caps, main.agent);
    const decl = caps?.agentFeatures?.[main.agent];
    const name = harnessName(main.agent, ownerT());
    if (f.readOnly === "none")
      return { readOnly: "none", ranOn: null, mode: null, why: say("noReadOnlyMode", { harness: name }) };
    const declared = decl?.readOnly?.opts?.strength;
    const strength: ReadOnlyStrength =
      declared === "weak" || declared === "strong" ? declared : readOnlySupport(main.agent) === "weak" ? "weak" : "strong";
    const fallback = this.ctx.sidecars.fallback(main);
    if (f.askOnly !== "none" && !fallback) return { readOnly: strength, ranOn: "branch", mode: null, why: null };
    const why =
      fallback === "disabled"
        ? say("branchOff")
        : fallback === "runner"
          ? say("runnerNoBranch")
          : say("noBranch", { harness: name });
    // The main line's own read-only mode: the declared one (an ACP `plan`),
    // Claude Code's plan mode; Codex's read-only is a sandbox set at launch
    // — not a per-turn mode — so it has none on the main line.
    const mode =
      (typeof decl?.readOnly?.opts?.mode === "string" && decl.readOnly.opts.mode) ||
      acpHarness(main.agent)?.modes.readOnly ||
      (main.agent === "claude" ? "plan" : null);
    if (!mode)
      return { readOnly: "none", ranOn: null, mode: null, why: say("noMainReadOnly", { why }) };
    // A plan mode on the main line is only as strong as the harness honours it.
    return { readOnly: main.agent === "claude" ? "weak" : strength, ranOn: "main-queue", mode, why };
  }
  /** The card's act extension `params` (a2a-usage.md §8.1). */
  describe(agent: AgentInfo): AskActCard | null {
    if (!this.handles(agent)) return null;
    const s = this.ctx.store.session(agent.sessionId!);
    if (!s || s.deleting) return null;
    return { act: this.settings(agent.id, s.agent).act, readOnly: this.askRoute(s).readOnly };
  }

  // ── running a task ──────────────────────────────────────────────────────
  private async run(job: A2AJob): Promise<A2AOutcome> {
    const store = this.ctx.store;
    const s = job.agent.sessionId ? store.session(job.agent.sessionId) : null;
    if (!s || s.deleting || s.archived)
      return { state: "rejected", reason: "AGENT_UNAVAILABLE", message: say("sessionGone") };
    const blocked = this.ctx.aiTurnsBlocked();
    if (blocked) return { state: "rejected", reason: "AGENT_UNAVAILABLE", message: say("noPin") };
    if (store.one("SELECT revoked_at FROM nodes WHERE id=?", s.nodeId)?.revoked_at)
      return { state: "rejected", reason: "AGENT_UNAVAILABLE", message: say("nodeRevoked") };
    // A continuation (after INPUT_REQUIRED) runs where the task's first turn ran.
    const prior = store.one("SELECT kind FROM a2a_turns WHERE task_id=? ORDER BY created DESC, rowid DESC LIMIT 1", job.taskId)?.kind as
      | TurnKind
      | undefined;
    const act = prior ? prior === "act" : job.mode === "act";
    if (act) {
      const st = this.settings(job.agent.id, s.agent);
      if (!st.act)
        return { state: "rejected", reason: "ACT_DISABLED", message: say("actOff") };
      return this.mainTurn(job, s, "act", st.permissionMode, null);
    }
    const route = this.askRoute(s);
    if (route.readOnly === "none")
      return { state: "rejected", reason: "ASK_NOT_SUPPORTED", message: say("askNotSupported", { why: route.why ?? say("cannotReadOnly") }) };
    if (route.ranOn === "branch" && prior !== "main-ask") return this.branchTurn(job, s, route);
    const mode = route.mode ?? this.mainLineReadOnly(s);
    if (!mode) return { state: "rejected", reason: "ASK_NOT_SUPPORTED", message: say("noMainLineReadOnly") };
    return this.mainTurn(job, s, "main-ask", mode, route.ranOn === "main-queue" ? route : { ...route, ranOn: "main-queue", readOnly: "weak" });
  }
  /** A main-line read-only mode even when a branch would be used (a continuation of a main-line 问). */
  private mainLineReadOnly(s: Session): string | null {
    return acpHarness(s.agent)?.modes.readOnly || (s.agent === "claude" ? "plan" : null);
  }

  /** Incoming files: attachments of the owner (names cut to a plain file name). */
  private attach(ownerId: string, files: A2AFile[]): string[] {
    if (!files.length) return [];
    const dir = join(this.ctx.opts.dataDir, "attachments");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return files.map((f) => {
      const aid = newId();
      const p = join(dir, aid);
      writeFileSync(p, f.bytes, { mode: 0o600 });
      this.ctx.store.run(
        "INSERT INTO attachments VALUES(?,?,?,?,?,?)",
        aid,
        ownerId,
        safeName(f.filename),
        /^[\w.+-]+\/[\w.+-]+$/.test(f.mediaType) ? f.mediaType : "application/octet-stream",
        f.bytes.length,
        p,
      );
      return aid;
    });
  }

  /** Queue one turn on `on` (the main session, or a branch); returns its job id and whether it waits. */
  private enqueue(job: A2AJob, on: Session, main: Session, kind: TurnKind, mode: string | null, prompt: string): { jid: string; waiting: boolean } {
    const store = this.ctx.store;
    const attachments = this.attach(on.ownerId, job.files);
    const jid = newId();
    const now = Date.now();
    const events: any[] = [];
    const waiting = store.atomic(() => {
      const active = store.one("SELECT id FROM jobs WHERE session_id=? AND status IN ('queued','running')", on.id);
      if (store.one("SELECT COUNT(*) AS n FROM jobs WHERE session_id=? AND status='pending'", on.id).n >= MAX_PENDING)
        throw new QueueFull();
      const n = store.one("SELECT COUNT(*) AS n FROM a2a_turns WHERE task_id=?", job.taskId).n as number;
      store.run(
        // P4-08 (trace.md §3, T-7): the turn carries the incoming call's
        // trace and depth — the AI's own calls from it go out at depth + 1.
        "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,origin,trace,depth) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        jid,
        on.id,
        on.nodeId,
        `a2a:${job.taskId}:${n + 1}`,
        prompt,
        JSON.stringify(attachments),
        active ? "pending" : "queued",
        now,
        "a2a",
        job.trace.traceId,
        job.trace.depth,
      );
      store.run(
        "INSERT INTO a2a_turns(job_id,task_id,agent_id,session_id,main_id,kind,permission_mode,created) VALUES(?,?,?,?,?,?,?,?)",
        jid,
        job.taskId,
        job.agent.id,
        on.id,
        main.id,
        kind,
        mode,
        now,
      );
      events.push(
        store.append(on.id, "item", {
          id: `user:${jid}`,
          kind: "user",
          text: prompt,
          status: "queued",
          origin: {
            type: "peer",
            senderName: job.caller.name,
            senderKind: job.caller.actor ? "agent" : "human",
            ownerName: job.caller.name,
            place: inSessionT(on)(kind === "act" ? "server-a2a.askAct.place.act" : "server-a2a.askAct.place.ask"),
            messageId: job.taskId,
            question: job.text.slice(0, 20000),
          },
          createdAt: now,
        }),
      );
      if (!active) events.push(store.append(on.id, "status", { status: "queued" }));
      return !!active;
    });
    events.forEach((e) => this.ctx.broadcast(e));
    log.info(`[a2a] task=${job.taskId} ${kind} job=${jid} session=${on.id}${waiting ? " (waits)" : ""}`);
    return { jid, waiting };
  }

  /** 办, or 问 on the main line read-only: behind the owner's current turn. */
  private async mainTurn(job: A2AJob, s: Session, kind: "act" | "main-ask", mode: string | null, route: AskRoute | null): Promise<A2AOutcome> {
    let q: { jid: string; waiting: boolean };
    try {
      q = this.enqueue(job, s, s, kind, mode, askActPrompt(job, kind, { readOnly: route?.readOnly === "weak" ? "weak" : "strong", lang: sessionLang(s) }));
    } catch (e) {
      if (e instanceof QueueFull)
        return { state: "rejected", reason: "QUOTA_EXCEEDED", message: say("mainQueueFull") };
      throw e;
    }
    if (q.waiting) job.queued();
    const end = await this.wait(q.jid, s.id, job);
    if (end !== "completed") return this.notDone(q.jid, end);
    const read = readAnswer(this.lastAnswer(s.id, q.jid));
    if (read.question) return { state: "input-required", question: read.question };
    if (kind === "act")
      return { state: "completed", answer: read.answer || say("noTextAnswer"), metadata: { [A2A_EXT.act]: { mode: "act" } } };
    return {
      state: "completed",
      answer: read.answer || say("noTextAnswer"),
      notes: [
        say("fellBack", {
          why: route?.why ?? say("noBranch", { harness: harnessName(s.agent, ownerT()) }),
          strength: say(route?.readOnly === "weak" ? "weakReadOnly" : "readOnly"),
        }),
      ],
      metadata: { [A2A_EXT.act]: { mode: "ask", readOnly: route?.readOnly ?? "weak", ranOn: "main-queue" } },
    };
  }

  /** 问 on a read-only side branch of the main line, now. */
  private async branchTurn(job: A2AJob, s: Session, route: AskRoute): Promise<A2AOutcome> {
    const sc = this.ctx.sidecars;
    const root = `a2a:${job.contextId}`;
    if (!job.continuing && sc.today(s.id) >= sc.limits.daily)
      return {
        state: "rejected",
        reason: "QUOTA_EXCEEDED",
        message: say("dailyLimit", { max: sc.limits.daily }),
      };
    // Over the concurrency cap: wait (still SUBMITTED) unless this
    // conversation's branch is already busy — then it waits in that queue.
    const busyBranch = () => {
      const o = sc.open(s.id, root);
      return !!o && !!this.ctx.store.one("SELECT 1 FROM jobs WHERE session_id=? AND status IN ('queued','running')", o.id);
    };
    if (!busyBranch() && sc.active(s.id) >= sc.limits.concurrent) {
      job.queued();
      const ok = await this.until(() => busyBranch() || sc.active(s.id) < sc.limits.concurrent, job.signal);
      if (!ok) return { state: "failed", reason: "INTERRUPTED", message: say("canceled") };
    }
    const { session: branch } = sc.sidecarFor(s, root, root);
    let q: { jid: string; waiting: boolean };
    try {
      q = this.enqueue(job, branch, s, "branch", null, askActPrompt(job, "branch", { readOnly: route.readOnly === "weak" ? "weak" : "strong", lang: sessionLang(branch) }));
    } catch (e) {
      if (e instanceof QueueFull)
        return { state: "rejected", reason: "QUOTA_EXCEEDED", message: say("branchQueueFull") };
      throw e;
    }
    if (q.waiting) job.queued();
    const end = await this.wait(q.jid, branch.id, job);
    if (end !== "completed") return this.notDone(q.jid, end);
    const read = readAnswer(this.lastAnswer(branch.id, q.jid));
    const via = this.via(branch.id, q.jid);
    // The side line's memory (the model reads it): the session's language.
    const st = inSessionT(s);
    const asked = st("server-a2a.askAct.asked", { caller: job.caller.name, text: job.text });
    if (read.question) {
      sc.remember(branch.id, { question: asked, response: st("server-a2a.askAct.askedBack", { question: read.question }), via });
      return { state: "input-required", question: read.question };
    }
    const answer = read.answer || say("noBranchAnswer");
    sc.remember(branch.id, { question: asked, response: answer, via });
    sc.keep({ main: s.id, sidecar: branch.id, tid: root, mid: job.taskId, text: oneLineSummary(job, answer, read.summary, sessionLang(s)) });
    return {
      state: "completed",
      answer,
      metadata: { [A2A_EXT.act]: { mode: "ask", readOnly: route.readOnly, ranOn: "branch" } },
    };
  }

  /** how the Runner answered a branch turn (side question, throwaway fork, fork). */
  private via(sid: string, jid: string): "side_question" | "ephemeral" | "fork" {
    try {
      const r = this.ctx.store.one("SELECT data FROM items WHERE session_id=? AND id=?", sid, `${jid}:ask-route`);
      const v = r && JSON.parse(r.data)?.input?.via;
      if (v === "side_question" || v === "ephemeral") return v;
    } catch {}
    return "fork";
  }

  /** The turn's last answer text (no subagent, no trace line, not retracted). */
  private lastAnswer(sid: string, jid: string): string {
    const items = this.ctx.store
      .all("SELECT data FROM items WHERE session_id=? AND id LIKE ?", sid, `${jid}:%`)
      .map((r: any) => {
        try {
          return JSON.parse(r.data);
        } catch {
          return null;
        }
      })
      .filter((i: any) => i && i.kind === "assistant" && !i.parentId && !i.category && !i.retracted && String(i.text || "").trim())
      .sort((a: any, b: any) => (a.createdAt || 0) - (b.createdAt || 0));
    return String(items.at(-1)?.text || "").trim();
  }

  private notDone(jid: string, end: "error" | "interrupted" | "aborted"): A2AOutcome {
    if (this.withdrawnForAct.delete(jid))
      return { state: "rejected", reason: "ACT_DISABLED", message: say("withdrawnAct") };
    if (end === "aborted") return { state: "failed", reason: "INTERRUPTED", message: say("canceled") };
    if (end === "error") return { state: "failed", reason: "EXECUTION_ERROR", message: say("turnError") };
    return { state: "failed", reason: "INTERRUPTED", message: say("turnStopped") };
  }

  /**
   * Wait for job `jid` (of session `sid`) to end, driven by the session's
   * change signals (a re-check every few seconds in case one is missed).
   * `working()` once it runs; the task's abort withdraws or stops it.
   */
  private wait(jid: string, sid: string, job: A2AJob): Promise<"completed" | "error" | "interrupted" | "aborted"> {
    const store = this.ctx.store;
    return new Promise((resolve) => {
      let done = false;
      let ran = false;
      let scheduled = false;
      const finish = (v: "completed" | "error" | "interrupted" | "aborted") => {
        if (done) return;
        done = true;
        off();
        clearInterval(timer);
        job.signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const check = () => {
        scheduled = false;
        if (done) return;
        const r = store.one("SELECT status FROM jobs WHERE id=?", jid);
        if (!r) return finish("interrupted");
        if (!ran && (r.status === "running" || ended(r.status))) {
          ran = true;
          try {
            job.working();
          } catch {}
        }
        if (ended(r.status)) finish(r.status);
      };
      const soon = () => {
        if (scheduled || done) return;
        scheduled = true;
        setImmediate(check);
      };
      const off = this.ctx.onSessionChange((changed) => {
        if (changed === sid) soon();
      });
      const timer = setInterval(check, RECHECK_MS);
      (timer as any).unref?.();
      // ADR-123 §6: abort may fire inside another transaction (a revocation):
      // nothing heavy here — the withdrawal is scheduled.
      const onAbort = () => {
        setImmediate(() => {
          try {
            this.cancelJob(jid);
          } catch (e) {
            log.warn("a2a: could not withdraw a turn", { job: jid, error: String((e as Error)?.message ?? e).slice(0, 200) });
          }
          finish("aborted");
        });
      };
      if (job.signal.aborted) onAbort();
      else job.signal.addEventListener("abort", onAbort, { once: true });
      check();
    });
  }
  /** Resolve when `ok()` holds (re-checked on every change), false when aborted. */
  private until(ok: () => boolean, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        off();
        clearInterval(timer);
        resolve(v);
      };
      const check = () => {
        if (signal.aborted) finish(false);
        else if (ok()) finish(true);
      };
      const off = this.ctx.onSessionChange(() => setImmediate(check));
      const timer = setInterval(check, RECHECK_MS);
      (timer as any).unref?.();
      signal.addEventListener("abort", () => setImmediate(() => finish(false)), { once: true });
      check();
    });
  }
  /** The caller canceled: a waiting turn is withdrawn, a running one stopped. */
  private cancelJob(jid: string) {
    const store = this.ctx.store;
    const j = store.one("SELECT * FROM jobs WHERE id=?", jid);
    if (!j || ended(j.status)) return;
    this.dropJob(j, inSessionT(store.session(j.session_id))("server-a2a.askAct.callerCanceled"));
  }
  /** Withdraw a job not yet started, or stop the running one (inside or outside a transaction). */
  private dropJob(j: any, why: string) {
    const store = this.ctx.store;
    if (j.status === "pending") {
      store.atomic(() => dropQueuedJob(store, j.session_id, j, (sid, type, data) => this.ctx.publish(sid, type, data)));
      return;
    }
    store.run("UPDATE jobs SET cancel=1 WHERE id=?", j.id);
    if (j.status === "queued" && !j.lease) this.ctx.settle({ ...j, cancel: 1 }, "interrupted", why);
  }
}

class QueueFull extends Error {}

/**
 * P6-23b: what the owner reads (settings, why not) and what is written into
 * a task (said once, stored): the owner's language. Text written into a
 * session uses that session's (`sessionT`).
 */
const say = (key: string, params?: Record<string, unknown>) => ownerT().dynamic(`server-a2a.askAct.${key}`, params);

/** A file name a caller sent, as a plain name (no directories, no control characters). */
export function safeName(name: string): string {
  const base = basename(String(name ?? "").replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
  return base || "file";
}

/**
 * The two routes (packages/contracts/src/api/invoke.ts `actShow` /
 * `actSet`): `daisy:grant` on the owner's channels; setting is
 * `letsIn: "agent-exposure"` (5.11 「设置是否允许办」, PIN), saved inside
 * `commitLetIn` (ADR-121 §4a) — synchronously, after nothing awaited.
 * Reading takes the PIN on the command line only (D-40 ①, `PIN_ON_CLI`).
 */
export function registerAskActRoutes(app: FastifyInstance, askAct: AskAct): void {
  const I = api.invoke;
  const actor = (req: any) => (req.daisyPrincipal as Principal | undefined)?.label ?? "anonymous";
  const answer = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof InvokeError) throw e.toHttp();
      throw e;
    }
  };
  const run = <T>(req: any, fn: () => T): T => answer(() => commitLetIn(req, fn));
  serve(app, I.actShow, async (req: any) => answer(() => askAct.view(String(req.params.aid))));
  serve(app, I.actSet, async (req: any) => {
    const b = I.actSet.body.parse(req.body ?? {});
    return run(req, () => askAct.set(String(req.params.aid), b, actor(req)));
  });
}
