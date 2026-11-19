/**
 * the owner's 「允许并重试」 of an action the agent's own review
 * refused, handed to the agent natively where it can take it (node
 * capability `agentFeatures[agent].approvals.approveDenied: native` —
 * Codex `thread/approveGuardianDeniedAction`). Daisy's retry wake goes
 * either way; this only lets the agent's reviewer see that the
 * owner approved that exact action.
 *
 * One row per decided card (`native_approvals`): the event Codex itself
 * sent with the refusal (stored with the card by the Runner's report,
 * never typed by anyone), given to the Runner with the next turn — or
 * appended input — of that session that runs with the owner's authority
 * (`ownerTurn`: her own message, her decision's wake, her timers…), so a
 * group request or another machine wake never carries it, nor an
 * operation (/compact, review…). Offered with every such turn until the
 * Runner reports it handled (its `stage:native-approval:<id>` item,
 * complete or error — `nativeApprovalHandled`), so a turn that failed
 * before getting to it (start-up error, thread not ready) leaves it for
 * the next one. One not handled within `NATIVE_APPROVAL_TTL` is dropped
 * (the wake still asks for the retry, which the reviewer judges as usual).
 */
import type { Store } from "../store/index.ts";
import type {
  NativeApproval,
  Session,
} from "../../../contracts/src/index.ts";
import { reviewRoute } from "../../../contracts/src/agent-capabilities.ts";
import { ownerTurn } from "./bypass-policy.ts";

export const NATIVE_APPROVAL_TTL = 60 * 60_000;

/** The session's node takes native approvals for its agent. */
export function approvesNatively(store: Store, s: Session): boolean {
  try {
    const caps = JSON.parse(
      store.one("SELECT capabilities FROM nodes WHERE id=?", s.nodeId)
        ?.capabilities || "{}",
    );
    return !!reviewRoute(caps, s.agent)?.approveDenied;
  } catch {
    return false;
  }
}

/**
 * Inside the decision's transaction: card `cardId` (`block:<id>`) was
 * allowed — queue its stored event for the agent. False: not natively
 * (no event, or the node / agent cannot take it).
 */
export function queueNativeApproval(
  store: Store,
  s: Session,
  cardId: string,
  event: unknown,
  /** The subagent thread refused (absent: the session's own). */
  threadId?: string,
): boolean {
  if (!event || typeof event !== "object") return false;
  if (!approvesNatively(store, s)) return false;
  store.run(
    "INSERT OR IGNORE INTO native_approvals(id,session_id,kind,data,created,taken_by,offered_to,thread_id) VALUES(?,?,?,?,?,NULL,NULL,?)",
    cardId,
    s.id,
    "codexGuardianDenial",
    JSON.stringify(event),
    Date.now(),
    threadId || null,
  );
  return true;
}

/**
 * What job `job` (being claimed / appended) hands to the agent: the
 * session's approvals not handled yet, if it runs with the owner's
 * authority and is not an operation. Each is offered again with later
 * turns until the Runner says it handled it.
 */
export function takeNativeApprovals(
  store: Store,
  job: any,
  now = Date.now(),
): NativeApproval[] | undefined {
  if (!job?.session_id || !ownerTurn(job)) return undefined;
  if (store.one("SELECT 1 FROM job_operations WHERE job_id=?", job.id))
    return undefined;
  // Not handled in time (the wake asked anyway); handled ones kept a week.
  store.run(
    "DELETE FROM native_approvals WHERE (taken_by IS NULL AND created<?) OR created<?",
    now - NATIVE_APPROVAL_TTL,
    now - 7 * 86400_000,
  );
  const rows = store.all(
    "SELECT * FROM native_approvals WHERE session_id=? AND taken_by IS NULL ORDER BY created",
    job.session_id,
  );
  if (!rows.length) return undefined;
  for (const r of rows)
    store.run(
      "UPDATE native_approvals SET offered_to=? WHERE id=?",
      job.id,
      r.id,
    );
  return rows.map((r: any) => ({
    id: r.id,
    kind: r.kind,
    event: JSON.parse(r.data),
    ...(r.thread_id ? { threadId: r.thread_id } : {}),
  }));
}

/**
 * The Runner reported item `itemId` of session `sid`: a
 * `<job>:stage:native-approval:<cardId>` stage that ended (complete =
 * approved, error = Codex refused it or the subagent thread is gone) —
 * that approval is handled, not offered again.
 */
export function nativeApprovalHandled(
  store: Store,
  sid: string,
  itemId: string,
  status: string | undefined,
) {
  const at = itemId.indexOf(":stage:native-approval:");
  if (at < 0 || !["complete", "error"].includes(String(status))) return;
  store.run(
    "UPDATE native_approvals SET taken_by=? WHERE id=? AND session_id=? AND taken_by IS NULL",
    itemId.slice(0, at),
    itemId.slice(at + ":stage:native-approval:".length),
    sid,
  );
}
