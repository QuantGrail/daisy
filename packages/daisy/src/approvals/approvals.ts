/**
 * 审批合并 (2026-11-03): one list of every decision Daisy needs from an AI's
 * owner, for the 「审批」 page — call cards (stage 4 plugs its call
 * authorization in through `c.access`; P1-01: none), harness permission
 * prompts and auto-mode interceptions (the `approvals` table, Runner
 * events), and the approvals an AI raised to its own owner. The data stays
 * where it is; this module only lists, decides and notifies.
 */
import type { FastifyInstance } from "fastify";
import { type Store, id } from "../store/index.ts";
import {
  approvalCategory,
  systemSender,
  type ApprovalThread,
  type ApprovalThreadEntry,
  type ApprovalThreadSummary,
  type Approval,
  type DaisyApproval,
  type DaisyApprovalOption,
  type Session,
} from "../../../contracts/src/index.ts";
import { agentLabel } from "../../../contracts/src/agent-label.ts";
import { CARD_LIMITS } from "../../../contracts/src/limits.ts";
import { api } from "../../../contracts/src/api/index.ts";
import { serve } from "../app/serve.ts";
import { LocalizedError, type MsgParams } from "../app/errors.ts";
import type { MessageKey, Translate } from "../../../contracts/src/i18n.ts";
import { ownerT, inSessionT } from "../platform/language.ts";
import { queueNativeApproval } from "./native-approvals.ts";
import {
  type BlockedOp,
  CLASSIFIER_BACKOFF,
  CLASSIFIER_MAX_OPS,
  CLASSIFIER_MAX_RETRIES,
  CLASSIFIER_WINDOW,
  classifierUnavailable,
  fenced,
  opList,
  opSummary,
  retryPrompt,
} from "./classifier-retry.ts";

const fail = (statusCode: number, code: string, key: MessageKey, params?: MsgParams): never => {
  throw new LocalizedError(statusCode, code, key, params);
};
type Actor = {
  ownerId: string;
  kind: "human" | "agent";
  id: string;
  jobId?: string;
};
/** Call cards wait a day for their owner. */
export const CALL_CARD_TTL = 24 * 3600_000;
/**
 * A harness's tool permission / question card waits this long for its
 * owner by default (limits.md §1, Q-1): then its turn ends (R-4).
 */
export const OWNER_APPROVAL_TTL = CARD_LIMITS.toolCardTtlMs;
/** "24 小时", "90 分钟", "3 秒": a card's time limit, said plainly. */
export function ttlText(ms: number, t: Translate = ownerT()) {
  if (ms % 3600_000 === 0) return t("server-approvals.ttl.hours", { n: ms / 3600_000 });
  if (ms % 60_000 === 0) return t("server-approvals.ttl.minutes", { n: ms / 60_000 });
  return t("server-approvals.ttl.seconds", { n: Math.max(1, Math.round(ms / 1000)) });
}
const NO = /^(deny|decline|reject|cancel|remove|dismiss|no)$/i;
const tone = (key: string, i: number): DaisyApprovalOption["tone"] =>
  // 不唤醒 (keep) is a wake card's refusal.
  NO.test(key) || key === "keep" ? "danger" : i === 0 ? "primary" : "default";
/** 5.6 卡片上的三个选择 (P4-03; the old group-bound keys kept for reading). */
const CALL_LABELS = new Set(["always", "once", "reject", "allowlist", "allowed"]);
const callLabel = (key: string): string =>
  CALL_LABELS.has(key) ? ownerT().dynamic(`server-approvals.call.option.${key}`) : key;
/** An interception card's two answers (the outage card words them differently). */
const interceptionLabel = (outage: boolean, key: "retry" | "dismiss"): string =>
  ownerT()(
    outage
      ? key === "retry"
        ? "server-approvals.option.outageRetry"
        : "server-approvals.option.outageDismiss"
      : key === "retry"
        ? "server-approvals.option.retry"
        : "server-approvals.option.dismiss",
  );

/**
 * Call card states for one resolver pass: the newest 200 once; a
 * card older than those is looked up in one more read of the whole list
 * instead of reading as unknown → 「canceled」 (approvals L3, R2).
 */
export function cardStates(
  list: (limit: number) => { id: unknown; status: unknown }[],
): (cardId: string) => string | null {
  let recent: Map<string, string> | null = null,
    all: Map<string, string> | null = null;
  const index = (rows: { id: unknown; status: unknown }[]) =>
    new Map(rows.map((x) => [String(x.id), String(x.status)]));
  return (aid) => {
    recent ??= index(list(200));
    const hit = recent.get(aid);
    if (hit !== undefined) return hit;
    all ??= index(list(Number.MAX_SAFE_INTEGER));
    return all.get(aid) ?? null;
  };
}
export function daisyApprovals(
  app: FastifyInstance,
  store: Store,
  c: {
    actor: (req: any) => Actor;
    access: {
      listCards: (a: Actor, q: any) => any[];
      respondCard: (a: Actor, aid: string, b: any) => any;
      pendingIds: (uid: string) => string[];
    };
    approvalEvent: (
      uid: string,
      cardId: string,
      state: "pending" | "approved" | "rejected" | "canceled" | "expired",
      title: string,
      sessionId?: string,
    ) => void;
    /**
     * P2-03: the event outlet alone (no notice) — a harness question's
     * card (`question:<id>`, AI 提问), answered in its conversation.
     */
    cardEvent?: (
      uid: string,
      cardId: string,
      state: "pending" | "approved" | "rejected" | "canceled" | "expired",
      title: string,
      sessionId?: string,
    ) => void;
    approvalHooks: {
      state: (uid: string, cardId: string) => string | null;
      resolver: (uid: string) => (cardId: string) => string | null;
      pending: (uid: string) => string[];
    };
    queueWake: (
      sid: string,
      requestId: string,
      prompt: string,
      origin: any,
    ) => void;
    username: (uid: string) => string;
  },
  d: {
    /** Answer a native approval as `by` (the session's owner). */
    answerNative: (
      sid: string,
      aid: string,
      b: { optionId: string; answers?: Record<string, string> },
      by: string,
    ) => void;
    /** re-show a queued retry turn whose text grew. */
    publish?: (sid: string, type: "item", data: any) => void;
  },
  t: {
    /** Q-1: a tool permission / question card's time limit (default limits.md §1). */
    cardTtlMs?: number;
    /** Tests: the clock card expiry reads (default Date.now). */
    now?: () => number;
  } = {},
) {
  const username = c.username;
  const cardTtl =
    t.cardTtlMs && t.cardTtlMs > 0 ? t.cardTtlMs : OWNER_APPROVAL_TTL;
  const clock = t.now ?? Date.now;
  const sessionRef = (sid: string) => {
    const s = store.session(sid);
    return s
      ? { id: s.id, title: s.title, ownerName: username(s.ownerId) }
      : { id: sid, title: ownerT()("server-approvals.deletedAi"), ownerName: "" };
  };
  const by = (uid: string | null) => ({
    id: uid || "",
    username: uid ? username(uid) : "",
  });
  /** Only a signed-in person decides; an AI job capability never can. */
  function person(req: any) {
    const a = c.actor(req);
    if (a.kind !== "human") fail(403, "approval_human_only", "server-approvals.error.humanOnly");
    return a;
  }

  // ── call cards (stage 4) ──────────────────────────────────────────────
  function callView(card: any): DaisyApproval {
    // The card's answers are always listed (also once decided, so
    // a read-back shows what could be chosen); clients show buttons only
    // while `status` is "pending".
    const keys: string[] = card.offers || ["always", "once", "reject"];
    const callee = card.calleeSession || {};
    const t = ownerT();
    const mine = agentLabel({ title: callee.title || "", ownerName: callee.ownerName || "" }, ownerT());
    const callTitle = () =>
      card.callerSession
        ? t("server-approvals.call.titleFromAgent", {
            caller: agentLabel({ title: card.callerSession.title, ownerName: card.callerUser?.username || "" }, ownerT()),
            agent: mine,
          })
        : t("server-approvals.call.titleFromPerson", { caller: card.callerUser?.username || "", agent: mine });
    const { decision, ...rest } = card;
    return {
      ...rest,
      kind: "call",
      // P4-03: the card says when it expires (7 days, limits.md §1).
      expiresAt: card.expiresAt ?? card.created + CALL_CARD_TTL,
      // P4-03: the card's own line (who, which agent, how many calls).
      title: card.title ?? callTitle(),
      session: {
        id: callee.id,
        title: callee.title || "",
        ownerName: callee.ownerName || "",
      },
      options: keys.map((key, i) => ({
        key,
        label: callLabel(key),
        tone: tone(key, i),
      })),
      ...(decision
        ? {
            decision: {
              ...decision,
              label: callLabel(decision.choice),
            },
          }
        : {}),
    } as DaisyApproval;
  }

  // ── harness permission prompts (approvals table) ──────────────────────
  function nativeState(a: Approval) {
    if (a.status === "pending") return "pending" as const;
    if (a.status === "expired") return "expired" as const;
    return NO.test(a.decision?.optionId || "")
      ? ("rejected" as const)
      : ("approved" as const);
  }
  function preview(v: unknown) {
    const raw = typeof v === "string" ? v : JSON.stringify(v ?? null);
    return raw.length > 4000
      ? { truncated: true, preview: raw.slice(0, 4000) }
      : v;
  }
  function nativeView(a: Approval): DaisyApproval {
    const s = store.session(a.sessionId);
    const state = nativeState(a);
    const label =
      a.options.find((o) => o.id === a.decision?.optionId)?.label ||
      a.decision?.optionId ||
      "";
    return {
      id: `perm:${a.id}`,
      kind: "permission",
      status: state,
      created: a.createdAt,
      expiresAt: a.createdAt + cardTtl,
      title: ownerT()("server-approvals.permission.title", {
        agent: s ? agentLabel({ title: s.title, ownerName: username(s.ownerId) }, ownerT()) : ownerT()("server-approvals.ai"),
        tool: a.title,
      }),
      session: sessionRef(a.sessionId),
      // Always the prompt's answers; buttons only while pending.
      options: a.options.map((o, i) => ({
        key: o.id,
        label: o.label,
        tone: tone(o.id, i),
      })),
      agent: s?.agent || "",
      tool: a.title,
      reason: a.reason || "",
      input: preview(a.input),
      jobId: a.jobId,
      ...(a.decision
        ? {
            decision: {
              choice: a.decision.optionId,
              label,
              by: by(a.decidedBy || s?.ownerId || null),
              at: a.decidedAt || 0,
            },
          }
        : {}),
    };
  }
  function nativeRows(uid: string, which: "pending" | "decided" | "all") {
    return store
      .all(
        `SELECT a.data FROM approvals a JOIN sessions s ON s.id=a.session_id
        WHERE json_extract(s.data,'$.ownerId')=? AND COALESCE(json_extract(s.data,'$.deleting'),0)=0
        ${which === "pending" ? "AND json_extract(a.data,'$.status')='pending'" : which === "decided" ? "AND json_extract(a.data,'$.status')!='pending'" : ""}
        ORDER BY a.rowid DESC LIMIT 300`,
        uid,
      )
      .map((r) => JSON.parse(r.data) as Approval)
      .filter((a) => approvalCategory(a) === "permission");
  }
  /**
   * A Runner reported a permission prompt: the owner hears of it once.
   * P2-03: a question (AI 提问) is an event-outlet card too, without a
   * notice (it is answered in its conversation, which shows it).
   */
  function nativeOpened(a: Approval) {
    if (a.status !== "pending") return;
    const s = store.session(a.sessionId);
    if (!s) return;
    if (approvalCategory(a) === "question") {
      if (!s.sidecar)
        c.cardEvent?.(
          s.ownerId,
          `question:${a.id}`,
          "pending",
          ownerT()("server-approvals.question.asking", {
            agent: agentLabel({ title: s.title, ownerName: username(s.ownerId) }, ownerT()),
            title: a.title,
          }),
          s.id,
        );
      return;
    }
    c.approvalEvent(
      s.ownerId,
      `perm:${a.id}`,
      "pending",
      ownerT()("server-approvals.permission.title", {
        agent: agentLabel({ title: s.title, ownerName: username(s.ownerId) }, ownerT()),
        tool: a.title,
      }),
      // P1-08: the web page shows it under its session.
      s.id,
    );
  }
  function nativeClosed(a: Approval) {
    const s = store.session(a.sessionId);
    if (!s) return;
    const state = nativeState(a);
    if (state === "pending") return;
    if (approvalCategory(a) === "question") {
      c.cardEvent?.(
        s.ownerId,
        `question:${a.id}`,
        a.status === "expired" ? "expired" : "approved",
        ownerT()(a.status === "expired" ? "server-approvals.question.expired" : "server-approvals.question.answered", {
          title: a.title,
        }),
        s.id,
      );
      return;
    }
    c.approvalEvent(
      s.ownerId,
      `perm:${a.id}`,
      state,
      ownerT()(
        state === "approved"
          ? "server-approvals.permission.approved"
          : state === "rejected"
            ? "server-approvals.permission.rejected"
            : "server-approvals.permission.expired",
        { title: a.title },
      ),
      s.id,
    );
  }
  const nativeRow = (aid: string) => {
    const r = store.one("SELECT data FROM approvals WHERE id=?", aid);
    return r ? (JSON.parse(r.data) as Approval) : null;
  };

  // ── AI→owner approvals and interceptions (owner_approvals) ────────────
  function ownView(r: any): DaisyApproval {
    const x = JSON.parse(r.data);
    const t = ownerT();
    // An interception's two answers are Daisy's own: said in the owner's
    // language now (the label stored with an older card is not read).
    const options: { key: string; label: string }[] = (x.options || []).map((o: { key: string; label: string }) =>
      r.kind === "interception" && (o.key === "retry" || o.key === "dismiss")
        ? { ...o, label: interceptionLabel(!!x.classifier, o.key) }
        : o,
    );
    const decision = r.decision
      ? {
          decision: {
            choice: r.decision,
            label:
              options.find((o) => o.key === r.decision)?.label || r.decision,
            ...(r.note ? { note: r.note } : {}),
            by: by(r.decided_by),
            at: r.decided_at || 0,
          },
        }
      : {};
    const base = {
      id: `${r.kind === "interception" ? "block" : "ask"}:${r.id}`,
      status: r.status,
      created: r.created,
      expiresAt: r.expires_at ?? null,
      session: sessionRef(r.session_id),
      // Always the card's answers; buttons only while pending.
      options: options.map((o, i) => ({ ...o, tone: tone(o.key, i) })),
      ...decision,
    };
    const s = store.session(r.session_id);
    const ai = s
      ? agentLabel({ title: s.title, ownerName: username(s.ownerId) }, ownerT())
      : t("server-approvals.ai");
    if (r.kind === "interception")
      return {
        ...base,
        kind: "interception",
        title: x.classifier
          ? t("server-approvals.interception.titleClassifier", { agent: ai, n: (x.ops || []).length || 1 })
          : t(x.reviewer === "auto_review" ? "server-approvals.interception.titleReview" : "server-approvals.interception.titleAuto", {
              agent: ai,
              tool: x.tool || t("server-approvals.tool"),
            }),
        // Codex auto review's judgement (absent: Claude auto mode).
        ...(x.reviewer === "auto_review"
          ? {
              reviewer: "auto_review",
              ...(x.riskLevel ? { riskLevel: x.riskLevel } : {}),
              ...(x.userAuthorization
                ? { userAuthorization: x.userAuthorization }
                : {}),
            }
          : {}),
        tool: x.tool || "",
        reason: x.reason || "",
        // the outage card shows what 「让 AI 重试」 would retry.
        message: x.classifier
          ? t("server-approvals.interception.retryList", {
              message: t("server-approvals.interception.outageMessage", { n: CLASSIFIER_MAX_RETRIES }),
              ops: opSummary(x.ops || []),
            })
          : x.message || "",
        input: preview(x.classifier ? x.ops || [] : x.input),
      } as DaisyApproval;
    return {
      ...base,
      kind: "owner",
      title: t("server-approvals.owner.title", { agent: ai, question: String(x.question).replace(/\s+/g, " ").slice(0, 80) }),
      question: x.question,
      detail: x.detail || "",
      askedBy: x.askedBy || null,
    } as DaisyApproval;
  }
  function ownRows(uid: string, which: "pending" | "decided" | "all") {
    return store.all(
      `SELECT * FROM owner_approvals WHERE owner_id=? ${which === "pending" ? "AND status='pending'" : which === "decided" ? "AND status!='pending'" : ""}
      ORDER BY created DESC LIMIT 300`,
      uid,
    );
  }
  /** The asking AI hears the answer: a turn with the owner's decision. */
  function wakeWith(r: any, decision: string, note: string, who: string) {
    const x = JSON.parse(r.data);
    const label =
      (x.options || []).find((o: any) => o.key === decision)?.label || decision;
    // Written into the asking session: in its language.
    const t = inSessionT(store.session(r.session_id));
    const owner = username(who);
    const noteLine = note ? t("server-approvals.wake.noteLine", { note }) : "";
    const prompt =
      r.kind === "interception" && x.classifier
        ? t("server-approvals.wake.retryAfterOutage", { owner, ops: opList(x.ops || [], t), note: noteLine })
        : r.kind === "interception"
          ? // the tool's arguments and the refusal's rationale are
            // model-made — fenced (the classifier retry's opList / fenced), never bare.
            t(x.reviewer === "auto_review" ? "server-approvals.wake.allowedReview" : "server-approvals.wake.allowedAuto", {
              owner,
              ops: opList([{ item: "", tool: x.tool || t("server-approvals.tool"), reason: "", request: x.input ?? null }], t),
              reason: fenced(t("server-approvals.wake.reviewReason"), String(x.reason || x.message || ""), 500, t),
              note: noteLine,
            })
          : t("server-approvals.wake.ownerDecided", {
              owner,
              id: `ask:${r.id}`,
              question: String(x.question).slice(0, 2000),
              label,
              decision,
              note: noteLine,
            });
    c.queueWake(r.session_id, `owner-approval:${r.id}`, prompt, {
      type: "peer-reply",
      senderName: username(who),
      senderKind: "human",
      ownerName: username(who),
      place: t("server-approvals.place.approvals"),
      messageId: "",
      question: String(x.question || x.tool || "").slice(0, 200),
    });
  }
  function decideOwn(a: Actor, rid: string, kind: string, b: any) {
    const r = store.one(
      "SELECT * FROM owner_approvals WHERE id=? AND owner_id=? AND kind=?",
      rid,
      a.id,
      kind,
    );
    if (!r) fail(404, "approval_not_found", "server-approvals.error.notFound");
    expireOwn(r);
    const row = store.one("SELECT * FROM owner_approvals WHERE id=?", rid);
    if (row.status !== "pending") {
      if (row.decision === b.decision) return ownView(row);
      if (row.status === "expired") fail(409, "approval_expired", "server-approvals.error.expired");
      fail(409, "approval_closed", "server-approvals.error.closed");
    }
    const x = JSON.parse(row.data);
    if (!(x.options || []).some((o: any) => o.key === b.decision))
      fail(422, "approval_option_unknown", "server-approvals.error.notAnOption");
    const note = (b.note || "").trim().slice(0, 2000);
    const state = NO.test(b.decision) ? "rejected" : "approved";
    store.atomic(() => {
      store.run(
        "UPDATE owner_approvals SET status=?,decision=?,note=?,decided_by=?,decided_at=? WHERE id=? AND status='pending'",
        state,
        b.decision,
        note || null,
        a.id,
        Date.now(),
        rid,
      );
      // the owner acted on the outage card — a new streak starts.
      if (x.classifier)
        store.run(
          "DELETE FROM classifier_retries WHERE session_id=?",
          row.session_id,
        );
      // Codex's refusal allowed — its reviewer is told natively
      // (where the node can; the Runner says so in the turn that carries
      // it), then the same wake asks for the retry.
      const s = store.session(row.session_id);
      if (kind === "interception" && b.decision === "retry" && x.guardian && s)
        queueNativeApproval(store, s, `block:${rid}`, x.guardian, x.thread);
      // An interception kept (dismiss) needs no turn; anything else does.
      if (!(kind === "interception" && b.decision === "dismiss"))
        wakeWith(row, b.decision, note, a.id);
      c.approvalEvent(
        a.id,
        `${kind === "interception" ? "block" : "ask"}:${rid}`,
        state,
        ownerT()(kind === "interception" ? "server-approvals.event.interceptionDecided" : "server-approvals.event.ownerDecided", {
          label:
            kind === "interception" && (b.decision === "retry" || b.decision === "dismiss")
              ? interceptionLabel(!!x.classifier, b.decision)
              : (x.options || []).find((o: any) => o.key === b.decision)?.label || b.decision,
        }),
        row.session_id,
      );
      store.audit(a.id, `approval.${kind}.${state}`, rid);
    });
    return ownView(store.one("SELECT * FROM owner_approvals WHERE id=?", rid));
  }
  /** 24 h without an answer: expired, and the AI is told once. */
  function expireOwn(r: any, now = Date.now()) {
    if (r.status !== "pending" || !r.expires_at || r.expires_at > now) return;
    store.atomic(() => {
      if (
        !store.run(
          "UPDATE owner_approvals SET status='expired' WHERE id=? AND status='pending'",
          r.id,
        ).changes
      )
        return;
      c.approvalEvent(
        r.owner_id,
        `${r.kind === "interception" ? "block" : "ask"}:${r.id}`,
        "expired",
        ownerT()("server-approvals.event.expired24h"),
        r.session_id,
      );
      if (r.kind === "owner") {
        const x = JSON.parse(r.data);
        c.queueWake(
          r.session_id,
          `owner-approval:${r.id}:expired`,
          inSessionT(store.session(r.session_id))("server-approvals.wake.ownerExpired", {
            id: r.id,
            question: String(x.question).slice(0, 2000),
          }),
          {
            type: "peer-failure",
            senderName: systemSender(ownerT()),
            senderKind: "human",
            ownerName: "",
            place: inSessionT(store.session(r.session_id))("server-approvals.place.approvals"),
            messageId: "",
            question: String(x.question).slice(0, 200),
          },
        );
      }
    });
  }
  /**
   * Q-1 / R-4: a harness's tool permission or question card nobody
   * answered within its time limit stops its turn, as 「停止」 does
   * (`cancel`, so an answer is refused from now on). The turn's end then
   * expires the card the usual way (queue.ts `settleJob`) and says why
   * (`expiredTurn`); nothing is replayed.
   */
  function expireNative(now: number) {
    for (const r of store.all(
      `SELECT DISTINCT a.job_id FROM approvals a JOIN jobs j ON j.id=a.job_id
       WHERE j.status='running' AND j.cancel=0
         AND json_extract(a.data,'$.status')='pending'
         AND json_extract(a.data,'$.createdAt')<=? LIMIT 100`,
      now - cardTtl,
    ))
      store.run(
        "UPDATE jobs SET cancel=1 WHERE id=? AND status='running' AND cancel=0",
        r.job_id,
      );
  }
  /**
   * The notice of a turn that ends while a card of it is past its time
   * limit (null: none is) — what the conversation shows instead of the
   * Runner's 「审批等待已取消」.
   */
  function expiredTurn(jobId: string): string | null {
    return store.one(
      `SELECT 1 FROM approvals WHERE job_id=?
         AND json_extract(data,'$.status')='pending'
         AND json_extract(data,'$.createdAt')<=?`,
      jobId,
      clock() - cardTtl,
    )
      ? ownerT()("server-approvals.turn.cardExpired", { ttl: ttlText(cardTtl) })
      : null;
  }
  /** A pending card past its time limit: why it cannot be answered (else null). */
  function overdue(a: Approval, t: Translate = ownerT()): string | null {
    return a.status === "pending" && a.createdAt + cardTtl <= clock()
      ? t("server-approvals.turn.overdue", { ttl: ttlText(cardTtl, t) })
      : null;
  }
  function sweep(now = clock()) {
    expireNative(now);
    store.run(
      "DELETE FROM classifier_retry_items WHERE created<?",
      now - 7 * 86400_000,
    );
    store.run(
      "DELETE FROM classifier_retries WHERE updated<?",
      now - 86400_000,
    );
    for (const r of store.all(
      "SELECT * FROM owner_approvals WHERE status='pending' AND expires_at IS NOT NULL AND expires_at<=? LIMIT 100",
      now,
    ))
      expireOwn(r, now);
  }
  /**
   * The Runner reported that auto mode refused a tool call (an item of
   * category "interception"): one card per item, for the owner.
   */
  function intercepted(job: any, item: any) {
    const s = store.session(job.session_id);
    if (!s || s.deleting) return;
    // the classifier could not decide — Daisy retries, no card.
    if (classifierUnavailable(item))
      return store.atomic(() => classifierRefused(s, job, item));
    const input = item.input || {};
    const rid = id();
    // Codex's automatic review (reasonType is the Runner's own
    // constant). Its event is kept only in the shape the Runner builds
    // from Codex's notification, for the native 「允许并重试」.
    const review: Record<string, unknown> =
      input.reasonType === "auto_review"
        ? {
            reviewer: "auto_review",
            ...(typeof input.riskLevel === "string"
              ? { riskLevel: input.riskLevel.slice(0, 40) }
              : {}),
            ...(typeof input.userAuthorization === "string"
              ? { userAuthorization: input.userAuthorization.slice(0, 40) }
              : {}),
            ...(guardianEvent(input.guardian)
              ? { guardian: input.guardian }
              : {}),
            // A subagent's refusal: approved natively in that thread only.
            ...(typeof input.threadId === "string" && input.threadId
              ? { thread: input.threadId.slice(0, 200) }
              : {}),
          }
        : {};
    // P2-03: the card and its notice / event in one transaction.
    store.atomic(() => {
      const changes = store.run(
        `INSERT OR IGNORE INTO owner_approvals(id,kind,session_id,owner_id,job_id,request_id,data,status,created,expires_at)
        VALUES(?,'interception',?,?,?,?,?,'pending',?,NULL)`,
        rid,
        s.id,
        s.ownerId,
        job.id,
        `item:${String(item.id).slice(0, 200)}`,
        JSON.stringify({
          tool: String(input.toolName || item.name || "").slice(0, 200),
          reason: String(input.reason || "").slice(0, 2000),
          message: String(input.message || item.text || "").slice(0, 2000),
          input: preview(input.request ?? null),
          ...review,
          options: [
            { key: "retry", label: interceptionLabel(false, "retry") },
            { key: "dismiss", label: interceptionLabel(false, "dismiss") },
          ],
        }),
        Date.now(),
      ).changes;
      if (!changes) return;
      c.approvalEvent(
        s.ownerId,
        `block:${rid}`,
        "pending",
        ownerT()(review.reviewer ? "server-approvals.interception.titleReview" : "server-approvals.interception.titleAuto", {
          agent: agentLabel({ title: s.title, ownerName: username(s.ownerId) }, ownerT()),
          tool: input.toolName || item.name || ownerT()("server-approvals.tool"),
        }),
        s.id,
      );
    });
  }

  /**
   * a Codex GuardianAssessmentEvent as the Runner builds it (a
   * refusal, an action, bounded) — anything else is not kept.
   */
  function guardianEvent(e: any): boolean {
    return (
      !!e &&
      typeof e === "object" &&
      !Array.isArray(e) &&
      typeof e.id === "string" &&
      e.status === "denied" &&
      !!e.action &&
      typeof e.action === "object" &&
      typeof e.action.type === "string" &&
      JSON.stringify(e).length <= 8000
    );
  }

  // ── classifier unavailable → automatic retry wake ────────────────────
  type RetryState = {
    streak: number;
    lastAt: number;
    /** When the latest retry wake was due (a refusal from an older turn is not its failure). */
    wakeAt: number;
    requestId: string;
    /** The outage card while one is open: no more automatic retries. */
    held: string;
    jobs: string[];
    ops: BlockedOp[];
  };
  const freshState = (): RetryState => ({
    streak: 0,
    lastAt: 0,
    wakeAt: 0,
    requestId: "",
    held: "",
    jobs: [],
    ops: [],
  });
  function retryState(sid: string): RetryState | null {
    const r = store.one(
      "SELECT data FROM classifier_retries WHERE session_id=?",
      sid,
    );
    return r ? { ...freshState(), ...JSON.parse(r.data) } : null;
  }
  const saveState = (sid: string, st: RetryState) =>
    store.run(
      "INSERT INTO classifier_retries(session_id,data,updated) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data,updated=excluded.updated",
      sid,
      JSON.stringify(st),
      Date.now(),
    );
  // Said when it is written (the owner's language then).
  const retryOrigin = (t: Translate) => ({
    type: "peer-failure",
    // A Daisy event: the transcript shows it as
    // one, not as an unfinished collaboration request.
    event: "classifier-retry",
    senderName: systemSender(ownerT()),
    senderKind: "human",
    ownerName: "",
    place: t("server-approvals.place.autoMode"),
    messageId: "",
    question: t("server-approvals.origin.classifierRetry"),
  });
  /** The outage card `cid`, while it is still open. */
  const openCard = (cid: string) =>
    cid
      ? store.one(
          "SELECT id,data FROM owner_approvals WHERE id=? AND status='pending'",
          cid,
        )
      : null;
  /** The retry wake `rq` while it has not been delivered (wakes). */
  const waitingWake = (sid: string, rq: string) =>
    rq
      ? store.one(
          "SELECT 1 FROM wakes WHERE session_id=? AND request_id=? AND status='pending'",
          sid,
          rq,
        )
      : null;
  /** …or delivered as a job that has not started yet (session was busy). */
  const waitingJob = (sid: string, rq: string) =>
    rq
      ? store.one(
          "SELECT id,created FROM jobs WHERE session_id=? AND request_id=? AND status IN ('pending','queued')",
          sid,
          rq,
        )
      : null;
  const joinCard = (card: any, op: BlockedOp) => {
    const x = JSON.parse(card.data);
    x.ops = [...(x.ops || []), op].slice(-CLASSIFIER_MAX_OPS * 2);
    store.run(
      "UPDATE owner_approvals SET data=? WHERE id=?",
      JSON.stringify(x),
      card.id,
    );
  };
  /**
   * The classifier is back (or the window passed): the streak restarts.
   * An open outage card stays held (it keeps collecting), and a retry not
   * yet started keeps collecting too (its list is still owed).
   */
  const restart = (sid: string, st: RetryState): RetryState => {
    const owed = !!(
      waitingWake(sid, st.requestId) || waitingJob(sid, st.requestId)
    );
    return {
      ...freshState(),
      held: openCard(st.held) ? st.held : "",
      requestId: owed ? st.requestId : "",
      ops: owed ? st.ops : [],
    };
  };
  function classifierRefused(s: Session, job: any, item: any) {
    const itemId = String(item.id).slice(0, 200);
    // The retry wake is written into this session: in its language.
    const wakeT = inSessionT(s);
    // Resent or updated items count once.
    if (
      !store.run(
        "INSERT OR IGNORE INTO classifier_retry_items(session_id,item_id,created) VALUES(?,?,?)",
        s.id,
        itemId,
        Date.now(),
      ).changes
    )
      return;
    const now = Date.now();
    const input = item.input || {};
    let st = retryState(s.id) || freshState();
    if (st.lastAt && now - st.lastAt > CLASSIFIER_WINDOW)
      st = restart(s.id, st);
    st.lastAt = now;
    if (!st.jobs.includes(job.id)) st.jobs = [...st.jobs, job.id].slice(-50);
    const op: BlockedOp = {
      item: itemId,
      tool: String(input.toolName || item.name || "").slice(0, 200),
      reason: "Classifier unavailable",
      request: preview(input.request ?? null),
    };
    // One card for the outage: while it is open, refusals join its list
    // and nothing retries automatically (the owner decides).
    const card = openCard(st.held);
    if (card) {
      joinCard(card, op);
      return saveState(s.id, st);
    }
    st.held = "";
    // Coalesced: at most one outstanding retry per session. Not delivered
    // yet → its wake; delivered but not started (busy) → its job's text.
    if (waitingWake(s.id, st.requestId)) {
      st.ops = [...st.ops, op].slice(-CLASSIFIER_MAX_OPS * 2);
      store.run(
        "UPDATE wakes SET prompt=? WHERE session_id=? AND request_id=?",
        retryPrompt(st.ops, Math.max(1, st.streak), wakeT),
        s.id,
        st.requestId,
      );
      return saveState(s.id, st);
    }
    const queued = waitingJob(s.id, st.requestId);
    if (queued) {
      st.ops = [...st.ops, op].slice(-CLASSIFIER_MAX_OPS * 2);
      const text = retryPrompt(st.ops, Math.max(1, st.streak), wakeT);
      store.run("UPDATE jobs SET text=? WHERE id=?", text, queued.id);
      d.publish?.(s.id, "item", {
        id: `user:${queued.id}`,
        kind: "user",
        text,
        status: "queued",
        origin: retryOrigin(wakeT),
        createdAt: queued.created,
      });
      return saveState(s.id, st);
    }
    // A new round, unless the refusal came from a turn older than the
    // retry wake (that one is still owed a retry, but is not its failure).
    if (!st.wakeAt || (job.created ?? now) >= st.wakeAt) st.streak++;
    st.streak = Math.max(1, st.streak);
    st.ops = [op];
    if (st.streak > CLASSIFIER_MAX_RETRIES) {
      // Still one card: an older outage card left open takes this round.
      const open = store.one(
        "SELECT id,data FROM owner_approvals WHERE session_id=? AND kind='interception' AND status='pending' AND request_id LIKE 'classifier-outage:%' ORDER BY created DESC LIMIT 1",
        s.id,
      );
      st.requestId = "";
      if (open) {
        joinCard(open, op);
        st.held = open.id;
        return saveState(s.id, st);
      }
      const rid = id();
      store.run(
        `INSERT INTO owner_approvals(id,kind,session_id,owner_id,job_id,request_id,data,status,created,expires_at)
        VALUES(?,'interception',?,?,?,?,?,'pending',?,NULL)`,
        rid,
        s.id,
        s.ownerId,
        job.id,
        `classifier-outage:${rid}`,
        JSON.stringify({
          classifier: true,
          tool: op.tool,
          reason: op.reason,
          message: ownerT()("server-approvals.interception.outageMessage", { n: CLASSIFIER_MAX_RETRIES }),
          input: null,
          ops: st.ops,
          options: [
            { key: "retry", label: interceptionLabel(true, "retry") },
            { key: "dismiss", label: interceptionLabel(true, "dismiss") },
          ],
        }),
        now,
      );
      st.held = rid;
      saveState(s.id, st);
      c.approvalEvent(
        s.ownerId,
        `block:${rid}`,
        "pending",
        ownerT()("server-approvals.interception.outageEvent", {
          agent: agentLabel({ title: s.title, ownerName: username(s.ownerId) }, ownerT()),
        }),
        s.id,
      );
      store.audit("system", "approval.interception.classifier-outage", rid);
      return;
    }
    st.requestId = `classifier-retry:${id()}`;
    st.wakeAt = now + CLASSIFIER_BACKOFF[st.streak - 1];
    store.run(
      "INSERT OR IGNORE INTO wakes(session_id,request_id,prompt,origin,created,next_at) VALUES(?,?,?,?,?,?)",
      s.id,
      st.requestId,
      retryPrompt(st.ops, st.streak, wakeT),
      JSON.stringify(retryOrigin(wakeT)),
      now,
      st.wakeAt,
    );
    saveState(s.id, st);
  }
  /**
   * A turn ended (settleJob). Only a Daisy retry turn that ended normally
   * without a classifier-unavailable refusal shows the classifier is back
   * (any other idle turn may simply not have used a checked tool).
   */
  function turnEnded(
    job: { id: string; session_id: string; request_id?: string | null },
    status: string,
  ) {
    if (status !== "idle") return;
    if (!String(job.request_id || "").startsWith("classifier-retry:")) return;
    const st = retryState(job.session_id);
    if (!st || st.jobs.includes(job.id) || !st.streak) return;
    saveState(job.session_id, restart(job.session_id, st));
  }
  /**
   * A Daisy retry appended into a running turn and
   * read at `readAt`; that turn ended (`status`). Like a retry turn of its
   * own (turnEnded): ended normally with no classifier-unavailable refusal
   * after it was read → the classifier is back, the streak restarts.
   */
  function retryRead(sid: string, readAt: number, status: string) {
    if (status !== "idle") return;
    const st = retryState(sid);
    if (!st || !st.streak) return;
    if (st.lastAt && st.lastAt >= readAt) return;
    saveState(sid, restart(sid, st));
  }
  /**
   * A tool call finished successfully (Runner item): if it is one of the
   * tools the classifier could not check (e.g. Bash), it was checked now —
   * the classifier is back, the streak restarts.
   */
  function toolSucceeded(job: { session_id: string }, item: any) {
    if (item?.kind !== "tool" || item.status !== "complete") return;
    if (item.category === "interception") return;
    const st = retryState(job.session_id);
    if (!st || !st.streak) return;
    const name = String(item.name || "");
    if (!name || !st.ops.some((o) => o.tool === name)) return;
    saveState(job.session_id, restart(job.session_id, st));
  }

  // ── 讨论串: ask a question on an approval, the AI answers ──────────────
  /** Who decides and which AI asked, per card kind (null = no such card). */
  function parties(aid: string): {
    ownerId: string;
    session: string | null;
    what: MessageKey;
    unsupported?: MessageKey;
  } | null {
    if (aid.startsWith("perm:")) {
      const n = nativeRow(aid.slice(5));
      const s = n && store.session(n.sessionId);
      return s
        ? {
            ownerId: s.ownerId,
            session: null,
            what: "server-approvals.thread.whatPermission",
            unsupported: "server-approvals.error.permissionThread",
          }
        : null;
    }
    if (aid.startsWith("ask:") || aid.startsWith("block:")) {
      const r = store.one(
        "SELECT * FROM owner_approvals WHERE id=?",
        aid.slice(aid.indexOf(":") + 1),
      );
      if (!r || r.kind !== (aid.startsWith("ask:") ? "owner" : "interception"))
        return null;
      return {
        ownerId: r.owner_id,
        session: r.session_id,
        what: r.kind === "owner" ? "server-approvals.thread.whatOwner" : "server-approvals.thread.whatInterception",
      };
    }
    // Call cards: stage 4 (call authorization) adds theirs here.
    return null;
  }
  const commentRows = (aid: string) =>
    store.all("SELECT * FROM approval_comments WHERE aid=? ORDER BY n", aid);
  function entryView(r: any): ApprovalThreadEntry {
    const human = r.by_kind === "human";
    const s = human ? null : store.session(r.by_id);
    return {
      n: r.n,
      at: r.at,
      by: {
        kind: human ? "human" : "agent",
        id: r.by_id,
        name: human
          ? username(r.by_id)
          : s
            ? agentLabel({ title: s.title, ownerName: username(s.ownerId) }, ownerT())
            : ownerT()("server-approvals.deletedAi"),
      },
      role: r.role,
      ai: !human,
      kind: r.kind,
      body: r.body,
    };
  }
  function threadSummary(aid: string): ApprovalThreadSummary | null {
    const last = store.one(
      "SELECT *,(SELECT count(*) FROM approval_comments WHERE aid=?) AS cnt FROM approval_comments WHERE aid=? ORDER BY n DESC LIMIT 1",
      aid,
      aid,
    );
    if (!last) return null;
    const e = entryView(last);
    return {
      count: Number(last.cnt),
      last: {
        n: e.n,
        role: e.role,
        ai: e.ai,
        kind: e.kind,
        at: e.at,
        by: e.by.name,
      },
    };
  }
  /** The card as its approver (owner) sees it, for the status. */
  function cardStatus(ownerId: string, aid: string) {
    return (
      find({ ownerId, kind: "human", id: ownerId }, aid)?.status || "canceled"
    );
  }
  function threadView(
    aid: string,
    p: NonNullable<ReturnType<typeof parties>>,
    role: "approver" | "requester",
  ): ApprovalThread {
    const s = p.session ? store.session(p.session) : null;
    return {
      id: aid,
      status: cardStatus(p.ownerId, aid) as ApprovalThread["status"],
      entries: commentRows(aid).map(entryView),
      me: { role, canPost: !p.unsupported },
      requester:
        s && !s.deleting
          ? {
              sessionId: s.id,
              title: agentLabel({
                title: s.title,
                ownerName: username(s.ownerId),
              }, ownerT()),
            }
          : null,
    };
  }
  const THREAD_MAX = 200,
    STREAK_MAX = 5,
    // Review M2: per poster per card, total size, and wakes coalesced.
    RATE_N = 10,
    RATE_WINDOW = 600_000,
    THREAD_BYTES = 64 * 1024,
    COALESCE_MS = 30_000;
  /**
   * The asking AI hears questions at most once per 30 s per card: the first
   * question queues a wake due in 30 s; more questions before it is
   * delivered are appended to it (one turn, all of them).
   */
  function debouncedWake(
    sid: string,
    aid: string,
    n: number,
    prompt: string,
    more: string,
    origin: any,
  ) {
    const waiting = store.one(
      "SELECT request_id,prompt FROM wakes WHERE session_id=? AND request_id LIKE ? AND status='pending' ORDER BY created DESC LIMIT 1",
      sid,
      `approval-comment:${aid}:%`,
    );
    if (waiting) {
      store.run(
        "UPDATE wakes SET prompt=? WHERE session_id=? AND request_id=?",
        `${waiting.prompt}\n${more}`.slice(0, 20_000),
        sid,
        waiting.request_id,
      );
      return;
    }
    const now = Date.now();
    store.run(
      "INSERT OR IGNORE INTO wakes(session_id,request_id,prompt,origin,created,next_at) VALUES(?,?,?,?,?,?)",
      sid,
      `approval-comment:${aid}:${n}`,
      prompt,
      JSON.stringify(origin),
      now,
      now + COALESCE_MS,
    );
  }
  function addComment(
    aid: string,
    p: NonNullable<ReturnType<typeof parties>>,
    who: { kind: "human" | "agent"; id: string },
    role: "approver" | "requester",
    b: { body: string; kind: "comment" | "change_request"; requestId?: string },
  ) {
    if (p.unsupported) fail(409, "approval_thread_unsupported", p.unsupported);
    if (b.kind === "change_request" && role !== "approver")
      fail(403, "approval_change_request_forbidden", "server-approvals.error.changeRequestApproverOnly");
    if (
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(
        b.body,
      )
    )
      fail(422, "approval_comment_control_chars", "server-approvals.error.controlChars");
    return store.atomic(() => {
      if (b.requestId) {
        const prior = store.one(
          "SELECT * FROM approval_comments WHERE aid=? AND by_id=? AND request_id=?",
          aid,
          who.id,
          b.requestId,
        );
        if (prior) return { entry: entryView(prior), duplicate: true };
      }
      const rows = commentRows(aid);
      if (rows.length >= THREAD_MAX) fail(409, "approval_thread_full", "server-approvals.error.threadFull", { n: THREAD_MAX });
      const used = rows.reduce(
        (k: number, r: any) => k + Buffer.byteLength(String(r.body)),
        0,
      );
      if (used + Buffer.byteLength(b.body) > THREAD_BYTES)
        fail(413, "approval_thread_too_large", "server-approvals.error.threadTooLarge", { kib: THREAD_BYTES / 1024 });
      const since = Date.now() - RATE_WINDOW;
      if (
        rows.filter((r: any) => r.by_id === who.id && r.at > since).length >=
        RATE_N
      )
        fail(429, "approval_comment_rate", "server-approvals.error.commentRate", { n: RATE_N });
      if (role === "requester") {
        let streak = 0;
        for (
          let i = rows.length - 1;
          i >= 0 && rows[i].role === "requester";
          i--
        )
          streak++;
        if (streak >= STREAK_MAX)
          fail(429, "approval_comment_streak", "server-approvals.error.commentStreak", { n: STREAK_MAX });
      }
      const n = (rows.at(-1)?.n || 0) + 1,
        now = Date.now();
      store.run(
        "INSERT INTO approval_comments(aid,n,at,by_kind,by_id,role,kind,body,request_id) VALUES(?,?,?,?,?,?,?,?,?)",
        aid,
        n,
        now,
        who.kind,
        who.id,
        role,
        b.kind,
        b.body,
        b.requestId || null,
      );
      const entry = entryView(
        store.one(
          "SELECT * FROM approval_comments WHERE aid=? AND n=?",
          aid,
          n,
        ),
      );
      const status = cardStatus(p.ownerId, aid);
      if (role === "approver" && p.session) {
        // The asking AI is woken with the question (once: wakes).
        const t = inSessionT(store.session(p.session));
        const change = b.kind === "change_request";
        const quote = b.body
          .split("\n")
          .map((l) => "> " + l)
          .join("\n");
        debouncedWake(
          p.session,
          aid,
          n,
          t(change ? "server-approvals.wake.commentChange" : "server-approvals.wake.commentQuestion", {
            name: entry.by.name,
            what: t.dynamic(p.what),
            id: aid,
            status: t(status === "pending" ? "server-approvals.thread.statusPending" : "server-approvals.thread.statusClosed"),
            quote,
          }),
          t(change ? "server-approvals.wake.commentMoreChange" : "server-approvals.wake.commentMoreQuestion", { n, quote }),
          {
            type: "peer-reply",
            senderName: entry.by.name,
            senderKind: "human",
            ownerName: username(p.ownerId),
            place: t("server-approvals.place.approvals"),
            messageId: "",
            question: b.body.slice(0, 200),
          },
        );
      } else if (role === "requester" && status === "pending") {
        // The approver hears the answer: the card surfaces again.
        c.approvalEvent(
          p.ownerId,
          aid,
          "pending",
          ownerT()("server-approvals.event.replied", { name: entry.by.name, body: b.body.replace(/\s+/g, " ").slice(0, 80) }),
          p.session || "",
        );
      }
      store.audit(
        who.kind === "human" ? who.id : p.ownerId,
        `approval.comment.${role}`,
        `${aid}#${n}`,
      );
      return { entry };
    });
  }
  const A = api.approvals;
  serve(app, A.comments, async (req: any) => {
    const a = person(req),
      aid = String(req.params.aid);
    const p = parties(aid);
    if (!p || p.ownerId !== a.id) fail(404, "approval_not_found", "server-approvals.error.notFound");
    return threadView(aid, p!, "approver");
  });
  serve(app, A.comment, async (req: any) => {
    const a = person(req),
      aid = String(req.params.aid),
      b = A.comment.body.parse(req.body);
    const p = parties(aid);
    if (!p || p.ownerId !== a.id) fail(404, "approval_not_found", "server-approvals.error.notFound");
    return addComment(aid, p!, { kind: "human", id: a.id }, "approver", b);
  });
  // ── one view of everything ────────────────────────────────────────────
  function list(a: Actor, which: "pending" | "decided" | "all") {
    sweep();
    const all: DaisyApproval[] = [
      ...c.access
        .listCards(a, { status: which, limit: 200 })
        .map((card) => callView(card)),
      ...nativeRows(a.id, which).map(nativeView),
      ...ownRows(a.id, which).map(ownView),
    ];
    for (const x of all) x.thread = threadSummary(x.id);
    return all.sort((x, y) => y.created - x.created || (y.id < x.id ? -1 : 1));
  }
  function find(a: Actor, aid: string): DaisyApproval | null {
    if (aid.startsWith("perm:")) {
      const n = nativeRow(aid.slice(5));
      return n && store.session(n.sessionId)?.ownerId === a.id
        ? nativeView(n)
        : null;
    }
    if (aid.startsWith("ask:") || aid.startsWith("block:")) {
      const r = store.one(
        "SELECT * FROM owner_approvals WHERE id=? AND owner_id=?",
        aid.slice(aid.indexOf(":") + 1),
        a.id,
      );
      return r ? ownView(r) : null;
    }
    return (
      c.access
        .listCards(a, { status: "all", limit: 200 })
        .map(callView)
        .find((x) => x.id === aid) || null
    );
  }
  /**
   * Live state of `uid`'s approvals by ID, for one pass over many rows (the
   * notification stream): the call cards are read once per
   * resolver, not once per row — that was
   * O(rows × cards). perm / ask / block are one indexed lookup each.
   */
  c.approvalHooks.resolver = (uid) => {
    const a: Actor = { ownerId: uid, kind: "human", id: uid };
    const cardState = cardStates((limit) =>
      c.access.listCards(a, { status: "all", limit }),
    );
    return (aid) => {
      if (
        aid.startsWith("perm:") ||
        aid.startsWith("ask:") ||
        aid.startsWith("block:")
      )
        return find(a, aid)?.status || null;
      return cardState(aid);
    };
  };
  c.approvalHooks.state = (uid, aid) => c.approvalHooks.resolver(uid)(aid);
  c.approvalHooks.pending = (uid) => [
    ...c.access.pendingIds(uid),
    ...nativeRows(uid, "pending").map((n) => `perm:${n.id}`),
    ...ownRows(uid, "pending")
      .filter((r) => !r.expires_at || r.expires_at > Date.now())
      .map((r) => `${r.kind === "interception" ? "block" : "ask"}:${r.id}`),
  ];

  serve(app, A.list, async (req: any) => {
    const a = person(req),
      q = A.list.query.parse(req.query);
    return {
      items: list(a, q.status)
        .filter((x) => q.before === undefined || x.created < q.before)
        .slice(0, q.limit),
    };
  });
  serve(app, A.show, async (req: any) => {
    const x = find(person(req), String(req.params.aid));
    if (!x) fail(404, "approval_not_found", "server-approvals.error.notFound");
    return { ...x!, thread: threadSummary(x!.id) };
  });
  serve(app, A.respond, async (req: any) => {
    const a = person(req),
      aid = String(req.params.aid),
      b = A.respond.body.parse(req.body);
    if (aid.startsWith("perm:")) {
      const n = nativeRow(aid.slice(5));
      const s = n && store.session(n.sessionId);
      if (!n || !s || s.ownerId !== a.id) fail(404, "approval_not_found", "server-approvals.error.notFound");
      if (n!.status !== "pending") {
        if (n!.decision?.optionId === b.decision) return nativeView(n!);
        fail(409, "approval_closed", "server-approvals.error.closedOrExpired");
      }
      d.answerNative(n!.sessionId, n!.id, { optionId: b.decision }, a.id);
      return nativeView(nativeRow(n!.id)!);
    }
    if (aid.startsWith("ask:")) return decideOwn(a, aid.slice(4), "owner", b);
    if (aid.startsWith("block:"))
      return decideOwn(a, aid.slice(6), "interception", b);
    const out = c.access.respondCard(a, aid, b);
    return out?.id ? callView(out) : out;
  });

  return {
    nativeOpened,
    nativeClosed,
    intercepted,
    turnEnded,
    expiredTurn,
    overdue,
    retryRead,
    toolSucceeded,
    sweep,
    list,
  };
}

export type DaisyApprovals = ReturnType<typeof daisyApprovals>;
export type { Session };
