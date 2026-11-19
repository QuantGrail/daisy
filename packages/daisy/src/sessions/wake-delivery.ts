/**
 * 唤醒投递（P1-01 从聊天的 collaboration.ts 抽出：`wakeJob`、
 * `queueWake`、`deliverWakes`）：把一段话作为 AI 自己的一轮交给它，唤醒
 * 它一次。用在审批的结果、到期，以及把一份答复作为参考资料交还给提问的
 * AI（`answer`，提示词见 source-prompt.ts）。
 *
 * - 先记下再投递：AI 暂时接不了（执行设备不在、已归档、队列满）时留在表
 *   里，退避重试（30 秒起翻倍，最长一小时），7 天或 200 次后放弃。
 * - 只一次：轮次的 (会话, request_id) 唯一，重复投递不会多出一轮。
 * - 会话删了就丢掉；归档的等它恢复。
 * - 轮次的 origin 是 `collab`（事件唤醒，不是主人自己的话；插队不会停它，
 *   见 queue-jump.ts）。
 */
import { id, type Store } from "../store/index.ts";
import type { Session } from "../../../contracts/src/index.ts";
import { residentHeld } from "../../../contracts/src/scheduler.ts";
import { sourcePrompt, type Source } from "../prompts/source-prompt.ts";
import { sessionLang } from "../../../contracts/src/prompt-i18n.ts";
import { isTraceId, traceForNewTurn } from "../observe/trace.ts";
import { inSessionT } from "../platform/language.ts";

/**
 * P4-08 (trace.md §3): a wake that continues a trace — the answer to an
 * AI's call goes back on the caller's trace at the caller's depth (not a
 * new trace, not one deeper). Absent: a new trace (or the action's), depth 0.
 */
export interface WakeTrace {
  traceId: string;
  depth: number;
}

/** Undeliverable for this long, or after this many tries: given up. */
export const WAKE_TTL = 7 * 86400_000;
export const WAKE_ATTEMPTS = 200;
/** A session with this many turns waiting takes no wake now (retried). */
export const WAKE_PENDING_MAX = 20;

export interface WakeDeliveryDeps {
  publish: (sid: string, type: any, data: any) => any;
  /** Extra check of the session's execution node (throws when unusable). */
  checkNode?: (n: any) => void;
}

export function wakeDelivery(store: Store, deps: WakeDeliveryDeps) {
  /** Can session `s` run a turn now (not archived or paused, node and identity there)? */
  function usable(s: Session): boolean {
    if (s.deleting || s.archived || residentHeld(s)) return false;
    const n = store.one("SELECT * FROM nodes WHERE id=?", s.nodeId);
    if (!n || n.revoked_at) return false;
    try {
      deps.checkNode?.(n);
    } catch {
      return false;
    }
    return !!store.one(
      "SELECT id FROM profiles WHERE id=? AND owner_id=?",
      s.profileId,
      s.ownerId,
    );
  }
  /**
   * Wake AI `s` once with `prompt` as its own turn; false when it cannot
   * run now or this `requestId` already woke it.
   */
  function wakeJob(s: Session, requestId: string, prompt: string, origin: any, trace?: WakeTrace | null) {
    if (!usable(s)) return false;
    if (
      store.one(
        "SELECT 1 FROM jobs WHERE session_id=? AND request_id=?",
        s.id,
        requestId,
      ) ||
      store.one(
        "SELECT count(*) n FROM jobs WHERE session_id=? AND status='pending'",
        s.id,
      ).n >= WAKE_PENDING_MAX
    )
      return false;
    const active = store.one(
      "SELECT 1 FROM jobs WHERE session_id=? AND status IN ('queued','running')",
      s.id,
    );
    const jid = id();
    store.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,origin,trace,depth) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      jid,
      s.id,
      s.nodeId,
      requestId,
      prompt,
      "[]",
      active ? "pending" : "queued",
      Date.now(),
      "collab",
      trace && isTraceId(trace.traceId) ? trace.traceId : traceForNewTurn(),
      trace ? Math.max(0, Math.floor(trace.depth) || 0) : 0,
    );
    store.run("UPDATE live_sessions SET stop=0 WHERE session_id=?", s.id);
    deps.publish(s.id, "item", {
      id: `user:${jid}`,
      kind: "user",
      text: prompt,
      status: "queued",
      origin,
      createdAt: Date.now(),
    });
    if (!active) deps.publish(s.id, "status", { status: "queued" });
    return true;
  }
  /**
   * Deliver the wakes due now, at most 50 per pass. One that cannot run
   * backs off and never holds up the rest.
   */
  function deliver(now = Date.now()) {
    for (const w of store.all(
      "SELECT * FROM wakes WHERE status='pending' AND next_at<=? ORDER BY next_at,created LIMIT 50",
      now,
    ))
      store.atomic(() => {
        const s = store.session(w.session_id);
        const done = (status: string) =>
          store.run(
            "UPDATE wakes SET status=? WHERE session_id=? AND request_id=?",
            status,
            w.session_id,
            w.request_id,
          );
        if (!s || s.deleting) return done("dropped");
        if (
          store.one(
            "SELECT 1 FROM jobs WHERE session_id=? AND request_id=?",
            s.id,
            w.request_id,
          ) ||
          wakeJob(
            s,
            w.request_id,
            w.prompt,
            JSON.parse(w.origin),
            w.trace ? { traceId: w.trace, depth: Number(w.depth) || 0 } : null,
          )
        )
          return done("delivered");
        if (now - w.created > WAKE_TTL || w.attempts + 1 >= WAKE_ATTEMPTS)
          return done("expired");
        store.run(
          "UPDATE wakes SET attempts=attempts+1,next_at=? WHERE session_id=? AND request_id=?",
          now + Math.min(3600_000, 30_000 * 2 ** w.attempts),
          w.session_id,
          w.request_id,
        );
      });
  }
  /** Record a one-time wake (idempotent by session × requestId) and try it now. */
  function queue(sid: string, requestId: string, prompt: string, origin: any, trace?: WakeTrace | null) {
    store.run(
      "INSERT OR IGNORE INTO wakes(session_id,request_id,prompt,origin,created,trace,depth) VALUES(?,?,?,?,?,?,?)",
      sid,
      requestId,
      prompt,
      JSON.stringify(origin ?? null),
      Date.now(),
      trace && isTraceId(trace.traceId) ? trace.traceId : null,
      trace ? Math.max(0, Math.floor(trace.depth) || 0) : 0,
    );
    deliver();
  }
  /**
   * Hand an answer back to the AI that asked, as reference material, and
   * wake it once: 【事件】你之前的提问有了回复, 【来自】 its source, the
   * answer as external data (the owner's own words plain), 【怎么处理】.
   */
  function answer(o: {
    sessionId: string;
    requestId: string;
    source: Source;
    ownerName: string;
    text: string;
    ownerWords?: boolean;
    sentAt?: number;
    meta?: Record<string, unknown>;
    origin?: any;
  }) {
    const prompt = sourcePrompt({
      event: inSessionT(store.session(o.sessionId))("server-sessions.wake.replied"),
      source: o.source,
      ownerName: o.ownerName,
      lang: sessionLang(store.session(o.sessionId)),
      ownerWords: o.ownerWords,
      outcome: "answer",
      text: o.text,
      sentAt: o.sentAt,
      meta: o.meta,
    });
    queue(
      o.sessionId,
      o.requestId,
      prompt,
      o.origin ?? {
        type: "peer-reply",
        senderName: o.source.name,
        senderKind: ["owner", "member"].includes(o.source.kind)
          ? "human"
          : "agent",
      },
    );
    return prompt;
  }
  /** State of a wake (tests, diagnostics). */
  const state = (sid: string, requestId: string) =>
    store.one(
      "SELECT status,attempts,next_at FROM wakes WHERE session_id=? AND request_id=?",
      sid,
      requestId,
    ) ?? null;
  return { queue, deliver, answer, wakeJob, usable, state };
}
export type WakeDelivery = ReturnType<typeof wakeDelivery>;
