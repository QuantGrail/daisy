/**
 * P6-20 (ADR-159 §2, D-44 ①): which language Daisy speaks to its owner.
 *
 * One owner setting, `language` in the data directory's `config.json`
 * (the owner's settings for this Daisy, ADR-102; the command line reads
 * it without Daisy running). Unset = follow the system. Resolution, first
 * that names an available language wins:
 *
 *   command line: `--lang <tag>` > `DAISY_LANG` > the owner setting > the system locale > English
 *   local API:    `Accept-Language` > the owner setting > the system locale > English
 *   web UI:       the owner setting (the browser's language only before it knows it)
 *
 * The system locale: `DAISY_LANG` (for the server: a Daisy started with
 * it), `LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE` (POSIX
 * order; `C` / `POSIX` say nothing), then on macOS the account's
 * preferred languages (`defaults read -g AppleLanguages`: a Daisy started
 * by launchd has no `LANG`), then the runtime's own locale (`Intl`:
 * Windows' user locale). Nothing Chinese → English: a public release's
 * default for a reader we know nothing about.
 */
import { spawnSync } from "node:child_process";
import {
  FALLBACK_LANG,
  languageName,
  languagesOf,
  matchLang,
  translator,
  type Lang,
  type MessageKey,
  type Packs,
  type Translate,
} from "../../../contracts/src/i18n.ts";
import { packsFor } from "../../../contracts/src/i18n-node.ts";
import { readConfigSection, writeConfigSection } from "../access/config.ts";

export type LanguageSource = "flag" | "env" | "setting" | "system" | "default";
export interface ResolvedLanguage {
  lang: Lang;
  source: LanguageSource;
}

/** The config.json section. */
export const LANGUAGE_KEY = "language";

let appleCache: string[] | undefined;
/** macOS: the account's preferred languages, most preferred first (cached). */
export function appleLanguages(): string[] {
  if (appleCache) return appleCache;
  appleCache = [];
  try {
    const r = spawnSync("defaults", ["read", "-g", "AppleLanguages"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status === 0) appleCache = [...r.stdout.matchAll(/"?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)"?\s*,?\s*$/gm)].map((m) => m[1]!);
  } catch {}
  return appleCache;
}

export interface SystemLocaleInputs {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform | string;
  /** Injected in tests; default `appleLanguages()`. */
  apple?: () => string[];
  /** Injected in tests; default the runtime's (`Intl`). */
  intl?: () => string | undefined;
}

/** The system's language among the available ones, or undefined. */
export function systemLanguage(i: SystemLocaleInputs, available: readonly Lang[]): Lang | undefined {
  // DAISY_LANG is this process's own word for the system's (it ranks above
  // the owner setting only on the command line, `useEnv`).
  for (const name of ["DAISY_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) {
    const v = i.env[name];
    if (!v) continue;
    // A set variable decides (POSIX): `C` / `POSIX` means "no preference" — go on looking.
    const m = matchLang(v, available);
    if (m) return m;
  }
  for (const v of (i.env.LANGUAGE ?? "").split(":")) {
    const m = matchLang(v, available);
    if (m) return m;
  }
  if (i.platform === "darwin")
    for (const v of (i.apple ?? appleLanguages)()) {
      const m = matchLang(v, available);
      if (m) return m;
    }
  let intl: string | undefined;
  try {
    intl = (i.intl ?? (() => Intl.DateTimeFormat().resolvedOptions().locale))();
  } catch {}
  return matchLang(intl, available);
}

/** The owner's setting, when it names an available language. */
export function ownerLanguage(dataDir: string, available: readonly Lang[]): Lang | undefined {
  const v = readConfigSection(dataDir, LANGUAGE_KEY);
  return typeof v === "string" ? matchLang(v, available) : undefined;
}

/** Set (a language) or clear (`null`: follow the system) the owner's setting. */
export function setOwnerLanguage(dataDir: string, lang: Lang | null): void {
  writeConfigSection(dataDir, LANGUAGE_KEY, lang ?? undefined);
}

/** What GET / PUT /api/settings/language answer (and `daisy language` while Daisy is not running). */
export function languageView(dataDir: string) {
  const packs = packsFor(dataDir);
  const available = languagesOf(packs);
  const setting = ownerLanguage(dataDir, available) ?? null;
  const system = systemLanguage({ env: process.env, platform: process.platform }, available) ?? null;
  return {
    setting,
    effective: setting ?? system ?? FALLBACK_LANG,
    system,
    available: available.map((lang) => ({ lang, name: languageName(packs, lang) })),
  };
}

/**
 * Set the owner's language (`null`: follow the system) when it names an
 * available pack — the tag as the pack spells it (`zh-cn` → `zh-CN`).
 * Returns false (nothing written) for a language there is no pack of.
 * The local API's PUT and `daisy language set` without a running Daisy
 * (P6-28) both come here.
 */
export function chooseLanguage(dataDir: string, language: string | null): boolean {
  if (language === null) {
    setOwnerLanguage(dataDir, null);
    return true;
  }
  const m = matchLang(language, languagesOf(packsFor(dataDir)));
  if (!m || m.toLowerCase() !== language.toLowerCase()) return false;
  setOwnerLanguage(dataDir, m);
  return true;
}

export interface ResolveInputs extends SystemLocaleInputs {
  dataDir?: string;
  /** `--lang` (the command line) or `Accept-Language`'s choice (the local API). */
  explicit?: Lang;
  /** `DAISY_LANG` counts (the command line; the server ignores its own env here). */
  useEnv?: boolean;
  packs?: Packs;
}

/** The language to speak, and what decided it. */
export function resolveLanguage(i: ResolveInputs): ResolvedLanguage {
  const available = languagesOf(i.packs ?? packsFor(i.dataDir));
  if (i.explicit) {
    const m = matchLang(i.explicit, available);
    if (m) return { lang: m, source: "flag" };
  }
  if (i.useEnv) {
    const m = matchLang(i.env.DAISY_LANG, available);
    if (m) return { lang: m, source: "env" };
  }
  if (i.dataDir) {
    const m = ownerLanguage(i.dataDir, available);
    if (m) return { lang: m, source: "setting" };
  }
  const sys = systemLanguage(i, available);
  if (sys) return { lang: sys, source: "system" };
  return { lang: FALLBACK_LANG, source: "default" };
}

/*
 * P6-23b (ADR-159 §11 ②): the server's words to its owner outside a
 * request — a notice written into a session, a card, a status text, a
 * start problem. They are said in the owner's language: the setting >
 * the system locale (this process's `DAISY_LANG` counts there) > English.
 * Text answered to a request uses `requestT` (app/language.ts) instead.
 */
let ownerDataDir: string | undefined;
let processLang: Lang | undefined;
let ownerCache: { dataDir: string | undefined; env: string; at: number; t: Translate } | undefined;

/** The data directory whose owner setting `ownerT()` reads (the app sets it at start). */
export function setOwnerDataDir(dataDir: string | undefined): void {
  ownerDataDir = dataDir;
  ownerCache = undefined;
}

/** The data directory `setOwnerDataDir` named (undefined before the app starts). */
export const currentOwnerDataDir = (): string | undefined => ownerDataDir;

/**
 * A process that speaks one chosen language — the command line after
 * `--lang` / `DAISY_LANG` settled it — says the shared modules' words
 * (autostart, update, start settings) in that language too.
 */
export function setProcessLanguage(lang: Lang | undefined): void {
  processLang = lang;
  ownerCache = undefined;
}

/**
 * The owner's translator (re-resolved at most once a second, so a changed
 * setting shows up without a restart).
 */
export function ownerT(dataDir: string | undefined = ownerDataDir): Translate {
  const now = Date.now();
  const env = ["DAISY_LANG", "LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"].map((n) => process.env[n] ?? "").join("|");
  if (ownerCache && ownerCache.dataDir === dataDir && ownerCache.env === env && now - ownerCache.at < 1000) return ownerCache.t;
  const packs = packsFor(dataDir);
  const lang = resolveLanguage({ env: process.env, platform: process.platform, dataDir, packs, explicit: processLang }).lang;
  const t = translator(packs, lang);
  ownerCache = { dataDir, env, at: now, t };
  return t;
}

/**
 * A key's text in every language present (each once): what a reader of
 * stored text matches, so text written in any language is recognised
 * (ADR-159 §6, §11 ⑥). Param-free keys only.
 */
export function textsInEveryLanguage(key: MessageKey): string[] {
  const packs = packsFor(ownerDataDir);
  return [...new Set(Object.keys(packs).map((l) => translator(packs, l).dynamic(key)))];
}

/**
 * The words the server writes into one session for its owner (a notice,
 * a wake's tail, a stage): the session's language (`Session.lang`, P6-24)
 * when it names an available pack, else the owner's (`ownerT`) — a session
 * from before P6-24 has none. Model-facing prompts use contracts'
 * `sessionT` instead (a session without a language there is Chinese).
 * A bare language tag is accepted too (the Runner's `turnT`).
 */
export function inSessionT(
  s?: { lang?: string | null } | string | null,
  dataDir: string | undefined = ownerDataDir,
): Translate {
  const lang = typeof s === "string" ? s : s?.lang;
  if (lang) {
    const packs = packsFor(dataDir);
    const m = matchLang(lang, languagesOf(packs));
    if (m) return translator(packs, m);
  }
  return ownerT(dataDir);
}
