/**
 * 「合并插队」 (2026-11-07) — queued messages that jump
 * while an earlier jump has not started yet go in with it as one message,
 * one interruption, instead of waiting for that whole turn.
 *
 * Only jobs of the same provenance merge (`mergeKind`): the owner's own
 * messages with each other, a plugin callback wake with another of the same
 * budget class, an event wake (origin `collab`) with another of the same
 * authority … — never a wake with the owner's words, never a group request
 * (`chat:` — its delivery, capability token and asker are per job), the task
 * 「快速了解」, a native operation or a turn the AI started itself. So the
 * surviving job's `request_id` / `origin` (which decide bypass, the daily
 * budget and how the transcript shows it) are true for every part.
 *
 * The merged-away job keeps its row (`request_id` stays taken, so a wake is
 * never delivered twice) as `interrupted`, linked in `queue_merges`; what was
 * filed against it (a plugin's rows, hook 2's `jobs`) now points at the survivor.
 * New table (CREATE IF NOT EXISTS, no `user_version` change): an
 * older release sees an interrupted job and a longer queued one.
 */
import type { Store } from "../store/index.ts";
import { clean, flat } from "../prompts/source-prompt.ts";
import { ownerTurn } from "../approvals/bypass-policy.ts";
import { pluginJobs } from "../plugins/server.ts";
import { callbackJob } from "../schedule/callback-jobs.ts";
import { ownerT, inSessionT } from "../platform/language.ts";
import type { Translate } from "../../../contracts/src/i18n.ts";
import {
  forgetJump,
  forgetJumpStarted,
  jumpedList,
  jumpStarted,
  markJumpStarted,
} from "./queue-jump.ts";

/** Between merged parts: Daisy's words, and the parts' source is the same (in the session's language). */
export const mergeSeparator = (t: Translate = ownerT()): string => t("server-sessions.merge.separator");
/** The session's language (P6-24's `language` field once it is there), else the owner's. */
const tOf = (store: Store, sid: string): Translate => inSessionT(store.session(sid));
/** As the scheduler's own coalescing (scheduler.ts COALESCE_MAX): never clipped later. */
const TEXT_MAX = 60_000,
  FILES_MAX = 8,
  RUNS_MAX = 8,
  WAKE_MAX = 500;

/** A deleted conversation's merge links (purgeIfDeleted). */
export function purgeMerges(store: Store, sid: string) {
  store.run("DELETE FROM queue_merges WHERE session_id=?", sid);
}
const userItem = (store: Store, sid: string, jid: string) => {
  const r = store.one(
    "SELECT data FROM items WHERE session_id=? AND id=?",
    sid,
    `user:${jid}`,
  );
  try {
    return r ? JSON.parse(r.data || "{}") : null;
  } catch {
    return {};
  }
};
/**
 * The provenance class a job merges within (null: never merged). Same
 * class = same `ownerTurn` (bypass), same budget rule, same origin.
 */
export function mergeKind(store: Store, job: any): string | null {
  if (store.one("SELECT 1 FROM job_operations WHERE job_id=?", job.id))
    return null;
  const rid = String(job.request_id || "");
  if (/^(chat|understanding|op):/.test(rid)) return null;
  if (job.origin === "agent") return null;
  if (job.origin === "schedule") {
    // a callback wake job: the generic frame (ADR-157).
    const cb = callbackJob(rid);
    if (cb) return cb.human ? "schedule:callback-human" : "schedule:callback";
    // the sweep's own delivery of kept callbacks has its own rules.
    if (rid.startsWith("schedule:kept-callbacks:")) return null;
    return ownerTurn(job) ? "schedule:own" : "schedule:other";
  }
  if (job.origin === "collab")
    return ownerTurn(job) ? "collab:own" : "collab:other";
  if (job.origin) return null;
  // An older event wake marked on its item only (before origin 'collab').
  const item = userItem(store, job.session_id, job.id);
  if (item?.origin) return null;
  // a steer turned into this job may still be withdrawn when the
  // Agent reports it took it after all (withdrawRequeued) — never merged.
  if (rid.startsWith("steer:")) return null;
  return ownerTurn(job) ? "owner" : null;
}
const parse = (s: any) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};
const slash = (t: string) =>
  String(t || "")
    .trimStart()
    .startsWith("/");
/**
 * Why `from` cannot go in with `into` (null: it can) — said on the card as
 * the reason it waits for that turn instead.
 */
export function mergeBlocker(
  store: Store,
  into: any,
  from: any,
): string | null {
  const a = mergeKind(store, into),
    b = mergeKind(store, from);
  const t = ownerT();
  if (!a || !b) return t("server-sessions.merge.block.kind");
  if (a !== b) return t("server-sessions.merge.block.source");
  if (slash(into.text) || slash(from.text)) return t("server-sessions.merge.block.slash");
  if (into.context && from.context && into.context !== from.context)
    return t("server-sessions.merge.block.context");
  if (
    // Review: carriers' preambles (carried blocks) count too.
    String(into.text || "").length +
      String(from.text || "").length +
      String(into.preamble || "").length +
      String(from.preamble || "").length +
      mergeSeparator(tOf(store, into.session_id)).length >
    TEXT_MAX
  )
    return t("server-sessions.merge.block.tooLong");
  const files = [
    ...(parse(into.attachments) || []),
    ...(parse(from.attachments) || []),
  ];
  if (new Set(files).size > FILES_MAX) return t("server-sessions.merge.block.files", { n: FILES_MAX });
  const runs =
    (parse(into.terminal) || []).length + (parse(from.terminal) || []).length;
  if (runs > RUNS_MAX) return t("server-sessions.merge.block.runs", { n: RUNS_MAX });
  return null;
}
/**
 * Inside a transaction: fold pending job `fromId` into job `intoId` (still
 * pending or queued and not claimed). Call `mergeBlocker` first.
 */
export function mergeInto(
  store: Store,
  intoId: string,
  fromId: string,
  publish: (sid: string, type: any, data: any) => any,
) {
  const into = store.one("SELECT * FROM jobs WHERE id=?", intoId),
    from = store.one("SELECT * FROM jobs WHERE id=?", fromId);
  const sid = into.session_id;
  const text = [into.text, from.text].filter(Boolean).join(mergeSeparator(tOf(store, sid)));
  const files = [
    ...new Set([
      ...(parse(into.attachments) || []),
      ...(parse(from.attachments) || []),
    ]),
  ];
  const runs = [
    ...(parse(into.terminal) || []),
    ...(parse(from.terminal) || []),
  ];
  const preamble =
    [into.preamble, from.preamble].filter(Boolean).join("\n\n") || null;
  const wake =
    into.wake || from.wake
      ? [...new Set([into.wake, from.wake].filter(Boolean))]
          .join(tOf(store, sid)("server-sessions.merge.wakeSeparator"))
          .slice(0, WAKE_MAX)
      : null;
  store.run(
    "UPDATE jobs SET text=?,attachments=?,terminal=?,context=?,preamble=?,wake=? WHERE id=?",
    text,
    JSON.stringify(files),
    runs.length ? JSON.stringify(runs) : null,
    into.context ?? from.context ?? null,
    preamble,
    wake,
    intoId,
  );
  store.run("UPDATE jobs SET status='interrupted' WHERE id=?", fromId);
  store.run(
    "INSERT OR REPLACE INTO queue_merges(job_id,session_id,into_job,into_input,created) VALUES(?,?,?,NULL,?)",
    fromId,
    sid,
    intoId,
    Date.now(),
  );
  // What was merged into `from` before now belongs to the survivor too.
  store.run(
    "UPDATE queue_merges SET into_job=? WHERE into_job=?",
    intoId,
    fromId,
  );
  forgetJump(store, sid, fromId);
  repoint(store, fromId, intoId);
  bubbles(store, sid, from, { status: "merged", mergedInto: intoId }, publish);
  const mine = userItem(store, sid, intoId);
  if (mine)
    publish(sid, "item", {
      ...mine,
      id: `user:${intoId}`,
      mergedFrom: [...new Set([...(mine.mergedFrom || []), fromId])],
    });
}
/**
 * Per-job bookkeeping filed against `from` follows the survivor: what a
 * plugin filed against a wake job (hook 2's `jobs`: callback entries;
 * a pending job carries nothing else — native approvals, live
 * inputs, capabilities are made once it runs). P4-13: no plugin enabled —
 * nothing to repoint.
 */
function repoint(store: Store, from: string, into: string) {
  pluginJobs(store).move(from, into);
}
/** The merged-away job's own items: its bubble, or a wake's notice. */
function bubbles(
  store: Store,
  sid: string,
  job: any,
  patch: Record<string, unknown>,
  publish: (sid: string, type: any, data: any) => any,
) {
  const item = userItem(store, sid, job.id);
  if (item)
    publish(sid, "item", {
      ...item,
      id: `user:${job.id}`,
      kind: "user",
      ...patch,
    });
  const w = store.one(
    "SELECT data FROM items WHERE session_id=? AND id=?",
    sid,
    `wake:${job.id}`,
  );
  if (w) {
    const d = parse(w.data) || {};
    // The tail this module wrote (`tail`, `tailKind: "merge"`) is cut off
    // as written, in any language; an older item's by its Chinese pattern.
    const base = withoutMergeTail(d);
    const tail = tOf(store, sid)(
      patch.kept
        ? "server-sessions.merge.tail.kept"
        : patch.status === "cancelled"
          ? "server-sessions.merge.tail.canceled"
          : "server-sessions.merge.tail.merged",
    );
    if (d.text !== base + tail)
      publish(sid, "item", { ...d, id: `wake:${job.id}`, text: base + tail, tail, tailKind: "merge" });
  }
}
/**
 * A wake item's text without the merge tail this module wrote: the tail
 * it names (`tail`, `tailKind: "merge"`), cut as written in any language;
 * an older item's by its Chinese pattern.
 */
function withoutMergeTail(d: { text?: unknown; tail?: unknown; tailKind?: unknown }): string {
  const text = String(d.text || "");
  return d.tailKind === "merge" && typeof d.tail === "string" && d.tail && text.endsWith(d.tail)
    ? text.slice(0, -d.tail.length)
    : text.replace(/（已(合并|与插队|保留)[^）]*）$/, "");
}
/** Jobs merged into `jid` (oldest first). */
export function mergedParts(store: Store, jid: string): string[] {
  return store
    .all(
      "SELECT job_id id FROM queue_merges WHERE into_job=? ORDER BY created,rowid",
      jid,
    )
    .map((r: any) => r.id);
}
/**
 * The survivor was removed / stopped: its merged parts' bubbles too (and
 * theirs). A callback part whose entries the stop kept for the next turn
 * (`kept` / `held` on what a plugin filed against the survivor) says
 * so instead of 「取消」.
 */
export function removedWithParts(
  store: Store,
  jid: string,
  publish: (sid: string, type: any, data: any) => any,
  seen = new Set<string>(),
  root = jid,
) {
  const kept = () => pluginJobs(store).kept(root);
  for (const p of mergedParts(store, jid)) {
    if (seen.has(p)) continue;
    seen.add(p);
    const j = store.one("SELECT * FROM jobs WHERE id=?", p);
    if (j)
      bubbles(
        store,
        j.session_id,
        j,
        {
          status: "cancelled",
          ...(callbackJob(j.request_id) && kept()
            ? { kept: true }
            : {}),
        },
        publish,
      );
    removedWithParts(store, p, publish, seen, root);
  }
}
// ---------------------------------------------------------- mixed selections
/**
 * Daisy wakes that may ride the owner's own message as labelled context
 * (2026-11-08, from a user report): plugin callbacks (budget and a
 * person's decision), the owner's own approval / interception decisions
 * (collab:own) and its own timers / background reports (schedule:own) —
 * what kept reports and kept callbacks already carry in a turn's preamble. Group
 * requests, 快速了解, operations, AI turns and requeued steers never.
 */
/**
 * Who may carry whom (2026-11-08, second report: two wakes, neither
 * her typed message): a job with the owner's authority carries the wakes
 * ranked below it — her typed message (3) > her own approval / interception
 * decision `collab:own` (2) > her own timer / background wake
 * `schedule:own` (1) > plugin callbacks (0, machine results: carried,
 * never carriers). A non-owner wake never carries an owner-authority one.
 */
const RANK: Record<string, number> = {
  owner: 3,
  "collab:own": 2,
  "schedule:own": 1,
  "schedule:callback": 0,
  "schedule:callback-human": 0,
};
/** Whether a job of kind `k` can carry others (owner authority). */
export function carrierRank(k: string | null): number {
  return k && k in RANK && RANK[k] >= 1 ? RANK[k] : -1;
}
/** The labelled block a carried wake becomes in the owner's preamble. */
export function carryBlock(
  store: Store,
  wake: any,
  /** appended into the owner's running turn (not carried). */
  how: "carry" | "append" = "carry",
): string {
  const k = mergeKind(store, wake);
  const t = tOf(store, wake.session_id);
  const how1 = t(how === "append" ? "server-sessions.carry.howAppend" : "server-sessions.carry.howCarry");
  const retry = String(wake.request_id || "").startsWith("classifier-retry:");
  const head = t(
    retry
      ? "server-sessions.carry.head.retry"
      : k === "collab:own"
        ? "server-sessions.carry.head.approval"
        : k === "schedule:own"
          ? "server-sessions.carry.head.schedule"
          : "server-sessions.carry.head.callback",
    { how: how1 },
  );
  // Review: the label on one line, the body fenced — neither a timer's
  // label nor background output can forge a header or break out.
  const label = wake.wake ? t("server-sessions.carry.source", { source: flat(wake.wake, 200) }) + "\n" : "";
  return `${head}\n${label}<external_message>\n${clean(String(wake.text || ""))}\n</external_message>`;
}
/**
 * How `b` (jumping now / next in a selection) goes in with `a` (the earlier
 * jump / the group so far): the same kind → merged text into `a`; the
 * owner's own message and a carriable wake → the owner's message survives
 * and carries the wake; else why not.
 */
export function mergePlan(
  store: Store,
  a: any,
  b: any,
):
  | { how: "merge"; into: any; from: any }
  | { how: "carry"; owner: any; wake: any }
  | { why: string } {
  const why = mergeBlocker(store, a, b);
  if (!why) return { how: "merge", into: a, from: b };
  const ka = mergeKind(store, a),
    kb = mergeKind(store, b);
  const ra = carrierRank(ka),
    rb = carrierRank(kb);
  // The higher-ranked one with the owner's authority carries the other.
  const owner = ra >= 1 && ra >= rb ? a : rb >= 1 ? b : null,
    wake = owner === a ? b : a;
  const kw = owner ? mergeKind(store, wake) : null;
  if (
    !owner ||
    !kw ||
    !(kw in RANK) ||
    RANK[kw] >= RANK[mergeKind(store, owner)!]
  )
    return { why };
  // A slash command takes no preamble (claimReports): the wake would be lost.
  if (slash(owner.text)) return { why: ownerT()("server-sessions.merge.block.slash") };
  if (
    String(owner.preamble || "").length +
      String(wake.preamble || "").length +
      carryBlock(store, wake).length +
      String(owner.text || "").length >
    TEXT_MAX
  )
    return { why: ownerT()("server-sessions.merge.block.tooLong") };
  return { how: "carry", owner, wake };
}
/** Apply a plan; returns the surviving job id. */
export function applyPlan(
  store: Store,
  plan:
    | { how: "merge"; into: any; from: any }
    | { how: "carry"; owner: any; wake: any },
  publish: (sid: string, type: any, data: any) => any,
): string {
  if (plan.how === "merge") {
    mergeInto(store, plan.into.id, plan.from.id, publish);
    return plan.into.id;
  }
  carryInto(store, plan.owner.id, plan.wake.id, publish);
  return plan.owner.id;
}
/**
 * Inside a transaction: wake `wakeId` rides owner's message `ownerId` as a
 * labelled preamble block (after the group digest, in the order carried).
 * The owner's message takes the wake's place: its jump position (the
 * earlier of the two) and, when the wake was the promoted jump not claimed
 * yet, its `queued` status. Bookkeeping as mergeInto (`how = 'carry'`).
 */
export function carryInto(
  store: Store,
  ownerId: string,
  wakeId: string,
  publish: (sid: string, type: any, data: any) => any,
) {
  const owner = store.one("SELECT * FROM jobs WHERE id=?", ownerId),
    wake = store.one("SELECT * FROM jobs WHERE id=?", wakeId);
  const sid = owner.session_id;
  jumpedList(store, sid); // the jump tables exist
  // Review: the wake's own jump identity, restored if she removes hers.
  const wakeJump =
    store.one(
      "SELECT stopped_job,created,why FROM queue_jump_order WHERE job_id=?",
      wakeId,
    ) ?? null;
  const wakeLegacy = store.one(
    "SELECT stopped_job,created FROM queue_jumps WHERE session_id=? AND job_id=?",
    sid,
    wakeId,
  );
  // Review (blocker): a wake that itself carries parts (her decision or a
  // timer carrying callbacks) is flattened — its carried blocks (its whole
  // preamble) come first, then its own block, all in the new carrier; its
  // carried parts now belong to the new carrier (`nested`, so removing the
  // new carrier gives them back to it).
  const nested = store
    .all(
      "SELECT job_id FROM queue_merges WHERE into_job=? AND how='carry' ORDER BY created,rowid",
      wakeId,
    )
    .map((r: any) => r.job_id as string);
  const preamble = [owner.preamble, wake.preamble, carryBlock(store, wake)]
    .filter(Boolean)
    .join("\n\n");
  store.run("UPDATE jobs SET preamble=? WHERE id=?", preamble, ownerId);
  if (nested.length)
    store.run(
      "UPDATE queue_merges SET into_job=? WHERE into_job=? AND how='carry'",
      ownerId,
      wakeId,
    );
  // The place in line: the earlier of the two jump positions.
  const rows = store.all(
    "SELECT * FROM queue_jump_order WHERE job_id IN (?,?) ORDER BY created",
    ownerId,
    wakeId,
  );
  if (rows.length && owner.status === "pending" && wake.status === "pending") {
    store.run(
      "DELETE FROM queue_jump_order WHERE job_id IN (?,?)",
      ownerId,
      wakeId,
    );
    store.run(
      "INSERT INTO queue_jump_order(job_id,session_id,stopped_job,created,why) VALUES(?,?,?,?,?)",
      ownerId,
      sid,
      rows[0].stopped_job,
      rows[0].created,
      rows[0].why ?? null,
    );
    store.run(
      "UPDATE queue_jumps SET job_id=? WHERE job_id=?",
      ownerId,
      wakeId,
    );
  }
  const moved = pluginJobs(store).keys(wakeId);
  store.run("UPDATE jobs SET status='interrupted' WHERE id=?", wakeId);
  // After the wake left the active slot (one queued / running job per session).
  if (wake.status === "queued" && !wake.lease) {
    // The wake was the promoted jump (not claimed): the owner's message
    // starts in its place.
    forgetJump(store, sid, ownerId);
    store.run("UPDATE jobs SET status='queued' WHERE id=?", ownerId);
    if (jumpStarted(store, wakeId)) markJumpStarted(store, sid, ownerId);
    forgetJumpStarted(store, wakeId);
  }
  store.run(
    "INSERT OR REPLACE INTO queue_merges(job_id,session_id,into_job,into_input,created,how,moved) VALUES(?,?,?,NULL,?,'carry',?)",
    wakeId,
    sid,
    ownerId,
    Date.now(),
    JSON.stringify({
      keys: moved,
      ...(nested.length ? { nested } : {}),
      ...(wakeJump ? { jump: { ...wakeJump } } : {}),
      ...(wakeLegacy ? { legacy: { ...wakeLegacy } } : {}),
    }),
  );
  forgetJump(store, sid, wakeId);
  repoint(store, wakeId, ownerId);
  bubbles(store, sid, wake, { status: "merged", mergedInto: ownerId }, publish);
  const mine = userItem(store, sid, ownerId);
  if (mine)
    publish(sid, "item", {
      ...mine,
      id: `user:${ownerId}`,
      mergedFrom: [...new Set([...(mine.mergedFrom || []), ...nested, wakeId])],
    });
}
/** Wakes carried by owner's message `jid` (oldest first), as job rows. */
export function carriedParts(store: Store, jid: string): any[] {
  return store.all(
    "SELECT j.* FROM queue_merges q JOIN jobs j ON j.id=q.job_id WHERE q.into_job=? AND q.how='carry' ORDER BY q.created,q.rowid",
    jid,
  );
}
/**
 * The owner removed her message before it ran: the wakes it carried go
 * back to the queue as they were (their callbacks' `job_id` too) — her
 * 「移除」 is not a stop of Daisy's events.
 */
export function restoreCarried(
  store: Store,
  jid: string,
  publish: (sid: string, type: any, data: any) => any,
) {
  const rows = store.all(
    "SELECT * FROM queue_merges WHERE into_job=? AND how='carry'",
    jid,
  );
  // Flattened parts go back to the carrier they came with, not the queue.
  const inner = new Set<string>(
    rows.flatMap((r: any) => parse(r.moved)?.nested || []),
  );
  for (const r of rows) {
    if (inner.has(r.job_id)) continue;
    const w = store.one("SELECT * FROM jobs WHERE id=?", r.job_id);
    store.run("DELETE FROM queue_merges WHERE job_id=?", r.job_id);
    if (!w) continue;
    store.run("UPDATE jobs SET status='pending' WHERE id=?", w.id);
    const m = parse(r.moved);
    for (const p of m?.nested || [])
      store.run(
        "UPDATE queue_merges SET into_job=? WHERE job_id=? AND into_job=?",
        w.id,
        p,
        jid,
      );
    const keys: string[] = Array.isArray(m) ? m : m?.keys || [];
    // Its place in line as a jump (review: else an owner's turn stopped for
    // it would pause the queue instead of promoting it).
    if (m?.jump)
      store.run(
        "INSERT OR IGNORE INTO queue_jump_order(job_id,session_id,stopped_job,created,why) VALUES(?,?,?,?,?)",
        w.id,
        w.session_id,
        m.jump.stopped_job ?? null,
        m.jump.created,
        m.jump.why ?? null,
      );
    if (m?.legacy)
      store.run(
        "INSERT INTO queue_jumps(session_id,job_id,stopped_job,created) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET job_id=excluded.job_id,stopped_job=excluded.stopped_job,created=excluded.created",
        w.session_id,
        w.id,
        m.legacy.stopped_job ?? null,
        m.legacy.created,
      );
    if (keys.length) pluginJobs(store).move(jid, w.id, keys);
    const item = userItem(store, w.session_id, w.id);
    if (item)
      publish(w.session_id, "item", {
        ...item,
        id: `user:${w.id}`,
        kind: "user",
        status: "queued",
        mergedInto: undefined,
      });
    const n = store.one(
      "SELECT data FROM items WHERE session_id=? AND id=?",
      w.session_id,
      `wake:${w.id}`,
    );
    if (n) {
      const d = parse(n.data) || {};
      // The merge tail goes (in any language), and with it its record.
      const { tail: _tail, tailKind: _kind, ...rest } = d;
      publish(w.session_id, "item", {
        ...(d.tailKind === "merge" ? rest : d),
        id: `wake:${w.id}`,
        text: withoutMergeTail(d),
      });
    }
  }
}
/**
 * Whether pending job `job` is the owner's own text only — what 「合并追加」
 * (steer) can take: no attachments, terminal runs, group digest or command.
 */
export function steerable(store: Store, job: any): boolean {
  const k = mergeKind(store, job);
  return (
    (k === "owner" || k === "owner:steer") &&
    !!String(job.text || "").trim() &&
    !slash(job.text) &&
    !(parse(job.attachments) || []).length &&
    !(parse(job.terminal) || []).length &&
    !job.preamble
  );
}
/** Inside a transaction: pending `fromId` went into live input `mid`. */
export function mergedIntoInput(
  store: Store,
  fromId: string,
  mid: string,
  publish: (sid: string, type: any, data: any) => any,
) {
  const from = store.one("SELECT * FROM jobs WHERE id=?", fromId);
  store.run("UPDATE jobs SET status='interrupted' WHERE id=?", fromId);
  store.run(
    "INSERT OR REPLACE INTO queue_merges(job_id,session_id,into_job,into_input,created) VALUES(?,?,NULL,?,?)",
    fromId,
    from.session_id,
    mid,
    Date.now(),
  );
  forgetJump(store, from.session_id, fromId);
  bubbles(
    store,
    from.session_id,
    from,
    { status: "merged", mergedInto: `input:${mid}` },
    publish,
  );
}
