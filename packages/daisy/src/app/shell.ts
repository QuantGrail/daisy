import { z } from "zod";
import { randomBytes } from "node:crypto";
import {
  type TerminalResult,
} from "../../../contracts/src/index.ts";
import { id, type Store } from "../store/index.ts";
import type { RunnerPort } from "./runner-port.ts";
import { serve } from "./serve.ts";
import type { MessageKey, Translate } from "../../../contracts/src/i18n.ts";
import { ownerT } from "../platform/language.ts";
import { LocalizedError } from "./errors.ts";
import { requestT } from "./language.ts";
import { api } from "../../../contracts/src/api/index.ts";
const fail = (statusCode: number, code: string, key: MessageKey): never => {
  throw new LocalizedError(statusCode, code, key);
};
/** A result the server wrote itself (no answer in time): its key, said when read. */
const NO_ANSWER: MessageKey = "server-app.shell.noAnswer";
/** Runner kills the command after this; the request expires a little later. */
export const SHELL_TIMEOUT_MS = 120_000;
const CLAIM_WAIT_MS = 30_000,
  RUN_GRACE_MS = 30_000,
  OUTPUT_MAX = 64 * 1024,
  /** Finished runs kept per owner (older ones are dropped). */
  KEEP_PER_OWNER = 50,
  /** All terminal output one message may carry to the Agent. */
  MESSAGE_OUTPUT_MAX = 100_000;
/**
 * 「在终端执行」: the conversation owner runs one shell command on
 * the session's node, in its workspace, as the node's OS account (in host
 * mode that is the owner's own account). A node-scoped request table
 * like filesystem.ts — not a session job, so it also works while the Agent is
 * running. Finished runs are attached to the owner's next message by id.
 */
export function shellRoutes(
  app: any,
  /** P1-02: the in-process Runner's calls (were /api/runner/*). */
  runner: RunnerPort,
  store: Store,
  user: (r: any) => any,
  session: (r: any, sid: string) => any,
  node: (r: any) => any,
  claimingNode: (r: any) => any,
) {
  const reap = () => {
    store.run(
      "UPDATE shell_requests SET status='error',result=? WHERE expires<? AND status IN ('queued','running')",
      JSON.stringify({ error: ownerT().dynamic(NO_ANSWER), errorKey: NO_ANSWER }),
      Date.now(),
    );
    // Finished runs stay a day so a message written later can still carry them.
    store.run(
      "DELETE FROM shell_requests WHERE expires<?",
      Date.now() - 86_400_000,
    );
  };
  const view = (r: any, t: Translate): TerminalResult & { status: string } => {
    const result = r.result ? JSON.parse(r.result) : {};
    // The server's own words in the reader's language (an older row has only `error`).
    if (typeof result.errorKey === "string") result.error = t.dynamic(result.errorKey);
    return {
      id: r.id,
      status: r.status,
      command: r.command,
      cwd: r.cwd,
      exitCode: result.exitCode ?? null,
      timedOut: !!result.timedOut,
      output: result.output ?? "",
      truncated: !!result.truncated,
      durationMs: result.durationMs ?? 0,
      ...(result.error ? { error: result.error } : {}),
    };
  };
  serve(app, api.sessionTools.shellRun, async (req: any) => {
    const u = user(req),
      s = session(req, req.params.id),
      b = api.sessionTools.shellRun.body.parse(req.body);
    // Strictly the owner: an admin override must never run commands under
    // another member's account.
    if (s.ownerId !== u.id) fail(403, "not_session_owner", "server-app.shell.ownerOnly");
    if (s.archived) fail(409, "session_archived", "server-app.session.archived");
    const n = store.one("SELECT * FROM nodes WHERE id=?", s.nodeId);
    if (!n || n.revoked_at) fail(409, "node_revoked", "server-app.node.revoked");
    // P1-03: one owner, one machine — the Runner runs as the owner's own
    // system account, so a command runs as the owner.
    if (Date.now() - n.last_seen > 30000)
      fail(503, "node_offline", "server-app.shell.nodeOffline");
    const w = store.one(
      "SELECT path FROM workspaces WHERE id=?",
      s.workspaceId,
    );
    if (!w) fail(409, "workspace_not_found", "server-app.shell.noWorkspace");
    reap();
    if (
      store.one(
        "SELECT COUNT(*) AS n FROM shell_requests WHERE owner_id=? AND status IN ('queued','running')",
        u.id,
      ).n >= 3
    )
      fail(429, "too_many_requests", "server-app.shell.tooMany");
    const rid = id(),
      now = Date.now();
    store.atomic(() => {
      store.run(
        "INSERT INTO shell_requests(id,owner_id,session_id,node_id,command,cwd,status,created,expires) VALUES(?,?,?,?,?,?,?,?,?)",
        rid,
        u.id,
        s.id,
        s.nodeId,
        b.command,
        w.path,
        "queued",
        now,
        now + CLAIM_WAIT_MS,
      );
      store.audit(
        u.id,
        "shell.run",
        `${s.id}:${rid}:${b.command.slice(0, 500)}`,
      );
      const old = store.all(
        "SELECT id FROM shell_requests WHERE owner_id=? AND status IN ('complete','error') ORDER BY rowid DESC LIMIT -1 OFFSET ?",
        u.id,
        KEEP_PER_OWNER,
      );
      for (const r of old)
        store.run("DELETE FROM shell_requests WHERE id=?", r.id);
    });
    return { id: rid, status: "queued" };
  });
  serve(app, api.sessionTools.shellStatus, async (req: any) => {
    const u = user(req);
    reap();
    const r = store.one(
      "SELECT * FROM shell_requests WHERE id=? AND owner_id=?",
      req.params.id,
      u.id,
    );
    if (!r) fail(404, "shell_not_found", "server-app.shell.notFound");
    return view(r, requestT(req));
  });
  runner.post("/shell/claim", async (req: any) => {
    const n = claimingNode(req);
    reap();
    return store.atomic(() => {
      const r = store.one(
        "SELECT * FROM shell_requests WHERE node_id=? AND status='queued' ORDER BY rowid LIMIT 1",
        n.id,
      );
      if (!r) return { request: null };
      const lease = randomBytes(24).toString("base64url");
      store.run(
        "UPDATE shell_requests SET status='running',lease=?,expires=? WHERE id=?",
        lease,
        Date.now() + SHELL_TIMEOUT_MS + RUN_GRACE_MS,
        r.id,
      );
      return {
        request: {
          id: r.id,
          lease,
          command: r.command,
          cwd: r.cwd,
          timeoutMs: SHELL_TIMEOUT_MS,
        },
      };
    });
  });
  runner.post("/shell/:id/complete", async (req: any) => {
    const n = node(req);
    reap();
    const r = store.one(
      "SELECT * FROM shell_requests WHERE id=?",
      req.params.id,
    );
    if (!r || r.node_id !== n.id || r.lease !== req.headers["x-lease"])
      fail(409, "lease_invalid", "server-app.shell.leaseInvalid");
    if (r.status === "complete") return { ok: true };
    if (r.status !== "running") fail(409, "shell_closed", "server-app.shell.closed");
    const b = z
      .object({
        exitCode: z.number().int().nullable(),
        timedOut: z.boolean(),
        output: z.string().max(OUTPUT_MAX + 1000),
        truncated: z.boolean(),
        durationMs: z.number().int().min(0),
        error: z.string().max(2000).optional(),
      })
      .parse(req.body);
    store.run(
      "UPDATE shell_requests SET status='complete',result=?,expires=? WHERE id=?",
      JSON.stringify(b),
      Date.now(),
      r.id,
    );
    return { ok: true };
  });
  /**
   * Finished runs of this owner + session, in the given order, for a message
   * (send route). Unknown, foreign, or unfinished ids are refused.
   */
  return {
    resolve(ownerId: string, sessionId: string, ids: string[]) {
      reap();
      // Carried to the Agent with the message: the owner's language.
      const t = ownerT();
      const runs = ids.map((rid) => {
        const r = store.one(
          "SELECT * FROM shell_requests WHERE id=? AND owner_id=? AND session_id=?",
          rid,
          ownerId,
          sessionId,
        );
        if (!r) fail(400, "shell_result_not_found", "server-app.shell.resultNotFound");
        if (r.status !== "complete" && r.status !== "error")
          fail(409, "shell_running", "server-app.shell.stillRunning");
        const { status: _status, ...result } = view(r, t);
        return result;
      });
      // Share the message budget: long outputs keep their head and tail.
      const budget = Math.floor(MESSAGE_OUTPUT_MAX / Math.max(1, runs.length));
      return runs.map((r) =>
        r.output.length <= budget
          ? r
          : {
              ...r,
              output:
                r.output.slice(0, Math.floor(budget / 4)) +
                `\n${t("server-app.shell.omitted", { chars: r.output.length - budget })}\n` +
                r.output.slice(-Math.floor((budget * 3) / 4)),
              truncated: true,
            },
      );
    },
  };
}
