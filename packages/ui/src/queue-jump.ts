import {
  featuresFor,
  harnessName,
  type FeatureSupport,
} from "@daisy-ai/contracts";
import { t } from "./i18n";
import { readMigrated, type KeyValueStore } from "./storage-keys";
/**
 * 「插队发送」: the pure rules the composer shows.
 *
 * Two ways in while a turn runs, both after 「发送」 is the plain action:
 * - 立即追加 (steer): the text joins the running turn (Claude / Codex only;
 *   text only — the Runner hands a live input over as text);
 * - 插队发送 (jump): the message (attachments, terminal runs included) goes
 *   into the running turn natively, read at its next tool boundary, never
 *   stopping it (else first in the queue, right after this turn;
 *   nothing running → it starts now). From a queued card, or ⌘/Ctrl+Enter
 *   in the composer. Only 「停止」 interrupts.
 */
export interface SteerState {
  busy: boolean;
  terminalMode: boolean;
  editing: boolean;
  /** Finished terminal runs that go with the next message. */
  finished: number;
  agent: string | undefined;
  hasText: boolean;
  attachments: number;
  /**
   * P4-11 (§5.5): the session's declared 运行中追加 (snapshot
   * `features.steer`); absent (an older server): this release's table.
   */
  steer?: FeatureSupport | null;
}
/** P4-11: whether the AI takes anything into a running turn at all. */
export const steerDeclared = (s: {
  agent?: string;
  steer?: FeatureSupport | null;
}) => (s.steer ?? featuresFor(null, s.agent || "").steer) !== "none";
/** Whether 「立即追加」 can take the composer's content. */
export function canSteer(s: SteerState): boolean {
  return (
    s.busy &&
    !s.terminalMode &&
    !s.editing &&
    !s.finished &&
    steerDeclared(s) &&
    s.hasText &&
    !s.attachments
  );
}
/**
 * Why 「立即追加」 is not offered for content the user has typed while a
 * turn runs (null: offered, or nothing to say — idle, empty, terminal or
 * edit mode, which have their own buttons).
 */
export function steerBlockReason(s: SteerState): string | null {
  if (!s.busy || s.terminalMode || s.editing) return null;
  if (!s.hasText && !s.attachments && !s.finished) return null;
  if (canSteer(s)) return null;
  if (!steerDeclared(s))
    return t("ui-queue.steer.unsupported", { harness: harnessName(s.agent, t) });
  if (s.attachments) return t("ui-queue.steer.attachments");
  if (s.finished) return t("ui-queue.steer.finished");
  return null;
}
/** The composer's one-line hint while a turn runs (web has the shortcut). */
export function busyComposerHint(s: SteerState, web: boolean): string | null {
  if (!s.busy || s.terminalMode || s.editing) return null;
  if (!s.hasText && !s.attachments && !s.finished) return null;
  const why = steerBlockReason(s);
  const keys = web ? t("ui-queue.steer.keys") : "";
  return [why, keys].filter(Boolean).join(t("ui-queue.sep")) || null;
}
/**
 * What the queued card says after 「插队发送」 (contracts QueueJumpMode);
 * `reason`: with `interrupting`, what was stopped when it is not
 * the owner's own turn; with `next`, why it does
 * not start at once. The server's `next` reason is short — why it
 * could not merge (「来源不同，不能合并」 → 「…：前面插队的那一轮结束后发出」)
 * or 「当前这一轮正在开始」; `merged` = it went in with an earlier jump not
 * started yet.
 * Older control planes sent `next` with 「……，不打断它」 (review M1) or
 * 「前面插队的消息正在发出」, or none.
 */
export function jumpNotice(mode: string, reason?: string): string {
  // into the running turn through the agent's own input queue.
  if (mode === "appended") return t("ui-queue.jump.appended");
  if (mode === "interrupting")
    return reason
      ? t("ui-queue.jump.interruptingWhy", { reason })
      : t("ui-queue.jump.interrupting");
  if (mode === "merged") return t("ui-queue.jump.merged");
  if (mode === "next") {
    if (!reason) return t("ui-queue.jump.nextFirst");
    // The server's reason, recognised by its wording (older servers' too).
    if (/不打断它$/.test(reason)) return t("ui-queue.jump.nextNotInterrupting", { reason });
    if (/正在开始$|is starting\.?$/i.test(reason)) return t("ui-queue.jump.nextStarting", { reason });
    if (/正在发出$|being sent\.?$/i.test(reason)) return t("ui-queue.jump.nextSending", { reason });
    if (/发出$|goes out[^.]*\.?$/i.test(reason)) return reason;
    return t("ui-queue.jump.nextAfterJump", { reason });
  }
  return t("ui-queue.jump.started");
}
/**
 * What a `nextTurn` queue row says instead of 「插队 ·」 and its button.
 * `nextTurnWait` (review): the queue is paused (nothing runs after a stop /
 * failure) or the running turn is being stopped (it pauses then) — nothing
 * goes out by itself after 「这一轮」.
 */
export function nextTurnLabel(r: {
  nextTurnWhy?: string;
  nextTurnWait?: string;
}): string {
  if (r.nextTurnWait === "paused") return t("ui-queue.next.paused");
  if (r.nextTurnWait === "stopping") return t("ui-queue.next.stopping");
  // A jumped row that just waits for the turn ahead (no `nextTurnWhy`).
  if (!r.nextTurnWhy) return t("ui-queue.next.afterTurn");
  // could not merge with the jump ahead of it — the real reason
  // (hotfix: not the generic 「来源不同」 for every one).
  if (/合并|来源不同|merge|different source/i.test(r.nextTurnWhy))
    return t("ui-queue.next.nextTurn", { why: r.nextTurnWhy });
  // could not go into the running turn (Kimi, someone else's request,
  // permissions …) or was not read by it: first after this turn.
  return t("ui-queue.next.afterThisTurn", { why: r.nextTurnWhy });
}
/**
 * the status line of a queue row delivered into the running turn
 * (`appended`) — null for an ordinary queued row.
 */
export function queueRowLabel(r: {
  appended?: boolean;
  appendState?: string;
  appendLabel?: string;
}): string | null {
  if (!r.appended) return null;
  if (r.appendState === "withdrawing") return t("ui-queue.row.withdrawing");
  return r.appendLabel || t("ui-queue.row.appended");
}
/** A queue row as these rules read it (`GET …/queue`). */
export interface QueueBulkRow {
  id: string;
  appended?: boolean;
  appendState?: string;
  appendLabel?: string;
  steerable?: boolean;
  appendable?: boolean;
  /** 「合并追加」 takes it into the running turn (server's word). */
  steerIn?: boolean;
}
/**
 * 「如果它已经被处理了，为什么还能被移除或者插队」: an
 * appended row the agent has read is part of the running turn, not a queue
 * row. Current servers no longer list it; an older one says it only by its
 * label (「AI 已读取，正在本轮处理」) — dropped here too.
 */
export function queueRowRead(r: QueueBulkRow): boolean {
  return (
    !!r.appended &&
    (r.appendState === "read" ||
      (r.appendState !== "withdrawing" && /已读取|read by the AI/i.test(r.appendLabel || "")))
  );
}
/** the rows still waiting — what 「排队 N 条」 counts and lists. */
export function waitingQueue<T extends QueueBulkRow>(rows: readonly T[]): T[] {
  return rows.filter((r) => !queueRowRead(r));
}
/**
 * whether the row takes a checkbox — still waiting: in Daisy's
 * queue (合并 / 批量移除), or appended and not read yet (批量移除 = 撤回
 * only; never merged); not read, not being withdrawn already.
 */
export function queueRowSelectable(r: QueueBulkRow): boolean {
  return !queueRowRead(r) && r.appendState !== "withdrawing";
}
/**
 * the per-row remove button — 「撤回」 for a row appended into the
 * running turn and not read yet (asked back from the agent's
 * queue), 「移除」 for a queued one, none for a read one or one already
 * being withdrawn.
 */
export function queueRemoveLabel(r: QueueBulkRow): string | null {
  if (queueRowRead(r) || r.appendState === "withdrawing") return null;
  return r.appended ? t("ui-queue.row.withdraw") : t("ui-queue.row.remove");
}
/**
 * what the bulk bar offers for the ticked rows, in queue order.
 * `remove`: every ticked selectable row (批量移除 / 撤回, ≥ 1). `jump`: the
 * ticked rows still in Daisy's queue (appended ones are in the turn
 * already) — 合并插队 with ≥ 2. `steer`: 合并追加 with ≥ 2 queued rows
 * ticked, a turn running, 运行中追加 declared (P4-11), and ≥ 1 of them the server says can go
 * in (`steerIn`; older servers: `steerable` / `appendable`); `steerCount`
 * how many.
 */
export function queueBulk(
  rows: readonly QueueBulkRow[],
  picked: Record<string, boolean>,
  o: { busy: boolean; agent?: string; steer?: FeatureSupport | null },
): {
  remove: string[];
  jump: string[];
  steer: boolean;
  steerCount: number;
} {
  const ticked = rows.filter((r) => picked[r.id] && queueRowSelectable(r));
  const queued = ticked.filter((r) => !r.appended);
  // Review L6: the server's `steerIn` when it sends one (her text that
  // does not fit the running turn would only queue after it).
  const steerCount = queued.filter(
    (r) => r.steerIn ?? (r.steerable || r.appendable),
  ).length;
  return {
    remove: ticked.map((r) => r.id),
    jump: queued.map((r) => r.id),
    steer:
      o.busy && steerDeclared(o) && queued.length >= 2 && steerCount >= 1,
    steerCount,
  };
}
/** what 「批量移除」 says (contracts QueueRemoveResult). */
export function bulkRemoveNotice(r: {
  removed: number;
  withdrawing: number;
  refused: number;
  restored?: string[];
  results?: { ok: boolean; reason?: string }[];
}): string {
  const parts: string[] = [];
  if (r.removed) parts.push(t("ui-queue.bulk.removed", { n: r.removed }));
  if (r.withdrawing) parts.push(t("ui-queue.bulk.withdrawing", { n: r.withdrawing }));
  if (r.refused) {
    const why = r.results?.find((x) => !x.ok && x.reason)?.reason;
    parts.push(
      why
        ? t("ui-queue.bulk.refusedWhy", { n: r.refused, why })
        : t("ui-queue.bulk.refused", { n: r.refused }),
    );
  }
  if (r.restored?.length)
    parts.push(t("ui-queue.bulk.restored", { n: r.restored.length }));
  return parts.join(t("ui-queue.sep")) || t("ui-queue.bulk.none");
}
/** what 「合并追加」 says (contracts QueueMergeSteerResult). */
export function mergeSteerNotice(r: {
  status?: string;
  merged?: string[];
  appended?: string[];
  left?: { id: string; reason: string }[];
  reason?: string;
}): string {
  if (r.status === "pending" && r.reason) return r.reason;
  const parts: string[] = [];
  const merged = r.merged?.length ?? 0;
  if (merged > 1) parts.push(t("ui-queue.steerMerge.merged", { n: merged }));
  else if (merged === 1) parts.push(t("ui-queue.steerMerge.one"));
  if (r.appended?.length)
    parts.push(t("ui-queue.steerMerge.appended", { n: r.appended.length }));
  if (r.left?.length)
    parts.push(t("ui-queue.steerMerge.left", { n: r.left.length, why: r.left[0].reason }));
  return parts.join(t("ui-queue.sep")) || t("ui-queue.steerMerge.none");
}
/**
 * what 「合并插队」 says (contracts QueueMergeJumpResult): how many
 * went in as one, and how the first jump went.
 */
export function mergeJumpNotice(r: {
  id?: string;
  mode: string;
  reason?: string;
  into?: string;
  merged?: string[];
  jobs?: string[];
  carried?: string[];
}): string {
  const merged = r.merged?.length ?? 0;
  const jobs = r.jobs ?? [r.id ?? ""];
  // The selected rows, and the later turns (heads after the first).
  const total = merged + jobs.length;
  const later = Math.max(0, jobs.length - 1);
  const first = total - later;
  // `merged` into itself: it took an earlier jumped wake's place.
  const tookPlace = r.mode === "merged" && !!r.into && r.into === r.id;
  const how =
    r.mode === "merged"
      ? tookPlace
        ? t("ui-queue.jumpMerge.tookPlace")
        : t("ui-queue.jumpMerge.joined")
      : r.mode === "interrupting"
        ? t("ui-queue.jumpMerge.interrupting")
        : r.mode === "started"
          ? t("ui-queue.jump.started")
          : jumpNotice(r.mode, r.reason);
  const carried = r.carried?.length
    ? t("ui-queue.jumpMerge.carried", { n: r.carried.length })
    : "";
  // 「随后立即发出」 is only about the first one; the rest run
  // after its turn ends.
  const rest = later ? t("ui-queue.jumpMerge.rest", { n: later }) : "";
  if (first > 1) return t("ui-queue.jumpMerge.merged", { n: first, carried, how, rest });
  if (later) return t("ui-queue.jumpMerge.nothing", { carried, how, rest });
  return carried ? t("ui-queue.jumpMerge.single", { carried, how }) : how;
}
/**
 * which queued rows 「合并插队」 / 「合并追加」 act on, in queue
 * order; `all` = every row. 合并追加 only when every one is `steerable`.
 */
export function mergeSelection(
  rows: { id: string; steerable?: boolean; appended?: boolean }[],
  picked: Record<string, boolean>,
): { ids: string[]; steerable: boolean } {
  // appended rows are in the running turn already — never merged
  // (「全选」 used to tick them, offering 「合并插队（2）」 for read rows).
  const sel = rows.filter((r) => picked[r.id] && !r.appended);
  return {
    ids: sel.map((r) => r.id),
    steerable: sel.length > 0 && sel.every((r) => !!r.steerable),
  };
}
/**
 * Whether the device types with a keyboard (review M3): no ⌘/Ctrl+Enter
 * hint on touch screens. Web without matchMedia counts as a keyboard.
 */
export function keyboardDevice(
  w:
    | { matchMedia?: (q: string) => { matches: boolean } }
    | undefined = typeof window === "undefined" ? undefined : (window as any),
): boolean {
  if (!w?.matchMedia) return true;
  return !w.matchMedia("(pointer: coarse)").matches;
}
/** ⌘/Ctrl+Enter asks once before it stops a turn (review M3), then not. */
export const JUMP_CONFIRM_KEY = "daisy.queueJump.confirmed.v1";
type KeyStore = KeyValueStore;
const local = (): KeyStore | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};
export function jumpConfirmed(store: KeyStore | undefined = local()): boolean {
  try {
    return readMigrated(store, JUMP_CONFIRM_KEY) === "1";
  } catch {
    return false;
  }
}
export function rememberJumpConfirmed(store: KeyStore | undefined = local()) {
  try {
    store?.setItem(JUMP_CONFIRM_KEY, "1");
  } catch {
    /* private mode: ask again next time */
  }
}
