/**
 * P4-07 (总纲 5.2 常驻 agent, 5.8, 5.11, D-12, a2a-usage.md §8.1 / §9.2 /
 * §12, ADR-126): resident agents — configurations, each visiting
 * conversation in a session of its own.
 *
 *   resolver   `invoke.agents.add`: a resident agent that is not closed is
 *              `kind: "resident"` (the call authorization applies as to
 *              any agent: range, cards, whitelist, grants).
 *   directory  `a2a.directory.add`: the ones not closed.
 *   executor   `a2a.executors.add`: per task —
 *                paused → rejected `AGENT_PAUSED` (A-18); closed, no PIN
 *                set (D-36), the device revoked → `AGENT_UNAVAILABLE`;
 *                over its turns a day → `QUOTA_EXCEEDED`;
 *                more conversations busy than its limit → the task waits
 *                (`job.queued()`, SUBMITTED), first come first served,
 *                never dropped (A-19);
 *                then a turn on the conversation's dedicated session
 *                (created on its first task; A-2: no other conversation
 *                is in it), with the agent's permission mode (default
 *                `auto`, never bypass); an operation auto mode still asks
 *                about is declined by the Runner unless the owner chose
 *                to be asked (A-3). 问 / 办 make no difference (5.8): the
 *                act mark is ignored.
 *   reclaim    `a2a.onReclaim`: a conversation reclaimed after 7 idle days
 *              — its dedicated session is closed and deleted.
 *
 * Waiting for a turn follows `AskAct.wait` (ADR-124 §10): driven by the
 * session's change signals (`ctx.onSessionChange`), re-checked every 2 s.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../../../contracts/src/index.ts";
import { A2A_EXT } from "../../../contracts/src/a2a.ts";
import { bypassMode } from "../../../contracts/src/approvals.ts";
import { permissionModes } from "../../../contracts/src/acp-harnesses.ts";
import { harnessName } from "../../../contracts/src/agent-features.ts";
import {
  RESIDENT_AGENT_LIMITS as L,
  RESIDENT_LAYERS,
  type ResidentAgentView,
  type ResidentConversation,
  type ResidentCreate,
  type ResidentSet,
} from "../../../contracts/src/api/residents.ts";
import { id as newId } from "../store/index.ts";
import { dropQueuedJob } from "../sessions/native-append.ts";
import { log } from "../observe/log.ts";
import type { AppContext } from "../app/context.ts";
import { LocalizedError } from "../app/errors.ts";
import { ownerT } from "../platform/language.ts";
import type { AgentInfo, InvokeAccess } from "../invoke/invoke-access.ts";
import type { A2AExecutor, A2AFile, A2AJob, A2AOutcome } from "../a2a/executors.ts";
import { readAnswer } from "../a2a/ask-act-prompt.ts";
import { safeName } from "../a2a/ask-act.ts";
import { readResident, RESIDENT_TOOLS_HARNESSES, type ResidentConfig, type ResidentRow } from "./config.ts";
import { residentLayers, residentPrompt } from "./prompt.ts";
import { newSessionLang } from "../prompts/lang.ts";
import { sessionLang } from "../../../contracts/src/prompt-i18n.ts";

const DAY = 24 * 60 * 60 * 1000;
/** A safety net for a missed change signal. */
const RECHECK_MS = 2000;
/** Turns waiting in one conversation's own session, at most. */
const MAX_PENDING = 20;
const ended = (st: string) => ["completed", "error", "interrupted"].includes(st);

type Take = "ok" | "aborted" | "paused" | "closed";
interface Waiter {
  context: string;
  go: (v: Take) => void;
}

/**
 * The concurrency limit (A-19): per agent, how many conversations have a
 * turn in flight. Another task of a conversation already in shares its
 * place (its turn queues in the conversation's own session). Waiters go
 * first come first served; nobody is dropped — only a pause or a close
 * sends them away (refused, said why).
 */
class Places {
  private held = new Map<string, Map<string, number>>();
  private queue = new Map<string, Waiter[]>();
  constructor(private cap: (agentId: string) => number) {}

  active(agentId: string): number {
    return this.held.get(agentId)?.size ?? 0;
  }
  waiting(agentId: string): number {
    return this.queue.get(agentId)?.length ?? 0;
  }
  private enter(agentId: string, context: string) {
    let m = this.held.get(agentId);
    if (!m) this.held.set(agentId, (m = new Map()));
    m.set(context, (m.get(context) ?? 0) + 1);
  }
  private free(agentId: string, context: string): boolean {
    const m = this.held.get(agentId);
    return !!m && (m.has(context) || m.size < this.cap(agentId));
  }
  /** Take a place for `context` (`onWait` once if it has to wait). */
  take(agentId: string, context: string, signal: AbortSignal, onWait: () => void): Promise<Take> {
    const m = this.held.get(agentId);
    if (m?.has(context) || (!this.waiting(agentId) && (!m || m.size < this.cap(agentId)))) {
      this.enter(agentId, context);
      return Promise.resolve("ok");
    }
    return new Promise((resolve) => {
      let settled = false;
      const w: Waiter = {
        context,
        go: (v) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
      };
      const onAbort = () => {
        const q = this.queue.get(agentId) ?? [];
        const i = q.indexOf(w);
        if (i >= 0) q.splice(i, 1);
        w.go("aborted");
      };
      let q = this.queue.get(agentId);
      if (!q) this.queue.set(agentId, (q = []));
      q.push(w);
      try {
        onWait();
      } catch {}
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  release(agentId: string, context: string) {
    const m = this.held.get(agentId);
    if (!m) return;
    const n = (m.get(context) ?? 1) - 1;
    if (n > 0) m.set(context, n);
    else m.delete(context);
    this.pump(agentId);
  }
  /** Let waiters in while there is room (the limit may have been raised). */
  pump(agentId: string) {
    const q = this.queue.get(agentId);
    while (q?.length) {
      if (!this.held.has(agentId)) this.held.set(agentId, new Map());
      if (!this.free(agentId, q[0]!.context)) break;
      const w = q.shift()!;
      this.enter(agentId, w.context);
      w.go("ok");
    }
  }
  /** Paused or closed: every waiter is sent away. */
  dropAll(agentId: string, why: "paused" | "closed"): number {
    const q = this.queue.get(agentId) ?? [];
    this.queue.delete(agentId);
    for (const w of q) w.go(why);
    return q.length;
  }
}

export class ResidentAgents {
  readonly executor: A2AExecutor;
  private places: Places;

  constructor(
    private ctx: AppContext,
    private invoke: InvokeAccess,
  ) {
    this.places = new Places((aid) => readResident(this.ctx.store, aid)?.config.concurrency ?? L.concurrency.default);
    this.executor = { run: (job) => this.run(job) };
  }

  // ── the seams ───────────────────────────────────────────────────────────
  /** `invoke.agents.add`: a resident agent not closed. */
  resolve(agentId: string): AgentInfo | null {
    const r = readResident(this.ctx.store, agentId);
    return r && r.state !== "closed" ? { id: r.id, kind: "resident", name: r.config.name, sessionId: null } : null;
  }
  /** `a2a.directory.add`. */
  ids(): string[] {
    return this.ctx.store.all("SELECT id FROM resident_agents WHERE state<>'closed' ORDER BY created_at").map((r: any) => r.id);
  }
  handles(agent: AgentInfo): boolean {
    return agent.kind === "resident" && !!readResident(this.ctx.store, agent.id);
  }

  // ── configuration ───────────────────────────────────────────────────────
  /** The modes a resident on `harness` may be given (never one that skips every confirmation). */
  modes(harness: string): string[] {
    return permissionModes(harness).values.filter((v) => !bypassMode({ agent: harness, permissionMode: v }));
  }
  private mode(harness: string, asked: string | undefined, cur: string | null | undefined): string | null {
    if (asked === undefined) return cur === undefined ? (this.modes(harness).includes("auto") ? "auto" : null) : cur;
    if (asked === "session") return null;
    if (!this.modes(harness).includes(asked))
      throw bypassMode({ agent: harness, permissionMode: asked })
        ? new LocalizedError(400, "mode_not_allowed", "server-resident.error.modeBypass", { mode: asked })
        : new LocalizedError(400, "mode_not_allowed", "server-resident.error.modeUnknown", {
            harness: harnessName(harness, ownerT()),
            mode: asked,
            modes: [...this.modes(harness), "session"].join(ownerT()("server-resident.listSeparator")),
          });
    return asked;
  }
  /** 原则 4: tools and directories only where Daisy can hold the harness to them. */
  private toolsDirs(harness: string, b: { tools?: string[]; dirs?: string[] }, cur?: ResidentConfig) {
    const tools = b.tools === undefined ? (cur?.tools ?? null) : b.tools.includes("*") ? null : [...new Set(b.tools)];
    const dirs = b.dirs === undefined ? (cur?.dirs ?? []) : [...new Set(b.dirs)];
    if ((tools || dirs.length) && !RESIDENT_TOOLS_HARNESSES.includes(harness))
      throw new LocalizedError(400, "capability_unsupported", "server-resident.error.toolsUnsupported", { harness: harnessName(harness, ownerT()) });
    return { tools, dirs };
  }

  /** The owner creates one (the route has checked the PIN; runs inside `commitLetIn`). */
  create(ownerId: string, b: ResidentCreate, by: string): ResidentAgentView {
    const store = this.ctx.store;
    const w = store.one("SELECT * FROM workspaces WHERE id=?", b.workspaceId);
    const p = store.one("SELECT * FROM profiles WHERE id=? AND owner_id=?", b.profileId, ownerId);
    if (!w || !p) throw new LocalizedError(400, "resident_invalid", "server-resident.error.workspaceOrProfileMissing");
    const pf = JSON.parse(p.data);
    if (pf.agent !== b.harness || pf.nodeId !== w.node_id)
      throw new LocalizedError(400, "resident_invalid", "server-resident.error.profileMismatch", { harness: harnessName(b.harness, ownerT()) });
    const node = store.one("SELECT * FROM nodes WHERE id=?", w.node_id);
    if (!node || node.revoked_at) throw new LocalizedError(409, "resident_invalid", "server-resident.error.nodeGone");
    // an AI others can call never runs on an identity in bypass.
    this.ctx.bypass?.checkOpen(pf, true);
    const config: ResidentConfig = {
      name: b.name.trim(),
      description: (b.description ?? "").trim(),
      harness: b.harness,
      workspaceId: w.id,
      profileId: p.id,
      nodeId: w.node_id,
      prompt: Object.fromEntries(RESIDENT_LAYERS.map((k) => [k, (b[k] ?? "").trim()])) as ResidentConfig["prompt"],
      permissionMode: this.mode(b.harness, b.permissionMode, undefined),
      ...this.toolsDirs(b.harness, b),
      concurrency: b.concurrency ?? L.concurrency.default,
      dailyTurns: b.dailyTurns ?? 0,
      approvals: b.approvals ?? "reject",
    };
    const aid = newId();
    const now = Date.now();
    store.atomic(() => {
      store.run(
        "INSERT INTO resident_agents(id,owner_id,data,state,created_at,updated_at) VALUES(?,?,?,'running',?,?)",
        aid,
        ownerId,
        JSON.stringify(config),
        now,
        now,
      );
      store.audit(by, "resident.create", JSON.stringify({ agent: aid, harness: config.harness, permissionMode: config.permissionMode ?? "session", approvals: config.approvals }), {
        object: `agent:${aid}`,
      });
    });
    return this.view(aid);
  }

  /** Change one (PIN; inside `commitLetIn`). Harness, workspace and identity stay. */
  update(aid: string, b: ResidentSet, by: string): ResidentAgentView {
    const r = this.rowOr404(aid);
    if (r.state === "closed") throw new LocalizedError(409, "agent_closed", "server-resident.error.closedNoChange");
    const c = r.config;
    const next: ResidentConfig = {
      ...c,
      ...(b.name !== undefined ? { name: b.name.trim() } : {}),
      ...(b.description !== undefined ? { description: b.description.trim() } : {}),
      prompt: Object.fromEntries(RESIDENT_LAYERS.map((k) => [k, b[k] !== undefined ? b[k]!.trim() : (c.prompt?.[k] ?? "")])) as ResidentConfig["prompt"],
      permissionMode: this.mode(c.harness, b.permissionMode, c.permissionMode),
      ...this.toolsDirs(c.harness, b, c),
      ...(b.concurrency !== undefined ? { concurrency: b.concurrency } : {}),
      ...(b.dailyTurns !== undefined ? { dailyTurns: b.dailyTurns } : {}),
      ...(b.approvals !== undefined ? { approvals: b.approvals } : {}),
    };
    const store = this.ctx.store;
    store.atomic(() => {
      store.run("UPDATE resident_agents SET data=?,updated_at=? WHERE id=?", JSON.stringify(next), Date.now(), aid);
      store.audit(by, "resident.update", JSON.stringify({ agent: aid, fields: Object.keys(b).filter((k) => (b as any)[k] !== undefined) }), {
        object: `agent:${aid}`,
      });
    });
    // A raised limit lets waiters in now.
    this.places.pump(aid);
    return this.view(aid);
  }

  /** Pause (no PIN: it only takes away). Waiters are refused AGENT_PAUSED; running turns finish. */
  pause(aid: string, by: string): ResidentAgentView & { refused: number } {
    const r = this.rowOr404(aid);
    if (r.state === "closed") throw new LocalizedError(409, "agent_closed", "server-resident.error.closed");
    if (r.state !== "paused")
      this.ctx.store.atomic(() => {
        const now = Date.now();
        this.ctx.store.run("UPDATE resident_agents SET state='paused',paused_at=?,updated_at=? WHERE id=?", now, now, aid);
        this.ctx.store.audit(by, "resident.pause", JSON.stringify({ agent: aid }), { object: `agent:${aid}` });
      });
    const refused = this.places.dropAll(aid, "paused");
    return { ...this.view(aid), refused };
  }
  /** Resume (PIN: callers get in again; inside `commitLetIn`). */
  resume(aid: string, by: string): ResidentAgentView {
    const r = this.rowOr404(aid);
    if (r.state === "closed") throw new LocalizedError(409, "agent_closed", "server-resident.error.closedNoResume");
    if (r.state === "paused")
      this.ctx.store.atomic(() => {
        this.ctx.store.run("UPDATE resident_agents SET state='running',paused_at=NULL,updated_at=? WHERE id=?", Date.now(), aid);
        this.ctx.store.audit(by, "resident.resume", JSON.stringify({ agent: aid }), { object: `agent:${aid}` });
      });
    return this.view(aid);
  }
  /**
   * Close (no PIN): no more calls; its grants, range and cards go and the
   * calls in progress stop (`forgetAgent`); waiters are refused; its
   * dedicated sessions are archived and their processes stopped. Kept
   * for reading; never reopened.
   */
  close(aid: string, by: string): ResidentAgentView & { stopped: number } {
    const r = this.rowOr404(aid);
    let stopped = 0;
    if (r.state !== "closed") {
      this.ctx.store.atomic(() => {
        const now = Date.now();
        this.ctx.store.run("UPDATE resident_agents SET state='closed',closed_at=?,updated_at=? WHERE id=?", now, now, aid);
        this.ctx.store.audit(by, "resident.close", JSON.stringify({ agent: aid }), { object: `agent:${aid}` });
      });
      this.places.dropAll(aid, "closed");
      stopped = this.invoke.forgetAgent(aid);
    }
    for (const s of this.ctx.store.all("SELECT session_id FROM resident_sessions WHERE agent_id=? AND closed_at IS NULL", aid))
      this.closeSession(aid, s.session_id, false);
    return { ...this.view(aid), stopped };
  }
  /** Delete (no PIN): close, then the configuration and its sessions go. */
  remove(aid: string, by: string): { ok: true; stopped: number; sessions: number } {
    const { stopped } = this.close(aid, by);
    const store = this.ctx.store;
    const sessions = store.all("SELECT session_id FROM resident_sessions WHERE agent_id=?", aid).map((r: any) => r.session_id as string);
    for (const sid of sessions) this.closeSession(aid, sid, true);
    store.atomic(() => {
      store.run("DELETE FROM resident_sessions WHERE agent_id=?", aid);
      store.run("DELETE FROM resident_agents WHERE id=?", aid);
      store.audit(by, "resident.delete", JSON.stringify({ agent: aid, sessions: sessions.length }), { object: `agent:${aid}` });
    });
    return { ok: true, stopped, sessions: sessions.length };
  }

  /**
   * a2a-usage.md §12: conversations reclaimed after 7 idle days — their
   * dedicated sessions are closed and deleted (ADR-126 §5).
   */
  reclaimed(contexts: { id: string; agentId: string }[]): number {
    let n = 0;
    for (const c of contexts) {
      const row = this.ctx.store.one("SELECT session_id FROM resident_sessions WHERE agent_id=? AND context_id=?", c.agentId, c.id);
      if (!row) continue;
      this.closeSession(c.agentId, row.session_id, true);
      this.ctx.store.run("DELETE FROM resident_sessions WHERE agent_id=? AND context_id=?", c.agentId, c.id);
      n++;
    }
    if (n) this.ctx.store.audit("system", "resident.reclaim", JSON.stringify({ sessions: n }));
    return n;
  }

  /** Stop and archive a dedicated session (`purge`: delete it too). */
  private closeSession(aid: string, sid: string, purge: boolean) {
    const store = this.ctx.store;
    const s = store.session(sid);
    store.run("UPDATE resident_sessions SET closed_at=COALESCE(closed_at,?) WHERE agent_id=? AND session_id=?", Date.now(), aid, sid);
    if (!s) return;
    try {
      this.ctx.stopWork({ ...s, ...(purge ? { deleting: true } : {}) });
      this.ctx.live.stop(sid);
    } catch (e) {
      log.warn("resident: stopping a session failed", { session: sid, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
    store.atomic(() => {
      const cur = store.session(sid);
      if (!cur) return;
      cur.archived = true;
      if (purge) cur.deleting = true;
      cur.updatedAt = Date.now();
      store.save(cur);
    });
    if (purge) this.ctx.purgeIfDeleted(sid);
  }

  // ── reading ─────────────────────────────────────────────────────────────
  private rowOr404(aid: string): ResidentRow {
    const r = readResident(this.ctx.store, aid);
    if (!r) throw new LocalizedError(404, "agent_not_found", "server-resident.error.notFound");
    return r;
  }
  private turnsToday(aid: string): number {
    return this.ctx.store.one("SELECT COUNT(*) AS n FROM a2a_turns WHERE agent_id=? AND kind='resident' AND created>?", aid, Date.now() - DAY).n as number;
  }
  view(aid: string): ResidentAgentView {
    const r = this.rowOr404(aid);
    const c = r.config;
    return {
      id: r.id,
      name: c.name,
      description: c.description,
      harness: c.harness,
      workspaceId: c.workspaceId,
      profileId: c.profileId,
      nodeId: c.nodeId,
      prompt: Object.fromEntries(RESIDENT_LAYERS.map((k) => [k, c.prompt?.[k] ?? ""])) as ResidentAgentView["prompt"],
      layers: residentLayers(c, newSessionLang(this.ctx.opts.dataDir)),
      permissionMode: c.permissionMode,
      modes: this.modes(c.harness),
      dirs: c.dirs,
      tools: c.tools,
      concurrency: c.concurrency,
      dailyTurns: c.dailyTurns,
      approvals: c.approvals,
      state: r.state,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      pausedAt: r.pausedAt,
      closedAt: r.closedAt,
      usage: { active: this.places.active(aid), waiting: this.places.waiting(aid), turnsToday: this.turnsToday(aid) },
      a2aPath: `/a2a/${encodeURIComponent(r.id)}`,
    };
  }
  list(): ResidentAgentView[] {
    return this.ctx.store.all("SELECT id FROM resident_agents ORDER BY created_at").map((r: any) => this.view(r.id));
  }
  conversations(aid: string): ResidentConversation[] {
    this.rowOr404(aid);
    return this.ctx.store
      .all("SELECT * FROM resident_sessions WHERE agent_id=? ORDER BY created", aid)
      .map((r: any) => ({
        contextId: r.context_id,
        sessionId: r.session_id,
        caller: r.caller,
        createdAt: r.created,
        lastAt: r.last_at,
        closedAt: r.closed_at ?? null,
      }));
  }

  // ── running a task ──────────────────────────────────────────────────────
  /** Why this agent takes no task now (null: it does). */
  private refusal(r: ResidentRow | null): A2AOutcome | null {
    // Told to the caller, in the owner's language.
    const t = ownerT();
    if (!r || r.state === "closed")
      return { state: "rejected", reason: "AGENT_UNAVAILABLE", message: t("server-resident.refusal.closed") };
    if (r.state === "paused")
      return { state: "rejected", reason: "AGENT_PAUSED", message: t("server-resident.refusal.paused") };
    if (this.ctx.aiTurnsBlocked())
      return { state: "rejected", reason: "AGENT_UNAVAILABLE", message: t("server-resident.refusal.noPin") };
    const store = this.ctx.store;
    if (store.one("SELECT revoked_at FROM nodes WHERE id=?", r.config.nodeId)?.revoked_at)
      return { state: "rejected", reason: "AGENT_UNAVAILABLE", message: t("server-resident.refusal.nodeRevoked") };
    if (!store.one("SELECT 1 FROM workspaces WHERE id=?", r.config.workspaceId) || !store.one("SELECT 1 FROM profiles WHERE id=?", r.config.profileId))
      return { state: "rejected", reason: "AGENT_UNAVAILABLE", message: t("server-resident.refusal.configGone") };
    if (r.config.dailyTurns > 0 && this.turnsToday(r.id) >= r.config.dailyTurns)
      return {
        state: "rejected",
        reason: "QUOTA_EXCEEDED",
        message: t("server-resident.refusal.dailyTurns", { n: r.config.dailyTurns }),
      };
    return null;
  }

  private async run(job: A2AJob): Promise<A2AOutcome> {
    const aid = job.agent.id;
    const first = this.refusal(readResident(this.ctx.store, aid));
    if (first) return first;
    const took = await this.places.take(aid, job.contextId, job.signal, () => job.queued());
    if (took === "aborted") return { state: "failed", reason: "INTERRUPTED", message: ownerT()("server-resident.outcome.canceled") };
    if (took === "paused" || took === "closed")
      return (
        this.refusal(readResident(this.ctx.store, aid)) ?? {
          state: "rejected",
          reason: "AGENT_UNAVAILABLE",
          message: ownerT()("server-resident.refusal.notTaking"),
        }
      );
    try {
      const r = readResident(this.ctx.store, aid);
      const again = this.refusal(r);
      if (again) return again;
      return await this.turn(job, r!);
    } finally {
      this.places.release(aid, job.contextId);
    }
  }

  /** The conversation's dedicated session (created on its first task). */
  private sessionFor(r: ResidentRow, job: A2AJob): Session | null {
    const store = this.ctx.store;
    const row = store.one("SELECT * FROM resident_sessions WHERE agent_id=? AND context_id=?", r.id, job.contextId);
    if (row) {
      const s = store.session(row.session_id);
      if (!s || s.deleting || s.archived || row.closed_at) return null;
      store.run("UPDATE resident_sessions SET last_at=? WHERE agent_id=? AND context_id=?", Date.now(), r.id, job.contextId);
      return s;
    }
    const now = Date.now();
    const c = r.config;
    const s: Session = {
      id: newId(),
      ownerId: r.ownerId,
      title: ownerT()("server-resident.session.title", { agent: c.name, caller: job.caller.name }).slice(0, 200),
      agent: c.harness as Session["agent"],
      nodeId: c.nodeId,
      workspaceId: c.workspaceId,
      workspaceMode: "shared",
      profileId: c.profileId,
      nativeId: null,
      contextDelivered: true,
      task: null,
      status: "idle",
      archived: false,
      residentOf: { agentId: r.id, contextId: job.contextId },
      // P6-24: its prompts' language, for its whole life (ADR-159 §6).
      lang: newSessionLang(this.ctx.opts.dataDir),
      createdAt: now,
      updatedAt: now,
    };
    store.atomic(() => {
      store.save(s);
      store.run(
        "INSERT INTO resident_sessions(agent_id,context_id,session_id,caller,created,last_at) VALUES(?,?,?,?,?,?)",
        r.id,
        job.contextId,
        s.id,
        job.caller.name.slice(0, 200),
        now,
        now,
      );
      store.audit("system", "resident.session.open", JSON.stringify({ agent: r.id, session: s.id }), { object: `agent:${r.id}` });
    });
    return s;
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

  private async turn(job: A2AJob, r: ResidentRow): Promise<A2AOutcome> {
    const store = this.ctx.store;
    const s = this.sessionFor(r, job);
    if (!s)
      return {
        state: "rejected",
        reason: "AGENT_UNAVAILABLE",
        message: ownerT()("server-resident.refusal.contextClosed"),
      };
    const firstTurn = !store.one("SELECT 1 FROM jobs WHERE session_id=? LIMIT 1", s.id);
    const prompt = residentPrompt(job, r.config, firstTurn, sessionLang(s));
    const attachments = this.attach(s.ownerId, job.files);
    const jid = newId();
    const now = Date.now();
    const events: any[] = [];
    let full = false;
    const waiting = store.atomic(() => {
      const active = store.one("SELECT id FROM jobs WHERE session_id=? AND status IN ('queued','running')", s.id);
      if (store.one("SELECT COUNT(*) AS n FROM jobs WHERE session_id=? AND status='pending'", s.id).n >= MAX_PENDING) {
        full = true;
        return false;
      }
      const n = store.one("SELECT COUNT(*) AS n FROM a2a_turns WHERE task_id=?", job.taskId).n as number;
      // P4-08 (trace.md §3): the turn carries the incoming call's trace and
      // depth, so an AI here calling further agents is depth-limited (T-7).
      store.run(
        "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,origin,trace,depth) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        jid,
        s.id,
        s.nodeId,
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
        r.id,
        s.id,
        s.id,
        "resident",
        r.config.permissionMode,
        now,
      );
      events.push(
        store.append(s.id, "item", {
          id: `user:${jid}`,
          kind: "user",
          text: prompt,
          status: "queued",
          origin: {
            type: "peer",
            senderName: job.caller.name,
            senderKind: job.caller.actor ? "agent" : "human",
            ownerName: job.caller.name,
            place: ownerT()("server-resident.place"),
            messageId: job.taskId,
            question: job.text.slice(0, 20000),
          },
          createdAt: now,
        }),
      );
      if (!active) events.push(store.append(s.id, "status", { status: "queued" }));
      return !!active;
    });
    if (full)
      return { state: "rejected", reason: "QUOTA_EXCEEDED", message: ownerT()("server-resident.refusal.queueFull", { n: MAX_PENDING }) };
    events.forEach((e) => this.ctx.broadcast(e));
    log.info(`[a2a] task=${job.taskId} resident=${r.id} job=${jid} session=${s.id}${waiting ? " (waits)" : ""}`);
    if (waiting) job.queued();
    const end = await this.wait(jid, s.id, job);
    const t = ownerT();
    if (end === "aborted") return { state: "failed", reason: "INTERRUPTED", message: t("server-resident.outcome.canceled") };
    if (end === "error") return { state: "failed", reason: "EXECUTION_ERROR", message: t("server-resident.outcome.error") };
    if (end === "interrupted") return { state: "failed", reason: "INTERRUPTED", message: t("server-resident.outcome.interrupted") };
    const read = readAnswer(this.lastAnswer(s.id, jid));
    const metadata = { [A2A_EXT.act]: { mode: "resident" } };
    if (read.question) return { state: "input-required", question: read.question, metadata };
    return { state: "completed", answer: read.answer || t("server-resident.outcome.noText"), metadata };
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

  /** Wait for job `jid` (the `AskAct.wait` pattern): change signals, a 2 s re-check; abort withdraws or stops it. */
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
      const off = this.ctx.onSessionChange((changed) => {
        if (changed !== sid || scheduled || done) return;
        scheduled = true;
        setImmediate(check);
      });
      const timer = setInterval(check, RECHECK_MS);
      (timer as any).unref?.();
      // ADR-123 §6: abort may fire inside another transaction (a revocation,
      // closing the agent): the withdrawal is scheduled, not done here.
      const onAbort = () => {
        setImmediate(() => {
          try {
            this.cancelJob(jid);
          } catch (e) {
            log.warn("resident: could not withdraw a turn", { job: jid, error: String((e as Error)?.message ?? e).slice(0, 200) });
          }
          finish("aborted");
        });
      };
      if (job.signal.aborted) onAbort();
      else job.signal.addEventListener("abort", onAbort, { once: true });
      check();
    });
  }
  /** The task ended from outside: a waiting turn is withdrawn, a running one stopped. */
  private cancelJob(jid: string) {
    const store = this.ctx.store;
    const j = store.one("SELECT * FROM jobs WHERE id=?", jid);
    if (!j || ended(j.status)) return;
    if (j.status === "pending") {
      store.atomic(() => dropQueuedJob(store, j.session_id, j, (sid, type, data) => this.ctx.publish(sid, type, data)));
      return;
    }
    store.run("UPDATE jobs SET cancel=1 WHERE id=?", j.id);
    if (j.status === "queued" && !j.lease) this.ctx.settle({ ...j, cancel: 1 }, "interrupted", ownerT()("server-resident.callerCanceled"));
  }
}
