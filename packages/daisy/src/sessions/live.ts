import { z } from "zod";
import type {
  LiveActivity,
  LiveState,
} from "../../../contracts/src/index.ts";
import { id, type Store } from "../store/index.ts";
import type { RunnerPort } from "../app/runner-port.ts";
import { serve } from "../app/serve.ts";
import { api } from "../../../contracts/src/api/index.ts";
import { autoCompactSupport } from "../../../contracts/src/context-usage.ts";
import { residentHeld } from "../../../contracts/src/scheduler.ts";
import { sessionAutoCompact } from "./auto-compact.ts";
import { decoratePending, takeStops } from "../schedule/background-tasks.ts";
import { traceForNewTurn } from "../observe/trace.ts";
import { HttpError, LocalizedError } from "../app/errors.ts";
import type { MessageKey } from "../../../contracts/src/i18n.ts";
import { ownerT } from "../platform/language.ts";
const fail = (statusCode: number, key: MessageKey, code: string): never => {
  throw new LocalizedError(statusCode, code, key);
};
/** A node silent this long has lost its processes as far as users can tell. */
const NODE_STALE_MS = 45_000;
const Timer = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["wakeup", "cron", "task"]),
  label: z.string().max(500),
  at: z.number().int().nonnegative().optional(),
  recurring: z.boolean().optional(),
  type: z.string().max(60).optional(),
  command: z.string().max(2000).optional(),
  subagent: z.string().max(100).optional(),
  prompt: z.string().max(600).optional(),
  since: z.number().int().nonnegative().optional(),
  /** the adapter can stop it alone (newer Runners). */
  stoppable: z.boolean().optional(),
});
const Activity = z.object({
  id: z.string().min(1).max(200),
  summary: z.string().max(500).optional(),
  lastTool: z.string().max(100).optional(),
  tokens: z.number().int().nonnegative().optional(),
  toolUses: z.number().int().nonnegative().optional(),
  output: z.string().max(4000).optional(),
  outputBytes: z.number().int().nonnegative().optional(),
});
const Report = z.object({
  sessions: z
    .array(
      z.object({
        sessionId: z.string().min(1).max(100),
        since: z.number().int().nonnegative(),
        lastActivity: z.number().int().nonnegative(),
        busy: z.boolean(),
        pending: z.array(Timer).max(100).default([]),
        activity: z.array(Activity).max(100).default([]),
        /** the identity the process was started with (newer Runners). */
        profileId: z.string().min(1).max(100).optional(),
        /** the threshold the process runs with (newer Runners). */
        autoCompact: z
          .object({
            tokens: z.number().int().positive().max(1e9).nullable(),
            want: z.number().int().positive().max(1e9).nullable().optional(),
            restarting: z.boolean().optional(),
          })
          .optional(),
      }),
    )
    .max(1000),
  /** Sessions this runner closed since its last report, and why. */
  closed: z
    .array(
      z.object({
        sessionId: z.string().min(1).max(100),
        reason: z.string().max(300),
      }),
    )
    .max(1000)
    .default([]),
});
/**
 * Online sessions: a session is online while its node's runner
 * keeps a real Agent process for it (Claude Code / Codex app-server / Kimi
 * ACP) between turns, so the Agent's own timers, background tasks and
 * Monitor keep working and can start turns by themselves. The runner owns
 * the processes and reports them; this module mirrors that into
 * `session.live` (a `live` event, so every view updates), lets the user take
 * a session offline, and turns an Agent-started turn into a job (`wake`).
 */
export function liveRoutes(
  app: any,
  /** P1-02: the in-process Runner's calls (were /api/runner/*). */
  runner: RunnerPort,
  store: Store,
  session: (r: any, sid: string) => any,
  claimingNode: (r: any) => any,
  publish: (sid: string, type: any, data: any, eventId?: string) => any,
  /** Lease a queued job / build the RunnerJob payload, as /runner/claim does. */
  payload: (job: any) => any,
  validateJob: (job: any) => boolean = () => true,
  /** a resident over its daily budget may not start turns itself. */
  overBudget: (s: any) => boolean = () => false,
  /**
   * this queued job launches with the same permission / sandbox
   * mode as a turn the process starts by itself (else it waits for
   * /runner/claim, which restarts the process).
   */
  sameLaunch: (s: any, job: any) => boolean = () => true,
  /**
   * an item of job `job` reported between turns (`fresh`: not
   * seen before) — interception cards and native-approval acks.
   */
  onItem: (job: any, data: any, fresh: boolean) => void = () => {},
  /**
   * D-36: why no AI turn may start now (no PIN set), or null. An online
   * process that starts a turn by itself is refused (403: the Runner ends
   * the process with this reason).
   */
  turnsBlocked: () => string | null = () => null,
) {
  const publishEvent = publish;
  // 立即重启 for a new auto-compact threshold: `live_restarts`,
  // one row per online session its owner asked to restart now; gone once
  // the Runner reports the new value, the session goes offline, or after
  // 10 minutes.
  const takes = (n: any, agent: any) =>
    autoCompactSupport(JSON.parse(n.capabilities || "{}"), agent).configurable;
  /**
   * The threshold this session's process should run with (null = CLI
   * default): a resident's own, else its identity's; undefined =
   * no identity.
   */
  const wanted = (s: any): number | null | undefined => {
    const r = store.one("SELECT data FROM profiles WHERE id=?", s.profileId);
    if (!r) return undefined;
    const n = JSON.parse(r.data).autoCompactTokens;
    return sessionAutoCompact(s, typeof n === "number" && n > 0 ? n : null);
  };
  /**
   * Background task activity per session: changes every few
   * seconds, so it stays in memory (not the event log) and is read on demand.
   */
  const activity = new Map<string, { at: number; items: LiveActivity[] }>();
  const same = (a: any, b: any) => {
    const strip = ({ at: _at, ...rest }: any = {}) => rest;
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  };
  const offline = (sid: string, reason: string) => {
    activity.delete(sid);
    if (!store.session(sid)) return;
    const data: LiveState = { online: false, reason, at: Date.now() };
    publish(sid, "live", data);
  };
  /** Rows of nodes that stopped reporting: their processes are unreachable. */
  const reap = () => {
    for (const r of store.all(
      `SELECT l.session_id FROM live_sessions l LEFT JOIN nodes n ON n.id=l.node_id
       WHERE n.id IS NULL OR COALESCE(n.revoked_at,0)>0 OR l.updated<?`,
      Date.now() - NODE_STALE_MS,
    )) {
      store.run("DELETE FROM live_sessions WHERE session_id=?", r.session_id);
      offline(r.session_id, ownerT()("server-sessions.live.nodeLost"));
    }
  };
  runner.post("/live", async (req: any) => {
    const n = claimingNode(req),
      b = Report.parse(req.body),
      now = Date.now(),
      stop: string[] = [],
      apply: { sessionId: string; tokens: number | null; now: boolean }[] = [],
      seen = new Set<string>(),
      retire: string[] = [];
    store.run(
      "DELETE FROM live_restarts WHERE node_id=? AND requested<?",
      n.id,
      now - 10 * 60_000,
    );
    const reasons = new Map(b.closed.map((c) => [c.sessionId, c.reason]));
    for (const e of b.sessions) {
      const s = store.session(e.sessionId);
      if (
        !s ||
        s.deleting ||
        s.archived ||
        residentHeld(s) ||
        s.nodeId !== n.id
      ) {
        stop.push(e.sessionId);
        continue;
      }
      seen.add(s.id);
      // 「换身份」 — the process runs the old identity; the Runner
      // ends it once idle and the next message starts the new one.
      if (e.profileId && e.profileId !== s.profileId) retire.push(s.id);
      const row = store.one(
        "SELECT * FROM live_sessions WHERE session_id=?",
        s.id,
      );
      if (row?.stop) stop.push(s.id);
      const data: LiveState = {
        online: true,
        ...(e.profileId ? { profileId: e.profileId } : {}),
        since: e.since,
        lastActivity: e.lastActivity,
        busy: e.busy,
        // 「停止」 where the node's agent can, and stops on their way.
        pending: decoratePending(store, s, n.id, e.pending, now),
        ...(row?.stop ? { stopping: true } : {}),
        ...(e.autoCompact ? { autoCompact: e.autoCompact } : {}),
        at: now,
      };
      // the identity's threshold differs from the process's — the
      // Runner restarts it once idle (now, after 立即重启).
      if (e.autoCompact) {
        const want = wanted(s);
        // Only where the node can apply it (a CLI too old for the flag
        // would restart every report and still run without it).
        if (
          want !== undefined &&
          want !== e.autoCompact.tokens &&
          (want === null || takes(n, s.agent))
        )
          apply.push({
            sessionId: s.id,
            tokens: want,
            now: !!store.one(
              "SELECT 1 FROM live_restarts WHERE session_id=?",
              s.id,
            ),
          });
        else store.run("DELETE FROM live_restarts WHERE session_id=?", s.id);
      }
      store.run(
        `INSERT INTO live_sessions(session_id,node_id,data,updated,stop) VALUES(?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET node_id=excluded.node_id,data=excluded.data,updated=excluded.updated`,
        s.id,
        n.id,
        JSON.stringify(data),
        now,
        row?.stop ? 1 : 0,
      );
      if (!same(s.live, data)) publish(s.id, "live", data);
      activity.set(s.id, { at: now, items: e.activity });
    }
    for (const r of store.all(
      "SELECT session_id,stop FROM live_sessions WHERE node_id=?",
      n.id,
    ))
      if (!seen.has(r.session_id)) {
        store.run("DELETE FROM live_sessions WHERE session_id=?", r.session_id);
        store.run("DELETE FROM live_restarts WHERE session_id=?", r.session_id);
        offline(
          r.session_id,
          reasons.get(r.session_id) ||
            ownerT()(r.stop ? "server-sessions.live.stoppedAsAsked" : "server-sessions.live.processGone"),
        );
      }
    // Closed before a report ever listed them (short-lived), or a stale
    // `online` left by an earlier server instance.
    for (const [sid, reason] of reasons) {
      const s = store.session(sid);
      // Only this node's own sessions (review r1 #3).
      if (!seen.has(sid) && s?.nodeId === n.id && s?.live?.online)
        offline(sid, reason);
    }
    // 「停止」 on one background task, handed over once.
    return { stop, apply, retire, stopTasks: takeStops(store, n.id, now) };
  });
  serve(app, api.sessionTools.activity, async (req: any) => {
    const s = session(req, req.params.id);
    const a = s.live?.online ? activity.get(s.id) : undefined;
    return { at: a?.at ?? null, items: a?.items ?? [] };
  });
  /**
   * The Agent started a turn by itself in its online process (timer fired,
   * background task reported back…). The session's queued message, if any,
   * is that turn's job (the runner sends it into the same process);
   * otherwise a new job marked origin='agent' carries the turn.
   */
  runner.post("/live/:sid/wake", async (req: any) => {
    const n = claimingNode(req),
      b = z
        .object({
          reason: z.string().min(1).max(500),
          /** the identity of the process asking (newer Runners). */
          profileId: z.string().min(1).max(100).optional(),
        })
        .parse(req.body);
    const blocked = turnsBlocked();
    if (blocked) throw new HttpError(403, blocked, "pin_not_set");
    const job = store.atomic(() => {
      const s = store.session(req.params.sid);
      if (
        !s ||
        s.deleting ||
        s.archived ||
        residentHeld(s) ||
        s.nodeId !== n.id
      )
        return fail(410, "server-sessions.live.error.gone", "gone");
      if (
        !store.one(
          "SELECT 1 FROM live_sessions WHERE session_id=? AND node_id=?",
          s.id,
          n.id,
        )
      )
        fail(404, "server-sessions.live.error.notLive", "not_live");
      if (
        store.one(
          "SELECT 1 FROM jobs WHERE session_id=? AND status='running'",
          s.id,
        )
      )
        fail(409, "server-sessions.live.error.busy", "busy");
      // the process asking is the old identity's (换身份): it may
      // not start turns for the new one; the Runner ends it. Its own word
      // first — the last report may still describe the process it replaced.
      const running = store.one(
        "SELECT data FROM live_sessions WHERE session_id=?",
        s.id,
      );
      const started =
        b.profileId ??
        (running ? JSON.parse(running.data).profileId : undefined);
      if (started && started !== s.profileId)
        return fail(410, "server-sessions.live.error.identitySwitched", "gone");
      // over its daily budget (the Runner ends the process; the
      // next message from its owner brings it back).
      if (overBudget(s))
        return fail(403, "server-sessions.live.error.budget", "budget");
      const lease = id(),
        until = Date.now() + 30_000;
      const queued = store.one(
        "SELECT * FROM jobs WHERE session_id=? AND status='queued' ORDER BY created LIMIT 1",
        s.id,
      );
      // A queued operation goes through /runner/claim and its rules
      // (review r1 #4); the Agent's turn waits for it.
      if (
        queued &&
        store.one("SELECT 1 FROM job_operations WHERE job_id=?", queued.id)
      )
        fail(409, "server-sessions.live.error.queued", "busy");
      if (queued && (queued.cancel || !validateJob(queued)))
        fail(409, "server-sessions.live.error.collabChanged", "busy");
      if (queued && sameLaunch(s, queued)) {
        store.run(
          "UPDATE jobs SET status='running',lease=?,lease_until=? WHERE id=?",
          lease,
          until,
          queued.id,
        );
        return { ...queued, lease };
      }
      const jid = id(),
        now = Date.now();
      store.run(
        "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,lease,lease_until,origin,wake,trace) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        jid,
        s.id,
        n.id,
        `wake:${jid}`,
        "",
        "[]",
        "running",
        now,
        lease,
        until,
        "agent",
        b.reason,
        traceForNewTurn(),
      );
      store.append(s.id, "item", {
        id: `wake:${jid}`,
        kind: "notice",
        category: "wake",
        text: b.reason,
        status: "complete",
        createdAt: now,
      });
      return store.one("SELECT * FROM jobs WHERE id=?", jid);
    });
    publish(req.params.sid, "status", { status: "running" });
    return { job: payload(job) };
  });
  /**
   * Updates between turns: a background task started in an earlier turn
   * finishing, its progress. Only items of this session's own jobs.
   */
  runner.post("/live/:sid/events", async (req: any) => {
    const n = claimingNode(req),
      s = store.session(req.params.sid);
    if (!s || s.deleting || s.nodeId !== n.id) fail(410, "server-sessions.live.error.gone", "gone");
    const b = z
      .object({
        events: z
          .array(
            z.object({
              id: z.string().max(100),
              type: z.literal("item"),
              data: z
                .object({
                  id: z.string().max(400),
                  kind: z.enum(["assistant", "thinking", "tool", "notice"]),
                  text: z.string().max(300000),
                })
                .passthrough(),
            }),
          )
          .max(100),
      })
      .parse(req.body);
    for (const e of b.events) {
      const jid = e.data.id.split(":")[0];
      if (
        !store.one("SELECT 1 FROM jobs WHERE id=? AND session_id=?", jid, s!.id)
      )
        throw new HttpError(400, "Invalid item scope", "invalid_input");
    }
    for (const e of b.events) {
      const fresh = !store.one("SELECT id FROM events WHERE id=?", e.id);
      publishEvent(s!.id, "item", e.data, e.id);
      onItem(
        store.one("SELECT * FROM jobs WHERE id=?", e.data.id.split(":")[0]),
        e.data,
        fresh,
      );
    }
    return { ok: true };
  });
  /** Ask the runner to close this session's process (at its next report). */
  const stop = (sid: string) => {
    const row = store.one(
      "SELECT * FROM live_sessions WHERE session_id=?",
      sid,
    );
    if (!row) return false;
    store.run("UPDATE live_sessions SET stop=1 WHERE session_id=?", sid);
    if (store.session(sid))
      publish(sid, "live", {
        ...JSON.parse(row.data),
        stopping: true,
        at: Date.now(),
      });
    return true;
  };
  serve(app, api.sessionTools.offline, async (req: any) => {
    const s = session(req, req.params.id);
    return { ok: true, stopping: stop(s.id) };
  });
  return {
    reap,
    stop,
    forget(sid: string) {
      store.run("DELETE FROM live_sessions WHERE session_id=?", sid);
    },
  };
}
