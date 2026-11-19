/**
 * P4-04 (D-27, a2a-usage.md §2–§5, §9, ADR-123): the A2A entry over both
 * transports — HTTP+JSON at the spec's paths under `/a2a/<agentId>`, and
 * JSON-RPC 2.0 at `/a2a/<agentId>/jsonrpc` — doing exactly the same
 * (A2AServer), only the envelope differs.
 *
 * Who gets here is the guard's (the definitions say `visitors: true`,
 * scope `daisy:invoke`); whether this caller may see this agent is the
 * server's (404 otherwise). Bodies are parsed here, as text, so a body
 * that is not JSON is an A2A parse error and not the local API's 400.
 * Every operation but reading the card and the directory needs
 * `A2A-Version: 1.0` (a2a-usage.md §3: no header → VersionNotSupported).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import {
  A2A_CONTENT_TYPE,
  A2A_EXTENSIONS_HEADER,
  A2A_VERSION,
  jsonTextDepth,
  ListTasksParamsSchema,
  SendMessageParamsSchema,
  TaskIdParamsSchema,
} from "../../../contracts/src/a2a.ts";
import { routeDef, serve } from "../app/serve.ts";
import { A2A_LIMITS } from "../../../contracts/src/limits.ts";
import { log } from "../observe/log.ts";
import type { Principal } from "../access/guard.ts";
import { traceOf } from "../observe/request-audit.ts";
import { A2AError, callerT, invalidArgument, rpcErrorBody, statusBody } from "./errors.ts";
import { msg } from "../app/errors.ts";
import type { Translate } from "../../../contracts/src/i18n.ts";
import type { A2AServer } from "./server.ts";
import { codeVersion } from "../cli/code.ts";

const A = api.a2a;
const JSON_RPC_TYPE = "application/json";

const principalOf = (req: any): Principal => req.daisyPrincipal as Principal;
/** Where the caller reached us (the guard checked the Host against this face's names). */
const rootOf = (req: any) => `${req.protocol}://${req.headers.host}`;
const extensionsOf = (req: any): string[] =>
  String(req.headers[A2A_EXTENSIONS_HEADER.toLowerCase()] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** a2a-usage.md §3: 1.0 or 1.0.x; anything else, or nothing, is not served. */
function checkVersion(req: any) {
  const v = String(req.headers["a2a-version"] ?? "").trim();
  if (/^1\.0(\.\d+)?$/.test(v)) return;
  throw new A2AError(
    "VERSION_NOT_SUPPORTED",
    v
      ? msg("server-a2a.version.got", { version: A2A_VERSION, got: v.slice(0, 20) })
      : msg("server-a2a.version.missing", { version: A2A_VERSION }),
    { metadata: { supported: A2A_VERSION } },
  );
}

/**
 * Review L-5: how deep a whole request body may nest — the envelope
 * (JSON-RPC → params → message → parts → part) plus `metadata` / `data`'s
 * own A2A_LIMITS.jsonDepthMax, with room to spare so the schema still
 * names the field that is too deep. Anything deeper is refused from the
 * text, before JSON.parse builds it.
 */
const BODY_DEPTH_MAX = A2A_LIMITS.jsonDepthMax + 16;

function parseJson(body: unknown): unknown {
  if (body === undefined || body === null || body === "") return undefined;
  if (typeof body !== "string") return body;
  if (jsonTextDepth(body, BODY_DEPTH_MAX) > BODY_DEPTH_MAX)
    throw new A2AError("INVALID_ARGUMENT", msg("server-a2a.json.tooDeep", { max: BODY_DEPTH_MAX, fieldMax: A2A_LIMITS.jsonDepthMax }));
  try {
    return JSON.parse(body);
  } catch {
    throw new A2AError("PARSE_ERROR", msg("server-a2a.json.invalid"));
  }
}

function internal(e: unknown): A2AError {
  if (e instanceof A2AError) return e;
  // Review L-5: a value too deep to walk (the schema bounds depth; this is the second line).
  if (e instanceof RangeError) return new A2AError("INVALID_ARGUMENT", msg("server-a2a.json.tooDeepFields", { max: 32 }));
  return new A2AError("INTERNAL", msg("server-a2a.internal"));
}

/** HTTP+JSON: an answer or a google.rpc.Status. */
async function http(reply: FastifyReply, fn: () => unknown): Promise<unknown> {
  reply.type(A2A_CONTENT_TYPE);
  try {
    return await fn();
  } catch (e) {
    const x = internal(e);
    if (x.more.retryAfterS) reply.header("retry-after", String(x.more.retryAfterS));
    return reply.code(x.http).send(statusBody(x, said(reply.request)));
  }
}

/** P6-23b: the caller's language for a refusal (its Accept-Language, else the owner's). */
function said(req: any): Translate {
  return callerT(req);
}

/** The caller's connection went away (stop holding it; the task goes on). */
function goneSignal(reply: FastifyReply): AbortSignal {
  const ac = new AbortController();
  reply.raw.once("close", () => ac.abort());
  return ac.signal;
}

const PUSH = () =>
  new A2AError("PUSH_NOTIFICATION_NOT_SUPPORTED", msg("server-a2a.push.unsupported"));
const STREAM = (what: "send" | "subscribe") => new A2AError("UNSUPPORTED_OPERATION", msg(`server-a2a.stream.${what}`));
const EXTENDED = () => new A2AError("EXTENDED_AGENT_CARD_NOT_CONFIGURED", msg("server-a2a.extendedCard"));
const NOT_FOUND = () => new A2AError("NOT_FOUND", msg("server-a2a.notFound"));

export async function registerA2ARoutes(root: FastifyInstance, server: A2AServer): Promise<void> {
  await root.register(async (app) => {
    // Bodies as text: a parse error is the A2A transport's to answer.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", { parseAs: "string", bodyLimit: A2A_LIMITS.bodyMax }, (_req, body, done) => done(null, body));
    // Review L-6: a body over the limit (or anything the parser refuses) is
    // answered in the route's own A2A shape, not the local API's.
    app.setErrorHandler((err: any, req: any, reply) => {
      const x =
        err?.code === "FST_ERR_CTP_BODY_TOO_LARGE"
          ? new A2AError("PAYLOAD_TOO_LARGE", msg("server-a2a.bodyTooLarge", { max: A2A_LIMITS.bodyMax, fileMax: A2A_LIMITS.fileMax }))
          : err instanceof A2AError
            ? err
            : err?.statusCode >= 400 && err?.statusCode < 500
              ? new A2AError("INVALID_REQUEST", msg("server-a2a.invalidRequest"))
              : internal(err);
      if (x.reason === "INTERNAL") log.warn("a2a: request failed", { route: routeDef(req)?.id, error: String(err?.message ?? err).slice(0, 300) });
      const rpcRoute = routeDef(req)?.id === A.jsonrpc.id;
      reply.type(rpcRoute ? JSON_RPC_TYPE : A2A_CONTENT_TYPE);
      const t = said(req);
      return reply.code(x.http).send(rpcRoute ? rpcErrorBody(null, x, t) : statusBody(x, t));
    });

    const reachable = (req: any) => {
      if (!server.reachable(principalOf(req), String(req.params.aid))) throw NOT_FOUND();
    };

    serve(app, A.directory, async (req: any, reply) => http(reply, () => server.listAgents(principalOf(req), rootOf(req))));

    serve(app, A.card, async (req: any, reply) =>
      http(reply, () => server.card(principalOf(req), String(req.params.aid), rootOf(req), daisyVersion(), said(req))),
    );

    serve(app, A.send, async (req: any, reply) =>
      http(reply, async () => {
        const p = principalOf(req);
        if (!server.canSee(p, String(req.params.aid))) throw NOT_FOUND();
        checkVersion(req);
        const parsed = SendMessageParamsSchema.safeParse(parseJson(req.body) ?? {});
        if (!parsed.success) throw invalidArgument(parsed.error.issues);
        const task = await server.send(p, String(req.params.aid), parsed.data, {
          extensions: extensionsOf(req),
          traceId: traceOf(req)?.traceId,
          signal: goneSignal(reply),
        });
        return { task };
      }),
    );

    serve(app, A.stream, async (req: any, reply) =>
      http(reply, () => {
        reachable(req);
        checkVersion(req);
        throw STREAM("send");
      }),
    );

    serve(app, A.listTasks, async (req: any, reply) =>
      http(reply, () => {
        reachable(req);
        checkVersion(req);
        const q = ListTasksParamsSchema.safeParse(req.query ?? {});
        if (!q.success) throw invalidArgument(q.error.issues);
        return server.list(principalOf(req), String(req.params.aid), q.data);
      }),
    );

    serve(app, A.getTask, async (req: any, reply) =>
      http(reply, () => {
        reachable(req);
        checkVersion(req);
        const q = TaskIdParamsSchema.safeParse({ ...(req.query ?? {}), id: String(req.params.tid) });
        if (!q.success) throw invalidArgument(q.error.issues);
        return server.get(principalOf(req), String(req.params.aid), q.data.id, q.data.historyLength);
      }),
    );

    serve(app, A.taskAction, async (req: any, reply) =>
      http(reply, () => {
        reachable(req);
        checkVersion(req);
        const op = String(req.params.op);
        const i = op.lastIndexOf(":");
        const id = i > 0 ? op.slice(0, i) : "";
        const action = i > 0 ? op.slice(i + 1) : "";
        if (action === "cancel") return server.cancel(principalOf(req), String(req.params.aid), id);
        if (action === "subscribe") throw STREAM("subscribe");
        throw new A2AError("METHOD_NOT_FOUND", msg("server-a2a.noSuchAction"));
      }),
    );

    for (const def of [A.pushConfigList, A.pushConfigCreate, A.pushConfigGet, A.pushConfigDelete])
      serve(app, def, async (req: any, reply) =>
        http(reply, () => {
          reachable(req);
          checkVersion(req);
          throw PUSH();
        }),
      );

    serve(app, A.extendedCard, async (req: any, reply) =>
      http(reply, () => {
        reachable(req);
        checkVersion(req);
        throw EXTENDED();
      }),
    );

    // ── JSON-RPC 2.0 ──────────────────────────────────────────────────────
    serve(app, A.jsonrpc, async (req: any, reply) => {
      reply.type(JSON_RPC_TYPE);
      // Not this caller's to see: no JSON-RPC processing at all (a2a-usage.md §9.1).
      if (!server.reachable(principalOf(req), String(req.params.aid))) {
        return reply.code(404).send(statusBody(NOT_FOUND(), said(req)));
      }
      let id: unknown = null;
      try {
        const body = parseJson(req.body);
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new A2AError("INVALID_REQUEST", msg("server-a2a.rpc.batch"));
        const r = body as Record<string, unknown>;
        if (typeof r.id === "string" || typeof r.id === "number") id = r.id;
        if (r.jsonrpc !== "2.0" || typeof r.method !== "string" || !("id" in r))
          throw new A2AError("INVALID_REQUEST", msg("server-a2a.rpc.shape"));
        checkVersion(req);
        const result = await rpc(req, reply, r.method, r.params ?? {});
        return { jsonrpc: "2.0", id, result };
      } catch (e) {
        const x = internal(e);
        const t = said(req);
        if (x.reason === "NOT_FOUND") return reply.code(404).send(statusBody(x, t));
        if (x.more.retryAfterS) reply.header("retry-after", String(x.more.retryAfterS));
        return reply.code(x.reason === "UNAVAILABLE" || x.reason === "INTERNAL" ? x.http : 200).send(rpcErrorBody(id, x, t));
      }
    });

    async function rpc(req: any, reply: FastifyReply, method: string, params: unknown): Promise<unknown> {
      const p = principalOf(req);
      const aid = String(req.params.aid);
      switch (method) {
        case "SendMessage": {
          const parsed = SendMessageParamsSchema.safeParse(params);
          if (!parsed.success) throw invalidArgument(parsed.error.issues, "params");
          const task = await server.send(p, aid, parsed.data, {
            extensions: extensionsOf(req),
            traceId: traceOf(req)?.traceId,
            signal: goneSignal(reply),
          });
          return { task };
        }
        case "GetTask": {
          const q = TaskIdParamsSchema.safeParse(params);
          if (!q.success) throw invalidArgument(q.error.issues, "params");
          return server.get(p, aid, q.data.id, q.data.historyLength);
        }
        case "ListTasks": {
          const q = ListTasksParamsSchema.safeParse(params);
          if (!q.success) throw invalidArgument(q.error.issues, "params");
          return server.list(p, aid, q.data);
        }
        case "CancelTask": {
          const q = TaskIdParamsSchema.safeParse(params);
          if (!q.success) throw invalidArgument(q.error.issues, "params");
          return server.cancel(p, aid, q.data.id);
        }
        case "SendStreamingMessage":
          throw STREAM("send");
        case "SubscribeToTask":
          throw STREAM("subscribe");
        case "CreateTaskPushNotificationConfig":
        case "GetTaskPushNotificationConfig":
        case "ListTaskPushNotificationConfigs":
        case "DeleteTaskPushNotificationConfig":
          throw PUSH();
        case "GetExtendedAgentCard":
          throw EXTENDED();
        default:
          throw new A2AError("METHOD_NOT_FOUND", msg("server-a2a.rpc.noMethod", { method: method.slice(0, 60) }));
      }
    }
  });
}

/** The card's `version`: Daisy's (a2a-usage.md §14). */
let cached: string | null = null;
const daisyVersion = () => (cached ??= codeVersion());
