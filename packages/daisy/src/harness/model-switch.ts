/**
 * the agent itself answered (part of) a turn with another model
 * than the session's — one trace step for both engines, so the person
 * knows which model wrote the answer:
 * - Claude Code 2.1.316 `system/model_fallback {trigger, original_model,
 *   fallback_model, content}` (measured: `--model <unknown> --fallback-model
 *   haiku` → trigger `model_not_found`, "Switched to Haiku 5.5 because … is
 *   not available"; turn-scoped, @internal) and `system/model_refusal_fallback
 *   {original_model, fallback_model, scope, api_refusal_category, content}`
 *   (schema: the refused turn retried once on the fallback; `scope`
 *   "session" or absent = the session model is swapped).
 * - Codex 0.157.1 `model/rerouted {threadId, turnId, fromModel, toModel,
 *   reason: "highRiskCyberActivity"}` (stable schema; not triggered here).
 */
import type { MessageKey } from "../../../contracts/src/i18n.ts";
import type { Item } from "../../../contracts/src/index.ts";
import type { Translate } from "../../../contracts/src/i18n.ts";
import { inSessionT } from "../platform/language.ts";

const CLAUDE_TRIGGER: Record<string, MessageKey> = {
  model_not_found: "server-harness.modelSwitch.trigger.model_not_found",
  permission_denied: "server-harness.modelSwitch.trigger.permission_denied",
  overloaded: "server-harness.modelSwitch.trigger.overloaded",
  server_error: "server-harness.modelSwitch.trigger.server_error",
  last_resort: "server-harness.modelSwitch.trigger.last_resort",
  model_blocked: "server-harness.modelSwitch.trigger.model_blocked",
  refusal: "server-harness.modelSwitch.trigger.refusal",
};
const CODEX_REASON: Record<string, MessageKey> = {
  highRiskCyberActivity: "server-harness.modelSwitch.codex.highRiskCyberActivity",
};
const said = (k: MessageKey | undefined) => (k ? turnT().dynamic(k) : "");
const name = (v: unknown) =>
  typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200) : "";
const prose = (v: unknown) =>
  typeof v === "string"
    ? v.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, 500)
    : "";

export interface ModelSwitch {
  from: string;
  to: string;
  /** Why, in the owner's language (the engine's own code when unknown). */
  reason: string;
  /** The session's model itself changed (not only this turn's answer). */
  session: boolean;
  engine: "claude" | "codex";
  code: string;
  /** The engine's own words, display only. */
  detail?: string;
}

/** A Claude Code system message about a model fallback; null: not one. */
export function claudeModelSwitch(m: any): ModelSwitch | null {
  if (m?.type !== "system") return null;
  const refusal = m.subtype === "model_refusal_fallback";
  if (!refusal && m.subtype !== "model_fallback") return null;
  const from = name(m.original_model),
    to = name(m.fallback_model);
  if (!to) return null;
  const code = refusal ? "refusal" : name(m.trigger);
  const category = refusal ? name(m.api_refusal_category) : "";
  return {
    from,
    to,
    reason:
      category
        ? turnT()("server-harness.modelSwitch.withCategory", { reason: said(CLAUDE_TRIGGER[code]) || code || turnT()("server-harness.modelSwitch.unavailable"), category })
        : said(CLAUDE_TRIGGER[code]) || code || turnT()("server-harness.modelSwitch.unavailable"),
    // Turn-scoped fallback: the next turn tries the primary again.
    session: refusal && m.scope !== "local",
    engine: "claude",
    code,
    ...(prose(m.content) ? { detail: prose(m.content) } : {}),
  };
}

/** Codex's `model/rerouted` params; null: not usable. */
export function codexModelSwitch(x: any): ModelSwitch | null {
  const to = name(x?.toModel);
  if (!to) return null;
  const code = name(x?.reason);
  return {
    from: name(x?.fromModel),
    to,
    reason: said(CODEX_REASON[code]) || code || turnT()("server-harness.modelSwitch.codexRerouted"),
    session: false,
    engine: "codex",
    code,
  };
}

/** The trace step (kind tool, category native — every client shows it). */
export function modelSwitchItem(s: ModelSwitch): Partial<Item> {
  return {
    kind: "tool",
    category: "native",
    name: turnT()("server-harness.modelSwitch.name"),
    text:
      turnT()(s.session ? "server-harness.modelSwitch.textSession" : "server-harness.modelSwitch.textTurn", {
        reason: s.reason,
        to: s.to,
        from: s.from ? turnT()("server-harness.modelSwitch.from", { from: s.from }) : "",
      }) + (s.detail ? `\n${s.detail}` : ""),
    status: "complete",
    input: {
      from: s.from,
      to: s.to,
      reason: s.code,
      scope: s.session ? "session" : "turn",
      engine: s.engine,
    },
  };
}

/**
 * P6-17 / P6-23b: the language of the words a turn carries to its owner
 * (an error, a notice). The Runner runs in this process (D-02): the
 * session's language when given (ADR-159 §6), else the owner's setting,
 * else the system's (platform/language.ts `inSessionT`).
 */
export function turnT(sessionLang?: string | null): Translate {
  return inSessionT(sessionLang);
}

/**
 * P6-17: an engine refusing the model itself (Codex 0.157 on a ChatGPT
 * account: "The '<model>' model is not supported when using Codex with a
 * ChatGPT account."; the API's "The model `x` does not exist …" /
 * model_not_found). The turn's error then says the way out — the model
 * picker's native model list — ahead of the engine's own words; null:
 * not a model refusal (the error stays as it is).
 */
const UNSUPPORTED_MODEL =
  /\bmodel\b[^\n]{0,120}?\b(?:not supported|unsupported|does not exist|not found|not available)\b|\bunsupported model\b|\bmodel_not_found\b|\bunsupported_model\b/i;
export function unsupportedModelHint(raw: string, say?: Translate): string | null {
  if (!raw || !UNSUPPORTED_MODEL.test(raw)) return null;
  const t = say ?? turnT();
  const m = /'([^'\s]{1,100})' model|model [`'"]([^`'"\s]{1,100})[`'"]/i.exec(raw);
  const model = name(m?.[1] || m?.[2] || "");
  return model
    ? t("server-harness.model.unsupported", { model, raw })
    : t("server-harness.model.unsupportedUnnamed", { raw });
}
