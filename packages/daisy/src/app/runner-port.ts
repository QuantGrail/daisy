import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { log } from "../observe/log.ts";
import { ownerT } from "../platform/language.ts";
import { isLocalized } from "./errors.ts";
import { runInTrace, systemTrace, type TraceContext } from "../observe/trace.ts";
/**
 * P1-02: the Runner's calls to the control plane, inside one process.
 *
 * Before, the Runner was another process (often another machine) and made
 * these calls as `POST /api/runner/<path>` with a node token and, for a
 * job's calls, its lease in `X-Lease`. Daisy runs both halves in one
 * process (D-02), so the HTTP routes are gone; what stays is the same set
 * of calls — the same paths, the same bodies, the same answers and the
 * same errors (status + message) — dispatched here to the handlers that
 * used to be the route handlers. Nothing outside this process can reach
 * them.
 *
 * Bodies and answers are copied as JSON both ways, as the wire did: a
 * handler that fills in an event (approvals) never changes the Runner's
 * copy, and an answer never shares objects with the database layer.
 */

/** One call: `path` as it was after `/api/runner` (`/jobs/<id>/pulse`). */
export type RunnerCall = ((
  path: string,
  body?: unknown,
  lease?: string,
) => Promise<any>) & {
  /**
   * P1-02b: the process's database (daisy.sqlite), where the Runner keeps
   * its result journal (turns/result-journal.ts). createApp's `runnerApi`
   * gives it; a test's stand-in may not (the journal is then in memory).
   */
  readonly journal?: DatabaseSync;
};

/** A refused call: the status and message the HTTP route answered with. */
export class RunnerCallError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** What a handler sees of a call (the fields the route handlers read). */
export interface RunnerRequest {
  params: Record<string, string>;
  body: any;
  /** `x-lease`: the job's (or login's / request's) lease, when given. */
  headers: Record<string, string | undefined>;
  /** The node the calling Runner runs for (was: its node token). */
  nodeId: string;
  url: string;
  routeOptions: { url: string };
}

/** The part of a reply a handler may use (one sets 204). */
export interface RunnerReply {
  code(status: number): RunnerReply;
  send(payload?: unknown): RunnerReply;
}

type Handler = (req: RunnerRequest, reply: RunnerReply) => unknown;

const copy = (v: unknown) =>
  v === undefined ? undefined : JSON.parse(JSON.stringify(v));

/**
 * Longest a call may take (was the Runner's fetch timeout, 8 s).
 *
 * The timeout cannot make a call run twice today: every Runner call's
 * handler is synchronous (one SQLite transaction, then the answer) except
 * `/org-guide`, which awaits the plugin's read and only records a report.
 * A synchronous handler finishes before the timer can fire, so a call that
 * timed out never changed anything. Before a claiming handler (`/claim`,
 * `/shell/claim`, `/logins/claim`, `/filesystem/claim`, `/jobs/:id/input/
 * claim`, `/live/:sid/wake`) gets an `await`, make it idempotent first:
 * the Runner retries after a timeout, and the first attempt may still
 * complete behind it (a job leased twice).
 */
export const RUNNER_CALL_TIMEOUT_MS = 8000;

/**
 * A call that took too long: not a refusal (no status) — the Runner treats
 * it like the network error it was over HTTP (retries what it retried).
 */
export class RunnerCallTimeout extends Error {}

/**
 * P1-11 (trace.md §3, S-4): what a call is part of. `context` names the
 * trace and who acts (the turn a `/jobs/:id/…` call reports for, the AI
 * whose tool made the call); a call it does not claim runs under a new
 * system trace — never under whatever context the caller happened to be
 * in. `done` sees every call's outcome (the harness tools' audit rows).
 */
export interface RunnerCallObserver {
  context(pattern: string, req: RunnerRequest): TraceContext | undefined;
  done(
    pattern: string,
    req: RunnerRequest,
    ctx: TraceContext,
    result: { status: number; out?: unknown; error?: unknown },
  ): void;
}

export class RunnerPort {
  constructor(private timeoutMs = RUNNER_CALL_TIMEOUT_MS) {}
  /** P1-11: set by createApp (observe/runner-trace.ts). */
  observer?: RunnerCallObserver;
  private routes: {
    pattern: string;
    re: RegExp;
    keys: string[];
    handler: Handler;
  }[] = [];
  /** Register a call (`/jobs/:id/pulse`); one handler per path. */
  post(pattern: string, handler: Handler) {
    if (!pattern.startsWith("/") || pattern.startsWith("/api/"))
      throw Error(`A Runner call path starts with / and has no /api/runner: ${pattern}`);
    if (this.routes.some((r) => r.pattern === pattern))
      throw Error(`Runner call registered twice: ${pattern}`);
    const keys: string[] = [];
    const re = new RegExp(
      "^" +
        pattern
          .split("/")
          .map((part) => {
            if (!part.startsWith(":"))
              return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            keys.push(part.slice(1));
            return "([^/]+)";
          })
          .join("/") +
        "$",
    );
    this.routes.push({ pattern, re, keys, handler });
  }
  /** Registered paths (tests: nothing of the old surface is missing). */
  paths() {
    return this.routes.map((r) => r.pattern);
  }
  /** The calls of the Runner that runs for node `nodeId`. */
  connect(nodeId: string): RunnerCall {
    return (path, body, lease) => this.dispatch(nodeId, path, body, lease);
  }
  private async dispatch(
    nodeId: string,
    path: string,
    body: unknown,
    lease?: string,
  ) {
    const found = this.find(path);
    if (!found) throw new RunnerCallError(404, "Not found");
    const req = this.request(nodeId, path, found, body, lease);
    let ctx: TraceContext | undefined;
    try {
      ctx = this.observer?.context(found.route.pattern, req);
    } catch {}
    ctx ??= systemTrace();
    const c = ctx;
    const report = (result: { status: number; out?: unknown; error?: unknown }) => {
      try {
        this.observer?.done(found.route.pattern, req, c, result);
      } catch {}
    };
    return runInTrace(c, async () => {
      try {
        const out = await this.handle(found.route, req);
        report({ status: out === null ? 204 : 200, out });
        return out;
      } catch (e: any) {
        report({ status: e?.status ?? 500, error: e });
        throw e;
      }
    });
  }
  private find(path: string) {
    const bare = path.split("?")[0];
    let route, match: RegExpExecArray | null = null;
    for (route of this.routes) if ((match = route.re.exec(bare))) break;
    if (!route || !match) return null;
    return { route, match };
  }
  private request(
    nodeId: string,
    path: string,
    { route, match }: { route: RunnerPort["routes"][number]; match: RegExpExecArray },
    body: unknown,
    lease?: string,
  ): RunnerRequest {
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => {
      try {
        params[k] = decodeURIComponent(match![i + 1]);
      } catch {
        params[k] = match![i + 1];
      }
    });
    return {
      params,
      body: copy(body ?? {}),
      headers: lease ? { "x-lease": lease } : {},
      nodeId,
      url: "/api/runner" + path,
      routeOptions: { url: "/api/runner" + route.pattern },
    };
  }
  private async handle(route: RunnerPort["routes"][number], req: RunnerRequest) {
    let status = 200,
      sent: unknown,
      replied = false;
    const reply: RunnerReply = {
      code(s) {
        status = s;
        return reply;
      },
      send(payload) {
        replied = true;
        sent = payload;
        return reply;
      },
    };
    let out: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A handler that hangs must not hang the Runner's loop (review P1-02).
      out = await Promise.race([
        route.handler(req, reply),
        new Promise((_, fail) => {
          timer = setTimeout(
            () =>
              fail(
                new RunnerCallTimeout(
                  ownerT()("server-app.runner.callTimeout", {
                    path: route!.pattern,
                    seconds: Math.round(this.timeoutMs / 1000),
                  }),
                ),
              ),
            this.timeoutMs,
          );
          (timer as any).unref?.();
        }),
      ]);
    } catch (e: any) {
      if (e instanceof RunnerCallTimeout) {
        log.error(`Runner call ${route.pattern} got no answer in ${Math.round(this.timeoutMs / 1000)} s`);
        throw e;
      }
      if (e instanceof z.ZodError)
        throw new RunnerCallError(400, ownerT()("api.error.invalidInput"), "invalid_input");
      if (e?.statusCode)
        throw new RunnerCallError(
          e.statusCode,
          // A keyed error in the owner's language (the Runner may show it).
          isLocalized(e) ? ownerT().dynamic(e.key, e.params) : String(e.message),
          e.code ?? e.apiCode,
        );
      log.error(`Runner call ${route.pattern}:`, e?.message || e);
      throw new RunnerCallError(500, ownerT()("api.error.serverFault"), "internal");
    } finally {
      clearTimeout(timer);
    }
    if (status === 204) return null;
    if (status >= 400)
      throw new RunnerCallError(status, String((sent as any)?.error ?? ""));
    return copy(out === reply || replied ? sent : out) ?? null;
  }
}
