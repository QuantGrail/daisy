/**
 * A 立即追加 (steer) that the
 * running turn did not take — never acknowledged by the Agent, or taken
 * and then cancelled — is never silently lost: it becomes the next turn
 * (an ordinary queued message) with a visible note.
 *
 * The new job keeps the steer's text, page context and creation time (so
 * it is in line where it was sent, ahead of messages queued after it).
 * Idempotent per live input (`request_id = steer:<input id>`).
 */
import { id, type Store } from "../store/index.ts";
import { restoreAppended, sourceOf } from "./native-append.ts";
import { forgetJump } from "./queue-jump.ts";
import { traceForNewTurn } from "../observe/trace.ts";
import { inSessionT } from "../platform/language.ts";

/** The session's language (P6-24's `language` field once it is there), else the owner's. */
const tOf = (store: Store, sid: string) => inSessionT(store.session(sid));

/**
 * Inside a transaction: turn live input `input` (a `live_inputs` row) of
 * session `sid` into a pending job; its items go out through `emit` (the
 * caller appends and broadcasts). Returns the new job id (null when it was
 * requeued before).
 */
export function requeueLiveInput(
  store: Store,
  sid: string,
  input: any,
  reason: string,
  emit: (sid: string, type: "item", data: any) => unknown,
): string | null {
  // an appended Daisy job goes back as itself, first in line.
  if (input.source_job) {
    restoreAppended(store, sid, input, reason, emit);
    return null;
  }
  const requestId = `steer:${input.id}`;
  const old = store.one(
    "SELECT id FROM jobs WHERE session_id=? AND request_id=?",
    sid,
    requestId,
  );
  if (old) return null;
  const s = store.session(sid);
  const jid = id();
  const context = input.context ? JSON.parse(input.context) : undefined;
  store.run(
    "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,context,trace) VALUES(?,?,?,?,?,?,?,?,?,?)",
    jid,
    sid,
    s?.nodeId ?? "",
    requestId,
    input.text,
    "[]",
    "pending",
    input.created,
    input.context ?? null,
    traceForNewTurn(),
  );
  store.run(
    "UPDATE live_inputs SET status='requeued',result=? WHERE id=?",
    JSON.stringify({ requeued: jid, reason: reason.slice(0, 500) }),
    input.id,
  );
  // The steer's own bubble says where it went; the queued one is the turn.
  emit(sid, "item", {
    id: `input:${input.id}`,
    kind: "user",
    text: input.text,
    status: "requeued",
    requeuedAs: jid,
    ...(context ? { context } : {}),
    createdAt: input.created,
  });
  emit(sid, "item", {
    id: `user:${jid}`,
    kind: "user",
    text: input.text,
    status: "queued",
    attachments: [],
    ...(context ? { context } : {}),
    createdAt: Date.now(),
  });
  emit(sid, "item", {
    id: `requeue:${input.id}`,
    kind: "notice",
    text: tOf(store, sid)("server-sessions.requeued.notice", { reason: reason.slice(0, 200) }),
    status: "complete",
    createdAt: Date.now(),
  });
  return jid;
}
/**
 * Claude Code took a steer after all, after it was
 * handed back (a late `started` / replay). Withdraw the requeued job while
 * it has not started, so it never runs twice; once it has started, say so.
 * Idempotent. Returns what happened.
 */
export function withdrawRequeued(
  store: Store,
  input: any,
  emit: (sid: string, type: "item", data: any) => unknown,
): "withdrawn" | "started" | "none" {
  if (input.status !== "requeued") return "none";
  // an appended Daisy job given back, then read after all — take
  // it out of the queue while it has not run as a turn of its own.
  if (input.source_job) {
    const job = sourceOf(store, input);
    if (!job) return "none";
    if (job.status !== "pending") {
      if (job.status === "interrupted") return "none";
      emit(job.session_id, "item", {
        id: `append-late:${input.id}`,
        kind: "notice",
        text: tOf(store, job.session_id)("server-sessions.requeued.alsoRead"),
        status: "error",
        createdAt: Date.now(),
      });
      return "started";
    }
    store.run("UPDATE jobs SET status='completed' WHERE id=?", job.id);
    forgetJump(store, job.session_id, job.id);
    store.run(
      "UPDATE native_appends SET state='completed' WHERE job_id=?",
      job.id,
    );
    store.run(
      "UPDATE live_inputs SET status='accepted',result=? WHERE id=?",
      JSON.stringify({ withdrawn: job.id }),
      input.id,
    );
    const old = store.one(
      "SELECT data FROM items WHERE session_id=? AND id=?",
      job.session_id,
      `user:${job.id}`,
    );
    if (old)
      emit(job.session_id, "item", {
        ...JSON.parse(old.data || "{}"),
        id: `user:${job.id}`,
        kind: "user",
        status: "accepted",
        delivery: "read",
      });
    emit(job.session_id, "item", {
      id: `append-back:${input.id}`,
      kind: "notice",
      text: tOf(store, job.session_id)("server-sessions.requeued.withdrawn"),
      status: "complete",
      createdAt: Date.now(),
    });
    return "withdrawn";
  }
  let jid = "";
  try {
    jid = JSON.parse(input.result || "{}").requeued || "";
  } catch {}
  const job = jid ? store.one("SELECT * FROM jobs WHERE id=?", jid) : null;
  if (!job) return "none";
  const sid = job.session_id;
  if (job.status !== "pending") {
    emit(sid, "item", {
      id: `requeue-late:${input.id}`,
      kind: "notice",
      text: tOf(store, sid)("server-sessions.requeued.claudeAlso"),
      status: "error",
      createdAt: Date.now(),
    });
    return "started";
  }
  store.run("UPDATE jobs SET status='interrupted' WHERE id=?", jid);
  store.run(
    "UPDATE live_inputs SET status='accepted',result=? WHERE id=?",
    JSON.stringify({ withdrawn: jid }),
    input.id,
  );
  const old = store.one(
    "SELECT data FROM items WHERE session_id=? AND id=?",
    sid,
    `user:${jid}`,
  );
  emit(sid, "item", {
    ...JSON.parse(old?.data || "{}"),
    id: `user:${jid}`,
    kind: "user",
    text: job.text,
    status: "cancelled",
    createdAt: job.created,
  });
  emit(sid, "item", {
    id: `input:${input.id}`,
    kind: "user",
    text: input.text,
    status: "accepted",
    delivery: "read",
    ...(input.context ? { context: JSON.parse(input.context) } : {}),
    createdAt: input.created,
  });
  emit(sid, "item", {
    id: `requeue:${input.id}`,
    kind: "notice",
    text: tOf(store, sid)("server-sessions.requeued.claudeWithdrawn"),
    status: "complete",
    createdAt: Date.now(),
  });
  return "withdrawn";
}
