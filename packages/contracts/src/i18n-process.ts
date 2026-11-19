/**
 * P6-23b (ADR-159 §10): one process's language, for the code that has no
 * owner setting to read — the standalone commands (`daisy-relay`,
 * `daisy-mcp`) and the shared A2A client (packages/a2a-client), which
 * both Daisy and `daisy-mcp` bundle.
 *
 * Order: `--lang <tag>` / `--lang=<tag>` (the command's own flag) >
 * `DAISY_LANG` > the system locale (`LC_ALL`, `LC_MESSAGES`, `LANG`,
 * `LANGUAGE`; on macOS the account's preferred languages; then the
 * runtime's own, `Intl`) > English. The same order as Daisy's command line
 * without the owner setting (packages/daisy/src/platform/language.ts).
 *
 * The packs come from `shippedPacks()` (i18n-node.ts). The two bundles
 * (relay / a2a-mcp build.mjs) replace that module with their inlined
 * packs, so a bundle reads no locale file at run time.
 *
 * A host may hand its own translator (`setProcessTranslator`): Daisy's
 * server can make the shared client speak the owner's language.
 */
import { spawnSync } from "node:child_process";
import { FALLBACK_LANG, languagesOf, matchLang, translator, type Lang, type MessageKey, type Packs, type Translate } from "./i18n.ts";
import { shippedPacks } from "./i18n-node.ts";

export interface ProcessLocaleInputs {
  env: Record<string, string | undefined>;
  platform: string;
  /** Injected in tests; default `defaults read -g AppleLanguages` on macOS. */
  apple?: () => string[];
  /** Injected in tests; default the runtime's (`Intl`). */
  intl?: () => string | undefined;
}

let appleCache: string[] | undefined;
function appleLanguages(): string[] {
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

/** `DAISY_LANG`, then the system's language, among the available ones. */
export function envLanguage(i: ProcessLocaleInputs, available: readonly Lang[]): Lang | undefined {
  for (const name of ["DAISY_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) {
    const m = matchLang(i.env[name], available);
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

/**
 * `--lang <tag>` / `--lang=<tag>` taken out of `argv`: the tag (undefined
 * when absent) and the other arguments. `--lang` with nothing after it is
 * left for the command to refuse as it refuses any bad option.
 */
export function takeLangFlag(argv: readonly string[]): { lang?: string; rest: string[] } {
  const rest: string[] = [];
  let lang: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--lang=")) lang = a.slice(7);
    else if (a === "--lang" && i + 1 < argv.length) lang = argv[++i];
    else rest.push(a);
  }
  return lang === undefined ? { rest } : { lang, rest };
}

/** The language: the flag > `DAISY_LANG` > the system > English. */
export function processLanguage(flag: string | undefined, i: ProcessLocaleInputs, packs: Packs = shippedPacks()): Lang {
  const available = languagesOf(packs);
  return matchLang(flag, available) ?? envLanguage(i, available) ?? FALLBACK_LANG;
}

let current: Translate | (() => Translate) | undefined;
const now = (): Translate => {
  if (!current) current = translator(shippedPacks(), processLanguage(undefined, { env: process.env, platform: process.platform }));
  return typeof current === "function" && !("lang" in current) ? (current as () => Translate)() : (current as Translate);
};

/** Speak `lang` from now on (a command settles it once, from `--lang` and the environment). */
export function setProcessLanguage(lang: Lang): void {
  current = translator(shippedPacks(), lang);
}

/** A host's own translator, or a function giving the one to use now (Daisy: the owner's). */
export function setProcessTranslator(t: Translate | (() => Translate) | undefined): void {
  current = t;
}

/** This process's text by key. */
export const pt = ((key: string, params?: Record<string, unknown>) => now().dynamic(key, params)) as Translate;
Object.defineProperty(pt, "lang", { get: () => now().lang });
(pt as any).dynamic = (key: string, params?: Record<string, unknown>) => now().dynamic(key, params);
(pt as any).has = (key: string) => now().has(key);

/**
 * An error whose text is a message key (ADR-159 §3): `message` is the
 * text in this process's language; a host that answers in another
 * language (Daisy's local API) says `key` with `params` again in its
 * reader's (`localized: true` is what it looks for).
 */
export class KeyedError extends Error {
  readonly localized = true;
  constructor(
    readonly key: MessageKey,
    readonly params: Record<string, string | number> = {},
  ) {
    super(pt.dynamic(key, params));
  }
}
