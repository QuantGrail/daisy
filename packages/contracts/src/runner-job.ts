import type { Session } from "./session.ts";
import type { Attachment } from "./items.ts";
import type { MessageContext, TerminalResult } from "./message.ts";
import type { Workspace } from "./workspace.ts";
import type { Profile } from "./profile.ts";
// What a Runner gets for a turn (P1-00: moved from index.ts).
/** one native approval of a refused action (RunnerJob.nativeApprovals). */
export interface NativeApproval {
  /** The interception card (`block:<id>`) it answers. */
  id: string;
  kind: "codexGuardianDenial";
  /** Codex: a serialized `GuardianAssessmentEvent` (snake_case). */
  event: unknown;
  /**
   * The subagent thread that was refused (absent: the session's own
   * thread). Approved there only while that thread is still loaded.
   */
  threadId?: string;
}
export interface RunnerJob {
  operation?: import("./commands").AgentOperation;
  id: string;
  /**
   * "agent": a turn the Agent started by itself in its online process
   *; `wake` says why. Absent: the user's message or an operation.
   */
  /**
   * "schedule": a Daisy timer fired or a Daisy background
   * command / monitor reported — `text` says what; it is not the owner's
   * message (no user bubble).
   */
  origin?: "agent" | "schedule";
  wake?: string;
  /**
   * the control plane runs Daisy's scheduler — the Runner gives
   * the Agent its tools (Claude Code: an in-process MCP server; Codex:
   * dynamic tools). ADR-154: `version` 2 (`DAISY_TOOLSET_VERSION`), sent
   * to a Runner that declared `daisyTools`; the tools go by Daisy's name
   * (server `daisy`, `daisy_<name>`), or — `legacyNames` — by the old ones
   * (server `harbor`, `harbor_<name>`) for a native conversation started
   * with those (`sessionToolNames`).
   */
  daisyTools?: { version: number; legacyNames?: boolean };
  /**
   * The same from a control plane before ADR-154 (or sent to a Runner
   * before it): the tools by the old names. Read only; neither field:
   * no Daisy tools.
   */
  harborTools?: { version: number };
  /**
   * a resident's whole built-in prompt, written by the control
   * plane (its owner's changes). Absent (an older
   * control plane): the Runner builds it from the session.
   */
  residentGuide?: string;
  /**
   * P4-07 (ADR-126): a resident agent's dedicated session — what its owner
   * allowed: the harness's built-in tools (null: its default set), extra
   * directories, and whether an operation auto mode still asks a person
   * about is declined by the Runner itself (never shown to the owner).
   */
  residentLimits?: { tools: string[] | null; dirs: string[]; declineApprovals: boolean };
  /**
   * the whole system-layer text in layers (org core, session
   * notes, the owner's words, safety rules), composed by the control
   * plane — only for a Runner that declared `promptLayers`. With it the
   * Runner appends `guide.text` as is and keys the process on
   * `guide.stable`; absent, `residentGuide` / the older logic.
   */
  guide?: import("./guide.ts").JobGuide;
  session: Session;
  /**
   * P1-03: this turn's working credential (5.11 「AI 工作凭据」) — the
   * file that holds it (rewritten each turn; the harness gets the path as
   * DAISY_AI_CREDENTIAL_FILE) and the local face's address (DAISY_URL).
   * It reads only this session and dies with the turn.
   */
  aiCredential?: { file: string; url: string | null };
  text: string;
  /** Host page context of this message, prepended by buildPrompt. */
  context?: MessageContext;
  /** Terminal runs sent with this message, full output. */
  terminal?: TerminalResult[];
  attachments: (Attachment & { data: string })[];
  /**
   * the owner's 「允许并重试」 of actions the agent's own review
   * refused, to hand to the agent natively before this turn (Codex
   * `thread/approveGuardianDeniedAction`). Taken once, by the first turn
   * (or appended input) of the session it is claimed with.
   */
  nativeApprovals?: NativeApproval[];
  workspace: Workspace;
  profile: Profile & { apiKey?: string; authHeader?: string };
  /**
   * after 「换身份」, the previous identity and its config
   * directory as stored ("" = the Runner user's default, "managed:<id>" =
   * resolved by the Runner) — where the Agent's transcript of this
   * conversation still is. Only for an identity of the same node.
   */
  carryFrom?: { profileId: string; configDir: string };
  lease: string;
}
