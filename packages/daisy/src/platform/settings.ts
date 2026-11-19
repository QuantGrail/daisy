/**
 * P6-11 (ADR-156): the start settings an autostarted Daisy cannot get from
 * a shell. systemd, launchd and the Windows Run entry start Daisy with
 * only PATH (and an explicit DAISY_DATA), so the owner can also write them
 * in the data directory's runner.json (the node's settings — `plugins`,
 * `autoUpdate`, `updateSource` live there too):
 *
 *   "port": 29420                        → DAISY_PORT (as given: taken → refuse)
 *   "acpHarnesses": "acp-harnesses.json" → DAISY_ACP_HARNESSES (a path; relative
 *                                          to the data directory)
 *   "agentBins": { "kimi": "/opt/…" }    → DAISY_KIMI_BIN, … (DAISY_<ID>_BIN)
 *
 * Precedence: the environment (new or old name) > runner.json > default.
 * Both entries — the `daisy` command (bin/daisy.mjs) and the Daisy process
 * (main.ts) — apply them to their own environment before anything reads
 * one (the harness table is fixed when contracts/acp-harnesses.ts loads),
 * so the command line and the process see the same harnesses, and every
 * reader stays as it was.
 *
 * Only node: modules, contracts/start-files.ts (which imports nothing) and
 * the language packs (platform/language.ts: node modules, the packs, config.json)
 * are imported: this runs before the rest is loaded.
 * Nothing here writes runner.json; nothing over the API does either (the
 * owner edits the file — see ADR-156 for why that is not behind the PIN).
 */
import { ownerT } from "./language.ts";
import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { commandShape, commandShapeOk, jsonErrorWhere, portOk, portRule, untrustedFile } from "../../../contracts/src/start-files.ts";
import { legacyEnvName } from "../../../contracts/src/env.ts";

export interface StartSettings {
  port?: number;
  /** Absolute path of the extra ACP harness file. */
  acpHarnesses?: string;
  /** agent id → command (absolute path or bare name). */
  agentBins: Record<string, string>;
  /** What is wrong in runner.json (one line each); the key is ignored. */
  problems: string[];
}

/**
 * The agents Daisy knows without an extra file: the native two and the
 * built-in ACP harnesses (contracts NATIVE_AGENTS + BUILTIN_ACP_AGENTS,
 * repeated here — the harness table must not load yet; a test keeps them
 * equal).
 */
export const BUILTIN_AGENT_IDS = ["claude", "codex", "kimi", "opencode", "antigravity", "deepseek"] as const;

const where = (dataDir: string) => join(dataDir, "runner.json");
const myUid = () => process.getuid?.();
/** Why `file` must not be used (another account's, writable by others), or null; throws when it is missing. */
const distrust = (file: string) => untrustedFile(statSync(file), myUid(), ownerT());

type RunnerFile = { missing: true } | { distrust: string } | { unreadable: unknown } | { text: string };

/**
 * P6-16 review (L3, L4): `<dataDir>/runner.json` opened once — judged by
 * the opened file's own stat, then read through the same descriptor (no
 * swap in between). Judged before it is read: a file another account owns
 * or can write is not parsed at all. Not being able to open or stat it
 * (other than its absence) counts as distrusted, never as fine.
 */
function loadRunnerFile(dataDir: string): RunnerFile {
  // The reasons are the owner's to read (status, doctor, the start's refusal).
  const t = ownerT(dataDir);
  let fd: number;
  try {
    fd = openSync(where(dataDir), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { missing: true };
    return { distrust: jsonErrorWhere(e, t) };
  }
  try {
    let st;
    try {
      st = fstatSync(fd);
    } catch (e) {
      return { distrust: jsonErrorWhere(e, t) };
    }
    const why = untrustedFile(st, myUid(), t);
    if (why) return { distrust: why };
    if (!st.isFile()) return { unreadable: Object.assign(new Error("not a file"), { code: "ENOTFILE" }) };
    try {
      return { text: readFileSync(fd, "utf8") };
    } catch (e) {
      return { unreadable: e };
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * P6-16 (ADR-160): why `<dataDir>/runner.json` must not be used, or null —
 * another account's, writable by others (the start settings' rule), or
 * not even looked at. Absent: null.
 */
export function runnerFileDistrusted(dataDir: string): string | null {
  const f = loadRunnerFile(dataDir);
  return "distrust" in f ? f.distrust : null;
}

/**
 * The keys of runner.json that decide which code this account runs: the
 * plugins it loads, where updates come from, whether they are installed
 * on their own (named when the command line leaves one out).
 */
export const CODE_KEYS = ["plugins", "updateSource", "autoUpdate"] as const;

export interface RunnerJson {
  /** The node's settings (null: no file, `distrust` or `broken`). */
  config: Record<string, any> | null;
  /** Why nothing of it is used (another account's, writable by others, cannot be looked at). */
  distrust?: string;
  /** Not a JSON object: one line saying where, never the file's text. */
  broken?: string;
}

/**
 * P6-16 (ADR-160 §3–4): runner.json as the Daisy process, the update
 * routes and the command line use it for the node's settings. Never
 * throws. Distrusted: nothing of it (review M2 — it also names the
 * identity homes and workspaces); the Daisy process does not start on it,
 * nor on a `broken` one (it holds the node's identity; defaults would run
 * a different node).
 */
export function readRunnerJson(dataDir: string): RunnerJson {
  const file = where(dataDir);
  const f = loadRunnerFile(dataDir);
  if ("missing" in f) return { config: null };
  if ("distrust" in f) return { config: null, distrust: f.distrust };
  if ("unreadable" in f) return { config: null, broken: ownerT(dataDir)("server-platform.settings.fileProblem", { file, why: jsonErrorWhere(f.unreadable, ownerT(dataDir)) }) };
  let raw: unknown;
  try {
    raw = JSON.parse(f.text);
  } catch (e) {
    // Never the parser's message: it quotes the file's text.
    return { config: null, broken: ownerT(dataDir)("server-platform.settings.fileProblem", { file, why: jsonErrorWhere(e, ownerT(dataDir)) }) };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { config: null, broken: ownerT(dataDir)("server-platform.settings.notObject", { file }) };
  return { config: { ...(raw as Record<string, any>) } };
}

/** The start settings in `<dataDir>/runner.json` (none when it is absent). Never throws. */
export function readStartSettings(dataDir: string): StartSettings {
  const out: StartSettings = { agentBins: {}, problems: [] };
  // Problems the owner reads (`daisy status`, `daisy doctor`): the owner's language.
  const t = ownerT(dataDir);
  let raw: any;
  try {
    // P6-11 review: a runner.json another account can write is not used
    // (it names the programs Daisy runs) — `--data-dir` / DAISY_DATA can
    // point anywhere.
    const f = loadRunnerFile(dataDir);
    if ("missing" in f) return out;
    if ("distrust" in f) {
      out.problems.push(t("server-platform.settings.distrusted", { file: where(dataDir), why: f.distrust }));
      return out;
    }
    if ("unreadable" in f) throw f.unreadable;
    raw = JSON.parse(f.text);
  } catch (e) {
    // Never the parser's message: it quotes the file's text.
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT")
      out.problems.push(t("server-platform.settings.unreadable", { file: where(dataDir), why: jsonErrorWhere(e, t) }));
    return out;
  }
  if (!raw || typeof raw !== "object") return out;
  const bad = (key: string, why: string) => out.problems.push(t("server-platform.settings.badKey", { file: where(dataDir), key, why }));
  if (raw.port !== undefined) {
    if (portOk(raw.port)) out.port = raw.port;
    else bad("port", t("server-platform.settings.mustBe", { rule: portRule(t) }));
  }
  if (raw.acpHarnesses !== undefined) {
    if (typeof raw.acpHarnesses === "string" && raw.acpHarnesses.trim())
      out.acpHarnesses = isAbsolute(raw.acpHarnesses) ? raw.acpHarnesses : resolve(dataDir, raw.acpHarnesses);
    else bad("acpHarnesses", t("server-platform.settings.mustBeJsonPath"));
  }
  if (raw.agentBins !== undefined) {
    if (!raw.agentBins || typeof raw.agentBins !== "object" || Array.isArray(raw.agentBins))
      bad("agentBins", t("server-platform.settings.mustBeAgentBins"));
    else
      for (const [id, cmd] of Object.entries(raw.agentBins)) {
        const key = `agentBins.${id.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 40)}`;
        if (typeof cmd !== "string" || !cmd.trim()) bad(key, t("server-platform.settings.mustBeCommand"));
        // P6-11 review: a relative path would be found in the session's workspace.
        else if (!commandShapeOk(cmd)) bad(key, commandShape(t));
        else out.agentBins[id] = cmd;
      }
  }
  return out;
}

/** DAISY_<ID>_BIN (contracts agentBinEnv, repeated here: nothing of contracts' harness table may load yet). */
const binEnv = (agent: string) => `DAISY_${agent.toUpperCase().replace(/-/g, "_")}_BIN`;
const isSet = (env: Record<string, string | undefined>, ...names: string[]) =>
  names.some((n) => env[n] !== undefined && env[n] !== "");

/**
 * The variables runner.json supplies that the environment does not set
 * (under either name: an old `HARBOR_<ID>_BIN` still wins over the file).
 * `agentBins` keys must be agents Daisy knows (`known`); others are said
 * and left out.
 */
export function settingsEnv(
  s: StartSettings,
  env: Record<string, string | undefined>,
  known: ReadonlySet<string> = new Set(BUILTIN_AGENT_IDS),
  file = "runner.json",
): { vars: Record<string, string>; problems: string[] } {
  const vars: Record<string, string> = {};
  const problems: string[] = [];
  if (s.port !== undefined && !isSet(env, "DAISY_PORT", "PORT")) vars.DAISY_PORT = String(s.port);
  if (s.acpHarnesses !== undefined && !isSet(env, "DAISY_ACP_HARNESSES")) vars.DAISY_ACP_HARNESSES = s.acpHarnesses;
  for (const [id, cmd] of Object.entries(s.agentBins)) {
    if (!known.has(id)) {
      const t = ownerT();
      problems.push(t("server-platform.settings.unknownAgent", { file, id: id.slice(0, 40), known: [...known].join(t("server.list.separator")) }));
      continue;
    }
    const name = binEnv(id);
    if (!isSet(env, name, legacyEnvName(name))) vars[name] = cmd;
  }
  return { vars, problems };
}

/**
 * The ids the extra ACP harness file declares (only the `id`s — the
 * harness table checks the rest), for `agentBins`. Nothing when it is
 * missing, broken or not trusted (the table says why).
 */
function extraIds(file: string | undefined): string[] {
  if (!file) return [];
  try {
    if (distrust(file)) return [];
    const list = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(list) ? list.map((x) => x?.id).filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** runner.json's settings for `env`: the variables it supplies and what is wrong. */
export function startEnv(
  dataDir: string,
  env: Record<string, string | undefined>,
): { vars: Record<string, string>; problems: string[] } {
  const s = readStartSettings(dataDir);
  const file = isSet(env, "DAISY_ACP_HARNESSES") ? env.DAISY_ACP_HARNESSES : s.acpHarnesses;
  const r = settingsEnv(s, env, new Set([...BUILTIN_AGENT_IDS, ...extraIds(file)]), where(dataDir));
  return { vars: r.vars, problems: [...s.problems, ...r.problems] };
}

/** `env` with what runner.json supplies (a copy; `env` wins). */
export function withSettings(
  dataDir: string,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return { ...env, ...startEnv(dataDir, env).vars };
}

let applied: { dataDir: string; from: Record<string, string>; problems: string[] } | null = null;

/**
 * At an entry, before anything else loads: runner.json's settings into
 * this process's environment where it has none. Returns the names set from
 * the file and what was wrong with it.
 */
export function applyStartSettings(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
): { from: Record<string, string>; problems: string[] } {
  const { vars: from, problems } = startEnv(dataDir, env);
  Object.assign(env, from);
  applied = { dataDir, from, problems };
  return { from, problems };
}

/** What `applyStartSettings` did in this process (null: not called — tests, in-process runs). */
export const appliedStartSettings = () => applied;

/**
 * P6-11 review: a child's environment without what this process took from
 * runner.json (unless it was changed since) — the Daisy process `daisy
 * start` launches, the successor a restart starts — so the child reads
 * runner.json itself: a later edit counts, and it knows the value came
 * from the file, not from the environment.
 */
export function withoutFileSettings<E extends Record<string, string | undefined>>(
  env: E,
  from: Record<string, string> = applied?.from ?? {},
): E {
  const out = { ...env };
  for (const [k, v] of Object.entries(from)) if (out[k] === v) delete out[k];
  return out;
}

/**
 * The command line's global `--data-dir` (cli/main.ts `globals` uses this
 * too, so the two never differ): the last one wins; up to a `--`; `missing`
 * when one has no value (`--data-dir` last, `--data-dir=`) — a usage error.
 */
export function splitDataDirArg(argv: readonly string[]): { dir?: string; missing: boolean; rest: string[] } {
  const rest: string[] = [];
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (a === "--data-dir" || a.startsWith("--data-dir=")) {
      dir = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      if (!dir) return { missing: true, rest };
      continue;
    }
    rest.push(a);
  }
  return { ...(dir ? { dir } : {}), missing: false, rest };
}

/**
 * The data directory the `daisy` command will use for `argv` when it has a
 * `--data-dir` (else undefined: DAISY_DATA or the system's convention, as
 * cli/main.ts) — before the command line itself is loaded.
 */
export function argvDataDir(argv: readonly string[]): string | undefined {
  const r = splitDataDirArg(argv);
  return !r.missing && r.dir ? resolve(r.dir) : undefined;
}
