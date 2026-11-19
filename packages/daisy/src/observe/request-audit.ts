/**
 * P1-11 (原则 7, S-4): every call of the local API gets a trace id and,
 * when it is an action (RouteDef.audit), one audit row — in one place,
 * not in the handlers.
 *
 * - onRequest (installed before the guard): the trace — the inbound
 *   `traceparent`'s trace id when it is well-formed, else a new one
 *   (trace.md §2–3) — and the face and route; the rest of the request runs
 *   inside it (observe/trace.ts), so the guard's refusals, the handlers'
 *   own audit rows (`session.create`, `pin.*` …), the log lines and the
 *   turn it queues (jobs.trace) all carry it.
 * - The guard (access/guard.ts) fills in who (`bindPrincipal`); an AI's
 *   working credential continues its turn's trace (trace.md §3).
 * - preHandler: re-entered after the body is read (a stream's events do
 *   not carry the request's context).
 * - onSend: the error code of a refusal by the handler; the id of what a
 *   POST created.
 * - onResponse: the row `api.<route id>` (target {face, channel, status},
 *   as P1-03's review M-2 had it in the guard; merged here) — who, face,
 *   channel, route, object, outcome, status, trace. A refusal by the guard already wrote its own
 *   (`access.denied`) and is not written twice.
 */
import type { FastifyInstance } from "fastify";
import type { AnyRoute } from "../../../contracts/src/index.ts";
import { routeDef } from "../app/serve.ts";
import { faceOf } from "../access/faces.ts";
import type { Principal } from "../access/guard.ts";
import type { Store } from "../store/index.ts";
import { log } from "./log.ts";
import {
  isTraceId,
  newSpanId,
  newTraceId,
  parseTraceparent,
  runInTrace,
  type TraceContext,
} from "./trace.ts";

/** At most this many malformed-`traceparent` warnings a minute. */
const WARN_PER_MINUTE = 10;

/** The request's trace (set by installRequestTrace). */
export const traceOf = (req: any): TraceContext | undefined => req.daisyTrace;

/** Who the guard recognised: into the request's trace. */
export function bindPrincipal(req: any, p: Principal) {
  const t = traceOf(req);
  if (!t) return;
  t.actor = p.kind === "ai" ? "ai" : p.kind === "visitor" ? "visitor" : p.channel === "cli" ? "cli" : "owner";
  t.channel = p.channel;
  if (p.sessionId) t.sessionId = p.sessionId;
  if (p.jobId) t.jobId = p.jobId;
  // trace.md §3: what an AI does within its turn continues that turn's trace.
  if (p.kind === "ai" && isTraceId(p.trace)) t.traceId = p.trace;
}

/** The ids a request names (its path parameters), for the audit's `object`. */
const objectOf = (req: any): string => {
  const params = req.params && typeof req.params === "object" ? req.params : {};
  return Object.values(params)
    .map((v) => String(v))
    .join("/")
    .slice(0, 300);
};

export function installRequestTrace(app: FastifyInstance) {
  let warnWindow = 0,
    warned = 0;
  app.addHook("onRequest", (req: any, _reply, done) => {
    const def = routeDef(req);
    const inbound = req.headers.traceparent;
    const tp = parseTraceparent(inbound);
    const ctx: TraceContext = {
      traceId: tp?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      depth: 0,
      actor: "anonymous",
      face: faceOf(req),
      channel: "none",
      ...(def ? { route: def.id } : {}),
    };
    req.daisyTrace = ctx;
    runInTrace(ctx, () => {
      if (inbound !== undefined && !tp) {
        const now = Date.now();
        if (now - warnWindow >= 60_000) {
          warnWindow = now;
          warned = 0;
        }
        if (warned++ < WARN_PER_MINUTE)
          log.warn(
            `a traceparent header in the wrong shape (expected 00-<32 hex>-<16 hex>-<2 hex>) was ignored; a new trace was started`,
          );
      }
      done();
    });
  });
  app.addHook("preHandler", (req: any, _reply, done) => {
    const t = traceOf(req);
    if (t) runInTrace(t, () => done());
    else done();
  });
}

export function installRequestAudit(app: FastifyInstance, store: Store) {
  app.addHook("onSend", async (req: any, reply, payload) => {
    const def: AnyRoute | undefined = routeDef(req);
    if (!def || req.daisyAudited || !def.audit) return payload;
    const status = reply.statusCode;
    if (typeof payload === "string" && payload.length < 65536) {
      if (status >= 400) {
        try {
          const code = JSON.parse(payload)?.code;
          if (typeof code === "string") req.daisyAuditCode = code.slice(0, 100);
        } catch {}
      } else if (
        def.method === "POST" &&
        !Object.keys(req.params ?? {}).length
      ) {
        try {
          const id = JSON.parse(payload)?.id;
          if (typeof id === "string") req.daisyAuditObject = id.slice(0, 200);
        } catch {}
      }
    }
    return payload;
  });
  app.addHook("onResponse", async (req: any, reply) => {
    const def: AnyRoute | undefined = routeDef(req);
    if (!def || req.daisyAudited || !def.audit) return;
    const t = traceOf(req);
    const p: Principal | undefined = req.daisyPrincipal;
    const status = reply.statusCode;
    const outcome =
      status < 400
        ? "ok"
        : status === 401 || status === 403
          ? "denied"
          : "error";
    try {
      // P1-03 review M-2's row (`api.<id>`, {face, channel, status}), with
      // P1-11's context.
      store.audit(
        p?.label ?? "anonymous",
        "api." + def.id,
        JSON.stringify({
          face: t?.face ?? p?.face ?? "local",
          channel: t?.channel ?? p?.channel ?? "none",
          status,
        }),
        {
          ...(t
            ? {
                traceId: t.traceId,
                depth: t.depth,
                actor: t.actor,
                face: t.face,
                channel: t.channel,
                ...(t.sessionId ? { sessionId: t.sessionId } : {}),
                ...(t.jobId ? { jobId: t.jobId } : {}),
              }
            : {}),
          route: def.id,
          object: req.daisyAuditObject ?? objectOf(req),
          outcome,
          ...(outcome === "ok"
            ? {}
            : { reason: req.daisyAuditCode ?? `http_${status}` }),
          status,
        },
      );
    } catch (e) {
      // The audit must never turn an answered request into a crash.
      log.error("[audit]", (e as Error)?.message || e);
    }
  });
}
