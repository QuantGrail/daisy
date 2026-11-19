/**
 * P6-22 (ADR-159 §8): give the web UI's `t` a shipped pack in a test — the
 * `ui`, `common` and `client` areas (with their `-*` parts) over English, as
 * `GET /api/locales/:lang?areas=ui,common,client` answers. UI tests call
 * `uiLang("zh-CN")` at the top (their assertions are Chinese) and switch to
 * `uiLang("en")` inside a test that checks the English text (switching
 * back in `finally`).
 */
import { FALLBACK_LANG, translator, type Translate } from "../packages/contracts/src/i18n.ts";
import { shippedPacks } from "../packages/contracts/src/i18n-node.ts";
import { setUiPack } from "../packages/ui/src/i18n.ts";

const UI = /^(ui|common|client)(-[\w-]+)?\./;

/** One shipped language's UI messages, English underneath. */
export function uiMessages(lang: string): Record<string, string> {
  const packs = shippedPacks();
  return Object.fromEntries(Object.entries({ ...packs[FALLBACK_LANG], ...packs[lang] }).filter(([k]) => UI.test(k)));
}

/** Make the UI speak `lang` (a shipped pack). */
export function uiLang(lang: string): void {
  setUiPack(lang, uiMessages(lang));
}

/** A translator over every shipped area (contracts helpers called with an explicit `t`). */
export const packT = (lang: string): Translate => translator(shippedPacks(), lang);

/** Run `f` with the UI in `lang`, then back to `back`. */
export async function inUiLang<T>(lang: string, f: () => T | Promise<T>, back = "zh-CN"): Promise<T> {
  uiLang(lang);
  try {
    return await f();
  } finally {
    uiLang(back);
  }
}
