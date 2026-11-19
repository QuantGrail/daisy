import { z } from "zod";
import { ACP_AGENTS, ACP_HARNESSES, harnessText } from "./acp-harnesses.ts";
import { AgentSchema, type Agent } from "./session.ts";
import type { Translate } from "./i18n.ts";
import { defaultTranslate } from "./i18n-default.ts";
/**
 * Context usage ring, plan quota and auto-compact threshold. Shared by Runner, server and
 * UI; the UI's gauge logic is `contextGauge()` in packages/ui present.ts.
 */
export const CONTEXT_USAGE_VERSION = 1;
type AgentName = Agent;

/** Prompt-side token counters of one job (or summed over a session). */
export interface CacheCounters {
  /** All prompt tokens, cached ones included (the denominator). */
  prompt: number;
  /** Prompt tokens read from the cache (the numerator). */
  read: number;
  /** Prompt tokens written to the cache; null = the Agent does not say. */
  write: number | null;
}
/** Where the auto-compaction really triggers, as the Agent reports it. */
export interface ContextThreshold {
  /** Tokens at which auto-compaction triggers; null = unknown or off. */
  tokens: number | null;
  /**
   * harness: the CLI reported its own trigger point (Claude
   * get_context_usage); config: the CLI read back the configured limit
   * (Codex config/read); unknown: nothing to go by.
   */
  source: "harness" | "config" | "unknown";
  /** Who set it: Daisy's identity setting, the CLI's own default, the environment / settings file. */
  origin: "identity" | "cli-default" | "cli-env" | "cli-settings" | "unknown";
  /** Auto-compaction on; null = unknown. */
  enabled: boolean | null;
  /** false: something the CLI does not report shifts the real point (≈). */
  exact: boolean;
  /** The CLI's compaction window (Claude maxTokens = the --autocompact value). */
  window: number | null;
  /** The identity's setting (tokens); null = the CLI's default. */
  requested: number | null;
  /** requested is what this process runs with; null = nothing requested. */
  applied: boolean | null;
  /** Why it is unknown / not applied (in the reporter's language, shown as is). */
  reason?: string;
  /** The CLI's own label for the source, e.g. Claude's "settings" | "env" | "model-default". */
  native?: string;
}
export interface CompactMark {
  at: number;
  trigger: "auto" | "manual" | "unknown";
  preTokens?: number;
  postTokens?: number;
}
/**
 * `input` of the `<jid>:context` item (v1). `used` / `window` keep their
 * original meaning for older clients; new clients never divide by `window`.
 */
export interface ContextUsage {
  v: 1;
  agent: AgentName;
  /** Tokens in the conversation now. */
  used: number;
  /** The model's context window: shown as a note only, never the ring's denominator. */
  window: number | null;
  threshold: ContextThreshold;
  /** This job's prompt counters; null = the Agent does not report them. */
  cache: CacheCounters | null;
  lastCompact?: CompactMark;
  updatedAt: number;
}
/** The newest ContextUsage of a conversation, kept by the server on the session. */
export interface SessionContext extends ContextUsage {
  /** The item it came from (`<jid>:context`). */
  itemId: string;
  /** Cache counters over the whole conversation (every job, once each). */
  cacheSession: CacheCounters | null;
}
export interface QuotaWindow {
  kind: "five_hour" | "weekly" | "weekly_model";
  label?: string;
  /** 0–100; null = unknown. Remaining = 100 − used. */
  usedPercent: number | null;
  /** When the window resets (ms); null = unknown. */
  resetsAt: number | null;
}
/**
 * Plan quota of one identity, as the Runner last read it (`<jid>:quota`
 * item, copied to `Session.quota`). Percentages, reset times and the plan
 * name only: never account ids, e-mail or credentials.
 */
export interface QuotaSnapshot {
  v: 1;
  profileId: string;
  provider:
    | "claude-subscription"
    | "codex-chatgpt"
    | "glm-coding"
    | "kimi-code"
    | "api-key"
    | "unknown";
  status: "ok" | "not-applicable" | "unavailable" | "error";
  reason?: string;
  plan: {
    name: string | null;
    source: "provider" | "identity-label" | "unknown";
  };
  /** The identity's own name (its owner's label), shown after the plan. */
  identity?: string;
  windows: QuotaWindow[];
  fetchedAt: number;
  via: "cli-control" | "cli-rpc" | "stream" | "http" | "none";
}
/** What one Agent supports on this Runner (heartbeat `capabilities.contextUsage`). */
export interface AgentContextCapability {
  threshold: "harness" | "config" | "none";
  configurable: boolean;
  /** Accepted --autocompact / limit values (tokens), inclusive. */
  range?: [number, number];
  /** How a new value takes effect: a restart of the idle process. */
  applies?: "idle-restart";
  reason?: string;
}
export interface ContextUsageCapability {
  version: number;
  agents: Partial<Record<AgentName, AgentContextCapability>>;
}
/** Claude Code's --autocompact range (2.1.316, measured: outside it the CLI exits). */
export const CLAUDE_AUTOCOMPACT_RANGE: [number, number] = [100_000, 1_000_000];
/** Codex model_auto_compact_token_limit: accepted range (the CLI reads it back). */
export const CODEX_AUTOCOMPACT_RANGE: [number, number] = [10_000, 2_000_000];
/** P6-23b: Kimi Code's reason, in `t`'s language (was the constant KIMI_THRESHOLD_REASON). */
export const kimiThresholdReason = (t: Translate = defaultTranslate()): string =>
  harnessText(ACP_HARNESSES.kimi!, "thresholdReason", t);
/**
 * Oldest Claude Code whose --autocompact and get_context_usage threshold
 * Daisy relies on: the oldest release verified on this machine (2.1.310,
 * also 2.1.312 / 2.1.316 — scripts/probe-autocompact.mjs). The CLI keeps no
 * changelog of when the flag arrived; an older CLI would exit on the
 * unknown option, so it is reported as not configurable.
 */
export const CLAUDE_AUTOCOMPACT_MIN_VERSION = "2.1.310";
/** "2.1.316 (Claude Code)" ≥ "2.1.310"? Unparseable = no. */
export function versionAtLeast(version: unknown, min: string) {
  const v = /(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? "")),
    m = /(\d+)\.(\d+)\.(\d+)/.exec(min)!;
  if (!v) return false;
  for (let i = 1; i <= 3; i++)
    if (Number(v[i]) !== Number(m[i])) return Number(v[i]) > Number(m[i]);
  return true;
}
/**
 * What a Runner of this version advertises. `cli`: the installed CLIs as
 * the Runner recorded them (`claude --version`); omitted = assume current.
 */
export function contextUsageCapability(
  cli?: Partial<Record<AgentName, { installed?: boolean; version?: string }>>,
  t: Translate = defaultTranslate(),
): ContextUsageCapability {
  const claude = cli?.claude;
  const claudeOk =
    !cli || versionAtLeast(claude?.version, CLAUDE_AUTOCOMPACT_MIN_VERSION);
  return {
    version: CONTEXT_USAGE_VERSION,
    agents: {
      claude: claudeOk
        ? {
            threshold: "harness",
            configurable: true,
            range: CLAUDE_AUTOCOMPACT_RANGE,
            applies: "idle-restart",
          }
        : {
            threshold: "none",
            configurable: false,
            reason: claude?.installed
              ? t("ui-contracts.context.claudeTooOld", {
                  version: claude.version ? String(claude.version).slice(0, 40) : t("ui-contracts.context.versionUnknown"),
                  min: CLAUDE_AUTOCOMPACT_MIN_VERSION,
                })
              : t("ui-contracts.context.claudeMissing"),
          },
      codex: {
        threshold: "config",
        configurable: true,
        range: CODEX_AUTOCOMPACT_RANGE,
        applies: "idle-restart",
      },
      // P4-10: no ACP harness reports or takes a threshold.
      ...Object.fromEntries(
        ACP_AGENTS.map((a) => [
          a,
          {
            threshold: "none" as const,
            configurable: false,
            reason: harnessText(ACP_HARNESSES[a]!, "thresholdReason", t),
          },
        ]),
      ),
    },
  };
}
/** Can this node take an auto-compact setting for `agent`? */
export function autoCompactSupport(
  capabilities: Record<string, unknown> | null | undefined,
  agent: AgentName,
  t: Translate = defaultTranslate(),
):
  | { configurable: true; range: [number, number] }
  | { configurable: false; reason: string } {
  const cap = (capabilities as any)?.contextUsage as
    ContextUsageCapability | undefined;
  if (!cap || typeof cap !== "object" || !cap.version)
    return {
      configurable: false,
      reason: t("ui-contracts.context.runnerTooOld"),
    };
  const a = cap.agents?.[agent];
  if (!a)
    return {
      configurable: false,
      reason: t("ui-contracts.context.runnerNoAgent"),
    };
  if (!a.configurable)
    return {
      configurable: false,
      reason: a.reason || t("ui-contracts.context.agentNotConfigurable"),
    };
  const r = Array.isArray(a.range) ? a.range : null;
  return {
    configurable: true,
    range:
      r && Number.isFinite(r[0]) && Number.isFinite(r[1])
        ? [r[0], r[1]]
        : [1, Number.MAX_SAFE_INTEGER],
  };
}
/** null = acceptable; otherwise why not (shown as is). */
export function autoCompactError(
  tokens: number | null,
  support: ReturnType<typeof autoCompactSupport>,
  t: Translate = defaultTranslate(),
): string | null {
  if (tokens === null) return null;
  if (!support.configurable) return support.reason;
  if (!Number.isInteger(tokens)) return t("ui-contracts.context.thresholdInteger");
  const [lo, hi] = support.range;
  if (tokens < lo || tokens > hi)
    return t("ui-contracts.context.thresholdRange", { lo: Math.round(lo / 1000), hi: Math.round(hi / 1000) });
  return null;
}

const count = z.number().int().nonnegative().max(1e15);
const Counters = z.object({
  prompt: count,
  read: count,
  write: count.nullable(),
});
const reason = z.string().max(300);
export const ContextUsageSchema = z.object({
  v: z.literal(1),
  agent: AgentSchema,
  used: count,
  window: count.nullable(),
  threshold: z.object({
    tokens: count.nullable(),
    source: z.enum(["harness", "config", "unknown"]),
    origin: z.enum([
      "identity",
      "cli-default",
      "cli-env",
      "cli-settings",
      "unknown",
    ]),
    enabled: z.boolean().nullable(),
    exact: z.boolean(),
    window: count.nullable(),
    requested: count.nullable(),
    applied: z.boolean().nullable(),
    reason: reason.optional(),
    native: z.string().max(60).optional(),
  }),
  cache: Counters.nullable(),
  lastCompact: z
    .object({
      at: count,
      trigger: z.enum(["auto", "manual", "unknown"]),
      preTokens: count.optional(),
      postTokens: count.optional(),
    })
    .optional(),
  updatedAt: count,
});
export const QuotaSnapshotSchema = z.object({
  v: z.literal(1),
  profileId: z.string().max(100),
  provider: z.enum([
    "claude-subscription",
    "codex-chatgpt",
    "glm-coding",
    "kimi-code",
    "api-key",
    "unknown",
  ]),
  status: z.enum(["ok", "not-applicable", "unavailable", "error"]),
  reason: reason.optional(),
  plan: z.object({
    name: z.string().max(100).nullable(),
    source: z.enum(["provider", "identity-label", "unknown"]),
  }),
  identity: z.string().max(100).optional(),
  windows: z
    .array(
      z.object({
        kind: z.enum(["five_hour", "weekly", "weekly_model"]),
        label: z.string().max(60).optional(),
        usedPercent: z.number().min(0).max(1000).nullable(),
        resetsAt: count.nullable(),
      }),
    )
    .max(8),
  fetchedAt: count,
  via: z.enum(["cli-control", "cli-rpc", "stream", "http", "none"]),
});
/** A `<jid>:context` item's input as v1, or null (older Runner, junk). */
export function parseContextUsage(input: unknown): ContextUsage | null {
  const r = ContextUsageSchema.safeParse(input);
  return r.success ? (r.data as ContextUsage) : null;
}
/** A `<jid>:quota` item's input (extra fields dropped), or null. */
export function parseQuotaSnapshot(input: unknown): QuotaSnapshot | null {
  const r = QuotaSnapshotSchema.safeParse(input);
  return r.success ? (r.data as QuotaSnapshot) : null;
}
