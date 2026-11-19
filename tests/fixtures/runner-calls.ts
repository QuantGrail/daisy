/**
 * P1-02: tests that played the Runner used to send `POST /api/runner/<path>`
 * with `app.inject`, the node token (`authorization`) and `x-lease`. The
 * Runner's calls are in process now (RunnerPort) and the HTTP routes are
 * gone; this keeps those tests' shape. `runnerInject(app, runnerApi)` is
 * `app.inject` except for `/api/runner/<path>`: that is the in-process
 * call `<path>` for the node named by `runnerHeaders(nodeId)`, answered
 * like an HTTP reply (status, json(), body) — the same status and error
 * message the route answered with.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  RunnerCallError,
  type RunnerCall,
} from "../../packages/daisy/src/app/runner-port.ts";

const NODE = "x-test-runner-node";

/** What a fake Runner of node `nodeId` sends (was the node token). */
export function runnerHeaders(nodeId: string) {
  return { [NODE]: nodeId } as Record<string, string>;
}

export interface InjectReply {
  statusCode: number;
  body: string;
  payload: string;
  json(): any;
}

const reply = (statusCode: number, value: unknown): InjectReply => {
  const body = value === null ? "" : JSON.stringify(value);
  return {
    statusCode,
    body,
    payload: body,
    json: () => (body ? JSON.parse(body) : null),
  };
};

/** The in-process call, answered like `app.inject` (tests' fake Runner). */
export async function runnerReply(
  call: RunnerCall,
  path: string,
  payload?: unknown,
  lease?: string,
): Promise<InjectReply> {
  try {
    const out = await call(
      path,
      typeof payload === "string" ? JSON.parse(payload) : payload,
      lease,
    );
    return out === null ? reply(204, null) : reply(200, out);
  } catch (e) {
    if (e instanceof RunnerCallError)
      return reply(e.status, {
        error: e.message,
        ...(e.code ? { code: e.code } : {}),
      });
    throw e;
  }
}

export function runnerInject(
  app: FastifyInstance,
  runnerApi: (nodeId: string) => RunnerCall,
) {
  return async (o: any): Promise<any> => {
    const url = String(o.url ?? "");
    if (!url.startsWith("/api/runner/")) return app.inject(o);
    const h = o.headers || {};
    const nodeId = h[NODE];
    if (typeof nodeId !== "string")
      // What the gone HTTP route answered a caller without a node.
      return reply(401, { error: "执行节点不存在或已吊销" });
    return runnerReply(
      runnerApi(nodeId),
      url.slice("/api/runner".length),
      o.payload ?? o.body,
      h["x-lease"],
    );
  };
}

/**
 * runner.json (the in-process Runner's settings) with its calls: what a
 * test's `runNode(config, …)` needs (was `{ ...runner.json, serverUrl }`).
 */
export function runnerConfig(
  ctx: { runnerApi: (nodeId: string) => RunnerCall },
  file: string,
) {
  const c = JSON.parse(readFileSync(file, "utf8"));
  return { ...c, api: ctx.runnerApi(c.nodeId) };
}

/**
 * A fake Runner's `runner(path, body)` that threw `{status, data}` on a
 * refusal (was a fetch of POST /api/runner<path> with the node token).
 */
export function runnerFetch(call: RunnerCall) {
  return async (path: string, body: any = {}) => {
    try {
      return await call(path, body);
    } catch (e: any) {
      if (!(e instanceof RunnerCallError)) throw e;
      throw Object.assign(Error(e.message), {
        status: e.status,
        data: { error: e.message, ...(e.code ? { code: e.code } : {}) },
      });
    }
  };
}

/**
 * A member's own execution node, straight in the database (P1-02: there
 * is no enrolment — POST /api/nodes/self — any more; tests that need a
 * second node or an owned one add it here). `nodeId` = `id`.
 */
export function ownNode(
  store: { run: (sql: string, ...args: any[]) => unknown },
  ownerId: string | null,
  label: string,
  kind: "local" | "remote" = "local",
) {
  const id = randomUUID();
  store.run(
    "INSERT INTO nodes(id,label,token_hash,owner_id) VALUES(?,?,?,?)",
    id,
    label,
    "test:" + id,
    ownerId,
  );
  store.run("UPDATE nodes SET kind=? WHERE id=?", kind, id);
  return { id, nodeId: id, label, ownerId };
}
