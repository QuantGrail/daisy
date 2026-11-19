/**
 * Codex's automatic approval review (approvalsReviewer
 * "auto_review") refusing an action, as Daisy's interception item — the
 * owner's 拦截卡, the same one Claude Code's `permission_denied` makes
 *. Codex 0.157.1 sends no server request for it (no card of its
 * own): `item/autoApprovalReview/completed {threadId, turnId, reviewId,
 * targetItemId, decisionSource, review{status, riskLevel,
 * userAuthorization, rationale}, action{type, …}}`, schema [UNSTABLE]
 * "expected to change soon" — so every field is read leniently and a
 * shape not understood still makes one card with what there is.
 *
 * 「允许并重试」 natively (measured 0.157.1): `thread/approveGuardianDeniedAction
 * {threadId, event}` where `event` is Codex's internal
 * `GuardianAssessmentEvent` (serde, snake_case: `id` = reviewId,
 * `status` "denied", `turn_id`, `target_item_id`, `risk_level`,
 * `user_authorization`, `rationale`, `decision_source`, `action` with
 * snake_case keys and variant names — `unified_exec`, `write_stdin`,
 * `apply_patch`, `network_access`, `mcp_tool_call`, `request_permissions`).
 * It answers `{}`, starts no turn and adds a developer message to the
 * thread: 「The user has manually approved a specific action that was
 * previously `Rejected`… Approved action: …」; the reviewer allowed the
 * same command on the retry. Codex does not check the event against its
 * own reviews, so the Runner only ever sends events built from Codex's own
 * notification (stored with the card), never anything model- or
 * person-typed.
 */
import { turnT } from "./model-switch.ts";
import type { Item } from "../../../contracts/src/index.ts";

/** Statuses that refused the action (aborted = the turn was stopped: no card). */
const REFUSED = new Set(["denied", "timedOut"]);
/** Above this the event is not kept (the card still comes; retry = wake only). */
export const GUARDIAN_EVENT_MAX = 8000;

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
/** Keys snake_case all the way down; enum values of `enums` keys too. */
function snakeDeep(v: unknown, enums: Set<string>): unknown {
  if (Array.isArray(v)) return v.map((x) => snakeDeep(x, enums));
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => [
      snake(k),
      typeof x === "string" && enums.has(k) ? snake(x) : snakeDeep(x, enums),
    ]),
  );
}
// `type` = the action variant; `source` = shell / unifiedExec;
// `protocol` = network (socks5Tcp → socks5_tcp). FileSystemPath `type`s
// are snake_case already.
const ACTION_ENUMS = new Set(["type", "source", "protocol"]);

/**
 * The `event` for `thread/approveGuardianDeniedAction` from a completed
 * review notification (null: not a refusal, or not understood).
 */
export function guardianEvent(n: any): Record<string, unknown> | null {
  const review = n?.review;
  if (!n?.reviewId || !review || !REFUSED.has(review.status)) return null;
  if (!n.action || typeof n.action !== "object" || !n.action.type) return null;
  const event = {
    id: String(n.reviewId),
    status: snake(String(review.status)),
    ...(n.turnId ? { turn_id: String(n.turnId) } : {}),
    target_item_id: n.targetItemId ?? null,
    risk_level: review.riskLevel ?? null,
    user_authorization: review.userAuthorization ?? null,
    rationale: review.rationale ?? null,
    decision_source: n.decisionSource ?? "agent",
    action: snakeDeep(n.action, ACTION_ENUMS),
  };
  return JSON.stringify(event).length <= GUARDIAN_EVENT_MAX ? event : null;
}

/** What the refused action is, in the card's words. */
export function actionTool(a: any): string {
  switch (a?.type) {
    case "command":
    case "execve":
      return "Shell";
    case "writeStdin":
      return turnT()("server-harness.review.shellInput");
    case "applyPatch":
      return turnT()("server-harness.review.fileChange");
    case "networkAccess":
      return turnT()("server-harness.review.network");
    case "mcpToolCall":
      return `MCP ${String(a.server || "")}${a.toolName ? `/${a.toolName}` : ""}`.trim();
    case "requestPermissions":
      return turnT()("server-harness.review.permissions");
    default:
      return a?.type ? String(a.type) : turnT()("server-harness.review.action");
  }
}


/**
 * The interception item of a refused review (null: approved, in progress,
 * aborted, or no review). `root`: the session's thread (a subagent's
 * refusal says which thread).
 */
export function reviewInterception(
  n: any,
  root: string,
): { key: string; item: Partial<Item> } | null {
  const review = n?.review;
  if (!review || !REFUSED.has(review.status)) return null;
  const id = String(n.reviewId || n.targetItemId || "");
  if (!id) return null;
  const action = n.action && typeof n.action === "object" ? n.action : null;
  const tool = actionTool(action);
  const timedOut = review.status === "timedOut";
  const rationale =
    typeof review.rationale === "string" ? review.rationale : "";
  const judged = [
    review.riskLevel ? turnT()("server-harness.review.risk", { level: String(review.riskLevel) }) : "",
    review.userAuthorization ? turnT()("server-harness.review.authorization", { value: String(review.userAuthorization) }) : "",
  ]
    .filter(Boolean)
    .join(turnT()("server-harness.review.separator"));
  const message = timedOut
    ? turnT()("server-harness.review.timedOut")
    : turnT()("server-harness.review.denied", {
        judged: judged ? turnT()("server-harness.review.judged", { judged }) : "",
        rationale: rationale ? turnT()("server-harness.review.rationale", { rationale }) : "",
      });
  const event = timedOut ? null : guardianEvent(n);
  const thread = n.threadId && n.threadId !== root ? String(n.threadId) : "";
  return {
    key: `denied:review:${id}`,
    item: {
      kind: "tool",
      category: "interception",
      name: tool,
      text: message,
      status: "error",
      input: {
        toolName: tool,
        toolUseId: n.targetItemId ?? "",
        // Codex's own enum, never model text (the classifier retry's check reads it).
        reasonType: "auto_review",
        reviewStatus: String(review.status),
        reason: timedOut ? "Auto review timed out" : rationale,
        message,
        ...(review.riskLevel ? { riskLevel: String(review.riskLevel) } : {}),
        ...(review.userAuthorization
          ? { userAuthorization: String(review.userAuthorization) }
          : {}),
        ...(thread ? { threadId: thread } : {}),
        request: action,
        ...(event ? { guardian: event } : {}),
      },
    } as Partial<Item>,
  };
}
