import type { Store } from "../store/index.ts";
import { ownerT } from "../platform/language.ts";
import type {
  NotificationAlertReason,
  NotificationClose,
  NotificationItem,
  NotificationKind,
} from "../../../contracts/src/notifications.ts";
import {
  NOTIFICATION_RETRACT_KIND,
  notificationCategory,
} from "../../../contracts/src/notifications.ts";

/**
 * Session notifications (P1-01: the chat's kinds and readers went
 * with the chat). What stays is what a session raises — a turn ended, an
 * approval card opened / closed, a call waiting for approval, an AI that
 * failed — written into one outbox, the source for the local web page's
 * notifications and the event outlet.
 */

/**
 * Latest unmerged turn per owned session (「一轮结束」). Driven from
 * sessions, not every historical job; status checked AFTER choosing the
 * newest turn so a running / queued turn never exposes an older result.
 * Only notification fields are read, not prompts or attachments.
 * P1-01: nothing reads it now — the 群聊's notification routes that did
 * are gone; kept for P1-08 (the local web page's notifications) and P2-03
 * (the event outlet), which turn it into 「一轮结束」 again.
 */
export const LATEST_AGENT_RESULTS_SQL = `
  SELECT j.id,j.session_id,j.status,j.created,json_extract(s.data,'$.title') title
  FROM sessions s JOIN jobs j ON j.id=(
    SELECT id FROM jobs WHERE session_id=s.id
      AND id NOT IN (SELECT job_id FROM queue_merges)
    ORDER BY created DESC,rowid DESC LIMIT 1
  )
  WHERE json_extract(s.data,'$.ownerId')=?
    AND json_extract(s.data,'$.deleting') IS NOT 1
    AND j.status IN ('completed','error','interrupted')`;

/** One notification for one person. */
export type NotificationWrite = {
  userId: string;
  kind: NotificationKind;
  title: string;
  /** Idempotency: the same key for the same person is stored once. */
  key: string;
  /** The session it is about. */
  sessionId?: string;
  /** What it is about (approval ID, job ID …). */
  subject?: string;
  actionRequired?: boolean;
  /**
   * Stable ID across revisions; a later write with the same ID updates the
   * item (collapse), a retract closes it. Default `${kind}:${subject || key}`.
   */
  notificationId?: string;
  /** Items shown together (default: the session). */
  collapseKey?: string;
  /** After this (ms) the item is moot (state expired, no alert); 0 = never. */
  expiresAt?: number;
};
export type NotificationRetract = {
  userId: string;
  notificationId: string;
  /** Why it closed (default handled). */
  state?: NotificationClose;
};

const defaultId = (kind: string, subject: string, key: string) =>
  `${kind}:${subject || key}`;
/** The stable ID of a stored row. */
export const rowNotificationId = (r: any): string =>
  r.item_key || defaultId(r.kind, r.subject, r.event_key);

const prepared = new WeakMap<Store, ReturnType<typeof make>>();
function make(store: Store) {
  const latest = (uid: string, nid: string) =>
    store.one(
      "SELECT seq,op,revision,kind,collapse_key FROM notification_events WHERE user_id=? AND item_key=? ORDER BY seq DESC LIMIT 1",
      uid,
      nid,
    );
  /** Returns the event's sequence, or null when the key was already stored. */
  function emit(w: NotificationWrite): number | null {
    const subject = w.subject || "";
    const nid = w.notificationId || defaultId(w.kind, subject, w.key);
    const last = latest(w.userId, nid);
    const r = store.run(
      `INSERT OR IGNORE INTO notification_events
      (event_key,user_id,kind,title,session_id,subject,action_required,created,op,item_key,revision,collapse_key,expires)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      w.key,
      w.userId,
      w.kind,
      w.title,
      w.sessionId || "",
      subject,
      Number(!!w.actionRequired),
      Date.now(),
      !last || last.op === "retract" ? "create" : "update",
      nid,
      (last?.revision || 0) + 1,
      w.collapseKey ?? (w.sessionId || ""),
      w.expiresAt || 0,
    );
    return r.changes ? Number(r.lastInsertRowid) : null;
  }
  /** Close an item on every device. No-op (null) when it is not open. */
  function retract(r: NotificationRetract): number | null {
    const last = latest(r.userId, r.notificationId);
    if (!last || last.op === "retract") return null;
    const res = store.run(
      `INSERT OR IGNORE INTO notification_events
      (event_key,user_id,kind,title,session_id,subject,action_required,created,op,item_key,revision,collapse_key,close_state)
      VALUES(?,?,?,'','','',0,?,'retract',?,?,?,?)`,
      `retract:${r.notificationId}:${last.seq}`,
      r.userId,
      NOTIFICATION_RETRACT_KIND,
      Date.now(),
      r.notificationId,
      last.revision + 1,
      last.collapse_key,
      r.state || "handled",
    );
    return res.changes ? Number(res.lastInsertRowid) : null;
  }
  return { emit, retract };
}

/**
 * The typed writer:
 *
 *   const n = notificationWriter(store);
 *   n.emit({ userId, kind: "approval", key, title, sessionId, subject,
 *            actionRequired: true, notificationId: `approval:${cardId}` });
 *   n.retract({ userId, notificationId: `approval:${cardId}`, state: "handled" });
 *
 * Call inside the same `store.atomic` as the state change it reports.
 */
export function notificationWriter(store: Store) {
  let w = prepared.get(store);
  if (!w) prepared.set(store, (w = make(store)));
  return w;
}

export type ApprovalState =
  "pending" | "approved" | "rejected" | "canceled" | "expired";
/**
 * The approval card's notification (P1-01: moved out of
 * collaboration.ts): every approval (harness permission prompts and
 * interceptions, call cards, an AI's approval to its owner) writes kind
 * "approval" — `emit` when it opens (actionRequired, notificationId
 * "approval:<cardId>", subject = the card's stable ID), `retract` when it
 * leaves pending (approved / rejected → handled, canceled → canceled,
 * expired → expired). Only the owner is ever notified of an approval.
 */
export function approvalNotices(store: Store) {
  const n = notificationWriter(store);
  return (
    uid: string,
    cardId: string,
    state: ApprovalState,
    title: string,
    sessionId = "",
  ) =>
    state === "pending"
      ? n.emit({
          userId: uid,
          kind: "approval",
          key: `approval:${cardId}:pending:${Date.now()}`,
          title: title.slice(0, 300),
          sessionId,
          subject: cardId,
          actionRequired: true,
          notificationId: `approval:${cardId}`,
        })
      : n.retract({
          userId: uid,
          notificationId: `approval:${cardId}`,
          state:
            state === "canceled"
              ? "canceled"
              : state === "expired"
                ? "expired"
                : "handled",
        });
}
export type ApprovalNotice = ReturnType<typeof approvalNotices>;

/**
 * P1-08: the read side the local web page uses (GET /api/notifications).
 * One row per item — its latest revision — newest change first. `after`
 * keeps only items that changed after that sequence. State: an open item
 * that wants an action is `pending`, another open one `unread` (read
 * receipts are each screen's own); a retracted one is how it closed.
 */
export function listNotifications(
  store: Store,
  uid: string,
  q: { sessionId?: string; after?: number; limit?: number } = {},
  alert?: (item: Omit<NotificationItem, "alert" | "alertReason">) => {
    alert: boolean;
    reason: NotificationAlertReason;
  },
): { items: NotificationItem[]; cursor: number } {
  notificationWriter(store); // the table exists
  const limit = Math.min(200, Math.max(1, q.limit ?? 50));
  const cursor = Number(
    store.one(
      "SELECT COALESCE(MAX(seq),0) n FROM notification_events WHERE user_id=?",
      uid,
    )?.n ?? 0,
  );
  // The latest row of each item (item_key; rows from before it existed
  // fall back to their own key), then the item's first row for its
  // session and subject (a retract row carries neither).
  const rows = store.all(
    `SELECT l.*, f.session_id first_session, f.subject first_subject,
       f.kind first_kind, f.title first_title, f.action_required first_action
     FROM notification_events l
     JOIN (SELECT MAX(seq) last, MIN(seq) first FROM notification_events
           WHERE user_id=? GROUP BY CASE WHEN item_key='' THEN 'k:'||event_key ELSE item_key END) g
       ON l.seq=g.last
     JOIN notification_events f ON f.seq=g.first
     WHERE l.seq>? ${q.sessionId ? "AND f.session_id=?" : ""}
     ORDER BY l.seq DESC LIMIT ?`,
    uid,
    q.after ?? 0,
    ...(q.sessionId ? [q.sessionId] : []),
    limit,
  );
  const items = rows.map((r: any): NotificationItem => {
    const retracted = r.op === "retract";
    // A retract row stores no title / kind: the item's own are the last
    // revision before it.
    const last = retracted
      ? store.one(
          "SELECT kind,title,action_required,expires FROM notification_events WHERE user_id=? AND item_key=? AND op!='retract' AND seq<? ORDER BY seq DESC LIMIT 1",
          uid,
          r.item_key,
          r.seq,
        )
      : r;
    const kind = String(last?.kind ?? r.first_kind);
    const actionRequired = !!(last?.action_required ?? r.first_action);
    const item = {
      id: String(r.seq),
      notificationId: rowNotificationId(r),
      op: r.op as NotificationItem["op"],
      revision: Number(r.revision),
      category: notificationCategory(kind),
      kind,
      state: (retracted
        ? r.close_state || "handled"
        : actionRequired
          ? "pending"
          : "unread") as NotificationItem["state"],
      title: String(last?.title ?? r.first_title ?? ""),
      sessionId: String(r.session_id || r.first_session || ""),
      subject: String(r.subject || r.first_subject || ""),
      actionRequired,
      collapseKey: String(r.collapse_key || ""),
      expiresAt: Number(last?.expires ?? r.expires ?? 0),
      created: Number(r.created),
    };
    if (!alert) return item;
    const a = alert(item);
    return { ...item, alert: a.alert, alertReason: a.reason };
  });
  return { items, cursor };
}

/**
 * P1-08: 「一轮结束」 and 「AI 出错」 of a turn, written where a turn
 * settles (app/queue.ts `settleJob`, inside its transaction). One item per
 * session (`turn:<session>`): the next turn's end replaces it. A turn the
 * owner stopped says nothing; one cut off by a lost process is an error.
 * Sidecars (「只问」) and deleted sessions are not the owner's turns.
 */
export function turnNotice(
  store: Store,
  job: { id: string; session_id: string },
  status: "idle" | "error" | "interrupted",
  detail?: string,
  lost = false,
) {
  if (status === "interrupted" && !lost) return null;
  const s: any = store.session(job.session_id);
  if (!s || s.sidecar || s.deleting) return null;
  const t = ownerT();
  const title = (s.title || t("server-sessions.notice.untitled")).slice(0, 120);
  const ok = status === "idle";
  return notificationWriter(store).emit({
    userId: s.ownerId,
    kind: ok ? "ai_private_message" : "ai_failed",
    key: `turn:${job.id}:${status}`,
    title: ok
      ? t("server-sessions.notice.turnDone", { title })
      : detail
        ? t(status === "error" ? "server-sessions.notice.turnErrorDetail" : "server-sessions.notice.turnInterruptedDetail", {
            title,
            detail: detail.slice(0, 160),
          })
        : t(status === "error" ? "server-sessions.notice.turnError" : "server-sessions.notice.turnInterrupted", { title }),
    sessionId: s.id,
    subject: job.id,
    notificationId: `turn:${s.id}`,
  });
}
