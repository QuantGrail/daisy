/**
 * P1-06 (ADR-107): register a local API route from its definition
 * (packages/contracts/src/api). The method and path come from the
 * definition; the handler validates with the definition's schemas
 * (`def.body.parse(req.body)` where it used to write its own) at the
 * point it always did, so the order of checks and every error text stay
 * as they were. The definition rides on the route's config (`api`), where
 * P1-03's scope / channel / PIN checks will read it; createApp records
 * every route so a test proves no `/api/*` route bypasses the table.
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteShorthandOptions,
} from "fastify";
import type { WebSocket } from "ws";
import { letInProblems, type AnyRoute } from "../../../contracts/src/index.ts";

/**
 * P4-02 (5.11, let-in.ts): a definition that lets someone in without
 * daisy:grant + the PIN — or a change at a place kept for those that does
 * not say what it is — is never registered (one not made by `group`).
 */
function checkLetIn(def: AnyRoute) {
  const problems = letInProblems({ ...def, socket: def.output.kind === "websocket" });
  if (def.letsIn && !def.pin) problems.push(`${def.id}: a route that lets someone in must want the PIN`);
  if (def.letsIn && def.channels.includes("ai"))
    problems.push(`${def.id}: a route that lets someone in must not be open to the AI`);
  if (problems.length) throw new Error(problems.join("\n"));
}

export type ApiHandler = (req: any, reply: FastifyReply) => unknown;

export function serve(
  app: FastifyInstance,
  def: AnyRoute,
  handler: ApiHandler,
  options: RouteShorthandOptions = {},
): void {
  checkLetIn(def);
  app.route({
    ...options,
    method: def.method,
    url: def.path,
    config: { ...(options.config as object), api: def },
    // P4-02 review M-1: a PIN route's success went through commitLetIn
    // (access/let-in-commit.ts) — a handler that forgot is a 500 in its
    // own tests, never a silent write after a reset. D-40 ①: a read that
    // wants the PIN on some channels only (`pinOn`) persists nothing and
    // answers outside commitLetIn, with or without a grant.
    handler: def.pin && !def.pinOn
      ? async (req: any, reply: FastifyReply) => {
          const out = await handler(req, reply);
          if (!req.daisyLetInCommitted && reply.statusCode < 400)
            throw new Error(`${def.id}: a PIN route must write through commitLetIn (ADR-121)`);
          return out;
        }
      : handler,
  } as any);
}

/** The live WebSocket (its definition's `output` is `websocket(…)`). */
export function serveSocket(
  app: FastifyInstance,
  def: AnyRoute,
  handler: (socket: WebSocket, req: FastifyRequest) => void,
): void {
  if (def.output.kind !== "websocket" || def.method !== "GET")
    throw Error(`${def.id} is not a WebSocket route`);
  checkLetIn(def);
  app.get(def.path, { websocket: true, config: { api: def } } as any, handler);
}

/** The definition a request was routed by (undefined: not a table route). */
export const routeDef = (req: any): AnyRoute | undefined =>
  req.routeOptions?.config?.api;
