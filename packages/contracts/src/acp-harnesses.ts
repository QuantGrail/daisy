/**
 * P4-10 (plan 5.5, ADR-130): the harnesses Daisy drives through the one
 * generic ACP adapter (packages/daisy/src/harness/acp.ts). Adding an ACP
 * harness is one entry here — or, without touching the code, one entry in
 * the JSON file named by `DAISY_ACP_HARNESSES` (same shape; read once at
 * start, Node only; P6-11: the owner can name it in runner.json's
 * `acpHarnesses` instead, platform/settings.ts). Everything else (session / identity agent values,
 * detection, doctor, logins, the UI's pickers, capability reports) reads
 * this table; nothing outside it branches on one ACP harness's id.
 *
 * Facts per harness: docs/research/acp-harnesses.md and
 * deepseek-harness.md (P0-03, verified 2026-11-16). What is not verified
 * there is left out (no login flow, no isolated CLI directory, no effort
 * list) rather than guessed: the adapter then says 「不支持」.
 *
 * `capabilities` has the shape of agent-capabilities.ts today —
 * P4-11 extends that file to all of 5.5 and reads the new fields from here.
 */
import type {
  AgentCapabilities,
  FeatureDeclaration,
} from "./agent-capabilities.ts";
import type { AgentStopCapabilities } from "./agent-stop.ts";
import { daisyEnv } from "./env.ts";
import { commandShape, commandShapeOk, jsonErrorWhere, untrustedFile } from "./start-files.ts";
import type { Translate } from "./i18n.ts";
import { defaultTranslate } from "./i18n-default.ts";

/** What the Runner reports for one ACP harness (agent-capabilities.ts shape, `agent` / `version` filled in). */
export type AcpCapabilities = Omit<
  AgentCapabilities,
  "version" | "agent" | "stop" | "cliVersion"
>;
export interface AcpHarnessConfig {
  /** Daisy's agent value (sessions, identities, `--agent`): [a-z][a-z0-9-]*. */
  id: string;
  /** Product name: settings, doctor, pickers. */
  name: string;
  /** In sentences: 「Kimi 工具」, 「Kimi 进程已退出」. */
  short: string;
  /** One character for the avatar. */
  letter: string;
  /** Avatar / accent colour. */
  color: string;
  /** Plan 5.5: second line (required capabilities + declared ones) or experimental (basic chat, no promise). */
  tier: "second" | "experimental";
  /**
   * One line for the start page. P6-23b: for the built-ins (and the
   * generated defaults) a message key — read every text field through
   * `harnessText(h, field, t)`, never directly; an owner-defined entry's
   * own words are kept as given.
   */
  description: string;
  /**
   * The ACP server: `command args…` on stdio. The command can be replaced
   * with `DAISY_<ID>_BIN` (formerly `HARBOR_<ID>_BIN`, still read) (ID upper-cased, `-` → `_`), as before for Kimi.
   */
  launch: { command: string; args: string[] };
  /** Arguments of the version probe (detection, doctor). */
  versionArgs: string[];
  /** How to install it (doctor). */
  install: string;
  /** Per-user install directories (from $HOME) added to the Runner's PATH. */
  binDirs?: string[];
  /**
   * The CLI's own directory: `env` points it elsewhere (an identity with
   * its own login, `profile create-managed`); `home` is the default under
   * $HOME. Absent: not known to be relocatable — no managed identities.
   */
  configDir?: { env: string; home: string };
  /**
   * Files Daisy can read / edit in that directory (config.read / MCP
   * management, configuration.ts). Absent: 「不支持」.
   */
  nativeConfig?: { main: string; mcp: string; projectDir: string };
  /**
   * In-Daisy login (`login start`): the CLI's own interactive login run in
   * a pty, the official page's URL picked from its output (only these
   * hosts). Absent: `loginHint` says how to log in on the machine itself.
   */
  login?: { args: string[]; hosts: string[]; message: string };
  loginHint: string;
  /**
   * Permission modes (ACP `session/set_mode` or the `mode` config option).
   * `readOnly`: the value that counts as read-only (plan 5.5; null = none
   * over ACP). `readOnlyStrength` weak = only a mode the agent honours,
   * not enforced (D-28: still takes 「问」, said so on its card); none = no
   * read-only (5.7: takes no 「问」). `bypass`: skips every prompt.
   */
  modes: {
    values: string[];
    default: string;
    readOnly: string | null;
    readOnlyStrength: "weak" | "none";
    bypass: string | null;
  };
  /** Effort values offered when the session lists none (fallback; [] = only what it lists). */
  efforts: string[];
  /**
   * The resume path (plan 5.5): `session/load` and / or `session/resume`,
   * whichever `initialize` declares; this is what the entry expects (the
   * adapter goes by the declaration).
   */
  resume: ("load" | "resume")[];
  /**
   * Older protocol this harness still takes (Kimi): `session/set_model`
   * when the session lists no model option, `thinkingConfigId` when it
   * lists no `thought_level` one.
   */
  legacy?: { setModel?: boolean; thinkingConfigId?: string };
  /**
   * 「打开完整 CLI」 (the native terminal on the same session): `args` with
   * `{sid}` for the native session id, `model` with `{model}` when the
   * identity names one, extra flags per permission mode. Absent: 「不支持」.
   */
  terminal?: {
    args: string[];
    model?: string[];
    modes?: Record<string, string[]>;
  };
  /** The quota card (ACP has no quota): provider id and why it is empty. */
  quota: { provider?: "kimi-code"; reason: string };
  /** Why the auto-compact point is unknown (the context ring). */
  thresholdReason: string;
  capabilities: AcpCapabilities;
  /**
   * P4-11's §5.5 list (agent-capabilities.ts `features`): what this
   * harness declares beyond the blocks above — fork (`session/fork`, still
   * checked against `initialize`), compact (`/compact`, checked against the
   * session's `available_commands`), usage (`usage_update`), terminal
   * (「打开完整 CLI」, `terminal` below). A key set `none` wins over
   * what the blocks imply (no modes → permissionMode none). The required
   * four are always native.
   */
  features: FeatureDeclaration;
  stop: Omit<AgentStopCapabilities, "version">;
}

const fallback = { support: "fallback" as const };
/**
 * What the generic adapter does for any ACP harness today: Daisy's queue
 * for input (ACP has no standard way into a running turn), settings
 * re-applied by a restart (ACP cannot go back to
 * "the default" live), no native refusals / titles / model reroutes,
 * Daisy's own background items, 「只问」 as an ordinary @.
 */
const ACP_BASE: AcpCapabilities = {
  input: {
    steer: fallback as AcpCapabilities["input"]["steer"],
    withdraw: { support: "none" },
    afterTurn: fallback,
    jump: { support: "fallback", opts: { interrupts: false } },
  },
  settings: { model: "restart", effort: "restart", permissionMode: "restart" },
  approvals: { autoReviewDenials: { support: "none" }, approveDenied: fallback },
  background: { list: fallback, stop: fallback },
  askOnly: { sideQuestion: "none", fork: "none" },
  rewind: { history: "none", files: "none" },
  title: { generate: "none", sync: "none" },
  modelSwitch: { support: "none" },
};
/**
 * What no ACP harness has through the generic adapter: no way into a
 * running turn (ACP defines none), no withdraw, no file rewind, no
 * 「问」 off the main line yet (askOnly — an ordinary @), no
 * background list of its own, no quota.
 */
const FEATURES_BASE: FeatureDeclaration = {
  steer: "none",
  withdraw: "none",
  rewindFiles: "none",
  askOnly: "none",
  background: "none",
  quota: "none",
  fork: "none",
  compact: "none",
  usage: "none",
  terminal: "none",
};
const STOP_BASE: AcpHarnessConfig["stop"] = {
  subagents: "none",
  commands: "native",
  survives: ["backgroundTasks"],
  killAfterMs: 5000,
};

/** The built-in entries (plan 5.5 table). */
const BUILTIN = {
  kimi: {
    id: "kimi",
    name: "Kimi Code CLI",
    short: "Kimi Code",
    letter: "K",
    color: "#7367b2",
    tier: "second",
    description: "common-contracts.harness.kimi.description",
    launch: { command: "kimi", args: ["acp"] },
    versionArgs: ["--version"],
    install: "common-contracts.harness.kimi.install",
    binDirs: [".kimi-code/bin"],
    configDir: { env: "KIMI_CODE_HOME", home: ".kimi-code" },
    nativeConfig: { main: "config.toml", mcp: "mcp.json", projectDir: ".kimi-code" },
    login: {
      args: ["login"],
      hosts: ["kimi.com", "www.kimi.com", "kimi.ai", "www.kimi.ai", "auth.kimi.com", "auth.kimi.ai"],
      message: "common-contracts.harness.kimi.loginMessage",
    },
    loginHint: "common-contracts.harness.kimi.loginHint",
    modes: {
      values: ["default", "plan", "auto", "yolo"],
      default: "default",
      readOnly: "plan",
      readOnlyStrength: "weak",
      bypass: "yolo",
    },
    efforts: ["low", "high", "max"],
    resume: ["load", "resume"],
    legacy: { setModel: true, thinkingConfigId: "thinking" },
    terminal: {
      args: ["--session", "{sid}"],
      model: ["--model", "{model}"],
      modes: { plan: ["--plan"] },
    },
    quota: { provider: "kimi-code", reason: "common-contracts.harness.kimi.quotaReason" },
    thresholdReason: "common-contracts.harness.kimi.thresholdReason",
    // `/undo N` over ACP (operations.ts, when the session lists it).
    capabilities: { ...ACP_BASE, rewind: { history: "native", files: "none" } },
    // ACP session/fork (declared by Kimi Code), /compact, usage_update,
    // `kimi --session` (P4-11's Kimi row).
    features: {
      ...FEATURES_BASE,
      fork: "native",
      compact: "native",
      usage: "native",
      terminal: "native",
    },
    stop: STOP_BASE,
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    short: "OpenCode",
    letter: "O",
    color: "#5f8a4e",
    tier: "second",
    description: "common-contracts.harness.opencode.description",
    launch: { command: "opencode", args: ["acp"] },
    versionArgs: ["--version"],
    install: "common-contracts.harness.opencode.install",
    loginHint: "common-contracts.harness.opencode.loginHint",
    modes: {
      // OpenCode's primary agents (`session/set_mode`); `plan` changes no
      // project file but runs commands by its permissions (weak, D-28).
      values: ["build", "plan"],
      default: "build",
      readOnly: "plan",
      readOnlyStrength: "weak",
      bypass: null,
    },
    efforts: [],
    resume: ["load", "resume"],
    quota: { reason: "common-contracts.harness.opencode.quotaReason" },
    thresholdReason: "common-contracts.harness.opencode.thresholdReason",
    capabilities: ACP_BASE,
    // session/fork declared; usage_update. Its /compact over ACP and a
    // terminal on the same session are not verified (P0-03): none.
    features: { ...FEATURES_BASE, fork: "native", usage: "native" },
    stop: STOP_BASE,
  },
  antigravity: {
    id: "antigravity",
    name: "Antigravity CLI",
    short: "Antigravity",
    letter: "A",
    color: "#c0894a",
    tier: "second",
    description: "common-contracts.harness.antigravity.description",
    launch: { command: "agy", args: ["acp"] },
    versionArgs: ["--version"],
    install: "common-contracts.harness.antigravity.install",
    loginHint: "common-contracts.harness.antigravity.loginHint",
    // No mode over ACP (no `--mode` for `agy acp`): no read-only, takes no 「问」.
    modes: {
      values: [],
      default: "",
      readOnly: null,
      readOnlyStrength: "none",
      bypass: null,
    },
    efforts: [],
    resume: ["load", "resume"],
    quota: { reason: "common-contracts.harness.antigravity.quotaReason" },
    thresholdReason: "common-contracts.harness.antigravity.thresholdReason",
    capabilities: ACP_BASE,
    // Fork / mode over ACP not documented (P0-03): none until verified.
    features: { ...FEATURES_BASE, permissionMode: "none" },
    stop: STOP_BASE,
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek Harness",
    short: "DeepSeek Harness",
    letter: "D",
    color: "#4d6bfe",
    tier: "experimental",
    description: "common-contracts.harness.deepseek.description",
    launch: { command: "dsh", args: ["acp"] },
    versionArgs: ["--version"],
    install: "common-contracts.harness.deepseek.install",
    loginHint: "common-contracts.harness.deepseek.loginHint",
    // ACP exposes no mode (its read-only preset is headless only).
    modes: {
      values: [],
      default: "",
      readOnly: null,
      readOnlyStrength: "none",
      bypass: null,
    },
    efforts: [],
    // No `session/load` (loadSession not declared): `session/resume` only.
    resume: ["resume"],
    quota: { reason: "common-contracts.harness.deepseek.quotaReason" },
    thresholdReason: "common-contracts.harness.deepseek.thresholdReason",
    capabilities: ACP_BASE,
    // No fork, no mode over ACP (P0-03).
    features: { ...FEATURES_BASE, permissionMode: "none" },
    stop: STOP_BASE,
  },
} satisfies Record<string, AcpHarnessConfig>;

/** The built-in ACP agent values. */
export type AcpAgent = keyof typeof BUILTIN;
export const BUILTIN_ACP_AGENTS = Object.keys(BUILTIN) as AcpAgent[];

const ID = /^[a-z][a-z0-9-]{1,30}$/;
/** Taken: the native agents, the built-ins, and the Runner's other capability keys. */
const RESERVED = new Set([
  "claude",
  "codex",
  ...BUILTIN_ACP_AGENTS,
  "runner",
  "filesystem",
  "plugins",
  "images",
  "sync",
]);
const isStrings = (v: unknown) =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
/**
 * One entry of the extra harness file, checked; what is missing is filled
 * from the generic defaults (no modes, no login, Daisy's queue …). Throws
 * with the reason; the file's reader (`loadAcpHarnessFile`) leaves that
 * entry out and says so — it is never skipped silently.
 */
export function acpHarnessFromJson(x: any, t: Translate = defaultTranslate()): AcpHarnessConfig {
  const bad = (why: string) => {
    throw Error(why);
  };
  if (!x || typeof x !== "object") bad(t("server-contracts.harnessFile.notObject"));
  if (typeof x.id !== "string" || !ID.test(x.id)) bad(t("server-contracts.harnessFile.idInvalid", { id: String(x.id) }));
  if (RESERVED.has(x.id)) bad(t("server-contracts.harnessFile.idTaken", { id: x.id }));
  if (
    typeof x.launch?.command !== "string" ||
    !x.launch.command ||
    !isStrings(x.launch.args ?? [])
  )
    bad(t("server-contracts.harnessFile.launchInvalid", { id: x.id }));
  // P6-11 review: never a path relative to the session's workspace.
  if (!commandShapeOk(x.launch.command)) bad(t("server-contracts.harnessFile.launchShape", { rule: commandShape(t) }));
  const name = typeof x.name === "string" && x.name ? x.name : x.id;
  const modes = x.modes ?? {};
  const resume = isStrings(x.resume)
    ? x.resume.filter((r: string) => r === "load" || r === "resume")
    : ["load", "resume"];
  return {
    id: x.id,
    name,
    short: typeof x.short === "string" && x.short ? x.short : name,
    letter: (typeof x.letter === "string" && x.letter ? x.letter : name)
      .slice(0, 1)
      .toUpperCase(),
    color: typeof x.color === "string" ? x.color : "#777777",
    tier: x.tier === "second" ? "second" : "experimental",
    // The owner's own words as given; the defaults are keys (`harnessText` fills {name}).
    description:
      typeof x.description === "string"
        ? x.description
        : "common-contracts.harness.default.description",
    launch: { command: x.launch.command, args: x.launch.args ?? [] },
    versionArgs: isStrings(x.versionArgs) ? x.versionArgs : ["--version"],
    install: typeof x.install === "string" ? x.install : "common-contracts.harness.default.install",
    ...(isStrings(x.binDirs) ? { binDirs: x.binDirs } : {}),
    loginHint:
      typeof x.loginHint === "string" ? x.loginHint : "common-contracts.harness.default.loginHint",
    modes: {
      values: isStrings(modes.values) ? modes.values : [],
      default: typeof modes.default === "string" ? modes.default : "",
      readOnly: typeof modes.readOnly === "string" ? modes.readOnly : null,
      readOnlyStrength:
        typeof modes.readOnly === "string" ? "weak" : "none",
      bypass: typeof modes.bypass === "string" ? modes.bypass : null,
    },
    efforts: isStrings(x.efforts) ? x.efforts : [],
    resume,
    quota: { reason: "common-contracts.harness.default.quotaReason" },
    thresholdReason: "common-contracts.harness.default.thresholdReason",
    // Optional capabilities are the generic adapter's own: a JSON entry
    // cannot claim one Daisy has no code for (5.5: never simulated). It may
    // declare those the adapter does by the agent's own answers (fork /
    // compact are still checked against initialize / available_commands).
    capabilities: ACP_BASE,
    features: {
      ...FEATURES_BASE,
      ...(typeof modes.readOnly === "string" || isStrings(modes.values)
        ? {}
        : { permissionMode: "none" as const }),
      ...Object.fromEntries(
        Object.entries(x.features ?? {}).filter(
          ([k, v]) =>
            JSON_FEATURES.has(k) && (v === "native" || v === "none"),
        ),
      ),
    },
    stop: STOP_BASE,
  };
}
/** The §5.5 keys an extra entry may declare (what acp.ts does by the agent's answers). */
const JSON_FEATURES = new Set(["fork", "compact", "usage"]);
/**
 * P6-11 (ADR-156): the entries of one extra harness file (a JSON array) and
 * what is wrong with it, one line each, naming the file. Never throws: a
 * file that cannot be read or is not an array adds nothing; a broken entry
 * (or a repeated id) is left out and the others are kept. A broken file
 * used to stop every `daisy` command, `--help` included.
 */
export function loadAcpHarnessFile(
  file: string,
  read: (file: string) => string,
  /** Why the file must not be used (another account's, writable by others), or null. */
  untrusted: (file: string) => string | null = () => null,
  /** The language of the problems (the reader's; default: this process's). */
  t: Translate = defaultTranslate(),
): { entries: AcpHarnessConfig[]; problems: string[] } {
  const where = t("server-contracts.harnessFile.where", { file });
  // One line each, whatever the file holds.
  const line = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ");
  let list: unknown;
  try {
    const distrust = untrusted(file);
    if (distrust) return { entries: [], problems: [line(t("server-contracts.harnessFile.untrusted", { where, why: distrust }))] };
    list = JSON.parse(read(file));
  } catch (e) {
    // Never the parser's message: it quotes the file's text.
    const why = (e as any)?.code === "ENOENT" ? t("server-contracts.harnessFile.missing") : jsonErrorWhere(e, t);
    return { entries: [], problems: [line(t("server-contracts.harnessFile.broken", { where, why }))] };
  }
  if (!Array.isArray(list))
    return { entries: [], problems: [line(t("server-contracts.harnessFile.notArray", { where }))] };
  const entries: AcpHarnessConfig[] = [];
  const problems: string[] = [];
  list.forEach((x, i) => {
    const label =
      typeof x?.id === "string"
        ? t("server-contracts.harnessFile.entryWithId", { n: i + 1, id: x.id.slice(0, 40) })
        : t("server-contracts.harnessFile.entry", { n: i + 1 });
    try {
      const h = acpHarnessFromJson(x, t);
      if (entries.some((e) => e.id === h.id)) throw Error(t("server-contracts.harnessFile.idRepeated", { id: h.id }));
      entries.push(h);
    } catch (e) {
      problems.push(line(t("server-contracts.harnessFile.entryProblem", { where, label, why: (e as Error).message })));
    }
  });
  return { entries, problems };
}

/** A harness's words that the start page, doctor, login and quota show. */
export type HarnessTextField = "description" | "install" | "loginHint" | "loginMessage" | "quotaReason" | "thresholdReason";
/**
 * P6-23b (ADR-159): one of a harness's texts in `t`'s language. The
 * built-ins (and an owner-defined entry's defaults) hold message keys;
 * an owner-defined entry's own words are returned as given. "" when the
 * harness has no such text (no in-Daisy login).
 */
export function harnessText(
  h: Partial<Pick<AcpHarnessConfig, "description" | "install" | "loginHint" | "thresholdReason">> & {
    name: string;
    login?: { message: string };
    quota?: { reason: string };
  },
  field: HarnessTextField,
  t: Translate = defaultTranslate(),
): string {
  const raw =
    field === "loginMessage" ? h.login?.message : field === "quotaReason" ? h.quota?.reason : h[field];
  if (!raw) return "";
  // A key (the built-ins', the defaults', the command line's own for the native CLIs) is said; other words are the owner's.
  return t.has(raw) ? t.dynamic(raw, { name: h.name }) : raw;
}

/** What was wrong with the extra harness file of this process (one line each; [] = nothing). */
export const ACP_HARNESS_PROBLEMS: string[] = [];
/** Node only: the extra entries of `$DAISY_ACP_HARNESSES` (a JSON array). */
function extraEntries(): AcpHarnessConfig[] {
  const proc = (globalThis as any).process;
  const file = proc?.env?.DAISY_ACP_HARNESSES;
  if (!file || typeof proc.getBuiltinModule !== "function") return [];
  const fs = proc.getBuiltinModule("node:fs");
  const r = loadAcpHarnessFile(
    file,
    (f) => fs.readFileSync(f, "utf8"),
    (f) => untrustedFile(fs.statSync(f), proc.getuid?.()),
  );
  ACP_HARNESS_PROBLEMS.push(...r.problems);
  return r.entries;
}

/** Every ACP harness of this process: the built-ins, then the extra file's. */
export const ACP_HARNESSES: Record<string, AcpHarnessConfig> = Object.freeze({
  ...(BUILTIN as Record<string, AcpHarnessConfig>),
  ...Object.fromEntries(extraEntries().map((h) => [h.id, h])),
});
/** The ACP agent values (built-in first). */
export const ACP_AGENTS: string[] = Object.keys(ACP_HARNESSES);
/** Daisy's own adapters (native protocols), then the ACP ones. */
export const NATIVE_AGENTS = ["claude", "codex"] as const;
export const AGENT_IDS: string[] = [...NATIVE_AGENTS, ...ACP_AGENTS];

export const isAcpAgent = (agent: unknown): boolean =>
  typeof agent === "string" && Object.hasOwn(ACP_HARNESSES, agent);
export const acpHarness = (agent: unknown): AcpHarnessConfig | undefined =>
  isAcpAgent(agent) ? ACP_HARNESSES[agent as string] : undefined;

const NATIVE_NAMES: Record<string, { name: string; short: string; letter: string }> = {
  claude: { name: "Claude Code", short: "Claude Code", letter: "✳" },
  codex: { name: "Codex", short: "Codex", letter: "◈" },
};
/** 「Claude Code」, 「Kimi Code CLI」 …; an unknown value as is. */
export function agentName(agent: string): string {
  return NATIVE_NAMES[agent]?.name ?? acpHarness(agent)?.name ?? agent;
}
/** The name inside a sentence: 「Kimi」, 「Codex」 … */
export function agentShortName(agent: string): string {
  return NATIVE_NAMES[agent]?.short ?? acpHarness(agent)?.short ?? agent;
}
export function agentLetter(agent: string): string {
  return (
    NATIVE_NAMES[agent]?.letter ??
    acpHarness(agent)?.letter ??
    agent.slice(0, 1).toUpperCase()
  );
}
/** The env variable that replaces an agent's command (`DAISY_KIMI_BIN`, …). */
export const agentBinEnv = (agent: string): `DAISY_${string}` =>
  `DAISY_${agent.toUpperCase().replace(/-/g, "_")}_BIN`;
/** The command Daisy runs for `agent`: the override, else its own command. */
export function agentCommand(
  agent: string,
  env: Record<string, string | undefined> = (globalThis as any).process?.env ??
    {},
): string {
  return (
    daisyEnv(agentBinEnv(agent), env) || acpHarness(agent)?.launch.command || agent
  );
}
/** The arguments of `agent`'s version probe. */
export const versionArgs = (agent: string) =>
  acpHarness(agent)?.versionArgs ?? ["--version"];
/** Every host an in-Daisy login may send the person to (auth.ts, login.ts). */
export const ACP_LOGIN_HOSTS: string[] = ACP_AGENTS.flatMap(
  (a) => ACP_HARNESSES[a]!.login?.hosts ?? [],
);
/**
 * Plan 5.7 / D-28: can a session of `agent` answer a 「问」 read-only, and
 * how strongly? `strong` for the native adapters (Claude restricted tools,
 * Codex read-only sandbox), `weak` for an ACP mode the agent only honours,
 * `none` when ACP offers no read-only (takes no 「问」).
 */
export function readOnlySupport(agent: string): "strong" | "weak" | "none" {
  const h = acpHarness(agent);
  if (!h) return agent === "claude" || agent === "codex" ? "strong" : "none";
  return h.modes.readOnly ? h.modes.readOnlyStrength : "none";
}
/** P4-10: the native adapters' permission modes and defaults (UI pickers, profiles.ts). */
const NATIVE_MODES: Record<string, { values: string[]; default: string }> = {
  claude: {
    values: ["manual", "default", "acceptEdits", "plan", "dontAsk", "auto"],
    default: "manual",
  },
  // codex "auto": Codex's own automatic review (auto_review).
  codex: { values: ["on-request", "untrusted", "never", "auto"], default: "on-request" },
};
/** The permission modes an identity of `agent` can choose ([]: none over ACP). */
export function permissionModes(agent: string): {
  values: string[];
  default: string;
} {
  const h = acpHarness(agent);
  return h
    ? { values: h.modes.values, default: h.modes.default }
    : (NATIVE_MODES[agent] ?? { values: [], default: "" });
}
/**
 * Can an identity of `agent` have its own login here (`profile
 * create-managed` + `login start`)? An ACP harness needs a relocatable CLI
 * directory and a login command in its entry.
 */
export function managedLoginSupported(agent: string): boolean {
  const h = acpHarness(agent);
  return !h || (!!h.configDir && !!h.login);
}
/** The agent's colour (UI avatars); undefined for the native ones (the theme has them). */
export const ACP_COLORS: Record<string, string> = Object.fromEntries(
  ACP_AGENTS.map((a) => [a, ACP_HARNESSES[a]!.color]),
);
