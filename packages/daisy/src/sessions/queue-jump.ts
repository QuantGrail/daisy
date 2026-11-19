/**
 * 「插队发送」 bookkeeping: which
 * queued messages jumped, in order, and which running turn was stopped for
 * them. `jobs.created` is never rewritten.
 *
 * New tables (CREATE IF NOT EXISTS, no `user_version` change):
 * an older release ignores `queue_jump_order` and reads the latest jump
 * from `queue_jumps`; its settle sees `cancel=2` as a plain stop and pauses
 * the queue (the jumped message waits for 「继续」).
 */
import type { Store } from "../store/index.ts";
import { ownerT } from "../platform/language.ts";

/** Remember a jump; a message that jumps again keeps its place in line. */
export function recordJump(
  store: Store,
  sid: string,
  jid: string,
  stopped: string | null,
  why: string | null = null,
) {
  const now = Date.now();
  store.run(
    "INSERT INTO queue_jumps(session_id,job_id,stopped_job,created) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET job_id=excluded.job_id,stopped_job=excluded.stopped_job,created=excluded.created",
    sid,
    jid,
    stopped,
    now,
  );
  // Order within a millisecond: after every earlier jump of the session.
  const last =
    store.one(
      "SELECT MAX(created) n FROM queue_jump_order WHERE session_id=?",
      sid,
    )?.n ?? 0;
  store.run(
    "INSERT INTO queue_jump_order(job_id,session_id,stopped_job,created,why) VALUES(?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET stopped_job=excluded.stopped_job,why=excluded.why",
    jid,
    sid,
    stopped,
    Math.max(now, last + 1),
    why,
  );
}
/**
 * The session's jumped messages still queued, in jump order (a row left
 * by an older release last).
 */
export function jumpedList(store: Store, sid: string): string[] {
  const ids = store
    .all(
      "SELECT q.job_id id FROM queue_jump_order q JOIN jobs j ON j.id=q.job_id AND j.status='pending' WHERE q.session_id=? ORDER BY q.created",
      sid,
    )
    .map((r: any) => r.id as string);
  const legacy = store.one(
    "SELECT q.job_id id FROM queue_jumps q JOIN jobs j ON j.id=q.job_id AND j.status='pending' WHERE q.session_id=?",
    sid,
  )?.id;
  if (legacy && !ids.includes(legacy)) ids.push(legacy);
  return ids;
}
/** The session's first jumped message while it is still queued (else none). */
export function jumpedPending(store: Store, sid: string): string | null {
  return jumpedList(store, sid)[0] ?? null;
}
/** The message to run next: the first jumped one, else the oldest. */
export function nextPending(store: Store, sid: string): string | null {
  return (
    jumpedPending(store, sid) ??
    store.one(
      "SELECT id FROM jobs WHERE session_id=? AND status='pending' ORDER BY created,rowid LIMIT 1",
      sid,
    )?.id ??
    null
  );
}
/**
 * A turn stopped for a jump ended: the first message that jumped while
 * this very turn was stopped for it, if one is still queued; null = pause
 * as a stop.
 */
export function takeJump(
  store: Store,
  job: { id: string; session_id: string },
) {
  const r =
    store.one(
      "SELECT q.job_id id FROM queue_jump_order q JOIN jobs j ON j.id=q.job_id AND j.status='pending' WHERE q.session_id=? AND q.stopped_job=? ORDER BY q.created LIMIT 1",
      job.session_id,
      job.id,
    ) ??
    store.one(
      "SELECT q.job_id id FROM queue_jumps q JOIN jobs j ON j.id=q.job_id AND j.status='pending' WHERE q.session_id=? AND q.stopped_job=?",
      job.session_id,
      job.id,
    );
  return r?.id ?? null;
}
/** why jump `jid` could not merge with the one ahead (null: none). */
export function jumpWhy(store: Store, jid: string): string | null {
  return (
    store.one("SELECT why FROM queue_jump_order WHERE job_id=?", jid)?.why ??
    null
  );
}
/** jumped message `jid` was promoted (it is the queued one now). */
export function markJumpStarted(store: Store, sid: string, jid: string) {
  store.run(
    "INSERT OR REPLACE INTO queue_jump_started(job_id,session_id,created) VALUES(?,?,?)",
    jid,
    sid,
    Date.now(),
  );
}
/** whether queued job `jid` is there because it jumped. */
export function jumpStarted(store: Store, jid: string): boolean {
  return !!store.one("SELECT 1 FROM queue_jump_started WHERE job_id=?", jid);
}
/** the job ended — no longer a jump waiting to start. */
export function forgetJumpStarted(store: Store, jid: string) {
  store.run("DELETE FROM queue_jump_started WHERE job_id=?", jid);
}
/** A deleted conversation's jump bookkeeping (purgeIfDeleted). */
export function purgeJumps(store: Store, sid: string) {
  store.run("DELETE FROM queue_jumps WHERE session_id=?", sid);
  store.run("DELETE FROM queue_jump_order WHERE session_id=?", sid);
  store.run("DELETE FROM queue_jump_started WHERE session_id=?", sid);
}
/** Promoted (or gone): forget the jump (all of the session's without `jid`). */
export function forgetJump(store: Store, sid: string, jid?: string) {
  if (jid) {
    store.run(
      "DELETE FROM queue_jumps WHERE session_id=? AND job_id=?",
      sid,
      jid,
    );
    store.run(
      "DELETE FROM queue_jump_order WHERE session_id=? AND job_id=?",
      sid,
      jid,
    );
  } else {
    store.run("DELETE FROM queue_jumps WHERE session_id=?", sid);
    store.run("DELETE FROM queue_jump_order WHERE session_id=?", sid);
  }
}
/**
 * Whose turn is running, when it is not the owner's own typed message
 * (review M1, R2 N-M2) — a phrase for the 插队 notice; null = the owner's.
 * Since 2026-11-05 (「想插就插」) any turn may be stopped for a
 * jump now; this only says what is being stopped.
 *
 * Not the owner's: a group request (`chat:`), a scheduled / callback wake
 * (origin schedule), the AI's own turn (origin agent), an event wake
 * (origin collab: approval decided / expired, peer failure, legacy archive),
 * the task 「快速了解」 prompt (`understanding:`), and any turn whose
 * `user:` item carries an `origin` (rows from before origin 'collab') or
 * that has no `user:` item at all.
 */
export function notOwnersTurn(store: Store, active: any): string | null {
  const rid = String(active.request_id || "");
  const t = ownerT();
  if (rid.startsWith("chat:")) return t("server-sessions.jump.notOwner.chat");
  if (active.origin === "schedule") return t("server-sessions.jump.notOwner.schedule");
  if (active.origin === "agent") return t("server-sessions.jump.notOwner.agent");
  if (active.origin === "collab") return t("server-sessions.jump.notOwner.collab");
  if (rid.startsWith("understanding:")) return t("server-sessions.jump.notOwner.understanding");
  const item = store.one(
    "SELECT data FROM items WHERE session_id=? AND id=?",
    active.session_id,
    `user:${active.id}`,
  );
  if (!item) return t("server-sessions.jump.notOwner.notYours");
  let data: any = {};
  try {
    data = JSON.parse(item.data || "{}");
  } catch {}
  if (data.origin) return t("server-sessions.jump.notOwner.collab");
  return null;
}
/**
 * A job started by someone or something other than its
 * owner — a group request (`chat:`), the task 「快速了解」 (`understanding:`),
 * a scheduled / AI-started / event wake (origin schedule / agent / collab),
 * or an older event wake whose `user:` item carries an `origin`. Ending
 * badly, it does not pause the owner's queue. The owner's own messages and
 * native operations (rewind, /compact …: `job_operations`) are not: their
 * failure still pauses it.
 */
export function othersJob(store: Store, job: any): boolean {
  if (store.one("SELECT 1 FROM job_operations WHERE job_id=?", job.id))
    return false;
  const rid = String(job.request_id || "");
  if (rid.startsWith("chat:") || rid.startsWith("understanding:")) return true;
  if (["schedule", "agent", "collab"].includes(job.origin)) return true;
  const item = store.one(
    "SELECT data FROM items WHERE session_id=? AND id=?",
    job.session_id,
    `user:${job.id}`,
  );
  try {
    return !!JSON.parse(item?.data || "{}").origin;
  } catch {
    return false;
  }
}
/**
 * The job to start next in fair order — the first jumped one, else the
 * oldest — skipping ones already canceled (review 4: the collaboration pump).
 */
export function nextLive(store: Store, sid: string): string | null {
  for (const jid of jumpedList(store, sid))
    if (store.one("SELECT 1 FROM jobs WHERE id=? AND cancel=0", jid))
      return jid;
  return (
    store.one(
      "SELECT id FROM jobs WHERE session_id=? AND status='pending' AND cancel=0 ORDER BY created,rowid LIMIT 1",
      sid,
    )?.id ?? null
  );
}
/**
 * Why 「插队发送」 cannot start now (null: it can) — shown on the queued
 * card instead of a button that would fail. Only a native
 * operation (回退、/compact …) cannot be stopped for it.
 */
export function jumpBlocked(store: Store, sid: string): string | null {
  return store.one(
    "SELECT 1 FROM jobs j JOIN job_operations o ON o.job_id=j.id WHERE j.session_id=? AND j.status IN ('queued','running')",
    sid,
  )
    ? ownerT()("server-sessions.jump.nativeOperation")
    : null;
}
/**
 * How many foreground subagents 「插队发送」
 * would take down if it stopped the running turn now — the running turn's
 * Agent / Task tool calls still in flight (Claude: the root tool item;
 * a backgrounded one returns at once and is not counted) and Codex's
 * subagent threads (`child:<thread>`, from spawnAgent or subAgentActivity —
 * 「停止」 interrupts them). Background commands / Monitor keep
 * running through an interrupt and are not counted. 0 when no turn runs.
 */
export function runningSubagents(store: Store, sid: string): number {
  const active = store.one(
    "SELECT id FROM jobs WHERE session_id=? AND status='running'",
    sid,
  );
  if (!active) return 0;
  let n = 0;
  for (const r of store.all(
    "SELECT id,data FROM items WHERE session_id=? AND substr(id,1,?)=?",
    sid,
    active.id.length + 1,
    `${active.id}:`,
  )) {
    let d: any = {};
    try {
      d = JSON.parse(r.data);
    } catch {
      continue;
    }
    if (d.kind !== "tool") continue;
    if (!["running", "pending", "streaming"].includes(d.status)) continue;
    const rest = String(r.id).slice(active.id.length + 1);
    const claude =
      !d.category &&
      ["Agent", "Task"].includes(d.name) &&
      d.input?.run_in_background !== true;
    const codex = d.category === "subagent" && rest.startsWith("child:");
    if (claude || codex) n++;
  }
  return n;
}
