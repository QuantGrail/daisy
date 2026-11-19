import { mkdirSync, writeFileSync } from "node:fs";
import { auditExternalTool } from "../a2a/tool-audit.ts";
import { join } from "node:path";
import { z } from "zod";
import {
  forgetJump,
  jumpedList,
  markJumpStarted,
  nextPending,
} from "../sessions/queue-jump.ts";
import { withdrawRequeued } from "../sessions/steer-requeue.ts";
import { appendState, withdrawals } from "../sessions/native-append.ts";
import { nativeApprovalHandled } from "../approvals/native-approvals.ts";
import { id } from "../store/index.ts";
import {
  residentHeld,
  sanitizeTitle,
  nativeTitle,
  isDaisyForkTitle,
  type Event,
} from "../../../contracts/src/index.ts";
import { normalizeNodeCapabilities } from "../../../contracts/src/agent-capabilities.ts";
import { HttpError, LocalizedError } from "./errors.ts";
import { ownerT } from "../platform/language.ts";
import type { AppBase, AppContext } from "./context.ts";
import type { NodeAccess } from "./nodes.ts";
import { log } from "../observe/log.ts";
/** A job's lease, checked on a Runner's request (P1-00: moved from app.ts). */
export function runnerHelpers(ctx: AppBase & NodeAccess) {
  const { store, node } = ctx;
  function ownedJob(req: any) {
    const n = node(req),
      j = store.one("SELECT * FROM jobs WHERE id=?", (req.params as any).id);
    if (!j || j.node_id !== n.id) throw new LocalizedError(404, "job_not_found", "server-app.job.notFound");
    if (
      j.status !== "running" ||
      j.lease !== req.headers["x-lease"] ||
      j.lease_until < Date.now()
    )
      throw new LocalizedError(409, "lease_expired", "server-app.job.leaseExpired");
    return j;
  }
  return { ownedJob };
}
export type RunnerHelpers = ReturnType<typeof runnerHelpers>;
/**
 * The Runner's side (P1-00: moved from app.ts): state sync, claim, lease
 * pulse, events, completion, recovery, titles, appended inputs, the
 * identity carry. P1-02: in-process calls on `ctx.runnerPort` (they were
 * POST /api/runner/*; paths, bodies and answers unchanged).
 */
export function registerRunnerCalls(ctx: AppContext): void {
  const app = ctx.runnerPort;
  const {
    opts,
    store,
    node,
    claimingNode,
    liveNudge,
    ownedJob,
    touched,
    publish,
    broadcast,
    reap,
    keepCallbackOf,
    settle,
    settleLateRead,
    sessionJob,
    runsSidecars,
    jobPayload,
    titleRequest,
  } = ctx;
  /**
   * the Runner carried the transcript after 「换身份」 — the switch
   * is forgotten (once), unless a newer one happened meanwhile.
   */
  app.post("/jobs/:id/identity-carried", async (req) => {
    const j = ownedJob(req),
      b = z.object({ at: z.number().int().nonnegative() }).parse(req.body);
    const cleared = store.atomic(() => {
      const s = store.session(j.session_id);
      if (!s || s.identityMove?.at !== b.at) return false;
      delete s.identityMove;
      store.save(s);
      return true;
    });
    if (cleared) touched(j.session_id);
    return { ok: true, cleared };
  });
  // Of these session ids, the ones this node no
  // longer runs (deleted, or moved): their file checkpoints go. Only the
  // node's own sessions count as known (nothing about others leaks).
  app.post("/sessions/gone", async (req) => {
    const n = node(req),
      b = z
        .object({ ids: z.array(z.string().min(1).max(200)).max(500) })
        .parse(req.body);
    return {
      gone: b.ids.filter((id) => {
        const s = store.session(id);
        return !s || s.nodeId !== n.id;
      }),
    };
  });
  /**
   * P1-02: what the heartbeat carried besides liveness, without it. The
   * in-process Runner reports its capabilities (CLIs found, adapters'
   * features, its OS user) and gets what the control plane has for it:
   * whether it may claim, deleted managed identities to remove, plugin
   * state (`orgGuide`). No restart requests, no release to follow,
   * no remote presence: the Runner lives and dies with this process.
   */
  app.post("/sync", async (req) => {
    const n = node(req),
      b = z
        .object({
          capabilities: z.record(z.string(), z.unknown()).default({}),
          runner: z
            .object({
              username: z.string().min(1).max(64),
              uid: z
                .number()
                .int()
                .min(0)
                .max(2 ** 32),
            })
            .optional(),
        })
        .parse(req.body);
    store.run(
      "UPDATE nodes SET last_seen=?,capabilities=?,runner_user=COALESCE(?,runner_user),runner_uid=COALESCE(?,runner_uid) WHERE id=?",
      Date.now(),
      // ADR-152: a Runner before the rename reports `"harbor"`; stored as `"fallback"`.
      JSON.stringify(normalizeNodeCapabilities(b.capabilities)),
      b.runner?.username ?? null,
      b.runner?.uid ?? null,
      n.id,
    );
    return {
      ok: true,
      // P1-03: never blocked (the runner-user check went with multi-user).
      blocked: null,
      // Deleted managed identities of this node (30 days): the runner removes
      // their CLI directories; removal is idempotent.
      retiredIdentities: store
        .all(
          "SELECT profile_id FROM retired_identities WHERE node_id=? AND retired_at>?",
          n.id,
          Date.now() - 30 * 86_400_000,
        )
        .map((r: any) => r.profile_id),
      // `orgGuide` — which L1 document is the org layer; a plugin
      // that knows how reads it as its user and reports it. Only while the
      // layered prompt is switched on.
      ...ctx.promptLayers.heartbeat(),
    };
  });
  app.post("/claim", async (req) => {
    const n = claimingNode(req);
    // the runner's free slots (online Agents) and the sessions that
    // already hold one. No free slot: only those sessions' jobs. An older
    // runner sends neither and claims as before.
    const slots = z
      .object({
        free: z.number().int().optional(),
        workspaceProtocol: z.number().int().default(1),
        online: z.array(z.string().max(100)).max(1000).default([]),
      })
      .parse(req.body ?? {});
    const full = slots.free !== undefined && slots.free <= 0;
    // D-36: no PIN, no AI turn — queued work waits until one is set (a
    // turn already running goes on).
    if (ctx.aiTurnsBlocked())
      return {
        job: null,
        waiting: false,
        ...(liveNudge.delete(n.id) ? { live: true } : {}),
      };
    reap();
    const job = store.atomic(() => {
      const j = store.one(
        `SELECT j.* FROM jobs j JOIN sessions s ON s.id=j.session_id
         WHERE j.node_id=? AND j.status='queued'
           AND (? >= 2 OR COALESCE(json_extract(s.data,'$.workspaceMode'),'shared') NOT IN ('read-only','snapshot'))
           AND (? = 0 OR j.session_id IN (SELECT value FROM json_each(?)))
           AND NOT EXISTS (
           SELECT 1 FROM jobs active JOIN sessions other ON other.id=active.session_id
           WHERE active.status='running' AND
             json_extract(other.data,'$.profileId')=json_extract(s.data,'$.profileId') AND
             EXISTS(SELECT 1 FROM job_operations o WHERE o.job_id IN (j.id,active.id)
               AND json_extract(o.data,'$.name') IN ('config.write','mcp.add','mcp.remove','skill.write','plugin.install','plugin.uninstall','terminal'))
         ) ORDER BY j.created LIMIT 1`,
        n.id,
        slots.workspaceProtocol,
        full ? 1 : 0,
        JSON.stringify(slots.online),
      );
      if (!j) return null;
      // Nothing runs for a paused / archived resident.
      const js = store.session(j.session_id);
      if (js && residentHeld(js)) {
        keepCallbackOf(js, j);
        settle(j, "interrupted", ownerT()("server-app.job.residentPaused"));
        return null;
      }
      if (j.cancel) {
        settle(j, "interrupted", ownerT()("server-app.job.cancelled"));
        return null;
      }
      // a Runner that does not run sidecars (rolled back since
      // it was queued) would run this one as an ordinary, writable
      // session — never hand it over.
      if (js?.sidecar && !runsSidecars(n.id)) {
        settle(j, "interrupted", ownerT()("server-app.job.noSidecarSupport"));
        return null;
      }
      const lease = id();
      store.run(
        "UPDATE jobs SET status='running',lease=?,lease_until=? WHERE id=?",
        lease,
        Date.now() + 30_000,
        j.id,
      );
      return { ...j, lease };
    });
    if (!job)
      return {
        job: null,
        // A new session waits for a slot: the runner may free an idle one.
        waiting:
          full &&
          !!store.one(
            `SELECT 1 FROM jobs WHERE node_id=? AND status='queued'
               AND session_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`,
            n.id,
            JSON.stringify(slots.online),
          ),
        // an identity threshold or 立即重启 for this node.
        ...(liveNudge.delete(n.id) ? { live: true } : {}),
      };
    publish(job.session_id, "status", { status: "running" });
    const payload = jobPayload(job);
    // P1-03: this turn's working credential, in the session's file (the
    // harness gets the path; access/ai-credential.ts).
    try {
      payload.aiCredential = {
        file: await ctx.access.ai.startTurn(job.session_id, job.id),
        url: ctx.access.faces.local.url,
      };
    } catch (e) {
      log.error("[ai-credential]", (e as Error)?.message || e);
    }
    return { job: payload };
  });
  app.post("/jobs/:id/artifacts", async (req) => {
    const j = ownedJob(req),
      s = store.session(j.session_id)!,
      b = z
        .object({
          name: z.string().min(1).max(250),
          mime: z.string().max(150),
          data: z.string().max(12 * 1024 * 1024),
        })
        .parse(req.body);
    const bytes = Buffer.from(b.data, "base64");
    if (bytes.length > 8 * 1024 * 1024) throw new LocalizedError(413, "attachment_too_large", "server-app.attachment.tooLargeRunner");
    const aid = id(),
      dir = join(opts.dataDir, "attachments");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, aid);
    writeFileSync(path, bytes, { mode: 0o600 });
    store.run(
      "INSERT INTO attachments VALUES(?,?,?,?,?,?)",
      aid,
      s.ownerId,
      b.name,
      b.mime,
      bytes.length,
      path,
    );
    return { id: aid, name: b.name, mime: b.mime, size: bytes.length };
  });
  app.post("/jobs/:id/pulse", async (req) => {
    const j = ownedJob(req);
    store.run(
      "UPDATE jobs SET lease_until=? WHERE id=?",
      Date.now() + 30_000,
      j.id,
    );
    // 「移除」 of appended jobs the agent has not read yet.
    const withdraw = withdrawals(store, j.id);
    return {
      cancel: !!j.cancel,
      ...(withdraw.length ? { withdraw } : {}),
      approvals: store
        .all("SELECT data FROM approvals WHERE job_id=?", j.id)
        .map((r) => JSON.parse(r.data)),
    };
  });
  app.post("/jobs/:id/events", async (req) => {
    const j = ownedJob(req);
    const b = z
      .object({
        events: z
          .array(
            z.object({
              id: z.string(),
              type: z.enum(["item", "status", "approval", "native"]),
              data: z.any(),
            }),
          )
          .max(100),
      })
      .parse(req.body);
    for (const e of b.events) {
      if (!e.data || typeof e.data !== "object")
        throw new HttpError(400, "Invalid event");
      if (
        e.type === "native" &&
        (typeof e.data.nativeId !== "string" ||
          e.data.nativeId.length > 300 ||
          ["model", "effort", "serviceTier", "permissionMode"].some(
            (k) =>
              e.data[k] !== undefined &&
              (typeof e.data[k] !== "string" || e.data[k].length > 200),
          ))
      )
        throw new HttpError(400, "Invalid session identifier");
      if (e.type === "approval") {
        const a = z
          .object({
            id: z.string().max(100),
            title: z.string().max(500),
            input: z.unknown(),
            options: z
              .array(
                z.object({
                  id: z.string().max(200),
                  label: z.string().max(500),
                }),
              )
              .min(1)
              .max(30),
          })
          .parse(e.data);
        const existing = store.one(
          "SELECT job_id FROM approvals WHERE id=?",
          a.id,
        );
        if (existing && !store.one("SELECT id FROM events WHERE id=?", e.id))
          throw new LocalizedError(409, "approval_id_used", "server-app.job.approvalIdUsed");
        Object.assign(e.data, a, {
          sessionId: j.session_id,
          jobId: j.id,
          status: "pending",
          createdAt: Date.now(),
        });
      }
      if (e.type === "item" && e.data.id === `user:${j.id}`) {
        const original = store.one(
          "SELECT data FROM items WHERE id=? AND session_id=?",
          e.data.id,
          j.session_id,
        );
        if (!original || e.data.status !== "accepted")
          throw new HttpError(400, "Invalid input acknowledgement");
        e.data = {
          ...JSON.parse(original.data),
          status: "accepted",
          ...(e.data.native ? { native: e.data.native } : {}),
        };
      }
      // An online process also finishes items of this session's
      // earlier turns (a background task started then, reporting now).
      if (
        e.type === "item" &&
        ((!e.data.id?.startsWith(j.id + ":") &&
          e.data.id !== `user:${j.id}` &&
          !sessionJob(e.data.id, j.session_id)) ||
          typeof e.data.text !== "string" ||
          e.data.text.length > 300000)
      )
        throw new HttpError(400, "Invalid item scope or text");
      if (
        e.type === "item" &&
        (!e.data?.id ||
          (!["assistant", "thinking", "tool", "notice"].includes(e.data.kind) &&
            e.data.id !== `user:${j.id}`))
      )
        throw new HttpError(400, "Invalid item");
      if (
        e.type === "status" &&
        !["running", "waiting"].includes(e.data.status)
      )
        throw new HttpError(400, "Invalid runtime status");
      const fresh =
        (e.type === "approval" || e.type === "item") &&
        !store.one("SELECT id FROM events WHERE id=?", e.id);
      // P4-06 (A-9): a tool action seen for the first time (by item, not event).
      const newTool =
        e.type === "item" &&
        e.data.kind === "tool" &&
        !store.one("SELECT 1 FROM items WHERE session_id=? AND id=?", j.session_id, e.data.id);
      // a permission prompt or an interception reaches the
      // owner's 「审批」 page (once: a resent event is not new). P2-03: the
      // card, its notice and its event in one transaction.
      broadcast(
        store.atomic(() => {
          const ev = store.append(j.session_id, e.type, e.data, e.id);
          if (fresh && e.type === "approval")
            ctx.approvalsHub?.nativeOpened(e.data);
          return ev;
        }),
      );
      // P4-06 (A-9): a turn an external task started — each tool action
      // audited with that task.
      if (newTool) auditExternalTool(store, j.session_id, e.data);
      // a sidecar's refusals are its read-only rules, no card.
      if (
        fresh &&
        e.type === "item" &&
        e.data.category === "interception" &&
        !store.session(j.session_id)?.sidecar
      )
        ctx.approvalsHub?.intercepted(j, e.data);
      // a checked tool went through — the classifier is back.
      if (e.type === "item" && e.data.kind === "tool")
        ctx.approvalsHub?.toolSucceeded(j, e.data);
      // the Runner handed (or could not hand) a native approval.
      if (e.type === "item")
        nativeApprovalHandled(store, j.session_id, e.data.id, e.data.status);
    }
    return { ok: true };
  });
  app.post("/jobs/:id/recover", async (req: any) => {
    const n = node(req),
      j = store.one("SELECT * FROM jobs WHERE id=?", req.params.id);
    if (!j || j.node_id !== n.id || j.lease !== req.headers["x-lease"])
      throw new LocalizedError(403, "recovery_mismatch", "server-app.job.recoveryMismatch");
    const s = store.session(j.session_id);
    if (!s || s.deleting) throw new LocalizedError(410, "gone", "server-app.session.deleted");
    const b = z
      .object({
        final: z.boolean().default(true),
        result: z.object({
          status: z.enum(["idle", "error", "interrupted"]),
          detail: z.string().max(10000).optional(),
        }),
        events: z
          .array(
            z.object({
              id: z.string().max(100),
              type: z.enum(["item", "status", "approval", "native", "live"]),
              data: z.any(),
            }),
          )
          .max(20),
      })
      .parse(req.body);
    for (const e of b.events) {
      if (
        e.type === "item" &&
        (!e.data ||
          typeof e.data.text !== "string" ||
          e.data.text.length > 300000 ||
          typeof e.data.id !== "string" ||
          (!e.data.id.startsWith(j.id + ":") &&
            e.data.id !== `user:${j.id}` &&
            !sessionJob(e.data.id, j.session_id)))
      )
        throw new LocalizedError(400, "recovery_out_of_scope", "server-app.job.recoveryOutOfScope");
    }
    store.atomic(() => {
      for (const e of b.events)
        store.run(
          "INSERT OR IGNORE INTO job_recovery_events(job_id,event_id,data) VALUES(?,?,?)",
          j.id,
          e.id,
          JSON.stringify(e),
        );
    });
    if (!b.final) return { recorded: false, chunkReceived: true };
    const recovered = store
      .all(
        "SELECT data FROM job_recovery_events WHERE job_id=? ORDER BY seq",
        j.id,
      )
      .map((r) => JSON.parse(r.data));
    // Late evidence never overwrites a new execution, resurrects canceled work or runs tools.
    if (
      j.status === "running" &&
      !j.cancel &&
      j.lease_until >= Date.now()
    ) {
      for (const e of recovered)
        if (
          e.type === "item" &&
          ["assistant", "thinking", "tool", "notice"].includes(e.data.kind) &&
          e.data.id.startsWith(j.id + ":")
        )
          publish(j.session_id, e.type, e.data, e.id);
      settle(j, b.result.status, b.result.detail);
      return { recorded: true, accepted: true };
    }
    if (j.status === "completed" && recovered.length === 0)
      return { recorded: true, accepted: true };
    store.run(
      "INSERT OR IGNORE INTO job_recoveries VALUES(?,?,?,?)",
      j.id,
      j.session_id,
      JSON.stringify({ result: b.result }),
      Date.now(),
    );
    publish(j.session_id, "item", {
      id: `recovery:${j.id}`,
      kind: "notice",
      text: ownerT()("server-app.job.recoveryFound"),
      createdAt: Date.now(),
    });
    return { recorded: true, accepted: false };
  });
  // The Runner's generated title: only for its own node's session,
  // only while the title is still the placeholder, and only once.
  // `source: "native"`: the native session was renamed (by its owner,
  // in the CLI / app) — the owner's title, unless Daisy's own title changed
  // since the Runner last saw it (`base`): a rename here always wins.
  app.post("/sessions/:id/title", async (req) => {
    const n = node(req),
      b = z
        .object({
          title: z.string().max(500),
          stage: z.enum(["final"]).optional(),
          /** This attempt failed: the next round may retry at once. */
          failed: z.boolean().optional(),
          source: z.enum(["native"]).optional(),
          /** The Daisy title the Runner knew when the native one changed. */
          base: z.string().max(500).optional(),
        })
        .parse(req.body),
      sid = (req.params as any).id;
    const out = store.atomic(() => {
      const s = store.session(sid);
      if (!s || s.nodeId !== n.id) throw new LocalizedError(404, "session_not_found", "server-app.session.notFound");
      if (b.source === "native") {
        const title = nativeTitle(b.title);
        // Compared as the native side sees names (one line, trimmed).
        if (
          !title ||
          isDaisyForkTitle(title) ||
          s.archived ||
          s.sidecar ||
          title === nativeTitle(s.title) ||
          (s.titleStage === "manual" &&
            nativeTitle(s.title) !== nativeTitle(b.base))
        )
          return { ok: true, applied: false, title: s.title };
        s.title = title;
        s.titleAuto = false;
        s.titleStage = "manual";
        delete s.titleAskedAt;
        s.updatedAt = Date.now();
        store.save(s);
        return { ok: true, applied: true, title };
      }
      const title = sanitizeTitle(b.title);
      if (!s.titleAuto || s.titleStage || !title) {
        if (b.failed && s.titleAuto && !s.titleStage && s.titleAskedAt) {
          delete s.titleAskedAt;
          store.save(s);
        }
        return { ok: true, applied: false };
      }
      s.title = title;
      s.titleAuto = false;
      s.titleStage = "final";
      delete s.titleAskedAt;
      s.updatedAt = Date.now();
      store.save(s);
      return { ok: true, applied: true, title };
    });
    if (out.applied) touched(sid);
    return out;
  });
  /**
   * A steer handed back that Claude Code then took
   * after all — withdraw its requeued turn if it has not started. Node
   * auth only (its job may have ended): the input must be this node's.
   */
  /**
   * what the agent did with an appended Daisy job — `started`
   * (read; `ownTurn`: as a turn of its own after the running one, counted
   * as a self-run turn), `completed`, `cancelled` (「移除」 got it back),
   * `kept` (it could not). Node auth only: the job may have ended.
   */
  app.post("/inputs/:mid/state", async (req) => {
    const n = node(req),
      b = z
        .object({
          state: z.enum(["started", "completed", "cancelled", "kept"]),
          ownTurn: z.boolean().optional(),
        })
        .parse(req.body);
    const events: (Event | null)[] = [];
    const r = store.atomic(() => {
      const input = store.one(
        "SELECT i.* FROM live_inputs i JOIN jobs j ON j.id=i.job_id WHERE i.id=? AND j.node_id=?",
        (req.params as any).mid,
        n.id,
      );
      if (!input) throw new LocalizedError(404, "message_not_found", "server-app.message.notFound");
      const emit = (sid: string, t: any, d: any) =>
        events.push(store.append(sid, t, d));
      // Follow-up 2026-11-09: a plain 立即追加 the model read — its bubble
      // 「已交给 Agent…」 → 「Agent 已读取」 (only once handed over and not
      // handed back; anything else about it is not the Runner's to say).
      if (!input.source_job) {
        if (b.state !== "started") throw new LocalizedError(404, "message_not_found", "server-app.message.notFound");
        if (input.status !== "accepted") return null;
        const sid = store.one(
          "SELECT session_id FROM jobs WHERE id=?",
          input.job_id,
        )?.session_id;
        const old = store.one(
          "SELECT data FROM items WHERE session_id=? AND id=?",
          sid,
          `input:${input.id}`,
        );
        // Review L1: a repeated report changes nothing (no new event).
        if (sid && old && JSON.parse(old.data).delivery !== "read")
          emit(sid, "item", {
            ...JSON.parse(old.data),
            status: "accepted",
            delivery: "read",
          });
        return null;
      }
      // Settle handed it back (not read by then) and
      // the agent reads it after all — out of the queue, not run twice.
      if (
        b.state === "started" &&
        input.status === "requeued" &&
        input.source_job
      ) {
        // Usually the next turn already took it in line (queued, not yet
        // claimed by a Runner): still not run — withdrawn the same way, and
        // the queue goes on with what comes after it.
        const back = store.one(
          "SELECT * FROM jobs WHERE id=?",
          input.source_job,
        );
        const unclaimed =
          back?.status === "queued" && !back.lease && !back.cancel;
        if (unclaimed)
          store.run("UPDATE jobs SET status='pending' WHERE id=?", back.id);
        const done = withdrawRequeued(store, input, emit);
        if (unclaimed && done === "withdrawn") {
          const next = nextPending(store, back.session_id);
          if (next) {
            const wasJump = jumpedList(store, back.session_id).includes(next);
            forgetJump(store, back.session_id, next);
            store.run("UPDATE jobs SET status='queued' WHERE id=?", next);
            if (wasJump) markJumpStarted(store, back.session_id, next);
          }
          emit(back.session_id, "status", {
            status: next ? "queued" : "idle",
          });
        } else if (unclaimed)
          store.run("UPDATE jobs SET status='queued' WHERE id=?", back.id);
        return null;
      }
      const res = appendState(
        store,
        input,
        b.state,
        !!b.ownTurn,
        emit,
        (job) => {
          const s = store.session(job.session_id);
          if (s) ctx.commands.dropQueued(s, job);
        },
      );
      // read after its turn settled — done now.
      if (!res && input.source_job && b.state !== "kept")
        settleLateRead(input.source_job);
      return res;
    });
    events.forEach(broadcast);
    if (r)
      throw r === "stale"
        ? new LocalizedError(409, "append_settled", "server-app.append.settled")
        : new LocalizedError(409, "append_not_withdrawing", "server-app.append.notWithdrawing");
    return { ok: true };
  });
  app.post("/inputs/:mid/withdraw", async (req) => {
    const n = node(req);
    const events: (Event | null)[] = [];
    const r = store.atomic(() => {
      const input = store.one(
        "SELECT i.* FROM live_inputs i JOIN jobs j ON j.id=i.job_id WHERE i.id=? AND j.node_id=?",
        (req.params as any).mid,
        n.id,
      );
      if (!input) throw new LocalizedError(404, "message_not_found", "server-app.message.notFound");
      return withdrawRequeued(store, input, (sid, t, d) =>
        events.push(store.append(sid, t, d)),
      );
    });
    events.forEach(broadcast);
    return { ok: true, result: r };
  });
  app.post("/jobs/:id/complete", async (req) => {
    const n = node(req),
      existing = store.one(
        "SELECT * FROM jobs WHERE id=?",
        (req.params as any).id,
      );
    if (
      existing &&
      existing.node_id === n.id &&
      existing.lease === req.headers["x-lease"] &&
      !["queued", "running"].includes(existing.status)
    ) {
      ctx.wakes.deliver();
      const desired =
        (req.body as any)?.status === "idle"
          ? "completed"
          : (req.body as any)?.status;
      // The first receipt was lost: the Runner never saw its title request.
      const again =
        existing.status === "completed" && desired === "completed"
          ? titleRequest(existing.id, existing.session_id, true)
          : null;
      return {
        ok: true,
        status: existing.status,
        accepted: existing.status === desired,
        ...(again ? { titleRequest: again } : {}),
      };
    }
    const j = ownedJob(req),
      b = z
        .object({
          status: z.enum(["idle", "error", "interrupted"]),
          detail: z.string().max(10000).optional(),
          /** steers the Agent did not take, handed back. */
          requeue: z
            .array(
              z.object({
                id: z.string().max(100),
                reason: z.string().max(500),
              }),
            )
            .max(50)
            .optional(),
        })
        .parse(req.body);
    // Review M2: a turn that ended by itself before a jump's stop reached
    // it stays completed (the jumped message then goes next).
    const done = j.cancel === 2 && b.status === "idle";
    settle(j, j.cancel && !done ? "interrupted" : b.status, b.detail, {
      requeue: b.requeue,
    });
    const title =
      (!j.cancel || done) && b.status === "idle"
        ? titleRequest(j.id, j.session_id)
        : null;
    return title ? { ok: true, titleRequest: title } : { ok: true };
  });
}
