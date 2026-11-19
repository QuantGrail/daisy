/**
 * P1-11 (trace.md §3, S-4): the in-process Runner's calls (app/
 * runner-port.ts), traced and — for the harness's own tools — audited.
 *
 * - `/jobs/:id/…` (a turn's events, approvals, completion …): Daisy acting
 *   for that turn, under the turn's trace (jobs.trace).
 * - The harness tools' calls (`/sessions/:sid/schedules…`: wakeup, cron,
 *   bash, monitor, schedules, cancel): the AI of that session acting in its
 *   turn — the turn named by `jobId`, or the session's running turn —
 *   under that turn's trace. Each gets an audit row `tool.<name>`.
 *   P4-08: the A2A client tools (`/sessions/:sid/a2a/…`: agents,
 *   call_agent, call_result) the same way; the context carries the turn's
 *   depth (jobs.depth).
 * - Anything else (a background command's result, a sync, a login): a new
 *   system trace (trace.md §3: a timer or a background result starts one).
 */
import type { Store } from "../store/index.ts";
import type { RunnerCallObserver, RunnerRequest } from "../app/runner-port.ts";
import { isTraceId, newSpanId, newTraceId, type TraceContext } from "./trace.ts";
import { externalTurn } from "../a2a/tool-audit.ts";

const TOOL_CALLS: Record<string, (req: RunnerRequest) => string> = {
  "/sessions/:sid/schedules": (req) => {
    const k = String(req.body?.kind ?? "");
    return ["wakeup", "cron", "bash", "monitor"].includes(k) ? k : "schedule";
  },
  "/sessions/:sid/schedules/list": () => "schedules",
  "/sessions/:sid/schedules/:id/cancel": () => "cancel",
  // P4-08 (ADR-127): the A2A client tools.
  "/sessions/:sid/a2a/agents": () => "agents",
  "/sessions/:sid/a2a/call": () => "call_agent",
  "/sessions/:sid/a2a/result": () => "call_result",
};

export function runnerTrace(store: Store): RunnerCallObserver {
  const turn = (jobId: unknown): { id: string; session_id: string; trace: string | null; depth: number } | undefined =>
    typeof jobId === "string" && jobId.length <= 200
      ? store.one("SELECT id,session_id,trace,depth FROM jobs WHERE id=?", jobId)
      : undefined;
  const runningTurn = (sid: string) =>
    store.one(
      "SELECT id,session_id,trace,depth FROM jobs WHERE session_id=? AND status='running' ORDER BY created DESC LIMIT 1",
      sid,
    );
  const traceOf = (j?: { trace: string | null }) =>
    j && isTraceId(j.trace) ? j.trace : newTraceId();
  return {
    context(pattern, req): TraceContext | undefined {
      if (pattern.startsWith("/jobs/:id/")) {
        const j = turn(req.params.id);
        if (!j) return undefined;
        return {
          traceId: traceOf(j),
          spanId: newSpanId(),
          depth: Number(j.depth) || 0,
          actor: "system",
          face: "internal",
          channel: "system",
          sessionId: j.session_id,
          jobId: j.id,
          route: `runner:${pattern}`,
        };
      }
      const tool = TOOL_CALLS[pattern];
      if (!tool) return undefined;
      const sid = String(req.params.sid ?? "");
      const named = turn(req.body?.jobId);
      const j = named && named.session_id === sid ? named : runningTurn(sid);
      return {
        traceId: traceOf(j),
        spanId: newSpanId(),
        depth: Number(j?.depth) || 0,
        actor: "ai",
        face: "internal",
        channel: "ai",
        sessionId: sid,
        ...(j ? { jobId: j.id } : {}),
        route: `tool.${tool(req)}`,
      };
    },
    done(pattern, req, ctx, r) {
      const tool = TOOL_CALLS[pattern];
      if (!tool) return;
      const out = r.out as { schedule?: { id?: unknown }; call?: { id?: unknown } } | null | undefined;
      const object =
        typeof out?.schedule?.id === "string"
          ? out.schedule.id
          : typeof out?.call?.id === "string"
            ? `a2a-call:${out.call.id}`
            : String(req.params.id ?? "");
      const ok = r.status < 400;
      // P4-06 (A-9): a turn an external task started names that task.
      const ext = externalTurn(store, ctx.jobId);
      const target = ext ? JSON.stringify({ object, task: ext.taskId, agent: ext.agentId }) : object;
      store.audit(`ai:${ctx.sessionId}`, ctx.route!, target, {
        object,
        outcome: ok ? "ok" : r.status === 401 || r.status === 403 ? "denied" : "error",
        ...(ok ? {} : { reason: String((r.error as any)?.code ?? `http_${r.status}`) }),
        status: r.status,
      });
    },
  };
}
