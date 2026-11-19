// Queue actions: jump, merge, remove (P1-00: moved from index.ts).
/**
 * 「插队发送」 a queued message —
 * `POST /api/sessions/:id/queue/:jid/jump`. The message keeps its text,
 * attachments, context and terminal runs (it is the same job); it becomes
 * the next to run (`GET …/queue` lists it first with `jump: true`) and:
 * - `interrupting`: the owner's own running turn is being stopped
 *   (cancel=2); the message starts as soon as it has ended — if it is still
 *   queued then (removed meanwhile: the queue pauses as after a stop);
 * - `started`: nothing was running — it was promoted at once (a paused
 *   queue included);
 * - `next`: it runs right after the current turn, which is not stopped:
 *   a turn claimed but not started, or one that is not the owner's own
 *   message (someone else's request, a scheduled / callback wake, the AI's own
 *   turn) — `reason` says which (review M1).
 * 409 when a native operation (回退、/compact…) runs: never cut one short.
 *
 * `merged` — an earlier jump had not started yet (its stop was
 * still landing, or it was queued and not claimed): this message went into
 * it (`into`), one message and one interruption; its own queued row is gone
 * and its `user:<id>` item gets `status: "merged"`, `mergedInto`. A jump of a
 * different provenance (the owner's words vs a wake …) cannot merge: `next`
 * with `reason` 「…：前面插队的那一轮结束后发出」.
 */
export type QueueJumpMode =
  "interrupting" | "started" | "next" | "merged" | "appended";
export interface QueueJumpResult {
  id: string;
  mode: QueueJumpMode;
  /**
   * `next`: why it does not start at once (an earlier jump goes first);
   * `interrupting`: which kind of turn not the owner's own was
   * stopped (「已停止群里的协作请求」).
   */
  reason?: string;
  /**
   * `merged`: the queued job it went into — itself when this, the
   * owner's own message, took in an earlier jumped Daisy wake (`carried`).
   */
  into?: string;
  /**
   * Mixed: Daisy wakes (plugin callbacks, her approval
   * decisions, timers) that now ride the owner's message as labelled
   * context in the same turn; their `user:` / `wake:` items say merged.
   */
  carried?: string[];
}
/**
 * `POST /api/sessions/:id/queue/merge-jump {ids} | {all: true}` —
 * the selected queued messages, in queue order, merged into one and jumped
 * (fields of the first jump as in QueueJumpResult; `id` = the merged job).
 * With an owner's own message selected, it is that one message: her other
 * messages merge in, Daisy wakes it can carry ride it as labelled context
 * (`carried`, also in `merged`). Others (others' requests …) become their own
 * messages, running in later turns (`jobs`, in order). `merged`: the ids
 * folded into another.
 */
export interface QueueMergeJumpResult extends QueueJumpResult {
  merged: string[];
  jobs: string[];
}
/**
 * `POST /api/sessions/:id/queue/merge-steer {ids} | {all: true}` —
 * the selected queued messages (all `steerable`: the owner's own plain text)
 * go into the running turn as one 立即追加 (`input:<id>` item). 409 when one
 * is not steerable, nothing runs, or the agent is Kimi.
 */
export interface QueueMergeSteerResult {
  id: string;
  status: string;
  merged: string[];
  /**
   * the running turn is someone else's (another's request, 快速了解,
   * the AI's own, a Daisy wake's) — nothing was steered; the selected
   * rows are first in the queue after it (`status: "pending"`).
   */
  reason?: string;
  /**
   * selected rows that are not plain text but the agent's own
   * input queue takes — appended natively, each as itself
   * (`status: "appended"` when nothing was steered).
   */
  appended?: string[];
  /** selected rows that could not go in — still queued, why. */
  left?: { id: string; reason: string }[];
}
/**
 * `POST /api/sessions/:id/queue/remove {ids} | {all: true}` —
 * 「批量移除」: every selected row (or every row still waiting) as its own
 * 「移除」 / 「撤回」, in one transaction. `results` per row in queue order:
 * `ok` (removed), `withdrawing` (an appended row asked back from the agent),
 * or `ok: false` + `reason` (read already, gone, cannot be withdrawn).
 * `restored`: Daisy wakes a removed message carried, back in the queue.
 */
export interface QueueRemoveResult {
  results: {
    id: string;
    ok: boolean;
    withdrawing?: boolean;
    reason?: string;
  }[];
  removed: number;
  withdrawing: number;
  refused: number;
  restored?: string[];
}
