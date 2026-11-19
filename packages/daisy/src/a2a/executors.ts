/**
 * P4-04 (ADR-123 §5): the seam between the A2A server and whatever runs a
 * task. The server owns the protocol — the three ids, the states, who may
 * call, blocking, cancel, history, expiry; an executor owns one thing: run
 * this request on this agent and say how it ended.
 *
 *   P4-05 (问与办) registers the public agents' executor: `mode` "ask" on
 *   the read-only branch (or the main line, read-only, noted), "act" on
 *   the main line after the owner's turn (refused `ACT_DISABLED` when the
 *   agent says no), `ASK_NOT_SUPPORTED` for a harness with no read-only.
 *   P4-07 (常驻 agent) registers the residents': one session per
 *   conversation (`contextId`), `queued()` while over its concurrency cap
 *   (A-19), `AGENT_PAUSED` while paused (A-18).
 *   P4-06 (ADR-125) resolves which sessions are public, marks where the
 *   turn came from (D-18: `caller`, `via`, `taskId`, `trace`) and audits
 *   each tool action of the turn with its task (A-9, a2a/tool-audit.ts).
 *
 * Until one of them registers, no agent has an executor: a call that got
 * through the call authorization is rejected `AGENT_UNAVAILABLE` (nothing
 * is callable before P4-06 anyway — every session is private).
 */
import type { AgentInfo, CallVia } from "../invoke/invoke-access.ts";
import type { TaskReason } from "../../../contracts/src/a2a.ts";

/** A file coming in (a `raw` part) or going out (an artifact). */
export interface A2AFile {
  filename: string;
  mediaType: string;
  bytes: Buffer;
}

/** An earlier request in the same conversation, and how it was answered. */
export interface A2APriorTask {
  taskId: string;
  state: string;
  /** What the caller asked (its messages' text, joined). */
  request: string;
  /** The final answer (null: none — failed, canceled, rejected, still open). */
  answer: string | null;
}

export interface A2AJob {
  agent: AgentInfo;
  taskId: string;
  contextId: string;
  caller: {
    /** Who owns the conversation: `contact:<id>`, `sub:<issuer>|<subject>`, or `token:<jti>` (a `daisy token`, P4-12). */
    key: string;
    /** The person, as the call authorization knows them (display name etc.). */
    contactId: string | null;
    subject: string;
    name: string;
    /** The caller's AI acting (`act.sub`), when its token said. */
    actor: string | null;
  };
  /**
   * What the caller asked for (a2a-usage.md §8.1): "act" only when the
   * A2A-Extensions header enables the act extension and the message's
   * metadata says `{"mode":"act"}`; anything else is "ask" — the safe
   * default. P4-05 decides what the agent does with it.
   */
  mode: "ask" | "act";
  /**
   * P4-06 (D-18): how the call authorization let this call in — the
   * whitelist, the agent's named list, the owner's standing grant, or her
   * 仅本次 on a card (null: not known, e.g. a continuation after a restart).
   */
  via?: CallVia | null;
  /** This message's text: its `text` parts, and `data` parts as JSON, in order. */
  text: string;
  /** This message's files (`raw` parts). */
  files: A2AFile[];
  /** The task resumes after the caller answered an input-required question. */
  continuing: boolean;
  /** This task's own exchange so far, oldest first (the caller's messages, the agent's questions). */
  thread: { role: "user" | "agent"; text: string }[];
  /** Earlier requests in this conversation (5.8: "执行时带上这段对话之前的历史"), oldest first. */
  history: A2APriorTask[];
  /** Tasks the message names in `referenceTaskIds` (the caller's own, on this agent). */
  references: A2APriorTask[];
  /** trace.md: the trace id this call continues, and the depth of the turn it causes. */
  trace: { traceId: string; depth: number };
  /** Aborted when the caller cancels, the permission is taken back, or Daisy restarts. */
  signal: AbortSignal;
  /** The task waits its turn (TASK_STATE_SUBMITTED) — e.g. behind the owner's turn, over a cap. */
  queued(): void;
  /** The task is running now (TASK_STATE_WORKING). The server sets this when `run` starts. */
  working(): void;
}

export type A2AOutcome =
  | {
      state: "completed";
      /** The final answer (artifact `answer`, first text part). */
      answer: string;
      /** Things to say alongside (e.g. "问回落到主线排队", 5.7): more text parts of `answer`. */
      notes?: string[];
      /** Files it produced (artifacts `file-<n>`). */
      files?: A2AFile[];
      /** Under the act extension's key etc. (a2a-usage.md §8.1 "结果里"). */
      metadata?: Record<string, unknown>;
    }
  | {
      /** The agent needs the caller to say more (A-5): the task waits on the caller. */
      state: "input-required";
      question: string;
      metadata?: Record<string, unknown>;
    }
  | { state: "rejected"; reason: TaskReason; message: string }
  | { state: "failed"; reason?: TaskReason; message: string };

export interface A2AExecutor {
  run(job: A2AJob): Promise<A2AOutcome>;
  /**
   * P4-05 (a2a-usage.md §8.1 名片里, §13): what the agent card's act
   * extension declares — `params.act` (办 accepted now), `params.readOnly`
   * (how strongly a 问 is read-only: `weak` adds §13's sentence to the
   * card's description; `none`: no 问). Absent: the card declares no params.
   */
  describe?(agent: AgentInfo): { act: boolean; readOnly: "strong" | "weak" | "none" } | null;
}

/** Who runs an agent's tasks (null: not mine). The newest registered is asked first. */
export type ExecutorResolver = (agent: AgentInfo) => A2AExecutor | null;
