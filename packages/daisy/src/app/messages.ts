import type { FastifyInstance } from "fastify";
import { requestT } from "./language.ts";
import type { Translate } from "../../../contracts/src/i18n.ts";
import { id } from "../store/index.ts";
import {
  approvalCategory,
  residentHeld,
  RESIDENT_PAUSED_CODE,
  RESIDENT_PAUSED_KEY,
  type Event,
  type Approval,
} from "../../../contracts/src/index.ts";
import { HttpError, LocalizedError } from "./errors.ts";
import { serve } from "./serve.ts";
import { api } from "../../../contracts/src/api/index.ts";
import type { AppBase, AppContext, LateServices } from "./context.ts";
import type { EventBus } from "./events.ts";
import { traceForNewTurn } from "../observe/trace.ts";
/** Answering a harness approval (P1-00: moved from app.ts). */
export function messageHelpers(ctx: AppBase & LateServices & EventBus) {
  const { store, broadcast } = ctx;
  /**
   * Answer a harness approval (also from the 「审批」 page, where
   * permission prompts are answered; the conversation view answers questions only).
   */
  function answerNative(
    sid: string,
    aid: string,
    b: { optionId: string; answers?: Record<string, string> },
    by: string,
    /** The language a refusal is said in (the request's; the owner's otherwise). */
    say?: Translate,
  ) {
    const r = store.one(
      "SELECT data,job_id FROM approvals WHERE id=? AND session_id=?",
      aid,
      sid,
    );
    if (!r) throw new LocalizedError(404, "approval_not_found", "server.approval.notFound");
    const a = JSON.parse(r.data) as Approval;
    if (a.status !== "pending") throw new LocalizedError(409, "approval_closed", "server-app.approval.closed");
    // Q-1: past its time limit it is expired even before the sweep ran.
    // Said in the request's language.
    const late = ctx.approvalsHub?.overdue(a, say);
    if (late) {
      ctx.approvalsHub!.sweep();
      throw new HttpError(409, late, "approval_expired");
    }
    const j = store.one(
      "SELECT * FROM jobs WHERE id=? AND status='running'",
      r.job_id,
    );
    if (!j || j.lease_until < Date.now() || j.cancel)
      throw new LocalizedError(409, "job_gone", "server-app.approval.jobGone");
    if (!a.options.some((o) => o.id === b.optionId))
      throw new LocalizedError(400, "approval_option_invalid", "server-app.approval.optionInvalid");
    const answered: Approval = {
      ...a,
      status: "answered",
      decision: b,
      decidedBy: by,
      decidedAt: Date.now(),
    };
    // P2-03: the answer, its notice and its event in one transaction.
    const ev = store.atomic(() => {
      const ev = store.append(sid, "approval", answered);
      ctx.approvalsHub?.nativeClosed(answered);
      store.audit(by, "approval.answer", a.id);
      return ev;
    });
    broadcast(ev);
  }
  return { answerNative };
}
export type MessageHelpers = ReturnType<typeof messageHelpers>;
/**
 * Sending a message; answering a question in the conversation (P1-00:
 * moved from app.ts).
 */
export function registerMessageRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  const { store, session, user, broadcast, provisionalTitle, answerNative } =
    ctx;
  const M = api.messages;
  serve(app, M.send, async (req) => {
    const s = session(req, (req.params as any).id),
      b = M.send.body.parse(req.body);
    // a paused resident takes no messages (archived: below).
    if (s.resident && !s.archived && residentHeld(s))
      throw new LocalizedError(409, RESIDENT_PAUSED_CODE, RESIDENT_PAUSED_KEY);
    const terminal = b.terminalIds.length
      ? ctx.shell.resolve(s.ownerId, s.id, b.terminalIds)
      : [];
    if (
      !store.one(
        "SELECT id FROM profiles WHERE id=? AND owner_id=?",
        s.profileId,
        s.ownerId,
      )
    )
      throw new LocalizedError(409, "profile_gone", "server-app.send.profileGone");
    if (s.archived) throw new LocalizedError(409, "session_archived", "server-app.session.archived");
    if (
      store.one("SELECT revoked_at FROM nodes WHERE id=?", s.nodeId)?.revoked_at
    )
      throw new LocalizedError(409, "node_revoked", "server-app.send.nodeRevoked");
    if (
      !s.nativeId &&
      store.one(
        "SELECT j.id FROM jobs j JOIN job_operations o ON j.id=o.job_id WHERE j.session_id=? AND json_extract(o.data,'$.name')='fork'",
        s.id,
      )
    )
      throw new LocalizedError(409, "fork_incomplete", "server-app.send.forkIncomplete");
    const attachments = b.attachmentIds.map((aid) => {
      const a = store.one(
        "SELECT * FROM attachments WHERE id=? AND owner_id=?",
        aid,
        s.ownerId,
      );
      if (!a) throw new LocalizedError(400, "attachment_not_found", "server-app.send.attachmentNotFound");
      return { id: a.id, name: a.name, mime: a.mime, size: a.size };
    });
    const initial: Event[] = [];
    const result = store.atomic(() => {
      const old = store.one(
        "SELECT id,status FROM jobs WHERE session_id=? AND request_id=?",
        s.id,
        b.requestId,
      );
      if (old) return { ...old, duplicate: true };
      // D-36: no PIN, no AI turn — say so instead of queueing for nothing.
      const blocked = ctx.aiTurnsBlocked();
      if (blocked) throw new LocalizedError(409, "pin_not_set", "server.pin.aiTurnsNeedPin");
      const activeJob = store.one(
        "SELECT id FROM jobs WHERE session_id=? AND status IN ('queued','running')",
        s.id,
      );
      if (activeJob && b.delivery !== "queue")
        throw new LocalizedError(409, "session_busy", "server-app.send.busy");
      if (
        store.one(
          "SELECT COUNT(*) AS n FROM jobs WHERE session_id=? AND status='pending'",
          s.id,
        ).n >= 20
      )
        throw new LocalizedError(429, "queue_full", "server-app.send.queueFull", { max: 20 });
      const nextStatus = activeJob ? "pending" : "queued";
      if (
        store.one(
          "SELECT id FROM logins WHERE profile_id=? AND status IN ('queued','running','waiting') AND expires>?",
          s.profileId,
          Date.now(),
        )
      )
        throw new LocalizedError(409, "profile_logging_in", "server-app.send.loggingIn");
      const jid = id();
      store.run(
        "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,context,terminal,trace) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        jid,
        s.id,
        s.nodeId,
        b.requestId,
        b.text,
        JSON.stringify(b.attachmentIds),
        nextStatus,
        Date.now(),
        b.context ? JSON.stringify(b.context) : null,
        terminal.length ? JSON.stringify(terminal) : null,
        traceForNewTurn(),
      );
      // First message of an untitled conversation: an immediate title.
      provisionalTitle(s.id, b.text);
      // Same transaction as the job: a requestId replay returned above, so
      // refs are merged exactly once.
      store.noteContext(s.id, b.context);
      // A message after 「下线」 keeps the session online.
      store.run("UPDATE live_sessions SET stop=0 WHERE session_id=?", s.id);
      initial.push(
        store.append(s.id, "item", {
          id: `user:${jid}`,
          kind: "user",
          text: b.text,
          status: "queued",
          attachments,
          ...(b.context ? { context: b.context } : {}),
          // The snapshot is polled: the item keeps a display cut, the job
          // keeps the full output for the Agent.
          ...(terminal.length
            ? {
                terminal: terminal.map((r) =>
                  r.output.length > 4000
                    ? {
                        ...r,
                        output: r.output.slice(0, 4000) + "\n…",
                        truncated: true,
                      }
                    : r,
                ),
              }
            : {}),
          createdAt: Date.now(),
        })!,
        ...(!activeJob
          ? [store.append(s.id, "status", { status: "queued" })!]
          : []),
      );
      return { id: jid, status: nextStatus, duplicate: false };
    });
    initial.forEach(broadcast);
    return result;
  });
  serve(app, M.answerApproval, async (req) => {
    const s = session(req, (req.params as any).id),
      b = M.answerApproval.body.parse(req.body),
      r = store.one(
        "SELECT data,job_id FROM approvals WHERE id=? AND session_id=?",
        (req.params as any).aid,
        s.id,
      );
    if (!r) throw new LocalizedError(404, "approval_not_found", "server.approval.notFound");
    // a harness permission prompt is answered on the 「审批」 page
    // only (its owner, through /api/approvals); the conversation view answers questions
    // — also for older clients and an admin's override (review 2026-11-03).
    if (approvalCategory(JSON.parse(r.data)) === "permission")
      throw new LocalizedError(409, "approval_elsewhere", "server-app.approval.elsewhere");
    answerNative(s.id, (req.params as any).aid, b, user(req).id, requestT(req));
    return { ok: true };
  });
}
