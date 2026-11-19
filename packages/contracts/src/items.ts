import type { MessageContext, TerminalResult } from "./message.ts";
import type { Session } from "./session.ts";
import { PRODUCT_NAME } from "./names.ts";
import type { Translate } from "./i18n.ts";
import { defaultTranslate } from "./i18n-default.ts";
/**
 * The sender of an item Daisy itself wrote (an origin's `senderName`).
 * ADR-154: 「Harbor 系统」 before — stored items still say so; a reader
 * takes either (`isSystemSender`).
 */
export const systemSender = (t: Translate = defaultTranslate()): string => t("common-contracts.systemSender");
/**
 * P6-23b: written in the owner's language (`systemSender(ownerT())`); a
 * reader takes every language's form and the old ones — 「<产品> 系统」,
 * 「Harbor 系统」, "<product> system" — whatever the reader speaks.
 */
const SYSTEM_WORD = /(?:系统|system)$/i;
const SYSTEM_SENDER_FORM = new RegExp(
  "^(?:" + PRODUCT_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "|Harbor) " + SYSTEM_WORD.source,
  "i",
);
export const isSystemSender = (name: unknown, t: Translate = defaultTranslate()) =>
  typeof name === "string" && (name === systemSender(t) || SYSTEM_SENDER_FORM.test(name));
// What a conversation holds: items, approvals, events, snapshots (P1-00: moved from index.ts).
export type ItemKind = "user" | "assistant" | "thinking" | "tool" | "notice";
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}
/**
 * Where a user-role item really came from: a
 * question another Agent or person asked ("peer"), the answer to this
 * Agent's own question ("peer-reply") or a failed one. `text` stays the
 * full model prompt; UIs show `question` as from the sender.
 */
export interface ItemOrigin {
  type: "peer" | "peer-reply" | "peer-failure";
  senderName: string;
  senderKind: "agent" | "human";
  ownerName: string;
  /** Where it came from, one short label (「审批」, 「自动模式」…). */
  place: string;
  messageId: string;
  question: string;
  /**
   * a Daisy event, not a collaboration — e.g.
   * "classifier-retry" (the auto-mode classifier was unavailable; Daisy
   * retries). Shown as a Daisy event marker, never as 「协作请求未完成」.
   */
  event?: "classifier-retry";
}
export interface Item {
  id: string;
  kind: ItemKind;
  text: string;
  /** User-role items Daisy injected for someone else (see ItemOrigin). */
  origin?: ItemOrigin;
  status?: string;
  name?: string;
  input?: unknown;
  category?:
    | "lifecycle"
    | "audit"
    | "subagent"
    | "plan"
    | "usage"
    | "native"
    /** A turn the Agent started by itself: timer, background report. */
    | "wake"
    /**
     * what a 「任务常驻 Agent」 deliberately said to people (its
     * `say` tool) — the only Agent output its conversation shows by default.
     */
    | "say"
    /** Context compaction finished: `input` = CompactInfo. */
    | "compact"
    /**
     * the harness refused a tool call by itself (Claude Code auto
     * mode, dontAsk, a deny rule); the control plane makes an 「审批」 card.
     */
    | "interception";
  parentId?: string;
  threadId?: string;
  native?: unknown;
  attachments?: Attachment[];
  /**
   * Host page context attached to this user message (echoed back, including
   * `text`, to the conversation owner). See MessageContextSchema.
   */
  context?: MessageContext;
  /**
   * Commands the user ran in their own terminal from the composer and sent
   * with this message; `output` here is cut for display.
   */
  terminal?: TerminalResult[];
  /**
   * Follow-up 2026-11-09: an accepted message added to a running turn
   * (立即追加, a native append) — `handed`: the agent holds it, not
   * read yet (Claude: at its next tool boundary); `read`: the model has it.
   * Absent: a turn's own message, or an older control plane.
   */
  delivery?: "handed" | "read";
  /**
   * Follow-up 2026-11-09: Claude Code retracted this
   * partial answer (`system/model_refusal_fallback`
   * `retracted_message_uuids`) and retried on its fallback model — kept,
   * shown greyed as 「已撤回」, never taken as the turn's answer.
   */
  retracted?: boolean;
  createdAt: number;
}
/** compact_boundary data. */
export interface CompactInfo {
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
}
export interface Approval {
  id: string;
  jobId: string;
  sessionId: string;
  title: string;
  input: unknown;
  options: { id: string; label: string }[];
  status: "pending" | "answered" | "expired";
  decision?: { optionId: string; answers?: Record<string, string> };
  createdAt: number;
  /**
   * "permission" = the harness asks before a tool runs (Claude
   * Code permission prompt incl. auto-mode escalations, Codex command /
   * file / permission requests) — answered only on the 「审批」 page, the
   * conversation shows its status; "question" = the Agent asks the user
   * something (AskUserQuestion, Codex user input, MCP forms) — answered in
   * the conversation.
   * Absent (older Runners): see approvalCategory().
   */
  category?: "permission" | "question";
  /** The harness's own reason for asking (Claude decision_reason). */
  reason?: string;
  /** Answered on the 「审批」 page by this person. */
  decidedBy?: string;
  decidedAt?: number;
}
/** what a native approval is, also for older Runners' rows. */
export function approvalCategory(
  a: Pick<Approval, "category" | "title" | "input">,
): "permission" | "question" {
  if (a.category) return a.category;
  // By the Runner's title only (review 2026-11-03): the tool input is the
  // model's, and must not turn a permission prompt into a question.
  if (/需要你的回答|需要你的确认|AskUserQuestion/.test(a.title || ""))
    return "question";
  return "permission";
}
export interface Event {
  id: string;
  seq: number;
  sessionId: string;
  type: "item" | "status" | "approval" | "native" | "live";
  data: any;
  createdAt: number;
}
export interface Snapshot {
  session: Session;
  items: Item[];
  approvals: Approval[];
  /** Newest event seq of the conversation: its version. */
  cursor: number;
  /**
   * Older items are not included (`?tail=N`, or a window the client grew
   * from one): `GET /sessions/:id/items?before=` pages them in.
   */
  partial?: boolean;
  /** Items the conversation has in all; a held window checks deletions against it. */
  total?: number;
  /**
   * `?since=<cursor>` answered with only the items written after that
   * cursor: `items` replace held ones by id or append. Absent =
   * a complete answer (full or tail) that replaces what the client holds.
   */
  delta?: boolean;
  /** The device the conversation runs on, as the server sees it now. */
  node?: SessionNodePresence;
  /**
   * what 「同时撤销文件」 does for this session's agent on its
   * device — `native` (Claude Code `rewind_files`), `fallback` (Daisy's
   * per-turn checkpoints, Codex), `none` (not offered). Absent: an older
   * server (Claude Code only). An older server wrote `fallback`
   * as `harbor` (ADR-152): read it as `fallback`.
   */
  rewindFiles?: "native" | "fallback" | "none";
  /**
   * P4-11 (plan §5.5, ADR-131): every capability of the unified list for
   * this session's AI on its device, as declared (`featuresFor`); the UI
   * offers only what is not `none`. Absent: an older server.
   */
  features?: Record<
    import("./agent-capabilities.ts").AgentFeature,
    "native" | "fallback" | "none"
  >;
  /**
   * Key of the newest user message that carried a host page context and was
   * not cancelled / failed, over the whole conversation (fb3 F2):
   * the composer's 「已附带」 does not depend on the loaded window. null = none.
   */
  contextKey?: string | null;
  /**
   * `?since=` named a cursor this server's log never reached (restored from
   * a backup): this complete answer replaces everything the client holds,
   * whatever its cursor.
   */
  reset?: boolean;
  /**
   * present only when a resident (常驻) session answered
   * `?view=conversation`: `items` are its visible items only (kind user,
   * its `say`, paused / resumed notices), the newest `messageLimit` of them;
   * `partial` = older visible items exist. Never a delta. Absent = the raw
   * run log (ordinary sessions, or no `view`).
   */
  view?: "conversation";
  /** With `view`: the earliest returned item id — `before=` for the next older page; null = no items. */
  before?: string | null;
}
/**
 * A page of older items, `GET /sessions/:id/items?before=`.
 * with `view=conversation` on a resident, visible items only —
 * then `view`, `before` (earliest returned id) and `partial` (= `more`).
 */
export interface ItemsPage {
  items: Item[];
  more: boolean;
  view?: "conversation";
  before?: string | null;
  partial?: boolean;
}
/**
 * A conversation's device (runner): online = its runner was heard from in
 * the last 10 s (it asks for work about every half second).
 */
export interface SessionNodePresence {
  online: boolean;
  /** Last time the runner was heard from (ms), 0 = never. */
  lastSeen: number;
  /** In the request's language when it is Daisy's own default name (P6-28). */
  label: string;
  /** The label is Daisy's default node name (`shownName("node", …)`). */
  labelDefault?: boolean;
}
