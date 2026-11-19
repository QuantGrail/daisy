import { shippedPacks } from "../../../contracts/src/i18n-node.ts";
import type { MessageKey } from "../../../contracts/src/i18n.ts";
import { turnT } from "./model-switch.ts";
import { daisyEnv } from "../../../contracts/src/env.ts";
import {
  realpathSync,
  mkdirSync,
  writeFileSync,
  statSync,
  accessSync,
  constants,
} from "node:fs";
import { resolve, relative, isAbsolute, join, basename, sep } from "node:path";
import { pluginSessionEnv } from "../plugins/runner.ts";
import { acpHarness } from "../../../contracts/src/acp-harnesses.ts";
import { buildPrompt } from "../../../contracts/src/prompt.ts";
import {
  contextUsageCapability,
  type ContextUsageCapability,
} from "../../../contracts/src/context-usage.ts";
import {
  settingsRoute,
  type AgentSettingsCapabilities,
} from "../../../contracts/src/agent-capabilities.ts";
import type {
  RunnerJob,
  Item,
  Approval,
  Event,
  LiveActivity,
  LiveTimer,
  CompactInfo,
  CacheCounters,
  CompactMark,
  ContextThreshold,
  ContextUsage,
  ModelSlot,
  QuotaSnapshot,
} from "../../../contracts/src/index.ts";
/**
 * a Daisy job delivered into the running turn (「插队发送」 while
 * live, a Daisy wake): its files, and how the adapter reports what the
 * Agent did with it. Absent for a plain 立即追加 (text only).
 */
export interface NativeInput {
  /** The Daisy job (pending in Daisy's queue until it is read). */
  source: string;
  /** The provider-neutral priority: into this turn at its next boundary. */
  priority: "next";
  files: { path: string; mime: string; data: string }[];
  /** the owner's native approvals it brings (RunnerJob.nativeApprovals). */
  approvals?: RunnerJob["nativeApprovals"];
  /**
   * The Agent read it (`started`; `ownTurn`: as a turn of its own after
   * the running one ended) / finished with it (`completed`).
   */
  report: (state: "started" | "completed", ownTurn?: boolean) => void;
  /**
   * Set by the adapter when it can withdraw it while not yet read
   * (「移除」): resolves true when the Agent gave it back.
   */
  cancel?: () => Promise<boolean>;
}
export type InputHandler = (
  text: string,
  requeue: (reason: string) => void,
  withdraw: () => void,
  native?: NativeInput,
  /**
   * Follow-up 2026-11-09: a plain 立即追加 (no `native`) was read by the
   * model — Claude `command_lifecycle` started (or its replay), Codex
   * `turn/steer` answered. Resolving the handler is only the hand-over.
   */
  read?: () => void,
) => Promise<void>;
export interface Runtime {
  managedIdentity?: boolean;
  job: RunnerJob;
  cwd: string;
  prompt: string;
  files: { path: string; mime: string; data: string }[];
  signal: AbortSignal;
  emit: (type: Event["type"], data: any) => void;
  flush: () => Promise<void>;
  /**
   * A message added to the running turn (立即追加). The handler resolves
   * once the Agent has the message (or rejects: it never got it).
   * `requeue(reason)` hands it back later — the Agent did not take it after
   * all (never acknowledged, or cancelled with its turn) — and the control
   * plane sends it as the next turn instead; `withdraw()` takes that back
   * when the Agent then ran it after all (its requeued turn not started).
   */
  onInput?: (handler: InputHandler | null) => void;
  publishAttachment?: (
    name: string,
    mime: string,
    data: string,
  ) => Promise<
    import("../../../contracts/src/index.ts").Attachment
  >;
  /**
   * `meta`: "permission" prompts are answered on the 「审批」 page
   * only, "question"s in the conversation; `reason` = the harness's own reason.
   */
  approve: (
    title: string,
    input: unknown,
    options: Approval["options"],
    meta?: Pick<Approval, "category" | "reason">,
  ) => Promise<NonNullable<Approval["decision"]>>;
  /** serves the Agent's calls of Daisy's tools (absent = none). */
  tools?: import("../tools/daisy-tools.ts").DaisyToolHost;
}
export function safeWorkspace(path: string, roots: string[]) {
  // P5-05: Windows — the long name, not an 8.3 short one (RUNNER~1): what
  // a harness and the file checkpoints see.
  const real = (x: string) => (process.platform === "win32" ? realpathSync.native(x) : realpathSync(x));
  const p = real(path);
  if (
    !roots.some((root) => {
      const r = relative(real(root), p);
      return (
        r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r))
      );
    })
  )
    throw Error(turnT()("server-harness.workspace.outsideRoots"));
  if (!statSync(p).isDirectory()) throw Error(turnT()("server-harness.workspace.notDir"));
  accessSync(p, constants.X_OK);
  return p;
}
/** Runner-inherited credentials / agent session markers no child may see. */
export const SCRUBBED_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "KIMI_API_KEY",
  "KIMI_BASE_URL",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // model slots come from the identity, never the Runner's own.
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
];
/** Claude Code's environment variable per model slot. */
export const SLOT_ENV: Record<ModelSlot, string> = {
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
};
export function agentEnv(job: RunnerJob) {
  const env = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  // P4-10: an ACP harness's own directory variable (acp-harnesses.ts);
  // one without any is not relocatable (no managed identities for it).
  const dirEnv =
    { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" }[
      job.session.agent as string
    ] ?? acpHarness(job.session.agent)?.configDir?.env;
  if (job.profile.configDir && dirEnv) env[dirEnv] = job.profile.configDir;
  if (job.profile.authMode === "apiKey") {
    env[
      job.profile.authHeader === "bearer"
        ? "ANTHROPIC_AUTH_TOKEN"
        : "ANTHROPIC_API_KEY"
    ] = job.profile.apiKey;
    if (job.profile.baseUrl) env.ANTHROPIC_BASE_URL = job.profile.baseUrl;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  // what the identity's model slots mean (an empty slot: unset,
  // so Claude Code's own default applies).
  if (job.session?.agent === "claude")
    for (const [slot, name] of Object.entries(SLOT_ENV)) {
      const v = job.profile.modelSlots?.[slot as ModelSlot];
      if (typeof v === "string" && v) env[name] = v;
    }
  // Claude Code keeps file checkpoints (what `rewind_files`
  // restores) only with this in SDK / -p mode. Not for a read-only
  // sidecar or a read-only workspace (they make no edits).
  if (
    job.session?.agent === "claude" &&
    !job.session.sidecar &&
    !["read-only", "snapshot"].includes(job.session.workspaceMode || "") &&
    daisyEnv("DAISY_CLAUDE_FILE_CHECKPOINTS") !== "0"
  )
    env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = "true";
  // P1-10 hook 1: what enabled plugins add to a session's process (login
  // flows have no session; none enabled: nothing).
  if (job.session?.id) Object.assign(env, pluginSessionEnv(job.session));
  // P1-03: where this session's working credential is (it reads only this
  // session, and only while a turn of it runs) and the local face.
  // P2-02: an MCP that needs a token for another system reads the
  // credential and calls POST /api/sessions/$DAISY_SESSION_ID/ai-token.
  delete env.DAISY_AI_CREDENTIAL_FILE;
  delete env.DAISY_URL;
  delete env.DAISY_SESSION_ID;
  if (job.aiCredential?.file) {
    env.DAISY_AI_CREDENTIAL_FILE = job.aiCredential.file;
    if (job.aiCredential.url) env.DAISY_URL = job.aiCredential.url;
    if (job.session?.id) env.DAISY_SESSION_ID = job.session.id;
  }
  return env;
}
/**
 * Agents whose CLI here takes an auto-compact threshold at launch
 *: set from the Runner's advertised capability (the recorded CLI
 * versions); until then every Agent that supports it at all.
 */
const thresholdAgents = new Set<string>(
  Object.entries(contextUsageCapability().agents)
    .filter(([, a]) => a?.configurable)
    .map(([agent]) => agent),
);
export function setThresholdAgents(cap: ContextUsageCapability) {
  thresholdAgents.clear();
  for (const [agent, a] of Object.entries(cap.agents))
    if (a?.configurable) thresholdAgents.add(agent);
}
export const takesThreshold = (agent: string) => thresholdAgents.has(agent);
/**
 * which settings each Agent's CLI here applies without a restart,
 * from the Runner's own report (by CLI version); until then the legacy
 * behaviour (what restarted before keeps restarting).
 */
let settingsFeatures: any = null;
export function setLiveSettings(agentFeatures: any) {
  settingsFeatures = agentFeatures ?? null;
}
export const liveSettings = (agent: string): AgentSettingsCapabilities =>
  settingsRoute(settingsFeatures, agent);
/** `agent`'s reported capabilities here (by CLI version). */
export const liveFeatures = (agent: string): any =>
  settingsFeatures?.[agent] ?? null;
/**
 * The identity's auto-compact setting, when it is a usable number and the
 * CLI here can take it (an older Claude Code would exit on --autocompact).
 */
export function requestedAutoCompact(job: RunnerJob): number | null {
  const n = job.profile.autoCompactTokens;
  return takesThreshold(job.session.agent) &&
    typeof n === "number" &&
    Number.isInteger(n) &&
    n > 0
    ? n
    : null;
}
/** A threshold nobody reported: the ring shows 「不可用」 with `reason`. */
export function unknownThreshold(
  requested: number | null,
  reason: string,
): ContextThreshold {
  return {
    tokens: null,
    source: "unknown",
    origin: "unknown",
    enabled: null,
    exact: false,
    window: null,
    requested,
    applied: null,
    reason,
  };
}
const nonNegative = (n: unknown) =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
/**
 * Context usage of one Agent process, one item per
 * job (`<jid>:context`): tokens in the conversation now, the real
 * auto-compact trigger point the Agent reports, this job's cache counters
 * and the last compaction. `used` / `window` keep their first meaning for
 * older clients; the ring divides by `threshold.tokens` only.
 */
export class ContextMeter {
  used = -1;
  window: number | null = null;
  threshold: ContextThreshold;
  lastCompact?: CompactMark;
  /** This job's prompt counters by API response (each counted once). */
  private calls = new Map<string, CacheCounters>();
  private cacheReported = false;
  constructor(
    private items: Items,
    private agent: ContextUsage["agent"],
    threshold: ContextThreshold,
  ) {
    this.threshold = threshold;
  }
  /** A new job: its cache counters start from nothing. */
  beginJob() {
    this.calls.clear();
  }
  /** One API response's prompt usage (same key = the same response again). */
  call(key: string, c: CacheCounters) {
    this.cacheReported = true;
    this.calls.set(key, {
      prompt: nonNegative(c.prompt),
      read: nonNegative(c.read),
      write: c.write === null ? null : nonNegative(c.write),
    });
  }
  cache(): CacheCounters | null {
    if (!this.cacheReported) return null;
    let prompt = 0,
      read = 0,
      write: number | null = null;
    for (const c of this.calls.values()) {
      prompt += c.prompt;
      read += c.read;
      if (c.write !== null) write = (write ?? 0) + c.write;
    }
    return { prompt, read, write };
  }
  compacted(info: CompactInfo) {
    this.lastCompact = {
      at: Date.now(),
      trigger:
        info.trigger === "auto"
          ? "auto"
          : info.trigger === "manual"
            ? "manual"
            : "unknown",
      ...(info.preTokens !== undefined ? { preTokens: info.preTokens } : {}),
      ...(info.postTokens !== undefined ? { postTokens: info.postTokens } : {}),
    };
    if (info.postTokens !== undefined) this.used = info.postTokens;
  }
  /** Write the `<jid>:context` item (nothing before the first count). */
  emit() {
    if (!Number.isFinite(this.used) || this.used < 0) return;
    const value: ContextUsage = {
      v: 1,
      agent: this.agent,
      used: Math.round(this.used),
      window: this.window && this.window > 0 ? Math.round(this.window) : null,
      threshold: this.threshold,
      cache: this.cache(),
      ...(this.lastCompact ? { lastCompact: this.lastCompact } : {}),
      updatedAt: Date.now(),
    };
    this.items.set("context", {
      kind: "tool",
      category: "usage",
      name: turnT()("server-harness.item.context"),
      text: JSON.stringify({
        used: value.used,
        window: value.window,
        threshold: value.threshold.tokens,
      }),
      input: value,
      status: "complete",
    });
  }
}
/** The identity's plan quota as a `<jid>:quota` item. */
export function quotaItem(
  items: Items,
  snapshot: QuotaSnapshot,
  identity?: string,
) {
  items.set("quota", {
    kind: "tool",
    category: "usage",
    name: turnT()("server-harness.item.quota"),
    text: snapshot.status,
    input: identity
      ? { ...snapshot, identity: identity.slice(0, 100) }
      : snapshot,
    status: "complete",
  });
}
export function preparePrompt(
  job: RunnerJob,
  cwd: string,
  attachmentRoot = cwd,
) {
  const files: Runtime["files"] = [];
  if (job.attachments.length) {
    // P6-03: was .harbor-attachments (files there stay where they are).
    const dir = join(attachmentRoot, ".daisy-attachments", job.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const a of job.attachments) {
      const path = join(
        dir,
        `${a.id}-${basename(a.name).replace(/[^a-zA-Z0-9._-]/g, "_")}`,
      );
      writeFileSync(path, Buffer.from(a.data, "base64"), { mode: 0o600 });
      files.push({ path, mime: a.mime, data: a.data });
    }
  }
  const prompt = buildPrompt(
    job.text,
    job.session.task,
    !(job.session.contextDelivered ?? !!job.session.nativeId),
    files.map((x) => x.path),
    job.context,
    job.terminal || [],
  );
  return { prompt, files };
}
type ItemTarget = { job: { id: string }; emit: Runtime["emit"] };
/**
 * Items of one Agent process, emitted as `<jobId>:<key>`. The target is read
 * on every call: an online process serves one turn after another,
 * and between turns emits through the session channel.
 */
export class Items {
  map = new Map<string, Item>();
  private target: () => ItemTarget;
  constructor(rt: ItemTarget | (() => ItemTarget)) {
    this.target = typeof rt === "function" ? rt : () => rt;
  }
  /** Full item id for `key` in the current turn. */
  id(key: string) {
    return `${this.target().job.id}:${key}`;
  }
  set(key: string, patch: Partial<Item>) {
    return this.setId(this.id(key), patch);
  }
  /** Update an item by full id (also one of an earlier turn). */
  setId(id: string, patch: Partial<Item>) {
    const prev = this.map.get(id),
      item = {
        id,
        kind: "assistant" as const,
        text: "",
        createdAt: Date.now(),
        ...prev,
        ...patch,
      };
    if (item.text.length > 250000)
      item.text =
        turnT()("server-harness.item.outputTail", { n: 250000 }) + "\n" + item.text.slice(-250000);
    for (const field of ["input", "native"] as const)
      if (item[field] !== undefined) {
        const raw = JSON.stringify(item[field]);
        if (raw.length > 100000)
          item[field] = {
            truncated: true,
            characters: raw.length,
            preview: raw.slice(0, 100000),
          };
      }
    this.map.set(id, item);
    this.target().emit("item", item);
    return item;
  }
  delta(key: string, text: string, kind: Item["kind"] = "assistant") {
    const id = this.id(key);
    return this.setId(id, {
      kind,
      text: ((this.map.get(id)?.text || "") + text).slice(-250000),
      status: "streaming",
    });
  }
  finish() {
    for (const item of this.map.values())
      if (item.status === "streaming" && item.kind !== "tool")
        this.target().emit("item", { ...item, status: "complete" });
  }
  /** Forget finished turns' items, keeping the ids in `keep`. */
  retain(keep: Set<string>) {
    for (const id of [...this.map.keys()])
      if (!keep.has(id)) this.map.delete(id);
  }
}
/** What an online Agent process tells its registry. */
export interface LiveHooks {
  /** The Agent started a turn by itself; a job for it is on its way. */
  wake(reason: string): void;
  /** Item updates between turns (session channel). */
  emit: Runtime["emit"];
  /** busy / pending changed: report soon. */
  changed(): void;
  /** The process ended (not by stop()). */
  closed(reason: string): void;
  /**
   * the native session was renamed outside Daisy (its owner, in
   * the CLI / app): `title`, while Daisy's title was `base`. Resolves the
   * control plane's answer (`applied`: Daisy took it; else `title` is the
   * one Daisy kept), null when it could not be reported (after retries).
   */
  title?(title: string, base: string): Promise<NativeRenameAnswer | null>;
}
export const noHooks: LiveHooks = {
  wake: () => {},
  emit: () => {},
  changed: () => {},
  closed: () => {},
};
/** the control plane's answer to a native rename. */
export interface NativeRenameAnswer {
  applied: boolean;
  title?: string;
}
/**
 * An adapter's view of Daisy's title and
 * the native renames it reports. One report at a time, keyed by a counter:
 * an answer counts only if it is the latest report and Daisy's title has
 * not changed since it was sent (a newer job's title is the truth then).
 * A rename while one is out is coalesced — the latest goes next, against
 * the title Daisy took — and dropped if Daisy kept its own.
 */
export interface DaisyTitle {
  /** nativeTitle-normalised. */
  title: string;
  manual: boolean;
  final?: boolean;
}
export class NativeRenames {
  daisy: DaisyTitle;
  private version = 0;
  private seq = 0;
  private out: { seq: number; from: string; version: number } | null = null;
  private next: string | null = null;
  constructor(
    daisy: DaisyTitle,
    private send: LiveHooks["title"],
    /** Daisy kept its own / it was not reported: push Daisy's again. */
    private refused: () => void = () => {},
  ) {
    this.daisy = daisy;
  }
  /** Daisy's title as a job (or an accepted rename) carries it. */
  setDaisy(h: DaisyTitle) {
    if (
      h.title !== this.daisy.title ||
      h.manual !== this.daisy.manual ||
      !!h.final !== !!this.daisy.final
    )
      this.version++;
    this.daisy = h;
  }
  /** Not pushed while a rename against it is being reported. */
  holdsBack(title: string) {
    return !!this.out && this.out.from === title;
  }
  get reporting() {
    return !!this.out;
  }
  report(name: string) {
    if (!this.send) return;
    if (this.out) {
      this.next = name;
      return;
    }
    const seq = ++this.seq,
      from = this.daisy.title,
      version = this.version;
    this.out = { seq, from, version };
    const done = (answer: NativeRenameAnswer | null) => {
      if (this.out?.seq !== seq) return;
      this.out = null;
      const next = this.next;
      this.next = null;
      if (this.version !== version) return;
      if (!answer?.applied) {
        this.refused();
        return;
      }
      this.setDaisy({ title: name, manual: true });
      if (next && next !== name) this.report(next);
    };
    void this.send(name, from).then(done, () => done(null));
  }
}
/** One Agent process serving the turns of one session. */
export interface LiveAgent {
  readonly since: number;
  lastActivity: number;
  readonly closed: boolean;
  /** A turn is attached, or the Agent started one and its job is coming. */
  busy(): boolean;
  /** Timers / background work that will wake the Agent: keeps it online. */
  pending(): LiveTimer[];
  /** What the background tasks are doing right now. */
  activity?(): Promise<LiveActivity[]>;
  /**
   * stop one of `pending()`'s own tasks (「停止」 on the item; Claude
   * Code `stop_task`, Codex `backgroundTerminals/terminate`). Resolves
   * whether it was there to stop.
   */
  stopTask?(id: string): Promise<boolean>;
  /** Serve one job (user message, Agent-started turn, /compact). */
  turn(rt: Runtime): Promise<TurnOutcome>;
  /**
   * End the process. `reason`: an attached turn fails with it
   * (立即重启) instead of a bare process exit.
   */
  stop(reason?: string): void;
  stopped?(): Promise<void>;
  /**
   * Start the CLI now, outside any turn (an idle restart): it
   * resumes the conversation and reports its context usage between turns.
   */
  warm?(): Promise<void>;
  /** The native conversation this process is on (to resume it elsewhere). */
  nativeId?(): string | null;
  /** Give up an Agent-started turn whose job did not attach. */
  discardWake?(): void;
  /**
   * 「只问」: ask this process a side question (Claude Code control
   * `side_question`): answered from the conversation in memory, no tools,
   * never interrupting a running turn, not added to its history. null:
   * this process cannot now (not started, closed, no answer) — the caller
   * falls back to the forked sidecar.
   */
  /** the process is started and initialised (a side question can go). */
  canAsk?(): boolean;
  sideQuestion?(
    question: string,
    history: { question: string; response: string }[],
    o: { signal: AbortSignal; timeoutMs: number },
  ): Promise<string | null>;
  /**
   * 「回退」 in place (Claude Code `rewind_conversation`, same native
   * id) and, when asked, the files its edit tools changed since that
   * message (`rewind_files`, dry run first). null: not now (busy, not
   * started); `inPlace: false`: the CLI refused — either way the caller
   * copies the conversation instead.
   */
  rewind?(uuid: string, o: { files: boolean }): Promise<RewindOutcome | null>;
  /**
   * the session's one AI title, made by this live process itself
   * from `description` (Claude Code `generate_session_title`). null: it
   * cannot now — Daisy's own CLI call names it instead.
   */
  generateTitle?(
    description: string,
    timeoutMs: number,
  ): Promise<string | null>;
  /**
   * Daisy's title (the AI's, just applied) to the native session
   * now, without waiting for the next turn (Codex `thread/name/set`).
   */
  pushTitle?(title: string): Promise<void>;
  /**
   * A name the owner gave the native session
   * that Daisy may not have yet (its report failed): the round-2 title
   * request reports it instead of naming the session anew.
   */
  ownerName?(): string | null;
}
/** what an in-place rewind did. */
export interface RewindOutcome {
  sessionId: string;
  /** The text of the message rewound to (Claude Code's prefillText). */
  prefillText?: string;
  /** false: the conversation was not rewound here (`refused`: the CLI's reason). */
  inPlace: boolean;
  refused?: string;
  files: RewindFiles;
}
/** the files part of a 「回退」 (shown in its notice). */
export interface RewindFiles {
  reverted: boolean;
  /** Not reverted: why (not asked, offline, background work, unsupported, the CLI's words). */
  reason?:
    "not-asked" | "offline" | "background" | "unsupported" | "nothing" | string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  /**
   * who restored them (Daisy's checkpoints for Codex:
   * `fallback`; ADR-152: `"harbor"` before, still read).
   */
  via?: "native" | "fallback";
  /** edited by the AI but not restored, and why. */
  notRestored?: { path: string; why: string }[];
  /** changed since, not by the AI's edit tool (first 20; not restored). */
  others?: string[];
  othersCount?: number;
  /** changed after the AI's edit — the rewind was refused. */
  conflicts?: { path: string; why: string }[];
}
export interface TurnOutcome {
  compact?: CompactInfo;
}
export type MakeAgent = (
  job: RunnerJob,
  cwd: string,
  hooks: LiveHooks,
  live: boolean,
) => LiveAgent;
/** A process for exactly one turn (offline mode, tests). */
export async function oneShot(make: MakeAgent, rt: Runtime) {
  const agent = make(rt.job, rt.cwd, noHooks, false);
  try {
    return await agent.turn(rt);
  } finally {
    agent.stop();
    await agent.stopped?.();
  }
}
/**
 * The runtime of a start outside any turn (LiveAgent.warm): stage items
 * and session events are dropped (no job to show them in), no prompt, no
 * approvals.
 */
export function warmRuntime(job: RunnerJob, cwd: string): Runtime {
  return {
    job,
    cwd,
    prompt: "",
    files: [],
    signal: new AbortController().signal,
    emit: () => {},
    flush: async () => {},
    approve: async () => {
      throw Error(turnT()("server-harness.noTurnToApprove"));
    },
  };
}
/** Readable token count: 21578 → "21.6K". */
export const tokens = (n?: number) =>
  typeof n !== "number"
    ? "?"
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)}M`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}K`
        : String(n);
/** The 「已压缩上下文」 notice of one compaction. */
export function compactNotice(items: Items, key: string, info: CompactInfo) {
  // N-4: an unknown size is left out, not shown as 「?」.
  const pre = typeof info.preTokens === "number",
    post = typeof info.postTokens === "number";
  const t = turnT();
  const after = post ? tokens(info.postTokens) : "?";
  const parts = [
    pre
      ? t("server-harness.compact.fromTo", { before: tokens(info.preTokens), after })
      : post
        ? t("server-harness.compact.now", { after })
        : t("server-harness.compact.done"),
  ];
  const meta = [
    info.durationMs ? t("server-harness.compact.seconds", { n: (info.durationMs / 1000).toFixed(1) }) : "",
    info.trigger === "auto" ? t("server-harness.compact.auto") : info.trigger ? t("server-harness.compact.manual") : "",
  ].filter(Boolean);
  items.set(`compact:${key}`, {
    kind: "notice",
    category: "compact",
    name: t("server-harness.item.compaction"),
    text: meta.length ? t("server-harness.compact.meta", { text: parts[0]!, meta: meta.join(" · ") }) : parts[0]!,
    input: info,
    status: "complete",
  });
}
export function stage(
  rt: Runtime,
  key: string,
  name: string,
  status = "complete",
  detail = "",
) {
  rt.emit("item", {
    id: `${rt.job.id}:stage:${key}`,
    kind: "tool",
    category: "lifecycle",
    name,
    status,
    text: detail,
    createdAt: Date.now(),
  });
}
/**
 * A turn's own stop / interrupt wording (each harness's), in every
 * language Daisy may have said it in (old stored Chinese included).
 */
const STOP_WORDS = /中断|停止|取消|interrupt|stopped|cancel/i;
/**
 * 「停止」 decides how a stopped turn ends (N-6 again, P5 gate). Once the
 * owner stopped the turn, what the transport or the process reports
 * afterwards is not its end: the kill after the grace period — or on
 * Windows the Job Object ending the tree at once — can close the transport
 * before the agent's own "interrupted" arrives, and the turn must still end
 * as interrupted, never "Agent exited (…)" / "Agent transport closed".
 * A stop's own wording (中断 / 停止 / 取消) and a reason given with
 * `agent.stop(reason)` (it rejects the turn first) are kept.
 */
/**
 * Every shipped language's text for a key: a reader that recognizes
 * text Daisy stored earlier (in whichever language the owner had then).
 */
export const textsOf = (key: MessageKey): Set<string> =>
  new Set(Object.values(shippedPacks()).map((p) => p[key]).filter((v): v is string => !!v));
export function stoppedEnd(e: unknown, rt: Runtime, label: string): unknown {
  if (!rt.signal.aborted) return e;
  return STOP_WORDS.test(String((e as Error)?.message ?? e)) ? e : Error(label);
}
export function abortableProcess(rt: Runtime, p: { stop: () => void }) {
  const stop = () => p.stop();
  rt.signal.addEventListener("abort", stop, { once: true });
  if (rt.signal.aborted) p.stop();
  return () => rt.signal.removeEventListener("abort", stop);
}
export const asText = (x: any): string =>
  typeof x === "string"
    ? x
    : Array.isArray(x)
      ? x
          .map((v) =>
            typeof v === "string" ? v : v.text || v.content?.text || "",
          )
          .filter(Boolean)
          .join("\n")
      : JSON.stringify(x ?? "", null, 2);

/** Native image payloads are artifacts, never text or implicit model instructions. */
export async function publishImage(
  rt: Runtime,
  key: string,
  mime: string,
  data: string,
) {
  if (!rt.publishAttachment || !/^image\/(png|jpeg|gif|webp)$/.test(mime))
    return;
  const base64 = data.replace(/^data:image\/[a-z]+;base64,/, "");
  if (
    !/^[A-Za-z0-9+/=\r\n]+$/.test(base64) ||
    Buffer.byteLength(base64) > 12 * 1024 * 1024
  )
    return;
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) return;
  const signature = bytes.subarray(0, 12);
  const actual =
    signature.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
      ? "image/png"
      : signature.subarray(0, 2).toString("hex") === "ffd8"
        ? "image/jpeg"
        : signature.subarray(0, 3).toString() === "GIF"
          ? "image/gif"
          : signature.subarray(0, 4).toString() === "RIFF" &&
              signature.subarray(8, 12).toString() === "WEBP"
            ? "image/webp"
            : null;
  if (actual !== mime) return;
  const a = await rt.publishAttachment(
    `agent-image-${key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-60)}.${mime.split("/")[1]}`,
    mime,
    base64,
  );
  rt.emit("item", {
    id: `${rt.job.id}:image:${key}`,
    kind: "notice",
    name: turnT()("server-harness.item.image"),
    text: turnT()("server-harness.item.imageText"),
    attachments: [a],
    status: "complete",
    createdAt: Date.now(),
  });
}

export function trackMedia(list: Promise<void>[], work: Promise<void>) {
  void work.catch(() => {});
  list.push(work);
}
