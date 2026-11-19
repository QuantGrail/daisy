import {
  forgetJump,
  forgetJumpStarted,
  jumpedList,
  markJumpStarted,
  nextPending,
  purgeJumps,
  othersJob,
  takeJump,
} from "../sessions/queue-jump.ts";
import { wakeBase } from "../sessions/native-append.ts";
import { ownerT, textsInEveryLanguage } from "../platform/language.ts";
import { requeueLiveInput } from "../sessions/steer-requeue.ts";
import { turnNotice } from "../sessions/notifications.ts";
import {
  purgeAppends,
  restoreAppended,
} from "../sessions/native-append.ts";
import { carriedParts, purgeMerges, removedWithParts } from "../sessions/queue-merge.ts";
import type {
  Event,
  Session,
} from "../../../contracts/src/index.ts";
import type { AppBase, LateServices } from "./context.ts";
import type { EventBus } from "./events.ts";
/**
 * A conversation's queue (P1-00: moved from app.ts): stopping, settling a
 * turn and starting the next, appended jobs, purging a deleted
 * conversation, the lease sweep.
 */
/**
 * A wake's text without the state suffix the queue added (so a new one
 * replaces it): the suffix in any language, or an older Chinese one
 * (`（已…）` / `（不会…）` / `（没…）`).
 */
function withoutWakeSuffix(item: { text?: unknown; tail?: unknown }): string {
  const text = String(item.text || "");
  for (const suffix of textsInEveryLanguage("server-app.queue.wakeExpiredSuffix"))
    if (text.endsWith(suffix)) return text.slice(0, -suffix.length);
  // The tail it was written with (any language), or an older row's (native-append).
  return wakeBase(item);
}

export function queueCore(ctx: AppBase & LateServices & EventBus) {
  const { store, lifecycle, publish, broadcast } = ctx;
  /**
   * Stop everything a conversation still has going: pending /
   * queued messages are interrupted, the running turn is flagged cancel —
   * its runner sees that on the next pulse (≤1 s) and kills the agent's
   * whole process group (SIGTERM, then SIGKILL). Returns whether a turn was
   * still running.
   */
  function stopWork(s: Session): boolean {
    for (const pending of store.all(
      // stop is stop — a job appended into the running turn and
      // not read yet goes as a queued one does (the Runner withdraws it
      // from the agent's queue as the turn stops; its hand-back is a no-op).
      "SELECT * FROM jobs WHERE session_id=? AND (status='pending' OR (status='appended' AND id IN (SELECT job_id FROM native_appends WHERE state='waiting')))",
      s.id,
    )) {
      store.run("UPDATE jobs SET status='interrupted' WHERE id=?", pending.id);
      // a callback wake's text is kept; so are callbacks
      // it carried — first, so their markers then say 「已保留」.
      keepCallbackOf(s, pending);
      // what was merged into it is stopped with it.
      removedWithParts(store, pending.id, publish);
      // a Daisy wake has no user bubble (its `wake:` marker stays).
      if (pending.origin === "schedule") continue;
      publish(s.id, "item", {
        ...JSON.parse(
          store.one(
            "SELECT data FROM items WHERE session_id=? AND id=?",
            s.id,
            `user:${pending.id}`,
          )?.data || "{}",
        ),
        id: `user:${pending.id}`,
        kind: "user",
        // the bubble's own words (the job may hold merged parts).
        text:
          JSON.parse(
            store.one(
              "SELECT data FROM items WHERE session_id=? AND id=?",
              s.id,
              `user:${pending.id}`,
            )?.data || "{}",
          ).text ?? pending.text,
        status: "cancelled",
        createdAt: pending.created,
      });
    }
    const j = store.one(
      "SELECT * FROM jobs WHERE session_id=? AND status IN ('queued','running')",
      s.id,
    );
    if (!j) return false;
    store.run("UPDATE jobs SET cancel=1 WHERE id=?", j.id);
    if (j.status === "queued") {
      keepCallbackOf(s, j);
      settle(j, "interrupted", ownerT()("server-app.queue.cancelledBeforeRun"));
      return false;
    }
    return true;
  }
  /**
   * a callback wake (a plugin's, hook 2) stopped before a Runner claimed it is
   * not voided: its text goes with the next turn (a paused resident holds
   * it; an archived conversation drops it). Stop still means stop — no
   * turn of its own.
   */
  function keepCallbackOf(s: Session, job: any) {
    // P1-10: the plugin that queued the wake hears of it (hook 2).
    const kept = ctx.scheduler.keepStopped(s, job);
    if (kept)
      ctx.plugins.wakeStopped({
        sessionId: s.id,
        scheduleId: kept.scheduleId,
        jobId: job.id,
        result: kept.result,
      });
    // Mixed selections: callbacks the owner's message carried, stopped with
    // it before it ran — kept for the next turn the same way.
    for (const part of carriedParts(store, job.id)) {
      const k = ctx.scheduler.keepStopped(s, part);
      if (k)
        ctx.plugins.wakeStopped({
          sessionId: s.id,
          scheduleId: k.scheduleId,
          jobId: job.id,
          result: k.result,
        });
    }
  }
  /**
   * appended job `jobId` read (or completed) after the turn it
   * went into had settled — that settle did not see it read; nothing else
   * would end it. Done now, as settle would have (the classifier retry's retryRead).
   */
  function settleLateRead(jobId: string) {
    const r = store.one(
      "SELECT n.*,j.request_id,j.session_id sid,t.status tstatus,t.created tcreated FROM native_appends n JOIN jobs j ON j.id=n.job_id LEFT JOIN jobs t ON t.id=n.into_job WHERE n.job_id=? AND j.status='appended' AND n.state IN ('started','completed') AND (t.id IS NULL OR t.status NOT IN ('queued','running'))",
      jobId,
    );
    if (!r) return;
    store.run("UPDATE jobs SET status='completed' WHERE id=?", jobId);
    store.run(
      "UPDATE native_appends SET state='completed' WHERE job_id=?",
      jobId,
    );
    if (String(r.request_id || "").startsWith("classifier-retry:"))
      ctx.approvalsHub?.retryRead(
        r.sid,
        r.read_at ?? r.tcreated ?? Date.now(),
        // retryRead takes the session status settle passes: a turn that
        // ended normally is "idle" (re-review L2).
        (r.tstatus || "completed") === "completed" ? "idle" : r.tstatus,
      );
  }
  /** an unread appended row whose turn ended ≤ this long ago goes back in line. */
  const STRAY_REQUEUE_MS = 60 * 60 * 1000;
  /**
   * appended jobs of `s` still `appended` though the turn they
   * went into is over (an older control plane; a crash between steps).
   * Safe by construction (review M1): read ones are done (`completed`);
   * unread ones the owner asked back (`withdraw`) are removed; unread ones
   * whose turn ended within STRAY_REQUEUE_MS go back to the head of the
   * queue as settle would have; older ones are not sent any more —
   * `interrupted`, with a notice saying so, and a plugin callback among
   * them is kept for the next turn (as a stop keeps it). Reads
   * first; writes only when there is something to settle. Not for an
   * archived / deleting conversation.
   */
  function tidyAppends(s: Session) {
    if (s.archived || s.deleting) return;
    const stray = () =>
      store.all(
        "SELECT n.*,t.status tstatus,t.lease_until tlease FROM native_appends n JOIN jobs j ON j.id=n.job_id LEFT JOIN jobs t ON t.id=n.into_job WHERE n.session_id=? AND j.status='appended' AND (t.id IS NULL OR t.status NOT IN ('queued','running'))",
        s.id,
      );
    if (!stray().length) return;
    store.atomic(() => {
      for (const r of stray()) {
        const job = store.one("SELECT * FROM jobs WHERE id=?", r.job_id);
        if (!job || job.status !== "appended") continue;
        if (r.state === "started" || r.state === "completed") {
          settleLateRead(job.id);
          continue;
        }
        const input = store.one(
          "SELECT * FROM live_inputs WHERE id=?",
          r.input_id,
        ) ?? { id: r.input_id, source_job: job.id };
        // restoreAppended removes a row the owner asked back (withdraw)
        // and otherwise puts it first in line, marked — with or without
        // its live input row.
        const recent =
          Math.max(r.created || 0, r.tlease || 0) >=
          Date.now() - STRAY_REQUEUE_MS;
        if (r.withdraw || recent) {
          restoreAppended(store, s.id, input, ownerT()("server-app.queue.turnEnded"), publish);
          continue;
        }
        // Expired: never sent again.
        store.run("UPDATE jobs SET status='interrupted' WHERE id=?", job.id);
        forgetJump(store, s.id, job.id);
        store.run(
          "UPDATE native_appends SET state='removed',withdraw=0 WHERE job_id=?",
          job.id,
        );
        store.run(
          "UPDATE live_inputs SET status='cancelled' WHERE id=? AND status IN ('queued','dispatched','accepted','error')",
          r.input_id,
        );
        const before = store.one(
          "SELECT COUNT(*) n FROM kept_callbacks WHERE session_id=?",
          s.id,
        )?.n;
        keepCallbackOf(s, job);
        const kept =
          store.one(
            "SELECT COUNT(*) n FROM kept_callbacks WHERE session_id=?",
            s.id,
          )?.n !== before;
        // Notices kept in the conversation: said once, in the owner's language.
        const t = ownerT();
        const at = new Date(r.created || Date.now()).toLocaleString(t.lang, {
          hour12: false,
        });
        const expired = t("server-app.queue.wakeExpiredSuffix");
        for (const id of [`user:${job.id}`, `wake:${job.id}`]) {
          const old = store.one(
            "SELECT data FROM items WHERE session_id=? AND id=?",
            s.id,
            id,
          );
          if (!old) continue;
          const d = JSON.parse(old.data || "{}");
          const { appendedInto: _drop, ...rest } = d;
          publish(s.id, "item", {
            ...rest,
            id,
            status: "cancelled",
            ...(id.startsWith("wake:")
              ? {
                  text: withoutWakeSuffix(d) + expired,
                }
              : {}),
          });
        }
        publish(s.id, "item", {
          id: `append-expired:${job.id}`,
          kind: "notice",
          text: t(kept ? "server-app.queue.appendExpiredKept" : "server-app.queue.appendExpired", { at }),
          status: "complete",
          createdAt: Date.now(),
        });
      }
    });
  }
  /** Remove a deleted conversation's rows once nothing of it runs any more. */
  function purgeIfDeleted(sid: string) {
    const s = store.session(sid);
    if (!s?.deleting) return;
    if (
      store.one(
        "SELECT 1 FROM jobs WHERE session_id=? AND status IN ('queued','running')",
        sid,
      )
    )
      return;
    store.atomic(() => {
      const jobs = "SELECT id FROM jobs WHERE session_id=?";
      store.run(`DELETE FROM live_inputs WHERE job_id IN (${jobs})`, sid);
      store.run(`DELETE FROM job_operations WHERE job_id IN (${jobs})`, sid);
      store.run(
        `DELETE FROM job_recovery_events WHERE job_id IN (${jobs})`,
        sid,
      );
      store.run("DELETE FROM job_recoveries WHERE session_id=?", sid);
      for (const t of ["approvals", "items", "events", "jobs"])
        store.run(`DELETE FROM ${t} WHERE session_id=?`, sid);
      store.run("DELETE FROM sessions WHERE id=?", sid);
      store.run("DELETE FROM live_sessions WHERE session_id=?", sid);
      // its Daisy timers / background items (the Runner stops
      // the running ones at its next sync).
      store.run("DELETE FROM agent_schedules WHERE session_id=?", sid);
      // results held for a paused resident.
      store.run("DELETE FROM resident_held_wakes WHERE session_id=?", sid);
      // callbacks kept for its next turn.
      store.run("DELETE FROM kept_callbacks WHERE session_id=?", sid);
      // its jump and merge bookkeeping.
      purgeJumps(store, sid);
      purgeMerges(store, sid);
      purgeAppends(store, sid);
    });
  }
  type SettleOptions = {
    keepPaused?: boolean;
    /** live inputs the Runner handed back (id → reason). */
    requeue?: { id: string; reason: string }[];
  };
  function settle(
    job: any,
    status: "idle" | "error" | "interrupted",
    detail?: string,
    opts: SettleOptions = {},
  ) {
    try {
      settleJob(job, status, detail, opts);
    } finally {
      purgeIfDeleted(job.session_id);
    }
  }
  /** the agent read appended job `jid` (started / completed). */
  const appendRead = (jid: string) =>
    !!store.one(
      "SELECT 1 FROM native_appends WHERE job_id=? AND state IN ('started','completed')",
      jid,
    );
  function settleJob(
    job: any,
    status: "idle" | "error" | "interrupted",
    detail?: string,
    opts: SettleOptions = {},
  ) {
    const events: (Event | null)[] = [];
    // Q-1 / R-4: stopped because a card of it went unanswered too long —
    // the conversation says so (the card expires below, as at any end).
    if (status === "interrupted")
      detail = ctx.approvalsHub?.expiredTurn(job.id) ?? detail;
    store.atomic(() => {
      store.run(
        "UPDATE jobs SET status=?,lease_until=0 WHERE id=?",
        status === "idle" ? "completed" : status,
        job.id,
      );
      // a normal turn ends a classifier-unavailable streak.
      ctx.approvalsHub?.turnEnded(job, status);
      // P1-08: 「一轮结束」 / 「AI 出错」 for the local web page.
      turnNotice(store, job, status, detail, !!opts.keepPaused);
      for (const r of store.all(
        "SELECT data FROM approvals WHERE job_id=?",
        job.id,
      )) {
        const a = JSON.parse(r.data);
        if (a.status === "pending") {
          events.push(
            store.append(a.sessionId, "approval", { ...a, status: "expired" }),
          );
          ctx.approvalsHub?.nativeClosed({ ...a, status: "expired" });
        }
      }
      // a steer this turn never took (still queued, or handed
      // over without an acknowledgement) is not lost: it becomes the next
      // turn, in line where it was sent, with a visible note. Before, it
      // was marked 「轮次已结束，未确认交接；请检查后重发」.
      // …and one the Runner handed back whose own requeue did not land
      // (review 3; same key, so never twice).
      const back = new Map((opts.requeue || []).map((r) => [r.id, r.reason]));
      for (const input of store.all(
        "SELECT * FROM live_inputs WHERE job_id=? AND status IN ('queued','dispatched','accepted','error') ORDER BY created",
        job.id,
      ))
        if (
          ["queued", "dispatched"].includes(input.status) ||
          back.has(input.id) ||
          // an appended Daisy job the agent never read is
          // Daisy's again (first in line); one it read is done.
          (input.source_job && !appendRead(input.source_job))
        )
          requeueLiveInput(
            store,
            job.session_id,
            input,
            back.get(input.id) || ownerT()("server-app.queue.turnEnded"),
            (sid, t, d) => events.push(store.append(sid, t, d)),
          );
      // appended jobs the agent read in this turn are done (their
      // `completed` may come after the turn's end).
      for (const r of store.all(
        "SELECT n.job_id,n.read_at,j.request_id FROM native_appends n JOIN jobs j ON j.id=n.job_id WHERE n.into_job=? AND n.state IN ('started','completed')",
        job.id,
      )) {
        // A classifier retry read in this turn.
        if (String(r.request_id || "").startsWith("classifier-retry:"))
          ctx.approvalsHub?.retryRead(
            job.session_id,
            r.read_at ?? job.created,
            status,
          );
        store.run(
          "UPDATE jobs SET status='completed' WHERE id=? AND status='appended'",
          r.job_id,
        );
        store.run(
          "UPDATE native_appends SET state='completed' WHERE job_id=?",
          r.job_id,
        );
      }
      // A turn that never started (canceled before it ran, e.g. a
      // 需要回复 withdrawn while it waited — second review 2026-11-03) lets
      // the next message run as an idle one does; a failed turn keeps the
      // rest waiting for its owner.
      // R #7 (review M2): stopped for 「插队发送」 (cancel=2) —
      // only the message that jumped, only while it is still queued; else
      // the queue pauses as after a stop. A jumped message goes first.
      const jumped =
        status === "interrupted" && job.cancel === 2
          ? takeJump(store, job)
          : null;
      // Since 2026-11-05 (「多条协作消息排队好像会卡死」) only
      // the owner's own turn failing / being stopped pauses the queue. A
      // group request, wake or AI-started turn that ended badly — a group
      // request withdrawn by its asker (cancel=1), a failed callback — lets
      // the queue go on in order; before, the owner's queued prompts stayed
      // behind it until 「继续」 while the pump kept running group requests.
      // A lost node (reap: `keepPaused`) and a failed native operation
      // (rewind, /compact: the next prompt would run on the wrong context)
      // still pause.
      // Also a jump's stop of someone else's turn whose jumped message is
      // gone (review 3): nothing of the owner's was stopped.
      const othersTurn =
        status !== "idle" && !opts.keepPaused && othersJob(store, job);
      const pending =
        jumped ??
        (status === "idle" ||
        othersTurn ||
        (status === "interrupted" && job.status === "queued" && !job.lease)
          ? nextPending(store, job.session_id)
          : null);
      forgetJumpStarted(store, job.id);
      // Stopped before any Runner took it — what was
      // merged into it did not go out either.
      if (status !== "idle" && job.status === "queued" && !job.lease)
        removedWithParts(store, job.id, (sid, t, d) =>
          events.push(store.append(sid, t, d)),
        );
      if (pending) {
        // A jumped message promoted for any reason
        // (its stop landed, or the turn ended first) — a jump arriving
        // before it is claimed merges into it.
        const wasJump = jumpedList(store, job.session_id).includes(pending);
        forgetJump(store, job.session_id, pending);
        store.run("UPDATE jobs SET status='queued' WHERE id=?", pending);
        if (wasJump) markJumpStarted(store, job.session_id, pending);
      }
      events.push(
        store.append(job.session_id, "status", {
          status: pending ? "queued" : status,
        }),
      );
      // the sidecar summaries this turn carried are done, or
      // waiting again when it did not end well.
      ctx.sidecars.settled(job.id, status === "idle");
      if (detail)
        events.push(
          store.append(job.session_id, "item", {
            // N-3: the job's own id prefix — the chat files this line under
            // the turn that ended this way (not whichever turn is last).
            id: `${job.id}:turn-end`,
            kind: "notice",
            text: detail,
            status,
            createdAt: Date.now(),
          }),
        );
    });
    events.forEach(broadcast);
    // A wake that waited for this turn to end can run now.
    ctx.wakes.deliver();
  }
  let lastSidecarSweep = 0;
  function reap() {
    // Background work runs in the lease holder only.
    if (!lifecycle.leading()) return;
    ctx.wakes.deliver();
    // idle sidecars close (at most once a minute).
    if (Date.now() - lastSidecarSweep > 60_000) {
      lastSidecarSweep = Date.now();
      ctx.sidecars.sweep();
    }
    ctx.approvalsHub?.sweep();
    ctx.live.reap();
    for (const j of store.all(
      "SELECT * FROM jobs WHERE status='running' AND lease_until<?",
      Date.now(),
    ))
      settle(
        // A lost node is not a jump's stop (review M2): the queue pauses.
        j.cancel === 2 ? { ...j, cancel: 1 } : j,
        "interrupted",
        ownerT()("server-app.queue.nodeLost"),
        { keepPaused: true },
      );
    for (const r of store.all(
      "SELECT id FROM sessions WHERE json_extract(data,'$.deleting')=1",
    ))
      purgeIfDeleted(r.id);
  }
  /** `<jobId>:…` item ids of this session's own (earlier) jobs. */
  function sessionJob(itemId: unknown, sid: string) {
    if (typeof itemId !== "string") return false;
    const jid = itemId.split(":")[0];
    return (
      !!jid &&
      !!store.one("SELECT 1 FROM jobs WHERE id=? AND session_id=?", jid, sid)
    );
  }
  return {
    stopWork,
    keepCallbackOf,
    settleLateRead,
    tidyAppends,
    purgeIfDeleted,
    settle,
    reap,
    sessionJob,
  };
}
export type QueueCore = ReturnType<typeof queueCore>;
