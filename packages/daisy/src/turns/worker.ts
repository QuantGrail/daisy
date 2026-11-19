import { turnT } from "../harness/model-switch.ts";
import { daisyEnv } from "../../../contracts/src/env.ts";
import { DAISY_TOOLSET_VERSION } from "../../../contracts/src/native-tools.ts";
import { systemUid } from "../access/ports.ts";
import { applyPlatform, platformReport, type PlatformFacts } from "../platform/capabilities.ts";
import { helperAvailable } from "../platform/windows/helper.ts";
import { windowsShell } from "../platform/windows/cmdline.ts";
import { resolveSpawn } from "../platform/spawn.ts";
import { AGENT_STOP } from "../../../contracts/src/agent-stop.ts";
import { isolatedWorkspace } from "./worktrees.ts";
import { readOnlyNote, sharedWorkspaceNote } from "../prompts/collab-guide.ts";
import { sessionT } from "../../../contracts/src/prompt-i18n.ts";
import { readOnlyLaunch } from "../platform/read-only.ts";
import {
  askNatively,
  codexSidecarFork,
  isSidecar,
  sidecarDecline,
  sidecarGuide,
} from "./sidecar.ts";
import {
  ResultJournal,
  importLegacyJournal,
  recoverJournal,
  standInJournalDb,
} from "./result-journal.ts";
import { AGENT_REDETECT_MS, ensureUserBins } from "../platform/agent-path.ts";
import { defaultStateRoot } from "../platform/paths.ts";
import { reportCompletion } from "./completion.ts";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir, userInfo } from "node:os";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  statSync,
  realpathSync,
} from "node:fs";
import {
  resolve,
  relative,
  isAbsolute,
  basename,
  dirname,
  extname,
  join,
} from "node:path";
import type {
  RunnerJob,
  Event,
  Approval,
} from "../../../contracts/src/index.ts";
import { sessionLang } from "../../../contracts/src/prompt-i18n.ts";
import { buildPrompt } from "../../../contracts/src/prompt.ts";
import {
  capabilitiesFor,
  isFallback,
} from "../../../contracts/src/agent-capabilities.ts";
import { schedulerPendingOf } from "../../../contracts/src/live.ts";
import { CLAUDE_CAPABILITIES } from "../harness/claude.ts";
import { CODEX_CAPABILITIES } from "../harness/codex.ts";
import {
  AGENT_IDS,
  agentCommand,
  versionArgs,
} from "../../../contracts/src/acp-harnesses.ts";
import { AGENT_CAPABILITIES } from "../../../contracts/src/agent-capabilities.ts";
import {
  configureFileCheckpoints,
  fileCheckpointsOn,
} from "./file-checkpoints.ts";
import { contextUsageCapability } from "../../../contracts/src/context-usage.ts";
import {
  safeWorkspace,
  preparePrompt,
  type InputHandler,
  type NativeInput,
  stage,
  setThresholdAgents,
  setLiveSettings,
  type Runtime,
  type RewindFiles,
  type RewindOutcome,
  type LiveAgent,
  liveFeatures,
} from "../harness/shared.ts";
import {
  browseDirectory,
  ensureDirectory,
  filesystemHome,
  filesystemRoots,
} from "./filesystem.ts";
import { executeLogin } from "./login.ts";
import {
  managedIdentityDir,
  resolveIdentity,
  retireIdentities,
} from "./identity.ts";
/**
 * 「换身份」's old directory as this node keeps it, or none — a
 * managed one only as its own id's (resolveIdentity's rule), never created
 * here (a deleted identity's directory stays deleted).
 */
export function carryDir(
  from: { profileId: string; configDir: string },
  config: { nodeId: string; identityRoot?: string },
): { profileId: string; configDir: string } | undefined {
  if (!from.configDir.startsWith("managed:")) return from;
  const dir = managedIdentityDir(
    from.configDir,
    from.profileId,
    config.nodeId,
    config.identityRoot,
  );
  return dir && existsSync(dir)
    ? { profileId: from.profileId, configDir: dir }
    : undefined;
}
import {
  namingInFlight,
  suggestTitle,
  type TitleRequest,
} from "./title.ts";
import {
  SESSION_TITLE_PROTOCOL,
  nativeTitle,
} from "../../../contracts/src/title.ts";
import { RESTART_IDLE_MS, UpgradeWatch } from "../update/upgrade.ts";
import {
  ProcessAbort,
  RestartAbort,
  restartCapability,
  stateKey,
  supervision,
  unconfirmed,
  type BusyItem,
  type ProcessRestart,
  type RestartRequest,
} from "../update/restart.ts";
import {
  RunnerCallError,
  type RunnerCall,
} from "../app/runner-port.ts";
import { runTerminal } from "./terminal.ts";
import {
  CarryError,
  carryClaudeTranscript,
  claudeConfigDir,
} from "./transcript-carry.ts";
import { runOperation } from "./operations.ts";
import { runShell } from "./shell.ts";
import { LiveRegistry, LIVE_IDLE_MS, EVICT_IDLE_MS } from "./live.ts";
import { BackgroundManager } from "../schedule/background.ts";
import { RestartDrain } from "../update/restart-drain.ts";
import { nodeAutoUpdate, type PackageUpdate } from "../update/package.ts";
import { markRunnerSynced } from "../update/guard.ts";
import { SCHEDULE_LIMITS } from "../../../contracts/src/scheduler.ts";
import {
  DaisyToolHost,
  launchGuide,
  layeredGuide,
  staticRulesDelivered,
} from "../tools/daisy-tools.ts";
import {
  activateRunnerPlugins,
  loadRunnerPlugins,
  pluginSelection,
  PLUGIN_TICK_WAIT_MS,
  type PluginSelection,
} from "../plugins/runner.ts";
import { setRunnerBuild } from "../observe/launch-audit.ts";
import { log } from "../observe/log.ts";
/** ADR-159 §6: a job's words in its session's language (P6-24 stores it on the session). */
const jobT = (job: RunnerJob) => turnT(job.session?.lang);
export interface NodeConfig {
  /**
   * P1-02: the control plane's calls for this node, in process
   * (`createApp(...).runnerApi(nodeId)`; were POST /api/runner/* with a
   * node token). Not part of runner.json.
   */
  api: RunnerCall;
  nodeId: string;
  allowedRoots: string[];
  /**
   * Agents online at once (default 8, 1–8): a session holds a slot
   * while its Agent process is online or one of its jobs runs; offline
   * sessions hold none.
   */
  concurrency: number;
  identityRoot?: string;
  workspaceHome?: string;
  maxJobDurationMs?: number;
  /**
   * P1-10: plugins to enable, with their options (absent: env
   * DAISY_PLUGINS; neither: none). See plugins.ts.
   */
  plugins?: PluginSelection;
  /**
   * Online sessions (default true; env DAISY_LIVE=0 turns it off):
   * keep each session's Agent process between turns.
   */
  live?: boolean;
  /** Idle-offline after this long without activity and nothing pending. */
  liveIdleMs?: number;
  /** Slots full: an Agent idle this long may give its slot up. */
  liveEvictIdleMs?: number;
  /**
   * Restart into a newly installed release once idle (default: when run by
   * systemd; env DAISY_RUNNER_SELF_RESTART=0/1 overrides). See upgrade.ts.
   */
  selfRestart?: boolean;
  /** The installed release marker (default: `.release` of this code). */
  releaseFile?: string;
  /** Continuous idleness before such a restart (default 60 s). */
  restartIdleMs?: number;
  /** A new release must stay installed this long first (default 60 s). */
  releaseSettleMs?: number;
  /**
   * The owner's 「空闲时重启」 (P1-02, was a per-node restart): continuous
   * idleness after the request before exiting (default 5 s).
   */
  restartRequestIdleMs?: number;
  /** State sync interval (P1-02, was the heartbeat; default 10 s). */
  syncMs?: number;
  /**
   * how long a pending restart waits for background work (Daisy
   * background commands / monitors, native background tasks) before it
   * stops them and restarts (default 30 min; env DAISY_RUNNER_RESTART_WAIT_MS).
   */
  restartWaitMs?: number;
  /**
   * Daisy background commands / monitors running here at once,
   * all sessions together (default 32; env DAISY_RUNNER_BACKGROUND_LIMIT).
   * The control plane has its own per-node limit; the smaller one applies.
   */
  backgroundLimit?: number;
  /**
   * D-34: apply an update found by the npm update (P5-06, ADR-145) by
   * itself once idle (default true); `false` leaves applying to the owner.
   * Read from runner.json by daemon.ts (PackageUpdate).
   */
  autoUpdate?: boolean;
  /**
   * P5-06 (ADR-145): where an npm-installed Daisy looks for updates —
   * `npm:<spec>` (default `npm:@daisy-ai/daisy@latest`), a directory of
   * `.tgz` packages, one `.tgz`, or `off`. `autoUpdate: false` keeps
   * looking off and leaves applying to the owner (`daisy update --apply`).
   */
  updateSource?: string;
  /** How often the update source is looked at (default 30 min; tests shorten it). */
  updateDiscoverMs?: number;
}
/** A positive integer from the environment, else undefined (review L4). */
const positiveEnv = (v: string | undefined) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};
export const delay = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));
/** A refused call: its status and message (P1-02: RunnerCallError). */
export const ApiError = RunnerCallError;
export type ApiError = RunnerCallError;
/**
 * The control plane no longer accepts this node (revoked): retrying
 * forever cannot help, so the Runner stops (the process keeps serving).
 */
export class NodeTokenRejected extends Error {
  /** EX_CONFIG: the generated systemd unit does not restart on it. */
  readonly exitCode = 78;
}
/** The OS account this runner executes Agents as (DESIGN D10). */
let identity: { username: string; uid: number } | undefined;
export const runnerIdentity = () => {
  if (!identity) {
    const u = userInfo();
    // P5-05: Windows has no uid (userInfo says -1, which the control plane
    // refuses — the node never came online): the account's stable number.
    identity = { username: u.username, uid: u.uid >= 0 ? u.uid : systemUid() };
  }
  return identity;
};
/**
 * One call to the control plane (P1-02: in process, `config.api`; was
 * POST /api/runner<path>). Same paths, bodies and answers; a refusal is
 * an ApiError with the status the route answered.
 */
export async function nodeApi(
  config: NodeConfig,
  path: string,
  body: any = {},
  lease?: string,
) {
  return config.api(path, body, lease);
}
/** This machine's facts for the platform overlay (Windows: the helper, Git Bash). */
function platformFacts(): PlatformFacts {
  if (process.platform !== "win32") return { platform: process.platform, helper: false };
  return { platform: "win32", helper: helperAvailable(), shell: windowsShell(process.env).kind };
}
/** each agent's features as last detected. */
const knownFeatures: Record<string, any> = {};
export async function capabilities() {
  // A CLI installed after enrolment may live in a directory the service
  // PATH never had (see agent-path.ts).
  const added = ensureUserBins();
  if (added.length)
    log.info(`Added ${added.join(", ")} to PATH (to detect the local AI tools)`);
  const results: Record<string, any> = {
    workspaceAccess: {
      version: 3,
      readOnly: process.platform === "linux" && existsSync("/usr/bin/bwrap"),
    },
    // One AI title after round 2; older Runners are not asked.
    sessionTitles: { version: SESSION_TITLE_PROTOCOL },
    // carries the transcript after 换身份 (carryFrom →
    // identity-carried), reports each process's identity, honours retire.
    identityCarry: { version: IDENTITY_CARRY_VERSION },
    // runs 「只问」 sidecars (fork + read-only settings); an older
    // Runner would run one as an ordinary session, so askOnly waits for it.
    askSidecar: { version: 1 },
    // takes the control plane's layered prompt (`job.guide`: the
    // text as is, the process keyed on `guide.stable`, the short per-turn
    // line) and reports the org core a plugin reads (hook 1). An older
    // Runner is not sent `guide`.
    promptLayers: { version: 1 },
    // ADR-154: serves Daisy's tools by `daisyTools` (MCP server `daisy`,
    // `daisy_<name>`; the old names for a conversation started with them).
    // An older Runner is sent `toolHost` and serves only the old names.
    daisyTools: { version: DAISY_TOOLSET_VERSION },
    // per agent, which unified input semantics its adapter does
    // natively (append into the running turn, withdraw …); the control
    // plane falls back to Daisy's queue for the rest.
    // By the detected CLI version (below, review L1).
    agentFeatures: {
      claude: CLAUDE_CAPABILITIES,
      codex: CODEX_CAPABILITIES,
      // P4-10: every ACP harness (acp-harnesses.ts).
      ...Object.fromEntries(
        AGENT_IDS.filter((a) => a !== "claude" && a !== "codex").map((a) => [
          a,
          AGENT_CAPABILITIES[a],
        ]),
      ),
    },
  };
  await Promise.all(
    AGENT_IDS.map(async (agent) => {
      try {
        const bin = agentCommand(agent);
        // P5-05: on Windows found on PATH × PATHEXT, an npm shim run under node.
        const r = await promisify(execFile)(...resolveSpawn(bin, versionArgs(agent)), {
          timeout: 8000,
          windowsHide: true,
        });
        results[agent] = {
          installed: true,
          version: r.stdout.trim().slice(0, 150),
        };
      } catch (e: any) {
        // ENOENT = not installed; anything else (timeout, crash) is kept
        // apart so a re-detection does not flip a working CLI to missing.
        results[agent] =
          e?.code === "ENOENT"
            ? { installed: false }
            : { installed: false, failed: true };
      }
    }),
  );
  // context usage v1 and which Agents take an auto-compact
  // threshold at launch — Claude only from the version that has
  // --autocompact. The control plane validates settings with it; the
  // adapters pass the flag only where it is advertised.
  // native append / withdraw only from the CLI version
  // they were measured on; older (or unknown) → Daisy's queue.
  for (const agent of AGENT_IDS)
    results.agentFeatures[agent] =
      // a --version that failed (timeout, crash — not
      // "not installed") keeps the last known features, so a slow check
      // does not flip online processes to the legacy settings (restarts).
      results[agent]?.failed && knownFeatures[agent]
        ? knownFeatures[agent]
        : (knownFeatures[agent] = withCheckpoints({
            ...capabilitiesFor(agent, results[agent]?.version),
            ...(typeof results[agent]?.version === "string"
              ? { cliVersion: results[agent].version }
              : {}),
            // What 「停止」 stops (also `agentStop` below).
            stop: AGENT_STOP[agent],
          }));
  // P5-05 (ADR-141, 5.14): what this system takes away (Windows: no CLI
  // window without the helper; Codex's read-only only `weak`), and how
  // trees, terminals, typed commands and owner-only files work here.
  const facts = platformFacts();
  results.agentFeatures = applyPlatform(results.agentFeatures, facts);
  for (const a of AGENT_IDS) knownFeatures[a] = results.agentFeatures[a];
  results.platform = platformReport(facts, existsSync("/usr/bin/bwrap"));
  results.contextUsage = contextUsageCapability(results, turnT());
  setThresholdAgents(results.contextUsage);
  // what a settings change does to an online process here.
  setLiveSettings(results.agentFeatures);
  // per agent, what 「停止」 stops (the turn's subagents and
  // commands: natively or by the adapter) and what it leaves running.
  results.agentStop = AGENT_STOP;
  return results;
}
/**
 * Codex's 「回退」 files are Daisy's checkpoints — not offered
 * when they are turned off here (DAISY_CODEX_FILE_CHECKPOINTS=0).
 */
function withCheckpoints(c: any) {
  return isFallback(c?.rewind?.files) && !fileCheckpointsOn()
    ? { ...c, rewind: { ...c.rewind, files: "none" } }
    : c;
}
/**
 * the files part of a 「回退」 that copied the conversation
 *: what an in-place attempt already did to them, else why they
 * were not reverted.
 */
export function rewindFilesFallback(
  job: RunnerJob,
  tried: RewindOutcome | null,
  /** The live process had background work / timers (review M2). */
  busy = false,
): RewindFiles {
  if (tried) return tried.files;
  if (job.operation?.args?.files !== true)
    return { reverted: false, reason: "not-asked" };
  if (busy) return { reverted: false, reason: "background" };
  return {
    reverted: false,
    reason: job.session.agent === "claude" ? "offline" : "unsupported",
  };
}
/** the in-place 「回退」 attempt (null: not possible now). */
async function rewindInPlace(
  rt: Runtime,
  agent: LiveAgent,
): Promise<RewindOutcome | null> {
  const args = rt.job.operation?.args || {};
  stage(rt, "operation", jobT(rt.job)("server-turns.op.rewindLive"), "running");
  return (
    (await agent
      .rewind?.(String(args.beforeUuid), { files: args.files === true })
      .catch(() => null)) ?? null
  );
}
/** Operations that rewrite a session's native state: its process must go. */
const SESSION_REWRITES = ["rewind", "terminal", "review"];
/** Operations that change an identity's configuration. */
const PROFILE_REWRITES = [
  "config.write",
  "mcp.add",
  "mcp.remove",
  "skill.write",
  "plugin.install",
  "plugin.uninstall",
];
/** Where this Runner keeps its local state (journal, restart requests). */
const stateRoot = (config: NodeConfig) =>
  config.identityRoot || defaultStateRoot();
export function journalRoot(config: NodeConfig) {
  return join(stateRoot(config), "result-journal", stateKey(config.nodeId));
}
/** Journal directories whose old results.sqlite this process has looked for. */
const legacyChecked = new WeakMap<object, Set<string>>();
/**
 * This node's result journal (P1-02b: rows in daisy.sqlite, the database
 * `config.api` carries). The first time in a process, an old
 * `<journalRoot>/results.sqlite` is imported and renamed
 * (importLegacyJournal).
 */
export function openJournal(config: NodeConfig): ResultJournal {
  const dir = journalRoot(config);
  const db = config.api.journal ?? standInJournalDb(dir);
  let seen = legacyChecked.get(db);
  if (!seen) legacyChecked.set(db, (seen = new Set()));
  if (!seen.has(dir)) {
    const r = importLegacyJournal(db, dir, config.nodeId);
    seen.add(dir);
    if (r)
      log.info(
        `Result journal merged into the database: ${r.jobs} job(s) and ${r.events} event(s) from ${r.file} imported into daisy.sqlite; the old file was renamed to ${r.renamedTo}`,
      );
  }
  return new ResultJournal(db, config.nodeId);
}
/**
 * P1-02: the Runner's local state was keyed by `<server URL>|<node id>`
 * (both as configured and with the trailing "/" trimmed); it is keyed by
 * the node alone now. Once, at start: what an older runner.json's
 * `serverUrl` points at is moved to the new key — the result journal (its
 * unsent results and evidence) and a plugin's state under
 * `<plugin>/<key>.json` (a callback cursor, say). Never overwrites
 * what the new key already has. Returns what was moved.
 */
export function migrateStateKey(config: {
  nodeId: string;
  identityRoot?: string;
  serverUrl?: unknown;
}): string[] {
  if (typeof config.serverUrl !== "string" || !config.serverUrl) return [];
  const root = stateRoot(config as NodeConfig),
    next = stateKey(config.nodeId);
  const old = [
    ...new Set(
      [config.serverUrl.replace(/\/+$/, ""), config.serverUrl].map((u) =>
        createHash("sha256")
          .update(u + "|" + config.nodeId)
          .digest("hex"),
      ),
    ),
  ];
  const moved: string[] = [];
  const move = (from: string, to: string) => {
    if (!existsSync(from) || existsSync(to)) return;
    try {
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      renameSync(from, to);
      moved.push(to);
    } catch {}
  };
  for (const key of old) {
    move(join(root, "result-journal", key), join(root, "result-journal", next));
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {}
    for (const n of names)
      if (n !== "result-journal")
        move(join(root, n, `${key}.json`), join(root, n, `${next}.json`));
  }
  return moved;
}
/** Runner protocol for 换身份 (capability in the state sync). */
export const IDENTITY_CARRY_VERSION = 1;
/**
 * the old identity's process ends, then this conversation's
 * transcript is copied into the new identity's directory and the control
 * plane told (it forgets the switch: once). Refused / failed: the job
 * fails with the reason — it never starts as if the history were there.
 */
async function carryTranscript(
  config: NodeConfig,
  job: RunnerJob,
  rt: Runtime,
  live?: LiveRegistry,
) {
  const fail = (why: string) =>
    Error(jobT(job)("server-turns.carry.failed", { why }));
  if (!job.carryFrom)
    throw fail(jobT(job)("server-turns.carry.noOldDir"));
  await live?.retireOther(job.session.id, job.profile.id);
  stage(rt, "carry", jobT(job)("server-turns.carry.running"), "running");
  let r;
  try {
    r = await carryClaudeTranscript({
      fromDir: claudeConfigDir(job.carryFrom.configDir),
      toDir: claudeConfigDir(job.profile.configDir || ""),
      sessionId: job.session.nativeId!,
      lang: sessionLang(job.session),
    });
  } catch (e: any) {
    const why =
      e instanceof CarryError
        ? e.message
        : jobT(job)("server-turns.carry.copyFailed", { error: String(e?.message || e).slice(0, 160) });
    stage(rt, "carry", jobT(job)("server-turns.carry.notCarried"), "error", why);
    throw fail(why);
  }
  stage(
    rt,
    "carry",
    r.copied
      ? jobT(job)("server-turns.carry.copied", { n: r.copied })
      : jobT(job)("server-turns.carry.skipped", { why: r.skipped || jobT(job)("server-turns.carry.alreadyThere") }),
    "complete",
  );
  if (r.kept.length)
    rt.emit("item", {
      id: `${job.id}:carry-kept`,
      kind: "notice",
      category: "lifecycle",
      name: jobT(job)("server-turns.carry.name"),
      text: jobT(job)("server-turns.carry.kept", { files: r.kept.map((p) => basename(p)).join(jobT(job)("server-turns.list.comma")) }),
      status: "complete",
      createdAt: Date.now(),
    });
  // Lost: the next job carries again, which then finds it already there.
  await nodeApi(
    config,
    `/jobs/${job.id}/identity-carried`,
    { at: job.session.identityMove!.at },
    job.lease,
  ).catch(() => {});
}
export async function execute(
  config: NodeConfig,
  job: RunnerJob,
  outerSignal?: AbortSignal,
  live?: LiveRegistry,
  /** Daisy's tools for this job's Agent. */
  tools?: DaisyToolHost,
  /**
   * a 「只问」 sidecar job (run offline, `live` undefined) asks
   * its main session's process here when it is up (side_question).
   */
  mainLive?: LiveRegistry,
) {
  const journal = openJournal(config);
  journal.start(job.id, job.lease);
  const managedIdentity =
    job.profile.configDir?.startsWith("managed:") || false;
  /** the control plane asks for the transcript carry (换身份). */
  const carryAsked = !!job.carryFrom;
  job = {
    ...job,
    profile: resolveIdentity(job.profile, config.nodeId, config.identityRoot),
    // the old identity's directory, resolved the same way (a
    // managed one only as its own id's); unusable = nothing to carry.
    ...(job.carryFrom ? { carryFrom: carryDir(job.carryFrom, config) } : {}),
  };
  const controller = new AbortController(),
    signal = controller.signal,
    stop = () => controller.abort();
  outerSignal?.addEventListener("abort", stop, { once: true });
  const queue: { id: string; type: Event["type"]; data: any }[] = [];
  const approvals = new Map<string, Approval>();
  let inputHandler: InputHandler | null = null,
    inputDelivery: Promise<void> | null = null;
  /** Where this job's prompt and files live (set once it is prepared). */
  let inputPlace: { cwd: string; attachmentRoot: string } | null = null;
  /**
   * Daisy jobs delivered into this turn, by live input id — the
   * adapter's withdraw for 「移除」 (pulse `withdraw`).
   */
  const natives = new Map<string, NativeInput>();
  /** reports posted before the job reports its end. */
  const reports: Promise<void>[] = [];
  let reported: Promise<void> = Promise.resolve();
  /**
   * Node-authenticated (the job may be over): what the Agent did with an
   * appended job — one after another, so `started` lands before `completed`.
   */
  const nativeState = (mid: string, body: any) => {
    reported = reported.then(async () => {
      for (let i = 0; i < 20; i++)
        try {
          await nodeApi(config, `/inputs/${mid}/state`, body);
          return;
        } catch (e) {
          if (e instanceof ApiError && e.status < 500) return;
          await delay(500);
        }
    });
    reports.push(reported);
  };
  const withdrawing = new Set<string>();
  const withdrawNative = async (mid: string) => {
    const n = natives.get(mid);
    // Not handed to the Agent yet: asked again on the next pulse.
    if (!n?.cancel || withdrawing.has(mid)) return;
    withdrawing.add(mid);
    let back = false;
    try {
      back = await n.cancel();
    } catch {}
    natives.delete(mid);
    // Not given back: it was read already (its `started` follows) — or
    // the adapter cannot withdraw it; the control plane says so.
    nativeState(mid, back ? { state: "cancelled" } : { state: "kept" });
  };
  /** steers handed back, posted before the job reports its end. */
  const requeues: Promise<void>[] = [];
  /**
   * …and named again in the job's completion (review 3): if the POST did not
   * land (lease gone, 409), the control plane requeues them as it settles —
   * the same key (`steer:<input id>`), so never twice.
   */
  const returnedInputs: { id: string; reason: string }[] = [];
  const deliverInput = async () => {
    if (!inputHandler || signal.aborted) return;
    const handler = inputHandler;
    const { input } = await nodeApi(
      config,
      `/jobs/${job.id}/input/claim`,
      {},
      job.lease,
    );
    if (!input) return;
    // a Daisy job delivered natively (its own text, files,
    // terminal runs and page context, as its own turn would have them).
    let native: NativeInput | undefined;
    let text = input.text;
    if (input.job && inputPlace) {
      const prepared = preparePrompt(
        {
          ...job,
          id: input.job.id,
          text: input.job.text,
          attachments: input.job.attachments || [],
          context: input.job.context,
          terminal: input.job.terminal || [],
          session: { ...job.session, contextDelivered: true },
        },
        inputPlace.cwd,
        inputPlace.attachmentRoot,
      );
      text = prepared.prompt;
      native = {
        source: input.job.id,
        priority: "next",
        files: prepared.files,
        ...(Array.isArray(input.job.nativeApprovals)
          ? { approvals: input.job.nativeApprovals }
          : {}),
        report: (state, ownTurn) =>
          nativeState(input.id, { state, ...(ownTurn ? { ownTurn } : {}) }),
      };
      natives.set(input.id, native);
    }
    let result: {} | { error: string } = {};
    let completed!: () => void;
    const settled = new Promise<void>((r) => (completed = r));
    // the Agent did not take it after all — the control plane
    // sends it as the next turn (after this input's own completion).
    let handedBack = false;
    const requeue = (reason: string) => {
      if (handedBack) return;
      handedBack = true;
      returnedInputs.push({ id: input.id, reason: reason.slice(0, 500) });
      requeues.push(
        settled.then(async () => {
          for (let i = 0; i < 20; i++)
            try {
              await nodeApi(
                config,
                `/jobs/${job.id}/input/${input.id}/requeue`,
                { reason: reason.slice(0, 500) },
                job.lease,
              );
              return;
            } catch (e) {
              // Gone / settled: the control plane requeues what it holds.
              if (e instanceof ApiError && e.status < 500) return;
              await delay(500);
            }
        }),
      );
    };
    try {
      // A live (steer) input carries its own host page context (fb3 F1); the
      // bound task is first-turn data and never repeats here.
      if (input.job && !native) throw Error(jobT(job)("server-turns.input.notReady"));
      const sent = native
        ? text
        : input.context
          ? buildPrompt(input.text, null, false, [], input.context)
          : input.text;
      // What goes into the running turn is audited like a
      // turn's own text (it was not: only the turn's first message was) —
      // for a job with the layered prompt; without it, nothing new.
      try {
        if (layeredGuide(job)) safeEmit("item", {
          id: `${job.id}:prompt-audit:input:${input.id}`,
          kind: "tool",
          category: "audit",
          name: jobT(job)("server-turns.audit.steer"),
          status: "complete",
          text: sent,
          createdAt: Date.now(),
          input: {
            role: "user",
            systemPromptOverride: false,
            midTurn: true,
            source: native ? native.source : input.id,
            pageContextIncluded: native
              ? !!input.job?.context
              : !!input.context,
            sha256: createHash("sha256").update(sent).digest("hex"),
          },
        });
      } catch {}
      await handler(
        sent,
        requeue,
        // Claude ran it after all — take the requeued turn back.
        // Node-authenticated: the job may be over by then.
        () => {
          if (!handedBack) return;
          void (async () => {
            await settled;
            await Promise.allSettled([...requeues, ...reports]);
            for (let i = 0; i < 10; i++)
              try {
                await nodeApi(config, `/inputs/${input.id}/withdraw`, {});
                return;
              } catch (e) {
                if (e instanceof ApiError && e.status < 500) return;
                await delay(500);
              }
          })();
        },
        native,
        // Follow-up 2026-11-09: a plain steer read by the model — reported
        // after its hand-over (`complete`), so the bubble goes 「已交给」 →
        // 「已读取」 in that order. An older control plane answers 404.
        native
          ? undefined
          : () => void settled.then(() => nativeState(input.id, { state: "started" })),
      );
    } catch (e: any) {
      result = { error: String(e.message).slice(0, 2000) };
    }
    // Only the acknowledgement retries; the native input is never replayed.
    try {
      while (!signal.aborted) {
        try {
          await nodeApi(
            config,
            `/jobs/${job.id}/input/${input.id}/complete`,
            result,
            job.lease,
          );
          return;
        } catch (e) {
          if (e instanceof ApiError && e.status < 500) throw e;
          await delay(500);
        }
      }
    } finally {
      completed();
    }
  };
  let flushing: Promise<void> | null = null,
    inFlight = 0,
    pulsing = false,
    lastPulse = Date.now(),
    ended = false;
  const redact = (s: string) => {
    let out = s;
    if (job.profile.apiKey)
      out = out.split(job.profile.apiKey).join("[REDACTED]");
    return out
      .replace(
        /(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{16,})/g,
        "[REDACTED]",
      )
      .slice(-10000);
  };
  const safeEmit: Runtime["emit"] = (type, data) => {
    let encoded = JSON.stringify(data);
    if (job.profile.apiKey)
      encoded = encoded.split(job.profile.apiKey).join("[REDACTED]");
    if (queue.length > 2000) {
      controller.abort();
      throw Error(jobT(job)("server-turns.events.backlog"));
    }
    const event = { id: randomUUID(), type, data: JSON.parse(encoded) };
    journal.event(job.id, event);
    // Keep only the latest unsent snapshot of each item. Never mutate an
    // in-flight batch: its UUIDs must remain stable across HTTP retries.
    if (type === "item") {
      for (let i = queue.length - 1; i >= inFlight; i--) {
        if (queue[i].type === "item" && queue[i].data.id === data.id) {
          journal.ack([queue[i].id]);
          queue[i] = event;
          return;
        }
      }
    }
    queue.push(event);
  };
  const flush = () => {
    if (flushing) return flushing;
    flushing = (async () => {
      while (queue.length) {
        const batch = queue.slice(0, 20);
        inFlight = batch.length;
        try {
          await nodeApi(
            config,
            `/jobs/${job.id}/events`,
            { events: batch },
            job.lease,
          );
          journal.ack(batch.map((e) => e.id));
          queue.splice(0, batch.length);
          inFlight = 0;
        } catch (e) {
          if (
            signal.aborted ||
            (e instanceof ApiError && e.status < 500) ||
            Date.now() - lastPulse > 25_000
          ) {
            controller.abort();
            throw e;
          }
          await delay(500);
        }
      }
    })().finally(() => {
      flushing = null;
      inFlight = 0;
    });
    return flushing;
  };
  const pulse = async () => {
    if (pulsing || ended) return;
    pulsing = true;
    try {
      const r = await nodeApi(config, `/jobs/${job.id}/pulse`, {}, job.lease);
      lastPulse = Date.now();
      for (const a of r.approvals) approvals.set(a.id, a);
      if (r.cancel) controller.abort();
      // 「移除」 of an appended Daisy job not read yet.
      for (const mid of r.withdraw || []) void withdrawNative(mid);
      if (inputHandler && !inputDelivery && !signal.aborted) {
        inputDelivery = deliverInput()
          .catch((e) => log.error("Input delivery:", redact(e.message)))
          .finally(() => {
            inputDelivery = null;
          });
      }
    } catch (e) {
      if (
        (e instanceof ApiError && e.status === 409) ||
        Date.now() - lastPulse > 25_000
      )
        controller.abort();
    } finally {
      pulsing = false;
    }
  };
  const pulseTimer = setInterval(() => void pulse(), 1000),
    flushTimer = setInterval(() => {
      void flush().catch(() => controller.abort());
    }, 120);
  let status: "idle" | "error" | "interrupted" = "idle",
    detail: string | undefined,
    acquired = false,
    /** Why the online process ended this turn (立即重启). */
    liveReason: string | undefined;
  const liveInterrupt = (reason: string) => {
    liveReason = reason;
    controller.abort();
  };
  // a resident's own limit per turn, within the node's.
  const residentMinutes = job.session.resident?.maxTurnMinutes || 0;
  const limitMs = Math.min(
    config.maxJobDurationMs && config.maxJobDurationMs > 0
      ? config.maxJobDurationMs
      : Infinity,
    residentMinutes > 0 ? residentMinutes * 60_000 : Infinity,
  );
  const limitTimer = Number.isFinite(limitMs)
    ? setTimeout(
        () =>
          residentMinutes > 0 && limitMs === residentMinutes * 60_000
            ? liveInterrupt(
                jobT(job)("server-turns.resident.overLimit", { minutes: residentMinutes }),
              )
            : controller.abort(),
        limitMs,
      )
    : undefined;
  try {
    const original = safeWorkspace(job.workspace.path, config.allowedRoots);
    const isolated = ["isolated", "snapshot"].includes(
      job.session.workspaceMode || "",
    )
      ? await isolatedWorkspace(
          original,
          // a sidecar reads its main session's worktree (it
          // never creates one).
          job.session.sidecar?.parent || job.session.id,
          signal,
          (path) => {
            safeWorkspace(path, config.allowedRoots);
          },
          true,
          !isSidecar(job),
        )
      : null;
    const cwd = isolated?.path || original;
    const readOnly = ["read-only", "snapshot"].includes(
      job.session.workspaceMode || "",
    );
    // Native operations may spawn outside read-only enforcement; /compact
    // uses the protected adapter below.
    if (readOnly && job.operation && job.operation.name !== "compact")
      throw Error(
        jobT(job)("server-turns.readOnly.noOps"),
      );
    // Fail closed before starting an Agent in a read-only workspace.
    if (readOnly) readOnlyLaunch(job, cwd);
    const useLiveAgent =
      live && (!job.operation || job.operation.name === "compact");
    // a Claude rewind to a known message tries the session's own
    // process first (in place) — it is not closed for it up front.
    // Not when (review M2) the process still has background work or timers
    // (Claude's own or Daisy's for this session): they would carry the
    // rewound work on — the process is closed first instead. Only
    // from the CLI version it was measured on (review L4).
    const liveCandidate =
      job.operation?.name === "rewind" &&
      job.session.agent === "claude" &&
      typeof job.operation.args?.beforeUuid === "string" &&
      liveFeatures("claude")?.rewind?.history === "native"
        ? live?.peek(job.session.id)
        : null;
    const rewindBusy =
      !!liveCandidate &&
      (liveCandidate.pending().length > 0 ||
        // ADR-152: an older control plane sends it as `harborPending`.
        schedulerPendingOf(job.session).length > 0);
    const rewindLive = rewindBusy ? null : liveCandidate;
    let rewound: RewindOutcome | null = null;
    if (live && job.operation && !useLiveAgent) {
      if (SESSION_REWRITES.includes(job.operation.name) && !rewindLive?.rewind)
        live.close(job.session.id, jobT(job)("server-turns.op.offlineBefore", { op: job.operation.name }));
      if (PROFILE_REWRITES.includes(job.operation.name))
        live.closeProfile(job.profile.id, jobT(job)("server-turns.op.profileChanging"));
    }
    safeEmit("item", {
      id: job.id + ":workspace-ready",
      kind: "tool",
      category: "lifecycle",
      text: jobT(job)("server-turns.workspace.ready", {
        mode: jobT(job)(
          isSidecar(job)
            ? "server-turns.workspace.mode.sidecar"
            : readOnly
              ? "server-turns.workspace.mode.readOnly"
              : isolated
                ? "server-turns.workspace.mode.isolated"
                : "server-turns.workspace.mode.shared",
        ),
        cwd,
        branch: isolated ? jobT(job)("server-turns.workspace.branch", { branch: isolated.branch }) : "",
      }),
      status: "complete",
      createdAt: Date.now(),
    });
    const attachmentRoot = join(
      config.identityRoot || defaultStateRoot(),
      "runtime",
      job.session.id,
    );
    const prepared = preparePrompt(job, cwd, attachmentRoot);
    inputPlace = { cwd, attachmentRoot };
    // The static rules are in the system layer this
    // conversation really has → the turn keeps only the command line (and
    // the isolated branch's line, which only the Runner knows).
    const shortRules = staticRulesDelivered(job);
    if (readOnly && !shortRules) prepared.prompt += readOnlyNote(sessionT(job.session));
    prepared.prompt += isolated
      ? "\n" + sessionT(job.session)("prompt-guide.isolatedBranch", { branch: isolated.branch, cwd })
      : "";
    // shared-edit sessions only, after the turn's own text.
    if (!isolated && !readOnly && !isSidecar(job) && !shortRules)
      prepared.prompt += sharedWorkspaceNote(sessionT(job.session));
    const texts = new Map<string, string>();
    const ephemeralFork =
      isSidecar(job) &&
      job.session.agent === "codex" &&
      !!codexSidecarFork(job)?.ephemeral;
    const rt: Runtime = {
      managedIdentity,
      job,
      cwd,
      ...prepared,
      signal,
      // a sidecar has no Daisy tools (no timers, no background).
      tools: isSidecar(job) ? undefined : tools,
      emit: (type, data) => {
        // a throwaway (ephemeral) Codex fork is never resumed —
        // the sidecar keeps no native id of it.
        if (type === "native" && ephemeralFork) return;
        // a Daisy wake is not the owner's message (no bubble;
        // the control plane wrote its `wake:` marker).
        if (
          job.origin === "schedule" &&
          type === "item" &&
          data?.id === `user:${job.id}`
        )
          return;
        safeEmit(type, data);
        if (type === "item" && data.kind === "assistant")
          // A retracted answer publishes no files.
          if (data.retracted) texts.delete(data.id);
          else texts.set(data.id, data.text);
      },
      flush,
      onInput: (handler) => {
        inputHandler = handler;
      },
      publishAttachment: async (name, mime, data) =>
        nodeApi(
          config,
          `/jobs/${job.id}/artifacts`,
          { name, mime, data },
          job.lease,
        ),
      approve: async (title, input, options, meta) => {
        // a read-only sidecar never asks its owner — declined.
        if (isSidecar(job)) {
          safeEmit("item", {
            id: `${job.id}:sidecar-denied:${randomUUID()}`,
            kind: "notice",
            text: jobT(job)("server-turns.sidecar.denied", { title: String(title).slice(0, 80) }),
            status: "complete",
            createdAt: Date.now(),
          });
          const no = sidecarDecline(options);
          if (!no)
            throw Error(
              jobT(job)("server-turns.sidecar.noDecline"),
            );
          return { optionId: no } as any;
        }
        // P4-07 (ADR-126, A-3): a resident agent's dedicated session —
        // what auto mode still asks a person about is declined (its owner
        // may choose to be asked instead: then no `declineApprovals`).
        if (job.residentLimits?.declineApprovals) {
          safeEmit("item", {
            id: `${job.id}:resident-denied:${randomUUID()}`,
            kind: "notice",
            text: jobT(job)("server-turns.resident.denied", { title: String(title).slice(0, 80) }),
            status: "complete",
            createdAt: Date.now(),
          });
          const no = sidecarDecline(options);
          if (!no)
            throw Error(
              jobT(job)("server-turns.resident.noDecline"),
            );
          return { optionId: no } as any;
        }
        const aid = randomUUID();
        safeEmit("approval", {
          id: aid,
          title,
          input,
          options,
          ...(meta?.category ? { category: meta.category } : {}),
          ...(meta?.reason ? { reason: meta.reason.slice(0, 2000) } : {}),
        });
        safeEmit("status", { status: "waiting" });
        await flush();
        while (!signal.aborted) {
          const a = approvals.get(aid);
          if (a?.status === "answered" && a.decision) {
            safeEmit("status", { status: "running" });
            return a.decision;
          }
          if (a?.status === "expired") throw Error(jobT(job)("server-turns.approval.expired"));
          await delay(200);
        }
        throw Error(jobT(job)("server-turns.approval.cancelled"));
      },
    };
    stage(
      rt,
      "claimed",
      job.origin === "agent"
        ? jobT(job)("server-turns.claimed.agent")
        : job.origin === "schedule"
          ? jobT(job)("server-turns.claimed.schedule")
          : jobT(job)("server-turns.claimed.node"),
      "complete",
      job.origin === "agent" || job.origin === "schedule"
        ? job.wake || ""
        : jobT(job)("server-turns.claimed.workspace", { cwd }),
    );
    if (!job.operation && job.origin !== "agent")
      rt.emit("item", {
        id: `${job.id}:prompt-audit`,
        kind: "tool",
        category: "audit",
        name: jobT(job)("server-turns.audit.sent"),
        status: "complete",
        text: prepared.prompt,
        createdAt: Date.now(),
        input: {
          role: "user",
          systemPromptOverride: false,
          // what Daisy appended to the system layer for this
          // process (the 「提示词」 page shows it), and whether this turn
          // carries the short collaboration line.
          ...(layeredGuide(job)
            ? {
                guideSha256: createHash("sha256")
                  .update(isSidecar(job) ? sidecarGuide(job) : launchGuide(job))
                  .digest("hex"),
                layered: true,
                shortRules,
              }
            : {}),
          taskIncluded:
            !(job.session.contextDelivered ?? !!job.session.nativeId) &&
            !!job.session.task,
          pageContextIncluded: !!job.context,
          terminalIncluded: job.terminal?.length || 0,
          sha256: createHash("sha256").update(prepared.prompt).digest("hex"),
          images: prepared.files
            .filter((x) => x.mime.startsWith("image/"))
            .map((x) => ({ path: x.path, mime: x.mime })),
        },
      });
    await flush();
    // once after 「换身份」, before any Claude command (turn,
    // /compact, fork, rewind, the native CLI…) resumes the conversation.
    if (
      carryAsked &&
      job.session.agent === "claude" &&
      job.session.nativeId &&
      job.session.identityMove
    )
      await carryTranscript(config, job, rt, live);
    const registry =
      live ||
      new LiveRegistry({
        api: async () => ({}),
        runWake: () => {},
        enabled: false,
        idleMs: 0,
      });
    if (job.operation?.name === "compact") {
      // the Agent's own compaction, in the session's process.
      stage(rt, "operation", jobT(job)("server-turns.op.compact"), "running");
      try {
        const agent = registry.acquire(job, cwd, liveInterrupt);
        let outcome;
        try {
          outcome = await agent.turn({ ...rt, prompt: "/compact" });
        } finally {
          await registry.release(job.session.id, agent);
        }
        await nodeApi(
          config,
          `/jobs/${job.id}/operation-result`,
          { completed: true, ...(outcome.compact || {}) },
          job.lease,
        );
        stage(rt, "operation", jobT(job)("server-turns.op.done", { op: "compact" }), "complete");
      } catch (e: any) {
        await nodeApi(
          config,
          `/jobs/${job.id}/operation-result`,
          { error: redact(e.message) },
          job.lease,
        ).catch(() => {});
        throw e;
      }
    } else if (
      rewindLive?.rewind &&
      (rewound = await rewindInPlace(rt, rewindLive))?.inPlace
    ) {
      // 「回退」 in place on the live Claude process (same native
      // id, files too when asked).
      await nodeApi(
        config,
        `/jobs/${job.id}/operation-result`,
        {
          sessionId: rewound.sessionId,
          inPlace: true,
          ...(rewound.prefillText !== undefined
            ? { prefillText: rewound.prefillText }
            : {}),
          files: rewound.files,
        },
        job.lease,
      );
      stage(rt, "operation", jobT(job)("server-turns.op.rewindLiveDone"), "complete");
    } else if (job.operation) {
      if (rewindBusy)
        stage(
          rt,
          "rewind-live",
          jobT(job)("server-turns.op.rewindOffline"),
        );
      if (SESSION_REWRITES.includes(job.operation.name))
        live?.close(job.session.id, jobT(job)("server-turns.op.offlineBefore", { op: job.operation.name }));
      if (PROFILE_REWRITES.includes(job.operation.name))
        live?.closeProfile(
          job.profile.id,
          jobT(job)("server-turns.op.profileChanged"),
        );
      stage(rt, "operation", jobT(job)("server-turns.op.running", { op: job.operation.name }), "running");
      try {
        const result =
          job.operation.name === "terminal"
            ? await runTerminal(rt, (part, data) =>
                nodeApi(
                  config,
                  `/jobs/${job.id}/terminal/exchange`,
                  { part, data },
                  job.lease,
                ),
              )
            : await runOperation(rt);
        await nodeApi(
          config,
          `/jobs/${job.id}/operation-result`,
          // what happened to the files, said plainly.
          job.operation.name === "rewind" &&
            result &&
            typeof result === "object"
            ? {
                ...result,
                // Codex's own (Daisy-checkpoint) result stands.
                files:
                  (result as any).files ??
                  rewindFilesFallback(job, rewound, rewindBusy),
              }
            : (result ?? { completed: true }),
          job.lease,
        );
        stage(rt, "operation", jobT(job)("server-turns.op.done", { op: job.operation.name }), "complete");
      } catch (e: any) {
        // Review L3: the files were restored before the copy failed — say so.
        const restored = rewound?.files.reverted
          ? rewound.files.filesChanged?.length || 0
          : -1;
        await nodeApi(
          config,
          `/jobs/${job.id}/operation-result`,
          {
            error:
              redact(e.message) +
              (restored >= 0
                ? jobT(job)("server-turns.op.filesRestoredAnyway", { n: restored })
                : ""),
            ...(rewound
              ? { files: rewound.files }
              : e?.files
                ? { files: e.files }
                : {}),
          },
          job.lease,
        ).catch(() => {});
        throw e;
      }
    } else if (isSidecar(job) && (await askNatively(rt, mainLive))) {
      // the live main process answered (side_question).
    } else {
      const agent = registry.acquire(job, cwd, liveInterrupt);
      acquired = true;
      try {
        await agent.turn(rt);
      } finally {
        await registry.release(job.session.id, agent);
      }
    }
    inputHandler = null;
    if (inputDelivery) await inputDelivery;
    await Promise.allSettled([...requeues, ...reports]);
    // Only explicit Markdown links to files inside this workspace are published.
    const paths = new Set<string>();
    for (const text of texts.values())
      for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
        let raw = match[1].replace(/^<|>$/g, "");
        if (/^[a-z]+:\/\//i.test(raw)) continue;
        try {
          raw = decodeURIComponent(raw);
        } catch {}
        try {
          const path = realpathSync(resolve(cwd, raw)),
            r = relative(cwd, path);
          if (r.startsWith("..") || isAbsolute(r) || paths.has(path)) continue;
          const st = statSync(path);
          if (!st.isFile() || st.size > 8 * 1024 * 1024 || paths.size >= 12)
            continue;
          paths.add(path);
          const mime =
            (
              {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".gif": "image/gif",
                ".webp": "image/webp",
                ".pdf": "application/pdf",
                ".md": "text/markdown",
                ".txt": "text/plain",
              } as Record<string, string>
            )[extname(path).toLowerCase()] || "application/octet-stream";
          const attachment = await nodeApi(
            config,
            `/jobs/${job.id}/artifacts`,
            {
              name: basename(path),
              mime,
              data: readFileSync(path).toString("base64"),
            },
            job.lease,
          );
          safeEmit("item", {
            id: `${job.id}:artifact:${attachment.id}`,
            kind: "notice",
            text: jobT(job)("server-turns.artifact"),
            attachments: [attachment],
            createdAt: Date.now(),
          });
        } catch {
          /* Missing links stay ordinary text. */
        }
      }
    await flush();
    if (signal.aborted) status = "interrupted";
    if (signal.aborted && liveReason) detail = liveReason;
    if (signal.aborted && outerSignal?.reason instanceof ProcessAbort)
      detail = outerSignal.reason.message;
  } catch (e) {
    // steers handed back still become the next turn.
    if (inputDelivery) await inputDelivery.catch(() => {});
    await Promise.allSettled([...requeues, ...reports]);
    status = signal.aborted ? "interrupted" : "error";
    detail = redact((e as Error).message);
    if (signal.aborted && liveReason) detail = liveReason;
    // 立即重启: say why the turn ended, like a stop does.
    if (signal.aborted && outerSignal?.reason instanceof ProcessAbort)
      detail = outerSignal.reason.message;
    try {
      await flush();
    } catch {
      status = "error";
      detail = jobT(job)("server-turns.output.incomplete");
    }
  } finally {
    ended = true;
    clearInterval(pulseTimer);
    clearInterval(flushTimer);
    clearTimeout(limitTimer);
    outerSignal?.removeEventListener("abort", stop);
    // The job is over: end what still waits on it (an approval the Agent
    // asked for before its process was closed).
    controller.abort();
    // An Agent-started turn whose job failed before attaching (review r1 #2).
    if (job.origin === "agent" && !acquired) live?.abandon(job.session.id);
  }
  journal.finish(job.id, { status, detail });
  try {
    const receipt = (await reportCompletion(() =>
      nodeApi(
        config,
        `/jobs/${job.id}/complete`,
        {
          status,
          detail,
          ...(returnedInputs.length
            ? { requeue: returnedInputs.slice(0, 50) }
            : {}),
        },
        job.lease,
      ),
    )) as { accepted?: boolean; titleRequest?: TitleRequest };
    // Second round of an untitled conversation: its one AI
    // title, in the background; the job is already complete, the session free.
    if (status === "idle" && receipt.titleRequest) {
      // named by the session's live process where the agent can
      // (no extra CLI process); then the applied title to the native session.
      const sid = job.session.id,
        caps = liveFeatures(job.session.agent)?.title,
        main = () => live?.peek(sid) ?? null;
      void suggestTitle(
        job,
        receipt.titleRequest,
        async (title) => {
          const r: any = await nodeApi(
            config,
            `/sessions/${sid}/title`,
            title ? { title, stage: "final" } : { title, failed: true },
          );
          if (r?.applied && r.title && caps?.sync === "native")
            await main()
              ?.pushTitle?.(r.title)
              .catch(() => {});
          return r;
        },
        caps?.generate === "native"
          ? async (d, ms) => (await main()?.generateTitle?.(d, ms)) ?? null
          : null,
        // Re-review L-d: the owner already named the native session (its
        // report failed): that name, not a new one.
        caps?.sync === "native"
          ? async () => {
              const owner = main()?.ownerName?.();
              if (!owner) return false;
              const r: any = await nodeApi(config, `/sessions/${sid}/title`, {
                title: owner,
                source: "native",
                base: nativeTitle(job.session.title),
              });
              return !!r?.applied;
            }
          : null,
      );
    }
    if (receipt.accepted !== false && journal.evidence(job.id).length === 0)
      journal.remove(job.id);
    if (receipt.accepted === false)
      log.error(
        `Job ${job.id}: late completion was not applied; inspect the interrupted request before retrying work`,
      );
  } catch {
    log.error(
      `Job ${job.id}: completion saved locally; reconnect will transport evidence without rerunning work`,
    );
  } finally {
    journal.close();
  }
}
/**
 * runNode's result: `restart` = exit 75 so the service manager starts the
 * process again (the installed or the built release); `requested` = the
 * owner asked for it (P1-02, the local API).
 */
export type NodeExit =
  | {
      restart: string;
      from: string;
      requested?: RestartRequest;
    }
  | undefined;
/** 空闲时重启 (the owner's): continuous idleness before exiting. */
export const REQUEST_IDLE_MS = 5_000;
/**
 * The Runner's loop, inside the Daisy process (P1-02). It claims the work
 * the control plane queues for `config.nodeId` and runs it, through
 * `config.api` — the same calls it made over HTTP when it was a process of
 * its own. `restart`: the process's restart state (the local API asks,
 * this loop carries it out once idle, or now when the owner confirmed).
 */
export async function runNode(
  config: NodeConfig,
  signal: AbortSignal,
  restart?: ProcessRestart,
  /** P5-06: updating an npm-installed Daisy (daemon.ts). */
  packageUpdate?: PackageUpdate,
): Promise<NodeExit> {
  if (typeof config.api !== "function" || !config.allowedRoots?.length)
    throw Error("Invalid node configuration");
  // An older runner.json (serverUrl): its state under the new key.
  for (const m of migrateStateKey(config as any))
    log.info(`Local state moved to the new key: ${m}`);
  // P1-02b: an old results.sqlite goes into daisy.sqlite before any work.
  openJournal(config);
  const activeIds = new Set<string>();
  // 立即重启 stops the work of this process, not just the loop.
  const stopAll = new AbortController(),
    workSignal = AbortSignal.any([signal, stopAll.signal]);
  let lastRecovery = 0;
  let recovering: Promise<void> | null = null;
  const active = new Set<Promise<void>>(),
    /** Sessions with a job running here, one entry per job. */
    jobSessions: string[] = [],
    /** P1-02: the jobs running here (what a restart would interrupt). */
    jobsRunning = new Map<string, { sessionId: string; since: number }>();
  const run = (job: RunnerJob) => {
    const sid = job.session.id;
    jobSessions.push(sid);
    activeIds.add(job.id);
    jobsRunning.set(job.id, { sessionId: sid, since: Date.now() });
    // a sidecar runs one process per turn (never kept online).
    const turn = execute(
      config,
      job,
      workSignal,
      isSidecar(job) ? undefined : live,
      toolHost,
      isSidecar(job) ? live : undefined,
    ).catch((e) => log.error("Runner job error:", e.message));
    active.add(turn);
    void turn.finally(() => {
      active.delete(turn);
      activeIds.delete(job.id);
      jobsRunning.delete(job.id);
      jobSessions.splice(jobSessions.indexOf(sid), 1);
    });
  };
  const slots = Math.max(1, Math.min(8, config.concurrency || 8));
  // Daisy background commands / monitors run here; timers are
  // the control plane's. The first sync tells it what a restart lost.
  const background = new BackgroundManager(
    (path, body) => nodeApi(config, path, body),
    config.backgroundLimit ??
      positiveEnv(daisyEnv("DAISY_RUNNER_BACKGROUND_LIMIT")) ??
      SCHEDULE_LIMITS.nodeBackground,
  );
  // Review M2: SIGTERM aborts this signal synchronously; children systemd
  // signals at the same time are then reported lost, not failed.
  signal.addEventListener("abort", () => {
    background.stopping = true;
  });
  const toolHost = new DaisyToolHost(
    (path, body) => nodeApi(config, path, body),
    background,
    stateRoot(config),
  );
  // P1-10: plugins (off by default). The callback feed and the org core
  // that used to be read here are a plugin's (hooks 1 and 2).
  const plugins = await loadRunnerPlugins(pluginSelection(config.plugins), {
    api: (path, body) => nodeApi(config, path, body),
    stateRoot: stateRoot(config),
    stateKey: stateKey(config.nodeId),
    user: runnerIdentity().username,
    log: (m) => log.warn(m),
  });
  const deactivatePlugins = activateRunnerPlugins(plugins);
  /** Plugins whose first waiting tick was waited for (seam: at most once each). */
  const pluginWaited = new Set<string>();
  let backgroundSynced = false,
    lastBackgroundSync = 0;
  const syncBackground = () => {
    lastBackgroundSync = Date.now();
    void background.sync().then(
      () => {
        backgroundSynced = true;
      },
      () => {},
    );
  };
  const live = new LiveRegistry({
    api: (path, body) => nodeApi(config, path, body),
    runWake: run,
    enabled: config.live ?? daisyEnv("DAISY_LIVE") !== "0",
    idleMs:
      config.liveIdleMs ??
      (Number(daisyEnv("DAISY_LIVE_IDLE_MS")) || LIVE_IDLE_MS),
    evictIdleMs: config.liveEvictIdleMs ?? EVICT_IDLE_MS,
  });
  // Codex file checkpoints live under the Runner's state root.
  // Configured only once `live` and `jobSessions` exist: the `kept`
  // callback reading them earlier would hit the TDZ (a ReferenceError the
  // sweep's catch turns into a silently skipped sweep).
  configureFileCheckpoints({
    stateRoot: stateRoot(config),
    gone: async (ids) =>
      ids.length
        ? ((await nodeApi(config, "/sessions/gone", { ids: ids.slice(0, 500) }))
            ?.gone ?? [])
        : [],
    // Online or running here: never swept by age.
    kept: () => [...live.sessions(), ...jobSessions],
  });
  const liveIdleMs =
    config.liveIdleMs ??
    (Number(daisyEnv("DAISY_LIVE_IDLE_MS")) || LIVE_IDLE_MS);
  const liveTimer = setInterval(
    () => {
      live.sweep();
      if (live.enabled) void live.report();
    },
    Math.max(250, Math.min(10_000, liveIdleMs / 2)),
  );
  let lastDetect = Date.now(),
    redetecting = false;
  const caps = await capabilities(),
    logins = new Set<Promise<void>>(),
    loginIds = new Map<Promise<void>, { id: string; since: number }>(),
    shells = new Set<Promise<void>>(),
    shellIds = new Map<
      Promise<void>,
      { id: string; sessionId?: string; since: number }
    >();
  caps.filesystem = {
    home: filesystemHome(config),
    roots: filesystemRoots(config),
  };
  // Whether an exit means being started again, and by what.
  const sup = supervision({ selfRestart: config.selfRestart }),
    supervised = sup.supervised;
  /** This process: a restart shows as a new id. */
  const processId = randomUUID();
  const upgrade = new UpgradeWatch({
    file: config.releaseFile,
    enabled: supervised,
    idleMs: config.restartIdleMs,
    settleMs: config.releaseSettleMs,
  });
  // the launch audit names the code this process runs.
  setRunnerBuild(upgrade.started);
  // Which code this process runs and how it updates, for the node table,
  // operators and release scripts. P6-01 (ADR-151): updates are the npm
  // update's (P5-06) only — the git-checkout updater is gone.
  caps.runner = {
    release: upgrade.started,
    selfRestart:
      upgrade.enabled || (supervised && !!packageUpdate?.status().supported),
    autoUpdate: autoUpdateStatus(),
    process: { id: processId, startedAt: Date.now() },
    restart: restartCapability(sup),
    // Follow-up 2026-11-09: reports when the model read a 立即追加
    // (`/inputs/:mid/state` started), so its bubble may say 「已交给」 first.
    inputReads: true,
  };
  /** The auto-update a node shows: the npm package's (P5-06). */
  function autoUpdateStatus() {
    return nodeAutoUpdate(packageUpdate?.status());
  }
  /** P1-02: what a restart would end right now. */
  const busyNow = (): BusyItem[] => {
    const out: BusyItem[] = [];
    for (const [id, j] of jobsRunning)
      out.push({ kind: "turn", id, sessionId: j.sessionId, since: j.since });
    const turns = new Set([...jobsRunning.values()].map((j) => j.sessionId));
    for (const sid of live.busySessions())
      if (!turns.has(sid)) out.push({ kind: "online", sessionId: sid });
    for (const b of background.list())
      out.push({ kind: "background", ...b });
    for (const l of loginIds.values()) out.push({ kind: "login", ...l });
    for (const sh of shellIds.values()) out.push({ kind: "shell", ...sh });
    return out;
  };
  const detachRestart = restart?.attach({ busy: busyNow, supervision: sup });
  /**
   * Nothing in flight here but background work: no turn, login,
   * shell command, recovery, title call; every online Agent without a turn,
   * a wake on its way or unsent events.
   */
  const idleButBackground = () =>
    active.size === 0 &&
    jobSessions.length === 0 &&
    logins.size === 0 &&
    shells.size === 0 &&
    !recovering &&
    namingInFlight() === 0 &&
    live.quiet(true);
  /** Nothing in flight here at all (see upgrade.ts for why each counts). */
  const idle = () =>
    idleButBackground() && background.size === 0 && live.quiet();
  // a pending restart waits for background work only so long.
  const drain = new RestartDrain(
    config.restartWaitMs ??
      positiveEnv(daisyEnv("DAISY_RUNNER_RESTART_WAIT_MS")) ??
      SCHEDULE_LIMITS.restartWaitMs,
  );
  const drainReason = () =>
    turnT()("server-turns.drain.stopped", { minutes: Math.max(1, Math.round(drain.waitMs / 60_000)) });
  /**
   * Idle as far as a restart is concerned: completely idle, or — once the
   * wait for background work is over — idle but for it. Daisy's background
   * work is stopped (and reported) then, and new work is refused.
   */
  const restartIdle = () => {
    const pending =
      !!upgrade.outdated() ||
      !!packageUpdate?.ready() ||
      !!restart?.requested();
    const base = idleButBackground();
    const holding = background.size > 0 || !live.quiet();
    // Only idle-but-background time counts, and only then is new work
    // refused (review M4: a busy node keeps taking background work).
    if (!drain.tick(pending, base, holding) || !base) {
      background.draining = null;
      return idle();
    }
    background.draining =
      turnT()("server-turns.drain.noNew");
    if (background.size) {
      background.interruptAll(drainReason(), drain.stopBefore());
      return false;
    }
    return true;
  };
  /** The owner's 空闲时重启: idle since (null: not idle). */
  let requestIdleSince: number | null = null;
  let exit: NodeExit;
  let lastSync = 0,
    lastError = 0,
    rejected = 0,
    confirmed = false;
  while (!signal.aborted) {
    // Before any claim: once the installed release changed and nothing has
    // been in flight for a while, stop claiming and exit for a restart.
    const idleNow = restartIdle();
    const target = upgrade.due(idleNow);
    const pkgWaiting = packageUpdate?.ready() ? packageUpdate.status().available : null;
    restart?.setPending(
      upgrade.outdated()
        ? { kind: "release", target: upgrade.outdated()! }
        : pkgWaiting
          ? { kind: "update", target: pkgWaiting.release ?? pkgWaiting.version }
          : null,
    );
    if (target) {
      // P5-06: installed by hand (npm install -g) — backed up and put on
      // trial like any update; code that does not load goes back.
      if (packageUpdate && !(await packageUpdate.switchInstalled(target))) {
        upgrade.recheck();
        continue;
      }
      exit = { restart: target, from: upgrade.started! };
      break;
    }
    // P5-06: a newer npm package found (or asked for), once idle.
    const pkgTarget = packageUpdate ? await packageUpdate.tick(idleNow) : null;
    if (pkgTarget) {
      exit = { restart: pkgTarget, from: packageUpdate!.status().running ?? "unknown" };
      break;
    }
    // The owner's 「重启」 (local API): 空闲时 = idle for a moment, 立即 = now.
    let asked = restart?.requested();
    // 立即: only what the owner confirmed may be cut off — something that
    // started since (an Agent-started turn, say) cancels it; asked again,
    // the owner sees the new list.
    if (asked?.mode === "now") {
      const extra = unconfirmed(busyNow(), asked.confirmed);
      if (extra.length) {
        restart!.dropNow(asked, extra);
        asked = null;
      }
    }
    if (!asked || !idleNow) requestIdleSince = null;
    else requestIdleSince ??= Date.now();
    if (
      asked &&
      (asked.mode === "now" ||
        (requestIdleSince !== null &&
          Date.now() - requestIdleSince >=
            (config.restartRequestIdleMs ?? REQUEST_IDLE_MS)))
    ) {
      const from = upgrade.started ?? "unknown";
      restart!.done(asked);
      exit = {
        restart: upgrade.outdated() ?? from,
        from,
        requested: asked,
      };
      break;
    }
    try {
      if (Date.now() - lastSync > (config.syncMs ?? 10_000)) {
        // A CLI installed while the Runner runs shows up without a restart.
        if (!redetecting && Date.now() - lastDetect > AGENT_REDETECT_MS) {
          redetecting = true;
          void capabilities()
            .then((fresh) => {
              const keep = AGENT_IDS.some(
                (a) => fresh[a]?.failed && caps[a]?.installed,
              );
              if (keep) return; // a slow --version: keep what was known
              for (const a of [...AGENT_IDS, "contextUsage"])
                caps[a] = fresh[a];
            })
            .catch(() => {})
            .finally(() => {
              lastDetect = Date.now();
              redetecting = false;
            });
        }
        caps.runner.autoUpdate = autoUpdateStatus();
        // P1-02: was the heartbeat — capabilities up, the control plane's
        // state for this node down; no liveness, restart or release.
        const state = await nodeApi(config, "/sync", {
          capabilities: caps,
          runner: runnerIdentity(),
        });
        lastSync = Date.now();
        rejected = 0;
        if (!confirmed) {
          confirmed = true;
          // P5-06: the start guard's health check waits for this.
          markRunnerSynced();
        }
        // which L1 document is the org layer; P1-10: to plugins.
        for (const p of plugins)
          try {
            p.sync?.(state);
          } catch (e: any) {
            log.warn(`Plugin ${p.name}: ${e?.message || e}`);
          }
        retireIdentities(
          state.retiredIdentities,
          config.nodeId,
          config.identityRoot,
        );
        if (state.blocked) {
          if (Date.now() - lastError > 15_000) {
            log.error("Runner blocked:", state.blocked);
            lastError = Date.now();
          }
          lastSync = 0; // re-check every 5 s instead of polling claims
          await delay(5000);
          continue;
        }
      }
      // every 5 s while something runs, 30 s otherwise.
      if (
        background.supported &&
        Date.now() - lastBackgroundSync >
          (!backgroundSynced ? 2000 : background.size ? 5000 : 30_000)
      )
        syncBackground();
      // P1-10: plugins' work before claiming (hooks 1 and 2). A promise a
      // plugin returns the first time is waited for, briefly (the
      // org core's first read is reported before any claim).
      for (const p of plugins) {
        let pass: Promise<void> | void;
        try {
          pass = p.tick?.();
        } catch (e: any) {
          log.warn(`Plugin ${p.name}: ${e?.message || e}`);
          continue;
        }
        if (pass && !pluginWaited.has(p.name)) {
          pluginWaited.add(p.name);
          await Promise.race([pass.catch(() => {}), delay(PLUGIN_TICK_WAIT_MS)]);
        }
      }
      // 立即重启 waits for its next loop pass: nothing new starts meanwhile
      // (the owner confirmed a list; a claim now would cut off more).
      const holdClaims = () => restart?.requested()?.mode === "now";
      if (holdClaims()) {
        await delay(50);
        continue;
      }
      const { request: fsRequest } = await nodeApi(config, "/filesystem/claim");
      if (fsRequest) {
        let result: any;
        try {
          result =
            fsRequest.operation === "browse"
              ? {
                  listing: browseDirectory(
                    config,
                    fsRequest.path,
                    fsRequest.offset,
                    fsRequest.hidden,
                  ),
                }
              : { directory: ensureDirectory(config, fsRequest.path) };
        } catch (e: any) {
          result = {
            error:
              e.code === "EACCES"
                ? turnT()("server-turns.dir.noAccess")
                : e.code === "ENOENT"
                  ? turnT()("server-turns.dir.willCreate")
                  : String(e.message).slice(0, 2000),
          };
        }
        await nodeApi(
          config,
          `/filesystem/${fsRequest.id}/complete`,
          result,
          fsRequest.lease,
        );
      }
      if (shells.size < 3 && !holdClaims()) {
        const { request: shellRequest } = await nodeApi(config, "/shell/claim");
        if (shellRequest) {
          const work = runShell(config, shellRequest, workSignal)
            .then((result) =>
              nodeApi(
                config,
                `/shell/${shellRequest.id}/complete`,
                result,
                shellRequest.lease,
              ),
            )
            .then(() => {})
            .catch((e) => log.error("Shell request:", e.message));
          shells.add(work);
          shellIds.set(work, {
            id: shellRequest.id,
            ...(shellRequest.sessionId
              ? { sessionId: shellRequest.sessionId }
              : {}),
            since: Date.now(),
          });
          void work.finally(() => {
            shells.delete(work);
            shellIds.delete(work);
          });
        }
      }
      if (logins.size < 3 && !holdClaims()) {
        const { login } = await nodeApi(config, "/logins/claim");
        if (login) {
          const work = executeLogin(config, login, workSignal).catch((e) =>
            log.error("Login runner:", e.message),
          );
          logins.add(work);
          loginIds.set(work, { id: login.id, since: Date.now() });
          void work.finally(() => {
            logins.delete(work);
            loginIds.delete(work);
          });
        }
      }
      if (!recovering && Date.now() - lastRecovery > 10_000) {
        lastRecovery = Date.now();
        recovering = (async () => {
          const journal = openJournal(config);
          try {
            await recoverJournal(
              journal,
              activeIds,
              (jid, lease, body) =>
                nodeApi(config, `/jobs/${jid}/recover`, body, lease),
              (jid, error) =>
                log.error(`Recovery ${jid}: ${(error as Error).message}`),
            );
          } finally {
            journal.close();
          }
        })()
          .catch((e) => log.error("Recovery journal:", e.message))
          .finally(() => {
            recovering = null;
          });
      }
      // slots are online Agents, not running turns. A session
      // already online (idle, waiting for authorization, running background
      // work) takes its next turn in its own slot; a new one needs a free
      // slot, and when there is none the longest-idle Agent with nothing in
      // the background goes offline to make room.
      if (holdClaims()) continue;
      const holding = new Set([...live.sessions(), ...jobSessions]);
      const {
        job,
        waiting,
        live: report,
      } = await nodeApi(config, "/claim", {
        free: slots - holding.size,
        online: [...holding],
        workspaceProtocol: 3,
      });
      if (job) {
        run(job);
        continue;
      }
      if (waiting) live.evictIdle();
      // An identity's auto-compact threshold changed: report the
      // online processes now, the answer says which to restart.
      if (report && live.enabled) void live.report();
      rejected = 0;
    } catch (e) {
      // Three consecutive 401s (not a blip): the node is revoked.
      if (e instanceof ApiError && e.status === 401 && ++rejected >= 3) {
        clearInterval(liveTimer);
        live.closeAll();
        await Promise.allSettled([...active, ...logins, ...shells]);
        detachRestart?.();
        throw new NodeTokenRejected(
          turnT()("server-turns.node.revoked", { error: String(e.message) }),
        );
      }
      if (!(e instanceof ApiError && e.status === 401)) rejected = 0;
      if (Date.now() - lastError > 15_000) {
        log.error("Runner:", (e as Error).message);
        lastError = Date.now();
      }
    }
    await delay(500);
  }
  clearInterval(liveTimer);
  if (exit?.requested) {
    const now = exit.requested.mode === "now";
    log.info(
      now
        ? "Restarting now as the owner asked: work in progress is interrupted (marked interrupted, not replayed); the service manager starts it again after the exit"
        : "Restarting as the owner asked (fully idle): the service manager starts it again after the exit",
    );
    // Running turns end the way a stop ends them (interrupted, with a
    // notice); nothing is replayed.
    if (now) stopAll.abort(new RestartAbort());
    live.closeAll(
      now
        ? turnT()("server-turns.restart.now")
        : turnT()("server-turns.restart.idle"),
    );
    if (live.enabled)
      for (let i = 0; i < 2; i++) await live.report().catch(() => {});
  } else if (exit) {
    log.info(
      `Code updated (${exit.from.slice(0, 7)} → ${exit.restart.slice(0, 7)}), idle for ${Math.round((config.restartIdleMs ?? RESTART_IDLE_MS) / 1000)}s with no work: exiting so the service manager restarts the new version`,
    );
    // Idle Agents only (checked above); say why they went offline. A report
    // already on its way would not carry the reasons: send one after it.
    live.closeAll(
      turnT()("server-turns.restart.updated"),
    );
    if (live.enabled)
      for (let i = 0; i < 2; i++) await live.report().catch(() => {});
  }
  live.closeAll();
  // nothing outlives the Runner. Each is reported `lost`
  // now, with its output's end (the control plane keeps the report until the
  // Agent can be woken); what cannot be sent in time the next start's sync
  // reports lost.
  await background.stopAll(
    exit
      ? turnT()("server-turns.background.endedRestart")
      : turnT()("server-turns.background.endedStop"),
  );
  await Promise.allSettled([...active, ...logins, ...shells]);
  await recovering;
  deactivatePlugins();
  detachRestart?.();
  return exit;
}
