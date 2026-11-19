/**
 * P4-04 A2A 服务端 (总纲 5.8, D-16, D-26, D-27, 5.11 「外面来的」,
 * docs/contracts/a2a-usage.md, ADR-123): visiting conversations and their
 * tasks, on top of the call authorization (P4-03) and an executor per
 * kind of agent (executors.ts — P4-05 / P4-07).
 *
 * The three ids, each with one meaning (D-16, a2a-usage.md §7):
 *
 *   contextId  one caller × one agent conversation. Made here when a
 *              message comes without one; belongs to that caller only —
 *              anyone else's, a reclaimed one, a made-up one: CONTEXT_NOT_FOUND
 *              (never a fresh one in its place, spec 3.4.1).
 *   taskId     one request (a turn) in it. Made here for every new task; a
 *              caller's own id for a new task: TaskNotFound (3.4.2). Given
 *              alone it names its conversation; with another conversation's
 *              id: CONTEXT_MISMATCH. To an ended task: UnsupportedOperation;
 *              to a running one too — only an input-required task takes more.
 *   messageId  the caller's, per caller × agent: the same one with the same
 *              content returns the original task (never run twice, 原则 2);
 *              with other content: MESSAGE_ID_CONFLICT.
 *
 * A call's path: recognised and in range (`canSee`, else 404 — T-2 / T-3),
 * then `check` — refused → REJECTED; pending → AUTH_REQUIRED, the owner's
 * card, `wait`; allowed → `begin` the call (registered so that taking the
 * permission back stops it, T-5) and run the executor. The call stays
 * registered until the task ends (an input-required task included).
 *
 * Blocking (D-26): a send without `returnImmediately: true` is answered
 * when the task ends or is interrupted (input / auth required) — no cap;
 * the caller's connection going away changes nothing about the task.
 * Restarts (原则 2): what was queued, running or waiting for the owner is
 * failed `INTERRUPTED` (never replayed); a task waiting on the caller
 * survives and re-checks the call authorization when the caller answers.
 */
import { msg } from "../app/errors.ts";
import { ownerT } from "../platform/language.ts";
import type { Translate } from "../../../contracts/src/i18n.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  A2A_EXT,
  weakReadOnlyNote,
  INTERRUPTED_STATES,
  isTerminal,
  TERMINAL_STATES,
  type A2AArtifact,
  type A2AMessageIn,
  type A2AMessageOut,
  type A2APart,
  type A2ATask,
  type ListTasksParams,
  type ListTasksResult,
  type SendMessageParams,
  type TaskReason,
  type TaskState,
} from "../../../contracts/src/a2a.ts";
import { A2A_LIMITS } from "../../../contracts/src/limits.ts";
import type { Principal } from "../access/guard.ts";
import { InvokeError, issuerPersonKey, SELF_PERSON, type InvokeAccess, type AgentInfo, type StopReason } from "../invoke/invoke-access.ts";
import type { CallHandle } from "../invoke/calls.ts";
import type { InvokePerson } from "../../../contracts/src/api/invoke.ts";
import type { Store } from "../store/index.ts";
import { isTraceId, newTraceId, parseTraceparent } from "../observe/trace.ts";
import { log } from "../observe/log.ts";
import { A2AError, type A2AText } from "./errors.ts";
import type { A2AExecutor, A2AFile, A2AJob, A2AOutcome, A2APriorTask, ExecutorResolver } from "./executors.ts";

const L = A2A_LIMITS;
const SETTLED: readonly string[] = [...TERMINAL_STATES, ...INTERRUPTED_STATES];
const OPEN_STATES = `('TASK_STATE_SUBMITTED','TASK_STATE_WORKING','TASK_STATE_INPUT_REQUIRED','TASK_STATE_AUTH_REQUIRED')`;
/** Stopped by a restart: everything open except what waits on the caller. */
const INTERRUPTIBLE = `('TASK_STATE_SUBMITTED','TASK_STATE_WORKING','TASK_STATE_AUTH_REQUIRED')`;

/** P4-12: the caller key of a request that came with a `daisy token` (`token:<jti>`). */
export const VISITOR_TOKEN_CALLER = "token:";

/** Who a caller is, for owning conversations and tasks (a2a-usage.md §7 "调用方"). */
export interface Caller {
  key: string;
  label: string;
  actor: string | null;
}
export function callerOf(p: Principal): Caller {
  // The external issuer's person: the issuer and the whole `sub` (hashed) —
  // the same person the call authorization keys its grants on.
  // P4-12 review M-1: a `daisy token` owns its own tasks and conversations
  // — each token apart from every other token for the same person, and
  // from that person's own Daisy (`contact:<id>`). Quotas, rate limits and
  // the trace count go by it too. The *person* (who the call authorization
  // asks about: cards, grants) is still the contact / `self` (invoke-access).
  const key = p.visitorToken
    ? `${VISITOR_TOKEN_CALLER}${p.visitorToken}`
    : p.contactId
      ? `contact:${p.contactId}`
      : issuerPersonKey(p.issuer ?? "", p.subjectHash ?? "");
  return { key, label: p.label, actor: p.actor ?? null };
}

/** A request's transport-level facts the handler hands over. */
export interface SendOptions {
  /** URIs in the `A2A-Extensions` request header. */
  extensions: readonly string[];
  /** The request's own trace id (the `traceparent` header, else new) — used when the message has no trace extension. */
  traceId?: string;
  /** The caller's connection went away: stop holding it (the task goes on). */
  signal?: AbortSignal;
}

interface Run {
  /** Aborts the executor (or the wait for the owner). */
  abort: AbortController;
  /** The executor is running / the wait for the owner is pending (finish aborts them, review L-3). */
  busy: boolean;
  /** The ticket of the card this call waits on (cancel withdraws it, review L-4). */
  ticket: string | null;
  /** The registered call, once admitted. */
  handle: CallHandle | null;
  /** Being stopped: whatever the executor answers now is ignored. */
  stopping: boolean;
  /** Who, as the call authorization named them when the call began. */
  person: InvokePerson | null;
}

/** A message kept in memory until its call begins (review M-1: only a stub is stored before). */
interface Pending {
  caller: string;
  messageId: string;
  data: string;
}

export class A2AServer {
  private resolvers: ExecutorResolver[] = [];
  private listers: (() => readonly string[])[] = [];
  private runs = new Map<string, Run>();
  private watchers = new Map<string, Set<(state: string) => void>>();
  /** Review M-1: full messages of calls not begun yet, by task. */
  private pending = new Map<string, Pending>();
  /** Review M-1: each caller's recent SendMessage times (ms). */
  private sendTimes = new Map<string, number[]>();
  /** Review M-2: each caller's held blocking sends — task → let the held one go now. */
  private held = new Map<string, Map<string, () => void>>();
  private now: () => number;
  private lastSweep = 0;
  private closed = false;

  /** P4-05 / P4-07: who runs which agent's tasks (newest asked first). */
  readonly executors = {
    add: (fn: ExecutorResolver) => void this.resolvers.unshift(fn),
    resolve: (agent: AgentInfo): A2AExecutor | null => {
      for (const f of this.resolvers) {
        const e = f(agent);
        if (e) return e;
      }
      return null;
    },
  };
  /**
   * P4-06 / P4-07: which agent ids exist, for the directory (`GET /a2a`).
   * Each id is shown only to callers `canSee` lets see it.
   */
  readonly directory = {
    add: (fn: () => readonly string[]) => void this.listers.push(fn),
    ids: (): string[] => [...new Set(this.listers.flatMap((f) => f()))],
  };
  /**
   * P4-07 (ADR-126, a2a-usage.md §12): told, after the reclaim's
   * transaction, which conversations were reclaimed (a resident agent
   * closes the dedicated session of each). A hook's error is logged.
   */
  onReclaim(fn: (contexts: { id: string; agentId: string }[]) => void): void {
    this.reclaimHooks.push(fn);
  }
  private reclaimHooks: ((contexts: { id: string; agentId: string }[]) => void)[] = [];

  constructor(
    private store: Store,
    private invoke: InvokeAccess,
    o: { now?: () => number } = {},
  ) {
    this.now = o.now ?? Date.now;
    this.recover();
    // P4-06 (ADR-125): an agent forgotten (taken back to private, its
    // session deleted, a resident closed): its tasks still open end now.
    invoke.onAgentGone((agentId) => this.closeAgent(agentId));
  }

  /**
   * P4-06: every task of `agentId` not ended yet ends now (REJECTED
   * GRANT_REVOKED, the reason said): the running ones are stopped (their
   * executor withdraws or stops the turn), the ones waiting on the caller
   * (input-required — also those left from before a restart) or on the
   * owner end at once. Synchronous; the writes happen right after.
   */
  closeAgent(agentId: string, why: StopReason = { code: "agent_gone", message: say("agentGone") }): number {
    const open = this.store.all(
      "SELECT id FROM a2a_tasks WHERE agent_id=? AND state NOT IN ('TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED')",
      agentId,
    );
    for (const t of open) this.stopped(t.id, why);
    return open.length;
  }

  // ── visibility ──────────────────────────────────────────────────────────
  /**
   * The per-agent operations other than send: 404 unless the caller may
   * see the agent or already has tasks on it (see `taskScope`).
   */
  reachable(p: Principal, agentId: string): boolean {
    try {
      this.taskScope(p, agentId);
      return true;
    } catch {
      return false;
    }
  }
  /** 5.11: may `p` see `agentId` (its card, a call)? Never raises a card. */
  canSee(p: Principal, agentId: string): AgentInfo | null {
    if (!this.invoke.canSee(p, agentId)) return null;
    return this.invoke.agents.resolve(agentId);
  }
  /**
   * The task operations (get, list, cancel): an agent the caller cannot
   * see answers 404 — unless they already have tasks on it (5.11: one may
   * query and cancel one's own tasks; that reveals nothing new).
   */
  private taskScope(p: Principal, agentId: string): Caller {
    const caller = callerOf(p);
    if (this.invoke.canSee(p, agentId)) return caller;
    if (this.store.one("SELECT 1 FROM a2a_tasks WHERE agent_id=? AND caller=? LIMIT 1", agentId, caller.key)) return caller;
    throw notFound();
  }

  // ── SendMessage ─────────────────────────────────────────────────────────
  async send(p: Principal, agentId: string, req: SendMessageParams, o: SendOptions): Promise<A2ATask> {
    this.sweep();
    if (this.closed) throw unavailable();
    const agent = this.canSee(p, agentId);
    if (!agent) throw notFound();
    const caller = callerOf(p);
    this.rateLimit(caller.key);
    const m = req.message;
    const cfg = req.configuration ?? {};
    if (cfg.taskPushNotificationConfig !== undefined)
      throw new A2AError("PUSH_NOTIFICATION_NOT_SUPPORTED", msg("server-a2a.push.inSend"));
    const modes = cfg.acceptedOutputModes ?? [];
    if (modes.length && !modes.some((x) => ["text/plain", "text/*", "*/*"].includes(x.toLowerCase())))
      throw new A2AError("CONTENT_TYPE_NOT_SUPPORTED", msg("server-a2a.textOnly"));
    const historyLength = cfg.historyLength;
    const digest = digestOf(m);
    const immediately = cfg.returnImmediately === true;
    const done = (taskId: string) => this.answer(taskId, immediately, historyLength, o.signal, caller.key);

    // A resend (the same messageId): the original task, never run again.
    const seen = this.store.one(
      "SELECT digest,task_id FROM a2a_message_ids WHERE agent_id=? AND caller=? AND message_id=?",
      agentId,
      caller.key,
      m.messageId,
    );
    if (seen) {
      if (seen.digest !== digest)
        throw new A2AError(
          "MESSAGE_ID_CONFLICT",
          msg("server-a2a.messageIdConflict"),
          { fields: [{ field: "message.messageId", description: msg("server-a2a.field.messageIdUsed") }] },
        );
      return done(seen.task_id);
    }

    // Which conversation, which task (a2a-usage.md §7).
    let task: any = null;
    let contextId: string | null = null;
    if (m.taskId) {
      task = this.ownTask(agentId, caller.key, m.taskId);
      if (!task) throw taskNotFound();
      if (m.contextId && m.contextId !== task.context_id)
        throw new A2AError("CONTEXT_MISMATCH", msg("server-a2a.contextMismatch"), {
          fields: [{ field: "message.contextId", description: msg("server-a2a.field.contextMismatch") }],
        });
      if (isTerminal(task.state))
        throw new A2AError(
          "UNSUPPORTED_OPERATION",
          msg("server-a2a.taskEnded"),
        );
      if (task.state !== "TASK_STATE_INPUT_REQUIRED")
        throw new A2AError("UNSUPPORTED_OPERATION", msg("server-a2a.taskRunning"));
      // Review L-3: the permission was just taken back; its REJECTED is on the way.
      if (this.runs.get(task.id)?.stopping)
        throw new A2AError("UNSUPPORTED_OPERATION", msg("server-a2a.taskStopping"));
      // Review L-2: a bounded exchange per task.
      const n = this.store.one("SELECT COUNT(*) n FROM a2a_messages WHERE task_id=? AND role='ROLE_USER'", task.id).n as number;
      if (n >= L.messagesPerTask)
        throw exhausted(msg("server-a2a.taskInputsUsed", { n }), 0);
      contextId = task.context_id;
    } else if (m.contextId) {
      if (!this.ownContext(agentId, caller.key, m.contextId))
        throw new A2AError(
          "CONTEXT_NOT_FOUND",
          msg("server-a2a.contextNotFound"),
          { fields: [{ field: "message.contextId", description: msg("server-a2a.field.contextNotFound") }] },
        );
      contextId = m.contextId;
    }
    for (const ref of m.referenceTaskIds ?? [])
      if (!this.ownTask(agentId, caller.key, ref))
        throw new A2AError("TASK_NOT_FOUND", msg("server-a2a.refTaskNotFound", { task: clip(ref) }), {
          fields: [{ field: "message.referenceTaskIds", description: msg("server-a2a.field.noSuchTask") }],
        });

    const trace = traceOf(m, o.traceId);
    const mode = actMode(m, o.extensions);
    const now = this.now();
    const continuing = !!task;
    const taskId: string = task?.id ?? randomUUID();
    // Review M-1 / M-2: what this caller may make Daisy hold — checked before anything is stored.
    const full = JSON.stringify({ ...outMessage(m), contextId: contextId ?? "", taskId });
    this.limits(caller.key, agentId, { newTask: !continuing, newContext: !contextId, bytes: full.length, holds: !immediately });
    // The call has begun already (a continuation of a running call): keep it whole.
    // Otherwise only a stub until `begin` (refused, or waiting for the owner).
    const run0 = continuing ? this.runs.get(taskId) : undefined;
    const begun = !!run0?.handle?.active && task?.via !== "once";
    this.store.atomic(() => {
      if (!contextId) {
        contextId = randomUUID();
        this.store.run(
          "INSERT INTO a2a_contexts(id,agent_id,caller,created,active_at) VALUES(?,?,?,?,?)",
          contextId,
          agentId,
          caller.key,
          now,
          now,
        );
      } else this.store.run("UPDATE a2a_contexts SET active_at=? WHERE id=?", now, contextId);
      if (!continuing)
        this.store.run(
          "INSERT INTO a2a_tasks(id,context_id,agent_id,caller,actor,state,mode,created,updated,trace_id,depth) VALUES(?,?,?,?,?,'TASK_STATE_SUBMITTED',?,?,?,?,?)",
          taskId,
          contextId,
          agentId,
          caller.key,
          caller.actor,
          mode,
          now,
          now,
          trace.traceId,
          trace.depth,
        );
      else
        this.store.run(
          "UPDATE a2a_tasks SET state='TASK_STATE_SUBMITTED',status_message=NULL,mode=?,updated=? WHERE id=?",
          mode,
          now,
          taskId,
        );
      const stored: A2AMessageOut = { ...outMessage(m), contextId: contextId!, taskId };
      const whole = JSON.stringify(stored);
      this.store.run(
        "INSERT INTO a2a_messages(task_id,context_id,role,message_id,data,created) VALUES(?,?,'ROLE_USER',?,?,?)",
        taskId,
        contextId,
        m.messageId,
        begun ? whole : JSON.stringify(stubOf(stored)),
        now,
      );
      if (!begun) this.pending.set(taskId, { caller: caller.key, messageId: m.messageId, data: whole });
      this.store.run(
        "INSERT INTO a2a_message_ids(agent_id,caller,message_id,digest,task_id,context_id,created) VALUES(?,?,?,?,?,?,?)",
        agentId,
        caller.key,
        m.messageId,
        digest,
        taskId,
        contextId,
        now,
      );
      if (!continuing)
        this.store.audit(caller.label, "a2a.task", JSON.stringify({ task: taskId, agent: agentId, mode }), {
          actor: "visitor",
          object: `task:${taskId}`,
          traceId: trace.traceId,
          depth: trace.depth,
        });
    });
    if (continuing) this.resume(p, agent, taskId);
    else this.start(p, agent, taskId, trace);
    return done(taskId);
  }

  /** A new task: trace limits, then the call authorization (synchronous up to the owner's card). */
  private start(p: Principal, agent: AgentInfo, taskId: string, trace: { traceId: string; depth: number }) {
    if (trace.depth > L.traceMaxDepth)
      return this.finish(taskId, "TASK_STATE_REJECTED", "TRACE_DEPTH_EXCEEDED", say("traceDepth", { max: L.traceMaxDepth }));
    // trace.md §5 / review L-8: the depth and the trace id are the caller's own
    // word (cooperative, not a defence); received calls are counted per
    // caller × trace — plus every call this Daisy's own AIs sent on the
    // trace (P4-08, a2a_calls: "本机发出的和本机接受的合起来").
    const caller = this.store.one("SELECT caller FROM a2a_tasks WHERE id=?", taskId)?.caller as string;
    const seen = traceCalls(this.store, trace.traceId, caller);
    if (seen > L.traceMaxCalls)
      return this.finish(taskId, "TASK_STATE_REJECTED", "TRACE_CALLS_EXCEEDED", say("traceCalls", { max: L.traceMaxCalls }));
    this.admit(p, agent, taskId);
  }

  /** The caller answered an input-required question. */
  private resume(p: Principal, agent: AgentInfo, taskId: string) {
    const run = this.runs.get(taskId);
    // Still registered (no restart since) and not a 仅本次 call: the same call goes on.
    if (run?.handle?.active && this.row(taskId)?.via !== "once") return this.execute(agent, taskId, run);
    // Review L-2: a 仅本次 approval let one call through — a continuation asks
    // again. After a restart (or the call was dropped): the same.
    run?.handle?.end();
    if (run) run.handle = null;
    this.admit(p, agent, taskId);
  }

  /**
   * `check` → refused (REJECTED) / pending (AUTH_REQUIRED, wait for the
   * owner) / allowed — then `begin` (ADR-122 §8, final API).
   */
  private admit(p: Principal, agent: AgentInfo, taskId: string) {
    const d = this.invoke.check(p, agent.id);
    if (d.outcome === "refused") {
      const reason = REFUSAL[d.reason] ?? "AGENT_UNAVAILABLE";
      const text = REFUSAL[d.reason] ? say(`refusal.${d.reason}`) : d.message;
      return this.finish(taskId, "TASK_STATE_REJECTED", reason, text || d.message);
    }
    if (d.outcome === "allowed") return this.begin(p, agent, taskId, undefined, d.person);
    // The owner decides (5.4 step 2–3): AUTH_REQUIRED until then. A 仅本次
    // for another waiting call moves this one to a fresh card — `wait`
    // keeps waiting, the task stays AUTH_REQUIRED.
    const run = this.runFor(taskId);
    run.ticket = d.ticket;
    run.busy = true;
    this.setState(taskId, "TASK_STATE_AUTH_REQUIRED", {
      statusMessage: this.statusMessage(taskId, say("waitingOwner"), null),
    });
    this.invoke.wait(d, run.abort.signal).then(
      (s) => {
        run.busy = false;
        if (run.stopping || this.isOver(taskId)) return;
        if (s.outcome === "allowed") return this.begin(p, agent, taskId, d.ticket, d.person);
        this.finish(
          taskId,
          "TASK_STATE_REJECTED",
          s.reason === "rejected" ? "OWNER_REJECTED" : s.reason === "expired" ? "APPROVAL_EXPIRED" : "APPROVAL_CANCELED",
          s.message,
        );
      },
      (e) => {
        run.busy = false;
        if (run.stopping || this.isOver(taskId)) return;
        log.warn("a2a: waiting for the owner failed", { task: taskId, error: clip(String((e as Error)?.message ?? e), 200) });
        this.finish(taskId, "TASK_STATE_FAILED", "EXECUTION_ERROR", say("waitFailed"));
      },
    );
  }

  /**
   * The moment the call starts (ADR-122 §8): `invoke.begin` — synchronous,
   * nothing held across an await; it re-checks admission in one
   * transaction and registers the call, so that taking the permission back
   * stops it. Its refusal (403 `not_admitted`) ends the task here.
   */
  private begin(p: Principal, agent: AgentInfo, taskId: string, ticket: string | undefined, person: InvokePerson) {
    const run = this.runFor(taskId);
    let handle: CallHandle;
    try {
      handle = this.invoke.begin(p, agent.id, {
        ...(ticket ? { ticket } : {}),
        stop: (why) => this.stopped(taskId, why),
      });
    } catch (e) {
      if (!(e instanceof InvokeError)) throw e;
      return this.finish(taskId, "TASK_STATE_REJECTED", "GRANT_REVOKED", say("revokedBeforeStart", { why: e.message }));
    }
    run.handle = handle;
    run.person = person;
    run.ticket = null;
    // Review M-1: the call has begun — now the message is kept whole.
    const full = this.pending.get(taskId);
    if (full) {
      this.store.run("UPDATE a2a_messages SET data=? WHERE task_id=? AND message_id=? AND role='ROLE_USER'", full.data, taskId, full.messageId);
      this.pending.delete(taskId);
    }
    const via = this.invoke.calls.list({ agentId: agent.id }).find((c) => c.id === handle.id)?.via ?? null;
    this.store.run("UPDATE a2a_tasks SET via=? WHERE id=?", via, taskId);
    this.execute(agent, taskId, run);
  }

  /** Run the executor once (a new task, or a continuation). */
  private execute(agent: AgentInfo, taskId: string, run: Run) {
    const executor = this.executors.resolve(agent);
    if (!executor)
      return this.finish(taskId, "TASK_STATE_REJECTED", "AGENT_UNAVAILABLE", say("noExecutor"));
    // A fresh signal for this run (a continuation gets its own).
    if (run.abort.signal.aborted) run.abort = new AbortController();
    const signal = run.abort.signal;
    this.setState(taskId, "TASK_STATE_WORKING", {});
    let job: A2AJob;
    try {
      job = this.jobOf(agent, taskId, signal);
    } catch (e) {
      // Review L-7: the detail goes to the log, never to the caller.
      log.warn("a2a: preparing a task failed", { task: taskId, error: clip(String((e as Error)?.message ?? e), 300) });
      return this.finish(taskId, "TASK_STATE_FAILED", "EXECUTION_ERROR", say("prepareFailed"));
    }
    let p: Promise<A2AOutcome>;
    run.busy = true;
    try {
      p = Promise.resolve(executor.run(job));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (out) => {
        run.busy = false;
        if (run.stopping || signal.aborted || this.isOver(taskId)) return;
        this.apply(taskId, out);
      },
      (e) => {
        run.busy = false;
        if (run.stopping || signal.aborted || this.isOver(taskId)) return;
        log.warn("a2a: an executor failed", { task: taskId, error: clip(String((e as Error)?.message ?? e), 300) });
        this.finish(taskId, "TASK_STATE_FAILED", "EXECUTION_ERROR", say("runFailed"));
      },
    );
  }

  private apply(taskId: string, out: A2AOutcome) {
    switch (out.state) {
      case "completed": {
        // limits.md §2: files inline up to 12 MB each, 32 MB together; the rest is left out and said so.
        const files: A2AFile[] = [];
        const left: string[] = [];
        let total = 0;
        for (const f of out.files ?? []) {
          if (f.bytes.length > L.resultFileMax || total + f.bytes.length > L.resultFilesMax) left.push(f.filename);
          else (files.push(f), (total += f.bytes.length));
        }
        const notes = [...(out.notes ?? []), ...(left.length ? [say("filesLeftOut", { n: left.length, names: left.join(say("listSeparator")) })] : [])];
        const parts: A2APart[] = [{ text: String(out.answer ?? "") }, ...notes.map((t) => ({ text: String(t) }))];
        const artifacts: A2AArtifact[] = [
          { artifactId: "answer", name: say("answerArtifact"), parts },
          ...files.map((f, i) => ({
            artifactId: `file-${i + 1}`,
            name: f.filename,
            parts: [{ raw: f.bytes.toString("base64"), filename: f.filename, mediaType: f.mediaType }],
          })),
        ];
        return this.finish(taskId, "TASK_STATE_COMPLETED", null, null, { artifacts, metadata: out.metadata });
      }
      case "input-required": {
        const t = this.row(taskId);
        const msg: A2AMessageOut = {
          messageId: randomUUID(),
          contextId: t.context_id,
          taskId,
          role: "ROLE_AGENT",
          parts: [{ text: String(out.question ?? "") }],
        };
        this.store.atomic(() => {
          this.store.run(
            "INSERT INTO a2a_messages(task_id,context_id,role,message_id,data,created) VALUES(?,?,'ROLE_AGENT',?,?,?)",
            taskId,
            t.context_id,
            msg.messageId,
            JSON.stringify(msg),
            this.now(),
          );
          this.setState(taskId, "TASK_STATE_INPUT_REQUIRED", { statusMessage: msg, metadata: out.metadata });
        });
        return;
      }
      case "rejected":
        return this.finish(taskId, "TASK_STATE_REJECTED", out.reason, out.message);
      case "failed":
        return this.finish(taskId, "TASK_STATE_FAILED", out.reason ?? "EXECUTION_ERROR", out.message);
    }
  }

  /** The call authorization took the permission back (T-5): the task ends now. */
  private stopped(taskId: string, why: StopReason) {
    const run = this.runs.get(taskId);
    if (run) {
      run.stopping = true;
      run.handle = null;
      run.abort.abort(new Error(why.code));
    }
    // Called from inside whatever change took the permission back (often
    // in its transaction): the task's own write happens right after it.
    setImmediate(() => {
      if (this.isOver(taskId)) return;
      this.finish(taskId, "TASK_STATE_REJECTED", "GRANT_REVOKED", say("stopped", { why: why.message }));
    });
  }

  // ── GetTask / ListTasks / CancelTask ────────────────────────────────────
  get(p: Principal, agentId: string, id: string, historyLength?: number): A2ATask {
    this.sweep();
    const caller = this.taskScope(p, agentId);
    const t = this.ownTask(agentId, caller.key, id);
    if (!t) throw taskNotFound();
    return this.view(t, historyLength, true);
  }

  list(p: Principal, agentId: string, q: ListTasksParams): ListTasksResult {
    this.sweep();
    const caller = this.taskScope(p, agentId);
    const where = ["agent_id=?", "caller=?"];
    const args: unknown[] = [agentId, caller.key];
    if (q.contextId) (where.push("context_id=?"), args.push(q.contextId));
    if (q.status) (where.push("state=?"), args.push(q.status));
    if (q.statusTimestampAfter) (where.push("updated>?"), args.push(Date.parse(q.statusTimestampAfter)));
    const total = this.store.one(`SELECT COUNT(*) n FROM a2a_tasks WHERE ${where.join(" AND ")}`, ...args).n as number;
    if (q.pageToken) {
      const c = cursorOf(q.pageToken);
      if (!c) throw new A2AError("INVALID_ARGUMENT", msg("server-a2a.pageToken"), { fields: [{ field: "pageToken", description: msg("server-a2a.field.invalid") }] });
      where.push("(created<? OR (created=? AND id<?))");
      args.push(c.created, c.created, c.id);
    }
    const size = q.pageSize ?? L.pageDefault;
    const rows = this.store.all(
      `SELECT * FROM a2a_tasks WHERE ${where.join(" AND ")} ORDER BY created DESC, id DESC LIMIT ?`,
      ...args,
      size + 1,
    );
    const page = rows.slice(0, size);
    const more = rows.length > size;
    const last = page[page.length - 1];
    return {
      tasks: page.map((t) => this.view(t, q.historyLength, q.includeArtifacts === true)),
      nextPageToken: more && last ? Buffer.from(`${last.created}|${last.id}`).toString("base64url") : "",
      pageSize: size,
      totalSize: total,
    };
  }

  cancel(p: Principal, agentId: string, id: string): A2ATask {
    this.sweep();
    const caller = this.taskScope(p, agentId);
    const t = this.ownTask(agentId, caller.key, id);
    if (!t) throw taskNotFound();
    if (isTerminal(t.state))
      throw new A2AError("TASK_NOT_CANCELABLE", msg("server-a2a.notCancelable"));
    const run = this.runs.get(id);
    // Review L-4 (a2a-usage.md §5): waiting for the owner — the call leaves
    // the card, and a card nobody waits on any more is closed.
    if (run?.ticket && t.state === "TASK_STATE_AUTH_REQUIRED") this.invoke.withdraw(run.ticket);
    if (run) {
      run.stopping = true;
      run.abort.abort(new Error("canceled"));
    }
    this.finish(id, "TASK_STATE_CANCELED", null, say("canceled"));
    return this.view(this.row(id), undefined, true);
  }

  // ── the card, the directory ─────────────────────────────────────────────
  card(p: Principal, agentId: string, root: string, version: string, t?: Translate): Record<string, unknown> {
    const agent = this.canSee(p, agentId);
    if (!agent) throw notFound();
    const ext = this.executors.resolve(agent)?.describe?.(agent) ?? null;
    return agentCard(agent, `${root}/a2a/${encodeURIComponent(agent.id)}`, version, ext, t);
  }
  listAgents(p: Principal, root: string): { agents: { agentId: string; name: string; card: string }[] } {
    const agents = [];
    for (const id of this.directory.ids()) {
      const a = this.canSee(p, id);
      if (a)
        agents.push({
          agentId: a.id,
          name: a.name,
          card: `${root}/a2a/${encodeURIComponent(a.id)}/.well-known/agent-card.json`,
        });
    }
    return { agents };
  }

  // ── lifecycle ───────────────────────────────────────────────────────────
  /**
   * Start-up (原则 2, a2a-usage.md §11): tasks the last process left
   * queued, running or waiting for the owner were interrupted — failed,
   * never replayed (`wait` lives in memory; the card stays with the owner).
   */
  private recover() {
    const rows = this.store.all(`SELECT id FROM a2a_tasks WHERE state IN ${INTERRUPTIBLE}`);
    for (const r of rows)
      this.finish(r.id, "TASK_STATE_FAILED", "INTERRUPTED", say("restartedInterrupted"));
  }
  /**
   * The process is going away (a restart, closing): fail what is in
   * flight so held connections get their answer (a2a-usage.md §11).
   */
  interruptAll(): number {
    this.closed = true;
    let n = 0;
    for (const [taskId, run] of [...this.runs]) {
      const t = this.row(taskId);
      if (!t || isTerminal(t.state) || t.state === "TASK_STATE_INPUT_REQUIRED") continue;
      run.stopping = true;
      run.abort.abort(new Error("interrupted"));
      this.finish(taskId, "TASK_STATE_FAILED", "INTERRUPTED", say("restartingInterrupted"));
      n++;
    }
    for (const run of this.runs.values()) run.handle?.end();
    return n;
  }
  /** Reclaim conversations idle past the limit with nothing open (a2a-usage.md §12). */
  sweep(force = false): number {
    const now = this.now();
    if (!force && now - this.lastSweep < 60_000) return 0;
    this.lastSweep = now;
    // Review L-2: waiting on the caller is not forever — the task fails and the call ends.
    for (const r of this.store.all("SELECT id FROM a2a_tasks WHERE state='TASK_STATE_INPUT_REQUIRED' AND updated<?", now - L.inputIdleMs))
      this.finish(r.id, "TASK_STATE_FAILED", "INPUT_EXPIRED", say("inputExpired", { hours: Math.round(L.inputIdleMs / 3_600_000) }));
    const old = this.store.all(
      `SELECT c.id,c.agent_id FROM a2a_contexts c WHERE c.active_at<? AND NOT EXISTS (SELECT 1 FROM a2a_tasks t WHERE t.context_id=c.id AND t.state IN ${OPEN_STATES})`,
      now - L.contextIdleMs,
    );
    if (!old.length) return 0;
    this.store.atomic(() => {
      for (const { id } of old) {
        this.store.run("DELETE FROM a2a_messages WHERE context_id=?", id);
        this.store.run("DELETE FROM a2a_message_ids WHERE context_id=?", id);
        this.store.run("DELETE FROM a2a_tasks WHERE context_id=?", id);
        this.store.run("DELETE FROM a2a_contexts WHERE id=?", id);
      }
      this.store.audit("system", "a2a.reclaim", JSON.stringify({ contexts: old.length }));
    });
    for (const fn of this.reclaimHooks)
      try {
        fn(old.map((r) => ({ id: r.id as string, agentId: r.agent_id as string })));
      } catch (e) {
        log.warn("a2a: a reclaim hook failed", { error: clip(String((e as Error)?.message ?? e), 200) });
      }
    return old.length;
  }

  // ── state ───────────────────────────────────────────────────────────────
  private runFor(taskId: string): Run {
    let r = this.runs.get(taskId);
    if (!r) this.runs.set(taskId, (r = { abort: new AbortController(), busy: false, ticket: null, handle: null, stopping: false, person: null }));
    return r;
  }
  private row(taskId: string): any {
    return this.store.one("SELECT * FROM a2a_tasks WHERE id=?", taskId);
  }
  /** The person behind a caller key, for the executor (display only); a token's from its record. */
  private personOfKey(key: string): { contactId: string | null; subject: string; name: string } {
    if (key.startsWith(VISITOR_TOKEN_CALLER)) {
      const r = this.store.one("SELECT subject,contact_id,name FROM visitor_tokens WHERE jti=?", key.slice(VISITOR_TOKEN_CALLER.length));
      if (r) return { contactId: r.contact_id ?? null, subject: r.subject, name: r.contact_id ? r.name : say("selfToken") };
    }
    return personOfCaller(key);
  }
  private ownTask(agentId: string, caller: string, taskId: string): any {
    return this.store.one("SELECT * FROM a2a_tasks WHERE id=? AND agent_id=? AND caller=?", taskId, agentId, caller);
  }
  private ownContext(agentId: string, caller: string, contextId: string): boolean {
    return !!this.store.one("SELECT 1 FROM a2a_contexts WHERE id=? AND agent_id=? AND caller=?", contextId, agentId, caller);
  }
  private isOver(taskId: string): boolean {
    const t = this.row(taskId);
    return !t || isTerminal(t.state);
  }

  private setState(
    taskId: string,
    state: TaskState,
    o: { statusMessage?: A2AMessageOut | null; artifacts?: A2AArtifact[]; metadata?: Record<string, unknown> },
  ): boolean {
    const now = this.now();
    const sets = ["state=?", "updated=?"];
    const args: unknown[] = [state, now];
    if (o.statusMessage !== undefined) (sets.push("status_message=?"), args.push(o.statusMessage ? JSON.stringify(o.statusMessage) : null));
    if (o.artifacts !== undefined) (sets.push("artifacts=?"), args.push(JSON.stringify(o.artifacts)));
    if (o.metadata !== undefined) (sets.push("metadata=?"), args.push(JSON.stringify(o.metadata)));
    const changed = this.store.atomic(() => {
      const r = this.store.run(
        `UPDATE a2a_tasks SET ${sets.join(",")} WHERE id=? AND state NOT IN ('TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED')`,
        ...args,
        taskId,
      );
      if (Number(r.changes) !== 1) return false;
      this.store.run("UPDATE a2a_contexts SET active_at=? WHERE id=(SELECT context_id FROM a2a_tasks WHERE id=?)", now, taskId);
      return true;
    });
    if (changed) this.notify(taskId, state);
    return changed;
  }

  /** End a task (terminal state) with its reason in `status.message`; ends the call. */
  private finish(
    taskId: string,
    state: TaskState,
    reason: TaskReason | null,
    text: string | null,
    o: { artifacts?: A2AArtifact[]; metadata?: Record<string, unknown> } = {},
  ) {
    const statusMessage = text ? this.statusMessage(taskId, text, reason) : null;
    const t = this.row(taskId);
    const ok = this.setState(taskId, state, { statusMessage, ...o });
    const run = this.runs.get(taskId);
    // Review L-3: whatever is still going for this task stops with it.
    if (run && run.busy && !run.abort.signal.aborted) {
      run.stopping = true;
      run.abort.abort(new Error("finished"));
    }
    run?.handle?.end();
    this.runs.delete(taskId);
    this.pending.delete(taskId);
    if (ok && t)
      this.store.audit("system", `a2a.task.${state.replace("TASK_STATE_", "").toLowerCase()}`, JSON.stringify({ task: taskId, agent: t.agent_id, reason }), {
        object: `task:${taskId}`,
        traceId: t.trace_id,
        depth: t.depth,
        ...(reason ? { reason } : {}),
      });
  }

  private statusMessage(taskId: string, text: string, reason: TaskReason | null): A2AMessageOut {
    const t = this.row(taskId);
    return {
      messageId: randomUUID(),
      contextId: t?.context_id ?? "",
      taskId,
      role: "ROLE_AGENT",
      parts: [{ text }, ...(reason ? [{ data: { reason } }] : [])],
    };
  }

  /** Review M-2: the state just written decides — no re-read per watcher. */
  private notify(taskId: string, state: string) {
    const set = this.watchers.get(taskId);
    if (!set) return;
    for (const fn of [...set]) fn(state);
  }

  /**
   * The send's answer: now, or once the task ends or is interrupted (D-26).
   * Review M-2: one held connection per caller × task (a newer one takes
   * over; the older is answered with the task as it stands), at most
   * `heldPerCaller` per caller (503 beyond).
   */
  private answer(
    taskId: string,
    immediately: boolean,
    historyLength: number | undefined,
    signal: AbortSignal | undefined,
    caller: string,
  ): Promise<A2ATask> {
    const view = () => {
      const t = this.row(taskId);
      if (!t) throw taskNotFound();
      return this.view(t, historyLength, true);
    };
    if (immediately || SETTLED.includes(this.row(taskId)?.state ?? "TASK_STATE_FAILED")) return Promise.resolve(view());
    const older = this.held.get(caller)?.get(taskId);
    if (older) older();
    else if ((this.held.get(caller)?.size ?? 0) >= L.heldPerCaller) throw tooManyHeld();
    let holds = this.held.get(caller);
    if (!holds) this.held.set(caller, (holds = new Map()));
    return new Promise((resolve, reject) => {
      let set = this.watchers.get(taskId);
      if (!set) this.watchers.set(taskId, (set = new Set()));
      const watchers = set;
      let done = false;
      const release = () => {
        if (done) return;
        done = true;
        watchers.delete(onState);
        if (!watchers.size) this.watchers.delete(taskId);
        if (holds!.get(taskId) === release) holds!.delete(taskId);
        if (!holds!.size && this.held.get(caller) === holds) this.held.delete(caller);
        signal?.removeEventListener("abort", release);
        try {
          resolve(view());
        } catch (e) {
          reject(e);
        }
      };
      const onState = (state: string) => {
        if (SETTLED.includes(state)) release();
      };
      watchers.add(onState);
      holds!.set(taskId, release);
      // The caller went away: stop holding (the task goes on, 5.8).
      if (signal?.aborted) return release();
      signal?.addEventListener("abort", release, { once: true });
    });
  }

  // ── limits (review M-1 / M-2) ───────────────────────────────────────────
  /** SendMessage requests per caller per minute. */
  private rateLimit(caller: string) {
    const now = this.now();
    const times = (this.sendTimes.get(caller) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= L.sendsPerMinute) {
      this.sendTimes.set(caller, times);
      throw exhausted(msg("server-a2a.tooFast", { max: L.sendsPerMinute }), Math.ceil((60_000 - (now - times[0]!)) / 1000));
    }
    times.push(now);
    this.sendTimes.set(caller, times);
    if (this.sendTimes.size > 10_000) for (const [k, v] of this.sendTimes) if (!v.some((t) => now - t < 60_000)) this.sendTimes.delete(k);
  }
  /** What one caller may make this Daisy hold, before anything is stored. */
  private limits(caller: string, agentId: string, o: { newTask: boolean; newContext: boolean; bytes: number; holds: boolean }) {
    if (o.newTask) {
      const open = this.store.one(`SELECT COUNT(*) n FROM a2a_tasks WHERE agent_id=? AND caller=? AND state IN ${OPEN_STATES}`, agentId, caller).n as number;
      if (open >= L.openTasksPerAgent)
        throw exhausted(msg("server-a2a.tooManyOpenTasks", { n: open }), 30);
    }
    if (o.newContext) {
      const live = this.store.one("SELECT COUNT(*) n FROM a2a_contexts WHERE caller=?", caller).n as number;
      if (live >= L.contextsPerCaller)
        throw exhausted(msg("server-a2a.tooManyContexts", { n: live }), 3600);
    }
    const stored = (this.store.one(
      "SELECT COALESCE(SUM(LENGTH(m.data)),0) n FROM a2a_messages m JOIN a2a_contexts c ON c.id=m.context_id WHERE c.caller=?",
      caller,
    ).n as number) + [...this.pending.values()].filter((x) => x.caller === caller).reduce((n, x) => n + x.data.length, 0);
    if (stored + o.bytes > L.storedBytesPerCaller)
      throw exhausted(msg("server-a2a.tooMuchStored"), 3600);
    if (o.holds && (this.held.get(caller)?.size ?? 0) >= L.heldPerCaller) throw tooManyHeld();
  }

  // ── views ───────────────────────────────────────────────────────────────
  private view(t: any, historyLength: number | undefined, withArtifacts: boolean): A2ATask {
    const out: A2ATask = {
      id: t.id,
      contextId: t.context_id,
      status: {
        state: t.state,
        timestamp: new Date(t.updated).toISOString(),
        ...(t.status_message ? { message: JSON.parse(t.status_message) } : {}),
      },
    };
    if (withArtifacts) {
      const a = JSON.parse(t.artifacts || "[]");
      if (a.length) out.artifacts = a;
    }
    if (historyLength !== 0) {
      const n = Math.min(historyLength ?? L.historyDefault, L.historyMax);
      const rows = this.store.all(
        "SELECT data FROM (SELECT seq,data FROM a2a_messages WHERE task_id=? ORDER BY seq DESC LIMIT ?) ORDER BY seq",
        t.id,
        n,
      );
      out.history = rows.map((r) => JSON.parse(r.data));
    }
    if (t.metadata) out.metadata = JSON.parse(t.metadata);
    return out;
  }

  private prior(t: any): A2APriorTask {
    const asked = this.store
      .all("SELECT data FROM a2a_messages WHERE task_id=? AND role='ROLE_USER' ORDER BY seq", t.id)
      .map((r) => textOf(JSON.parse(r.data).parts ?? []))
      .join("\n\n");
    const a = JSON.parse(t.artifacts || "[]").find((x: any) => x.artifactId === "answer");
    return {
      taskId: t.id,
      state: t.state,
      request: asked,
      answer: a ? textOf(a.parts ?? []) : null,
    };
  }

  private jobOf(agent: AgentInfo, taskId: string, signal: AbortSignal): A2AJob {
    const t = this.row(taskId);
    const msgs = this.store.all("SELECT role,data FROM a2a_messages WHERE task_id=? ORDER BY seq", taskId).map((r) => ({
      role: r.role as string,
      m: JSON.parse(r.data) as A2AMessageOut,
    }));
    const last = [...msgs].reverse().find((x) => x.role === "ROLE_USER")!.m;
    const history = this.store
      .all(
        "SELECT * FROM (SELECT * FROM a2a_tasks WHERE context_id=? AND id<>? AND created<=? ORDER BY created DESC LIMIT 100) ORDER BY created",
        t.context_id,
        taskId,
        t.created,
      )
      .map((x) => this.prior(x));
    const references = (last.referenceTaskIds ?? [])
      .map((id) => this.ownTask(t.agent_id, t.caller, id))
      .filter(Boolean)
      .map((x: any) => this.prior(x));
    const known = this.runs.get(taskId)?.person;
    const person = known
      ? { contactId: known.contactId, subject: known.subject, name: known.name }
      : this.personOfKey(t.caller);
    return {
      agent,
      taskId,
      contextId: t.context_id,
      caller: { key: t.caller, ...person, actor: t.actor ?? null },
      mode: t.mode === "act" ? "act" : "ask",
      via: (["whitelist", "listed", "grant", "once"] as const).find((v) => v === t.via) ?? null,
      text: textOf(last.parts),
      files: filesOf(last.parts),
      continuing: msgs.filter((x) => x.role === "ROLE_USER").length > 1,
      thread: msgs.map((x) => ({ role: x.role === "ROLE_AGENT" ? "agent" : "user", text: textOf(x.m.parts) })),
      history,
      references,
      trace: { traceId: t.trace_id, depth: t.depth },
      signal,
      queued: () => void this.setState(taskId, "TASK_STATE_SUBMITTED", {}),
      working: () => void this.setState(taskId, "TASK_STATE_WORKING", {}),
    };
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * check()'s refusals → the task's reason; what the caller is told is
 * `server-a2a.refusal.<reason>` (a2a-usage.md §9.2).
 */
const REFUSAL: Record<string, TaskReason> = {
  rejected_recently: "OWNER_REJECTED",
  too_many_waiting: "QUOTA_EXCEEDED",
  too_many_requests: "QUOTA_EXCEEDED",
  not_recognised: "AGENT_UNAVAILABLE",
  agent_unknown: "AGENT_UNAVAILABLE",
  not_listed: "AGENT_UNAVAILABLE",
};

/**
 * P6-23b: what is written into a task (its status message, an artifact's
 * name) — stored, so said once, in the owner's language. A refusal
 * thrown at a request is a `msg` instead (said in the caller's).
 */
const say = (key: string, params?: Record<string, unknown>) => ownerT().dynamic(`server-a2a.${key}`, params);

const exhausted = (message: A2AText, retryAfterS: number) => new A2AError("RESOURCE_EXHAUSTED", message, retryAfterS ? { retryAfterS } : {});
const tooManyHeld = () =>
  new A2AError("UNAVAILABLE", msg("server-a2a.tooManyHeld", { max: L.heldPerCaller }), { retryAfterS: 5 });

/**
 * Review M-1: what is stored of a message before its call has begun —
 * its text (clipped), the files' names and sizes, no bytes, no metadata.
 */
function stubOf(m: A2AMessageOut): A2AMessageOut {
  let room = L.stubTextMax;
  const parts: A2APart[] = [];
  for (const p of m.parts) {
    if (p.raw !== undefined) {
      parts.push({ text: say("fileStub", { name: clip(p.filename || "attachment", 100), bytes: Math.floor((p.raw.length * 3) / 4) }) });
      continue;
    }
    if (room <= 0) continue;
    const t = p.text !== undefined ? p.text : JSON.stringify(p.data);
    parts.push({ text: t.length > room ? t.slice(0, room) + "…" : t });
    room -= t.length;
  }
  const { metadata: _m, ...rest } = m;
  return { ...rest, parts };
}

const notFound = () => new A2AError("NOT_FOUND", msg("server-a2a.notFound"));
const taskNotFound = () => new A2AError("TASK_NOT_FOUND", msg("server-a2a.taskNotFound"));
const unavailable = () => new A2AError("UNAVAILABLE", msg("server-a2a.closing"), { retryAfterS: 5 });

const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The message as stored and shown in `history` (what the caller sent, nothing else). */
function outMessage(m: A2AMessageIn): Omit<A2AMessageOut, "contextId" | "taskId"> {
  return {
    messageId: m.messageId,
    role: "ROLE_USER",
    parts: m.parts,
    ...(m.metadata ? { metadata: m.metadata } : {}),
    ...(m.extensions?.length ? { extensions: m.extensions } : {}),
    ...(m.referenceTaskIds?.length ? { referenceTaskIds: m.referenceTaskIds } : {}),
  };
}

/** a2a-usage.md §7 "同样的内容": parts, contextId, taskId, referenceTaskIds, metadata — canonical JSON. */
export function digestOf(m: A2AMessageIn): string {
  return createHash("sha256")
    .update(
      canonical({
        parts: m.parts,
        contextId: m.contextId ?? null,
        taskId: m.taskId ?? null,
        referenceTaskIds: m.referenceTaskIds ?? [],
        metadata: m.metadata ?? null,
      }),
    )
    .digest("hex");
}
function canonical(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

/** text parts, and data parts as JSON, in order. */
export function textOf(parts: readonly A2APart[]): string {
  return parts
    .filter((p) => p.text !== undefined || p.data !== undefined)
    .map((p) => (p.text !== undefined ? p.text : JSON.stringify(p.data)))
    .join("\n");
}
function filesOf(parts: readonly A2APart[]): A2AFile[] {
  return parts
    .filter((p) => p.raw !== undefined)
    .map((p) => ({
      filename: p.filename || "attachment",
      mediaType: p.mediaType || "application/octet-stream",
      bytes: Buffer.from(p.raw!, "base64"),
    }));
}

/** a2a-usage.md §8.1: "act" only with both the header and `{"mode":"act"}`. */
function actMode(m: A2AMessageIn, extensions: readonly string[]): "ask" | "act" {
  if (!extensions.includes(A2A_EXT.act)) return "ask";
  const v = m.metadata?.[A2A_EXT.act] as { mode?: unknown } | undefined;
  return v && typeof v === "object" && v.mode === "act" ? "act" : "ask";
}

/**
 * trace.md §5 "次数怎么数": the calls on `traceId` this Daisy has seen —
 * tasks it received (from `caller` only, when given: P4-04 review L-8)
 * and calls its own AIs sent (P4-08) — against one limit of 64.
 */
export function traceCalls(store: Store, traceId: string, caller?: string): number {
  const received = Number(
    (caller
      ? store.one("SELECT COUNT(*) n FROM a2a_tasks WHERE trace_id=? AND caller=?", traceId, caller)
      : store.one("SELECT COUNT(*) n FROM a2a_tasks WHERE trace_id=?", traceId)
    )?.n ?? 0,
  );
  const sent = Number(store.one("SELECT COUNT(*) n FROM a2a_calls WHERE trace_id=?", traceId)?.n ?? 0);
  return received + sent;
}

/** trace.md §3 / §4: the caller's trace and depth (metadata first), else the request's trace at depth 1. */
function traceOf(m: A2AMessageIn, requestTrace?: string): { traceId: string; depth: number } {
  const v = m.metadata?.[A2A_EXT.trace] as { traceparent?: unknown; depth?: unknown } | undefined;
  const tp = v && typeof v === "object" ? parseTraceparent(v.traceparent) : null;
  const depth = v && typeof v === "object" && Number.isInteger(v.depth) && (v.depth as number) >= 1 ? Math.min(v.depth as number, 1_000_000) : 1;
  return {
    traceId: tp?.traceId ?? (isTraceId(requestTrace) ? requestTrace : newTraceId()),
    depth,
  };
}

function cursorOf(token: string): { created: number; id: string } | null {
  try {
    const s = Buffer.from(token, "base64url").toString("utf8");
    const i = s.indexOf("|");
    const created = Number(s.slice(0, i));
    if (i < 1 || !Number.isFinite(created)) return null;
    return { created, id: s.slice(i + 1) };
  } catch {
    return null;
  }
}

/** The person behind a caller key (for the executor; display only). */
function personOfCaller(key: string): { contactId: string | null; subject: string; name: string } {
  if (key === SELF_PERSON) return { contactId: null, subject: SELF_PERSON, name: say("selfToken") };
  if (key.startsWith("contact:")) {
    const id = key.slice("contact:".length);
    return { contactId: id, subject: id, name: id.slice(0, 12) };
  }
  const subject = key.slice(key.indexOf("|") + 1);
  return { contactId: null, subject, name: subject };
}

/** a2a-usage.md §14: the agent card. */
export function agentCard(
  agent: AgentInfo,
  base: string,
  version: string,
  /** P4-05: the act extension's `params` (the executor's `describe`). */
  ext: { act: boolean; readOnly: "strong" | "weak" | "none" } | null = null,
  /** P6-23b: the caller's language (`callerT`), else the owner's. */
  t: Translate = ownerT(),
): Record<string, unknown> {
  return {
    name: agent.name,
    description: t("server-a2a.card.description", {
      name: agent.name,
      kind: t(agent.kind === "resident" ? "server-a2a.card.kind.resident" : "server-a2a.card.kind.public"),
      // P4-07: a resident does not tell 问 from 办 (5.8) — the mark is ignored.
      how: t(
        agent.kind === "resident"
          ? "server-a2a.card.how.resident"
          : ext?.readOnly === "none"
            ? "server-a2a.card.how.actOnly"
            : "server-a2a.card.how.default",
      ),
      // a2a-usage.md §13 (D-28): a weak read-only says so.
      weak: ext?.readOnly === "weak" ? weakReadOnlyNote(t) : "",
    }),
    version,
    supportedInterfaces: [
      { url: `${base}/jsonrpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url: base, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [
        {
          uri: A2A_EXT.act,
          required: false,
          description: t("server-a2a.card.ext.act"),
          ...(ext ? { params: { act: ext.act, readOnly: ext.readOnly } } : {}),
        },
        {
          uri: A2A_EXT.trace,
          required: false,
          description: t("server-a2a.card.ext.trace"),
          params: { maxDepth: L.traceMaxDepth },
        },
      ],
    },
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          bearerFormat: "JWT",
          description: t("server-a2a.card.bearer"),
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["text/plain", "application/json", "application/octet-stream"],
    defaultOutputModes: ["text/plain", "application/octet-stream"],
    skills: [
      {
        id: "general",
        name: t("server-a2a.card.skill.name"),
        description: t("server-a2a.card.skill.description"),
        tags: ["question", "task"],
      },
    ],
  };
}
