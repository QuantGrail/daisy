import { turnT } from "./model-switch.ts";
import { daisyEnv } from "../../../contracts/src/env.ts";
import { resolveSpawn } from "../platform/spawn.ts";
import { readOnlyLaunch } from "../platform/read-only.ts";
import {
  claudeSidecarArgs,
  isSidecar,
  sidecarDenyRules,
  sidecarGuide,
  sidecarLaunch,
} from "../turns/sidecar.ts";
import { askSideQuestion, rewindInPlace } from "./claude-native.ts";
import { claudeModelSwitch, modelSwitchItem } from "./model-switch.ts";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JsonProcess } from "../turns/transport.ts";
import {
  claudeAllowed,
  freshLaunch,
  jobToolNames,
  launchGuide,
  layeredGuide,
  toolsFor,
} from "../tools/daisy-tools.ts";
import {
  DAISY_TOOLSET_VERSION,
  toolServer,
} from "../../../contracts/src/native-tools.ts";
import { launchAudit } from "../observe/launch-audit.ts";
import { log } from "../observe/log.ts";
import {
  authLogLine,
  checkClaudeAuth,
  claudeAuthMessage,
  probeOf,
} from "./claude-auth.ts";
import type {
  ContextThreshold,
  LiveActivity,
  LiveTimer,
  RunnerJob,
} from "../../../contracts/src/index.ts";
import {
  isDaisyForkTitle,
  nativeTitle,
} from "../../../contracts/src/title.ts";
import {
  fetchGlmQuota,
  fromClaudeUsage,
  fromRateLimit,
  isGlm,
  markAsked,
  quotaOf,
  staticQuota,
  usageDue,
} from "../turns/quota.ts";
import {
  Items,
  ContextMeter,
  agentEnv,
  asText,
  stage,
  quotaItem,
  requestedAutoCompact,
  unknownThreshold,
  warmRuntime,
  compactNotice,
  publishImage,
  trackMedia,
  oneShot,
  liveFeatures,
  liveSettings,
  type LiveAgent,
  type LiveHooks,
  NativeRenames,
  type Runtime,
  type TurnOutcome,
  type NativeInput,
  stoppedEnd,
  textsOf,
} from "./shared.ts";
import { AGENT_CAPABILITIES } from "../../../contracts/src/agent-capabilities.ts";
import { bypassMode } from "../../../contracts/src/approvals.ts";
/**
 * N-6 (C-1 device acceptance, Claude Code 2.1.326): a stopped turn's result
 * carries Claude Code's internal diagnostics (`[ede_diagnostic]
 * result_type=user last_content_type=n/a stop_reason=null`). They go to the
 * log; the conversation says 「本轮已停止」 for a stop, and for another
 * failure what is left (or a plain line naming the result's subtype).
 */
export function claudeResultError(r: any, stopped: boolean): string {
  const raw = asText(r?.errors || r?.result || r?.subtype || "");
  const lines = String(raw).split("\n");
  const diagnostic = (l: string) => /^\s*\[[a-z_]*diagnostic\]/i.test(l);
  const diag = lines.filter(diagnostic);
  if (diag.length)
    log.info(`Claude Code diagnostics (not shown in the conversation): ${diag.join(" | ")}`);
  if (stopped) return turnT()("server-harness.turn.stopped");
  const rest = lines
    .filter((l) => !diagnostic(l))
    .join("\n")
    .trim();
  return rest || turnT()("server-harness.claude.endedAbnormally", { reason: String(r?.subtype || turnT()("server-harness.claude.unknownReason")) });
}

/** the unified semantics this adapter does natively (reported). */
export const CLAUDE_CAPABILITIES = AGENT_CAPABILITIES.claude;
/** One Claude turn in a process that ends with it (offline mode, tests). */
export const runClaude = (rt: Runtime) => oneShot(claudeAgent, rt);
/**
 * Claude Code's get_context_usage answer → the real auto-compact trigger
 * point (measured on 2.1.316: `--autocompact 200000` → maxTokens
 * 200000, autoCompactThreshold 167000, autocompactSource "settings").
 * `wanted`: the identity's setting now; `launched`: what this process was
 * started with; `pct`: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is in effect, which
 * moves the real point without the CLI reporting it.
 */
export function claudeThreshold(
  r: any,
  wanted: number | null,
  launched: number | null,
  pct: boolean,
): ContextThreshold {
  if (
    !r ||
    typeof r !== "object" ||
    typeof r.isAutoCompactEnabled !== "boolean"
  )
    return unknownThreshold(wanted, turnT()("server-harness.claude.threshold.notReported"));
  const native =
    typeof r.autocompactSource === "string"
      ? r.autocompactSource.slice(0, 60)
      : undefined;
  const window =
    typeof r.maxTokens === "number" && r.maxTokens > 0
      ? Math.round(r.maxTokens)
      : null;
  const origin: ContextThreshold["origin"] =
    native === "env"
      ? "cli-env"
      : native === "settings"
        ? launched !== null && window === launched
          ? "identity"
          : "cli-settings"
        : native === "model-default" || native === "auto"
          ? "cli-default"
          : "unknown";
  const applied =
    wanted === null
      ? null
      : r.isAutoCompactEnabled && native === "settings" && window === wanted;
  const extra = native ? { native } : {};
  if (!r.isAutoCompactEnabled)
    return {
      tokens: null,
      source: "harness",
      origin,
      enabled: false,
      exact: true,
      window,
      requested: wanted,
      applied: wanted === null ? null : false,
      reason:
        turnT()("server-harness.claude.threshold.off"),
      ...extra,
    };
  const tokens =
    typeof r.autoCompactThreshold === "number" && r.autoCompactThreshold > 0
      ? Math.round(r.autoCompactThreshold)
      : null;
  const reason =
    tokens === null
      ? turnT()("server-harness.claude.threshold.noTrigger")
      : applied === false
        ? wanted !== launched
          ? turnT()("server-harness.threshold.afterIdleRestart")
          : native === "env"
            ? turnT()("server-harness.claude.threshold.envWins")
            : turnT()("server-harness.claude.threshold.mismatch")
        : pct
          ? turnT()("server-harness.claude.threshold.pctOverride")
          : undefined;
  return {
    tokens,
    source: tokens === null ? "unknown" : "harness",
    origin,
    enabled: true,
    exact: !pct,
    window,
    requested: wanted,
    applied,
    ...(reason ? { reason } : {}),
    ...extra,
  };
}
const bin = () => daisyEnv("DAISY_CLAUDE_BIN") || "claude";
/** Harness text for a card: no escape sequences, at most 2000 chars. */
const plain = (v: unknown) => plainTail(String(v ?? ""), 2000);
/** Terminal output as plain text: no escape sequences, at most `max` chars from the end. */
export function plainTail(text: string, max: number) {
  const plain = text
    // eslint-disable-next-line no-control-regex
    .replace(
      /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g,
      "",
    )
    // A carriage return redraws the line (progress bars): keep what is left.
    .replace(/[^\n]*\r(?!\n)/g, "");
  return plain.length > max ? plain.slice(-max) : plain;
}
/** Claude Code 2.1.316's in-process scheduling tools. */
export const CLAUDE_NATIVE_TIMERS = [
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "CronList",
];
/**
 * the native timers live only as long as the process. With Daisy's
 * durable wakeup / cron available — online or offline —
 * they are disallowed so the model has one way to come back; offline without
 * Daisy's tools they are disallowed too (the process ends after the turn,
 * before any timer fires). Online without Daisy's tools they stay. A
 * sidecar gets none: its own --tools list already excludes them.
 * Native background Bash / Monitor are not touched.
 */
export function nativeTimerArgs(o: {
  live: boolean;
  sidecar: boolean;
  daisyTools: boolean;
}): string[] {
  if (o.sidecar || (o.live && !o.daisyTools)) return [];
  return ["--disallowed-tools", CLAUDE_NATIVE_TIMERS.join(",")];
}
/**
 * P4-07 (ADR-126): one `--disallowed-tools` flag holding both the native
 * timers and a resident's Read deny rules.
 */
function disallowedArgs(timers: string[], extra: string): string[] {
  const list = [timers[1] ?? "", extra].filter(Boolean).join(",");
  return list ? ["--disallowed-tools", list] : [];
}
/**
 * P4-07 (ADR-126): a resident's dedicated session never reads the
 * secrets a sidecar may not (other conversations' transcripts live in
 * the identity's config directory — `sidecarDenyRules` covers it).
 */
function residentDenyRules(job: RunnerJob): string {
  return sidecarDenyRules(job as any);
}
/** P4-07: `--tools` (the built-in tools it may use) and `--add-dir` per extra directory. */
export function residentArgs(l: NonNullable<RunnerJob["residentLimits"]>): string[] {
  return [
    ...(l.tools ? ["--tools", l.tools.join(",")] : []),
    ...l.dirs.flatMap((d) => ["--add-dir", d]),
  ];
}
/**
 * Claude Code over stream-json, one process per session. Offline
 * (`live` false) the process serves one turn and ends; online it stays up
 * between turns, so Claude Code's background Bash, Monitor and background
 * subagents (and, only without Daisy's tools, its own ScheduleWakeup /
 * CronCreate timers) keep running and start turns by themselves —
 * those reach Daisy through `hooks.wake`.
 */
export function claudeAgent(
  first: RunnerJob,
  cwd: string,
  hooks: LiveHooks,
  live: boolean,
): LiveAgent {
  // ADR-159 §6: this process's words in its session's language (P6-24 stores it on the session).
  const T = () => turnT(first.session?.lang);
  const since = Date.now();
  /** Daisy's tools (an in-process MCP server) and the resident's guidance. */
  // a 「只问」 sidecar — read-only, no Daisy tools.
  const sidecar = isSidecar(first);
  const daisyTools = toolsFor(first);
  /**
   * ADR-154: the server they are served as — "daisy", or "harbor" for a
   * conversation started with that name (`jobToolNames`). Fixed for the
   * process: Claude Code lists the tools at start.
   */
  const toolNames = jobToolNames(first) ?? "daisy";
  const server = toolServer(toolNames);
  /**
   * what to tell the control plane about this conversation's
   * system layer once Claude announces its session id (`init`): it holds
   * the layered text of this launch (`set` — recorded by a new session,
   * or rendered afresh), or it is back on whatever the engine recorded
   * before (`clear`).
   */
  let guideReport:
    | {
        set: {
          sha256: string;
          staticRules: boolean;
          via: "record" | "fresh";
        };
      }
    | { clear: true }
    | null = null;
  /**
   * …and the layered text this process was launched with, when the engine
   * records its prompt: a compaction makes it the conversation's.
   */
  let processGuide: { sha256: string; staticRules: boolean } | null = null;
  /**
   * ADR-154: a new conversation records which names it got Daisy's tools
   * by (`session.nativeTools.version`), once Claude announces its id: a
   * later resume serves the same ones.
   */
  let toolsReport: number | null = null;
  let p: JsonProcess | null = null,
    starting: Promise<void> | null = null,
    /** initialised — side questions may go to it. */
    ready = false,
    closed = false,
    stopping = false,
    nativeId = first.session.nativeId || randomUUID(),
    /** The model the process runs with now ("" = Claude Code's default). */
    model = first.profile.model || "",
    /** the effort / permission mode the process runs with now. */
    effort = first.profile.reasoningEffort || "",
    mode = first.profile.permissionMode || "manual",
    /** …the effort Claude Code reported after a live change (get_settings). */
    effortShown = "";
  /**
   * Auto-compact: the setting this process starts with
   * (--autocompact), and the identity's value as the latest job carried it.
   */
  const launched = requestedAutoCompact(first);
  let wanted = launched;
  /** The attached turn's runtime; null between turns. */
  let cur: Runtime | null = null,
    lastJob = first.id,
    /** the last `native` report (a session-wide fallback re-sends it). */
    lastNative: Record<string, unknown> | null = null;
  // App → native title, applied through the identity's own running CLI; the
  // session_id guard keeps it off a transcript the CLI has left (/clear).
  // Keys are (nativeId, title): the last one Claude Code took, one still in
  // flight (a turn stopped during it), and the ones it refused, which this
  // process does not ask again.
  let titled = "",
    titling = "";
  const refusedTitles = new Set<string>();
  /**
   * Daisy's title as the latest job carried it — what a native
   * rename is compared with (and reported against, `base`).
   */
  const daisyOf = (job: RunnerJob) => ({
    // Compared as the native side keeps names (review L5).
    title: nativeTitle(job.session.title),
    manual: job.session.titleStage === "manual",
    final: job.session.titleStage === "final",
  });
  /**
   * Daisy's title as the latest job carried it and the native renames
   * reported against it (NativeRenames); the native name as Claude Code
   * last reported it (custom title only).
   */
  const renames = new NativeRenames(
    daisyOf(first),
    hooks.title && ((t, base) => hooks.title!(t, base)),
    () => {
      titled = "";
    },
  );
  let nativeName: string | null = null;
  const items = new Items(
    () => cur || { job: { id: lastJob }, emit: hooks.emit },
  );
  // Process-wide stream bookkeeping (message ids are unique per process).
  let current = "reply";
  const currents = new Map<string, string>();
  const blocks = new Map<string, { id: string; json: string }>();
  /**
   * Content block positions per message id. Stream items are keyed by the
   * content_block_start index; Claude Code then sends one `assistant` event
   * per finished block (content length 1, thinking at index 0), so the final
   * text must be mapped back to that stream index rather than its position
   * in the event's content array - otherwise the same reply appears twice and
   * the thinking item is overwritten.
   */
  const layouts = new Map<
    string,
    { stream: Map<number, { type: string; id?: string }>; used: Set<number> }
  >();
  /**
   * Follow-up 2026-11-09: the items of each assistant
   * message by its transcript uuid — the full ids of its blocks and the
   * prefix of its streamed ones — so a refusal retry's
   * `retracted_message_uuids` can mark them retracted (newest 200 kept).
   */
  const byUuid = new Map<string, { prefix: string; ids: Set<string> }>();
  const layout = (msgId: string) => {
    let l = layouts.get(msgId);
    if (!l) layouts.set(msgId, (l = { stream: new Map(), used: new Set() }));
    return l;
  };
  const blockIndex = (msgId: string, b: any, i: number, count: number) => {
    const l = layout(msgId);
    let index: number | undefined;
    if (count > 1)
      index = i; // complete message: array position = block index
    else {
      // One block per event: the first unused stream block of the same kind
      // (tool_use by id); without partial streaming, the next free position.
      for (const [n, s] of [...l.stream].sort((a, c) => a[0] - c[0]))
        if (
          !l.used.has(n) &&
          s.type === b.type &&
          (b.type !== "tool_use" || s.id === b.id)
        ) {
          index = n;
          break;
        }
      if (index === undefined) {
        index = 0;
        while (l.used.has(index) || l.stream.has(index)) index++;
      }
    }
    l.used.add(index);
    return index;
  };
  /** Background tasks / subagents: state, and the item showing each. */
  const tasks = new Map<string, string>(),
    taskItems = new Map<string, string>(),
    taskLabels = new Map<string, string>();
  /** Claude Code's own list of running background tasks, when it sends one. */
  let background: Map<string, string> | null = null;
  /**
   * What each background task is: type, command / prompt, start;
   * and its latest progress. `commands`: background Bash / Monitor tool
   * calls by tool_use id, so a task_started names its command line.
   */
  const taskInfo = new Map<string, Omit<LiveTimer, "id" | "kind" | "label">>(),
    taskProgress = new Map<string, Omit<LiveActivity, "id">>(),
    commands = new Map<string, string>();
  const taskStarted = (key: string, m: any) => {
    const info = taskInfo.get(key) || { since: Date.now() };
    const command = m.tool_use_id && commands.get(m.tool_use_id);
    taskInfo.set(key, {
      ...info,
      ...(m.task_type ? { type: String(m.task_type).slice(0, 60) } : {}),
      ...(command ? { command } : {}),
      ...(m.subagent_type
        ? { subagent: String(m.subagent_type).slice(0, 100) }
        : {}),
      ...(typeof m.prompt === "string" && m.prompt
        ? { prompt: m.prompt.slice(0, 600) }
        : {}),
    });
  };
  /** ScheduleWakeup / CronCreate timers set in this process. */
  const timers = new Map<string, LiveTimer>();
  const toolUses = new Map<string, { name: string; input: any }>();
  let lastReport: { at: number; text: string } | null = null,
    lastLifecycle = 0;
  // Context fill: every root API call's prompt size; the window
  // comes with the result's modelUsage; the real trigger point from
  // get_context_usage.
  const meter = new ContextMeter(
    items,
    "claude",
    unknownThreshold(launched, T()("server-harness.threshold.noDataYet")),
  );
  /** CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in effect (the CLI does not report it). */
  let pct = launched === null && !!process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
    settingsRead = false,
    /** claude auth status: the subscription's plan name. */
    plan: string | null = null,
    refreshing: Promise<void> | null = null,
    again = false;
  /**
   * Ask Claude Code where it compacts (local, no API call): after start,
   * every root result, compaction and model switch. One at a time; a call
   * while one is out runs once more after it.
   */
  const refresh = (): Promise<void> => {
    if (refreshing) {
      again = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        again = false;
        if (!p || closed) return;
        if (!settingsRead) {
          settingsRead = true;
          try {
            const r = await p.control({ subtype: "get_settings" }, 5000);
            if (r?.effective?.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) pct = true;
          } catch {
            // Older CLI: only the process environment is known.
          }
        }
        let r: any = null;
        try {
          r = await p.control(
            { subtype: "get_context_usage", detail: "summary" },
            5000,
          );
        } catch {
          r = null;
        }
        if (closed) return;
        meter.threshold = claudeThreshold(r, wanted, launched, pct);
        if (typeof r?.totalTokens === "number" && r.totalTokens >= 0)
          meter.used = r.totalTokens;
        meter.emit();
      } while (again);
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };
  /**
   * Plan quota at most every 5 min per identity: a subscription asks the
   * CLI (get_usage), a GLM Coding Plan identity its provider's quota
   * endpoint with its own key.
   */
  const usage = async () => {
    const pid = first.profile.id;
    if (!p || closed) return;
    if (first.profile.authMode === "apiKey" && isGlm(first)) {
      if (!usageDue(pid)) return;
      markAsked(pid);
      const snap = await fetchGlmQuota(first);
      if (!closed) quotaItem(items, snap, first.profile.label);
      return;
    }
    if (first.profile.authMode !== "subscription") return;
    if (!usageDue(pid)) return;
    markAsked(pid);
    try {
      const r = await p.control(
        { subtype: "get_usage", skip_behaviors: true },
        15000,
      );
      const snap = fromClaudeUsage(pid, r);
      if (snap && !closed) quotaItem(items, snap, first.profile.label);
    } catch {
      // Experimental, may go away: rate_limit_event keeps filling in.
    }
  };
  const acknowledgements = new Map<string, () => void>();
  /**
   * a steer of this turn. `sent` = no word yet; `unacked` = no
   * word within the acknowledgement time (does not hold the job; a late
   * `queued` / replay / `started` reclaims it, only the turn's end decides);
   * `replayed` = an older CLI's replay without lifecycle (done);
   * `delegated` = left to Claude Code (it runs it itself next);
   * `requeued` = handed back as the next turn; `dropped` = cancelled after
   * it had started (not sent again).
   */
  type Steer = {
    state:
      | "sent"
      | "unacked"
      | "queued"
      | "started"
      | "completed"
      | "replayed"
      | "delegated"
      | "requeued"
      | "dropped"
      | "withdrawn";
    /** Claude Code reported a command_lifecycle for it. */
    lifecycle: boolean;
    /** Claude Code said it is idle while this was still only queued. */
    idle?: boolean;
    requeue: (reason: string) => void;
    withdraw?: () => void;
    /**
     * a Daisy job delivered into Claude Code's own input queue
     * (`priority: "next"`): reported as Claude reads / finishes it.
     */
    native?: NativeInput;
    /** 「移除」 asked Claude for it back (`cancel_async_message`). */
    withdrawing?: boolean;
    /** Asked back, Claude said it had taken it already (review L2 / L3). */
    taken?: boolean;
    /** A plain steer read by the model (once; see InputHandler `read`). */
    read?: () => void;
  };
  /** The model has this steer now: a plain one says so once. */
  const readSteer = (st: Steer) => {
    const r = st.read;
    st.read = undefined;
    if (!st.native) r?.();
  };
  /** Hand a steer back; remembered so a late start withdraws it. */
  const handBack = (uuid: string, st: Steer, reason: string) => {
    st.state = "requeued";
    st.requeue(reason);
    if (st.withdraw) returned.set(uuid, st.withdraw);
  };
  /**
   * Whether this process ever sent a `command_lifecycle` (2.1.316 does,
   * for every prompt). Without it (an older CLI) steers keep the earlier
   * replay-only behaviour: never handed back (Claude runs them itself).
   */
  let sawLifecycle = false;
  /** Messages of a turn the Agent started itself, until its job attaches. */
  let buffer: any[] | null = null;
  // The attached turn.
  let turn: {
      resolve: () => void;
      reject: (e: Error) => void;
      rootResult: any;
      submitted: number;
      results: number;
      outcome: TurnOutcome;
      media: Promise<void>[];
      approvals: Promise<void>[];
      /** get_context_usage after the root result: reported within the job. */
      refresh?: Promise<void>;
      /**
       * this turn's steers by uuid, as Claude Code's
       * `command_lifecycle` reports them (2.1.316, measured): `queued` at
       * once, then `started` — at the next tool boundary, merged into the
       * running turn, or after its result as a turn of its own — then
       * `completed`, or `cancelled`. `sent` = no word yet; `replayed` = an
       * older CLI's replay without lifecycle (done).
       */
      steers: Map<string, Steer>;
      /** Stopped waiting for steers that stay only queued. */
      steerWaitOver?: boolean;
      steerTimer?: ReturnType<typeof setTimeout>;
    } | null = null,
    turnOpen = false,
    // A report is what a self-started turn answers, so the next `init`
    // consumes it; a steer may run as a turn of its own, so only a later
    // result settles it.
    reported = false,
    steered = false,
    interruptTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Offline only: Claude Code starts a turn by itself (`init` … `result`)
   * when a background task reports back while it is idle, ~100 ms after the
   * report; a queued steer can likewise run as its own turn. Ending the
   * process at the first result where everything looks finished loses that
   * turn. So: never end while a turn is open, and if a report or
   * steer reached Claude since the previous result, wait a grace period for
   * a new `init` before ending. Online, the turn ends at its result and a
   * later one comes back through `hooks.wake`.
   */
  const followUpMs = Number(daisyEnv("DAISY_CLAUDE_FOLLOWUP_MS") || 5000);
  /** no `queued` / replay for a steer this long → the next turn. */
  const steerAckMs = Number(daisyEnv("DAISY_CLAUDE_STEER_ACK_MS") || 15000);
  /**
   * a steer still only `queued` after the turn's result is handed
   * back on Claude Code's own `session_state_changed` idle (it runs queued
   * input before going idle — measured). Without that signal: only after
   * this long with nothing at all from the process (a last resort).
   */
  const steerIdleMs = Number(
    daisyEnv("DAISY_CLAUDE_STEER_IDLE_MS") || 120_000,
  );
  /**
   * Steers handed back (uuid → withdraw): a late `queued` / `started` /
   * replay means Claude ran it after all — take the requeued turn back.
   */
  const returned = new Map<string, () => void>();
  let followUp: ReturnType<typeof setTimeout> | undefined;
  const finish = (mode: "now" | "grace" | "timer" = "now") => {
    const t = turn;
    if (!t || !t.rootResult || turnOpen || t.results < t.submitted) return;
    // a steer Claude still holds (queued, or running as a turn of
    // its own after this result) keeps the job; merged ones are done. A
    // stopped turn ends at its result: Claude keeps a queued steer through
    // an interrupt (`still_queued`) and runs it next by itself (2.1.316,
    // measured) — an AI-started turn, not this job's.
    if (!cur?.signal.aborted) {
      const open = [...t.steers.values()].filter((st) =>
        ["sent", "queued", "started"].includes(st.state),
      );
      const waiting = t.steerWaitOver
        ? open.filter((st) => st.state !== "queued")
        : open;
      if (waiting.length) {
        // Only queued ones left: wait a bounded time.
        if (!t.steerTimer && waiting.every((st) => st.state === "queued")) {
          const check = () => {
            const quiet = Date.now() - agent.lastActivity;
            if (quiet < steerIdleMs) {
              t.steerTimer = setTimeout(check, steerIdleMs - quiet);
              return;
            }
            // Silent this long: it will not run it — the next turn.
            for (const st of t.steers.values())
              if (st.state === "queued") st.idle = true;
            t.steerWaitOver = true;
            finish("now");
          };
          t.steerTimer = setTimeout(check, steerIdleMs);
        }
        return;
      }
    }
    clearTimeout(t.steerTimer);
    if (!live) {
      if ([...tasks.values()].some((x) => x === "running")) return;
      if (mode === "grace") {
        clearTimeout(followUp);
        followUp = setTimeout(() => finish("timer"), followUpMs);
        return;
      }
      if (mode === "now" && followUp) return; // the grace timer decides
    }
    clearTimeout(followUp);
    followUp = undefined;
    items.finish();
    const r = t.rootResult;
    if (r.is_error || r.subtype !== "success")
      t.reject(Error(claudeResultError(r, !!cur?.signal.aborted)));
    else t.resolve();
  };
  const pending = (): LiveTimer[] => {
    const now = Date.now(),
      out: LiveTimer[] = [];
    for (const [key, t] of timers)
      // A wakeup long past its time has fired or been dropped.
      if (t.kind === "wakeup" && t.at && t.at < now - 10 * 60_000)
        timers.delete(key);
      else out.push(t);
    const running = background
      ? [...background]
      : [...tasks]
          .filter(([, state]) => state === "running")
          .map(([id]) => [id, taskLabels.get(id) || T()("server-harness.claude.task.background")] as const);
    for (const [id, label] of running)
      out.push({
        id: `task:${id}`,
        kind: "task",
        label,
        ...taskInfo.get(id),
        // a CLI with background_tasks_changed answers stop_task.
        ...(background ? { stoppable: true } : {}),
      });
    return out;
  };
  /** 「停止」 on one background task (Claude Code's stop_task). */
  const stopTask = async (id: string) => {
    if (!p || closed || !id.startsWith("task:")) return false;
    if (!pending().some((t) => t.id === id && t.kind === "task")) return false;
    await p.control({ subtype: "stop_task", task_id: id.slice(5) }, 5000);
    return true;
  };
  const backgroundChanged = (list: any[] = []) => {
    background = new Map(
      list.map((t: any) => {
        if (!taskInfo.has(t.task_id)) taskStarted(t.task_id, t);
        else if (t.task_type && !taskInfo.get(t.task_id)!.type)
          taskStarted(t.task_id, t);
        return [t.task_id, t.description || t.task_type || T()("server-harness.claude.task.background")];
      }),
    );
  };
  /**
   * Background tasks right now: progress of subagents, the end of
   * the output of commands / Monitor (Claude Code's get_task_output, the
   * tail its own /tasks view shows).
   */
  const activity = async (): Promise<LiveActivity[]> => {
    const out: LiveActivity[] = [];
    for (const t of pending()) {
      if (t.kind !== "task") continue;
      const key = t.id.slice("task:".length);
      const a: LiveActivity = { id: t.id, ...taskProgress.get(key) };
      if (
        p &&
        !closed &&
        ["local_bash", "monitor_mcp", "monitor_ws"].includes(t.type || "")
      )
        try {
          const r = await p.control(
            { subtype: "get_task_output", task_id: key },
            5000,
          );
          if (typeof r?.output === "string") {
            a.output = plainTail(r.output, 4000);
            if (typeof r.total_bytes === "number")
              a.outputBytes = r.total_bytes;
          }
        } catch {
          // An older CLI, or the task just ended: no output this time.
        }
      out.push(a);
    }
    return out;
  };
  /** Why the Agent just started a turn by itself. */
  const wakeReason = () => {
    const now = Date.now();
    if (lastReport && now - lastReport.at < 15_000)
      return T()("server-harness.claude.wake.taskDone", { text: lastReport.text }).slice(0, 480);
    const due = [...timers.values()]
      .filter((t) => t.kind === "wakeup" && t.at && t.at <= now + 30_000)
      .sort((a, b) => a.at! - b.at!)[0];
    if (due) {
      timers.delete(due.id);
      return T()("server-harness.claude.wake.timer", { label: due.label }).slice(0, 480);
    }
    const cron =
      [...timers.values()].find((t) => t.kind === "cron" && !t.recurring) ||
      [...timers.values()].find((t) => t.kind === "cron");
    if (cron && now - lastLifecycle < 10_000) {
      if (!cron.recurring) timers.delete(cron.id);
      return T()("server-harness.claude.wake.cron", { label: cron.label }).slice(0, 480);
    }
    return T()("server-harness.claude.wake.self");
  };
  /** Background task / subagent state, attached or between turns. */
  const taskEvent = (m: any) => {
    const key = m.task_id || m.tool_use_id || m.uuid;
    const state =
      m.subtype === "task_notification"
        ? m.status || "completed"
        : m.subtype === "task_updated"
          ? m.patch?.status === "running" || !m.patch?.status
            ? tasks.get(key) || "running"
            : m.patch.status
          : "running";
    tasks.set(key, state);
    if (m.description) taskLabels.set(key, m.description);
    if (m.subtype === "task_started") taskStarted(key, m);
    if (m.subtype === "task_progress" || m.summary || m.last_tool_name)
      taskProgress.set(key, {
        ...taskProgress.get(key),
        ...(m.summary ? { summary: String(m.summary).slice(0, 500) } : {}),
        ...(m.last_tool_name
          ? { lastTool: String(m.last_tool_name).slice(0, 100) }
          : {}),
        ...(m.usage?.total_tokens != null
          ? { tokens: Number(m.usage.total_tokens) || 0 }
          : {}),
        ...(m.usage?.tool_uses != null
          ? { toolUses: Number(m.usage.tool_uses) || 0 }
          : {}),
      });
    if (m.subtype === "task_notification") {
      taskInfo.delete(key);
      taskProgress.delete(key);
    }
    if (m.subtype === "task_updated" && !taskItems.has(key)) return;
    const patch = {
      kind: "tool" as const,
      category: "subagent" as const,
      ...(m.tool_use_id ? { parentId: m.tool_use_id } : {}),
      name: m.description || taskLabels.get(key) || T()("server-harness.claude.task.subagentOrBackground"),
      ...(m.summary || m.last_tool_name
        ? { text: m.summary || m.last_tool_name }
        : {}),
      ...(m.output_file || m.usage
        ? { input: { output_file: m.output_file, usage: m.usage } }
        : {}),
      native: m,
      status:
        state === "running"
          ? "running"
          : state === "completed"
            ? "complete"
            : "error",
    };
    const known = taskItems.get(key);
    if (known) items.setId(known, patch);
    else if (cur) taskItems.set(key, items.set(`task:${key}`, patch).id);
    if (m.subtype === "task_notification") {
      taskItems.delete(key);
      reported = true;
      lastReport = {
        at: Date.now(),
        text: m.summary || m.description || taskLabels.get(key) || T()("server-harness.claude.task.background"),
      };
    }
  };
  /** ScheduleWakeup / CronCreate / CronDelete results: the pending timers. */
  const toolResult = (b: any) => {
    const use = toolUses.get(b.tool_use_id);
    if (!use) return;
    toolUses.delete(b.tool_use_id);
    const text = asText(b.content),
      input = use.input || {};
    if (b.is_error) return;
    if (use.name === "ScheduleWakeup") {
      if (input.stop === true) timers.delete("wakeup");
      else {
        const secs = /\(in (\d+)s\)/.exec(text)?.[1];
        timers.set("wakeup", {
          id: "wakeup",
          kind: "wakeup",
          label: String(input.reason || input.prompt || T()("server-harness.claude.timer.wakeup")).slice(
            0,
            300,
          ),
          at: Date.now() + Number(secs ?? input.delaySeconds ?? 60) * 1000,
        });
      }
    }
    if (use.name === "CronCreate") {
      const id = /task ([0-9a-zA-Z_-]{4,})/.exec(text)?.[1] || b.tool_use_id;
      timers.set(`cron:${id}`, {
        id: `cron:${id}`,
        kind: "cron",
        label: String(input.prompt || input.cron || T()("server-harness.claude.timer.cron")).slice(0, 300),
        recurring: input.recurring !== false,
      });
    }
    if (use.name === "CronDelete" && input.id)
      timers.delete(`cron:${input.id}`);
  };
  const approval = async (m: any) => {
    const rt = cur;
    try {
      const r = m.request;
      if (r.subtype !== "can_use_tool" || !rt) {
        if (rt)
          items.set(`unsupported:${m.request_id}`, {
            kind: "tool",
            category: "native",
            name: T()("server-harness.item.unsupportedRequest"),
            text: r.subtype,
            input: r,
            status: "error",
          });
        p?.send({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: m.request_id,
            error: rt
              ? `Unsupported control request: ${r.subtype}`
              : "No active turn",
          },
        });
        return;
      }
      // a permission prompt (auto-mode escalations carry Claude's
      // reason) is answered on the 「审批」 page; AskUserQuestion stays a
      // question in the conversation.
      const question = r.tool_name === "AskUserQuestion";
      const decision = await rt.approve(
        r.tool_name || T()("server-harness.claude.card.tool"),
        r.input,
        [
          { id: "allow", label: T()("server-harness.codex.decision.accept") },
          { id: "deny", label: T()("server-harness.card.deny") },
        ],
        {
          category: question ? "question" : "permission",
          ...(r.decision_reason ? { reason: plain(r.decision_reason) } : {}),
        },
      );
      const response =
        decision.optionId === "allow"
          ? {
              behavior: "allow",
              updatedInput: decision.answers
                ? { ...r.input, answers: decision.answers }
                : r.input,
              toolUseID: r.tool_use_id,
            }
          : {
              behavior: "deny",
              message: T()("server-harness.claude.denied"),
              toolUseID: r.tool_use_id,
            };
      p?.send({
        type: "control_response",
        response: { subtype: "success", request_id: m.request_id, response },
      });
    } catch (e) {
      if (rt && !rt.signal.aborted) turn?.reject(e as Error);
      else
        try {
          // Stopped while waiting: tell Claude so the interrupted turn ends.
          p?.send({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: m.request_id,
              response: {
                behavior: "deny",
                message: T()("server-harness.claude.deniedStopped"),
                toolUseID: m.request?.tool_use_id,
              },
            },
          });
        } catch {}
    }
  };
  /** Between turns: track state; an `init` means Claude began a turn itself. */
  const idle = (m: any) => {
    if (m.type === "control_request" && m.request?.subtype === "can_use_tool") {
      // A background subagent needs an authorization between turns: it
      // becomes a turn so the user can answer it.
      buffer = [m];
      hooks.wake(
        T()("server-harness.claude.wake.needsAuth", { tool: m.request.tool_name || T()("server-harness.claude.tool") }).slice(0, 480),
      );
      hooks.changed();
      return;
    }
    if (m.type === "control_request") {
      void approval(m);
      return;
    }
    if (m.type === "system" && m.subtype === "init" && !m.parent_tool_use_id) {
      buffer = [m];
      hooks.wake(wakeReason());
      hooks.changed();
      return;
    }
    if (
      m.type === "system" &&
      [
        "task_started",
        "task_progress",
        "task_notification",
        "task_updated",
      ].includes(m.subtype)
    )
      taskEvent(m);
    if (m.type === "system" && m.subtype === "background_tasks_changed")
      backgroundChanged(m.tasks);
    if (m.type === "command_lifecycle") lastLifecycle = Date.now();
    hooks.changed();
  };
  /** Mark the items of these assistant messages retracted; how many. */
  const retract = (uuids: unknown): number => {
    if (!Array.isArray(uuids)) return 0;
    let n = 0;
    for (const u of uuids.slice(0, 200)) {
      const own = typeof u === "string" ? byUuid.get(u) : undefined;
      if (!own) continue;
      const ids = new Set(own.ids);
      for (const id of items.map.keys())
        if (id.startsWith(own.prefix)) ids.add(id);
      for (const id of ids) {
        const it = items.map.get(id);
        // Review L2: only what the model wrote (text / thinking); a tool
        // call's effects really happened — it stays as it is.
        const words =
          it?.kind === "assistant" ||
          it?.kind === "thinking" ||
          (it?.kind === "tool" && textsOf("server-harness.item.subagentReply").has(String(it.name)));
        if (!it || it.retracted || !words) continue;
        items.setId(id, {
          retracted: true,
          ...(it.status === "streaming" || it.status === "running"
            ? { status: "complete" }
            : {}),
        });
        n++;
      }
    }
    return n;
  };
  const handle = (m: any) => {
    const rt = cur!,
      t = turn!;
    if (m.type === "control_request") {
      t.approvals.push(approval(m));
      return;
    }
    if (m.type === "command_lifecycle") {
      lastLifecycle = Date.now();
      const st = t.steers.get(m.command_uuid);
      if (st && ["sent", "unacked", "queued", "started"].includes(st.state)) {
        st.lifecycle = true;
        if (m.state === "queued") {
          // Never back from started to queued.
          if (st.state !== "started") st.state = "queued";
        } else if (m.state === "started" || m.state === "completed") {
          // started after this turn's result, before a new `init`
          // = Claude runs it as a turn of its own (budget: a turn).
          if (st.native && m.state === "started" && st.state !== "started")
            st.native.report("started", !!t.rootResult && !turnOpen);
          if (st.native && m.state === "completed") {
            if (st.state !== "started") st.native.report("started");
            st.native.report("completed");
          }
          readSteer(st);
          st.state = m.state;
        } else if (m.state === "cancelled") {
          if (st.withdrawing && st.state !== "started") {
            // 「移除」 — Claude gave it back; not sent again.
            st.state = "withdrawn";
          } else if (st.state === "started") {
            // It had begun: not sent again, but said (review 2).
            st.state = "dropped";
            items.set(`steer-dropped:${m.command_uuid}`, {
              kind: "notice",
              name: T()("server-harness.claude.steer.name"),
              text: T()("server-harness.claude.steer.dropped"),
              status: "error",
            });
          } else {
            // Cancelled before it ran: the next turn.
            handBack(m.command_uuid, st, T()("server-harness.claude.steer.cancelled"));
          }
        }
        finish("now");
      }
      return;
    }
    // only with CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS — Claude is
    // idle: a steer still only queued will not run by itself.
    if (
      m.type === "system" &&
      m.subtype === "session_state_changed" &&
      m.state === "idle"
    ) {
      for (const st of t.steers.values())
        if (st.state === "queued") st.idle = true;
      if ([...t.steers.values()].some((st) => st.idle)) {
        t.steerWaitOver = true;
        finish("now");
      }
    }
    const parent = m.parent_tool_use_id || "root";
    const metadata =
      parent === "root"
        ? {}
        : { category: "subagent" as const, parentId: parent };
    if (m.type === "system" && m.subtype === "init" && parent === "root") {
      if (t.rootResult)
        stage(
          rt,
          `follow-up:${t.results}`,
          T()("server-harness.claude.stage.followUp"),
        );
      turnOpen = true;
      reported = false;
      clearTimeout(followUp);
      followUp = undefined;
    }
    if (m.type === "system" && m.subtype === "init" && m.session_id) {
      nativeId = m.session_id;
      lastNative = {
        nativeId: m.session_id,
        ...(m.model ? { model: String(m.model).slice(0, 200) } : {}),
        ...(effortShown || rt.job.profile.reasoningEffort
          ? { effort: effortShown || rt.job.profile.reasoningEffort }
          : {}),
        // the permission mode this turn really runs with.
        ...(!sidecar && typeof m.permissionMode === "string"
          ? { permissionMode: m.permissionMode.slice(0, 40) }
          : {}),
      };
      // ADR-154: in the same event as the id (a job built in between
      // would take a new conversation for one from before).
      rt.emit(
        "native",
        toolsReport !== null
          ? { ...lastNative, nativeTools: toolsReport }
          : lastNative,
      );
      toolsReport = null;
      if (guideReport) {
        rt.emit("native", {
          nativeId: m.session_id,
          nativeGuide: "set" in guideReport ? guideReport.set : { clear: true },
        });
        guideReport = null;
      }
      stage(
        rt,
        "session",
        T()("server-harness.claude.stage.sessionReady"),
        "complete",
        asText({
          model: m.model,
          tools: m.tools,
          mcp_servers: m.mcp_servers,
          permissionMode: m.permissionMode,
          skills: m.skills,
        }),
      );
    }
    if (
      m.type === "system" &&
      [
        "task_started",
        "task_progress",
        "task_notification",
        "task_updated",
      ].includes(m.subtype)
    ) {
      taskEvent(m);
      if (m.subtype !== "task_updated")
        finish(m.subtype === "task_notification" ? "grace" : "now");
    }
    if (m.type === "system" && m.subtype === "background_tasks_changed")
      backgroundChanged(m.tasks);
    // auto mode (or dontAsk / a deny rule) refused a tool call by
    // itself. The control plane turns this item into an 「审批」 card
    // (category "interception"); older control planes just show it.
    if (m.type === "system" && m.subtype === "permission_denied")
      items.set(`denied:${m.tool_use_id || m.uuid}`, {
        kind: "tool",
        category: "interception",
        name: m.tool_name || T()("server-harness.claude.tool"),
        text: plain(m.message || m.decision_reason || T()("server-harness.claude.autoBlocked")),
        status: "error",
        input: {
          toolName: m.tool_name || "",
          toolUseId: m.tool_use_id || "",
          reason: plain(m.decision_reason || ""),
          reasonType: m.decision_reason_type || "",
          message: plain(m.message || ""),
          ...(m.agent_id ? { agentId: m.agent_id } : {}),
          request: items.map.get(items.id(m.tool_use_id || ""))?.input ?? null,
        },
      });
    // Claude Code answered with another model (fallback / refusal
    // retry). A session-wide swap is what the session runs with now.
    const switched = claudeModelSwitch(m);
    // Follow-up 2026-11-09: what the refused model had
    // written is retracted — kept in the trace, marked (shown greyed as
    // 「已撤回」, never counted as the answer), not deleted.
    // Review L2: also when the switch itself cannot be parsed.
    const retracted =
      m.type === "system" && m.subtype === "model_refusal_fallback"
        ? retract(m.retracted_message_uuids)
        : 0;
    if (switched) {
      const step = modelSwitchItem(switched);
      items.set(`model-switch:${m.uuid || Date.now()}`, {
        ...step,
        ...(retracted
          ? {
              text: T()("server-harness.claude.retracted", { text: String(step.text ?? ""), n: retracted }),
            }
          : {}),
        ...metadata,
      });
      if (switched.session && parent === "root" && lastNative) {
        lastNative = { ...lastNative, model: switched.to };
        rt.emit("native", lastNative);
      }
    }
    if (m.type === "system" && /hook/.test(m.subtype || ""))
      items.set(`system:${m.hook_id || m.subtype}`, {
        kind: "tool",
        category: "native",
        name: m.subtype,
        text: asText(m),
        status: m.subtype.endsWith("started") ? "running" : "complete",
      });
    // compaction (the /compact command, or Claude's own auto-compact).
    if (m.type === "system" && m.subtype === "status") {
      if (m.status === "compacting")
        items.set("compacting", {
          kind: "tool",
          category: "native",
          name: T()("server-harness.item.compacting"),
          text: "",
          status: "running",
        });
      else if (m.compact_result)
        items.set("compacting", {
          kind: "tool",
          category: "native",
          name: T()("server-harness.item.compaction"),
          text: String(m.compact_result),
          status: m.compact_result === "success" ? "complete" : "error",
        });
    }
    if (m.type === "system" && m.subtype === "compact_boundary") {
      const md = m.compact_metadata || {};
      const info = {
        ...(md.trigger ? { trigger: String(md.trigger) } : {}),
        ...(typeof md.pre_tokens === "number"
          ? { preTokens: md.pre_tokens }
          : {}),
        ...(typeof md.post_tokens === "number"
          ? { postTokens: md.post_tokens }
          : {}),
        ...(typeof md.duration_ms === "number"
          ? { durationMs: md.duration_ms }
          : {}),
      };
      compactNotice(items, m.uuid || String(Date.now()), info);
      // after a compaction Claude Code records its system prompt
      // anew — with what this process appended (measured 2.1.322). From
      // here the conversation holds this process's layered text.
      if (processGuide)
        rt.emit("native", {
          nativeId,
          nativeGuide: { ...processGuide, via: "record" },
        });
      t.outcome.compact = info;
      meter.compacted(info);
      meter.emit();
      void refresh();
    }
    if (m.type === "rate_limit_event") {
      const snap = fromRateLimit(rt.job.profile.id, m.rate_limit_info, plan);
      if (snap && rt.job.profile.authMode === "subscription")
        quotaItem(items, snap, rt.job.profile.label);
    }
    if (m.type === "rate_limit_event")
      items.set("rate", {
        kind: "tool",
        category: "usage",
        name: T()("server-harness.claude.item.rateLimit"),
        text: asText(m.rate_limit_info || m),
        status: "complete",
      });
    if (m.type === "stream_event") {
      const e = m.event;
      if (e.type === "message_start") currents.set(parent, e.message.id);
      if (e.type === "message_start" && e.message?.usage) {
        const u = e.message.usage;
        const read = u.cache_read_input_tokens || 0,
          write = u.cache_creation_input_tokens || 0,
          prompt = (u.input_tokens || 0) + read + write;
        // Cache hit rate: every API call, subagents included.
        if (e.message.id) meter.call(e.message.id, { prompt, read, write });
        if (parent === "root") meter.used = prompt;
        meter.emit();
      }
      current = currents.get(parent) || `reply:${parent}`;
      if (e.type === "content_block_delta") {
        const d = e.delta;
        if (d.type === "text_delta") {
          items.delta(
            `${current}:${e.index}`,
            d.text,
            parent === "root" ? "assistant" : "tool",
          );
          if (parent !== "root")
            items.set(`${current}:${e.index}`, {
              ...metadata,
              name: T()("server-harness.item.subagentReply"),
            });
        }
        if (d.type === "thinking_delta")
          items.delta(`${current}:${e.index}`, d.thinking, "thinking");
      }
      if (
        e.type === "content_block_delta" &&
        e.delta.type === "input_json_delta"
      ) {
        const b = blocks.get(`${parent}:${current}:${e.index}`);
        if (b) {
          b.json += e.delta.partial_json;
          let input: any = b.json;
          try {
            input = JSON.parse(b.json);
          } catch {}
          items.set(b.id, { input });
        }
      }
      if (e.type === "content_block_start" && e.content_block)
        layout(current).stream.set(e.index, {
          type: e.content_block.type,
          id: e.content_block.id,
        });
      if (
        e.type === "content_block_start" &&
        e.content_block?.type === "tool_use"
      ) {
        blocks.set(`${parent}:${current}:${e.index}`, {
          id: e.content_block.id,
          json: "",
        });
        items.set(e.content_block.id, {
          kind: "tool",
          ...metadata,
          name: e.content_block.name,
          input: e.content_block.input,
          text: "",
          status: "running",
        });
      }
    }
    if (m.type === "assistant") {
      const msg = m.message,
        content = msg.content || [];
      if (msg.id && msg.usage) {
        const u = msg.usage,
          read = u.cache_read_input_tokens || 0,
          write = u.cache_creation_input_tokens || 0;
        meter.call(msg.id, {
          prompt: (u.input_tokens || 0) + read + write,
          read,
          write,
        });
      }
      let own: { prefix: string; ids: Set<string> } | undefined;
      if (typeof m.uuid === "string" && msg.id) {
        own = byUuid.get(m.uuid);
        if (!own) {
          byUuid.set(
            m.uuid,
            (own = { prefix: items.id(`${msg.id}:`), ids: new Set() }),
          );
          if (byUuid.size > 200) byUuid.delete(byUuid.keys().next().value!);
        }
      }
      content.forEach((b: any, i: number) => {
        const key = `${msg.id}:${blockIndex(msg.id, b, i, content.length)}`;
        own?.ids.add(items.id(b.type === "tool_use" ? b.id : key));
        if (b.type === "text")
          items.set(key, {
            text: b.text,
            kind: parent === "root" ? "assistant" : "tool",
            ...metadata,
            name: parent === "root" ? undefined : T()("server-harness.item.subagentReply"),
            status: "complete",
          });
        if (b.type === "thinking")
          items.set(key, {
            text: b.thinking,
            kind: "thinking",
            status: "complete",
          });
        if (b.type === "tool_use") {
          if (["ScheduleWakeup", "CronCreate", "CronDelete"].includes(b.name))
            toolUses.set(b.id, { name: b.name, input: b.input });
          if (
            (b.name === "Monitor" ||
              (b.name === "Bash" && b.input?.run_in_background)) &&
            typeof b.input?.command === "string"
          )
            commands.set(b.id, b.input.command.slice(0, 2000));
          items.set(b.id, {
            kind: "tool",
            ...metadata,
            name: b.name,
            input: b.input,
            text: "",
            status: "running",
          });
        }
      });
    }
    if (m.type === "user" && Array.isArray(m.message?.content))
      for (const b of m.message.content)
        if (b.type === "tool_result") {
          toolResult(b);
          if (Array.isArray(b.content))
            b.content.forEach((part: any, n: number) => {
              if (part.type === "image" && part.source?.type === "base64")
                trackMedia(
                  t.media,
                  publishImage(
                    rt,
                    `${b.tool_use_id}:${n}`,
                    part.source.media_type,
                    part.source.data,
                  ),
                );
            });
          items.set(b.tool_use_id, {
            kind: "tool",
            text: asText(b.content),
            status: b.is_error ? "error" : "complete",
          });
        }
    if (m.type === "result" && parent === "root") {
      t.rootResult = m;
      t.results++;
      turnOpen = false;
      const wait = reported || steered;
      steered = false;
      // The session's model is the one that read the most input.
      const models = Object.values(m.modelUsage || {}) as any[];
      const main = models.sort(
        (a, b) =>
          (b.inputTokens || 0) +
          (b.cacheReadInputTokens || 0) -
          (a.inputTokens || 0) -
          (a.cacheReadInputTokens || 0),
      )[0];
      if (main?.contextWindow) meter.window = main.contextWindow;
      meter.emit();
      t.refresh = refresh();
      void usage();
      items.set("usage", {
        kind: "tool",
        category: "usage",
        name: T()("server-harness.claude.item.turnUsage"),
        text: asText({
          usage: m.usage,
          cost: m.total_cost_usd,
          duration_ms: m.duration_ms,
          num_turns: m.num_turns,
        }),
        status: "complete",
      });
      finish(wait ? "grace" : "now");
    }
  };
  /**
   * Claude Code's MCP traffic for the in-process server (`server`,
   * control_request `mcp_message`), answered here. A tool call made while
   * the Agent's own turn waits for its job to attach waits for it (30 s).
   */
  const mcp = async (m: any) => {
    const msg = m.request?.message || {};
    const reply = (body: any) =>
      p?.send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: m.request_id,
          response: {
            mcp_response: { jsonrpc: "2.0", id: msg.id ?? 0, ...body },
          },
        },
      });
    if (m.request?.server_name !== server || !daisyTools.length) {
      p?.send({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: m.request_id,
          error: `SDK MCP server not found: ${m.request?.server_name}`,
        },
      });
      return;
    }
    if (msg.id === undefined) return reply({ result: {} });
    if (msg.method === "initialize")
      return reply({
        result: {
          protocolVersion: msg.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: server, version: String(DAISY_TOOLSET_VERSION) },
        },
      });
    if (msg.method === "tools/list")
      return reply({ result: { tools: daisyTools } });
    if (msg.method === "ping") return reply({ result: {} });
    if (msg.method !== "tools/call")
      return reply({ error: { code: -32601, message: "Method not found" } });
    // The turn this call belongs to, as it arrives: between turns it is the one that just ended (a background
    // subagent's late call), even if it is then served in the next turn.
    const origin = cur ? cur.job.id : lastJob;
    for (let i = 0; !cur && !closed && i < 300; i++)
      await new Promise((r) => setTimeout(r, 100));
    const rt = cur;
    const r = rt?.tools
      ? await rt.tools.call(
          rt,
          String(msg.params?.name || ""),
          msg.params?.arguments,
          origin,
        )
      : { ok: false, text: T()("server-harness.tools.noTurn") };
    reply({
      result: { content: [{ type: "text", text: r.text }], isError: !r.ok },
    });
  };
  const onMessage = (m: any) => {
    agent.lastActivity = Date.now();
    // the mode the process really runs with — also when
    // the model changed it itself (an approved ExitPlanMode → acceptEdits,
    // `system/status {permissionMode}`, 2.1.316 measured), so the next turn
    // puts the identity's mode back.
    if (
      !sidecar &&
      m.type === "system" &&
      ["status", "init"].includes(m.subtype) &&
      !m.parent_tool_use_id &&
      typeof m.permissionMode === "string" &&
      m.permissionMode
    )
      mode = m.permissionMode.slice(0, 40);
    if (m.type === "control_request" && m.request?.subtype === "mcp_message") {
      void mcp(m);
      return;
    }
    if (m.type === "system" && m.subtype === "session_title_changed") {
      nativeRenamed(m);
      return;
    }
    if (m.type === "user" && m.uuid) {
      acknowledgements.get(m.uuid)?.();
      acknowledgements.delete(m.uuid);
      const st = turn?.steers.get(m.uuid);
      if (st && ["sent", "unacked", "queued"].includes(st.state)) {
        // An older CLI without command_lifecycle: the replay is all we get.
        // With it, the replay means the model has it (`started` follows).
        if (st.native)
          st.native.report("started", !!turn?.rootResult && !turnOpen);
        st.state = sawLifecycle ? "started" : "replayed";
        if (st.native && !sawLifecycle) st.native.report("completed");
        readSteer(st);
      }
      if (st && !sawLifecycle) finish("now");
    }
    if (m.type === "command_lifecycle") sawLifecycle = true;
    // Claude took a handed-back steer after all.
    const late =
      m.type === "command_lifecycle" &&
      ["queued", "started", "completed"].includes(m.state)
        ? m.command_uuid
        : m.type === "user" && m.uuid
          ? m.uuid
          : null;
    if (late && returned.has(late)) {
      returned.get(late)!();
      returned.delete(late);
    }
    // `queued` is Claude's acknowledgement (within ms); the replay
    // only comes when the message reaches the model, at the next tool
    // boundary — minutes later while a subagent runs.
    if (
      m.type === "command_lifecycle" &&
      m.command_uuid &&
      ["queued", "started", "completed"].includes(m.state)
    ) {
      acknowledgements.get(m.command_uuid)?.();
      acknowledgements.delete(m.command_uuid);
    }
    if (!cur) {
      if (buffer) buffer.push(m);
      else idle(m);
      return;
    }
    handle(m);
  };
  const start = async (rt: Runtime) => {
    stage(rt, "auth", T()("server-harness.claude.stage.checkAuth"), "running");
    if (rt.job.profile.authMode === "subscription") {
      // N-9 / ADR-133: each way the check can fail says what it was; a
      // passing failure (timeout, keychain, odd exit) is asked once more.
      const protection = readOnlyLaunch(rt.job, cwd);
      const verdict = await checkClaudeAuth(
        (timeout) =>
          promisify(execFile)(
            ...(protection
              ? (["/usr/bin/bwrap", [...protection, bin(), "auth", "status", "--json"]] as [string, string[]])
              : resolveSpawn(bin(), ["auth", "status", "--json"], agentEnv(rt.job))),
            { cwd, env: agentEnv(rt.job), timeout },
          ).then(
            (r) => probeOf(null, r),
            (e) => probeOf(e),
          ),
        {
          configDir: rt.job.profile.configDir,
          onFailure: (p, v, attempt) =>
            log.warn(
              authLogLine(
                `identity ${rt.job.profile.id}, attempt ${attempt}`,
                p,
                v,
              ),
            ),
        },
      );
      if (verdict.kind !== "ok") throw Error(claudeAuthMessage(verdict));
      if (verdict.plan) plan = verdict.plan;
    }
    stage(
      rt,
      "auth",
      rt.job.profile.authMode === "subscription"
        ? T()("server-harness.stage.subscriptionOk")
        : T()("server-harness.claude.stage.apiIdentity"),
    );
    stage(rt, "launch", T()("server-harness.claude.stage.launch"), "running");
    // what is appended to the system prompt — of the
    // job that starts the process now (with the layered prompt two jobs of
    // one process key may hold different org cores: the newest goes in).
    const guide = sidecar ? sidecarGuide(rt.job) : launchGuide(rt.job);
    const layered = layeredGuide(rt.job);
    // Off unless the control plane switched the experiment on for this
    // session (and this CLI is one it was measured on).
    const freshPrompt = !sidecar && freshLaunch(rt.job);
    const args = [
      "-p",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--forward-subagent-text",
      "--replay-user-messages",
      "--include-hook-events",
      // Claude Code's in-process timers die with the process.
      ...disallowedArgs(
        nativeTimerArgs({ live, sidecar, daisyTools: daisyTools.length > 0 }),
        rt.job.residentLimits ? residentDenyRules(rt.job) : "",
      ),
      // P4-07 (ADR-126): a resident agent's allowed tools and directories.
      ...(rt.job.residentLimits && !sidecar ? residentArgs(rt.job.residentLimits) : []),
      // Daisy's tools that touch nothing outside Daisy run
      // without asking; its background commands are checked like Bash.
      ...(daisyTools.length
        ? ["--allowedTools", claudeAllowed(daisyTools, toolNames).join(",")]
        : []),
      ...(sidecar
        ? []
        : ["--permission-mode", rt.job.profile.permissionMode || "manual"]),
      "--permission-prompt-tool",
      "stdio",
      // Claude Code records the system prompt on a conversation's
      // first request and resends that record until a compaction — a
      // changed appended text reaches a resumed session only then
      // (measured 2.1.322, docs/prompt-layers-stage0). That is the
      // default here too. Rendering afresh instead ("for iterating on
      // prompt text", says the CLI) is an experiment the control plane
      // switches on per session; its cost on long sessions is unmeasured.
      // Never for a sidecar: a fork would lose its main session's cache.
      ...(freshPrompt ? ["--system-prompt-snapshot", "off"] : []),
    ];
    nativeId = rt.job.session.nativeId || nativeId;
    // a sidecar forks its main session on its first turn
    // (--resume <main> --fork-session --session-id <own>), read-only.
    if (sidecar) args.push(...claudeSidecarArgs(rt.job, nativeId));
    else
      args.push(
        rt.job.session.nativeId ? "--resume" : "--session-id",
        nativeId,
      );
    model = rt.job.profile.model || "";
    effort = rt.job.profile.reasoningEffort || "";
    mode = rt.job.profile.permissionMode || "manual";
    effortShown = "";
    if (model) args.push("--model", model);
    if (rt.job.profile.reasoningEffort)
      args.push("--effort", rt.job.profile.reasoningEffort);
    const env = agentEnv(rt.job);
    // `session_state_changed` (idle = the turn and its queued
    // input are really over; 2.1.316 emits it only with this set).
    env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = "1";
    if (launched !== null) {
      // the identity's compaction window, Claude Code's own range
      // (100K–1M); the Runner's inherited overrides must not win over it.
      args.push("--autocompact", String(launched));
      delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    }
    const proc = new JsonProcess(bin(), args, {
      cwd,
      env,
      readOnly: sidecar
        ? sidecarLaunch(rt.job, cwd)
        : readOnlyLaunch(rt.job, cwd),
    });
    p = proc;
    proc.onMessage = onMessage;
    proc.onExit = (e) => {
      const unexpected = !stopping;
      closed = true;
      clearTimeout(interruptTimer);
      for (const ack of acknowledgements.values()) ack();
      acknowledgements.clear();
      if (turn) turn.reject(e);
      else if (unexpected)
        hooks.closed(T()("server-harness.processExited", { name: "Claude", error: e.message.slice(0, 200) }));
    };
    await proc.control({
      subtype: "initialize",
      hooks: {},
      sdkMcpServers: daisyTools.length ? [server] : [],
      sdkAgents: [],
      // a resident's built-in guidance.
      ...(guide ? { appendSystemPrompt: guide } : {}),
    });
    stage(rt, "launch", T()("server-harness.claude.stage.connected"));
    // the model has this text from now on only in a new session
    // (the engine records it at the first request) or one rendered
    // afresh; a resumed session keeps what the engine recorded, until it
    // is compacted.
    const resumed = !!rt.job.session.nativeId;
    const delivered = !resumed || freshPrompt;
    launchAudit(rt, {
      guide,
      mode: sidecar
        ? rt.job.session.nativeId
          ? "resume"
          : "fork"
        : rt.job.session.nativeId
          ? "resume"
          : "start",
      delivery: sidecar ? "unknown" : delivered ? "launch" : "recorded",
      args,
      engine: {
        name: "claude",
        version: liveFeatures("claude")?.cliVersion,
      },
      cwd,
      tools: daisyTools,
    });
    // Reported with the session id Claude itself announces (`init`).
    const had = rt.job.session.nativeGuide;
    const mine =
      layered && !sidecar
        ? { sha256: layered.sha256, staticRules: layered.staticRules }
        : null;
    guideReport = !mine
      ? null
      : delivered
        ? { set: { ...mine, via: freshPrompt ? "fresh" : "record" } }
        : // Resumed on the engine's record. What was reported as recorded
          // still holds (that record is what it resends). Anything else —
          // reported while rendering afresh, which leaves no record — is
          // not what the model has now: said so, and each turn carries the
          // full note again until a compaction.
          had &&
            had.thread === rt.job.session.nativeId &&
            had.via !== "record"
          ? { clear: true }
          : null;
    processGuide = mine && !freshPrompt ? mine : null;
    toolsReport =
      !sidecar && daisyTools.length && !rt.job.session.nativeId
        ? toolNames === "daisy"
          ? DAISY_TOOLSET_VERSION
          : 1
        : null;
    ready = true;
    // Where it compacts and the plan quota: in the background, never
    // holding up the turn.
    void refresh();
    void usage();
  };
  const interrupt = (forTurn: typeof turn = turn) => {
    if (!p || closed) return;
    if (!live) {
      p.stop();
      return;
    }
    // Stop the turn, keep the process (and its timers) online; a turn that
    // does not end promptly takes the process down with it.
    const answer = p.control({ subtype: "interrupt" }).catch(() => null);
    clearTimeout(interruptTimer);
    // Only the turn it was armed for (review: never the next one).
    interruptTimer = setTimeout(() => {
      if (turn && turn === forTurn && p) {
        stopping = true;
        p.stop();
      }
    }, 5000);
    return answer;
  };
  /**
   * Ask Claude for appended Daisy jobs it has
   * not read (`cancel_async_message`), waiting for its answers up to
   * `ms`. Returns the uuids it gave back; one it answered `cancelled:false`
   * for was taken already (its `started` follows) and is marked `taken`.
   */
  const withdrawUnread = async (
    steers: Map<string, Steer>,
    ms: number,
  ): Promise<Set<string>> => {
    const back = new Set<string>();
    if (!p || closed) return back;
    const asks = [...steers]
      .filter(
        ([, st]) =>
          st.native && ["sent", "unacked", "queued"].includes(st.state),
      )
      .map(async ([uuid, st]) => {
        const r = await p!
          .control({ subtype: "cancel_async_message", message_uuid: uuid }, ms)
          .catch(() => null);
        if (r?.cancelled === true) back.add(uuid);
        else if (r?.cancelled === false) st.taken = true;
      });
    await Promise.all(asks);
    return back;
  };
  /**
   * The title the user gave this conversation (titleStage "manual") → the
   * native session, before the prompt. Not an AI title: the server stores
   * the one-time AI title with titleAuto false too (titleStage "final"), and
   * Claude Code records every source:"host" rename as the user's. Bounded
   * (5 s, and a Stop ends the wait) and never fails the turn.
   */
  /**
   * a changed effort / permission mode, applied to the online
   * process before this turn — its background tasks and subagents kept
   * (Claude Code 2.1.316, measured: `apply_flag_settings {effortLevel}`,
   * null = the model's default; `set_permission_mode`). Below that version
   * both are in the live key instead (a restart). Bypass on / off is never
   * applied here (only a new process gets or loses it). A mode
   * that cannot be applied ends the process: the turn never runs with the
   * old mode.
   */
  const applySettings = async (rt: Runtime) => {
    const live = liveSettings("claude");
    const wantEffort = rt.job.profile.reasoningEffort || "";
    if (live.effort === "native" && wantEffort !== effort) {
      try {
        await p!.control({
          subtype: "apply_flag_settings",
          settings: { effortLevel: wantEffort || null },
        });
        effort = wantEffort;
        // What Claude Code runs with now (an unknown level is ignored).
        const got = await p!
          .control({ subtype: "get_settings" }, 5000)
          .catch(() => null);
        const applied = got?.applied?.effort;
        effortShown =
          typeof applied === "string" ? applied.slice(0, 40) : wantEffort;
        stage(rt, "effort", T()("server-harness.stage.effortSwitched", { effort: effortShown || T()("server-harness.stage.default") }));
      } catch (e: any) {
        stage(rt, "effort", T()("server-harness.stage.effortFailed"), "error", e.message);
      }
    }
    const wantMode = rt.job.profile.permissionMode || "manual";
    // Claude Code reports Daisy's "manual" as "default".
    const same = (a: string) => (a === "manual" ? "default" : a);
    if (
      sidecar ||
      live.permissionMode !== "native" ||
      same(wantMode) === same(mode) ||
      bypassMode({ agent: "claude", permissionMode: wantMode }) !==
        bypassMode({ agent: "claude", permissionMode: mode })
    )
      return;
    try {
      const r: any = await p!.control(
        { subtype: "set_permission_mode", mode: wantMode },
        10000,
      );
      mode = wantMode;
      stage(rt, "permission", T()("server-harness.stage.modeSwitched", { mode: String(r?.mode || wantMode) }));
    } catch (e: any) {
      stage(rt, "permission", T()("server-harness.stage.modeFailed"), "error", e.message);
      agent.stop();
      throw Error(
        T()("server-harness.claude.modeRestart"),
      );
    }
  };
  /**
   * the native session's name (Claude Code 2.1.316
   * `system/session_title_changed`, measured: sent at startup when the
   * session already has a name — before `initialize` answers — and after
   * every rename, Daisy's own `rename_session` included; never for the
   * ai-title). Daisy's echo and a name Daisy already has are dropped. At
   * startup a name other than Daisy's own manual title loses (it is pushed
   * by syncTitle before the turn); otherwise it is the owner's rename in
   * the CLI and goes to Daisy, which keeps its own if it changed since.
   */
  const nativeRenamed = (m: any) => {
    const t = nativeTitle(m.title);
    if (!t || sidecar || (m.session_id && m.session_id !== nativeId)) return;
    nativeName = t;
    const key = JSON.stringify([nativeId, t]);
    if (key === titled || key === titling) return;
    const h = renames.daisy;
    const pushed = titled === JSON.stringify([nativeId, h.title]);
    titled = key;
    if (t === h.title) return;
    // Review H1: the name Daisy gave a copy (forkSession) is not the owner's.
    if (isDaisyForkTitle(t) || (h.manual && !pushed)) {
      titled = "";
      return;
    }
    renames.report(t);
  };
  /**
   * the session's one AI title from this live process (Claude
   * Code `generate_session_title {description, persist:true}`, measured
   * ~2 s): the CLI's own small-model namer with the process's credentials,
   * recorded as the native ai-title (not the owner's custom title). The CLI
   * answers an existing custom title instead of naming (measured): when
   * that is the one it reported, or Daisy's copy marker (review H1), it is
   * asked again without persisting.
   */
  const generateTitle = async (description: string, timeoutMs: number) => {
    if (!p || closed || !ready || sidecar) return null;
    const until = Date.now() + timeoutMs;
    const ask = async (persist: boolean) => {
      const r: any = await p!.control(
        { subtype: "generate_session_title", description, persist },
        Math.max(1000, until - Date.now()),
      );
      return typeof r?.title === "string" ? r.title : null;
    };
    const t = await ask(true);
    if (t && (isDaisyForkTitle(t) || nativeTitle(t) === nativeName))
      return ask(false);
    return t;
  };
  /**
   * Daisy's title the native session should carry: the owner's; the AI
   * title only over Daisy's copy marker (re-review L-c — it is Daisy's
   * label there, and its echo is Daisy's own, never reported back).
   */
  const wantedName = () => {
    const h = renames.daisy;
    return h.manual || (h.final && isDaisyForkTitle(nativeName))
      ? h.title
      : "";
  };
  const syncTitle = async (rt: Runtime | null) => {
    const title = wantedName();
    const key = JSON.stringify([nativeId, title]);
    if (!title || !p || closed || [titled, titling].includes(key)) return;
    if (refusedTitles.has(key)) return; // asked once in this process
    // Not Daisy's older title back over a rename still being reported.
    if (renames.holdsBack(title)) return;
    titling = key;
    const sent = p
      .control(
        {
          subtype: "rename_session",
          title,
          source: "host",
          session_id: nativeId,
        },
        5000,
      )
      .then(
        () => {
          titled = key;
        },
        (e: Error) => {
          if (closed) return;
          refusedTitles.add(key);
          if (rt && cur === rt)
            stage(
              rt,
              "title",
              T()("server-harness.stage.titleNotSynced"),
              "error",
              T()("server-harness.stage.titleNotSyncedDetail", { error: String(e.message) }),
            );
        },
      )
      .finally(() => {
        if (titling === key) titling = "";
      });
    if (!rt) return void (await sent);
    let stop = () => {};
    const stopped = new Promise<void>((r) => (stop = r));
    rt.signal.addEventListener("abort", stop, { once: true });
    if (rt.signal.aborted) stop();
    await Promise.race([sent, stopped]);
    rt.signal.removeEventListener("abort", stop);
  };
  const agent: LiveAgent = {
    since,
    lastActivity: since,
    get closed() {
      return closed;
    },
    busy: () => !!cur || !!buffer,
    pending,
    activity,
    stopTask,
    discardWake() {
      // The job for the Agent's own turn will not come: stop that turn.
      if (!buffer || cur) return;
      buffer = null;
      if (p && !closed) p.control({ subtype: "interrupt" }).catch(() => {});
      hooks.changed();
    },
    stopped: () => p?.whenStopped() ?? Promise.resolve(),
    stop(reason) {
      stopping = true;
      closed = true;
      clearTimeout(followUp);
      clearTimeout(interruptTimer);
      if (reason) turn?.reject(Error(reason));
      p?.stop();
    },
    async warm() {
      if (closed) throw Error(T()("server-harness.processEnded", { name: "Claude" }));
      await (starting ??= start(warmRuntime(first, cwd)).catch((e) => {
        agent.stop();
        throw e;
      }));
      await refreshing;
    },
    nativeId: () => (p ? nativeId : first.session.nativeId || null),
    // 「只问」 / 「回退」 through this process (claude-native.ts).
    canAsk: () => !!p && !closed && ready,
    // the AI title from this process itself.
    generateTitle,
    // Re-review L-c: the AI title Daisy just applied, over the copy marker.
    async pushTitle(title) {
      if (renames.daisy.manual) return;
      renames.setDaisy({
        title: nativeTitle(title),
        manual: false,
        final: true,
      });
      if (ready) await syncTitle(null);
    },
    // Re-review L-d: the owner's native name Daisy may not have.
    ownerName: () =>
      nativeName &&
      !isDaisyForkTitle(nativeName) &&
      nativeName !== renames.daisy.title
        ? nativeName
        : null,
    sideQuestion: (question, history, o) =>
      p && !closed && ready
        ? askSideQuestion(p, question, history, o)
        : Promise.resolve(null),
    rewind: (uuid, o) =>
      p && !closed && !cur && !buffer
        ? rewindInPlace(p, nativeId, uuid, o)
        : Promise.resolve(null),
    async turn(rt) {
      if (closed) throw Error(T()("server-harness.processEndedResend", { name: "Claude" }));
      if (cur) throw Error(T()("server-harness.busyOtherTurn", { name: "Claude" }));
      cur = rt;
      lastJob = rt.job.id;
      renames.setDaisy(daisyOf(rt.job));
      wanted = requestedAutoCompact(rt.job);
      meter.beginJob();
      let resolve!: () => void, reject!: (e: Error) => void;
      const done = new Promise<void>((a, b) => {
        resolve = a;
        reject = b;
      });
      done.catch(() => {});
      const t = (turn = {
        resolve,
        reject,
        rootResult: null,
        submitted: 0,
        results: 0,
        outcome: {},
        media: [],
        approvals: [],
        steers: new Map(),
      } as NonNullable<typeof turn>);
      // Own the Agent-started turn's messages before anything can throw, so
      // a job that stops early cannot leave them stuck (review r1 #2).
      const replay = buffer;
      buffer = null;
      let replayed = false;
      turnOpen = false;
      reported = false;
      steered = false;
      hooks.changed();
      const onAbort = () => {
        // Daisy jobs still waiting in Claude's queue go back to
        // Daisy first — written before the interrupt, so Claude does not
        // keep them (`still_queued`) and run them as a turn of its own.
        // 「停止」 is stop: Daisy's queue decides what happens to them.
        // Review L3: their answers are awaited (≤ 2 s) before the interrupt;
        // one Claude still lists as `still_queued` after it is asked again.
        void (async () => {
          await withdrawUnread(t.steers, 2000);
          // The turn may have ended (or the next begun) while asking:
          // nothing to interrupt, no kill armed for another turn.
          if (turn !== t || closed) return;
          const r: any = await interrupt(t);
          for (const uuid of r?.still_queued || [])
            if (t.steers.get(uuid)?.native && p && !closed)
              p.control(
                { subtype: "cancel_async_message", message_uuid: uuid },
                5000,
              ).catch(() => {});
        })();
        // Only waiting for a steer Claude still holds: end now.
        finish("now");
      };
      rt.signal.addEventListener("abort", onAbort, { once: true });
      if (rt.signal.aborted) onAbort();
      try {
        // A warm start may still be connecting: wait for it.
        const reused = !!starting;
        await (starting ??= start(rt).catch((e) => {
          agent.stop();
          throw e;
        }));
        // This job's identity quota (or why there is none), refreshed by
        // get_usage / rate_limit_event during the turn.
        const quota = quotaOf(rt.job.profile.id) ?? staticQuota(rt.job);
        if (quota) quotaItem(items, quota, rt.job.profile.label);
        if (!reused) {
          // Nothing to add.
        } else if ((rt.job.profile.model || "") !== model) {
          // a model chosen for this conversation, applied live.
          const next = rt.job.profile.model || "";
          try {
            await p!.control({
              subtype: "set_model",
              model: next || undefined,
            });
            model = next;
            stage(rt, "model", T()("server-harness.stage.modelSwitched", { model: next || T()("server-harness.stage.default") }));
            void refresh();
          } catch (e: any) {
            stage(rt, "model", T()("server-harness.stage.modelFailed"), "error", e.message);
          }
        }
        // effort / permission mode from this turn on.
        if (reused) await applySettings(rt);
        if (closed) throw Error(T()("server-harness.processEndedResend", { name: "Claude" }));
        if (rt.signal.aborted) throw Error(T()("server-harness.turn.stopped"));
        await syncTitle(rt);
        // A Stop, or the process ending, while the rename was out.
        if (closed) throw Error(T()("server-harness.processEndedResend", { name: "Claude" }));
        if (rt.signal.aborted) throw Error(T()("server-harness.turn.stopped"));
        if (reused) stage(rt, "launch", T()("server-harness.stage.reused", { name: "Claude Code" }));
        rt.emit("native", { nativeId });
        await rt.flush();
        // Every root `init` buffered is a turn whose `result` this job
        // waits for; a user message adds its own. Counted before replaying,
        // so a buffered turn that already ended cannot settle the job
        // before the message is answered (review r1 #1).
        const userTurn = rt.job.origin !== "agent";
        const inits = (replay || []).filter(
          (m) =>
            m.type === "system" &&
            m.subtype === "init" &&
            !m.parent_tool_use_id,
        ).length;
        t.submitted = inits + (userTurn ? 1 : 0);
        if (replay) {
          replayed = true;
          stage(rt, "wake", T()("server-harness.claude.stage.wake"), "complete", rt.job.wake || "");
          for (const m of replay) handle(m);
        }
        // A message added while this turn runs (steer), also in a turn the
        // Agent started by itself.
        // Written without `priority`, Claude Code queues
        // it (`command_lifecycle` queued) and takes it at the next tool
        // boundary of the running turn — subagents keep running; it never
        // interrupts (2.1.316, measured). No extra `result` is counted: the
        // steer's own lifecycle settles it. Not acknowledged in 15 s, or
        // cancelled → handed back as the next turn, never lost.
        // a Daisy job (「插队发送」 while live, a Daisy wake) goes
        // the same way with `priority: "next"`, its images as content, and
        // `cancel_async_message` for 「移除」 while Claude has not read it.
        rt.onInput?.(async (text, requeue, withdraw, native, read) => {
          if (cur !== rt) throw Error(T()("server-harness.claude.turnOver"));
          if (rt.signal.aborted) throw Error(T()("server-harness.turn.stopped"));
          const uuid = randomUUID();
          const st: Steer = {
            state: "sent",
            lifecycle: false,
            requeue,
            withdraw,
            ...(native ? { native } : {}),
            ...(read ? { read } : {}),
          };
          if (native)
            native.cancel = async () => {
              if (!["sent", "unacked", "queued"].includes(st.state) || !p)
                return false;
              st.withdrawing = true;
              const r = await p
                .control(
                  { subtype: "cancel_async_message", message_uuid: uuid },
                  5000,
                )
                .catch(() => null);
              if (r?.cancelled === true) {
                st.state = "withdrawn";
                finish("now");
                return true;
              }
              st.withdrawing = false;
              return false;
            };
          const content: any[] = [{ type: "text", text }];
          for (const f of native?.files || [])
            if (/^image\/(png|jpeg|gif|webp)$/.test(f.mime))
              content.push({
                type: "image",
                source: { type: "base64", media_type: f.mime, data: f.data },
              });
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              // Not decided here (review 1): a late `queued` / replay
              // reclaims it; the turn's end decides. It stops holding the
              // job, and the composer is not told 「未确认」.
              if (st.state === "sent") {
                st.state = "unacked";
                finish("now");
              }
              resolve();
            }, steerAckMs);
            acknowledgements.set(uuid, () => {
              clearTimeout(timer);
              resolve();
            });
            t.steers.set(uuid, st);
            steered = true;
            try {
              p!.send({
                type: "user",
                uuid,
                message: { role: "user", content },
                parent_tool_use_id: null,
                session_id: nativeId,
                ...(native ? { priority: native.priority } : {}),
              });
            } catch (e) {
              t.steers.delete(uuid);
              clearTimeout(timer);
              acknowledgements.delete(uuid);
              reject(e);
            }
          });
        });
        if (!userTurn) {
          if (!replay) return t.outcome;
          if (!inits) {
            // Only an authorization request between turns (a background
            // subagent): the job lasts until it is answered.
            await Promise.allSettled(t.approvals);
            return t.outcome;
          }
        } else {
          const content: any[] = [{ type: "text", text: rt.prompt }];
          for (const f of rt.files)
            if (/^image\/(png|jpeg|gif|webp)$/.test(f.mime))
              content.push({
                type: "image",
                source: { type: "base64", media_type: f.mime, data: f.data },
              });
          // Claude Code keeps this uuid as the transcript message id, so
          // editing this message later can rewind to exactly before it.
          const promptUuid = randomUUID();
          p!.send({
            type: "user",
            uuid: promptUuid,
            message: { role: "user", content },
            parent_tool_use_id: null,
            session_id: nativeId,
          });
          // Attachment- or terminal-only messages are acknowledged too.
          if (
            rt.job.text ||
            rt.job.attachments?.length ||
            rt.job.terminal?.length
          )
            rt.emit("item", {
              id: `user:${rt.job.id}`,
              kind: "user",
              text: rt.job.text,
              status: "accepted",
              native: { uuid: promptUuid },
              createdAt: Date.now(),
            });
          stage(rt, "sent", T()("server-harness.stage.inputSent", { name: "Claude" }));
          rt.emit("native", { nativeId, contextDelivered: true });
        }
        await done;
        await Promise.all(t.media);
        // The trigger point after this turn, inside the job (offline too).
        if (t.refresh)
          await Promise.race([
            t.refresh,
            new Promise((r) => setTimeout(r, 3000)),
          ]);
        return t.outcome;
      } catch (e) {
        throw stoppedEnd(e, rt, T()("server-harness.turn.stopped"));
      } finally {
        rt.signal.removeEventListener("abort", onAbort);
        rt.onInput?.(null);
        // what this turn's steers became. Never acknowledged → the
        // next turn. Queued in a process that goes on (online): Claude runs
        // it next by itself (an AI-started turn); in a process that ends,
        // it is handed back too. Started: the model has it.
        // An older CLI (no lifecycle ever): as before — it runs an
        // unreplayed steer itself in its next turn; nothing is sent again.
        const ending = closed || stopping || !live;
        clearTimeout(t.steerTimer);
        // appended Daisy jobs still unread at the turn's
        // end are asked back before they are handed back, so Claude does not
        // run them after all (the stop asked already).
        if (!rt.signal.aborted && !ending) await withdrawUnread(t.steers, 2000);
        for (const [uuid, st] of t.steers) {
          if (st.native && st.taken && st.state !== "started") {
            // Taken just now: Claude runs it (as a turn of its own) — done
            // on Daisy's side, never handed back to run twice.
            st.native.report("started", true);
            st.native.report("completed");
            st.state = "delegated";
            continue;
          }
          const unacked = st.state === "sent" || st.state === "unacked";
          // a Daisy job Claude has not read is Daisy's again
          // (its cancel went out with the stop) — never left to Claude.
          if (st.native && (unacked || st.state === "queued"))
            handBack(
              uuid,
              st,
              rt.signal.aborted ? T()("server-harness.turn.stopped") : T()("server-harness.steer.unreadAtEnd", { name: "Claude" }),
            );
          else if (unacked && !sawLifecycle) st.state = "delegated";
          else if (unacked || (st.state === "queued" && (ending || st.idle)))
            handBack(
              uuid,
              st,
              unacked
                ? T()("server-harness.steer.unackedAtEnd", { name: "Claude" })
                : T()("server-harness.steer.unhandledAtEnd", { name: "Claude" }),
            );
          else if (st.state === "queued") st.state = "delegated";
          acknowledgements.get(uuid)?.();
          acknowledgements.delete(uuid);
        }
        clearTimeout(followUp);
        clearTimeout(interruptTimer);
        followUp = undefined;
        if (replay && !replayed && p && !closed)
          // Stopped before the Agent's own turn was shown: end it there too.
          p.control({ subtype: "interrupt" }).catch(() => {});
        turnOpen = false;
        turn = null;
        cur = null;
        items.retain(new Set(taskItems.values()));
        // A long-lived process: forget finished stream bookkeeping.
        blocks.clear();
        layouts.clear();
        currents.clear();
        for (const [key, state] of tasks)
          if (state !== "running") {
            tasks.delete(key);
            taskLabels.delete(key);
          }
        agent.lastActivity = Date.now();
        hooks.changed();
      }
    },
  };
  return agent;
}
