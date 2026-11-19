/**
 * P1-11 (5.11 「查看日志和审计」): GET /api/audit and GET /api/logs
 * (packages/contracts/src/api/audit.ts). The guard lets only the owner in
 * (`daisy:manage`, owner channels); the AI's working credential is refused
 * there, before this runs.
 */
import type { FastifyInstance } from "fastify";
import {
  api,
  type AuditRecord,
} from "../../../contracts/src/api/index.ts";
import { serve } from "../app/serve.ts";
import type { Store } from "../store/index.ts";
import { recentLogs } from "./log.ts";
import { redact } from "./redact.ts";

/** Rows as stored → AuditRecord. */
const recordOf = (r: any): AuditRecord => ({
  id: r.id,
  at: r.created,
  action: r.action,
  actor: r.actor ?? "owner",
  who: r.user_id,
  sessionId: r.session_id ?? null,
  turnId: r.job_id ?? null,
  face: r.face ?? "internal",
  channel: r.channel ?? "none",
  route: r.route ?? null,
  object: r.object ?? null,
  // Rows written before P1-11 never passed through redact: they do now.
  target: redact(String(r.target ?? "")),
  outcome: r.outcome ?? "ok",
  reason: r.reason ?? null,
  status: r.status ?? null,
  trace: r.trace_id ?? null,
  depth: r.depth ?? 0,
});

export function registerObserveRoutes(app: FastifyInstance, store: Store) {
  const A = api.audit;
  serve(app, A.auditList, async (req) => {
    const q = A.auditList.query.parse(req.query ?? {});
    const where: string[] = [],
      args: unknown[] = [];
    const eq = (col: string, v: unknown) => {
      if (v === undefined) return;
      where.push(`${col}=?`);
      args.push(v);
    };
    if (q.since !== undefined) {
      where.push("a.created>=?");
      args.push(q.since);
    }
    if (q.until !== undefined) {
      where.push("a.created<?");
      args.push(q.until);
    }
    if (q.before) {
      const [at, id] = q.before.split(":");
      where.push("(a.created<? OR (a.created=? AND a.id<?))");
      args.push(Number(at), Number(at), id);
    }
    eq("c.channel", q.channel);
    eq("c.route", q.route);
    eq("a.action", q.action);
    eq("c.actor", q.actor);
    eq("c.outcome", q.outcome);
    eq("c.session_id", q.session);
    eq("c.trace_id", q.trace);
    const rows = store.all(
      `SELECT a.*, c.trace_id, c.depth, c.actor, c.session_id, c.job_id, c.face, c.channel, c.route, c.object, c.outcome, c.reason, c.status
       FROM audit a LEFT JOIN audit_context c ON c.audit_id=a.id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY a.created DESC, a.id DESC LIMIT ?`,
      ...args,
      q.limit + 1,
    );
    const more = rows.length > q.limit;
    const page = rows.slice(0, q.limit).map(recordOf);
    const last = page[page.length - 1];
    return { records: page, next: more && last ? `${last.at}:${last.id}` : null };
  });
  serve(app, A.logs, async (req) => {
    const q = A.logs.query.parse(req.query ?? {});
    return { lines: recentLogs(q) };
  });
}
