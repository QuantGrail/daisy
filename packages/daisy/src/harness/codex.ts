import type { MessageKey } from "../../../contracts/src/i18n.ts";
import { daisyEnv } from "../../../contracts/src/env.ts";
import { PRODUCT_NAME } from "../../../contracts/src/names.ts";
import { sessionT } from "../../../contracts/src/prompt-i18n.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  codexModelSwitch,
  modelSwitchItem,
  turnT,
  unsupportedModelHint,
} from "./model-switch.ts";
import { readOnlyLaunch } from "../platform/read-only.ts";
import {
  CODEX_SIDECAR,
  sidecarToolRefusal,
  codexSidecarFork,
  isSidecar,
  sidecarGuide,
} from "../turns/sidecar.ts";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { JsonProcess } from "../turns/transport.ts";
import {
  killAll,
  orphansToKill,
  readProcs,
  sandboxesFor,
  type Sandbox,
} from "../platform/sandbox-reap.ts";
import {
  jobToolNames,
  launchGuide,
  layeredGuide,
  toolsFor,
} from "../tools/daisy-tools.ts";
import {
  bareToolName,
  DAISY_TOOLSET_VERSION,
  toolId,
} from "../../../contracts/src/native-tools.ts";
import { launchAudit, type LaunchAudit } from "../observe/launch-audit.ts";
import {
  guideSidecarHead,
  guideUpdateHead,
} from "../../../contracts/src/guide.ts";
import {
  missingThreadTools,
  missingToolsNotice,
} from "../../../contracts/src/native-tools.ts";
import type {
  ContextThreshold,
  Item,
  RunnerJob,
} from "../../../contracts/src/index.ts";
import { catalogModel } from "../../../contracts/src/model-options.ts";
import { AGENT_STOP } from "../../../contracts/src/agent-stop.ts";
import { reviewInterception } from "./codex-review.ts";
import { CodexTerminals } from "./codex-background.ts";
import { TurnCheckpoint } from "../turns/file-checkpoints.ts";
import { fromCodexRateLimits, quotaOf, staticQuota } from "../turns/quota.ts";
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
  liveSettings,
  liveFeatures,
  NativeRenames,
  type LiveAgent,
  type LiveHooks,
  type Runtime,
  type TurnOutcome,
  type NativeInput,
  stoppedEnd,
} from "./shared.ts";
import {
  AGENT_CAPABILITIES,
  nativeReviewAt,
  promptRefreshAt,
} from "../../../contracts/src/agent-capabilities.ts";
import { bypassMode } from "../../../contracts/src/approvals.ts";
import { nativeTitle } from "../../../contracts/src/title.ts";
/** the unified semantics this adapter does natively (reported). */
export const CODEX_CAPABILITIES = AGENT_CAPABILITIES.codex;
/** One Codex turn in a process that ends with it (offline mode, tests). */
export const runCodex = (rt: Runtime) => oneShot(codexAgent, rt);
/**
 * Codex's own auto-compact rule, measured on 0.157.1 (n-codexring,
 * 2026-11-02; real turns with `-c model_context_window=<W>`):
 * - the reported `tokenUsage.modelContextWindow` is 95% of the model's
 *   context window W (the catalog's effective_context_window_percent:
 *   W 16500 → 15675, 17500 → 16625, 272000 → 258400);
 * - with no limit configured Codex compacts once the conversation reaches
 *   90% of W (W 14500: compacted at 13292 = 91.7%; W 14900: not at
 *   13301 = 89.3%; W 14400: compacted at 13291 though < 95%);
 * - a configured model_auto_compact_token_limit above that is capped at it
 *   (W 14400, limit 14000: compacted at 13291).
 * Codex does not report the point itself (no protocol field), hence ≈.
 */
export const CODEX_REPORTED_WINDOW_PERCENT = 95;
export const CODEX_DEFAULT_COMPACT_PERCENT = 90;
/**
 * Smallest reported window taken as real: below it (a junk / test value)
 * the 90% point would be a handful of tokens, so it is unknown instead.
 * Codex's own base prompt alone is ~13K tokens (0.157.1).
 */
export const CODEX_MIN_REPORTED_WINDOW = 1000;
/** The 90% point from a reported modelContextWindow; null = no usable window. */
const CODEX_DECISION_LABELS: Record<string, MessageKey> = {
  accept: "server-harness.codex.decision.accept",
  acceptForSession: "server-harness.codex.decision.acceptForSession",
  decline: "server-harness.codex.decision.decline",
  cancel: "server-harness.codex.decision.cancel",
};
const clip = (s: string, n = 80) =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;
/** A human label for one native Codex approval decision (C1-b): an object
 *  decision names what it changes, never dumps its JSON. */
export function codexDecisionLabel(d: unknown): string {
  if (typeof d === "string") return CODEX_DECISION_LABELS[d] ? turnT().dynamic(CODEX_DECISION_LABELS[d]!) : d;
  const [kind, body] = Object.entries((d || {}) as Record<string, any>)[0] || [
    "",
    null,
  ];
  if (kind === "acceptWithExecpolicyAmendment") {
    const cmd = body?.execpolicy_amendment;
    const text = Array.isArray(cmd) ? cmd.map(String).join(" ").trim() : "";
    return text ? turnT()("server-harness.codex.decision.allowAlwaysFor", { what: clip(text) }) : turnT()("server-harness.codex.decision.allowAlways");
  }
  if (kind === "applyNetworkPolicyAmendment") {
    const a = body?.network_policy_amendment || {};
    const host = typeof a.host === "string" ? clip(a.host) : "";
    const deny = a.action === "deny";
    if (host) return deny ? turnT()("server-harness.codex.decision.denyNetworkHost", { host }) : turnT()("server-harness.codex.decision.allowNetworkHost", { host });
    return deny ? turnT()("server-harness.codex.decision.denyNetwork") : turnT()("server-harness.codex.decision.allowNetwork");
  }
  return kind ? turnT()("server-harness.codex.decision.allowKind", { kind: clip(kind, 40) }) : turnT()("server-harness.codex.decision.allow");
}
/** The options a Codex command / file-change approval card offers. Codex's
 *  `availableDecisions` is what its own TUI would show, and 0.165 omits
 *  `decline` (only accept / amendment / cancel). Both response schemas define
 *  `decline` ("the agent will continue the turn"), so Daisy always offers it
 *  (C1-a), before `cancel`, keeping everything Codex offered. */
export function codexApprovalOptions(available: unknown) {
  const decisions: unknown[] =
    Array.isArray(available) && available.length
      ? [...available]
      : ["accept", "acceptForSession", "decline", "cancel"];
  if (!decisions.includes("decline")) {
    const at = decisions.indexOf("cancel");
    decisions.splice(at < 0 ? decisions.length : at, 0, "decline");
  }
  const options = decisions.map((d, i) => ({
    id: typeof d === "string" ? d : `native-${i}`,
    label: codexDecisionLabel(d),
  }));
  return { decisions, options };
}

export function codexDefaultLimit(reportedWindow: number | null | undefined) {
  if (
    typeof reportedWindow !== "number" ||
    !Number.isFinite(reportedWindow) ||
    reportedWindow < CODEX_MIN_REPORTED_WINDOW
  )
    return null;
  const window = Math.round(
    (reportedWindow * 100) / CODEX_REPORTED_WINDOW_PERCENT,
  );
  return {
    window,
    tokens: Math.floor((window * CODEX_DEFAULT_COMPACT_PERCENT) / 100),
  };
}
const k = (n: number) => `${Math.round(n / 1000)}K`;
/** A duration from the environment (tests shorten them), else `fallback`. */
const envMs = (name: `DAISY_${string}`, fallback: number) =>
  Number(daisyEnv(name)) > 0 ? Number(daisyEnv(name)) : fallback;
const minutes = (ms: number) =>
  ms < 60_000
    ? turnT()("server-harness.duration.seconds", { n: Math.max(1, Math.round(ms / 1000)) })
    : turnT()("server-harness.duration.minutes", { n: Math.round(ms / 60_000) });
/**
 * Measured 2026-11-06 on Codex 0.157.1: Codex may send no
 * event for minutes while a turn runs — its remote-compaction retries are
 * silent (a stream idle timeout is 5 min, two retries) — and a turn's
 * end can be missed. A turn silent this long is checked against the
 * thread's own state (thread/read, thread/turns/list).
 */
export const codexQuietMs = () => envMs("DAISY_CODEX_QUIET_MS", 3 * 60_000);
/** Silent this long with nothing running in the turn: interrupted, the job fails. */
export const codexStallMs = () => envMs("DAISY_CODEX_STALL_MS", 30 * 60_000);
/** /compact: first check of the thread after this, then every poll. */
export const codexCompactCheckMs = () =>
  envMs("DAISY_CODEX_COMPACT_CHECK_MS", 120_000);
/** /compact still running after this: interrupted, the job fails. */
export const codexCompactMaxMs = () =>
  envMs("DAISY_CODEX_COMPACT_MAX_MS", 20 * 60_000);
const codexPollMs = () => envMs("DAISY_CODEX_POLL_MS", 15_000);
/**
 * N-2a (C-1 device acceptance, Codex 0.165.0, 2026-11-17): the turn after
 * one that took a `turn/steer` (插队) was answered with a turn id and then
 * showed nothing — no item, no delta — and stayed active until
 * `turn/interrupt`. A turn like that, with no progress this long, is
 * interrupted and its message started again once (see `restartStalled`).
 */
export const codexSteerStallMs = () =>
  envMs("DAISY_CODEX_STEER_STALL_MS", 30_000);
/**
 * 「停止」 not done after this (the turn, its subagents,
 * its commands): the process is ended.
 */
const codexStopKillMs = () =>
  envMs("DAISY_CODEX_STOP_KILL_MS", AGENT_STOP.codex.killAfterMs);
/** turn/start refused because Codex is compacting (measured 0.157.1 error). */
export const COMPACT_BUSY = /ActiveTurnNotSteerable[^}]*Compact/;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Thread statuses that positively say no turn runs (thread/read). A
 * missing / unknown status (an older Codex) says nothing.
 */
const NOT_RUNNING = new Set(["idle", "notLoaded", "systemError"]);
const RUNNING_CHILD = ["running", "pendingInit", "pending", "inProgress"];
/**
 * Where Codex compacts: config/read's model_auto_compact_token_limit
 * (measured: `-c model_auto_compact_token_limit=180000` reads back 180000,
 * no setting reads back null), capped at — or, without a setting, equal
 * to — 90% of the model's context window, which follows from the window
 * Codex reports with each usage update. Always ≈: Codex reports neither
 * the point nor what it compares with it.
 */
export function codexThreshold(
  config: any,
  wanted: number | null,
  launched: number | null,
  reportedWindow: number | null = null,
): ContextThreshold {
  const raw = config?.model_auto_compact_token_limit;
  // config/read failed (null): the only limit known is the one Daisy
  // launched Codex with (-c); without one, Codex's config.toml may hold any
  // limit, so the point is unknown — the 90% default only when Codex
  // answered that no limit is set.
  const assumed = !config && launched !== null;
  const limit = config
    ? typeof raw === "number" && raw > 0
      ? Math.round(raw)
      : null
    : assumed
      ? launched
      : null;
  const cap = codexDefaultLimit(reportedWindow);
  if (limit === null && (!config || !cap))
    return unknownThreshold(
      wanted,
      config
        ? turnT()("server-harness.codex.threshold.noWindowYet")
        : turnT()("server-harness.codex.threshold.noConfigAnswer"),
    );
  const applied =
    wanted === null ? null : limit === null ? false : limit === wanted;
  const reasons: string[] = [];
  if (assumed)
    reasons.push(
      turnT()("server-harness.codex.threshold.assumedFromLaunch", { launched: String(launched) }),
    );
  if (applied === false)
    reasons.push(
      wanted !== launched
        ? turnT()("server-harness.threshold.afterIdleRestart")
        : turnT()("server-harness.codex.threshold.mismatch"),
    );
  let tokens: number, origin: ContextThreshold["origin"], native: string;
  if (limit === null) {
    tokens = cap!.tokens;
    origin = "cli-default";
    native = "codex-default-90pct";
    reasons.push(
      turnT()("server-harness.codex.threshold.default90", { window: k(cap!.window) }),
    );
  } else {
    origin =
      launched !== null && limit === launched ? "identity" : "cli-settings";
    native = assumed
      ? "launch-flag (config/read failed)"
      : "model_auto_compact_token_limit";
    if (cap && limit > cap.tokens) {
      tokens = cap.tokens;
      reasons.push(
        turnT()("server-harness.codex.threshold.overCap", { limit: k(limit), window: k(cap.window), tokens: k(cap.tokens) }),
      );
    } else tokens = limit;
  }
  return {
    tokens,
    source: "config",
    origin,
    enabled: true,
    exact: false,
    window: limit ?? null,
    requested: wanted,
    applied,
    ...(reasons.length ? { reason: reasons.join(turnT()("server-harness.list.separator")).slice(0, 300) } : {}),
    native,
  };
}
const text = (v: unknown) => (typeof v === "string" ? v : "");
/** A turn error, with the way out when Codex refused the model (P6-17). */
const refused = (msg: string) => unsupportedModelHint(msg) ?? msg;
/**
 * Daisy's permission mode for a thread's approval policy and
 * reviewer (auto_review = "auto"); undefined when it is not one.
 */
export function codexModeOf(s: {
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
}): string | undefined {
  if (s.approvalsReviewer === "auto_review") return "auto";
  return typeof s.approvalPolicy === "string" &&
    ["on-request", "untrusted", "never"].includes(s.approvalPolicy)
    ? s.approvalPolicy
    : undefined;
}
/** Codex's alias: config `service_tier = "fast"` runs as "priority". */
const tierId = (v: unknown) => (text(v) === "fast" ? "priority" : text(v));
/**
 * What 默认 means for this process: the effort / tier a thread
 * runs with when Daisy overrides nothing. Effort: config.toml's
 * model_reasoning_effort, else what a fresh thread/start answered (nothing
 * was overridden yet), else the catalog's defaultReasoningEffort for the
 * model (a resumed thread may answer with a saved override). Tier:
 * config.toml's service_tier, else standard ("default").
 */
export function codexBaseline(
  config: any,
  answer: { reasoningEffort?: unknown },
  fresh: boolean,
  catalogEffort?: string,
): { effort?: string; tier: string } {
  const effort =
    text(config?.model_reasoning_effort) ||
    (fresh ? text(answer.reasoningEffort) : "") ||
    catalogEffort ||
    "";
  return {
    ...(effort ? { effort } : {}),
    tier: tierId(config?.service_tier) || "default",
  };
}
/**
 * Whether the thread as thread/start|resume answered already differs from
 * the baseline (a resumed thread restored a saved override), so the next
 * turn must reset it even though 默认 is chosen.
 */
export function codexStartsOverridden(
  answer: { reasoningEffort?: unknown; serviceTier?: unknown },
  baseline: { effort?: string; tier: string },
): { effort: boolean; tier: boolean } {
  const effort = text(answer.reasoningEffort);
  return {
    effort: !!baseline.effort && !!effort && effort !== baseline.effort,
    tier: (tierId(answer.serviceTier) || "default") !== baseline.tier,
  };
}
/**
 * The effort / service tier one turn/start carries. Both stick to
 * the thread ("this turn and subsequent turns"), so going back to 默认
 * ("") after an override sends the baseline (codexBaseline); omitting it
 * would keep the override.
 */
export function codexTurnSettings(
  profile: { reasoningEffort?: string; serviceTier?: string },
  baseline: { effort?: string; tier?: string },
  overridden: { effort: boolean; tier: boolean },
): { effort?: string; serviceTier?: string } {
  const effort =
      profile.reasoningEffort || (overridden.effort ? baseline.effort : ""),
    serviceTier =
      profile.serviceTier ||
      (overridden.tier ? baseline.tier || "default" : "");
  return {
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}
/**
 * P6-17 (outsider acceptance: a fresh install's first turn failed with
 * "The 'gpt-6.2-sol' model is not supported when using Codex with a
 * ChatGPT account."): the model Codex would use on its own (the host
 * config's `model`) checked against this account's own model list
 * (`model/list {includeHidden:true}` — Codex lists what the login can
 * use). Unlisted on a complete list: the list's default (else its first
 * visible model) to start the thread with instead; undefined = keep it
 * (listed, or nothing known: no list, an empty or partial one).
 */
export function codexModelInstead(list: any, model: string): string | undefined {
  const data = Array.isArray(list?.data) ? list.data : [];
  if (!model || !data.length || list?.nextCursor) return undefined;
  const names = (m: any) => [text(m?.model), text(m?.id)].filter(Boolean);
  if (data.some((m: any) => names(m).includes(model))) return undefined;
  const visible = data.filter((m: any) => !m?.hidden && names(m).length);
  const pick = visible.find((m: any) => m?.isDefault === true) ?? visible[0];
  return pick ? names(pick)[0] : undefined;
}
/**
 * Codex app-server, one process per session: the thread is
 * started / resumed once, each job is a `turn/start` on it. Offline the
 * process serves one turn and ends.
 */
export function codexAgent(
  first: RunnerJob,
  cwd: string,
  hooks: LiveHooks,
  live: boolean,
): LiveAgent {
  // ADR-159 §6: this process's words in its session's language (P6-24 stores it on the session).
  const T = () => turnT(first.session?.lang);
  const since = Date.now();
  /**
   * Daisy's tools as Codex dynamic tools (`daisy_<name>`), given
   * at thread/start — Codex keeps them with the thread, also on resume — and
   * the resident's guidance (developer instructions, start and resume).
   * ADR-154: a thread started by the old names (`harbor_<name>`) keeps
   * calling them; a new thread gets the names the control plane says
   * (`jobToolNames`) and records which (`nativeTools` version).
   */
  // a 「只问」 sidecar — read-only sandbox, no Daisy tools.
  const sidecar = isSidecar(first);
  const daisyTools = toolsFor(first);
  const toolNames = jobToolNames(first) ?? "daisy";
  /** Daisy's file checkpoint of the running turn. */
  let checkpoint: TurnCheckpoint | null = null;
  let p!: JsonProcess,
    starting: Promise<void> | null = null,
    started = false,
    closed = false,
    stopping = false,
    root = "",
    cur: Runtime | null = null,
    lastJob = first.id;
  const items = new Items(
    () => cur || { job: { id: lastJob }, emit: hooks.emit },
  );
  /** the identity's limit this process starts with / now wants. */
  const launched = requestedAutoCompact(first);
  let wanted = launched,
    config: any = undefined,
    usageEvents = 0,
    /** Signed in with ChatGPT: the plan quota is this account's. */
    chatgpt = false;
  /**
   * What the thread runs with: thread/start's answer, then
   * each turn's overrides. `overridden`: an identity / conversation value
   * was sent in this process (see codexTurnSettings).
   */
  let threadModel: string | undefined,
    threadEffort: string | undefined,
    threadTier: string | undefined,
    baseline: { effort?: string; tier: string } = { tier: "default" };
  /**
   * the Daisy permission mode the thread runs with (thread/start's
   * answer, then thread/settings/updated, else what a taken turn/start
   * asked), the sandbox the process was launched in, Codex's default model
   * (resolved once; "" = unknown), and how many thread/settings/updated
   * were seen (a report beats an assumption, review L1).
   */
  let modeSent = "",
    /** The model thread/start was given ("" = none), when Codex says none. */
    launchModel = "",
    launchedSandbox = "",
    threadMode: string | undefined,
    defaultModel: string | undefined,
    settingsSeen = 0;
  const overridden = { effort: false, tier: false };
  /**
   * the thread's name as Codex last said it (thread/start|resume
   * `thread.name`, thread/name/updated; Codex 0.157.1 never names a thread
   * itself), Daisy's title as the latest job carried it, and a name Codex
   * refused (not asked again in this process).
   */
  const daisyOf = (job: RunnerJob) => ({
    // Compared as Codex keeps names (review L5).
    title: nativeTitle(job.session.title),
    manual: job.session.titleStage === "manual",
    final: job.session.titleStage === "final",
  });
  let threadName: string | null = null;
  const refusedNames = new Set<string>();
  /**
   * Names this process is setting (re-review L-b): the matching
   * thread/name/updated is Daisy's echo and is consumed by it (it may come
   * before the answer); a failed set removes it. Not permanent: the owner
   * renaming back to such a name later is a rename.
   */
  const echoes = new Set<string>();
  /** Daisy's title and the native renames reported against it. */
  const renames = new NativeRenames(
    daisyOf(first),
    hooks.title && ((t, base) => hooks.title!(t, base)),
  );
  /** Each thread's cumulative token total as last reported. */
  const totals = new Map<string, number>();
  const meter = new ContextMeter(
    items,
    "codex",
    unknownThreshold(launched, T()("server-harness.threshold.noDataYet")),
  );
  const published = new Set<string>();
  // The attached turn.
  let resolve: () => void = () => {},
    reject: (e: Error) => void = () => {},
    done = true,
    rootCompleted = false,
    turnId: string | undefined,
    media: Promise<void>[] = [],
    compactDone: (() => void) | null = null,
    interruptTimer: ReturnType<typeof setTimeout> | undefined,
    /** the check that a stop's subagents / commands ended. */
    scopeTimer: ReturnType<typeof setTimeout> | undefined,
    /** Last message of any kind from Codex (the watchdog's clock). */
    heard = Date.now(),
    /** Reverse requests Daisy is serving (approval, Daisy tool): not Codex's silence. */
    daisyWaits = 0,
    /** Since when the trace says Codex is silent (0 = it does not). */
    quietShown = 0,
    /** A turn not this job's runs (a compaction it waits for): its end is not this job's. */
    othersTurn = false,
    /** Since when Codex compacts within this turn (0 = it does not). */
    compactingSince = 0;
  /**
   * Items Codex started and has not completed yet (this turn, any thread).
   * Measured 0.157.1: thread/turns/list does not list a running turn's
   * in-progress items (a `sleep 20` command was absent until it ended), so
   * only the event stream says something is executing.
   */
  const open = new Map<string, string>();
  const children = new Map<string, string>();
  /**
   * Root turns earlier jobs left (ended, failed, interrupted, gave up on):
   * their late turn/completed or error — e.g. after an interrupt, or a
   * compaction Daisy stopped waiting for — is not the next job's.
   */
  const left = new Set<string>();
  /**
   * N-2a: the previous root turn took a steer; this turn took one; this
   * turn showed progress (an item or a delta, any thread); a stalled turn
   * being interrupted, whose end is awaited.
   */
  /** N-4: root-thread token updates seen (a compaction's after-size). */
  let rootUsage = 0;
  let steeredLast = false,
    steeredNow = false,
    progressed = false,
    endWait: { id: string; done: () => void } | null = null;
  /**
   * what the attached turn started, for 「停止」 — the subagent
   * turns running (child thread → its turn: Codex's `turn/interrupt`
   * needs the turn id) and the unified-exec commands still running
   * (thread → command item ids; Codex lists them as background terminals
   * once interrupted). A fresh object per turn: a stop still finishing
   * after its turn ended keeps its own.
   */
  type TurnScope = {
    childTurns: Map<string, string>;
    commands: Map<string, Set<string>>;
    /** subAgentActivity items applied (a replayed one is not re-applied). */
    activity: Set<string>;
  };
  const newScope = (): TurnScope => ({
    childTurns: new Map(),
    commands: new Map(),
    activity: new Set(),
  });
  let scope = newScope();
  /** the app-server's version (initialize userAgent). */
  let cliVersion: string | undefined;
  /** Codex's own background commands (「后台」, stoppable one by one). */
  const terminals = new CodexTerminals({
    request: (method, params, ms) =>
      p && !closed ? p.request(method, params, ms) : Promise.reject(),
    root: () => root || null,
    running: () => (cur && !done ? scope.commands : null),
    changed: () => hooks.changed(),
    pid: () => p?.child.pid,
    // Not below the measured version (no list polling there).
    enabled: () => nativeReviewAt("codex", cliVersion),
  });
  /**
   * the owner's 「允许并重试」 of refused actions, natively, before
   * the turn / appended input that retries them (Codex adds a developer
   * message its reviewer reads) — in the thread that was refused: the
   * session's, or a subagent's while it is still loaded (else skipped: the
   * retry is reviewed as usual). Each ends in a `native-approval:<id>`
   * stage (complete / error), which tells Daisy it was handled. Resolves
   * the line the retrying turn's text gets when any went through (never
   * claimed otherwise).
   */
  const approveNative = async (
    rt: Runtime,
    list: RunnerJob["nativeApprovals"],
  ): Promise<string> => {
    let any = false;
    for (const a of list || []) {
      if (a?.kind !== "codexGuardianDenial") continue;
      if (!root) {
        // Not handled: Daisy offers it again with the next turn.
        stage(
          rt,
          `native-approval-wait:${a.id}`,
          T()("server-harness.codex.guardian.notReady"),
          "complete",
        );
        continue;
      }
      const thread = a.threadId && a.threadId !== root ? a.threadId : root;
      if (thread !== root) {
        const r = await p
          .request("thread/read", { threadId: thread }, 5000)
          .catch(() => null);
        if (!["idle", "active"].includes(r?.thread?.status?.type)) {
          stage(
            rt,
            `native-approval:${a.id}`,
            T()("server-harness.codex.guardian.childGone"),
            "error",
          );
          continue;
        }
      }
      const ok = await p
        .request(
          "thread/approveGuardianDeniedAction",
          { threadId: thread, event: a.event },
          5000,
        )
        .then(
          () => true,
          () => false,
        );
      any ||= ok;
      stage(
        rt,
        `native-approval:${a.id}`,
        ok
          ? thread !== root
            ? T()("server-harness.codex.guardian.passedChild")
            : T()("server-harness.codex.guardian.passed")
          : T()("server-harness.codex.guardian.notPassed"),
        ok ? "complete" : "error",
      );
    }
    return any
      ? T()("server-harness.codex.guardian.modelNote")
      : "";
  };
  /** A subagent's name (subAgentActivity agentPath), by thread. */
  const childNames = new Map<string, string>();
  const childName = (id: string) =>
    T()("server-harness.subagent.named", { name: childNames.get(id) || id.slice(0, 8) });
  const finish = () => {
    if (
      !done &&
      rootCompleted &&
      ![...children.values()].some((x) =>
        ["running", "pendingInit", "pending", "inProgress"].includes(x),
      )
    ) {
      done = true;
      items.finish();
      resolve();
    }
  };
  const reverse = async (m: any) => {
    const x = m.params || {};
    const rt = cur;
    if (!rt) {
      p.reject(m.id, "No active Daisy turn");
      return;
    }
    daisyWaits++;
    try {
      if (m.method === "item/tool/call") {
        // ADR-154: `daisy_<name>`, or `harbor_<name>` on an older thread.
        const name = bareToolName(String(x.tool || ""));
        // a forked sidecar thread may still list Daisy's tools
        // (they stay with the thread); a sidecar never runs them. P4N-4:
        // said so the model does not take it for "no way to read files"
        // (it answered that once, then listed the directory itself).
        const r = sidecar
          ? { ok: false, text: sidecarToolRefusal(first.session?.lang) }
          : rt.tools
            ? await rt.tools.call(rt, name, x.arguments)
            : { ok: false, text: T()("server-harness.tools.unavailable") };
        p.respond(m.id, {
          success: r.ok,
          contentItems: [{ type: "inputText", text: r.text }],
        });
        return;
      }
      if (m.method === "item/tool/requestUserInput") {
        const d = await rt.approve(
          T()("server-harness.codex.card.question"),
          x,
          [{ id: "submit", label: T()("server-harness.card.submitAnswer") }],
          { category: "question" },
        );
        p.respond(m.id, {
          answers: Object.fromEntries(
            (x.questions || []).map((q: any) => [
              q.id,
              { answers: [d.answers?.[q.id] || ""] },
            ]),
          ),
        });
        return;
      }
      if (
        [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
        ].includes(m.method)
      ) {
        const { decisions, options } = codexApprovalOptions(
          x.availableDecisions,
        );
        const d = await rt.approve(
          m.method.includes("command") ? T()("server-harness.codex.card.command") : T()("server-harness.codex.card.fileChange"),
          x,
          options,
          {
            category: "permission",
            ...(typeof x.reason === "string" ? { reason: x.reason } : {}),
          },
        );
        const index = options.findIndex((o: any) => o.id === d.optionId);
        if (index < 0) throw Error(T()("server-harness.card.badOption"));
        p.respond(m.id, { decision: decisions[index] });
        return;
      }
      if (m.method === "item/permissions/requestApproval") {
        const d = await rt.approve(
          T()("server-harness.codex.card.permissions"),
          x,
          [
            { id: "allow", label: T()("server-harness.card.allowTurn") },
            { id: "deny", label: T()("server-harness.card.deny") },
          ],
          {
            category: "permission",
            ...(typeof x.reason === "string" ? { reason: x.reason } : {}),
          },
        );
        p.respond(m.id, {
          permissions: d.optionId === "allow" ? x.permissions : {},
          scope: "turn",
        });
        return;
      }
      if (m.method === "mcpServer/elicitation/request") {
        const normalize = (v: any): any =>
          Array.isArray(v)
            ? v.map(normalize)
            : v && typeof v === "object"
              ? Object.fromEntries(
                  Object.entries(v)
                    .filter(
                      ([k, value]) =>
                        value !== null || ["default", "const"].includes(k),
                    )
                    .map(([k, value]) => [k, normalize(value)]),
                )
              : v;
        const form = normalize(x.requestedSchema || x.schema);
        const validate = form
          ? new (form.$schema?.includes("2020-12") ? Ajv2020 : Ajv)({
              strict: false,
              allErrors: true,
              validateFormats: false,
            }).compile(form)
          : null;
        let validation = "";
        while (!rt.signal.aborted) {
          const d = await rt.approve(
            T()("server-harness.codex.card.mcp"),
            {
              ...x,
              validation,
              questions: form
                ? [
                    {
                      id: "json",
                      question:
                        T()("server-harness.codex.card.mcpQuestion"),
                    },
                  ]
                : [],
            },
            [
              { id: "accept", label: T()("server-harness.card.confirmSubmit") },
              { id: "decline", label: T()("server-harness.card.deny") },
              { id: "cancel", label: T()("server-harness.card.cancel") },
            ],
            { category: "question" },
          );
          let content: any = null;
          if (d.optionId === "accept" && form) {
            try {
              content = JSON.parse(d.answers?.json || "{}");
              if (
                !content ||
                typeof content !== "object" ||
                Array.isArray(content)
              )
                throw Error(T()("server-harness.card.needJsonObject"));
              if (validate && !validate(content))
                throw Error(JSON.stringify(validate.errors));
            } catch (e: any) {
              validation = e.message;
              continue;
            }
          }
          p.respond(m.id, { action: d.optionId, content });
          return;
        }
        return;
      }
      items.set(`unsupported:${m.id}`, {
        kind: "tool",
        category: "native",
        name: T()("server-harness.item.unsupportedRequest"),
        input: x,
        text: m.method,
        status: "error",
      });
      p.reject(
        m.id,
        `Daisy does not support ${m.method}; request was not executed`,
      );
    } catch (e) {
      if (!rt.signal.aborted) reject(e as Error);
    } finally {
      daisyWaits--;
      heard = Date.now();
    }
  };
  const onItem = (i: any, threadId: string, finished: boolean) => {
    const rt = cur!;
    // what the edit tool changed (any thread of the turn) —
    // completed patches only (a declined / failed one changed nothing).
    if (i.type === "fileChange" && finished) checkpoint?.fileChange(i);
    if (
      i.type === "imageGeneration" &&
      finished &&
      i.result &&
      !published.has(i.id)
    ) {
      published.add(i.id);
      const data = String(i.result),
        mime = data.startsWith("/9j/")
          ? "image/jpeg"
          : data.match(/^data:(image\/[a-z]+);base64,/)?.[1] || "image/png";
      trackMedia(media, publishImage(rt, i.id, mime, data));
      i = { ...i, result: T()("server-harness.item.imageAsAttachment") };
    }
    const child = threadId !== root,
      key = `${threadId}:${i.id}`,
      meta = {
        threadId,
        ...(child ? { category: "subagent" as const, parentId: root } : {}),
        native: i,
      };
    if (i.type === "agentMessage")
      items.set(key, {
        ...meta,
        kind: child ? "tool" : "assistant",
        name: child ? T()("server-harness.item.subagentReply") : undefined,
        text: i.text || "",
        status: finished ? "complete" : "streaming",
      });
    else if (i.type === "reasoning")
      items.set(key + ":reasoning", {
        ...meta,
        kind: "thinking",
        text: asText(i.summary || i.content || ""),
        status: finished ? "complete" : "streaming",
      });
    else if (i.type === "subAgentActivity") {
      // Measured on 0.157.1, gpt-6 models: a subagent is reported
      // as subAgentActivity {kind, agentThreadId, agentPath} on the
      // parent's thread, not as collabAgentToolCall spawnAgent (gpt-5.x
      // models still use that). Each item once: thread/read replays them.
      const id = String(i.agentThreadId || "");
      if (!id || id === root || scope.activity.has(i.id)) return;
      if (i.id) scope.activity.add(i.id);
      // Only the kinds measured; another leaves the state as it was.
      const state =
        i.kind === "completed"
          ? "completed"
          : i.kind === "interrupted"
            ? "interrupted"
            : ["started", "interacted"].includes(i.kind)
              ? "running"
              : children.get(id);
      if (!state) return;
      const path = String(i.agentPath || "")
        .split("/")
        .filter(Boolean)
        .pop();
      if (path && path !== "root") childNames.set(id, path);
      children.set(id, state);
      items.set(`child:${id}`, {
        kind: "tool",
        category: "subagent",
        threadId: id,
        parentId: root,
        name: childName(id),
        input: { agentPath: i.agentPath },
        native: i,
        status:
          state === "running"
            ? "running"
            : state === "completed"
              ? "complete"
              : "error",
      });
      finish();
    } else if (i.type !== "userMessage") {
      items.set(key, {
        ...meta,
        kind: "tool",
        name:
          i.type === "collabAgentToolCall"
            ? T()("server-harness.subagent.named", { name: String(i.tool) })
            : i.type === "contextCompaction"
              ? finished
                ? T()("server-harness.item.compaction")
                : T()("server-harness.item.compacting")
              : // Daisy's tools by their own names.
                i.type === "dynamicToolCall"
                ? String(i.tool || i.type)
                : i.type,
        input: i.command || i.changes || i.arguments || i.query || i.prompt,
        text: asText(
          i.aggregatedOutput ??
            i.result ??
            i.output ??
            i.agentsStates ??
            (Array.isArray(i.contentItems)
              ? i.contentItems.map((c: any) => c.text || "").join("\n")
              : ""),
        ),
        status: ["failed", "errored", "declined"].includes(i.status)
          ? "error"
          : finished
            ? "complete"
            : "running",
        ...(i.type === "collabAgentToolCall"
          ? { category: "subagent" as const }
          : {}),
      });
      if (i.type === "collabAgentToolCall") {
        for (const id of i.receiverThreadIds || [])
          if (id !== root && !children.has(id)) children.set(id, "running");
        for (const [id, state] of Object.entries(i.agentsStates || {}) as [
          string,
          any,
        ][]) {
          if (id === root) continue;
          children.set(id, state.status);
          items.set(`child:${id}`, {
            kind: "tool",
            category: "subagent",
            threadId: id,
            parentId: root,
            name: childName(id),
            text: state.message || "",
            input: { model: i.model, reasoningEffort: i.reasoningEffort },
            native: state,
            status: ["completed", "shutdown"].includes(state.status)
              ? "complete"
              : ["errored", "notFound"].includes(state.status)
                ? "error"
                : "running",
          });
        }
      }
    }
  };
  /**
   * Daisy jobs steered into this turn, by clientUserMessageId.
   * `turn/steer` answering is "received"; the `userMessage` item echoing
   * the id as `clientId` is "absorbed" (codex 0.157.1, measured). Not
   * absorbed when the turn ends → handed back to Daisy's queue.
   */
  const appended = new Map<
    string,
    { native: NativeInput; requeue: (reason: string) => void; read: boolean }
  >();
  const onMessage = (m: any) => {
    const x = m.params || {};
    heard = Date.now();
    // N-2a: anything Codex does in the turn (not the echo of the message).
    if (
      typeof m.method === "string" &&
      m.method.startsWith("item/") &&
      x.item?.type !== "userMessage"
    )
      progressed = true;
    if (m.method === "turn/completed" && endWait && x.turn?.id === endWait.id)
      endWait.done();
    if (
      m.method === "item/started" &&
      x.item?.type === "userMessage" &&
      typeof x.item.clientId === "string"
    ) {
      const a = appended.get(x.item.clientId);
      if (a && !a.read) {
        a.read = true;
        a.native.report("started");
      }
    }
    if (quietShown && cur && !done) {
      items.set("codex-quiet", {
        kind: "tool",
        category: "native",
        name: T()("server-harness.codex.item.resumed"),
        text: T()("server-harness.codex.item.resumedText", { duration: minutes(heard - quietShown) }),
        status: "complete",
      });
      quietShown = 0;
    }
    if (m.id !== undefined && m.method) {
      void reverse(m);
      return;
    }
    agent.lastActivity = Date.now();
    if (m.method === "thread/name/updated" && x.threadId === root && root)
      threadNamed(x.threadName, false);
    // what the root thread runs with now (0.157.1 sends it after
    // a turn/start that overrides settings).
    if (
      m.method === "thread/settings/updated" &&
      x.threadId === root &&
      x.threadSettings
    ) {
      const ts = x.threadSettings;
      settingsSeen++;
      if (typeof ts.model === "string" && ts.model)
        threadModel = ts.model.slice(0, 200);
      // Review L1: what Codex says it runs with is what the next turn is
      // compared with — an override it dropped is sent again.
      const reported = codexModeOf(ts);
      if (reported) modeSent = reported;
      if (!sidecar) threadMode = reported ?? threadMode;
    }
    // The turn this job runs, when Codex starts it itself (/compact answers
    // `{}`; its turn id comes with turn/started).
    if (
      m.method === "turn/started" &&
      cur &&
      !done &&
      !turnId &&
      (x.threadId || root) === root
    )
      turnId = x.turn?.id;
    if (
      x.item?.type === "contextCompaction" &&
      (x.threadId || root) === root &&
      ["item/started", "item/completed"].includes(m.method)
    )
      compactingSince = m.method === "item/started" ? Date.now() : 0;
    if (
      ["item/started", "item/completed"].includes(m.method) &&
      x.item?.id &&
      x.item.type !== "userMessage"
    ) {
      const key = `${x.threadId || root}:${x.item.id}`;
      if (m.method === "item/started") open.set(key, String(x.item.type));
      else open.delete(key);
    }
    if (
      m.method === "thread/compacted" ||
      (m.method === "item/completed" && x.item?.type === "contextCompaction")
    ) {
      // Codex compacting by itself mid-turn (not /compact) is shown too.
      // Not while a message waits for another turn's compaction (that
      // compaction is not this message's).
      if (
        !compactDone &&
        !othersTurn &&
        cur &&
        !done &&
        m.method === "item/completed"
      ) {
        // N-4: the size before is the last count Codex gave (its next
        // token update gives the size after, on the context ring).
        const auto = {
          trigger: "auto",
          ...(meter.used >= 0 ? { preTokens: meter.used } : {}),
        };
        compactNotice(items, `auto:${x.item?.id || usageEvents}`, auto);
        meter.compacted(auto);
        meter.emit();
      }
      compactDone?.();
    }
    // a command ended — the background list may have changed.
    if (m.method === "item/completed" && x.item?.type === "commandExecution")
      terminals.ended(x.threadId || root, String(x.item.id || ""));
    // Codex's automatic review refused an action (UNSTABLE): the
    // owner's interception card, as Claude Code's permission_denied — also
    // one that ends after the turn (a subagent still running): it goes out
    // on the session channel.
    if (m.method === "item/autoApprovalReview/completed") {
      const r = reviewInterception(x, root);
      if (r) items.set(r.key, r.item);
    }
    // Codex does not start turns by itself: between turns there is nothing
    // to show.
    if (!cur || done) return;
    // Codex answered this turn (or a subagent's) with another model.
    if (m.method === "model/rerouted") {
      const s = codexModelSwitch(x);
      if (s)
        items.set(`model-switch:${x.threadId || root}:${x.turnId || ""}`, {
          ...modelSwitchItem(s),
          ...((x.threadId || root) !== root
            ? {
                category: "subagent" as const,
                threadId: x.threadId,
                parentId: root,
              }
            : {}),
        });
    }
    const tid = x.threadId || root,
      child = tid !== root,
      key = `${tid}:${x.itemId}`;
    // what this turn started (any thread), for 「停止」.
    if (child && m.method === "turn/started" && x.turn?.id)
      scope.childTurns.set(tid, x.turn.id);
    if (
      child &&
      m.method === "turn/completed" &&
      (!x.turn?.id || scope.childTurns.get(tid) === x.turn.id)
    )
      scope.childTurns.delete(tid);
    if (x.item?.type === "commandExecution" && x.item.id) {
      if (m.method === "item/started") {
        let ids = scope.commands.get(tid);
        if (!ids) scope.commands.set(tid, (ids = new Set()));
        ids.add(String(x.item.id));
        terminals.noteThread(tid);
      } else if (m.method === "item/completed")
        scope.commands.get(tid)?.delete(String(x.item.id));
    }
    if (m.method === "item/agentMessage/delta") {
      items.delta(key, x.delta, child ? "tool" : "assistant");
      if (child)
        items.set(key, {
          category: "subagent",
          threadId: tid,
          parentId: root,
          name: T()("server-harness.item.subagentReply"),
        });
    }
    if (
      ["item/reasoning/summaryTextDelta", "item/reasoning/textDelta"].includes(
        m.method,
      )
    )
      items.delta(key + ":reasoning", x.delta, "thinking");
    if (m.method === "item/commandExecution/outputDelta")
      items.delta(key, x.delta, "tool");
    if (["item/started", "item/completed"].includes(m.method))
      // /compact shows its own 「正在压缩上下文」.
      if (!(compactDone && x.item?.type === "contextCompaction"))
        onItem(x.item || {}, tid, m.method === "item/completed");
    if (m.method === "turn/plan/updated")
      items.set(`plan:${tid}`, {
        kind: "tool",
        category: "plan",
        name: T()("server-harness.item.plan"),
        threadId: tid,
        input: x.plan,
        text: x.explanation || "",
        status: x.plan?.every((s: any) => s.status === "completed")
          ? "complete"
          : "running",
      });
    if (m.method === "thread/tokenUsage/updated") {
      const last = x.tokenUsage?.last,
        total = x.tokenUsage?.total?.totalTokens;
      // Cache hit rate: each update is one response's usage;
      // inputTokens includes the cached part. The same update repeated
      // (the thread's cumulative total did not move) is counted once
      // (review N7); without a total every update counts.
      const repeat = typeof total === "number" && totals.get(tid) === total;
      if (typeof total === "number") totals.set(tid, total);
      if (last && !repeat)
        meter.call(`${tid}:${++usageEvents}`, {
          prompt: last.inputTokens || 0,
          read: last.cachedInputTokens || 0,
          write:
            typeof last.cacheWriteInputTokens === "number"
              ? last.cacheWriteInputTokens
              : null,
        });
      if (last && tid === root) {
        rootUsage++;
        meter.used =
          last.totalTokens ??
          (last.inputTokens || 0) + (last.outputTokens || 0);
        // An update without the window keeps the last one (no flicker
        // back to 「不可用」).
        const w = x.tokenUsage.modelContextWindow;
        if (typeof w === "number" && w > 0) meter.window = w;
        // The default point (and the cap) follow from the window.
        if (config !== undefined)
          meter.threshold = codexThreshold(
            config,
            wanted,
            launched,
            meter.window,
          );
      }
      if (last) meter.emit();
    }
    if (m.method === "account/rateLimits/updated" && chatgpt) {
      const snap = fromCodexRateLimits(cur.job.profile.id, x);
      if (snap) quotaItem(items, snap, cur.job.profile.label);
    }
    if (m.method === "turn/diff/updated")
      items.set(`diff:${tid}`, {
        kind: "tool",
        name: T()("server-harness.item.fileChanges"),
        threadId: tid,
        text: x.diff || "",
        status: "complete",
      });
    // The raw rate-limit notification (credits, plan, spend) is not
    // forwarded: the plan quota goes out only as the owner-only
    // `<jid>:quota` snapshot above (review N item 2).
    if (m.method === "thread/tokenUsage/updated")
      items.set(`usage:${m.method}:${tid}`, {
        kind: "tool",
        category: "usage",
        name: T()("server-harness.item.contextUsage"),
        text: asText(x),
        status: "complete",
      });
    if (m.method === "item/mcpToolCall/progress")
      items.set(key, {
        kind: "tool",
        name: T()("server-harness.item.mcpTool"),
        text: x.message || asText(x),
        status: "running",
      });
    // another root turn's end (a /compact Daisy stopped
    // waiting for) is not this job's.
    const otherTurn = (id: unknown) =>
      !child &&
      (othersTurn ||
        (typeof id === "string" &&
          !!id &&
          (left.has(id) || (!!turnId && id !== turnId))));
    if (m.method === "turn/completed" && !otherTurn(x.turn?.id)) {
      if (child) {
        children.set(
          tid,
          x.turn?.status === "completed"
            ? "completed"
            : x.turn?.status || "completed",
        );
        if (items.map.has(items.id(`child:${tid}`)))
          items.set(`child:${tid}`, {
            status: x.turn?.status === "completed" ? "complete" : "error",
          });
        finish();
        return;
      }
      if (x.turn?.status === "failed")
        reject(Error(refused(x.turn?.error?.message || "Codex turn failed")));
      else if (x.turn?.status === "interrupted")
        reject(Error(T()("server-harness.codex.turnInterrupted")));
      else {
        rootCompleted = true;
        finish();
      }
    }
    const handled = new Set([
      "item/agentMessage/delta",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/textDelta",
      "item/commandExecution/outputDelta",
      "item/started",
      "item/completed",
      "turn/plan/updated",
      "turn/diff/updated",
      "thread/tokenUsage/updated",
      "account/rateLimits/updated",
      "item/mcpToolCall/progress",
      "turn/started",
      "turn/completed",
      "thread/name/updated",
      "error",
    ]);
    if (m.method && !handled.has(m.method))
      items.set(`native:${tid}:${m.method}`, {
        kind: "tool",
        category: "native",
        name: m.method,
        threadId: tid,
        text: asText(x).slice(0, 20000),
        status: "complete",
      });
    if (m.method === "error") {
      items.set(`error:${tid}`, {
        kind: "tool",
        category: "native",
        name: x.willRetry ? T()("server-harness.item.retrying") : T()("server-harness.item.nativeError"),
        text: x.error?.message || asText(x),
        status: x.willRetry ? "running" : "error",
      });
      if (!x.willRetry && !child && !otherTurn(x.turnId))
        reject(Error(refused(x.error?.message || "Codex error")));
    }
  };
  const start = async (rt: Runtime) => {
    stage(rt, "launch", T()("server-harness.codex.stage.launch"), "running");
    p = new JsonProcess(
      daisyEnv("DAISY_CODEX_BIN") || "codex",
      [
        "app-server",
        // the identity's limit, for this process only.
        ...(launched !== null
          ? [
              "-c",
              `model_auto_compact_token_limit=${launched}`,
              "-c",
              'model_auto_compact_token_limit_scope="total"',
            ]
          : []),
      ],
      {
        cwd,
        env: agentEnv(rt.job),
        readOnly: readOnlyLaunch(rt.job, cwd),
      },
    );
    p.onMessage = onMessage;
    p.onExit = (e) => {
      const unexpected = !stopping;
      closed = true;
      clearTimeout(interruptTimer);
      clearTimeout(scopeTimer);
      if (!done) reject(e);
      else if (unexpected)
        hooks.closed(T()("server-harness.processExited", { name: "Codex", error: e.message.slice(0, 200) }));
    };
    const initialized = await p.request("initialize", {
      clientInfo: {
        name: "daisy",
        title: PRODUCT_NAME,
        version: "0.2.0",
      },
      capabilities: { experimentalApi: true },
    });
    p.send({ method: "initialized", params: {} });
    // "<client>/<version> (…)" — which experimental APIs to use.
    cliVersion = /\/(\d+\.\d+\.\d+)/.exec(
      String(initialized?.userAgent || ""),
    )?.[1];
    stage(rt, "launch", T()("server-harness.codex.stage.connected"), "complete", asText(initialized));
    try {
      config = (await p.request("config/read", {}, 5000))?.config ?? null;
    } catch {
      config = null;
    }
    meter.threshold = codexThreshold(config, wanted, launched, meter.window);
    stage(rt, "auth", T()("server-harness.stage.checkSubscription"), "running");
    const account = await p.request("account/read", { refreshToken: false });
    if (
      rt.job.profile.authMode === "subscription" &&
      account.account?.type !== "chatgpt"
    )
      throw Error(
        T()("server-harness.codex.needChatgpt"),
      );
    stage(rt, "auth", T()("server-harness.stage.subscriptionOk"));
    // Plan quota: read once per process in the background, kept
    // current by account/rateLimits/updated during turns.
    chatgpt = account.account?.type === "chatgpt";
    if (chatgpt) {
      const pid = rt.job.profile.id,
        label = rt.job.profile.label;
      p.request("account/rateLimits/read", {}, 15000).then(
        (r) => {
          const snap = fromCodexRateLimits(pid, r);
          if (snap && !closed) quotaItem(items, snap, label);
        },
        () => {},
      );
    }
    // "auto" = Codex's automatic review (CLI --approve-for-me):
    // approval requests go to Codex's risk-reviewing subagent (auto_review)
    // instead of the user; commands still run in the profile's sandbox.
    const mode = rt.job.profile.permissionMode || "on-request",
      autoReview = mode === "auto";
    modeSent = mode;
    // P6-17: no model chosen in Daisy (a host-login identity names none):
    // the host config's, unless this account's own list lacks it.
    let instead: { from: string; to: string } | null = null;
    const configured = text(config?.model);
    if (!rt.job.profile.model && !sidecar && configured)
      try {
        const to = codexModelInstead(
          await p.request("model/list", { limit: 100, includeHidden: true }, 5000),
          configured,
        );
        if (to) {
          instead = { from: configured.slice(0, 200), to: to.slice(0, 200) };
          // "Default" from now on means the usable one.
          defaultModel = instead.to;
        }
      } catch {
        // No list: Codex's own choice stands.
      }
    const startModel = rt.job.profile.model || instead?.to || "";
    launchModel = startModel;
    launchedSandbox = rt.job.profile.sandboxMode || "workspace-write";
    threadMode = sidecar ? undefined : mode;
    // a sidecar's first turn forks its main session's thread;
    // every turn, throwaway (`ephemeral`), where Codex can.
    const forked = sidecar ? codexSidecarFork(rt.job) : null;
    const fork = forked?.threadId;
    // the developer instructions — of the job that
    // opens the thread now (two jobs of one process key may hold different
    // org cores with the layered prompt: the newest goes in).
    const guide = sidecar ? sidecarGuide(rt.job) : launchGuide(rt.job);
    const result = await p
      .request(
        fork
          ? "thread/fork"
          : rt.job.session.nativeId
            ? "thread/resume"
            : "thread/start",
        {
          cwd,
          modelProvider: "openai",
          approvalPolicy: autoReview ? "on-request" : mode,
          approvalsReviewer: autoReview ? "auto_review" : "user",
          sandbox: rt.job.profile.sandboxMode || "workspace-write",
          // read-only, nothing escalates (fork / start / resume).
          ...(sidecar ? CODEX_SIDECAR : {}),
          ...(startModel ? { model: startModel } : {}),
          // "priority" = Fast; "default" = standard speed.
          ...(rt.job.profile.serviceTier
            ? { serviceTier: rt.job.profile.serviceTier }
            : {}),
          ...(fork
            ? {
                threadId: fork,
                excludeTurns: true,
                ...(forked?.ephemeral ? { ephemeral: true } : {}),
              }
            : rt.job.session.nativeId
              ? // Only thread.id is used: do not ship the whole history back
                // (a long thread's history exceeded the transport's frame limit).
                { threadId: rt.job.session.nativeId, excludeTurns: true }
              : daisyTools.length
                ? {
                    dynamicTools: daisyTools.map((t) => ({
                      type: "function",
                      name: toolId("codex", t.name, toolNames),
                      description: t.description,
                      inputSchema: t.inputSchema,
                    })),
                  }
                : {}),
          ...(guide ? { developerInstructions: guide } : {}),
        },
      )
      .catch((e: Error) => {
        // The same thread open in another Codex process
        // (Codex app / remote-control app-server) holds the writer lock.
        if (/already has an active writer/i.test(e?.message || ""))
          throw Error(
            T()("server-harness.codex.writerLocked"),
          );
        throw e;
      });
    if (result.modelProvider && result.modelProvider !== "openai")
      throw Error(T()("server-harness.codex.otherProvider"));
    root = result.thread.id;
    // Codex writes the developer instructions into a thread when
    // it starts; resume and fork keep that text until a compaction
    // (measured 0.157.1, docs/prompt-layers-stage0). A changed layered
    // prompt therefore goes into a resumed / forked thread as one
    // developer message — once per text (`session.nativeGuide`).
    const layered = layeredGuide(rt.job);
    const opened: LaunchAudit["mode"] = fork
      ? "fork"
      : rt.job.session.nativeId
        ? "resume"
        : "start";
    const had = rt.job.session.nativeGuide;
    const current =
      !!layered && had?.thread === root && had.sha256 === layered.sha256;
    let delivery: LaunchAudit["delivery"] = !guide
      ? "unknown"
      : opened === "start"
        ? "launch"
        : current
          ? "injected"
          : "recorded";
    let deliveryNote = current ? T()("server-harness.codex.guide.current") : "";
    if (layered && guide && opened !== "start" && !current) {
      if (!promptRefreshAt("codex", cliVersion))
        deliveryNote =
          T()("server-harness.codex.guide.untested");
      else
        try {
          await p.request(
            "thread/inject_items",
            {
              threadId: root,
              items: [
                {
                  type: "message",
                  role: "developer",
                  content: [
                    {
                      type: "input_text",
                      text: `${(sidecar ? guideSidecarHead : guideUpdateHead)(sessionT(rt.job.session))}\n${guide}`,
                    },
                  ],
                },
              ],
            },
            8000,
          );
          delivery = "injected";
        } catch (e: any) {
          deliveryNote = T()("server-harness.codex.guide.failed", { error: String(e?.message || e).slice(0, 160) });
        }
    }
    launchAudit(rt, {
      guide,
      mode: opened,
      delivery,
      ...(deliveryNote ? { note: deliveryNote } : {}),
      args: ["app-server", fork ? "thread/fork" : `thread/${opened}`],
      engine: { name: "codex", version: cliVersion },
      cwd,
      tools: daisyTools,
    });
    const guideDelivered =
      !!layered && !!guide && (opened === "start" || delivery === "injected");
    if (!fork) threadNamed(result.thread?.name, true);
    const said = (v: unknown) =>
      typeof v === "string" && v ? v.slice(0, 200) : undefined;
    threadModel = said(result.model);
    modeSent = codexModeOf(result) ?? modeSent;
    if (!sidecar) threadMode = codexModeOf(result) ?? threadMode;
    threadEffort = said(result.reasoningEffort);
    threadTier = said(result.serviceTier);
    // what 默认 means here; a resumed thread may come back
    // with a saved override, which the next turn then resets.
    const fresh = !rt.job.session.nativeId;
    baseline = codexBaseline(config, result, fresh);
    if (!baseline.effort) {
      const model = threadModel || text(config?.model);
      try {
        const list = await p.request("model/list", { limit: 100 }, 5000);
        baseline = codexBaseline(
          config,
          result,
          fresh,
          text(catalogModel(list?.data, model)?.defaultReasoningEffort),
        );
      } catch {
        // Unknown: 默认 then leaves an earlier effort override in place.
      }
    }
    // P4N-3: a thread resumed without some of the tools Daisy gives now
    // (started before they existed): the owner is told once per thread and
    // set of names, in the conversation (the model is told by its guide).
    const missing = fresh
      ? null
      : missingThreadTools(
          { ...rt.job.session, nativeId: root },
          daisyTools.map((t) => t.name),
        );
    const told = rt.job.session.nativeToolsNotice;
    const lacking =
      missing?.names.length &&
      !(
        told?.thread === root &&
        missing.names.every((n) => told.names.includes(n))
      )
        ? missing
        : null;
    if (instead)
      rt.emit("item", {
        id: `${rt.job.id}:model-instead`,
        kind: "notice",
        category: "lifecycle",
        name: T()("server-harness.codex.modelInsteadTitle"),
        text: T()("server-harness.codex.modelInstead", instead),
        status: "complete",
        createdAt: Date.now(),
      });
    if (lacking)
      rt.emit("item", {
        id: `${rt.job.id}:tools-missing`,
        kind: "notice",
        category: "lifecycle",
        name: T()("server-harness.item.toolsMissing"),
        text: missingToolsNotice(lacking, sessionT(rt.job.session)),
        status: "complete",
        createdAt: Date.now(),
      });
    const restored = codexStartsOverridden(result, baseline);
    overridden.effort ||= restored.effort;
    overridden.tier ||= restored.tier || !!rt.job.profile.serviceTier;
    rt.emit("native", {
      nativeId: root,
      ...(threadModel ? { model: threadModel } : {}),
      ...(rt.job.profile.reasoningEffort || threadEffort
        ? { effort: rt.job.profile.reasoningEffort || threadEffort }
        : {}),
      ...(threadTier ? { serviceTier: threadTier } : {}),
      ...(threadMode ? { permissionMode: threadMode } : {}),
      // this thread has Daisy's tools from now on — P4N-3: these
      // ones, for good (Codex adds none on resume).
      ...(fresh && daisyTools.length
        ? {
            nativeTools: toolNames === "daisy" ? DAISY_TOOLSET_VERSION : 1,
            nativeToolNames: daisyTools.map((t) => t.name),
          }
        : {}),
      ...(lacking ? { nativeToolsNoticed: lacking.names } : {}),
      // …and this text in its system layer.
      ...(guideDelivered && layered
        ? {
            nativeGuide: {
              sha256: layered.sha256,
              staticRules: layered.staticRules,
              // Written into a new thread, or added as a developer message.
              via: opened === "start" ? "record" : "inject",
            },
          }
        : {}),
    });
    started = true;
  };
  /** names go both ways only where this Codex was measured. */
  const syncsName = () =>
    !sidecar && liveFeatures("codex")?.title?.sync === "native";
  /** Daisy's title the native thread should carry: the AI's or the owner's. */
  const wantedName = () =>
    renames.daisy.manual || renames.daisy.final ? renames.daisy.title : "";
  /**
   * Codex said the thread's name. Daisy's echo / a name Daisy
   * has: nothing. At start (`opening`) a name other than Daisy's own manual
   * title loses (the turn pushes Daisy's); otherwise it is the owner's
   * rename in Codex (TUI / app) and goes to Daisy, which keeps its own if
   * it changed since.
   */
  const threadNamed = (raw: unknown, opening: boolean) => {
    const name = nativeTitle(raw);
    const before = threadName;
    threadName = name || null;
    if (name && echoes.delete(name)) return;
    if (!name || !syncsName() || name === before) return;
    const h = renames.daisy;
    if (name === h.title) return;
    if (opening && h.manual) return;
    renames.report(name);
  };
  /** Daisy's title → `thread/name/set` (bounded, never fails a turn). */
  const pushName = async (rt: Runtime | null) => {
    const name = wantedName();
    if (!name || !syncsName() || !started || closed || !root) return;
    if (name === threadName || refusedNames.has(name)) return;
    if (renames.holdsBack(name)) return;
    echoes.add(name);
    try {
      await p.request("thread/name/set", { threadId: root, name }, 5000);
      threadName = name;
    } catch (e: any) {
      echoes.delete(name);
      refusedNames.add(name);
      if (rt && cur === rt)
        stage(
          rt,
          "title",
          T()("server-harness.stage.titleNotSynced"),
          "error",
          T()("server-harness.stage.titleNotSyncedDetail", { error: String(e?.message || e) }),
        );
    }
  };
  /** Codex's default model — config's, else the catalog's. */
  const codexDefault = async () => {
    if (defaultModel === undefined) {
      defaultModel = text(config?.model);
      if (!defaultModel)
        try {
          const list = await p.request("model/list", { limit: 100 }, 5000);
          defaultModel = text(
            (list?.data || []).find((m: any) => m?.isDefault)?.model,
          );
        } catch {}
    }
    return defaultModel;
  };
  /**
   * the turn/start overrides for a model / permission mode changed
   * since this process last gave them (Codex 0.157.1: `model`,
   * `approvalPolicy`, `approvalsReviewer` hold for this turn and the next,
   * measured). "默认" model = the config's (or catalog's) default. Bypass
   * on / off (danger-full-access + never) is never applied here: only a new
   * process gets or loses it (the sandbox itself is in the key).
   */
  const liveTurnSettings = async (rt: Runtime) => {
    const live = liveSettings("codex"),
      params: Record<string, string> = {},
      later: (() => void)[] = [],
      seen = settingsSeen;
    // Compared with what the thread runs with (thread/start's answer,
    // thread/settings/updated): a resumed thread keeps the last per-turn
    // model (0.157.1, measured), so 默认 after an override sends the
    // default explicitly (review L5). Thread model unknown: only a chosen
    // model is sent (its 默认 is then Codex's own).
    const wantModel = rt.job.profile.model || "",
      now = threadModel || launchModel;
    if (live.model === "native" && (now || wantModel)) {
      const target = wantModel || (await codexDefault());
      if (target && target !== now) {
        params.model = target;
        later.push(() => (threadModel = target.slice(0, 200)));
      }
    }
    const wantMode = rt.job.profile.permissionMode || "on-request";
    if (
      live.permissionMode === "native" &&
      wantMode !== modeSent &&
      bypassMode({
        agent: "codex",
        permissionMode: wantMode,
        sandboxMode: launchedSandbox,
      }) ===
        bypassMode({
          agent: "codex",
          permissionMode: modeSent,
          sandboxMode: launchedSandbox,
        })
    ) {
      const auto = wantMode === "auto";
      params.approvalPolicy = auto ? "on-request" : wantMode;
      params.approvalsReviewer = auto ? "auto_review" : "user";
      later.push(() => {
        modeSent = wantMode;
        threadMode = wantMode;
      });
    }
    if (!Object.keys(params).length) return null;
    return {
      params,
      commit: () => {
        // Codex reported its settings for this turn/start: that stands.
        if (settingsSeen === seen) for (const f of later) f();
        if (params.model)
          if (threadModel === params.model)
            stage(rt, "model", T()("server-harness.stage.modelSwitched", { model: params.model }));
          else stage(rt, "model", T()("server-harness.codex.stage.modelNotSwitched"), "error");
        if (params.approvalPolicy)
          if (modeSent === wantMode)
            stage(rt, "permission", T()("server-harness.stage.modeSwitched", { mode: String(wantMode) }));
          else
            stage(
              rt,
              "permission",
              T()("server-harness.codex.stage.modeNotSwitched"),
              "error",
            );
      },
    };
  };
  /**
   * The root thread as Codex reports it now: its status
   * (idle / active + flags / notLoaded / systemError) and its latest turn
   * with every item (measured 0.157.1: thread/turns/list itemsView "full").
   */
  const threadState = async () => {
    const r = await p.request("thread/read", { threadId: root }, 10000);
    let last: any = null;
    try {
      const list = await p.request(
        "thread/turns/list",
        { threadId: root, limit: 1, itemsView: "full" },
        10000,
      );
      last = list?.data?.[0] ?? null;
    } catch {
      // An older Codex: the status alone.
    }
    return {
      status: String(r?.thread?.status?.type || ""),
      flags: (r?.thread?.status?.activeFlags || []) as string[],
      last,
    };
  };
  /**
   * The watchdog's check (a turn shown as running forever with no
   * output): Codex sent nothing for `silent` ms while this
   * job's turn runs. The thread decides: the turn ended without its
   * notification → finish / fail it as recorded; Codex runs no turn →
   * fail; still running → say so in the trace, and after the stall limit
   * with nothing executing in it, interrupt and fail.
   */
  const checkQuiet = async (rt: Runtime, silent: number) => {
    const s = await threadState().catch((e: any) => ({
      status: "",
      flags: [] as string[],
      last: null as any,
      error: String(e?.message || e).slice(0, 200),
    }));
    if (done || cur !== rt) return;
    const last = s.last,
      mine = !!last && !!turnId && last.id === turnId,
      ended = ["completed", "failed", "interrupted"].includes(last?.status);
    if (!rootCompleted && mine && ended) {
      for (const i of last.items || []) onItem(i, root, true);
      quietShown = 0;
      items.set("codex-quiet", {
        kind: "tool",
        category: "native",
        name: T()("server-harness.codex.item.noEndNotice"),
        text: T().dynamic(`server-harness.codex.item.endedByRecord.${last.status}`, { duration: minutes(silent) }),
        status: last.status === "completed" ? "complete" : "error",
      });
      if (last.status === "completed") {
        rootCompleted = true;
        finish();
      } else
        reject(
          Error(
            last.status === "failed"
              ? refused(last.error?.message || "Codex turn failed")
              : T()("server-harness.codex.turnInterrupted"),
          ),
        );
      return;
    }
    if (rootCompleted) {
      // Only subagents keep the job open: one whose thread no longer runs
      // is done (its end was missed).
      for (const [id, state] of [...children])
        if (RUNNING_CHILD.includes(state)) {
          const r = await p
            .request("thread/read", { threadId: id }, 10000)
            .catch(() => null);
          const t = r?.thread?.status?.type;
          if (t && t !== "active")
            children.set(id, t === "systemError" ? "errored" : "completed");
        }
      finish();
      if (done) return;
    } else if (NOT_RUNNING.has(s.status)) {
      quietShown = 0;
      reject(
        Error(
          T()("server-harness.codex.notRunningNoNotice", { status: String(s.status), duration: minutes(silent) }),
        ),
      );
      return;
    }
    const running = [...new Set(open.values())],
      busyChildren = [...children.values()].filter((c) =>
        RUNNING_CHILD.includes(c),
      ).length,
      parts = [
        rootCompleted
          ? T()("server-harness.codex.quiet.rootDone")
          : s.status === "active"
            ? T()("server-harness.codex.quiet.active")
            : T()("server-harness.codex.quiet.unknown"),
        compactingSince ? T()("server-harness.item.compacting") : "",
        running.length ? T()("server-harness.codex.quiet.running", { items: running.join(T()("server-harness.list.comma")) }) : "",
        busyChildren ? T()("server-harness.codex.quiet.children", { n: busyChildren }) : "",
        s.flags.includes("waitingOnApproval")
          ? T()("server-harness.codex.quiet.waitingApproval")
          : "",
        s.flags.includes("waitingOnUserInput") ? T()("server-harness.codex.quiet.waitingAnswer") : "",
        "error" in s ? T()("server-harness.codex.quiet.readFailed", { error: String(s.error) }) : "",
      ].filter(Boolean);
    quietShown ||= Date.now() - silent;
    items.set("codex-quiet", {
      kind: "tool",
      category: "native",
      name: T()("server-harness.codex.item.quiet"),
      text: T()("server-harness.codex.item.quietText", { duration: minutes(silent), parts: parts.join(T()("server-harness.list.separator")) }),
      status: "running",
    });
    // Interrupted only when it is known that nothing executes: Codex says
    // the thread runs, its latest turn is readable and is this one, no
    // item is open, no subagent runs, nothing waits for an answer.
    if (
      silent >= codexStallMs() &&
      s.status === "active" &&
      !("error" in s) &&
      (rootCompleted || mine) &&
      !running.length &&
      !busyChildren &&
      !s.flags.length
    ) {
      quietShown = 0;
      if (turnId && !rootCompleted)
        p.request("turn/interrupt", { threadId: root, turnId }, 5000).catch(
          () => {},
        );
      reject(
        Error(
          T()(rootCompleted ? "server-harness.codex.stalledEnded" : "server-harness.codex.stalledInterrupted", { duration: minutes(silent) }),
        ),
      );
    }
  };
  /**
   * stop what the stopped turn started in the foreground, which
   * Codex's `turn/interrupt` on the root leaves running (measured 0.157.1,
   * research X9 / X10): each subagent turn (`turn/interrupt` on the child
   * thread — measured: the child turn ends `interrupted` at once, its
   * thread goes idle) and each unified-exec command started in this turn
   * and still running, in the root or a subagent thread
   * (`thread/backgroundTerminals/terminate`; its item completes `failed`).
   * Terminals an earlier turn left running and Daisy's own background
   * tasks stay, as Claude Code's run_in_background ones do.
   * Resolves with what was asked to stop.
   */
  const stopScope = async (s: TurnScope, shown: Map<string, Item>) => {
    // A running subagent whose turn/started was not seen (an older Codex,
    // a turn started before this process attached): its thread says.
    for (const [id, state] of [...children])
      if (RUNNING_CHILD.includes(state) && !s.childTurns.has(id)) {
        const r = await p
          .request("thread/read", { threadId: id, includeTurns: true }, 5000)
          .catch(() => null);
        const last = r?.thread?.turns?.at(-1);
        if (last?.id && last.status === "inProgress")
          s.childTurns.set(id, last.id);
      }
    const threads = [...s.childTurns];
    await Promise.all(
      threads.map(([threadId, turnId]) => {
        // The trace says so (the subagent's own end is not reported any
        // more: the job has ended).
        const item = shown.get(threadId);
        if (item)
          items.setId(item.id, {
            ...item,
            status: "error",
            text: item.text
              ? T()("server-harness.codex.stoppedWithText", { text: item.text })
              : T()("server-harness.codex.stoppedWith"),
          });
        return p
          .request("turn/interrupt", { threadId, turnId }, 5000)
          .catch(() => {});
      }),
    );
    let terminals = 0;
    // The bwraps running each terminated command, just before its
    // terminate (sandbox-reap.ts: Codex's terminate leaves a sandboxed
    // command running under a dead bwrap).
    const noted: Sandbox[] = [],
      root = p.child.pid;
    for (const [threadId, own] of s.commands) {
      if (!own.size) continue;
      const list = await p
        .request("thread/backgroundTerminals/list", { threadId }, 5000)
        .catch(() => null);
      for (const t of list?.data || [])
        if (own.has(String(t.itemId))) {
          terminals++;
          if (root)
            noted.push(
              ...sandboxesFor(readProcs(root), root, String(t.command || "")),
            );
          await p
            .request(
              "thread/backgroundTerminals/terminate",
              { threadId, processId: t.processId },
              5000,
            )
            .catch(() => {});
        }
    }
    if (noted.length)
      for (const wait of [300, 700]) {
        await delay(wait);
        killAll(orphansToKill(noted, readProcs()));
      }
    return { subagents: threads.length, terminals };
  };
  /**
   * What of a stop's scope still runs: a subagent
   * thread still active, a command of the turn still listed.
   */
  const stillRunning = async (s: TurnScope) => {
    for (const [threadId] of s.childTurns) {
      const r = await p
        .request("thread/read", { threadId }, 5000)
        .catch(() => null);
      if (r?.thread?.status?.type === "active") return true;
    }
    for (const [threadId, own] of s.commands) {
      if (!own.size) continue;
      const list = await p
        .request("thread/backgroundTerminals/list", { threadId }, 5000)
        .catch(() => null);
      if ((list?.data || []).some((t: any) => own.has(String(t.itemId))))
        return true;
    }
    return false;
  };
  const interrupt = (rt: Runtime) => {
    if (!p || closed) return;
    // Waiting for a compaction that is not this job's:
    // the wait ends by itself (rt.signal); the process and the compaction
    // stay.
    if (othersTurn) return;
    if (!live || !turnId) {
      stopping = true;
      p.stop();
      return;
    }
    p.request("turn/interrupt", { threadId: root, turnId }, 5000).catch(
      () => {},
    );
    // and what the turn started in the foreground.
    // The trace rows of its subagents and of the stop, as of now (the
    // turn's items are forgotten once it ends).
    const s = scope,
      shown = new Map<string, Item>(),
      stopItem = items.id("stop-scope");
    for (const id of new Set([...s.childTurns.keys(), ...children.keys()])) {
      const item = items.map.get(items.id(`child:${id}`));
      if (item) shown.set(id, item);
    }
    const stopped = stopScope(s, shown).catch(() => ({
      subagents: 0,
      terminals: 0,
    }));
    void stopped.then(({ subagents, terminals }) => {
      if (subagents || terminals)
        items.setId(stopItem, {
          kind: "tool",
          category: "native",
          name: T()("server-harness.codex.stop.name"),
          text: [
            subagents ? T()("server-harness.codex.stop.subagents", { n: subagents }) : "",
            terminals ? T()("server-harness.codex.stop.terminals", { n: terminals }) : "",
          ]
            .filter(Boolean)
            .join(T()("server-harness.list.separator")),
          status: "complete",
        });
    });
    clearTimeout(interruptTimer);
    clearTimeout(scopeTimer);
    // the turn not ended after the grace period — the
    // process is ended (the thread resumes on the next message).
    interruptTimer = setTimeout(() => {
      if (!done) {
        stopping = true;
        p.stop();
      }
    }, codexStopKillMs());
    // likewise a subagent / command of it still running then
    // (its own timer: the turn's end clears interruptTimer). Not while a
    // later message's turn runs in the process.
    scopeTimer = setTimeout(async () => {
      await stopped;
      if (closed || cur) return;
      if ((await stillRunning(s).catch(() => false)) && !cur && !closed) {
        // Closed first (as agent.stop()): a message arriving while the
        // process dies relaunches Codex instead of failing on it.
        stopping = true;
        closed = true;
        p.stop();
      }
    }, codexStopKillMs());
  };
  const agent: LiveAgent = {
    since,
    lastActivity: since,
    get closed() {
      return closed;
    },
    busy: () => !!cur,
    // Codex's own background commands (polled list).
    pending: () => (closed || !p ? [] : terminals.pending()),
    activity: async () => terminals.activity(),
    stopTask: (id) => terminals.stop(id),
    stopped: () => p?.whenStopped() ?? Promise.resolve(),
    stop(reason) {
      stopping = true;
      closed = true;
      clearTimeout(interruptTimer);
      clearTimeout(scopeTimer);
      if (reason && !done) reject(Error(reason));
      p?.stop();
    },
    async warm() {
      if (closed) throw Error(T()("server-harness.processEnded", { name: "Codex" }));
      await (starting ??= start(warmRuntime(first, cwd)).catch((e) => {
        agent.stop();
        throw e;
      }));
      // Codex says how full the thread is only with its next usage
      // update: the new limit is reported with it (never a made-up 0).
      meter.emit();
    },
    nativeId: () => (started ? root : first.session.nativeId || null),
    // Re-review L-d: a name the owner gave the thread Daisy may not have.
    ownerName: () =>
      syncsName() && threadName && threadName !== renames.daisy.title
        ? threadName
        : null,
    // the AI title Daisy just applied, to the thread now.
    async pushTitle(title) {
      // Review L4: only over the placeholder / AI title this process knows
      // (a newer job may already carry the owner's own).
      if (renames.daisy.manual) return;
      renames.setDaisy({
        title: nativeTitle(title),
        manual: false,
        final: true,
      });
      await pushName(null);
    },
    async turn(rt): Promise<TurnOutcome> {
      if (closed) throw Error(T()("server-harness.processEndedResend", { name: "Codex" }));
      if (cur) throw Error(T()("server-harness.busyOtherTurn", { name: "Codex" }));
      cur = rt;
      lastJob = rt.job.id;
      renames.setDaisy(daisyOf(rt.job));
      wanted = requestedAutoCompact(rt.job);
      if (config !== undefined)
        meter.threshold = codexThreshold(
          config,
          wanted,
          launched,
          meter.window,
        );
      meter.beginJob();
      const quota = quotaOf(rt.job.profile.id) ?? staticQuota(rt.job);
      if (quota) quotaItem(items, quota, rt.job.profile.label);
      const completed = new Promise<void>((a, b) => {
        resolve = a;
        reject = b;
      });
      completed.catch(() => {});
      done = false;
      rootCompleted = false;
      turnId = undefined;
      media = [];
      children.clear();
      scope = newScope();
      othersTurn = false;
      compactingSince = 0;
      open.clear();
      quietShown = 0;
      heard = Date.now();
      // N-2a: whether the turn before this one took a steer.
      const afterSteer = steeredLast;
      steeredNow = false;
      progressed = false;
      endWait = null;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const outcome: TurnOutcome = {};
      hooks.changed();
      const onAbort = () => interrupt(rt);
      rt.signal.addEventListener("abort", onAbort, { once: true });
      if (rt.signal.aborted) onAbort();
      let childPoll: ReturnType<typeof setInterval> | undefined,
        watchdog: ReturnType<typeof setInterval> | undefined,
        reading = false;
      try {
        const reused = !!starting;
        await (starting ??= start(rt).catch((e) => {
          agent.stop();
          throw e;
        }));
        if (closed) throw Error(T()("server-harness.processEndedResend", { name: "Codex" }));
        if (rt.signal.aborted) throw Error(T()("server-harness.turn.stopped"));
        if (reused) stage(rt, "launch", T()("server-harness.stage.reused", { name: "Codex" }));
        // Daisy's title to the thread (at most 5 s, never fails the turn).
        await pushName(rt);
        if (rt.signal.aborted) throw Error(T()("server-harness.turn.stopped"));
        // this turn's effort / tier, reported as what the thread
        // now runs with (the /model panel's 当前实际使用).
        // (/compact and /review do not take them: review/start has no
        // effort / tier, the review runs with the thread's.)
        const plain = !["compact", "review"].includes(
            rt.job.operation?.name || "",
          ),
          turnSettings = plain
            ? codexTurnSettings(rt.job.profile, baseline, overridden)
            : {};
        // a changed model / permission mode rides this turn/start
        // ("this turn and subsequent turns"), committed once it is taken.
        const changes = plain && !sidecar ? await liveTurnSettings(rt) : null;
        if (changes) Object.assign(turnSettings, changes.params);
        // Review M1: /compact (thread/compact/start) takes no settings and
        // runs no tools; a changed mode / model goes with the next turn.
        // (/review never runs here: worker.ts takes the session offline and
        // runs it in a new process, whose thread/resume carries them.)
        if (
          rt.job.operation?.name === "compact" &&
          !sidecar &&
          (rt.job.profile.permissionMode || "on-request") !== modeSent
        )
          stage(
            rt,
            "permission",
            T()("server-harness.codex.stage.modeNextTurn"),
          );
        if (plain) {
          if (rt.job.profile.reasoningEffort) overridden.effort = true;
          if (rt.job.profile.serviceTier) overridden.tier = true;
          threadEffort = turnSettings.effort ?? threadEffort;
          threadTier = turnSettings.serviceTier ?? threadTier;
        }
        const report = () =>
          rt.emit("native", {
            nativeId: root,
            ...(threadModel ? { model: threadModel } : {}),
            ...(threadEffort ? { effort: threadEffort } : {}),
            ...(threadTier ? { serviceTier: threadTier } : {}),
            ...(threadMode ? { permissionMode: threadMode } : {}),
          });
        report();
        await rt.flush();
        stage(rt, "session", T()("server-harness.stage.sessionReady"));
        if (rt.job.operation?.name === "compact") {
          // compact the live thread itself (a second app-server on
          // the same thread would race this one).
          const compacted = new Promise<void>((ok) => {
            compactDone = ok;
          });
          try {
            items.set("compacting", {
              kind: "tool",
              category: "native",
              name: T()("server-harness.item.compacting"),
              text: "",
              status: "running",
            });
            const began = Date.now();
            // N-4: the size before (Codex's last count for this thread) and
            // which token update came before the compaction.
            const pre = meter.used >= 0 ? meter.used : undefined,
              usageBefore = rootUsage;
            await p.request("thread/compact/start", { threadId: root });
            // Codex 0.157 ends a compaction with the
            // contextCompaction item and the compaction turn's
            // turn/completed (thread/compacted is deprecated and not sent).
            // No answer in time is not a failure: Codex retries a failed
            // remote compaction silently, for minutes — ask the thread.
            let wait = codexCompactCheckMs();
            let asked = false;
            for (;;) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              const over = await Promise.race([
                compacted.then(() => true),
                completed.then(() => true),
                new Promise<boolean>((r) => {
                  timer = setTimeout(() => r(false), wait);
                }),
              ]).finally(() => clearTimeout(timer));
              if (over) break;
              if (rt.signal.aborted) throw Error(T()("server-harness.turn.stopped"));
              wait = codexPollMs();
              const s = await threadState().catch(() => null);
              // A Codex that answers neither thread/read nor turn/started
              // (older): the old rule — not confirmed in time = failure.
              // Later, a failed read only waits for the next one.
              if (!asked && (!s || !turnId))
                throw Error(T()("server-harness.codex.compact.unconfirmed"));
              asked = true;
              if (!s) {
                if (Date.now() - began >= codexCompactMaxMs())
                  throw Error(
                    T()("server-harness.codex.compact.unconfirmedFor", { duration: minutes(Date.now() - began) }),
                  );
                continue;
              }
              const last = s.last,
                mine = !!last && (!turnId || last.id === turnId),
                spent = Date.now() - began;
              if (
                mine &&
                last.status === "completed" &&
                (last.items || []).some(
                  (i: any) => i.type === "contextCompaction",
                )
              )
                break;
              if (mine && ["failed", "interrupted"].includes(last.status))
                throw Error(
                  last.error?.message ||
                    (last.status === "failed"
                      ? T()("server-harness.codex.compact.failed")
                      : T()("server-harness.codex.compact.interrupted")),
                );
              if (NOT_RUNNING.has(s.status))
                throw Error(
                  T()("server-harness.codex.compact.notDone", { status: String(s.status) }),
                );
              if (spent >= codexCompactMaxMs()) {
                if (turnId)
                  await p
                    .request("turn/interrupt", { threadId: root, turnId }, 5000)
                    .catch(() => {});
                throw Error(
                  T()("server-harness.codex.compact.tooLong", { duration: minutes(spent) }),
                );
              }
              items.set("compacting", {
                kind: "tool",
                category: "native",
                name: T()("server-harness.item.compacting"),
                text: T()("server-harness.codex.compact.still", { duration: minutes(spent) }),
                status: "running",
              });
            }
            items.set("compacting", {
              kind: "tool",
              category: "native",
              name: T()("server-harness.item.compaction"),
              text: "success",
              status: "complete",
            });
            // N-4: Codex sends the compacted thread's count as a token
            // update (measured 0.165.0: just before the compaction item
            // completes) — the size after; a short wait if it lags.
            for (let i = 0; i < 30 && rootUsage === usageBefore; i++)
              await delay(50);
            const info = {
              trigger: "manual",
              durationMs: Date.now() - began,
              ...(pre !== undefined ? { preTokens: pre } : {}),
              ...(rootUsage !== usageBefore && meter.used >= 0
                ? { postTokens: meter.used }
                : {}),
            };
            compactNotice(items, "codex", info);
            meter.compacted(info);
            meter.emit();
            outcome.compact = info;
            done = true;
            return outcome;
          } finally {
            compactDone = null;
          }
        }
        const input: any[] = [{ type: "text", text: rt.prompt }];
        const skillNames = [
          ...(rt.job.text || rt.prompt || "").matchAll(
            /(?:^|\s)\$([a-zA-Z0-9_-]+)/g,
          ),
        ].map((m) => m[1]);
        if (skillNames.length) {
          const result = await p.request("skills/list", {
            cwds: [cwd],
            forceReload: true,
          });
          const skills = (result.data || []).flatMap(
            (group: any) => group.skills || [],
          );
          for (const name of new Set(skillNames)) {
            const skill = skills.find(
              (s: any) => s.name === name && s.enabled !== false,
            );
            if (skill?.path)
              input.push({ type: "skill", name, path: skill.path });
          }
        }
        for (const f of rt.files)
          if (f.mime.startsWith("image/"))
            input.push({ type: "localImage", path: f.path });
        // the owner's native approvals first (the retry reads them).
        const told = await approveNative(rt, rt.job.nativeApprovals);
        if (told) {
          input[0].text = `${told}\n\n${input[0].text}`;
          // The text as sent, with Daisy's prefix (the
          // turn's own audit item was written before it) — a job with the
          // layered prompt only.
          if (layeredGuide(rt.job))
            rt.emit("item", {
              id: `${rt.job.id}:prompt-audit:native-approvals`,
              kind: "tool",
              category: "audit",
              name: T()("server-harness.item.auditNativeApprovals"),
              status: "complete",
              text: input[0].text,
              createdAt: Date.now(),
              input: {
                role: "user",
                systemPromptOverride: false,
                prefix: "native-approvals",
                sha256: createHash("sha256")
                  .update(input[0].text)
                  .digest("hex"),
              },
            });
        }
        // the workspace before this turn (Codex keeps no file
        // checkpoints; 「回退」 restores its edits from Daisy's).
        checkpoint = plain
          ? await TurnCheckpoint.begin(rt.job, cwd, liveFeatures("codex"))
          : null;
        if (checkpoint?.error)
          stage(
            rt,
            "file-checkpoint",
            T()("server-harness.stage.noCheckpoint", { error: String(checkpoint.error) }),
          );
        const begin = () =>
          p.request(
            rt.job.operation?.name === "review" ? "review/start" : "turn/start",
            {
              threadId: root,
              ...(rt.job.operation?.name === "review"
                ? {
                    delivery: "inline",
                    target: { type: "uncommittedChanges" },
                  }
                : { input, ...turnSettings }),
            },
          );
        let startedTurn: any;
        try {
          startedTurn = await begin();
        } catch (e: any) {
          // Codex is still compacting (measured 0.157.1:
          // turn/start fails with ActiveTurnNotSteerable { turn_kind:
          // Compact }) — e.g. a compaction that outlived Daisy's wait.
          // The message waits for it instead of failing.
          if (!COMPACT_BUSY.test(String(e?.message || ""))) throw e;
          stage(
            rt,
            "sent",
            T()("server-harness.codex.sent.waitCompact"),
            "running",
          );
          const began = Date.now();
          othersTurn = true;
          for (;;) {
            await delay(Math.min(codexPollMs(), 2000));
            if (rt.signal.aborted) throw Error(T()("server-harness.turn.stopped"));
            if (closed) throw Error(T()("server-harness.processEndedResend", { name: "Codex" }));
            const r = await p
              .request("thread/read", { threadId: root }, 10000)
              .catch(() => null);
            if (r && r.thread?.status?.type !== "active") break;
            if (Date.now() - began >= codexCompactMaxMs())
              throw Error(
                T()("server-harness.codex.sent.stillCompacting", { duration: minutes(Date.now() - began) }),
              );
          }
          othersTurn = false;
          startedTurn = await begin();
        }
        if (changes) {
          changes.commit();
          report();
        }
        let id = (turnId = startedTurn.turn?.id);
        checkpoint?.started(id);
        // Codex runs a new message in a turn still active (measured
        // 0.157.1: turn/start answers that turn's id): it is this job's now.
        if (id) left.delete(id);
        // a Daisy job (「插队发送」 while live, a Daisy wake) goes
        // in the same way, with its images and a clientUserMessageId; Codex
        // takes it into the active turn when the request succeeds (no
        // queue of its own to withdraw from), so it is read at once.
        rt.onInput?.(async (text, requeue, _withdraw, native, read) => {
          if (done || rootCompleted || !id || cur !== rt)
            throw Error(T()("server-harness.codex.steer.turnOver"));
          if (rt.signal.aborted) throw Error(T()("server-harness.turn.stopped"));
          const input: any[] = [{ type: "text", text }];
          for (const f of native?.files || [])
            if (/^image\//.test(f.mime))
              input.push({ type: "localImage", path: f.path });
          const told = await approveNative(rt, native?.approvals);
          if (told) input[0].text = `${told}\n\n${input[0].text}`;
          const clientId = randomUUID();
          if (native) appended.set(clientId, { native, requeue, read: false });
          try {
            await p.request(
              "turn/steer",
              {
                threadId: root,
                expectedTurnId: id,
                input,
                ...(native ? { clientUserMessageId: clientId } : {}),
              },
              15000,
            );
          } catch (e) {
            appended.delete(clientId);
            throw e;
          }
          steeredNow = true;
          // Follow-up 2026-11-09: Codex has no queue of its own — the
          // answered steer is in the active turn (a Daisy job waits for its
          // `userMessage.clientId` echo instead, above).
          if (!native) read?.();
        });
        // Attachment- or terminal-only messages are acknowledged too.
        const acknowledge = () => {
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
              native: { turnId: id },
              createdAt: Date.now(),
            });
        };
        acknowledge();
        stage(rt, "sent", T()("server-harness.stage.inputSent", { name: "Codex" }));
        rt.emit("native", { nativeId: root, contextDelivered: true });
        // A child turn completing must never finish the parent's job. Read
        // descendants while active to retain their transcripts, including
        // background work.
        childPoll = setInterval(async () => {
          if (reading || done || rt.signal.aborted) return;
          reading = true;
          try {
            for (const [id, status] of children) {
              if (
                !["running", "pendingInit", "pending", "inProgress"].includes(
                  status,
                )
              )
                continue;
              const r = await p.request(
                "thread/read",
                { threadId: id, includeTurns: true },
                10000,
              );
              heard = Date.now();
              const turns = r.thread?.turns || [],
                last = turns.at(-1);
              for (const t of turns)
                for (const i of t.items || [])
                  onItem(i, id, t.status !== "inProgress");
              if (
                last &&
                ["completed", "failed", "interrupted"].includes(last.status)
              ) {
                children.set(id, last.status);
                items.set(`child:${id}`, {
                  kind: "tool",
                  category: "subagent",
                  threadId: id,
                  parentId: root,
                  name: childName(id),
                  text: (last.items || [])
                    .filter((i: any) => i.type === "agentMessage")
                    .map((i: any) => i.text)
                    .join("\n"),
                  status: last.status === "completed" ? "complete" : "error",
                });
              }
            }
            finish();
          } catch (e: any) {
            if (done) return;
            items.set("child-read", {
              kind: "tool",
              category: "native",
              name: T()("server-harness.codex.item.childReadRetry"),
              text: e.message,
              status: "running",
            });
          } finally {
            reading = false;
          }
        }, 1500);
        // no Codex event for codexQuietMs() while this
        // turn runs (Daisy serving an approval / tool call is not Codex's
        // silence) → check the thread instead of waiting forever.
        const quiet = codexQuietMs();
        let checking = false;
        heard = Date.now();
        watchdog = setInterval(
          async () => {
            if (checking || done || rt.signal.aborted || daisyWaits > 0)
              return;
            const silent = Date.now() - heard;
            if (silent < quiet) return;
            checking = true;
            try {
              await checkQuiet(rt, silent);
            } catch (e: any) {
              if (!done) reject(e);
            } finally {
              checking = false;
            }
          },
          Math.max(20, Math.min(10_000, Math.floor(quiet / 3))),
        );
        // N-2a: right after a turn that took a steer, a turn with no
        // progress at all is checked against the thread: still this turn,
        // still running, nothing in it but the message → interrupted and
        // the same message started again, once. (Device acceptance,
        // Codex 0.165.0: 乙 stayed 「执行中」 with no output until stopped.)
        const restartStalled = async () => {
          const still = () =>
            !done && !progressed && !rt.signal.aborted && cur === rt;
          if (!still() || daisyWaits > 0 || !id) return;
          const s = await threadState().catch(() => null);
          if (!still() || !s || s.status !== "active") return;
          const last = s.last;
          if (
            !last ||
            last.id !== id ||
            ["completed", "failed", "interrupted"].includes(last.status) ||
            (last.items || []).some((i: any) => i?.type !== "userMessage")
          )
            return;
          const stalled = id;
          // Its end (interrupted) is not this job's.
          left.add(stalled);
          const ended = new Promise<boolean>((ok) => {
            endWait = { id: stalled, done: () => ok(true) };
          });
          items.set("codex-restart", {
            kind: "tool",
            category: "native",
            name: T()("server-harness.codex.item.notStarted"),
            text: T()("server-harness.codex.item.restarting", { duration: minutes(codexSteerStallMs()) }),
            status: "running",
          });
          await p
            .request("turn/interrupt", { threadId: root, turnId: stalled }, 5000)
            .catch(() => {});
          let gone = await Promise.race([ended, delay(5000).then(() => false)]);
          endWait = null;
          if (!gone) {
            const r = await p
              .request("thread/read", { threadId: root }, 5000)
              .catch(() => null);
            gone = !!r && r.thread?.status?.type !== "active";
          }
          if (done || rt.signal.aborted || cur !== rt) return;
          if (!gone)
            throw Error(
              T()("server-harness.codex.noProgress"),
            );
          const again: any = await begin();
          id = turnId = again?.turn?.id;
          if (id) left.delete(id);
          checkpoint?.started(id);
          heard = Date.now();
          acknowledge();
          items.set("codex-restart", {
            kind: "tool",
            category: "native",
            name: T()("server-harness.codex.item.restarted"),
            text: T()("server-harness.codex.item.restartedText", { duration: minutes(codexSteerStallMs()) }),
            status: "complete",
          });
        };
        if (afterSteer && plain)
          stallTimer = setTimeout(
            () =>
              void restartStalled().catch((e) => {
                if (!done) reject(e);
              }),
            codexSteerStallMs(),
          );
        await completed;
        await Promise.all(media);
        return outcome;
      } catch (e) {
        throw stoppedEnd(e, rt, T()("server-harness.codex.turnInterrupted"));
      } finally {
        done = true;
        clearTimeout(stallTimer);
        endWait = null;
        // N-2a: a steer taken here makes the next turn watched.
        steeredLast = steeredNow;
        if (childPoll) clearInterval(childPoll);
        // the workspace as this turn left it (stopped / failed too).
        const cp = checkpoint;
        checkpoint = null;
        await cp?.end();
        if (watchdog) clearInterval(watchdog);
        othersTurn = false;
        if (turnId) {
          left.add(turnId);
          if (left.size > 50) left.delete(left.values().next().value!);
        }
        clearTimeout(interruptTimer);
        rt.signal.removeEventListener("abort", onAbort);
        rt.onInput?.(null);
        // read in this turn → done; not read → Daisy's again.
        for (const a of appended.values())
          if (a.read) a.native.report("completed");
          else
            a.requeue(
              rt.signal.aborted ? T()("server-harness.turn.stopped") : T()("server-harness.steer.unreadAtEnd", { name: "Codex" }),
            );
        appended.clear();
        turnId = undefined;
        cur = null;
        items.retain(new Set());
        agent.lastActivity = Date.now();
        hooks.changed();
      }
    },
  };
  return agent;
}
