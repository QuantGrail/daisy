import { z } from "zod";
import {
  AGENT_IDS,
  type AcpAgent,
  type NATIVE_AGENTS,
} from "./acp-harnesses.ts";
import type { ResidentConfig } from "./scheduler.ts";
import type { QuotaSnapshot, SessionContext } from "./context-usage.ts";
import type { LiveState, LiveTimer } from "./live.ts";
// Conversations (sessions): the record, its settings, creation (P1-00: moved from index.ts).
/**
 * Who can find and call an AI conversation (开放范围; stage 4 rebuilds call
 * authorization on it — P1-01 keeps only the setting). public: everyone
 * the owner recognizes; private: owner only; selected: only the listed
 * people. Never grants the transcript (owner-only).
 */
export const SessionVisibilitySchema = z.enum([
  "public",
  "private",
  "selected",
]);
export type SessionVisibility = z.infer<typeof SessionVisibilitySchema>;
/**
 * P4-10: Daisy's own adapters plus every ACP harness of acp-harnesses.ts
 * (and of `$DAISY_ACP_HARNESSES`, at run time — the type names the
 * built-in ones).
 */
export type Agent = (typeof NATIVE_AGENTS)[number] | AcpAgent;
export const AgentSchema = z.enum(AGENT_IDS as [Agent, ...Agent[]]);
export type SessionStatus =
  "idle" | "queued" | "running" | "waiting" | "interrupted" | "error";
/** A host task this session's messages carried in `context.refs` (fb3 F3). */
export interface RelatedTask {
  id: string;
  title: string;
  url?: string;
  /** Last time a message carried this task (ms); the list is newest first. */
  lastSeenAt: number;
}
export interface TaskContext {
  id: string;
  title: string;
  description?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}
export interface Session {
  workspaceMode?: "shared" | "isolated" | "read-only" | "snapshot";
  parentSession?: string;
  id: string;
  ownerId: string;
  title: string;
  /**
   * The title is provisional (created without one): the first message sets a
   * placeholder (its first sentence) and the second finished round the one
   * AI title. A title the user gave or renamed sets this false and is never
   * replaced.
   */
  titleAuto?: boolean;
  /**
   * Who produced the current title: absent = the system
   * placeholder (「新对话」 or the first sentence), `final` = the AI title
   * from the first two rounds (never generated again), `manual` = the user.
   */
  titleStage?: "final" | "manual";
  /** AI title attempts asked of the Runner so far (at most 2). */
  titleTries?: number;
  /** When the last attempt was asked (ms) and by which round's job. */
  titleAskedAt?: number;
  titleJob?: string;
  agent: Agent;
  nodeId: string;
  workspaceId: string;
  profileId: string;
  nativeId: string | null;
  contextDelivered?: boolean;
  commandCatalog?: {
    commands?: import("./commands").AgentCommand[];
    models?: any[];
    configOptions?: any[];
    writable?: boolean;
  };
  task: TaskContext | null;
  /**
   * Tasks seen in this session's message contexts, newest first, at most 50.
   * Maintained by the server; PATCH can only remove entries.
   */
  relatedTasks?: RelatedTask[];
  /**
   * the conversation's identity was switched (「换身份」): from
   * which identity, when. The Runner carries the Agent's transcript over
   * from the old identity's config directory before it resumes.
   */
  identityMove?: { from: string; at: number };
  /**
   * identities this conversation switched away from (newest last,
   * at most 10): while a process that does not say its identity (an older
   * Runner) is online, any of them may still be the one running, so none is
   * deleted or moved until it is offline.
   */
  identityPrev?: string[];
  status: SessionStatus;
  archived: boolean;
  /**
   * Is a real Agent process behind this conversation? Reported by
   * the runner that holds it; absent / `online: false` = offline (history is
   * kept, the next message brings it back online).
   */
  live?: LiveState;
  /** Model / effort for this conversation only; empty = the identity's. */
  settings?: SessionSettings;
  /**
   * "resident" = a 「任务常驻 Agent」 — a long-lived AI private
   * session with a purpose and its own controls (`resident`). Absent = an
   * ordinary AI conversation.
   */
  kind?: "resident";
  resident?: ResidentConfig;
  /**
   * P4-07 (ADR-126): the dedicated session of one visiting conversation
   * (A2A `contextId`) of resident agent `agentId` — hidden from the
   * session list like a sidecar; the agent's config says what it may do.
   */
  residentOf?: { agentId: string; contextId: string };
  /**
   * a read-only 「只问」 sidecar of session `parent`, answering in
   * conversation `root` (of `threadId`). Hidden from every list; `forkFrom` is
   * the parent's native session it forks from on its first turn (null: the
   * parent had none, the sidecar starts fresh).
   */
  sidecar?: {
    parent: string;
    threadId: string;
    root: string;
    forkFrom: string | null;
    createdAt: number;
    /**
     * Set in the job the Runner gets (not stored): the main
     * session's current native id (a fork takes the latest context), the
     * earlier questions / answers, and how this node's agent
     * answers natively (absent: Daisy's persisted fork, an older control plane).
     */
    mainNativeId?: string | null;
    history?: import("./ask-sidecar.ts").AskHistoryEntry[];
    native?: {
      sideQuestion: "native" | "none";
      fork: "native" | "fallback" | "none";
    };
  };
  /**
   * the Codex thread `thread` was started with Daisy's dynamic
   * tools (Codex keeps them on resume; a thread started before has none).
   * P4N-3: `names` — which ones (bare names); absent on a record from
   * before they were kept (see `missingThreadTools`). ADR-154: `version`
   * 2 — by Daisy's names (`daisy_*`), 1 — by the old ones (`harbor_*`).
   * A Claude Code conversation records `{ thread, version }` too (no
   * names: its tools are listed at every launch) — which names it was
   * started with (`sessionToolNames`).
   */
  nativeTools?: { thread: string; version: number; names?: string[] };
  /**
   * P6-24 (ADR-159 §6): the language of everything Daisy writes to this
   * session's model (system layer, tool descriptions and results, wake
   * heads) — the owner's language when the session was created, kept for
   * its whole life. Absent: created before P6-24, Chinese
   * (`sessionLang`, prompt-i18n.ts).
   */
  lang?: string;
  /**
   * P4N-3: the owner was told once that the Codex thread `thread` lacks
   * (or may lack) these Daisy tools.
   */
  nativeToolsNotice?: { thread: string; names: string[] };
  /**
   * the native session / thread `thread` got Daisy's layered
   * prompt in its system layer — `sha256` is which text. Reported by the
   * Runner at launch (Claude: a new session, or rendered afresh; Codex: a
   * new thread, or a developer message injected after resume). Each turn
   * of that thread may carry the short collaboration line.
   */
  nativeGuide?: {
    thread: string;
    sha256: string;
    /** That text held the static collaboration / workspace rules. */
    staticRules?: boolean;
    /**
     * How it got there: "record" — the engine recorded it (a new Claude
     * session, or after a compaction; a new Codex thread) and keeps it;
     * "inject" — a developer message added to a Codex thread; "fresh" —
     * Claude rendered afresh at that launch, true only while launches
     * stay that way.
     */
    via?: "record" | "inject" | "fresh";
    at: number;
  };
  /** bumped by its owner's 「立即压缩并生效」 (part of the process key). */
  promptEpoch?: number;
  /**
   * this ordinary session's own additions to its prompt (a note,
   * optional sections on / off); what is absent follows its owner's
   * defaults. Its owner's alone.
   */
  promptExtra?: import("./guide.ts").SessionPromptExtra;
  /**
   * Daisy scheduler items still open (timers, background
   * commands, monitors) — kept by the control plane, also while offline.
   * 「后台 N 项」 = these plus the online process's own `live.pending`.
   * ADR-152: called `harborPending` before; a record or an older server
   * that still has that name is read through `schedulerPendingOf` (live.ts).
   */
  schedulerPending?: LiveTimer[];
  /** What the Agent itself reported it runs with. */
  runtime?: {
    model?: string;
    effort?: string;
    /** Codex service tier the thread runs with; absent = unknown / standard. */
    serviceTier?: string;
    /**
     * the permission mode the Agent reported it runs with (Claude
     * `init.permissionMode`, Codex Daisy's mode for the thread's approval
     * policy / reviewer); absent = not reported.
     */
    permissionMode?: string;
    at: number;
  };
  /**
   * The newest context usage the Agent reported, whatever the
   * loaded item window: the composer ring reads this.
   */
  context?: SessionContext;
  /** The identity's plan quota as last read in this conversation. */
  quota?: QuotaSnapshot;
  /** The viewer is not the owner: `quota` was left out. */
  quotaHidden?: boolean;
  /**
   * Being deleted (DELETE /api/sessions/:id): hidden everywhere;
   * its running turn is being stopped, after which all rows are purged.
   */
  deleting?: boolean;
  /**
   * Visibility requested at creation, kept for the idempotent replay check
   * only (stage 4's call authorization reads it).
   */
  initialVisibility?: { visibility: SessionVisibility; visibleTo: string[] };
  createdAt: number;
  updatedAt: number;
}
export interface SessionSettings {
  model?: string;
  reasoningEffort?: string;
  /** Codex only: "" = the identity's, "default" = standard, "priority" = Fast. */
  serviceTier?: string;
  /** false = no 「只问」 sidecars (askOnly wakes the main session). */
  askSidecar?: boolean;
  /**
   * false = Daisy wakes arriving while a turn runs wait in
   * Daisy's queue instead of going into that turn natively. Absent = on.
   */
  autoAppendWakes?: boolean;
}
export const TaskSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  description: z.string().max(50000).optional(),
  url: z.string().url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const CreateSessionSchema = z.object({
  workspaceMode: z
    .enum(["shared", "isolated", "read-only", "snapshot"])
    .default("shared"),
  /** Optional: blank = generated after turn 1. */
  title: z.string().max(200).default(""),
  agent: AgentSchema,
  workspaceId: z.string(),
  profileId: z.string(),
  task: TaskSchema.optional(),
  /**
   * Idempotency key (M5): the same user repeating the same requestId gets the
   * session already created (`duplicate: true`) instead of a second one.
   */
  requestId: z.string().min(8).max(100).optional(),
  /**
   * Who can find this AI conversation (2026-10-30); see
   * SessionVisibilitySchema. P1-01: default private — and until stage 4
   * rebuilds call authorization the control plane records every new
   * session as private whatever is asked, so none becomes public later.
   */
  visibility: SessionVisibilitySchema.default("private"),
  /** visibility "selected": the people (user IDs) who can find and call it. */
  visibleTo: z.array(z.string().min(1).max(100)).max(100).default([]),
});
