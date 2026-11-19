import { agentShortName, isAcpAgent } from "../../../contracts/src/acp-harnesses.ts";
import { PRODUCT_NAME } from "../../../contracts/src/names.ts";
import { z } from "zod";
import { id, type Store } from "../store/index.ts";
import type { RunnerPort } from "../app/runner-port.ts";
import { requeueLiveInput } from "./steer-requeue.ts";
import {
  residentHeld,
  RESIDENT_PAUSED_CODE,
  RESIDENT_PAUSED_KEY,
} from "../../../contracts/src/scheduler.ts";
import {
  forgetJump,
  jumpBlocked,
  jumpedList,
  jumpStarted,
  jumpWhy,
  markJumpStarted,
  nextPending,
  notOwnersTurn,
  othersJob,
  recordJump,
  takeJump,
} from "./queue-jump.ts";
import {
  applyPlan,
  carriedParts,
  carrierRank,
  mergeSeparator,
  mergeBlocker,
  mergeKind,
  mergePlan,
  restoreCarried,
  mergedIntoInput,
  mergedParts,
  mergeInto,
  removedWithParts,
  steerable,
} from "./queue-merge.ts";
import { takeNativeApprovals } from "../approvals/native-approvals.ts";
import { serve } from "../app/serve.ts";
import {
  operationFeature,
  requireFeatures,
  sessionFeatures,
} from "./features.ts";
import { api } from "../../../contracts/src/api/index.ts";
import {
  OPERATION_NAMES,
  RewindCountSchema,
} from "../../../contracts/src/api/operations.ts";
import { ownerTurn } from "../approvals/bypass-policy.ts";
import {
  appendBlocker,
  versionOnlyBlock,
  appendJob,
  appendPayload,
  appendView,
  appendedWhy,
  appendRead,
  autoAppend,
  autoAppendable,
  daisySteer,
  daisyWake,
  removeAppended,
  inputCaps,
  turnFit,
  dropQueuedJob,
  midTurnLead,
  sourceOf,
} from "./native-append.ts";
import {
  type QueueJumpResult,
  type Session,
} from "../../../contracts/src/index.ts";
import { isFallback } from "../../../contracts/src/agent-capabilities.ts";
import { traceForNewTurn } from "../observe/trace.ts";
import { isLocalized, LocalizedError, type MsgParams } from "../app/errors.ts";
import type { MessageKey, Translate } from "../../../contracts/src/i18n.ts";
import { ownerT, inSessionT } from "../platform/language.ts";
const fail = (code: number, message: string, why?: string): never => {
  throw Object.assign(Error(message), {
    statusCode: code,
    ...(why ? { apiCode: why } : {}),
  });
};
/** An error by message key (said in the request's language), with its stable code. */
const failK = (status: number, code: string, key: MessageKey, params?: MsgParams): never => {
  throw new LocalizedError(status, code, key, params);
};
/**
 * ADR-152: a rewind result's `files.via` as the current code writes it —
 * a Runner before the rename (or a result stored then) says `"harbor"`
 * for Daisy's own checkpoints, read as `"fallback"`.
 */
export function normalizeOperationResult<T>(r: T): T {
  const f = (r as any)?.files;
  return f && typeof f === "object" && f.via === "harbor"
    ? ({ ...(r as any), files: { ...f, via: "fallback" } } as T)
    : r;
}
/** Why a file was not rewound (`server-sessions.rewind.why.<reason>`; an unknown reason as it is). */
const whyText = (t: Translate, why: string): string =>
  t.has(`server-sessions.rewind.why.${why}`) ? t.dynamic(`server-sessions.rewind.why.${why}`) : why;
const names = (t: Translate, list: string[], n = list.length) => {
  const names = list.slice(0, 5).join(t("server-sessions.rewind.separator"));
  return n > 5 ? t("server-sessions.rewind.namesMore", { names, n }) : names;
};
/**
 * the notice after a 「回退」 — what happened to the history (in
 * place, or a copy up to the cut) and, said plainly, to the files.
 * Codex's files come from Daisy's checkpoints (`via: fallback`,
 * or `harbor` from before ADR-152):
 * what was not restored, and what commands / others changed, are named.
 * In the session's language (`t`; default the owner's).
 */
export function rewindNotice(count: number, result: any, agent: string, t: Translate = ownerT()) {
  const f = result?.files;
  const fallback = isFallback(f?.via);
  const skipped: { path: string; why: string }[] = Array.isArray(f?.notRestored)
    ? f.notRestored
    : [];
  const others: string[] = Array.isArray(f?.others) ? f.others : [];
  const skippedList = skipped
    .slice(0, 5)
    .map((x) => t("server-sessions.rewind.skippedItem", { path: x.path, why: whyText(t, x.why) }))
    .join(t("server-sessions.rewind.separator"));
  const othersN = Number(f?.othersCount) || others.length;
  const extra =
    (skipped.length
      ? t(skipped.length > 5 ? "server-sessions.rewind.skippedMore" : "server-sessions.rewind.skipped", {
          n: skipped.length,
          list: skippedList,
        })
      : "") +
    (others.length ? t("server-sessions.rewind.others", { n: othersN, names: names(t, others, othersN) }) : "");
  const changed = Array.isArray(f?.filesChanged) ? f.filesChanged.length : 0;
  const files = f?.reverted
    ? fallback
      ? t("server-sessions.rewind.files.fallback", { n: changed, extra })
      : t("server-sessions.rewind.files.native", { n: changed })
    : fallback
      ? f.reason === "no-checkpoint"
        ? t("server-sessions.rewind.files.noCheckpoint", { extra })
        : f.reason === "nothing"
          ? t("server-sessions.rewind.files.nothing", { extra })
          : f.reason === "unsupported"
            ? t("server-sessions.rewind.files.snapshotsOff", { extra })
            : t("server-sessions.rewind.files.reason", { reason: String(f.reason || "").slice(0, 120), extra })
      : (agent === "codex" || isAcpAgent(agent)) &&
          (!f || f.reason === "unsupported")
        ? t("server-sessions.rewind.files.agentUnsupported", { agent: agentShortName(agent) })
        : f?.reason === "offline"
          ? t("server-sessions.rewind.files.offline")
          : f?.reason === "background"
            ? t("server-sessions.rewind.files.background")
            : f?.reason === "nothing"
              ? t("server-sessions.rewind.files.nothing", { extra: "" })
              : f?.reason && f.reason !== "not-asked"
                ? t("server-sessions.rewind.files.reason", { reason: String(f.reason).slice(0, 120), extra: "" })
                : t("server-sessions.rewind.files.none");
  return t(result?.inPlace ? "server-sessions.rewind.noticeInPlace" : "server-sessions.rewind.notice", { count, files });
}
const RUNS = new Set(["fork", "rewind", "compact", "review", "terminal"]);
/**
 * What runs the model or the shell is refused for a
 * paused resident; reading (catalog, models, config…) still works.
 */
const refusePaused = (s: Session) => {
  if (!s.archived && residentHeld(s))
    throw new LocalizedError(409, RESIDENT_PAUSED_CODE, RESIDENT_PAUSED_KEY);
};
/** P1-06: the list lives with the route's definition. */
const operations = OPERATION_NAMES;
export function commandRoutes(
  app: any,
  /** P1-02: the in-process Runner's calls (were /api/runner/*). */
  runner: RunnerPort,
  store: Store,
  session: (r: any, id: string) => Session,
  ownedJob: (r: any) => any,
  publish: (sid: string, type: any, data: any) => any,
  hooks: { tidyAppends?: (s: Session) => void } = {},
) {
  const checkProfile = (s: Session) => {
    if (
      !store.one(
        "SELECT id FROM profiles WHERE id=? AND owner_id=?",
        s.profileId,
        s.ownerId,
      )
    )
      failK(409, "profile_gone", "server-sessions.op.error.profileGone");
    if (
      store.one("SELECT revoked_at FROM nodes WHERE id=?", s.nodeId)?.revoked_at
    )
      failK(409, "node_revoked", "server-sessions.op.error.nodeRevoked");
  };
  const O = api.operations;
  // P1-03 (ADR-110): one handler, two definitions — session operations
  // (`daisy:session:write`) and the harness-configuration ones
  // (`daisy:manage`); each parses its own body, so neither takes the
  // other's names.
  const runOperation = (
    def: typeof O.operation | typeof O.harnessConfig | typeof O.terminalOpen,
  ) => async (req: any) => {
    const s = session(req, req.params.id);
    checkProfile(s);
    const b = def.body.parse(req.body) as { requestId: string; name: (typeof OPERATION_NAMES)[number]; args: Record<string, unknown> };
    if (JSON.stringify(b.args).length > 200000) failK(413, "operation_too_large", "server-sessions.op.error.argsTooLarge");
    if (s.archived) failK(409, "session_archived", "server-sessions.op.error.archived");
    if (RUNS.has(b.name)) refusePaused(s);
    const existing = store.one(
      "SELECT id,session_id FROM jobs WHERE request_id=? AND node_id=?",
      `op:${s.id}:${b.requestId}`,
      s.nodeId,
    );
    if (existing) return { id: existing.id, sessionId: existing.session_id };
    // P4-11 (§5.5, C-3): only what the session's AI declares.
    requireFeatures(store, s, ...operationFeature(b.name, b.args));
    if (
      store.one(
        "SELECT id FROM jobs WHERE session_id=? AND status IN ('queued','running','pending')",
        s.id,
      )
    )
      failK(409, "session_busy", "server-sessions.op.error.busy");
    if (
      store.one(
        "SELECT id FROM logins WHERE profile_id=? AND status IN ('queued','running','waiting') AND expires>?",
        s.profileId,
        Date.now(),
      )
    )
      failK(409, "login_in_progress", "server-sessions.op.error.loggingIn");
    if (["fork", "rewind", "compact"].includes(b.name) && !s.nativeId)
      failK(409, "no_native_session", "server-sessions.op.error.noNative");
    let target = s;
    const jid = id();
    store.atomic(() => {
      if (b.name === "fork") {
        target = {
          ...s,
          id: id(),
          nativeId: null,
          title: String(b.args.title || ownerT()("server-sessions.op.forkTitle", { title: s.title })).slice(0, 200),
          status: "queued",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        store.save(target);
        for (const item of store.snapshot(s.id).items)
          store.append(target.id, "item", item);
        b.args = { sourceNativeId: s.nativeId };
      }
      if (b.name === "rewind") {
        const count = RewindCountSchema.parse(b.args.count || 1);
        const users = store
          .all(
            "SELECT rowid,data FROM items WHERE session_id=? AND json_extract(data,'$.kind')='user' ORDER BY rowid",
            s.id,
          )
          .filter((row: any) => {
            const item = JSON.parse(row.data);
            return (
              (!item.status || item.status === "accepted") &&
              (s.agent !== "codex" || item.id.startsWith("user:"))
            );
          });
        // Edit and resend: rewind to just before one message.
        const itemId = typeof b.args.itemId === "string" ? b.args.itemId : null;
        const at = itemId
          ? users.findIndex((row: any) => JSON.parse(row.data).id === itemId)
          : users.length - count;
        if (itemId && at < 0) failK(400, "item_not_in_conversation", "server-sessions.op.error.notInConversation");
        if (!itemId && count > users.length) failK(400, "rewind_too_far", "server-sessions.op.error.rewindTooFar");
        const selected = users[at],
          native = JSON.parse(selected.data).native;
        // also restore the files the AI's edit tools changed
        // (Claude Code, live process; reported in the notice either way).
        const files = b.args.files === true;
        b.args = {
          count: users.length - at,
          cutoff: selected.rowid,
          ...(files ? { files: true } : {}),
          ...(s.agent === "codex" && native?.turnId
            ? { beforeTurnId: native.turnId }
            : {}),
          ...(s.agent === "claude" && native?.uuid
            ? { beforeUuid: native.uuid }
            : {}),
        };
      }
      store.run(
        "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,trace) VALUES(?,?,?,?,?,?,?,?,?)",
        jid,
        target.id,
        s.nodeId,
        `op:${s.id}:${b.requestId}`,
        "",
        "[]",
        "queued",
        Date.now(),
        traceForNewTurn(),
      );
      store.run(
        "INSERT INTO job_operations(job_id,data) VALUES(?,?)",
        jid,
        JSON.stringify(
          ["config.write", "mcp.add", "skill.write"].includes(b.name)
            ? {
                name: b.name,
                encryptedArgs: store.encrypt(JSON.stringify(b.args)),
              }
            : { name: b.name, args: b.args },
        ),
      );
      publish(target.id, "status", { status: "queued" });
      if (b.name === "compact")
        store.run("UPDATE live_sessions SET stop=0 WHERE session_id=?", s.id);
      store.audit(s.ownerId, "agent.operation." + b.name, target.id);
    });
    return { id: jid, sessionId: target.id };
  };
  serve(app, O.operation, runOperation(O.operation));
  serve(app, O.harnessConfig, runOperation(O.harnessConfig));
  serve(app, O.terminalOpen, runOperation(O.terminalOpen));
  serve(app, O.operationStatus, async (req: any) => {
    const s = session(req, req.params.id);
    const j = store.one(
      "SELECT j.status,o.result FROM jobs j JOIN job_operations o ON j.id=o.job_id WHERE j.id=? AND j.session_id=?",
      req.params.jid,
      s.id,
    );
    if (!j) failK(404, "operation_not_found", "server-sessions.op.error.notFound");
    return {
      status: j.status,
      result: j.result ? normalizeOperationResult(JSON.parse(j.result)) : null,
    };
  });
  runner.post("/jobs/:id/operation-result", async (req: any) => {
    const j = ownedJob(req),
      op = store.one("SELECT * FROM job_operations WHERE job_id=?", j.id);
    if (!op) failK(409, "not_an_operation", "server-sessions.op.error.notOperation");
    if (op.result) return { ok: true };
    const encoded = JSON.stringify(normalizeOperationResult(req.body));
    if (encoded.length > 1000000) failK(413, "operation_result_too_large", "server-sessions.op.error.resultTooLarge");
    const action = JSON.parse(op.data);
    store.atomic(() => {
      store.run(
        "UPDATE job_operations SET result=? WHERE job_id=?",
        encoded,
        j.id,
      );
      if (["catalog", "models"].includes(action.name) && !req.body.error) {
        const s = store.session(j.session_id)!;
        s.commandCatalog = req.body;
        s.updatedAt = Date.now();
        store.save(s);
        // the identity's list, for the resident wizard.
        saveProfileCatalog(store, s.profileId, req.body);
      }
      if (action.name === "rewind" && !req.body.error) {
        store.run(
          "DELETE FROM items WHERE session_id=? AND rowid>=?",
          j.session_id,
          action.args.cutoff,
        );
        const s = store.session(j.session_id)!;
        if (
          !store.one(
            "SELECT id FROM items WHERE session_id=? AND json_extract(data,'$.kind')='user'",
            s.id,
          )
        ) {
          s.contextDelivered = false;
          store.save(s);
        }
        publish(j.session_id, "item", {
          id: id(),
          kind: "notice",
          text: rewindNotice(
            action.args.count,
            req.body,
            store.session(j.session_id)?.agent || "",
            inSessionT(store.session(j.session_id)),
          ),
          createdAt: Date.now(),
        });
      }
    });
    return { ok: true };
  });
  serve(app, O.steer, async (req: any) => {
    const s = session(req, req.params.id);
    checkProfile(s);
    const b = O.steer.body.parse(req.body);
    // P4-11: was `agent === "kimi"` — the declared 运行中追加.
    requireFeatures(store, s, "steer");
    const j = store.one(
      "SELECT j.* FROM jobs j LEFT JOIN job_operations o ON o.job_id=j.id WHERE j.session_id=? AND j.status='running' AND o.job_id IS NULL",
      s.id,
    );
    if (!j || j.cancel) failK(409, "no_active_turn", "server-sessions.queue.error.noActiveTurn");
    const old = store.one(
      "SELECT id,status FROM live_inputs WHERE job_id=? AND request_id=?",
      j.id,
      b.requestId,
    );
    if (old) return old;
    // her words never go into someone else's turn
    // (a group request, 快速了解, the AI's own, a Daisy wake's): first in
    // the queue after it instead, saying why.
    const why = turnFit(store, j, {
      id: "",
      session_id: s.id,
      request_id: b.requestId,
      origin: null,
    });
    if (why) {
      const prior = store.one(
        "SELECT id,status FROM jobs WHERE session_id=? AND request_id=?",
        s.id,
        b.requestId,
      );
      if (prior)
        return { id: prior.id, status: "pending", queued: true, reason: why };
      const jid = id();
      store.atomic(() => {
        store.run(
          "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,context,trace) VALUES(?,?,?,?,?,?,?,?,?,?)",
          jid,
          s.id,
          s.nodeId,
          b.requestId,
          b.text,
          "[]",
          "pending",
          Date.now(),
          b.context ? JSON.stringify(b.context) : null,
          traceForNewTurn(),
        );
        store.noteContext(s.id, b.context);
        recordJump(store, s.id, jid, null, why);
        publish(s.id, "item", {
          id: `user:${jid}`,
          kind: "user",
          text: b.text,
          status: "queued",
          attachments: [],
          ...(b.context ? { context: b.context } : {}),
          createdAt: Date.now(),
        });
      });
      return {
        id: jid,
        status: "pending",
        queued: true,
        reason: ownerT()("server-sessions.queue.afterThisTurn", { why }),
      };
    }
    const mid = id();
    store.atomic(() => {
      store.run(
        "INSERT INTO live_inputs(id,job_id,request_id,text,status,created,context) VALUES(?,?,?,?,?,?,?)",
        mid,
        j.id,
        b.requestId,
        b.text,
        "queued",
        Date.now(),
        b.context ? JSON.stringify(b.context) : null,
      );
      store.noteContext(s.id, b.context);
      publish(s.id, "item", {
        id: `input:${mid}`,
        kind: "user",
        text: b.text,
        status: "queued",
        ...(b.context ? { context: b.context } : {}),
        createdAt: Date.now(),
      });
    });
    return { id: mid, status: "queued" };
  });
  runner.post("/jobs/:id/input/claim", async (req: any) => {
    const j = ownedJob(req);
    return store.atomic(() => {
      // Daisy wakes waiting in the queue go into this turn by
      // themselves (one per claim; the Runner asks every second) — only a
      // Runner whose adapter appends natively (it reported agentFeatures).
      if (
        !j.cancel &&
        j.status === "running" &&
        !store.one(
          "SELECT 1 FROM live_inputs WHERE job_id=? AND status='queued'",
          j.id,
        )
      ) {
        const s = store.session(j.session_id);
        if (s && !s.archived && !s.deleting) autoAppend(store, s, j, publish);
      }
      const m = store.one(
        "SELECT * FROM live_inputs WHERE job_id=? AND status='queued' ORDER BY created,rowid LIMIT 1",
        j.id,
      );
      if (!m || j.cancel) return { input: null };
      const source = sourceOf(store, m);
      if (m.source_job && source?.status !== "appended") {
        // Stopped / removed before the Runner took it.
        store.run("UPDATE live_inputs SET status='cancelled' WHERE id=?", m.id);
        return { input: null };
      }
      store.run("UPDATE live_inputs SET status='dispatched' WHERE id=?", m.id);
      // her words read as come mid-turn (agent-facing
      // only; the stored text and her bubble stay as written).
      const lead = midTurnLead(store, m, source);
      const payload = source ? appendPayload(store, source, j, lead) : null;
      return {
        input: {
          id: m.id,
          text: source ? m.text : `${lead}${m.text}`,
          ...(m.context ? { context: JSON.parse(m.context) } : {}),
          // a Daisy job, as its own turn would have it.
          ...(payload
            ? {
                job: {
                  ...payload,
                  // her native 「允许并重试」 ride her own input
                  // into her own turn only.
                  ...((ownerTurn(j) &&
                    (() => {
                      const n = takeNativeApprovals(store, source);
                      return n ? { nativeApprovals: n } : null;
                    })()) ||
                    {}),
                },
              }
            : {}),
        },
      };
    });
  });
  /** Follow-up 2026-11-09: the node's Runner reports 立即追加 reads. */
  const readsReported = (nodeId: string) => {
    try {
      return (
        JSON.parse(
          store.one("SELECT capabilities FROM nodes WHERE id=?", nodeId)
            ?.capabilities || "{}",
        )?.runner?.inputReads === true
      );
    } catch {
      return false;
    }
  };
  runner.post("/jobs/:id/input/:mid/complete", async (req: any) => {
    const j = ownedJob(req),
      b = z.object({ error: z.string().max(2000).optional() }).parse(req.body);
    const m = store.one(
      "SELECT * FROM live_inputs WHERE id=? AND job_id=?",
      req.params.mid,
      j.id,
    );
    if (!m) failK(404, "message_not_found", "server-sessions.queue.error.messageNotFound");
    if (["accepted", "error"].includes(m.status)) return { ok: true };
    if (m.source_job) {
      // an appended Daisy job — the agent holds it (its bubble
      // already reads 「已追加，等待 AI 读取」), or it could not take it:
      // back to the head of Daisy's queue.
      if (m.status !== "dispatched") return { ok: true };
      store.atomic(() => {
        if (b.error) requeueLiveInput(store, j.session_id, m, b.error, publish);
        else
          store.run(
            "UPDATE live_inputs SET status='accepted',result=? WHERE id=?",
            JSON.stringify(b),
            m.id,
          );
      });
      return { ok: true };
    }
    if (m.status !== "dispatched") failK(409, "message_not_dispatched", "server-sessions.queue.error.notDispatched");
    store.atomic(() => {
      store.run(
        "UPDATE live_inputs SET status=?,result=? WHERE id=?",
        b.error ? "error" : "accepted",
        JSON.stringify(b),
        m.id,
      );
      publish(j.session_id, "item", {
        id: `input:${m.id}`,
        kind: "user",
        text: m.text,
        status: b.error ? "error" : "accepted",
        // Follow-up 2026-11-09 (a user misread a stall): the agent has
        // it (Claude: queued for its next tool boundary), not read yet —
        // 「已读取」 follows from the Runner (`/inputs/:mid/state` started).
        // Only from a Runner that reports the read (else 「已接收」 as before).
        ...(!b.error && readsReported(j.node_id) ? { delivery: "handed" } : {}),
        ...(m.context ? { context: JSON.parse(m.context) } : {}),
        createdAt: m.created,
      });
      publish(j.session_id, "item", {
        id: `input-result:${m.id}`,
        kind: "tool",
        category: "lifecycle",
        name: inSessionT(store.session(j.session_id))(
          b.error ? "server-sessions.queue.appendFailed" : "server-sessions.queue.appendHandedOver",
        ),
        text: b.error || "",
        status: b.error ? "error" : "complete",
        createdAt: Date.now(),
      });
    });
    return { ok: true };
  });
  /**
   * the Agent did not take a steer after all (never acknowledged,
   * or taken and then cancelled with its turn) — the Runner hands it back
   * and it becomes the next turn with a visible note. Idempotent.
   */
  runner.post("/jobs/:id/input/:mid/requeue", async (req: any) => {
    const j = ownedJob(req),
      b = z.object({ reason: z.string().max(500).optional() }).parse(req.body);
    store.atomic(() => {
      const m = store.one(
        "SELECT * FROM live_inputs WHERE id=? AND job_id=?",
        req.params.mid,
        j.id,
      );
      if (!m) failK(404, "message_not_found", "server-sessions.queue.error.messageNotFound");
      if (m.status === "requeued") return;
      if (!["dispatched", "accepted", "error"].includes(m.status))
        failK(409, "message_not_dispatched", "server-sessions.queue.error.notDispatched");
      requeueLiveInput(
        store,
        j.session_id,
        m,
        b.reason || ownerT()("server-sessions.queue.agentNotTaken"),
        publish,
      );
    });
    return { ok: true };
  });
  serve(app, O.queue, async (req: any) => {
    const s = session(req, req.params.id);
    // appended jobs whose turn is over are settled first (app.ts
    // tidyAppends) — only when the owner reads. P1-03 (ADR-110): an AI's
    // working credential reads (`aiSelf`, daisy:session:read) and writes
    // nothing: its read skips the tidy; the next read by the owner (or
    // the turn's own settle) does it.
    if (req.daisyPrincipal?.kind !== "ai") hooks.tidyAppends?.(s);
    const rows = store.all(
      "SELECT id,text,status,created,request_id,origin,attachments,terminal,preamble FROM jobs WHERE session_id=? AND status='pending' ORDER BY created,rowid",
      s.id,
    );
    // R #7: the jumped messages first, in jump order, marked.
    const jumped = jumpedList(store, s.id);
    // why 插队 cannot start now, on every card (no failing button).
    const blocked = jumpBlocked(store, s.id);
    // a jump never stops the running turn now, so there is no
    // subagent warning (`runningSubagents`) to give.
    // Jobs delivered into the running turn, not read yet, come first.
    const appended = store.all(
      "SELECT id,text,status,created,request_id,origin,attachments,terminal,preamble FROM jobs WHERE session_id=? AND status='appended' ORDER BY created,rowid",
      s.id,
    );
    // a jumped row that could not go in with the jump ahead of it
    // runs in a later turn — say so (`nextTurn`), not a pending 插队.
    // Only the jump a stop is landing for (or, nothing running, the first)
    // goes out next; every other jumped row waits for a turn to finish —
    // also once that earlier turn is claimed and running.
    const ahead = store.one(
      "SELECT * FROM jobs WHERE session_id=? AND status IN ('queued','running')",
      s.id,
    );
    const direct = !ahead
      ? (jumped[0] ?? null)
      : ahead.status === "running" && ahead.cancel === 2
        ? takeJump(store, ahead)
        : null;
    const later = new Set(jumped.filter((jid) => jid !== direct));
    // Review: nothing runs (the queue paused after a stop / failure), or the
    // running turn is being stopped plainly (cancel=1, the queue then
    // pauses): nothing comes 「当前这一轮结束后」 by itself.
    const wait = !ahead
      ? "paused"
      : // Only the owner's own turn being stopped pauses the queue; someone
        // else's (a group request, a wake) ending lets it go on.
        ahead.status === "running" &&
          ahead.cancel === 1 &&
          !othersJob(store, ahead)
        ? "stopping"
        : null;
    // Hotfix 2: a Daisy wake waiting while a turn runs goes
    // into it by itself when it can (autoAppend, within a second) — no
    // 「下一轮」 then. One that cannot go in says why on its row, after this
    // turn, with no 插队 button that could only put it first in line (never
    // 「来源不同」 alone) — also while a native operation runs (review L2).
    // One that could but autoAppend will not take (given back once, setting
    // off: review L1) keeps its own label / 插队 button.
    const live = store.one(
      "SELECT * FROM jobs WHERE session_id=? AND status='running' AND cancel=0",
      s.id,
    );
    // P4-11: the declared 运行中追加 (was `agent !== "kimi"`).
    const steerDeclared = sessionFeatures(store, s).steer !== "none";
    const view = (r: any, jump: boolean) => {
      const { request_id, origin, attachments, terminal, preamble, ...row } = r;
      const job = { ...r, session_id: s.id };
      const wake = !!live && daisyWake(job);
      const wakeWhy = wake ? appendBlocker(store, s, job, live) : null;
      const wakeAuto = wake && !wakeWhy && autoAppendable(store, s, job, live);
      // 「合并追加」 can put it into the running turn natively
      // (the agent's own input queue) — the server's real eligibility.
      const appendable = !!live && !appendBlocker(store, s, job, live);
      // Review L6: whether 「合并追加」 really takes it into this turn — her
      // text when it fits the running turn (not Kimi), or natively.
      const steerIn =
        !!live &&
        steerDeclared &&
        (appendable || (steerable(store, job) && !turnFit(store, live, job)));
      const from = notOwnersTurn(store, job);
      // how many queued messages went into this one; whether
      // 「合并追加」 can take it (the owner's own plain text).
      const merged = mergedParts(store, r.id).length;
      // 「看不到排队的内容」: what rides along, to read before
      // deciding — each carried wake's own text (≤ 4000 characters).
      const carriedItems = carriedParts(store, r.id).map((p: any) => {
        const t = String(p.text || "");
        return {
          id: p.id,
          ...(notOwnersTurn(store, p)
            ? { from: notOwnersTurn(store, p)! }
            : {}),
          text: t.slice(0, 4000),
          ...(t.length > 4000 ? { truncated: true } : {}),
        };
      });
      return {
        ...row,
        ...(merged ? { merged } : {}),
        ...(carriedItems.length ? { carriedItems } : {}),
        ...(steerable(store, job) ? { steerable: true } : {}),
        ...(appendable ? { appendable: true } : {}),
        ...(live ? { steerIn } : {}),
        ...(jump ? { jump: true } : {}),
        ...(wakeWhy
          ? {
              nextTurn: true,
              nextTurnWhy: wakeWhy,
              ...(wait ? { nextTurnWait: wait } : {}),
            }
          : // It can go into the running turn: no 「下一轮」 (it goes in by
            // itself, or 插队 puts it in).
            jump && later.has(r.id) && !wakeAuto
            ? {
                nextTurn: true,
                ...(jumpWhy(store, r.id)
                  ? { nextTurnWhy: jumpWhy(store, r.id)! }
                  : {}),
                ...(wait ? { nextTurnWait: wait } : {}),
              }
            : {}),
        // Not the owner's words (a group request, a wake …): what it is.
        ...(from ? { from } : {}),
        ...(blocked ? { jumpBlocked: blocked } : {}),
      };
    };
    return [
      // a row the agent has read is part of the running turn, not
      // waiting — not listed (its bubble says 「Agent 已读取」 in the turn);
      // it leaves `appended` when that turn settles.
      ...appended
        .filter((r: any) => !appendRead(store, r.id))
        .map((r: any) => {
          const {
            request_id,
            origin,
            attachments,
            terminal,
            preamble,
            ...row
          } = r;
          const from = notOwnersTurn(store, { ...r, session_id: s.id });
          return {
            ...row,
            ...appendView(store, r.id),
            ...(from ? { from } : {}),
          };
        }),
      ...jumped
        .map((jid) => rows.find((r: any) => r.id === jid))
        .filter(Boolean)
        .map((r: any) => view(r, true)),
      ...rows
        .filter((r: any) => !jumped.includes(r.id))
        .map((r: any) => view(r, false)),
    ];
  });
  serve(app, O.queueResume, async (req: any) => {
    const s = session(req, req.params.id);
    checkProfile(s);
    if (s.archived) failK(409, "session_archived", "server-sessions.op.error.archived");
    refusePaused(s);
    return store.atomic(() => {
      if (
        store.one(
          "SELECT id FROM jobs WHERE session_id=? AND status IN ('queued','running')",
          s.id,
        )
      )
        failK(409, "session_running", "server-sessions.queue.error.running");
      const nid = nextPending(store, s.id);
      if (!nid) failK(404, "queue_empty", "server-sessions.queue.error.empty");
      const next = { id: nid! };
      forgetJump(store, s.id, next.id);
      store.run("UPDATE jobs SET status='queued' WHERE id=?", next.id);
      publish(s.id, "status", { status: "queued" });
      return { id: next.id };
    });
  });
  /**
   * 「插队发送」 — a queued message goes to the head
   * of the queue and starts now: the running turn is stopped with cancel=2
   * (settleJob then promotes the head instead of pausing the queue). The
   * message is the same job: attachments, context and terminal runs stay.
   * Older control planes / Runners only see `cancel` truthy (a plain stop).
   *
   * a jump while an earlier jump has not started yet (that turn is
   * being stopped for it, or it is queued and not claimed) goes in with it
   * — one message, one interruption — when both have the same provenance
   * (queue-merge.ts); otherwise it runs right after that turn and says so.
   * Inside a transaction.
   */
  function jumpOne(s: Session, j: any, active: any): QueueJumpResult {
    if (!active) {
      forgetJump(store, s.id);
      store.run("UPDATE jobs SET status='queued' WHERE id=?", j.id);
      markJumpStarted(store, s.id, j.id);
      publish(s.id, "status", { status: "queued" });
      return { id: j.id, mode: "started" };
    }
    const stopping = active.status === "running" && active.cancel === 2;
    const head =
      active.status === "queued" &&
      !active.lease &&
      jumpStarted(store, active.id);
    if (stopping || head) {
      // The jumps not started yet, in order; this one goes in with the last
      // (one that jumped already: the last one ahead of it).
      const list = jumpedList(store, s.id),
        at = list.indexOf(j.id);
      const chain = [
        ...(head ? [active.id] : []),
        ...(at >= 0 ? list.slice(0, at) : list),
      ];
      const tail = chain.length
        ? store.one("SELECT * FROM jobs WHERE id=?", chain[chain.length - 1])
        : null;
      if (!tail) {
        // The message that jumped for this stop was removed: this one is it.
        recordJump(store, s.id, j.id, active.id);
        return { id: j.id, mode: "interrupting" };
      }
      // Same kind → merged text; the owner's message and a Daisy wake
      // (callback, her approval decision, a timer) → her message carries
      // the wake as labelled context and takes its place (mixed selection).
      const plan = mergePlan(store, tail, j);
      if ("how" in plan) {
        const into = applyPlan(store, plan, publish);
        return {
          id: j.id,
          mode: "merged",
          into,
          ...(plan.how === "carry" ? { carried: [plan.wake.id] } : {}),
        };
      }
      recordJump(store, s.id, j.id, stopping ? active.id : null, plan.why);
      return {
        id: j.id,
        mode: "next",
        // Short (review): an older web adds 「；它之后紧接着发出」 itself.
        reason: plan.why,
      };
    }
    // Claimed by the queue but not started: it is not stopped; this one
    // is next (no `created` rewrite, review L4).
    if (active.status === "queued") {
      recordJump(store, s.id, j.id, null);
      return {
        id: j.id,
        mode: "next",
        reason: ownerT()("server-sessions.queue.turnStarting"),
      };
    }
    // 「要停就按停止，插入消息时不该打断」: a jump never
    // stops a running turn. Natively — into the agent's own input queue,
    // read at its next tool boundary in this same turn — when the agent
    // and the item allow (native-append.ts appendBlocker); otherwise first
    // in Daisy's queue, right after this turn, saying why. Merging: it
    // goes in with a jumped row still waiting there when it can.
    if (!active.cancel) {
      const why = appendBlocker(store, s, j, active);
      if (!why) {
        appendJob(store, s, j, active, publish);
        return { id: j.id, mode: "appended" };
      }
      // Hotfix: a Runner not updated yet (no agentFeatures) still takes the
      // owner's plain text as a 立即追加 (as before
      // native append) — into a turn of her own session only (turnFit).
      // Hotfix 3: also an updated Runner whose CLI is below the measured
      // version (steer `fallback`): her plain text only — wakes stay queued.
      if (
        sessionFeatures(store, s).steer !== "none" &&
        (!inputCaps(store, s) ||
          (!inputCaps(store, s)!.append && daisySteer(store, s))) &&
        steerable(store, j) &&
        // Only when the agent / node is the one blocker left (not a
        // sidecar, a native operation, a slash command …).
        versionOnlyBlock(why) &&
        !turnFit(store, active, j)
      ) {
        const mid = id();
        store.run(
          "INSERT INTO live_inputs(id,job_id,request_id,text,status,created,context) VALUES(?,?,?,?,?,?,?)",
          mid,
          active.id,
          `queue-merge:${j.id}`,
          j.text,
          "queued",
          Date.now(),
          j.context ?? null,
        );
        mergedIntoInput(store, j.id, mid, publish);
        publish(s.id, "item", {
          id: `input:${mid}`,
          kind: "user",
          text: j.text,
          status: "queued",
          ...(j.context ? { context: JSON.parse(j.context) } : {}),
          mergedFrom: [j.id],
          createdAt: Date.now(),
        });
        return { id: j.id, mode: "appended" };
      }
      const list = jumpedList(store, s.id).filter((x) => x !== j.id);
      const tail = list.length
        ? store.one("SELECT * FROM jobs WHERE id=?", list[list.length - 1])
        : null;
      if (tail) {
        const plan = mergePlan(store, tail, j);
        if ("how" in plan) {
          const into = applyPlan(store, plan, publish);
          return {
            id: j.id,
            mode: "merged",
            into,
            ...(plan.how === "carry" ? { carried: [plan.wake.id] } : {}),
          };
        }
        // Behind a jumped row it could not join (short reason —
        // 「…：前面插队的那一轮结束后发出」).
        // 「这类消息不能合并」 says less than why it cannot go in natively.
        const short = plan.why === ownerT()("server-sessions.merge.block.kind") ? why : plan.why;
        recordJump(store, s.id, j.id, null, short);
        return { id: j.id, mode: "next", reason: short };
      }
      recordJump(store, s.id, j.id, null, why);
      return { id: j.id, mode: "next", reason: ownerT()("server-sessions.queue.afterThisTurn", { why }) };
    }
    // Already stopping (cancel=1, the owner's 「停止」, review 2): upgraded to
    // a jump's stop, so the jumped message runs when it ends instead of the
    // queue pausing. Nothing new is interrupted.
    const from = notOwnersTurn(store, active);
    recordJump(store, s.id, j.id, active.id);
    store.run("UPDATE jobs SET cancel=2 WHERE id=?", active.id);
    publish(s.id, "item", {
      id: `jump:${j.id}`,
      kind: "notice",
      text: from
        ? inSessionT(s)("server-sessions.queue.jumpStopping", { from })
        : inSessionT(s)("server-sessions.queue.jumpStoppingPlain"),
      createdAt: Date.now(),
    });
    return {
      id: j.id,
      mode: "interrupting",
      ...(from ? { reason: ownerT()("server-sessions.queue.stopped", { from }) } : {}),
    };
  }
  /** The session's turn in flight, refusing a jump over a native operation. */
  const jumpable = (s: Session) => {
    const active = store.one(
      "SELECT j.*,o.job_id op FROM jobs j LEFT JOIN job_operations o ON o.job_id=j.id WHERE j.session_id=? AND j.status IN ('queued','running')",
      s.id,
    );
    if (active?.op)
      failK(409, "native_operation_running", "server-sessions.jump.nativeOperation");
    return active;
  };
  const opening = (req: any) => {
    const s = session(req, req.params.id);
    checkProfile(s);
    if (s.archived) failK(409, "session_archived", "server-sessions.op.error.archived");
    refusePaused(s);
    return s;
  };
  serve(app, O.queueJump, async (req: any) => {
    const s = opening(req);
    return store.atomic(() => {
      const j = store.one(
        "SELECT * FROM jobs WHERE id=? AND session_id=? AND status='pending'",
        req.params.jid,
        s.id,
      );
      // already in the running turn — read, or waiting there.
      if (!j && appendedRow(s, req.params.jid))
        fail(409, appendedWhy(store, req.params.jid));
      if (!j) failK(404, "queued_not_found", "server-sessions.queue.error.queuedGone");
      const active = jumpable(s);
      return jumpOne(s, j, active);
    });
  });
  /** job `jid` of `s` delivered into the running turn. */
  const appendedRow = (s: Session, jid: string) =>
    store.one(
      "SELECT * FROM jobs WHERE id=? AND session_id=? AND status='appended'",
      jid,
      s.id,
    );
  /** the selected pending jobs, in queue order (jumped first). */
  const selection = (s: Session, body: any) => {
    // merge-jump and merge-steer share this body schema.
    const b = O.queueMergeJump.body.parse(body ?? {});
    const rows = store.all(
      "SELECT * FROM jobs WHERE session_id=? AND status='pending' ORDER BY created,rowid",
      s.id,
    );
    const jumped = jumpedList(store, s.id);
    const ordered = [
      ...jumped.map((x) => rows.find((r: any) => r.id === x)).filter(Boolean),
      ...rows.filter((r: any) => !jumped.includes(r.id)),
    ];
    if (b.all) {
      if (!ordered.length) failK(404, "queue_empty", "server-sessions.queue.error.empty");
      return ordered;
    }
    const ids = [...new Set(b.ids || [])];
    if (!ids.length) failK(400, "queue_selection_empty", "server-sessions.queue.error.selectMerge");
    const picked = ordered.filter((r: any) => ids.includes(r.id));
    // a row already in the running turn (read, or waiting there)
    // is not merged again — say why, not 「不存在」.
    const inTurn = ids.find(
      (x) => !picked.some((r: any) => r.id === x) && appendedRow(s, x),
    );
    if (inTurn) fail(409, appendedWhy(store, inTurn));
    if (picked.length !== ids.length) failK(404, "queued_not_found", "server-sessions.queue.error.queuedGone");
    return picked;
  };
  /**
   * 「合并插队」 — the selected queued messages (`ids`, or `all`),
   * in queue order, go in as one message and jump (as one 插队: the running
   * turn is stopped once, or it starts now when nothing runs). Messages of a
   * different provenance cannot share a message: each such run becomes its
   * own merged message, jumping right after the previous one.
   */
  serve(app, O.queueMergeJump, async (req: any) => {
    const s = opening(req);
    return store.atomic(() => {
      const picked = selection(s, req.body);
      jumpable(s);
      const heads: any[] = [],
        merged: string[] = [],
        carried: string[] = [];
      // Mixed selections (2026-11-08): with an owner's own message
      // selected, it is the one message — her other messages merge into it
      // and Daisy wakes it can carry ride it as labelled context, in queue
      // order. The rest (group requests …) follow as below.
      let rest = picked;
      // The carrier: the highest owner authority selected (her typed
      // message > her approval decision > her own timer), first in order.
      let lead: any = null;
      for (const r of picked) {
        const k = mergeKind(store, r);
        if (
          k === "owner" &&
          String(r.text || "")
            .trimStart()
            .startsWith("/")
        )
          continue;
        if (carrierRank(k) > (lead ? carrierRank(mergeKind(store, lead)) : 0))
          lead = r;
      }
      if (lead) {
        heads.push(lead.id);
        rest = [];
        for (const r of picked) {
          if (r.id === lead.id) continue;
          const cur = store.one("SELECT * FROM jobs WHERE id=?", lead.id);
          const plan = mergePlan(store, cur, r);
          if ("how" in plan && applyPlan(store, plan, publish) === lead.id) {
            merged.push(r.id);
            if (plan.how === "carry") carried.push(r.id);
          } else rest.push(r);
        }
      }
      // Group the rest in order: each next one merges into the current
      // head when it can (same kind), else it starts a new head.
      const restHeads: string[] = [];
      for (const r of rest) {
        const last = restHeads.length
          ? store.one(
              "SELECT * FROM jobs WHERE id=?",
              restHeads[restHeads.length - 1],
            )
          : null;
        if (last && !mergeBlocker(store, last, r)) {
          mergeInto(store, last.id, r.id, publish);
          merged.push(r.id);
        } else restHeads.push(r.id);
      }
      heads.push(...restHeads);
      let first: QueueJumpResult | null = null;
      for (const h of heads) {
        const j = store.one("SELECT * FROM jobs WHERE id=?", h);
        const now = store.one(
          "SELECT * FROM jobs WHERE session_id=? AND status IN ('queued','running')",
          s.id,
        );
        const r: QueueJumpResult = jumpOne(s, j, now);
        // Merged into an earlier jump — or it carried that jump's wake (then
        // it is still the job, `into` = itself).
        if (r.mode === "merged" && r.into !== h) merged.push(h);
        if (r.carried) carried.push(...r.carried);
        first ??= r;
      }
      return {
        ...first!,
        // The job that carries the first selection (review: not a row that
        // was itself merged into an earlier jump).
        id: first!.mode === "merged" && first!.into ? first!.into : heads[0],
        merged,
        ...(carried.length ? { carried } : {}),
        jobs: heads.filter((h) => !merged.includes(h)),
      };
    });
  });
  /**
   * 「合并追加」 — the selected queued messages go into the running
   * turn, whenever one of them can — the owner's own
   * plain text as one 立即追加 (Claude / Codex natively,
   * older CLIs through Daisy's steer; not taken → the next turn, as any
   * steer), every other row the agent's own input queue takes (native-append.ts
   * appendBlocker: attachments, her approval decisions, plugin callbacks …)
   * appended natively, each as itself. Rows neither can take stay queued,
   * listed in `left` with the reason. Nothing can go in: 409.
   */
  serve(app, O.queueMergeSteer, async (req: any) => {
    const s = opening(req);
    // P4-11: was `agent === "kimi"` — the declared 运行中追加.
    requireFeatures(store, s, "steer");
    return store.atomic(() => {
      const picked = selection(s, req.body);
      const j = store.one(
        "SELECT j.* FROM jobs j LEFT JOIN job_operations o ON o.job_id=j.id WHERE j.session_id=? AND j.status='running' AND o.job_id IS NULL",
        s.id,
      );
      if (!j || j.cancel) failK(409, "no_active_turn", "server-sessions.queue.error.noActiveTurn");
      const texts = picked.filter((r: any) => steerable(store, r));
      const native: any[] = [],
        left: { id: string; reason: string }[] = [];
      for (const r of picked) {
        if (texts.includes(r)) continue;
        const why = appendBlocker(store, s, r, j);
        if (why) left.push({ id: r.id, reason: why });
        else native.push(r);
      }
      if (!texts.length && !native.length)
        if (picked.length === 1 && left[0])
          failK(409, "not_appendable", "server-sessions.queue.error.useMergeJump", { reason: left[0].reason });
        else failK(409, "not_appendable", "server-sessions.queue.error.noneAppendable");
      // her text is not steered into someone else's
      // turn — first in the queue after it, in order, saying why.
      const why = texts.length ? turnFit(store, j, texts[0]) : null;
      if (why && !native.length) {
        for (const r of picked) recordJump(store, s.id, r.id, null, why);
        return {
          id: picked[0].id,
          status: "pending",
          merged: [],
          reason: ownerT()("server-sessions.queue.afterThisTurn", { why }),
        };
      }
      const steer = why ? [] : texts;
      // Review L1: every check before anything is written.
      const contexts = [
        ...new Set(steer.map((r: any) => r.context).filter(Boolean)),
      ];
      if (contexts.length > 1) failK(409, "context_differs", "server-sessions.queue.error.contextsDiffer");
      const text = steer.map((r: any) => r.text).join(mergeSeparator(inSessionT(s)));
      if (text.length > 100000) failK(409, "merge_too_long", "server-sessions.queue.error.tooLong");
      const requestId = steer.length ? `queue-merge:${steer[0].id}` : "";
      const old = steer.length
        ? store.one(
            "SELECT id,status FROM live_inputs WHERE job_id=? AND request_id=?",
            j.id,
            requestId,
          )
        : null;
      if (old && !native.length) return { ...old, merged: [] };
      if (why) {
        for (const r of texts) left.push({ id: r.id, reason: why });
        for (const r of texts) recordJump(store, s.id, r.id, null, why);
      }
      // Review L1: into the agent's queue in queue order — the merged text
      // at its first row's place (the Runner claims by created, rowid).
      const appended: string[] = [];
      let mid: string | null = null;
      const context = contexts[0] as string | undefined;
      for (const r of picked) {
        if (native.includes(r)) {
          appendJob(store, s, r, j, publish);
          appended.push(r.id);
        } else if (steer.length && r === steer[0] && !old) {
          mid = id();
          store.run(
            "INSERT INTO live_inputs(id,job_id,request_id,text,status,created,context) VALUES(?,?,?,?,?,?,?)",
            mid,
            j.id,
            requestId,
            text,
            "queued",
            Date.now(),
            context ?? null,
          );
          for (const t of steer) mergedIntoInput(store, t.id, mid, publish);
          publish(s.id, "item", {
            id: `input:${mid}`,
            kind: "user",
            text,
            status: "queued",
            ...(context ? { context: JSON.parse(context) } : {}),
            mergedFrom: steer.map((t: any) => t.id),
            createdAt: Date.now(),
          });
        }
      }
      const extra = {
        ...(appended.length ? { appended } : {}),
        ...(left.length ? { left } : {}),
      };
      if (!mid)
        return old
          ? { ...old, merged: [], ...extra }
          : { id: appended[0], status: "appended", merged: [], ...extra };
      return {
        id: mid,
        status: "queued",
        merged: steer.map((r: any) => r.id),
        ...extra,
      };
    });
  });
  /**
   * Take pending (or appended) job `j` out of the queue: Daisy
   * wakes it carried go back, what was merged into it goes with it, its
   * bubble / wake marker says so. Inside a transaction.
   */
  function dropQueued(s: Session, j: any) {
    dropQueuedJob(store, s.id, j, publish);
  }
  serve(app, O.queueRemove, async (req: any) => {
    const s = session(req, req.params.id);
    return store.atomic(() => {
      const j = store.one(
        "SELECT * FROM jobs WHERE id=? AND session_id=? AND status IN ('pending','appended')",
        req.params.jid,
        s.id,
      );
      if (!j) failK(404, "queued_not_found", "server-sessions.queue.error.queuedNotFound");
      if (j.status === "appended") {
        // delivered into the running turn, not read yet — Daisy
        // takes it back itself before the Runner has it, else asks the
        // agent (Claude: cancel_async_message; the Runner reports back).
        const r = removeAppended(store, s, j);
        if (r === "withdrawing") return { ok: true, withdrawing: true };
        if (r !== "removed") fail(409, r);
      }
      dropQueued(s, j);
      return { ok: true };
    });
  });
  /**
   * 「批量移除」 — the
   * selected rows (`ids`) or every row still waiting (`all`), each exactly
   * as its own 「移除」 / 「撤回」 (DELETE above), in one transaction, queue
   * order. Per row: `ok` (removed), `withdrawing` (the agent is asked for
   * an appended row back) or `reason` (read already, gone, cannot be
   * withdrawn). Daisy wakes a removed message carried go back to the
   * queue as with one 移除 (`restored`); a removed callback wake is
   * dropped as with one 移除 (「不会送达」) — only 「停止」 keeps it.
   * `all` skips rows the agent has read (part of the running turn).
   */
  serve(app, O.queueRemoveMany, async (req: any) => {
    const s = session(req, req.params.id);
    const b = O.queueRemoveMany.body.parse(req.body ?? {});
    return store.atomic(() => {
      const pendingIds = () =>
        store
          .all(
            "SELECT id FROM jobs WHERE session_id=? AND status='pending'",
            s.id,
          )
          .map((r: any) => r.id as string);
      const before = new Set(pendingIds());
      // Queue order as GET …/queue lists it: appended, jumped, the rest.
      const appendedIds = store
        .all(
          "SELECT id FROM jobs WHERE session_id=? AND status='appended' ORDER BY created,rowid",
          s.id,
        )
        .map((r: any) => r.id as string);
      const jumped = jumpedList(store, s.id).filter((x) => before.has(x));
      const rest = store
        .all(
          "SELECT id FROM jobs WHERE session_id=? AND status='pending' ORDER BY created,rowid",
          s.id,
        )
        .map((r: any) => r.id as string)
        .filter((x: string) => !jumped.includes(x));
      const order = [...appendedIds, ...jumped, ...rest];
      let targets: string[];
      if (b.all) {
        // Review M2: only an appended row the agent read is skipped — never
        // a pending one (whatever its native_appends row says).
        targets = order.filter(
          (x) => !(appendedIds.includes(x) && appendRead(store, x)),
        );
        if (!targets.length) failK(404, "queue_empty", "server-sessions.queue.error.empty");
      } else {
        const ids = [...new Set(b.ids || [])];
        if (!ids.length) failK(400, "queue_selection_empty", "server-sessions.queue.error.selectRemove");
        targets = [
          ...order.filter((x) => ids.includes(x)),
          ...ids.filter((x) => !order.includes(x)),
        ];
      }
      const results: {
        id: string;
        ok: boolean;
        withdrawing?: boolean;
        reason?: string;
      }[] = [];
      // Review L7: only what was waiting when asked — a wake put back in the
      // queue by removing its carrier (`restored`) is not removed with it.
      const present = new Set(order);
      for (const jid of targets) {
        if (!present.has(jid)) {
          results.push({
            id: jid,
            ok: false,
            reason: ownerT()("server-sessions.queue.error.queuedGone"),
          });
          continue;
        }
        const j = store.one(
          "SELECT * FROM jobs WHERE id=? AND session_id=? AND status IN ('pending','appended')",
          jid,
          s.id,
        );
        if (!j) {
          results.push({
            id: jid,
            ok: false,
            reason: ownerT()("server-sessions.queue.error.queuedGone"),
          });
          continue;
        }
        if (j.status === "appended") {
          const r = removeAppended(store, s, j);
          if (r === "withdrawing") {
            results.push({ id: jid, ok: true, withdrawing: true });
            continue;
          }
          if (r !== "removed") {
            results.push({ id: jid, ok: false, reason: r });
            continue;
          }
        }
        dropQueued(s, j);
        results.push({ id: jid, ok: true });
      }
      const restored = pendingIds().filter((x) => !before.has(x));
      return {
        results,
        removed: results.filter((r) => r.ok && !r.withdrawing).length,
        withdrawing: results.filter((r) => r.withdrawing).length,
        refused: results.filter((r) => !r.ok).length,
        ...(restored.length ? { restored } : {}),
      };
    });
  });
  /**
   * 「立即压缩并生效」: one `/compact` of `s`, queued by the control
   * plane itself (the same job an owner's /compact makes, under the same
   * conditions). `{ error }`: why not now — the caller tries again later.
   */
  const queueCompact = (
    s: Session,
    requestId: string,
    /** Who asked for it: its owner, or the admin whose 「立即生效」 it is. */
    actorId: string = s.ownerId,
  ): { id: string } | { error: string } => {
    try {
      checkProfile(s);
      const t = ownerT();
      if (s.archived) return { error: t("server-sessions.op.error.archived") };
      if (residentHeld(s)) return { error: t("server-sessions.op.error.residentPaused") };
      if (!s.nativeId) return { error: t("server-sessions.op.error.noNativeYet") };
      const rid = `op:${s.id}:${requestId}`;
      const existing = store.one(
        "SELECT id FROM jobs WHERE request_id=? AND node_id=?",
        rid,
        s.nodeId,
      );
      if (existing) return { id: existing.id };
      if (
        store.one(
          "SELECT id FROM jobs WHERE session_id=? AND status IN ('queued','running','pending')",
          s.id,
        )
      )
        return { error: t("server-sessions.op.error.workingOrQueued") };
      if (
        store.one(
          "SELECT id FROM logins WHERE profile_id=? AND status IN ('queued','running','waiting') AND expires>?",
          s.profileId,
          Date.now(),
        )
      )
        return { error: t("server-sessions.op.error.loggingIn") };
      const jid = id();
      store.atomic(() => {
        store.run(
          "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,trace) VALUES(?,?,?,?,?,?,?,?,?)",
          jid,
          s.id,
          s.nodeId,
          rid,
          "",
          "[]",
          "queued",
          Date.now(),
          traceForNewTurn(),
        );
        store.run(
          "INSERT INTO job_operations(job_id,data) VALUES(?,?)",
          jid,
          JSON.stringify({ name: "compact", args: {} }),
        );
        publish(s.id, "status", { status: "queued" });
        store.run("UPDATE live_sessions SET stop=0 WHERE session_id=?", s.id);
        // Under the one who asked, never the owner when an admin did.
        store.audit(
          actorId,
          actorId === s.ownerId
            ? "agent.operation.compact"
            : "agent.operation.compact.admin",
          s.id,
        );
      });
      return { id: jid };
    } catch (e: any) {
      // A keyed error (checkProfile) in the owner's language, not its English `message`.
      return { error: String(isLocalized(e) ? ownerT().dynamic(e.key, e.params) : e?.message || e).slice(0, 200) };
    }
  };
  return { dropQueued, queueCompact };
}
/**
 * keep a native catalog per identity (on 读取原生模型列表).
 * P1-01: moved out of resident.ts.
 */
export function saveProfileCatalog(store: Store, profileId: string, body: any) {
  if (!Array.isArray(body?.models) || !body.models.length) return;
  store.run(
    "INSERT INTO profile_catalogs(profile_id,data,at) VALUES(?,?,?) ON CONFLICT(profile_id) DO UPDATE SET data=excluded.data,at=excluded.at",
    profileId,
    JSON.stringify({
      models: body.models,
      configOptions: body.configOptions || [],
    }),
    Date.now(),
  );
}
