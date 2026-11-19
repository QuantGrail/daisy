/**
 * P6-03 (ADR-153, D-43 ⑥): Daisy's environment variables are `DAISY_*`.
 * Each one used to be `HARBOR_*`; the old name is still read when the new
 * one is not set, with a one-time warning naming both (never the value).
 * Every reader of a renamed variable goes through `daisyEnv` — the one
 * place the fallback lives.
 */
import type { Translate } from "./i18n.ts";
import { defaultTranslate } from "./i18n-default.ts";
export type EnvSource = Record<string, string | undefined>;

/**
 * Every renamed variable Daisy reads (each was `HARBOR_` + the same
 * suffix), besides `DAISY_<ID>_BIN` (one per harness, `agentBinEnv`) and
 * `DAISY_BASE_PATH` (the web build, apps/app/app.config.js, which reads
 * both names itself). `HARBOR_DATA` is not here: it was never honoured by
 * Daisy (paths.ts) and only gets its own warning (daemon.ts).
 */
export const RENAMED_ENV = [
  "DAISY_AGENT_FRAME_MAX_MIB",
  "DAISY_ASK_SIDECAR_CONCURRENT",
  "DAISY_ASK_SIDECAR_DAILY",
  "DAISY_ASK_SIDECAR_IDLE_MS",
  "DAISY_BACKGROUND_PER_NODE",
  "DAISY_BACKGROUND_PER_SESSION",
  "DAISY_BG_KEEPALIVE_MS",
  "DAISY_BOOTSTRAP_LOCAL",
  "DAISY_BRANDING",
  "DAISY_BRANDING_FILE",
  "DAISY_CLAUDE_BIN",
  "DAISY_CLAUDE_FILE_CHECKPOINTS",
  "DAISY_CLAUDE_FOLLOWUP_MS",
  "DAISY_CLAUDE_STEER_ACK_MS",
  "DAISY_CLAUDE_STEER_IDLE_MS",
  "DAISY_CODEX_BIN",
  "DAISY_CODEX_CHECKPOINT_FILE_MB",
  "DAISY_CODEX_CHECKPOINT_FILES",
  "DAISY_CODEX_CHECKPOINT_MB",
  "DAISY_CODEX_CHECKPOINT_MS",
  "DAISY_CODEX_CHECKPOINT_SNAPSHOT_MB",
  "DAISY_CODEX_CHECKPOINT_TOTAL_MB",
  "DAISY_CODEX_CHECKPOINT_TTL_DAYS",
  "DAISY_CODEX_CHECKPOINT_TURNS",
  "DAISY_CODEX_COMPACT_CHECK_MS",
  "DAISY_CODEX_COMPACT_MAX_MS",
  "DAISY_CODEX_FILE_CHECKPOINTS",
  "DAISY_CODEX_POLL_MS",
  "DAISY_CODEX_QUIET_MS",
  "DAISY_CODEX_STALL_MS",
  "DAISY_CODEX_STEER_STALL_MS",
  "DAISY_CODEX_STOP_KILL_MS",
  "DAISY_DRAIN_GRACE_MS",
  "DAISY_DRAIN_MS",
  "DAISY_LIVE",
  "DAISY_LIVE_IDLE_MS",
  "DAISY_LOCAL_RUNNER",
  "DAISY_MONITOR_MIN_INTERVAL_S",
  "DAISY_NODE_CONFIG",
  "DAISY_ORIGINS",
  "DAISY_PROMPT_PILOT_MAX",
  "DAISY_RATE_LIMIT",
  "DAISY_RUNNER_BACKGROUND_LIMIT",
  "DAISY_RUNNER_RESTART_WAIT_MS",
  "DAISY_RUNNER_SELF_RESTART",
  "DAISY_SERVER_URL",
  "DAISY_SIDE_QUESTION_MS",
  "DAISY_SIDECAR_BWRAP",
  "DAISY_TITLE_BUDGET_MS",
  "DAISY_TITLE_CODEX_MODEL",
] as const;

/** The name a `DAISY_*` variable had before the rename (`HARBOR_*`). */
export const legacyEnvName = (name: string): string =>
  name.replace(/^DAISY_/, "HARBOR_");

const warned = new Set<string>();
let sink: (message: string) => void = (m) => console.warn(m);

/** The warning given once per old name. */
export const legacyEnvWarning = (name: string, t: Translate = defaultTranslate()): string =>
  t("server-contracts.env.legacyRenamed", { old: legacyEnvName(name), name });

/**
 * The value of `name` (a `DAISY_*` variable): the new name when it is set
 * (also when set to ""), else the old `HARBOR_*` name (warned once per
 * process), else undefined.
 */
export function daisyEnv(
  name: `DAISY_${string}`,
  env: EnvSource = (globalThis as any).process?.env ?? {},
): string | undefined {
  const v = env[name];
  if (v !== undefined) return v;
  const old = legacyEnvName(name);
  const o = env[old];
  if (o !== undefined && !warned.has(old)) {
    warned.add(old);
    try {
      sink(legacyEnvWarning(name));
    } catch {
      /* a warning never stops a read */
    }
  }
  return o;
}

/** Both names of a renamed variable (to remove both from a child's environment). */
export const envNames = (name: `DAISY_${string}`): [string, string] => [
  name,
  legacyEnvName(name),
];

/** Tests: where warnings go, and forget which were given. */
export function setLegacyEnvWarning(f?: (message: string) => void): void {
  sink = f ?? ((m) => console.warn(m));
  warned.clear();
}
