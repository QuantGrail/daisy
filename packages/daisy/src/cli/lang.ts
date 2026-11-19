/**
 * P6-20 (ADR-159): the language this `daisy` command speaks. `run()`
 * (main.ts) settles it once per command — `--lang` > `DAISY_LANG` > the
 * owner setting > the system locale > English (platform/language.ts) —
 * and every part of the command line says its text through `t`. API
 * calls send it as `Accept-Language`, so the server's messages come back
 * in the same language.
 */
import { translator, type Lang, type Translate } from "../../../contracts/src/i18n.ts";
import { packsFor, shippedPacks } from "../../../contracts/src/i18n-node.ts";
import { resolveLanguage, setProcessLanguage } from "../platform/language.ts";
import { setDefaultTranslate } from "../../../contracts/src/i18n-default.ts";
import { setProcessTranslator } from "../../../contracts/src/i18n-process.ts";

// Until `run()` settles it: this process's environment (a module used on its own — tests, scripts).
let current: Translate = translator(
  shippedPacks(),
  resolveLanguage({ env: process.env, platform: process.platform, useEnv: true, packs: shippedPacks() }).lang,
);

/** Speak `lang` from now on (with the data directory's drop-in packs). */
export function setCliLanguage(lang: Lang, dataDir?: string): void {
  current = translator(dataDir ? packsFor(dataDir) : shippedPacks(), lang);
  // P6-23b: the server modules a local command uses (autostart, update,
  // doctor's checks), contracts' helpers and the shared A2A client speak
  // the command's language too, not the owner setting's.
  setProcessLanguage(lang);
  setDefaultTranslate(() => current);
  setProcessTranslator(() => current);
}

/** The command line's text by key (the current language). */
export const t = ((key: string, params?: Record<string, unknown>) => current.dynamic(key, params)) as Translate;
Object.defineProperty(t, "lang", { get: () => current.lang });
(t as any).dynamic = (key: string, params?: Record<string, unknown>) => current.dynamic(key, params);
(t as any).has = (key: string) => current.has(key);
