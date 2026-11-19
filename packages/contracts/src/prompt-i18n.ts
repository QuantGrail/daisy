/**
 * P6-24 (ADR-159 §6, D-44 ①): the language of what Daisy writes for a
 * model — system-layer text, tool descriptions and results, wake heads,
 * notices — and of the few readers that recognise such text later.
 *
 * - A session speaks one language for its whole life: the owner's
 *   language when it was created (`Session.lang`). A session created
 *   before P6-24 has none: its prompts were Chinese, so it stays Chinese
 *   (`LEGACY_PROMPT_LANG`) — a running conversation never gets the same
 *   rule in a second language.
 * - The texts live in the language packs: short ones as keys of the
 *   `prompt*` areas (`prompt-guide.json` …), long ones as
 *   `locales/<lang>/prompts/<name>.md`. Never in source.
 * - Browser-safe (the web UI imports contracts): the packs come from a
 *   source the Node side registers (`i18n-node.ts` does on import); this
 *   file never touches the disk.
 * - Markers Daisy stores and later matches (redelivery heads, the ask
 *   reply marker …) are written in the session's language and recognised
 *   in every language (`promptForms`) and in their older spellings.
 */
import { FALLBACK_LANG, interpolate, languagesOf, translator, type Lang, type Packs, type Translate } from "./i18n.ts";

/** What a session that recorded no language speaks (one created before P6-24: Chinese). */
export const LEGACY_PROMPT_LANG: Lang = "zh-CN";

/** The language a session's prompts are written in. */
export function sessionLang(s?: { lang?: string | null } | null): Lang {
  return (s && typeof s.lang === "string" && s.lang) || LEGACY_PROMPT_LANG;
}

/** Where the packs and the long texts come from (registered by the Node side). */
export interface PromptSource {
  packs(): Packs;
  /** `prompts/<name>.md` of `lang` (the fallback language's when it has none). */
  text(name: string, lang: Lang): string | undefined;
}
let source: PromptSource | undefined;
/** Registered by `i18n-node.ts` when it is loaded (and by tests). */
export function setPromptSource(s: PromptSource | undefined): void {
  source = s;
}
const noPacks: Packs = Object.freeze({});
const packsNow = (): Packs => source?.packs() ?? noPacks;

/** Text for a model in one language. */
export interface PromptT extends Translate {
  /**
   * A long text (`prompts/<name>.md`), its `{params}` filled; the file's
   * last newline is not part of it. Unknown name: the name in brackets
   * (a test failure, never a crash).
   */
  long(name: string, params?: Record<string, unknown>): string;
}

/** The translator for a language's model-facing text. */
export function promptT(lang: Lang): PromptT {
  const t = translator(packsNow(), lang) as PromptT;
  (t as any).long = (name: string, params?: Record<string, unknown>) => {
    const raw = source?.text(name, lang);
    return raw === undefined ? `[${name}]` : interpolate(raw.replace(/\r?\n$/, ""), params, lang);
  };
  return t;
}

/** A session's translator (its own language, ADR-159 §6). */
export const sessionT = (s?: { lang?: string | null } | null): PromptT => promptT(sessionLang(s));

/** The languages there are packs for (the fallback first). */
export const promptLangs = (): Lang[] => {
  const l = languagesOf(packsNow());
  return l.length ? l : [FALLBACK_LANG, LEGACY_PROMPT_LANG];
};

/**
 * Every language's text of `key` (params filled as given), each once —
 * what a reader of a stored marker accepts besides its older spellings.
 */
export function promptForms(key: string, params?: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const lang of promptLangs()) {
    const t = translator(packsNow(), lang);
    if (t.has(key)) out.add(t.dynamic(key, params));
  }
  return [...out];
}
