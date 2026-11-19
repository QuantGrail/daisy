/**
 * P6-20 (ADR-159): reading the language packs from disk (Node only: the
 * server and the command line; the web UI gets its pack from the server,
 * `GET /api/locales/:lang`).
 *
 * Layout: `<root>/<lang>/<area>.json` — a flat JSON object whose keys all
 * start with `<area>.` — and `<root>/<lang>/prompts/<name>.md` for the
 * long model-facing texts (P6-24). The shipped root is
 * `packages/contracts/locales` (packed with the npm package); an owner
 * may drop a pack for another language into `<data dir>/locales/<lang>/`
 * — it adds that language, it never replaces a shipped one's text.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FALLBACK_LANG, LANG_TAG, languagesOf, matchLang, translator, type Lang, type Pack, type Packs } from "./i18n.ts";
import { setDefaultTranslate } from "./i18n-default.ts";
import { setPromptSource } from "./prompt-i18n.ts";

/** The packs that ship with Daisy. */
export const SHIPPED_LOCALES = fileURLToPath(new URL("../locales/", import.meta.url));
/** Where an owner's extra pack goes, under the data directory. */
export const dataDirLocales = (dataDir: string) => join(dataDir, "locales");
const AREA = /^[a-z][a-z0-9-]*$/;

export interface LoadedPacks {
  packs: Packs;
  /** What was wrong (a file that is not JSON, a key outside its area …), one line each. */
  problems: string[];
  /** Per language, the directory it came from. */
  from: Record<Lang, string>;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** One language directory → its merged pack. */
export function readPackDir(dir: string, problems: string[] = []): Record<string, string> {
  const pack: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const area = name.slice(0, -5);
    const file = join(dir, name);
    if (!AREA.test(area)) {
      problems.push(`${file}: the file name is not an area name (a-z, 0-9, -)`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      problems.push(`${file}: not valid JSON`);
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push(`${file}: not a JSON object`);
      continue;
    }
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!k.startsWith(area + ".")) problems.push(`${file}: key ${k} is outside its area (${area}.*)`);
      else if (typeof v !== "string") problems.push(`${file}: ${k} is not a string`);
      else pack[k] = v;
    }
  }
  return pack;
}

/**
 * Every language under the roots, the first root winning a language it
 * has (the shipped one first: a drop-in pack adds a language only).
 */
export function loadPacks(roots: readonly string[] = [SHIPPED_LOCALES]): LoadedPacks {
  const packs: Record<Lang, Pack> = {};
  const from: Record<Lang, string> = {};
  const problems: string[] = [];
  for (const root of roots) {
    if (!isDir(root)) continue;
    for (const lang of readdirSync(root).sort()) {
      const dir = join(root, lang);
      if (!isDir(dir) || packs[lang]) continue;
      if (!LANG_TAG.test(lang)) {
        problems.push(`${dir}: not a language tag (en, zh-CN, ja …)`);
        continue;
      }
      packs[lang] = Object.freeze(readPackDir(dir, problems));
      from[lang] = dir;
    }
  }
  return { packs: Object.freeze(packs), problems, from };
}

let shipped: LoadedPacks | undefined;
const withDataDir = new Map<string, { at: number; loaded: LoadedPacks }>();

/** The shipped packs (read once per process). */
export function shippedPacks(): Packs {
  return (shipped ??= loadPacks()).packs;
}

/**
 * The shipped packs plus the data directory's drop-in languages
 * (re-read at most every 5 seconds, so a pack dropped in shows up
 * without a restart).
 */
export function packsFor(dataDir: string | undefined): Packs {
  if (!dataDir || !existsSync(dataDirLocales(dataDir))) return shippedPacks();
  const kept = withDataDir.get(dataDir);
  if (kept && Date.now() - kept.at < 5000) return kept.loaded.packs;
  const loaded = loadPacks([SHIPPED_LOCALES, dataDirLocales(dataDir)]);
  withDataDir.set(dataDir, { at: Date.now(), loaded });
  return loaded.packs;
}

/**
 * A long model-facing text (P6-24): `<root>/<lang>/prompts/<name>.md`,
 * the fallback language's when that language has none; undefined when
 * neither has it. Read every time (they are small, and a session's
 * layers are built once per turn).
 */
export function promptText(
  name: string,
  lang: Lang,
  roots: readonly string[] = [SHIPPED_LOCALES],
): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`bad prompt name: ${name}`);
  for (const l of [lang, FALLBACK_LANG])
    for (const root of roots) {
      const file = join(root, l, "prompts", `${name}.md`);
      if (existsSync(file)) return readFileSync(file, "utf8");
    }
  return undefined;
}

/**
 * P6-22: the default translator of shared contracts helpers called without
 * one (i18n-default.ts) — the shipped packs in this process's language:
 * `DAISY_LANG`, `LC_ALL`, `LC_MESSAGES`, `LANG`, else English.
 */
setDefaultTranslate(() => {
  const packs = shippedPacks();
  const env = process.env;
  const langs = languagesOf(packs);
  const lang =
    [env.DAISY_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG].map((v) => matchLang(v, langs)).find(Boolean) ?? FALLBACK_LANG;
  return translator(packs, lang);
});

/**
 * P6-24: model-facing text speaks the shipped packs only (a drop-in pack
 * in the data directory adds a language for people; a session in such a
 * language gets the fallback's prompts). The long texts are read once.
 */
const promptCache = new Map<string, string | undefined>();
setPromptSource({
  packs: shippedPacks,
  text(name, lang) {
    const k = `${lang}/${name}`;
    if (!promptCache.has(k)) promptCache.set(k, promptText(name, lang));
    return promptCache.get(k);
  },
});
