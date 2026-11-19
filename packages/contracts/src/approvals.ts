/**
 * 审批合并 (2026-11-03): every
 * decision Daisy needs from an AI's owner, in one list that a host UI's
 * 「审批」 page merges with its own approvals and tickets. The data
 * stays where it is (approvals, owner_approvals; call cards: stage 4);
 * this is only the shared view.
 */
import { z } from "zod";
import { acpHarness } from "./acp-harnesses.ts";
import type { Translate } from "./i18n.ts";
import { defaultTranslate } from "./i18n-default.ts";

/**
 * call: someone wants to call my AI (调用审批; P4-03: 永久通过 / 仅本次 /
 * 拒绝, 7 days, decided with the PIN at `respondVia`); permission: Claude Code / Codex asks
 * before a tool runs (incl. auto-mode escalations); interception: Claude
 * Code auto mode refused a tool call by itself; owner: my AI asks me.
 */
export type DaisyApprovalKind =
  "call" | "permission" | "interception" | "owner";
export type DaisyApprovalStatus =
  "pending" | "approved" | "rejected" | "canceled" | "expired";
export interface DaisyApprovalOption {
  key: string;
  label: string;
  tone: "primary" | "danger" | "default";
}
export interface DaisyApprovalBase {
  /**
   * Stable: call cards `call:<id>` (P4-03); permission `perm:<id>`;
   * interception `block:<id>`; owner `ask:<id>`.
   */
  id: string;
  kind: DaisyApprovalKind;
  status: DaisyApprovalStatus;
  created: number;
  /**
   * Call cards: 7 days after `created` (P4-03). Owner approvals: 24 h after `created`. Permission
   * cards: `created` + the card time limit (limits.md §1, default 24 h);
   * then the turn ends and the card expires (R-4). Interceptions: null.
   */
  expiresAt: number | null;
  /** One line, ready to show. */
  title: string;
  /** The AI concerned (call cards: my AI that was asked). */
  session: { id: string; title: string; ownerName: string } | null;
  /**
   * This item's answers — also once decided (before, [] after a
   * decision). Answerable only while `status` is "pending"; show buttons by
   * status, not by `options.length`. One click = respond.
   */
  options: DaisyApprovalOption[];
  decision?: {
    choice: string;
    label: string;
    note?: string;
    by: { id: string; username: string };
    at: number;
  };
  /**
   * 审批讨论串: how many entries and the newest one (null = none
   * yet). The thread itself is `GET /api/approvals/:id/comments`.
   */
  thread?: ApprovalThreadSummary | null;
}
/**
 * 审批讨论串 (2026-11-05 「审批…可聊天可以修改」): one entry of an
 * approval's discussion. `ai` is decided by the server from the
 * credential (a signed-in person vs an AI job's), never self-declared;
 * clients show AI entries labelled and as plain text. No entry ever
 * decides anything.
 */
export interface ApprovalThreadEntry {
  n: number;
  at: number;
  by: { kind: "human" | "agent"; id: string; name: string };
  /** approver = the one who decides; requester = the AI that asked (call cards: the calling AI). */
  role: "approver" | "requester";
  ai: boolean;
  kind: "comment" | "change_request" | "revision";
  body: string;
}
export interface ApprovalThreadSummary {
  count: number;
  last: Pick<ApprovalThreadEntry, "n" | "role" | "ai" | "kind" | "at"> & {
    by: string;
  };
}
export interface ApprovalThread {
  id: string;
  status: DaisyApprovalStatus;
  entries: ApprovalThreadEntry[];
  me: { role: "approver" | "requester" | null; canPost: boolean };
  /** Is there an AI to wake (permission prompts: no). */
  requester: { sessionId: string; title: string } | null;
}
/** POST /api/approvals/:id/comments (person). */
export const ApprovalCommentSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  kind: z.enum(["comment", "change_request"]).default("comment"),
  requestId: z.string().min(8).max(100).optional(),
});
/**
 * A call card (stage 4 rebuilds call authorization; P1-01 keeps only the
 * shape the list needs): who calls which of my AIs.
 */
export type DaisyCallApproval = DaisyApprovalBase & {
  kind: "call";
  callerUser?: { id: string; username: string } | null;
  callerSession?: { id: string; title: string } | null;
  /**
   * P4-03 (additive): who calls — the contact (identity number) or the
   * external issuer's person — and the caller's AI, when its token said.
   */
  caller?: {
    key: string;
    contactId: string | null;
    /** The external issuer behind the person (null: a contact); its name reads 「…（外部签发方）」. */
    issuer: string | null;
    subject: string;
    name: string;
    actor: string | null;
  };
  /** P4-03: the agent asked (a public agent's session, or a resident agent). */
  agent?: { id: string; name: string; sessionId: string | null };
  /**
   * P4-03 review M-3: how many calls joined the card, how many wait on it
   * now, and the distinct AIs behind them (cleaned, cut).
   */
  calls?: number;
  waiting?: number;
  actors?: string[];
  /**
   * P4-03: deciding a call card lets someone in (5.11: the PIN) — it goes
   * to this route (`daisy:grant` + PIN), not `/api/approvals/:id/respond`,
   * which answers 403 `request_needs_pin` for a call card.
   */
  respondVia?: { method: "POST"; path: string; pin: true };
};
export type DaisyPermissionApproval = DaisyApprovalBase & {
  kind: "permission";
  agent: string;
  tool: string;
  /** The harness's own reason (Claude decision_reason), "" when none. */
  reason: string;
  input: unknown;
  jobId: string;
};
export type DaisyInterception = DaisyApprovalBase & {
  kind: "interception";
  tool: string;
  reason: string;
  message: string;
  input: unknown;
  /**
   * who refused it — "auto_review" = Codex's automatic approval
   * review (its `riskLevel` / `userAuthorization` judgement alongside);
   * absent = Claude Code auto mode (or a deny rule / hook).
   */
  reviewer?: "auto_review";
  riskLevel?: string;
  userAuthorization?: string;
};
export type DaisyOwnerApproval = DaisyApprovalBase & {
  kind: "owner";
  question: string;
  detail: string;
  /**
   * Who asked the AI to do it, when the AI said so: a person or an AI it
   * named by ID / username, else its own words (`text`, ≤ 100 chars;
   * free text used to be dropped).
   */
  askedBy:
    | { kind: "human" | "agent"; id: string; name: string }
    | { kind: "text"; name: string }
    | null;
};
export type DaisyApproval =
  | DaisyCallApproval
  | DaisyPermissionApproval
  | DaisyInterception
  | DaisyOwnerApproval;

export const DaisyApprovalRespondSchema = z.object({
  decision: z.string().min(1).max(64),
  note: z.string().max(2000).optional(),
});

/**
 * Claude Code bypassPermissions, Codex danger-full-access with approval
 * policy never, Kimi yolo: no harness prompt at all. Not for an AI others
 * can find or call; shown everywhere with 「不鼓励」.
 */
export function bypassMode(p: {
  agent?: string;
  permissionMode?: string;
  sandboxMode?: string;
}): boolean {
  const mode = p.permissionMode || "";
  if (p.agent === "claude") return mode === "bypassPermissions";
  if (p.agent === "codex")
    return mode === "never" && p.sandboxMode === "danger-full-access";
  // P4-10: the ACP harness's declared bypass mode (Kimi yolo), if any.
  const bypass = acpHarness(p.agent)?.modes.bypass;
  return !!bypass && mode === bypass;
}
/** P6-23b: the bypass warning in `t`'s language (was the constant BYPASS_WARNING). */
export const bypassWarning = (t: Translate = defaultTranslate()): string => t("common-contracts.bypassWarning");
