/**
 * one declaration of what each agent does natively for the unified
 * provider-neutral semantics, and one fallback. The Runner reports it per
 * agent (node capability `agentFeatures[agent]`, research
 * capability-matrix.md §2 — only the `input` part so far); the control
 * plane routes by semantic, never by agent name: `native` → the adapter's
 * own API, `fallback` → Daisy's queue does it, `none` → not offered. The
 * person sees the same labels either way.
 *
 * | Unified semantic      | Claude Code 2.1.316                          | Codex app-server 0.157.1                              | Kimi (ACP) | Daisy fallback                       |
 * | --------------------- | -------------------------------------------- | ----------------------------------------------------- | ---------- | ------------------------------------ |
 * | input.steer (append)  | stdin user `priority:"next"`; ack =          | `turn/steer {expectedTurnId, clientUserMessageId}`;   | —          | head of Daisy's queue (next turn)    |
 * |                       | command_lifecycle queued/started/completed   | ack = response (received) + `userMessage.clientId`    |            |                                      |
 * |                       | /cancelled; read at the next tool boundary   | (absorbed); read at the next tool boundary            |            |                                      |
 * | input.withdraw        | control `cancel_async_message{message_uuid}` | — (no withdraw of a steer)                            | —          | Daisy-side only, before the Runner   |
 * |                       |                                              |                                                       |            | has it                               |
 * | input.afterTurn       | (`priority:"later"`, not used)               | (`thread/queue/*`, experimental, not used)            | —          | Daisy's queue (pending job)          |
 * | input.jump            | = steer while a turn runs (never interrupts) | = steer while a turn runs (never interrupts)          | —          | queue head; starts now when idle     |
 * | stop                  | control `interrupt` — 「停止」 only            | `turn/interrupt` — 「停止」 only                         | cancel     | —                                    |
 * | approvals.autoReview- | `system/permission_denied` (stable)          | `item/autoApprovalReview/completed` denied / timedOut | —          | —                                    |
 * |   Denials   |                                              | (UNSTABLE, approvalsReviewer auto_review)              |            |                                      |
 * | approvals.approve-    | — (fallback: a wake, the retry goes through  | `thread/approveGuardianDeniedAction {threadId, event}` | —          | owner-approval wake: retry once      |
 * |   Denied    | auto mode again)                             | (UNSTABLE; then the same wake)                         |            |                                      |
 * | background.list       | `system/background_tasks_changed`            | `thread/backgroundTerminals/list` (experimental,       | —          | Daisy's own bash / monitor / timers  |
 * |             |                                              | polled; no change notification)                        |            | (session.schedulerPending)           |
 * | background.stop       | control `stop_task{task_id}`                 | `thread/backgroundTerminals/terminate` + sandbox reap  | —          | Daisy scheduler cancel               |
 *
 * `settings` (model / effort / permission mode from the next turn,
 * the process kept): Claude `set_model`, `apply_flag_settings{effortLevel}`,
 * `set_permission_mode`; Codex `turn/start {model, effort, approvalPolicy,
 * approvalsReviewer}` ("this turn and subsequent turns"); Kimi: restart.
 * | askOnly (只问) | control `side_question{question, history}`   | — ; `thread/fork {ephemeral, sandbox:"read-only",       | —          | forked read-only sidecar             |
 * |                       | on the live main process (no tools, never    | approvalPolicy:"never", model}` per question, the     |            | (persisted, one per conversation);   |
 * |                       | interrupts, not in its history)              | main's effective model / effort                       |            | an ordinary @                        |
 * | rewind (回退)  | control `rewind_conversation` (same session) | `thread/revert {beforeTurnId}` (history only)         | `/undo N`  | Claude offline: `forkSession` copy;  |
 * |                       | + `rewind_files` (dry run first) while live  |                                                       |            | files: none (「文件未回退」)          |
 * | rewind.files | `rewind_files` (native, live only)          | — no file checkpoints: Daisy's own per-turn            | —          | file-checkpoints.ts: pre/post-turn   |
 * |                       |                                              | snapshots + `fileChange` paths (`fallback`)            |            | snapshot, conflicts refused          |
 * | title.generate        | control `generate_session_title              | — (no auto title; every thread `name:null`)           | —          | title.ts: one tool-less headless CLI |
 * |             | {description, persist:true}` on the live     |                                                       |            | call (Claude offline / Codex)        |
 * |                       | process (native ai-title, no extra process)  |                                                       |            |                                      |
 * | title.sync            | out: `rename_session {source:"host"}`;       | out: `thread/name/set {threadId, name}`;              | —          | —                                    |
 * |             | in: `system/session_title_changed` (startup  | in: thread/start|resume `thread.name`,                |            |                                      |
 * |                       | + every rename, not the ai-title)            | `thread/name/updated {threadName}`                    |            |                                      |
 * | modelSwitch | `system/model_fallback` (turn) +             | `model/rerouted {fromModel, toModel, reason}`         | —          | — (not knowable)                     |
 * |                       | `system/model_refusal_fallback` (session)    | (stable; per turn)                                    |            |                                      |
 *
 * Decided not to use (no benefit to the person): Codex
 * `thread/inject_items` for carried reports / summaries (they already ride
 * the next turn on both engines; injected items are invisible in the
 * thread's history) — the layered prompt does use it for one other thing, see
 * `PROMPT_REFRESH_SINCE` below: a changed system-layer text added to a
 * resumed / forked thread as a developer message (rules, not material to
 * deliver; once per thread and text; only at resume, never mid-turn) —
 * Codex `thread/queue/*` / Claude `priority:"later"`
 * (Daisy's queue is the truth; saves < 1 s a turn), Codex
 * `thread/status/changed` for the watchdog (sent in the same millisecond as
 * `turn/completed`: lost together).
 */

import type { AgentStopCapabilities } from "./agent-stop.ts";
import { ACP_AGENTS, ACP_HARNESSES } from "./acp-harnesses.ts";

export type Support = "native" | "fallback" | "none";
/**
 * ADR-152: Daisy's own fallback was written `"harbor"` until
 * it was renamed `"fallback"` (no product name in the contract). Reports
 * from an older Runner and node rows stored before still say `"harbor"`:
 * every reader takes it as `"fallback"`, writers only write `"fallback"`.
 */
export const LEGACY_FALLBACK = "harbor";
/** `"fallback"`, or its old spelling. */
export const isFallback = (x: unknown): boolean =>
  x === "fallback" || x === LEGACY_FALLBACK;
/** The old spelling as the new one; anything else unchanged. */
export const normalizeSupport = <T>(x: T): T | "fallback" =>
  x === LEGACY_FALLBACK ? "fallback" : x;
/**
 * The keys of a capability report that hold a `Support` value (`Cap.support`,
 * askOnly.fork, rewind.history / files, title.generate, stop.subagents /
 * commands; every value of `features`). Other strings (an ACP harness id,
 * a mode, a `via`) are never touched.
 */
const SUPPORT_KEYS = new Set([
  "support",
  "fork",
  "history",
  "files",
  "generate",
  "subagents",
  "commands",
]);
/**
 * ADR-152: one agent's report (`agentFeatures[agent]` / `agentStop[agent]`)
 * with every old `"harbor"` support value read as `"fallback"`. Returns the
 * same object when there is none (copy on write).
 */
export function normalizeCapabilityValues<T>(x: T, inFeatures = false, depth = 0): T {
  if (!x || typeof x !== "object" || Array.isArray(x) || depth > 6) return x;
  let out: any = null;
  for (const [k, v] of Object.entries(x as any)) {
    const n =
      v === LEGACY_FALLBACK && (inFeatures || SUPPORT_KEYS.has(k))
        ? "fallback"
        : normalizeCapabilityValues(v, k === "features", depth + 1);
    if (n !== v) (out ??= { ...(x as any) })[k] = n;
  }
  return out ?? x;
}
/**
 * ADR-152: a node's whole capability report with old values read as new
 * (`agentFeatures`, `agentStop` per agent). The control plane stores and
 * serves only this form.
 */
export function normalizeNodeCapabilities<T>(caps: T): T {
  if (!caps || typeof caps !== "object") return caps;
  const c = caps as any;
  const per = (m: any) => {
    if (!m || typeof m !== "object") return m;
    let out: any = null;
    for (const [a, r] of Object.entries(m)) {
      const n = normalizeCapabilityValues(r);
      if (n !== r) (out ??= { ...m })[a] = n;
    }
    return out ?? m;
  };
  const features = per(c.agentFeatures),
    stop = per(c.agentStop);
  return features === c.agentFeatures && stop === c.agentStop
    ? caps
    : ({ ...c, agentFeatures: features, agentStop: stop } as T);
}
/** `agent`'s report on a node, old values read as new (null-ish: none). */
const reportOf = (capabilities: any, agent: string) =>
  normalizeCapabilityValues(capabilities?.agentFeatures?.[agent]) as
    | AgentCapabilities
    | undefined;
export interface Cap<Opts = {}> {
  support: Support;
  stability?: "stable" | "experimental" | "unstable";
  /** The native API, for audit / debugging. */
  via?: string;
  opts?: Opts;
}
export type InputAck = "received" | "absorbed" | "completed" | "cancelled";

export interface AgentInputCapabilities {
  /**
   * A Daisy job into the running turn at its next boundary, never
   * interrupting it (「插队发送」 while live, Daisy wakes).
   */
  steer: Cap<{
    ack: InputAck[];
    boundary: "tool";
    /** Image attachments go in as image content (other files: paths). */
    images: boolean;
    /** Slash commands are taken in (Claude: no — a turn of their own). */
    slashCommands: boolean;
    /** Codex: a steer ends a collab `wait` (it re-waits). */
    interruptsWait?: boolean;
  }>;
  /** An appended item the agent has not read yet can be taken back. */
  withdraw: Cap;
  /** Runs after the current turn. */
  afterTurn: Cap<{ coalesces?: boolean }>;
  /** 「插队发送」: what it does while a turn runs. */
  jump: Cap<{ interrupts: false }>;
}
/**
 * how a changed setting reaches an online process. `native`: the
 * adapter applies it before the next turn, the process (its background
 * tasks, subagents) kept; `restart`: part of the live key, the next message
 * restarts the process and resumes the conversation. A change that turns
 * bypass on or off always restarts, whatever this says.
 */
export type SettingApply = "native" | "restart";
export interface AgentSettingsCapabilities {
  model: SettingApply;
  effort: SettingApply;
  /** Codex: approval policy / reviewer; its sandbox mode always restarts. */
  permissionMode: SettingApply;
}
/**
 * what the agent's own automatic review refused. `autoReviewDenials`
 * native = the adapter reports each refusal as an interception item (the
 * owner's 拦截卡); none = refusals are not seen. `approveDenied` = what
 * 「允许并重试」 does besides Daisy's retry wake: native = the agent is
 * also told natively that the owner approved that exact action (Codex
 * injects it into the thread, its reviewer reads it); fallback = the wake only.
 */
export interface AgentApprovalCapabilities {
  autoReviewDenials: Cap;
  approveDenied: Cap;
}
/**
 * the session's background tasks the agent itself runs (Daisy's
 * own scheduler items are always listed and cancelled by Daisy). `list`
 * native = the adapter reports them in `live.pending`; `stop` native = one
 * can be stopped alone (「停止」 on the item).
 */
export interface AgentBackgroundCapabilities {
  list: Cap;
  stop: Cap;
}
/**
 * 「只问」: how a question is answered from the main session's
 * context without waking it. `sideQuestion` native: the live main
 * process answers from memory (Claude `side_question`); when it is
 * offline, or the answer says files are needed, `fork` does it —
 * `native`: a throwaway fork per question (Codex `thread/fork
 * ephemeral`), `fallback`: Daisy's persisted read-only sidecar, `none`:
 * an ordinary @ (Kimi).
 */
export interface AgentAskOnlyCapabilities {
  sideQuestion: "native" | "none";
  fork: Support;
  /** The native side question's own deadline (Claude Code: 660 s). */
  deadlineMs?: number;
}
/**
 * 「回退」: `history` native = the agent rewinds its own
 * conversation in place (same native id); `fallback` = Daisy copies it up
 * to the cut (Claude `--fork-session`, offline). `files` native = the
 * agent restores the files its own edit tools changed after the cut
 * (Claude `rewind_files`, live process only); `fallback` = Daisy's
 * own per-turn checkpoints restore the files the agent's edit tool
 * changed (Codex `fileChange`; offline too; a file changed after the AI's
 * edit refuses the rewind); `none` = 「文件未回退」.
 */
export interface AgentRewindCapabilities {
  history: Support;
  files: Support;
  /** `files` / in-place history need the session's process online. */
  liveOnly?: boolean;
}
/**
 * Session title (one AI title after round 2, the owner's rename
 * always wins, kept in sync with the native session). `generate` native =
 * the live process names the conversation itself (Claude Code
 * `generate_session_title`, also recorded as the native ai-title); fallback
 * = Daisy's own one-shot CLI call (title.ts); none = never named by AI.
 * `sync` native = Daisy's title goes to the native session and a rename
 * there comes back as the owner's; none = Daisy only.
 */
export interface AgentTitleCapabilities {
  generate: "native" | "fallback" | "none";
  sync: "native" | "none";
}
/**
 * P4-11 (plan §5.5 「统一的能力清单」, acceptance C-3): every capability of
 * the list, by one key each. The required four every adapter must do; the
 * optional ones an adapter declares (`features` below, or the measured
 * blocks above for what they already express) and the control
 * plane, the UI and the command line offer only what is declared — Daisy
 * never imitates a capability the harness lacks. `featuresFor`
 * (agent-features.ts) flattens a report into one map.
 *
 * | key            | §5.5 row              | what it gates                                         |
 * | -------------- | --------------------- | ----------------------------------------------------- |
 * | session        | 开会话与恢复 (必备)    | —                                                     |
 * | stream         | 发消息并流式返回 (必备)| —                                                     |
 * | cancel         | 取消 (必备)            | —                                                     |
 * | approvals      | 工具授权与提问 (必备)  | —                                                     |
 * | steer          | 运行中追加             | 「立即追加」, 合并追加, `session steer`                |
 * | withdraw       | 运行中追加             | taking back an appended item not read yet             |
 * | rewind         | 回退                   | /rewind, edit-and-resend                              |
 * | rewindFiles    | 回退（连文件改动）     | 「同时撤销文件」, rewind `files: true`                 |
 * | fork           | 分叉与压缩             | /fork                                                 |
 * | compact        | 分叉与压缩             | /compact                                              |
 * | model          | 切模型与推理强度       | /model, the model chip, a session's model             |
 * | effort         | 切模型与推理强度       | a session's reasoning effort                          |
 * | permissionMode | 权限模式               | /permissions                                          |
 * | readOnly       | 权限模式（只读档）     | 5.7 「问」 needs it                                    |
 * | askOnly        | 旁问或分叉             | 5.7 「问」 off the main line                           |
 * | usage          | 用量与额度             | context usage                                         |
 * | quota          | 用量与额度             | plan quota                                            |
 * | background     | 后台任务与终端窗口     | the agent's own background tasks                      |
 * | terminal       | 后台任务与终端窗口     | /terminal (the official CLI's full window)            |
 *
 * Values: `native` = the harness does it; `fallback` = Daisy does it with
 * the harness's own means (restart-and-resume for a setting, Daisy's
 * per-turn file checkpoints, the read-only sidecar, plain-text steer by
 * the adapter); `none` = not offered.
 */
export const REQUIRED_FEATURES = [
  "session",
  "stream",
  "cancel",
  "approvals",
] as const;
export const OPTIONAL_FEATURES = [
  "steer",
  "withdraw",
  "rewind",
  "rewindFiles",
  "fork",
  "compact",
  "model",
  "effort",
  "permissionMode",
  "readOnly",
  "askOnly",
  "usage",
  "quota",
  "background",
  "terminal",
] as const;
export type RequiredFeature = (typeof REQUIRED_FEATURES)[number];
export type OptionalFeature = (typeof OPTIONAL_FEATURES)[number];
export type AgentFeature = RequiredFeature | OptionalFeature;
/** A harness's own §5.5 declaration (absent keys: derived, else `none`). */
export type FeatureDeclaration = Partial<Record<AgentFeature, Support>>;
/**
 * 5.7 / D-28: the permission mode that counts as read-only — `strong` =
 * tools or sandbox refuse writes; `weak` = only a mode (plan), not a
 * guarantee (say 「弱只读」 on the card).
 */
export type ReadOnlyCap = Cap<{ strength: "strong" | "weak"; mode?: string }>;

export interface AgentCapabilities {
  version: 1;
  /**
   * The harness: one of the native three, or (P4-10) the id of a generic
   * ACP harness's config entry — `declareCapabilities` builds its report.
   */
  agent: "claude" | "codex" | "kimi" | (string & {});
  input: AgentInputCapabilities;
  /** what 「停止」 stops (contracts agent-stop.ts). */
  stop?: AgentStopCapabilities;
  /** which settings apply without a restart. */
  settings?: AgentSettingsCapabilities;
  /** Absent: an older Runner — no native refusals / stops. */
  approvals?: AgentApprovalCapabilities;
  background?: AgentBackgroundCapabilities;
  /** 「只问」. */
  askOnly?: AgentAskOnlyCapabilities;
  /** 「回退」. */
  rewind?: AgentRewindCapabilities;
  /** session title (absent: an older Runner — Daisy's CLI call). */
  title?: AgentTitleCapabilities;
  /**
   * the agent says when it answered with another model than the
   * session's (a trace step 「本轮换了模型」); none = it cannot be known.
   */
  modelSwitch?: Cap;
  /**
   * Follow-up 2026-11-09: the CLI's `--version` text these features were
   * computed from (the Runner reads it at start), so a 「CLI 版本」 reason
   * can name what was detected. Absent: an older Runner / not readable.
   */
  cliVersion?: string;
  /**
   * P4-11: the §5.5 items the blocks above do not express (session, fork,
   * compact, usage, quota, terminal, steer's fallback …); absent in a
   * report from an older Runner — this release's table is used then.
   */
  features?: FeatureDeclaration;
  /** P4-11 / 5.7: the read-only permission mode (absent: none). */
  readOnly?: ReadOnlyCap;
}

const fallback: Cap = { support: "fallback" };
/** P4-11: the four §5.5 calls every adapter must make. */
const REQUIRED: FeatureDeclaration = {
  session: "native",
  stream: "native",
  cancel: "native",
  approvals: "native",
};
/** What each adapter of this release implements (the Runner reports it). */
export const AGENT_CAPABILITIES: Record<string, AgentCapabilities> = {
  claude: {
    version: 1,
    agent: "claude",
    input: {
      steer: {
        support: "native",
        stability: "stable",
        via: 'stdin user priority:"next" + command_lifecycle',
        opts: {
          ack: ["received", "absorbed", "completed", "cancelled"],
          boundary: "tool",
          images: true,
          slashCommands: false,
        },
      },
      withdraw: {
        support: "native",
        stability: "stable",
        via: "control cancel_async_message",
      },
      afterTurn: fallback,
      jump: { support: "native", via: "steer", opts: { interrupts: false } },
    },
    settings: { model: "native", effort: "native", permissionMode: "native" },
    approvals: {
      autoReviewDenials: {
        support: "native",
        stability: "stable",
        via: "system/permission_denied",
      },
      approveDenied: fallback,
    },
    background: {
      list: {
        support: "native",
        stability: "stable",
        via: "system/background_tasks_changed",
      },
      stop: {
        support: "native",
        stability: "stable",
        via: "control stop_task",
      },
    },
    askOnly: { sideQuestion: "native", fork: "fallback", deadlineMs: 660_000 },
    rewind: { history: "native", files: "native", liveOnly: true },
    title: { generate: "native", sync: "native" },
    // P4-11 (§5.5): `steer` fallback = below the measured CLI version the
    // adapter still takes her plain text into the turn.
    features: {
      ...REQUIRED,
      steer: "fallback",
      fork: "native", // --resume … --fork-session
      compact: "native", // /compact in the live process
      usage: "native", // get_context_usage
      quota: "native", // get_usage (subscription)
      terminal: "native",
    },
    readOnly: {
      support: "native",
      via: "--restricted --tools Read,Grep,Glob + --permission-mode dontAsk",
      opts: { strength: "strong" },
    },
    modelSwitch: {
      support: "native",
      // @internal / "not yet in the public SDKMessage union".
      stability: "unstable",
      via: "system/model_fallback + system/model_refusal_fallback",
    },
  },
  codex: {
    version: 1,
    agent: "codex",
    input: {
      steer: {
        support: "native",
        stability: "stable",
        via: "turn/steer + userMessage.clientId",
        opts: {
          ack: ["received", "absorbed"],
          boundary: "tool",
          images: true,
          slashCommands: false,
          interruptsWait: true,
        },
      },
      withdraw: { support: "none" },
      afterTurn: fallback,
      jump: { support: "native", via: "steer", opts: { interrupts: false } },
    },
    settings: { model: "native", effort: "native", permissionMode: "native" },
    approvals: {
      autoReviewDenials: {
        support: "native",
        stability: "unstable",
        via: "item/autoApprovalReview/completed",
      },
      approveDenied: {
        support: "native",
        stability: "unstable",
        via: "thread/approveGuardianDeniedAction",
      },
    },
    background: {
      list: {
        support: "native",
        stability: "experimental",
        via: "thread/backgroundTerminals/list",
      },
      stop: {
        support: "native",
        stability: "experimental",
        via: "thread/backgroundTerminals/terminate",
      },
    },
    askOnly: { sideQuestion: "none", fork: "native" },
    // thread/revert rewinds the history; Daisy the files.
    rewind: { history: "native", files: "fallback" },
    title: { generate: "fallback", sync: "native" },
    features: {
      ...REQUIRED,
      steer: "fallback",
      fork: "native", // thread/fork
      compact: "native", // thread/compact/start
      usage: "native", // thread token usage
      quota: "native", // account rate limits (ChatGPT sign-in)
      terminal: "native",
    },
    readOnly: {
      support: "native",
      via: 'sandbox "read-only" + approvalPolicy "never"',
      opts: { strength: "strong" },
    },
    modelSwitch: {
      support: "native",
      stability: "stable",
      via: "model/rerouted",
    },
  },
  // P4-10: every ACP harness declares its own (acp-harnesses.ts; Kimi:
  // no way into a running turn — Daisy's queue; ACP cannot go back to "the
  // default" live, review r1 #7; `/undo N` for 回退; no headless mode to
  // name with). P4-11's §5.5 `features` and `readOnly` (D-28: an ACP
  // mode is 「弱只读」) come from the same entry.
  ...Object.fromEntries(
    ACP_AGENTS.map((a) => {
      const h = ACP_HARNESSES[a]!;
      const c: AgentCapabilities = {
        version: 1,
        agent: a,
        ...h.capabilities,
        features: { ...REQUIRED, ...h.features },
        readOnly: h.modes.readOnly
          ? {
              support: "native",
              via: `ACP mode ${h.modes.readOnly}`,
              opts: {
                strength: h.modes.readOnlyStrength === "weak" ? "weak" : "strong",
                mode: h.modes.readOnly,
              },
            }
          : { support: "none" },
      };
      return [a, c];
    }),
  ),
};
/**
 * below the measured CLI version (or unknown), what Daisy did
 * before — Claude's model live (`set_model`, long-standing), Codex's effort
 * per turn; the rest restarts.
 */
const RESTART_ALL: AgentSettingsCapabilities = {
  model: "restart",
  effort: "restart",
  permissionMode: "restart",
};
export const LEGACY_SETTINGS: Record<string, AgentSettingsCapabilities> = {
  claude: { model: "native", effort: "restart", permissionMode: "restart" },
  codex: { model: "restart", effort: "native", permissionMode: "restart" },
  // P4-10: every ACP harness restarts (as Kimi did).
  ...Object.fromEntries(ACP_AGENTS.map((a) => [a, RESTART_ALL])),
};

/**
 * The CLI versions the native input semantics were measured on (review
 * L1): Claude Code 2.1.316 (command_lifecycle on stdin, `priority`,
 * `cancel_async_message`), Codex 0.157 (`turn/steer` echoing
 * `clientUserMessageId` as the userMessage `clientId`). Older, or a
 * version Daisy cannot read: Daisy's queue does it.
 */
export const NATIVE_INPUT_SINCE: Record<string, [number, number, number]> = {
  claude: [2, 1, 316],
  codex: [0, 157, 0],
};
const parts = (v: string | undefined) => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
/**
 * What `agent` at CLI `version` does natively: this release's declaration,
 * with `steer` / `withdraw` / `jump` falling back to Daisy below the
 * measured version (the adapter would still send them, but the CLI's
 * answers — lifecycle, clientId — are not known to come).
 */
/**
 * the CLI versions auto-review refusals / background stops were
 * measured on (Codex 0.157.1: item/autoApprovalReview/*,
 * approveGuardianDeniedAction, backgroundTerminals/*; Claude Code 2.1.316:
 * stop_task). Older or unreadable: none / Daisy's own only.
 */
export const NATIVE_REVIEW_SINCE: Record<string, [number, number, number]> = {
  claude: [2, 1, 316],
  codex: [0, 157, 1],
};
const atLeast = (v: number[] | null, since: [number, number, number]) =>
  !!v &&
  (v[0] !== since[0]
    ? v[0] > since[0]
    : v[1] !== since[1]
      ? v[1] > since[1]
      : v[2] >= since[2]);
export function capabilitiesFor(
  agent: string,
  version: string | undefined,
): AgentCapabilities {
  const base = gateReview(
    agent,
    version,
    AGENT_CAPABILITIES[agent] ?? AGENT_CAPABILITIES.kimi!,
  );
  const since = NATIVE_INPUT_SINCE[agent],
    v = parts(version);
  if (!since) return base;
  // Live settings measured on Claude Code 2.1.316 (apply_flag_settings effortLevel,
  // set_permission_mode) and Codex 0.157.1 (turn/start overrides): the same
  // versions as the input semantics.
  if (atLeast(v, since)) return base;
  return {
    ...base,
    settings: LEGACY_SETTINGS[agent],
    // side_question / rewind_conversation / ephemeral forks were
    // measured on the same versions; below them the persisted sidecar / the offline copy hold.
    ...(base.askOnly
      ? {
          askOnly: {
            sideQuestion: "none" as const,
            fork: agent === "codex" ? ("fallback" as const) : base.askOnly.fork,
          },
        }
      : {}),
    // generate_session_title / thread/name/* measured on the same
    // versions; below them Daisy names it, and only Claude's long-standing
    // rename_session goes out.
    ...(base.title
      ? {
          title: {
            generate:
              base.title.generate === "none"
                ? ("none" as const)
                : ("fallback" as const),
            sync: agent === "claude" ? base.title.sync : ("none" as const),
          },
        }
      : {}),
    ...(base.rewind
      ? {
          rewind: {
            history:
              agent === "claude" ? ("fallback" as const) : base.rewind.history,
            files: "none" as const,
          },
        }
      : {}),
    input: {
      ...base.input,
      steer: fallback as AgentInputCapabilities["steer"],
      withdraw: { support: "none" },
      jump: { support: "fallback", opts: { interrupts: false } },
    },
  };
}

/**
 * the CLI versions on which a changed system-layer text was
 * measured to reach an existing conversation (docs/prompt-layers-stage0):
 * Codex 0.157.1 `thread/inject_items` (a developer message after resume /
 * fork — used by default); Claude Code 2.1.322
 * `--system-prompt-snapshot off` (rendered afresh at every request — an
 * experiment only, off unless an admin names the session: its cost on
 * long sessions is unmeasured; by default a Claude conversation takes a
 * new text at its next compaction). Older or unreadable: only a new
 * conversation or a compaction brings the new text.
 */
export const PROMPT_REFRESH_SINCE: Record<string, [number, number, number]> = {
  claude: [2, 1, 322],
  codex: [0, 157, 1],
};
export function promptRefreshAt(agent: string, version: string | undefined) {
  const since = PROMPT_REFRESH_SINCE[agent];
  return !!since && atLeast(parts(version), since);
}
/**
 * `agent` at CLI `version` (any text holding x.y.z) is at least
 * the version the review / background APIs were measured on.
 */
export function nativeReviewAt(agent: string, version: string | undefined) {
  const since = NATIVE_REVIEW_SINCE[agent];
  return !!since && atLeast(parts(version), since);
}
/** below the measured version the UNSTABLE / experimental APIs are not used. */
function gateReview(
  agent: string,
  version: string | undefined,
  base: AgentCapabilities,
): AgentCapabilities {
  const since = NATIVE_REVIEW_SINCE[agent];
  if (!since || atLeast(parts(version), since)) return base;
  return {
    ...base,
    approvals: {
      // Claude's permission_denied predates this; Codex's notification not.
      autoReviewDenials:
        agent === "claude"
          ? base.approvals!.autoReviewDenials
          : { support: "none" },
      approveDenied: fallback,
    },
    background: {
      list: agent === "claude" ? base.background!.list : fallback,
      stop: fallback,
    },
    // measured on Claude Code 2.1.316 / Codex 0.157.1 (schema).
    ...(base.modelSwitch ? { modelSwitch: { support: "none" as const } } : {}),
  };
}

/** What the control plane routes by (flattened from a node's report). */
export interface InputRoute {
  /** A Daisy job can go into the running turn natively. */
  append: boolean;
  /** …with images as image content. */
  images: boolean;
  /** An appended job not read yet can be withdrawn (「移除」). */
  withdraw: boolean;
}
/**
 * The input routes of `agent` on a node, from that node's reported
 * capabilities (null: an older Runner — Daisy's queue does everything).
 */
export function inputRoute(
  capabilities: any,
  agent: string,
): InputRoute | null {
  const c = reportOf(capabilities, agent);
  if (!c || !(c.version >= 1) || !c.input) return null;
  const steer = c.input.steer;
  return {
    append: steer?.support === "native",
    images: steer?.support === "native" && !!steer.opts?.images,
    withdraw: c.input.withdraw?.support === "native",
  };
}

/**
 * how `agent`'s settings reach an online process on this Runner,
 * from its own report (`agentFeatures`, by CLI version); unknown → the
 * legacy behaviour.
 */
export function settingsRoute(
  features: any,
  agent: string,
): AgentSettingsCapabilities {
  const s = features?.[agent]?.settings;
  const legacy = LEGACY_SETTINGS[agent] ?? RESTART_ALL;
  if (!s || typeof s !== "object") return legacy;
  const one = (k: keyof AgentSettingsCapabilities): SettingApply =>
    s[k] === "native" ? "native" : "restart";
  return {
    model: one("model"),
    effort: one("effort"),
    permissionMode: one("permissionMode"),
  };
}
/** how 「只问」 is answered by `agent` on a node (null: an older Runner — Daisy's persisted fork). */
export function askOnlyRoute(
  capabilities: any,
  agent: string,
): AgentAskOnlyCapabilities | null {
  const c = reportOf(capabilities, agent);
  return c && c.version >= 1 && c.askOnly ? c.askOnly : null;
}
/**
 * whether 「同时撤销文件」 is offered for `agent` on a node, from
 * its report; an older Runner (no `rewind`): Claude Code only.
 */
export function rewindFilesRoute(capabilities: any, agent: string): Support {
  const f = rewindRoute(capabilities, agent)?.files;
  return f === "native" || f === "fallback" || f === "none"
    ? f
    : agent === "claude"
      ? "native"
      : "none";
}
/** what 「回退」 can do for `agent` on a node (null: an older Runner — an offline copy, Claude Code only). */
export function rewindRoute(
  capabilities: any,
  agent: string,
): AgentRewindCapabilities | null {
  const c = reportOf(capabilities, agent);
  return c && c.version >= 1 && c.rewind ? c.rewind : null;
}

/**
 * how `agent`'s session titles are made and synced on a node, from
 * its report; null: an older Runner (Daisy's CLI call, as before).
 */
export function titleRoute(
  capabilities: any,
  agent: string,
): AgentTitleCapabilities | null {
  const c = reportOf(capabilities, agent);
  return c && c.version >= 1 && c.title ? c.title : null;
}

/** The bubble / queue label of an appended item not read yet. */
// P6-23b: the appended row's label is the server's (server-sessions.append.label.*).

/** what the control plane routes refusals and background stops by. */
export interface ReviewRoute {
  /** 「允许并重试」 also approves natively (then Daisy's wake). */
  approveDenied: boolean;
  /** The agent's own background tasks can be stopped one by one. */
  stopTask: boolean;
}
/** Null: an older Runner (wake only; only Daisy's items can be stopped). */
export function reviewRoute(
  capabilities: any,
  agent: string,
): ReviewRoute | null {
  const c = reportOf(capabilities, agent);
  if (!c || !(c.version >= 1) || (!c.approvals && !c.background)) return null;
  return {
    approveDenied: c.approvals?.approveDenied?.support === "native",
    stopTask: c.background?.stop?.support === "native",
  };
}
