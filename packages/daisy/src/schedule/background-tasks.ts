/**
 * the session's background tasks in one 「后台」 list, each with its
 * own 「停止」. The list is what is already there — the Agent's own tasks
 * (`live.pending`, reported by the Runner: Claude Code's
 * `background_tasks_changed`, Codex's `backgroundTerminals/list`) and
 * Daisy's (`session.schedulerPending`) — labelled by source. What
 * this adds is the stop:
 *
 * - Daisy's scheduler item (`scheduler:<scheduleId>`; ADR-152: the old
 *   `harbor:<scheduleId>` a client may still hold is taken too): the
 *   scheduler cancels it (as 「取消」 in the resident's schedule panel).
 * - The Agent's own task: only where the node says the agent can
 *   (`agentFeatures[agent].background.stop: native`) and the Runner marked
 *   the task `stoppable`. The request waits in `live_task_stops` and goes
 *   to the Runner with the answer to its next live report (`stopTasks`),
 *   once; the item shows `stopping` until it is gone from the report, at
 *   most `STOP_WAIT_MS`.
 *
 * Owner only, like Daisy's own 「取消」.
 */
import { sessionT as promptSessionT } from "../../../contracts/src/prompt-i18n.ts";
import type { Store } from "../store/index.ts";
import { serve } from "../app/serve.ts";
import { LocalizedError } from "../app/errors.ts";
import type { MessageKey } from "../../../contracts/src/i18n.ts";
import { ownerT } from "../platform/language.ts";
import { api } from "../../../contracts/src/api/index.ts";
import type {
  LiveTimer,
  Session,
} from "../../../contracts/src/index.ts";
import { reviewRoute } from "../../../contracts/src/agent-capabilities.ts";
import {
  SCHEDULER_SOURCE,
  schedulerItemId,
  schedulerPendingOf,
} from "../../../contracts/src/live.ts";

export const STOP_WAIT_MS = 60_000;
const fail = (statusCode: number, code: string, key: MessageKey): never => {
  throw new LocalizedError(statusCode, code, key);
};
function stopsNatively(store: Store, nodeId: string, agent: string) {
  try {
    const caps = JSON.parse(
      store.one("SELECT capabilities FROM nodes WHERE id=?", nodeId)
        ?.capabilities || "{}",
    );
    return !!reviewRoute(caps, agent)?.stopTask;
  } catch {
    return false;
  }
}

/**
 * The Runner's pending list as the person sees it: `stoppable` only where
 * the node's agent can stop it, `stopping` while a stop is on its way.
 * Stops whose task is gone (or that waited too long) are forgotten.
 */
export function decoratePending(
  store: Store,
  s: Pick<Session, "id" | "agent">,
  nodeId: string,
  pending: LiveTimer[],
  now = Date.now(),
): LiveTimer[] {
  const ids = new Set(pending.map((p) => p.id));
  const asked = new Set<string>();
  for (const r of store.all(
    "SELECT task_id,requested FROM live_task_stops WHERE session_id=?",
    s.id,
  ))
    if (!ids.has(r.task_id) || r.requested < now - STOP_WAIT_MS)
      store.run(
        "DELETE FROM live_task_stops WHERE session_id=? AND task_id=?",
        s.id,
        r.task_id,
      );
    else asked.add(r.task_id);
  const can = stopsNatively(store, nodeId, s.agent);
  return pending.map((p) => {
    const { stoppable, stopping, ...rest } = p;
    return {
      ...rest,
      ...(can && stoppable && p.kind === "task" ? { stoppable: true } : {}),
      ...(asked.has(p.id) ? { stopping: true } : {}),
    };
  });
}

/** Stops for node `nodeId`'s Runner, each handed over once. */
export function takeStops(store: Store, nodeId: string, now = Date.now()) {
  store.run(
    "DELETE FROM live_task_stops WHERE requested<?",
    now - STOP_WAIT_MS,
  );
  const rows = store.all(
    "SELECT session_id,task_id FROM live_task_stops WHERE node_id=? AND sent=0",
    nodeId,
  );
  for (const r of rows)
    store.run(
      "UPDATE live_task_stops SET sent=1 WHERE session_id=? AND task_id=?",
      r.session_id,
      r.task_id,
    );
  return rows.map((r: any) => ({ sessionId: r.session_id, id: r.task_id }));
}

export function backgroundRoutes(
  app: any,
  store: Store,
  deps: {
    session: (req: any, sid: string) => Session;
    user: (req: any) => { id: string };
    /** Daisy's scheduler: cancel one of its items. */
    cancel: (sid: string, scheduleId: string, reason: string) => unknown;
    publish: (sid: string, type: any, data: any) => any;
  },
) {
  serve(app, api.sessionTools.backgroundStop, async (req: any) => {
    const s = deps.session(req, req.params.id);
    if (s.ownerId !== deps.user(req).id)
      fail(403, "background_owner_only", "server-schedule.error.ownerOnly");
    const tid = String(req.params.tid || "");
    const scid = schedulerItemId(tid);
    if (scid !== null) {
      if (!schedulerPendingOf(s).some((p) => schedulerItemId(p.id) === scid))
        fail(404, "background_task_not_found", "server-schedule.error.taskGone");
      // The end reason reaches the AI in tool results: the session's language (P6-24).
      deps.cancel(s.id, scid, promptSessionT(s)("server-schedule.stoppedByOwner"));
      store.audit(
        deps.user(req).id,
        "live.task.stop.scheduler",
        `${s.id}:${tid}`,
      );
      return { ok: true, stopped: true, source: SCHEDULER_SOURCE };
    }
    const live = s.live;
    const item = live?.online
      ? (live.pending || []).find((p) => p.id === tid)
      : undefined;
    if (!item) fail(404, "background_task_not_found", "server-schedule.error.taskGoneOrOffline");
    if (!item!.stoppable)
      fail(
        409,
        "not_stoppable",
        item!.kind === "task" ? "server-schedule.error.taskNotStoppable" : "server-schedule.error.timerNotStoppable",
      );
    const row = store.one(
      "SELECT node_id FROM live_sessions WHERE session_id=?",
      s.id,
    );
    if (!row) fail(409, "offline", "server-schedule.error.offline");
    store.run(
      `INSERT INTO live_task_stops(session_id,task_id,node_id,requested,user_id,sent) VALUES(?,?,?,?,?,0)
         ON CONFLICT(session_id,task_id) DO UPDATE SET requested=excluded.requested,sent=0,user_id=excluded.user_id`,
      s.id,
      tid,
      row.node_id,
      Date.now(),
      deps.user(req).id,
    );
    store.audit(deps.user(req).id, "live.task.stop", `${s.id}:${tid}`);
    const data = {
      ...live!,
      pending: (live!.pending || []).map((p) =>
        p.id === tid ? { ...p, stopping: true } : p,
      ),
      at: Date.now(),
    };
    store.run(
      "UPDATE live_sessions SET data=? WHERE session_id=?",
      JSON.stringify(data),
      s.id,
    );
    deps.publish(s.id, "live", data);
    return { ok: true, stopping: true, source: "agent" };
  });
}
