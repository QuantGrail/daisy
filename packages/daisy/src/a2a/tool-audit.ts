/**
 * P4-06 (总纲 5.2 「外来任务标明来源」, A-9, ADR-125): every tool action of
 * a turn an external task started is audited with the task that caused it.
 *
 * P4-05 records each such turn in `a2a_turns` (job → task). Here:
 *
 *   - the harness's own tool actions (Claude Code's Bash / Edit / Read …,
 *     Codex's commands and patches, an ACP tool call; a sub-agent; a call
 *     the harness refused by itself) — one audit row `a2a.tool` the first
 *     time the Runner reports the item (runner-api.ts `/jobs/:id/events`);
 *   - Daisy's own tools (wakeup, cron, call_agent …) keep their row
 *     `tool.<name>` (observe/runner-trace.ts), with the task added.
 *
 * Each row: `object` `task:<taskId>` (the same key the task's own rows
 * use), the turn (`job_id`), the session, the task's trace and depth, the
 * route `tool.<name>`; `target` names the task, the agent, the tool and
 * the item. Nothing is blocked (5.2: 这不拦任何操作). The tool's input is
 * not copied (it may hold anything; the transcript has it).
 */
import type { Store } from "../store/index.ts";

export interface ExternalTurn {
  taskId: string;
  agentId: string;
  kind: string;
  traceId: string | null;
  depth: number;
}

/** The external task behind turn `jobId` (undefined: the owner's own, a timer …). */
export function externalTurn(store: Store, jobId: unknown): ExternalTurn | undefined {
  if (typeof jobId !== "string" || !jobId || jobId.length > 200) return undefined;
  const r = store.one(
    "SELECT t.task_id,t.agent_id,t.kind,k.trace_id,k.depth FROM a2a_turns t LEFT JOIN a2a_tasks k ON k.id=t.task_id WHERE t.job_id=?",
    jobId,
  );
  return r
    ? { taskId: r.task_id, agentId: r.agent_id, kind: r.kind, traceId: r.trace_id ?? null, depth: Number(r.depth) || 0 }
    : undefined;
}

/** Item categories that are a tool action (not lifecycle, usage, hooks, plans …). */
const ACTION = new Set<string | undefined>([undefined, "subagent", "interception"]);

/**
 * A tool item the Runner reported for the first time in session `sid`:
 * if its turn came from an external task, audit it. The turn is the job
 * the item id starts with (`<job>:…`; an online process may report items
 * of an earlier turn of the same session).
 */
export function auditExternalTool(store: Store, sid: string, item: any): void {
  if (!item || item.kind !== "tool" || !ACTION.has(item.category) || typeof item.id !== "string") return;
  const at = item.id.indexOf(":");
  if (at <= 0) return;
  const jobId = item.id.slice(0, at);
  const job = store.one("SELECT id,session_id FROM jobs WHERE id=?", jobId);
  if (!job || job.session_id !== sid) return;
  const ext = externalTurn(store, jobId);
  if (!ext) return;
  const tool = String(item.name || "tool").replace(/[\r\n\t]+/g, " ").slice(0, 80);
  store.audit(
    `ai:${sid}`,
    "a2a.tool",
    JSON.stringify({ task: ext.taskId, agent: ext.agentId, turn: ext.kind, tool, item: item.id.slice(0, 200), ...(item.category ? { category: item.category } : {}) }),
    {
      object: `task:${ext.taskId}`,
      actor: "ai",
      channel: "ai",
      face: "internal",
      sessionId: sid,
      jobId,
      ...(ext.traceId ? { traceId: ext.traceId } : {}),
      depth: ext.depth,
      route: `tool.${tool}`,
      outcome: item.category === "interception" ? "denied" : item.status === "error" ? "error" : "ok",
    },
  );
}
