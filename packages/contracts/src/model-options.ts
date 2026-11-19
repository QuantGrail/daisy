import { z } from "zod";
import { ACP_AGENTS, ACP_HARNESSES, isAcpAgent } from "./acp-harnesses.ts";
import type { Translate } from "./i18n.ts";
import { defaultTranslate } from "./i18n-default.ts";
/**
 * What the /model panel offers for the selected model:
 * reasoning efforts and Codex service tiers ("Fast"). Codex's native
 * catalog (app-server `model/list`, read by the 读取原生模型列表 operation
 * and kept in `session.commandCatalog.models`) lists, per model,
 * `supportedReasoningEfforts` and `serviceTiers`; Kimi lists its thinking
 * levels in `configOptions`; Claude has none, so a fixed list.
 */

/**
 * Every effort the server accepts. Passed to the CLIs as one argument
 * (Claude `--effort`, Codex `-c model_reasoning_effort=` in the terminal),
 * so it stays an enum. "ultra": Codex 0.157 (GPT-6 / 5.6 Sol, Terra,
 * Astra) — maximum reasoning with automatic task delegation.
 */
export const REASONING_EFFORTS = [
  "",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "on",
  "off",
] as const;
export const ReasoningEffortSchema = z.enum(REASONING_EFFORTS);
/**
 * A Codex service tier id: "" = the identity's / Codex's own default,
 * "default" = standard speed, otherwise a catalog id ("priority" = Fast).
 * Lowercase word only: it also goes into `-c service_tier="…"`.
 */
export const ServiceTierSchema = z
  .string()
  .max(40)
  .regex(/^(?:[a-z][a-z0-9_-]*)?$/, { error: () => defaultTranslate()("ui-contracts.model.tierInvalid") });
/** Codex's tier id for standard speed (turn/start `serviceTier`). */
export const STANDARD_TIER = "default";

export interface EffortChoice {
  value: string;
  /** The Agent's own one-line explanation, when it gives one. */
  description?: string;
}
export interface TierChoice {
  id: string;
  name: string;
  description?: string;
}
export interface ModelChoices {
  /** Efforts to offer, "" (the default) first. */
  efforts: EffortChoice[];
  /** The catalog's default effort for this model, if known. */
  defaultEffort?: string;
  /** Codex service tiers beyond standard; empty = no speed choice. */
  tiers: TierChoice[];
  /** true: read from the native catalog for this model; false: fallback list. */
  fromCatalog: boolean;
}

const known = new Set<string>(REASONING_EFFORTS);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const FALLBACK: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  // What every model of Codex 0.157's catalog accepts; ultra and Fast only
  // once the catalog says the selected model has them.
  codex: ["low", "medium", "high", "xhigh", "max"],
  // P4-10: each ACP harness's fallback ([] = only what its session lists).
  ...Object.fromEntries(ACP_AGENTS.map((a) => [a, ACP_HARNESSES[a]!.efforts])),
};

/** The catalog entry of `model` ("" = the catalog's default model). */
export function catalogModel(
  models: unknown[] | undefined,
  model: string,
): Record<string, any> | undefined {
  const list = (Array.isArray(models) ? models : []).filter(
    (m): m is Record<string, any> => !!m && typeof m === "object",
  );
  // Claude Code's initialize lists `value`s; its default is "default".
  return model
    ? list.find((m) => m.model === model || m.id === model || m.value === model)
    : list.find((m) => m.isDefault === true) ||
        list.find((m) => m.value === "default");
}

/**
 * Efforts / tiers for `model` of `agent`. `current` values stay listed even
 * when the catalog does not offer them, so a saved choice can be seen and
 * changed.
 */
export function modelChoices(
  agent: string,
  opts: {
    models?: unknown[];
    configOptions?: unknown[];
    model?: string;
    effort?: string;
    tier?: string;
  } = {},
): ModelChoices {
  let efforts: EffortChoice[] = [],
    defaultEffort: string | undefined,
    tiers: TierChoice[] = [],
    fromCatalog = false;
  if (agent === "codex") {
    const m = catalogModel(opts.models, opts.model || "");
    if (m && Array.isArray(m.supportedReasoningEfforts)) {
      fromCatalog = true;
      efforts = m.supportedReasoningEfforts
        .map((e: any) => ({
          value: str(e?.reasoningEffort),
          ...(str(e?.description) ? { description: str(e.description) } : {}),
        }))
        // Only what the server accepts (a newer Codex may add more).
        .filter((e: EffortChoice) => e.value && known.has(e.value));
      defaultEffort = str(m.defaultReasoningEffort) || undefined;
      tiers = (Array.isArray(m.serviceTiers) ? m.serviceTiers : [])
        .map((t: any) => ({
          id: str(t?.id),
          name: str(t?.name) || str(t?.id),
          ...(str(t?.description) ? { description: str(t.description) } : {}),
        }))
        .filter(
          (t: TierChoice) =>
            t.id !== STANDARD_TIER && ServiceTierSchema.safeParse(t.id).success,
        );
    }
  } else if (agent === "claude") {
    // Claude Code's initialize lists, per model,
    // `supportedEffortLevels` (and `supportsEffort: false` for none).
    const m = catalogModel(opts.models, opts.model || "");
    // A listed model without levels takes no effort (Haiku 4.5).
    if (m && typeof m.value === "string") {
      fromCatalog = true;
      efforts = (
        m.supportsEffort !== false && Array.isArray(m.supportedEffortLevels)
          ? m.supportedEffortLevels
          : []
      )
        .map((v: unknown) => ({ value: str(v) }))
        .filter((e: EffortChoice) => e.value && known.has(e.value));
    }
  } else if (isAcpAgent(agent)) {
    // ACP: the session's `thought_level` config option (Kimi Code
    // `thinking`, OpenCode `effort` …); an older Kimi lists it by id only.
    const list = Array.isArray(opts.configOptions) ? opts.configOptions : [];
    const legacy = ACP_HARNESSES[agent]!.legacy?.thinkingConfigId;
    const thinking = (list.find((o: any) => o?.category === "thought_level") ||
      (legacy && list.find((o: any) => o?.id === legacy))) as any;
    if (Array.isArray(thinking?.options)) {
      fromCatalog = true;
      efforts = thinking.options
        .map((o: any) => ({ value: str(o?.value) }))
        .filter((e: EffortChoice) => e.value && known.has(e.value));
    }
  }
  if (!fromCatalog)
    efforts = (FALLBACK[agent] || FALLBACK.claude!).map((value) => ({ value }));
  if (opts.effort && !efforts.some((e) => e.value === opts.effort))
    efforts.push({ value: opts.effort });
  if (
    agent === "codex" &&
    opts.tier &&
    opts.tier !== STANDARD_TIER &&
    !tiers.some((t) => t.id === opts.tier)
  )
    tiers.push({ id: opts.tier, name: tierName(opts.tier) });
  return {
    efforts: [{ value: "" }, ...efforts],
    ...(defaultEffort ? { defaultEffort } : {}),
    tiers,
    fromCatalog,
  };
}

/**
 * What an effort means, when the Agent does not say (the UI explains every
 * choice), in `t`'s language; undefined for an effort without words.
 */
export function effortWord(value: string, t: Translate = defaultTranslate()): string | undefined {
  return (REASONING_EFFORTS as readonly string[]).includes(value) && value
    ? t.dynamic(`ui-contracts.effort.${value}`)
    : undefined;
}
/** One row of a native model list, for pickers. */
export interface NativeModel {
  /** What to save as the model ("" = the identity's / CLI's default). */
  value: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  /** Claude Code: the model an alias resolves to now. */
  resolved?: string;
}
/**
 * A native model list (Codex model/list, Claude Code initialize, Kimi
 * configOptions) as picker rows; Claude's "default" becomes "" (the
 * identity's default). Hidden Codex models are left out.
 */
export function nativeModels(agent: string, models?: unknown[]): NativeModel[] {
  const out: NativeModel[] = [];
  for (const m of Array.isArray(models) ? models : []) {
    if (!m || typeof m !== "object") continue;
    const x = m as Record<string, any>;
    if (x.hidden === true) continue;
    const value =
      agent === "claude" && x.value === "default"
        ? ""
        : str(x.model) || str(x.value) || str(x.id);
    if (!value && !(agent === "claude" && x.value === "default")) continue;
    if (out.some((o) => o.value === value)) continue;
    out.push({
      value,
      name: str(x.displayName) || str(x.display_name) || str(x.name) || value,
      ...(str(x.description) ? { description: str(x.description) } : {}),
      ...(x.isDefault === true || (agent === "claude" && x.value === "default")
        ? { isDefault: true }
        : {}),
      ...(str(x.resolvedModel) && str(x.resolvedModel) !== value
        ? { resolved: str(x.resolvedModel) }
        : {}),
    });
  }
  return out;
}
/** A tier id as people read it: the catalog's name, else Codex's own. */
export function tierName(id: string, models?: unknown[], t: Translate = defaultTranslate()): string {
  for (const m of Array.isArray(models) ? models : [])
    for (const t of (m as any)?.serviceTiers || [])
      if (t?.id === id && str(t?.name)) return t.name;
  if (id === "priority" || id === "fast") return "Fast";
  if (id === STANDARD_TIER) return t("ui-contracts.model.tierStandard");
  return id;
}

/**
 * Why `agent` cannot run with these settings, or null:
 * ultra and service tiers are Codex's; for a Codex model the native
 * catalog lists (`models`, the session's commandCatalog), the effort and
 * tier must be among its own. An unknown model / no catalog: not checked.
 */
export function settingsError(
  agent: string,
  s: { model?: string; reasoningEffort?: string; serviceTier?: string },
  models?: unknown[],
  t: Translate = defaultTranslate(),
): string | null {
  if (agent !== "codex") {
    if (s.reasoningEffort === "ultra") return t("ui-contracts.model.ultraCodexOnly");
    if (s.serviceTier) return t("ui-contracts.model.tierCodexOnly");
    return null;
  }
  const m = s.model ? catalogModel(models, s.model) : undefined;
  if (!m) return null;
  if (
    s.reasoningEffort &&
    Array.isArray(m.supportedReasoningEfforts) &&
    !m.supportedReasoningEfforts.some(
      (e: any) => e?.reasoningEffort === s.reasoningEffort,
    )
  )
    return t("ui-contracts.model.effortUnsupported", { model: s.model!, effort: s.reasoningEffort });
  if (
    s.serviceTier &&
    s.serviceTier !== STANDARD_TIER &&
    Array.isArray(m.serviceTiers) &&
    !m.serviceTiers.some(
      (t: any) =>
        t?.id === s.serviceTier ||
        // Codex's own alias of priority.
        (s.serviceTier === "fast" && t?.id === "priority"),
    )
  )
    return t("ui-contracts.model.tierUnsupported", { model: s.model!, tier: s.serviceTier });
  return null;
}
