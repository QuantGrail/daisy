import { z } from "zod";
import { ReasoningEffortSchema, ServiceTierSchema } from "./model-options.ts";
import { AgentSchema, type Agent } from "./session.ts";
import type { ContextThreshold } from "./context-usage.ts";
import type { Translate } from "./i18n.ts";
import { defaultTranslate } from "./i18n-default.ts";
// Identities (profiles), model names / slots, per-session model settings (P1-00: moved from index.ts).
// Passed to the Agent CLI as one argument / an environment value: never a
// flag (no leading "-"), no spaces or control characters.
export const ModelNameSchema = z
  .string()
  .max(200)
  .regex(/^(?:[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]*)?$/, { error: () => defaultTranslate()("ui-contracts.profile.modelInvalid") });
/** Claude Code's model slots. */
export const MODEL_SLOTS = ["opus", "sonnet", "haiku", "fable"] as const;
export type ModelSlot = (typeof MODEL_SLOTS)[number];
export type ModelSlots = Partial<Record<ModelSlot, string>>;
export const ModelSlotsSchema = z
  .object({
    opus: ModelNameSchema.optional(),
    sonnet: ModelNameSchema.optional(),
    haiku: ModelNameSchema.optional(),
    fable: ModelNameSchema.optional(),
  })
  .strict();
/** Slots with a value only (empty strings dropped); undefined = none. */
export function cleanModelSlots(
  slots: ModelSlots | undefined | null,
): ModelSlots | undefined {
  const out: ModelSlots = {};
  for (const k of MODEL_SLOTS) {
    const v = slots?.[k]?.trim();
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
/**
 * Provider presets, taken from the cc-switch project's presets (verified
 * there): GLM has no fable slot, and without 「[1m]」 GLM gives a 200k
 * window only; the official plan maps every slot to Opus 5.5 (1M).
 */
export const GLM_MODEL_SLOTS: Readonly<ModelSlots> = {
  opus: "glm-5.3[1m]",
  sonnet: "glm-5.3-flash[1m]",
  haiku: "glm-5.3-flash[1m]",
};
export const OFFICIAL_MODEL_SLOTS: Readonly<ModelSlots> = {
  opus: "claude-opus-5-5[1m]",
  sonnet: "claude-opus-5-5[1m]",
  haiku: "claude-opus-5-5[1m]",
  fable: "claude-opus-5-5[1m]",
};
/** The top-level pin for GLM when it is empty or a fable / mythos model. */
export const GLM_MODEL_PIN = "opus[1m]";
/** A Zhipu GLM endpoint (bigmodel.cn / z.ai), as the Runner's quota reader. */
export function isGlmBaseUrl(baseUrl: string | undefined | null): boolean {
  try {
    return /(^|\.)bigmodel\.cn$|(^|\.)z\.ai$/i.test(
      new URL(baseUrl || "").hostname,
    );
  } catch {
    return false;
  }
}
const FABLE = /fable|mythos/i;
/**
 * A GLM identity whose top-level pin is a fable / mythos model, or with a
 * fable slot: GLM has no such model, so Claude Code would send it straight
 * to the GLM endpoint and the request fails. null = nothing to say.
 */
export function glmModelWarning(
  p: {
    baseUrl?: string | null;
    model?: string | null;
    modelSlots?: ModelSlots | null;
  },
  t: Translate = defaultTranslate(),
): string | null {
  if (!isGlmBaseUrl(p.baseUrl)) return null;
  const pin = FABLE.test(p.model || "");
  const slot = !!p.modelSlots?.fable?.trim();
  if (!pin && !slot) return null;
  const what = [
    pin ? t("ui-contracts.profile.glm.pin", { model: p.model! }) : "",
    slot ? t("ui-contracts.profile.glm.slot", { model: p.modelSlots!.fable!.trim() }) : "",
  ]
    .filter(Boolean)
    .join(t("ui-contracts.profile.glm.sep"));
  return t(slot ? "ui-contracts.profile.glm.warningSlot" : "ui-contracts.profile.glm.warning", { what, pin: GLM_MODEL_PIN });
}
/** The pin cc-switch sets on GLM: opus[1m] for an empty or fable / mythos pin. */
export const glmModelPin = (model: string | undefined | null): string =>
  !model?.trim() || FABLE.test(model) ? GLM_MODEL_PIN : model.trim();
/** 「换身份」 — the identity this conversation continues with. */
export const SwitchIdentitySchema = z.object({
  profileId: z.string().min(1).max(100),
});
export const SessionSettingsSchema = z.object({
  model: ModelNameSchema.optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  /** Codex service tier: "" = the identity's, "default" = standard, "priority" = Fast. */
  serviceTier: ServiceTierSchema.optional(),
  /**
   * false = 「只问」 does not fork a sidecar for this AI; askOnly
   * messages wake its main session as a normal @ (with a note). Absent = on.
   */
  askSidecar: z.boolean().optional(),
  /**
   * false = Daisy wakes (callbacks, timers, approval decisions …)
   * do not go into a running turn by themselves; they wait in the queue.
   */
  autoAppendWakes: z.boolean().optional(),
});
export interface Profile {
  id: string;
  ownerId: string;
  nodeId: string;
  agent: Agent;
  /** In the request's language when it is Daisy's own default name (P6-28). */
  label: string;
  /** The label is Daisy's default ("<harness> · host login"): `shownName("profile", …)` says it in another language. */
  labelDefault?: boolean;
  authMode: "subscription" | "apiKey";
  model: string;
  baseUrl: string;
  configDir: string;
  hasSecret: boolean;
  lastAuthenticatedAt?: number;
  reasoningEffort?: string;
  /** Codex service tier for this identity; absent / "" = Codex's own default. */
  serviceTier?: string;
  /**
   * Claude Code model slots of this identity: what 「opus」 /
   * 「sonnet」 / 「haiku」 / 「fable」 mean for its process and subagents
   * (ANTHROPIC_DEFAULT_*_MODEL). Absent / empty slot = Claude Code's own.
   */
  modelSlots?: ModelSlots;
  permissionMode?: string;
  sandboxMode?: string;
  /**
   * Auto-compact threshold for every conversation of this identity
   *, in tokens: Claude Code's native compaction window
   * (--autocompact), Codex's model_auto_compact_token_limit. Absent / null
   * = the CLI's default.
   */
  autoCompactTokens?: number | null;
}
export const ProfileSchema = z.object({
  label: z.string().min(1).max(100),
  nodeId: z.string(),
  agent: AgentSchema,
  authMode: z.enum(["subscription", "apiKey"]),
  model: z.string().max(200).default(""),
  baseUrl: z.string().max(1000).default(""),
  configDir: z.string().max(1000).default(""),
  // P1-06: a credential — the command line reads it from stdin / a prompt
  // (`x-daisy-input`, api/route.ts secretInput); validation unchanged.
  apiKey: z.string().max(10000).meta({ "x-daisy-input": "secret" }).optional(),
  authHeader: z.enum(["apiKey", "bearer"]).default("apiKey"),
  /** Claude Code model slots (Claude identities only). */
  modelSlots: ModelSlotsSchema.optional(),
});
/**
 * An identity's auto-compact threshold and what its online processes run
 * with (`GET /api/profiles/:id/auto-compact`). P1-06: moved from
 * the client package (the route table names it).
 */
export interface AutoCompactStatus {
  profileId: string;
  agent: Agent;
  tokens: number | null;
  support:
    | { configurable: true; range: [number, number] }
    | { configurable: false; reason: string };
  reported: (ContextThreshold & { at: number; sessionId: string }) | null;
  sessions: {
    sessionId: string;
    title: string;
    state: "applied" | "waiting" | "restarting" | "unknown";
    tokens: number | null;
    restartNow: boolean;
    interrupts: string[];
  }[];
}
