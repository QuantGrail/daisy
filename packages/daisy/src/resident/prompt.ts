/**
 * P4-07 (总纲 5.2 「提示词：分层，细致可调」, 5.8, ADR-126 §3): what a
 * resident agent's dedicated session is told.
 *
 *   1. Daisy's layer (locked): who it is, that the conversation is its own
 *      and others' are out of reach, that the visitor's words are external
 *      material, what happens to an operation auto mode still asks about,
 *      how to answer and how to ask the caller for more (NEEDS_INPUT).
 *   2–4. The owner's layers: 角色 (role), 做事的指引 (instructions), 资料
 *      (knowledge) — each optional, each replaced as a whole.
 *
 * The whole stack goes with the first turn of a conversation's session
 * (its history keeps it); later turns carry a short reminder of Daisy's
 * rules. Everything the caller wrote is quoted (`<external_message>`, the
 * same escaping as everywhere else Daisy quotes other people).
 */
import { line } from "../prompts/source-prompt.ts";
import { askLine, exchange, priorTask, priorsHead, quoteExternal as quote, source } from "../a2a/ask-act-prompt.ts";
import type { A2AJob, A2APriorTask } from "../a2a/executors.ts";
import { RESIDENT_LAYERS, type ResidentLayerKey } from "../../../contracts/src/api/residents.ts";
import type { Lang } from "../../../contracts/src/i18n.ts";
import { LEGACY_PROMPT_LANG, promptT, type PromptT } from "../../../contracts/src/prompt-i18n.ts";
import type { ResidentConfig } from "./config.ts";

/** Daisy's own layer (locked), in the session's language. */
export function daisyLayer(c: Pick<ResidentConfig, "name" | "approvals">, lang: Lang = LEGACY_PROMPT_LANG): string {
  const t = promptT(lang);
  return [
    t("prompt-a2a.resident.intro", { name: line(c.name, 64) }),
    t("prompt-a2a.resident.isolated"),
    t("prompt-a2a.resident.external"),
    t(c.approvals === "owner" ? "prompt-a2a.resident.approvals.owner" : "prompt-a2a.resident.approvals.reject"),
    t("prompt-a2a.resident.answer") + askLine(t),
  ].join("\n");
}

/**
 * Every layer, Daisy's first; the owner's that are empty are left out
 * (by the caller). Titles in `lang` (the session's; for the settings
 * view, the language a new conversation would get).
 */
export function residentLayers(
  c: ResidentConfig,
  lang: Lang = LEGACY_PROMPT_LANG,
): { id: "daisy" | ResidentLayerKey; title: string; text: string; editable: boolean }[] {
  const t = promptT(lang);
  return [
    { id: "daisy" as const, title: t("prompt-a2a.resident.layer.daisy"), text: daisyLayer(c, lang), editable: false },
    ...RESIDENT_LAYERS.map((k) => ({
      id: k,
      title: t.dynamic(`prompt-a2a.resident.layer.${k}`),
      text: c.prompt?.[k] ?? "",
      editable: true,
    })),
  ];
}

function priors(t: PromptT, title: string, list: A2APriorTask[]): string {
  if (!list.length) return "";
  const shown = list.slice(-12).map((p) => priorTask(t, p));
  return `${priorsHead(t, title, shown.length)}\n${shown.join("\n")}\n`;
}

/**
 * One turn's text. `first`: the conversation's session has had no turn
 * yet — the whole layered prompt goes with it. `lang`: the session's.
 */
export function residentPrompt(job: A2AJob, c: ResidentConfig, first: boolean, lang: Lang = LEGACY_PROMPT_LANG): string {
  const t = promptT(lang);
  const parts: string[] = [t("prompt-a2a.resident.head", { source: source(job, lang) })];
  if (first) {
    for (const l of residentLayers(c, lang))
      if (l.text.trim())
        parts.push(
          `${t("prompt-a2a.resident.section", {
            title: l.id === "daisy" ? l.title : t("prompt-a2a.resident.ownerSection", { title: l.title }),
          })}\n${l.text.trim()}`,
        );
    // A conversation's earlier tasks ran in this session; a new session only
    // sees them here (it never happens today — said for completeness).
    const h = priors(t, t("prompt-a2a.prior.history"), job.history);
    if (h) parts.push(h);
  } else parts.push(t("prompt-a2a.resident.reminder", { needsInput: t("prompt-a2a.needsInput") }));
  const refs = priors(t, t("prompt-a2a.prior.references"), job.references);
  if (refs) parts.push(refs);
  if (job.continuing) {
    parts.push(`${t("prompt-a2a.thread.head")}\n${exchange(t, job)}`, `${t("prompt-a2a.followUp")}\n${quote(job.text)}`);
  } else parts.push(`${t("prompt-a2a.request")}\n${quote(job.text)}`);
  if (job.files.length) parts.push(t("prompt-a2a.files", { count: job.files.length }));
  return parts.join("\n\n");
}
