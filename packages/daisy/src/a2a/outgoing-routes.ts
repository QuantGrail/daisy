/**
 * P4-12 (ADR-132; P4-08 left it, ADR-127 「没有给主人看的“我的 AI 调用过谁”」):
 * the owner's read-only view of the tasks their AIs asked of other
 * Daisies' agents — `a2a_calls` (outgoing.ts), newest first. Reading a
 * conversation's record is `daisy:session:read` (5.11); the AI has its own
 * `call_result` and does not reach these routes.
 */
import { ownerT } from "../platform/language.ts";
import type { FastifyInstance } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import type { OutgoingCall } from "../../../contracts/src/api/outgoing.ts";
import { serve } from "../app/serve.ts";
import { LocalizedError } from "../app/errors.ts";
import type { Store } from "../store/index.ts";
import { stateLabel } from "./outgoing.ts";

const SETTLED = `('error','TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED')`;
const LIST_ANSWER_MAX = 2000;
const TEXT_MAX = 4000;

const cut = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s);

/** The text of the message my AI sent (its parts as P4-08 stored them). */
function sentText(message: string): string {
  try {
    const m = JSON.parse(message)?.message;
    const parts: any[] = Array.isArray(m?.parts) ? m.parts : [];
    return parts
      .map((p) => (typeof p?.text === "string" ? p.text : typeof p?.content?.value === "string" ? p.content.value : ""))
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

function filesOf(v: string | null): string[] {
  if (!v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.map((f) => (typeof f === "string" ? f : String(f?.name ?? f?.filename ?? ""))).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function outgoingView(r: any, title: string, answerMax: number | null): OutgoingCall {
  const answer = typeof r.answer === "string" ? (answerMax ? cut(r.answer, answerMax) : r.answer) : null;
  return {
    id: r.id,
    session: { id: r.session_id, title },
    contact: { id: r.contact_id, name: r.contact_name },
    agent: { id: r.agent_id, name: r.agent_name },
    mode: r.mode === "act" ? "act" : "ask",
    text: cut(sentText(r.message), TEXT_MAX),
    state: r.state,
    stateLabel: stateLabel(r.state),
    reason: r.reason ?? null,
    statusText: r.status_text ?? null,
    answer,
    files: filesOf(r.files),
    contextId: r.context_id ?? null,
    taskId: r.task_id ?? null,
    traceId: r.trace_id,
    depth: Number(r.depth),
    created: Number(r.created),
    updated: Number(r.updated),
    failures: Number(r.failures ?? 0),
    nextAt: r.next_at ?? null,
  };
}

export function registerOutgoingRoutes(app: FastifyInstance, store: Store): void {
  const O = api.outgoing;
  const titleOf = (sid: string) => {
    const s = store.session(sid);
    return s ? s.title || sid : ownerT()("server-a2a.calls.sessionDeleted");
  };
  serve(app, O.outgoingList, async (req: any) => {
    const q = O.outgoingList.query.parse(req.query ?? {});
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.session) (where.push("session_id=?"), args.push(q.session));
    if (q.contact) (where.push("contact_id=?"), args.push(q.contact));
    // Open: not ended (an input-required one waits for my AI's answer).
    if (q.state === "open") where.push(`state NOT IN ${SETTLED}`);
    if (q.state === "settled") where.push(`state IN ${SETTLED}`);
    const rows = store.all(
      `SELECT * FROM a2a_calls${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created DESC, id DESC LIMIT ?`,
      ...args,
      q.limit,
    );
    return { calls: rows.map((r) => outgoingView(r, titleOf(r.session_id), LIST_ANSWER_MAX)) };
  });
  serve(app, O.outgoingShow, async (req: any) => {
    const r = store.one("SELECT * FROM a2a_calls WHERE id=?", String(req.params.cid));
    if (!r) throw new LocalizedError(404, "call_not_found", "server-a2a.calls.notFound");
    return outgoingView(r, titleOf(r.session_id), null);
  });
}
