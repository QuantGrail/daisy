/**
 * P6-20 (ADR-159): the web UI's language. The text is the server's
 * language pack (`GET /api/locales/:lang`, the `ui` and `common` areas),
 * so the UI never carries a language of its own and a pack the owner
 * dropped into the data directory works here too. Which language: the
 * owner's setting (the server's `health.language`); the browser's language
 * only as a hint before the server has said.
 *
 * Components say text through `useT()` (re-renders on a switch) or `t`
 * outside React. Until a pack is loaded `t` answers the key itself — the
 * app waits for `loadUiLanguage` before its first frame, and `Settings`
 * loads it for an embedding host that did not.
 */
import { useSyncExternalStore } from "react";
import { DaisyClient, setClientTranslator } from "@daisy-ai/client";
import { FALLBACK_LANG, translator, type Lang, type Translate } from "@daisy-ai/contracts";

/** The areas of a pack the UI uses (`client`: the client library's own messages — timeouts, connection lost). */
export const UI_AREAS = ["ui", "common", "client"] as const;

let current: { t: Translate; loaded: boolean } = { t: translator({}, FALLBACK_LANG), loaded: false };
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** Speak `lang` with these messages (already merged over the fallback by the server). */
export function setUiPack(lang: Lang, messages: Record<string, string>): void {
  current = { t: translator({ [lang]: messages }, lang), loaded: true };
  DaisyClient.language = lang;
  // The client library's own errors (timeout, offline, …) speak the UI's language too.
  setClientTranslator(current.t.dynamic);
  try {
    if (typeof document !== "undefined") document.documentElement.lang = lang;
  } catch {}
  for (const f of listeners) f();
}

/** The UI's text by key (outside React; inside, `useT()`). */
export const t = ((key: string, params?: Record<string, unknown>) => current.t.dynamic(key, params)) as Translate;
Object.defineProperty(t, "lang", { get: () => current.t.lang });
(t as any).dynamic = (key: string, params?: Record<string, unknown>) => current.t.dynamic(key, params);
(t as any).has = (key: string) => current.t.has(key);

/** The translator, re-rendering the component when the language changes. */
export function useT(): Translate {
  return useSyncExternalStore(subscribe, () => current.t, () => current.t);
}

export const uiLanguageLoaded = () => current.loaded;

/** The browser's preferred language tags (a hint only). */
export function browserLanguages(): string[] {
  try {
    const n: any = typeof navigator !== "undefined" ? navigator : undefined;
    return [...(n?.languages ?? []), n?.language].filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/**
 * Load the pack for `preferred` (the owner's language, from health or the
 * language settings), else the browser's, else English. Never throws: an
 * older server without packs leaves the UI as it was.
 */
export async function loadUiLanguage(client: DaisyClient, preferred?: string | null): Promise<Lang | null> {
  const tried = new Set<string>();
  for (const want of [preferred, ...browserLanguages(), FALLBACK_LANG]) {
    // The server matches a tag to its packs (`zh-Hans-CN` → `zh-CN`, `en-GB` → `en`).
    if (!want || tried.has(want)) continue;
    tried.add(want);
    try {
      const r = await client.locales(want, [...UI_AREAS]);
      setUiPack(r.lang, r.messages);
      return r.lang;
    } catch {}
  }
  return null;
}

/** Settings → Language's choices: "follow the system" (`null`) first, then each pack by its own name. */
export function languageChoices(v: { available: { lang: string; name: string }[] }): { value: string | null; label: string }[] {
  return [{ value: null, label: "" }, ...v.available.map((a) => ({ value: a.lang, label: a.name }))];
}
