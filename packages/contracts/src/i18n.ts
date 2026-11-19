/**
 * P6-20 (ADR-159, D-44 ①): language packs — the one mechanism every
 * part of Daisy (server, command line, web UI) shows text through.
 *
 * - The text itself lives in per-language resource files, never in
 *   source: `packages/contracts/locales/<lang>/<area>.json`, flat
 *   `{ "<area>.<…>": "text with {named} params" }`. Source code names
 *   message keys only (`t("cli.status.running", { pid })`).
 * - The languages are the pack directories present (no list in code):
 *   adding a language is adding a directory. `en` is the reference pack
 *   (the typed keys are generated from it, `keys.gen.ts`) and the
 *   fallback for a key another pack lacks. Both shipped packs are 100%
 *   complete (tests/i18n.test.ts).
 * - Interpolation: `{name}`, and (P6-28) a plural choice in the ICU
 *   form `{count, plural, one {# step} other {# steps}}` — the branch is
 *   picked by the language's plural rules (`Intl.PluralRules`; `=0`
 *   picks an exact number), `#` is the number. A language without
 *   plural forms just writes `{count} 步`. No other formatting rules — a
 *   number is printed as it is. `{product}` and `{command}` are always
 *   filled (names.ts), so packs never spell the product's name.
 *
 * This file is browser-safe (the web UI imports it); reading packs from
 * disk is `i18n-node.ts`.
 */
import { COMMAND_NAME, PRODUCT_NAME } from "./names.ts";
import type { MessageKey, MessageParams } from "./i18n-keys.gen.ts";
export type { MessageKey, MessageParams } from "./i18n-keys.gen.ts";

/** A language: a pack directory's name, a BCP 47 tag (`en`, `zh-CN`). */
export type Lang = string;
/** The reference pack and the fallback for a missing key (ADR-159 §3). */
export const FALLBACK_LANG: Lang = "en";
/** One language's messages, every area merged: key → text. */
export type Pack = Readonly<Record<string, string>>;
export type Packs = Readonly<Record<Lang, Pack>>;

/** Params every message gets without asking (the product's names). */
export const BUILTIN_PARAMS = { product: PRODUCT_NAME, command: COMMAND_NAME } as const;
const PARAM = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** A language tag as a pack directory may be named. */
export const LANG_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The start of a plural choice: `{name, plural,`. */
const PLURAL_HEAD = /\{([A-Za-z_][A-Za-z0-9_]*)\s*,\s*plural\s*,/g;

/** The `{name}`s a text uses (a plural choice's number included), sorted, each once. */
export function paramsOf(text: string): string[] {
  return [
    ...new Set([...[...text.matchAll(PARAM)].map((m) => m[1]!), ...[...text.matchAll(PLURAL_HEAD)].map((m) => m[1]!)]),
  ].sort();
}

const pluralRules = new Map<string, Intl.PluralRules | null>();
/** The plural category of `n` in `lang` (`other` when the runtime does not know the language). */
function pluralCategory(n: number, lang: Lang): string {
  if (!pluralRules.has(lang))
    try {
      pluralRules.set(lang, new Intl.PluralRules(lang));
    } catch {
      pluralRules.set(lang, null);
    }
  return pluralRules.get(lang)?.select(n) ?? "other";
}

/**
 * A plural choice at `start` (`{n, plural, one {…} other {…}}`): its
 * branches and where it ends, or undefined when it is not well formed
 * (then it stays as written).
 */
function parsePlural(text: string, bodyAt: number): { end: number; branches: Map<string, string> } | undefined {
  const branches = new Map<string, string>();
  let i = bodyAt;
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] === "}") return branches.has("other") ? { end: i + 1, branches } : undefined;
    const sel = /^(=\d+|zero|one|two|few|many|other)\s*\{/.exec(text.slice(i));
    if (!sel) return undefined;
    let depth = 1,
      j = i + sel[0].length;
    const from = j;
    for (; j < text.length && depth; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
    }
    if (depth) return undefined;
    branches.set(sel[1]!, text.slice(from, j - 1));
    i = j;
  }
}

/** Every plural choice → its branch for the number given (`#` = the number). */
function choosePlurals(text: string, params: Record<string, unknown>, lang: Lang): string {
  if (!text.includes("plural")) return text;
  let out = "",
    at = 0;
  for (const m of text.matchAll(PLURAL_HEAD)) {
    if (m.index! < at) continue;
    const p = parsePlural(text, m.index! + m[0].length);
    const v = params[m[1]!];
    if (!p || v === undefined || v === null) continue;
    const n = Number(v);
    const branch =
      (Number.isFinite(n) ? p.branches.get(`=${n}`) ?? p.branches.get(pluralCategory(n, lang)) : undefined) ?? p.branches.get("other")!;
    out += text.slice(at, m.index!) + branch.replace(/#/g, String(v));
    at = p.end;
  }
  return out + text.slice(at);
}

/**
 * `{name}` → its value; a plural choice → its branch for the number in
 * `lang`'s rules (default English); an unknown `{name}` stays as written.
 */
export function interpolate(text: string, params: Record<string, unknown> = {}, lang: Lang = FALLBACK_LANG): string {
  return choosePlurals(text, params, lang).replace(PARAM, (all, name: string) => {
    const v = name in params ? params[name] : (BUILTIN_PARAMS as Record<string, unknown>)[name];
    return v === undefined || v === null ? all : String(v);
  });
}

/**
 * A locale as the system or a client writes it (`zh_CN.UTF-8`,
 * `zh-Hans-CN`, `en-US`, `en`) → the best of the available languages,
 * or undefined (`C`, `POSIX`, empty, or nothing close). Exact tag first,
 * then the same primary language (`zh-TW` → `zh-CN` while that is the
 * only Chinese pack; `en-GB` → `en`).
 */
export function matchLang(tag: string | null | undefined, available: readonly Lang[]): Lang | undefined {
  if (!tag) return undefined;
  const t = tag.trim().replace(/[.@].*$/, "").replace(/_/g, "-");
  if (!t || /^(c|posix)$/i.test(t)) return undefined;
  const lower = t.toLowerCase();
  const exact = available.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  const primary = lower.split("-")[0]!;
  // `zh-Hans-CN` / `zh-CN` both reach `zh-CN`; prefer a pack whose region matches.
  const same = available.filter((l) => l.toLowerCase().split("-")[0] === primary);
  if (!same.length) return undefined;
  const parts = lower.split("-").slice(1);
  return same.find((l) => parts.some((p) => l.toLowerCase().split("-").slice(1).includes(p))) ?? same[0];
}

/** `Accept-Language` → the best available language by quality, or undefined. */
export function parseAcceptLanguage(header: string | null | undefined, available: readonly Lang[]): Lang | undefined {
  if (!header) return undefined;
  const ranked = header
    .split(",")
    .map((part, i) => {
      const [tag, ...rest] = part.trim().split(";");
      const q = rest.map((r) => r.trim()).find((r) => r.startsWith("q="));
      return { tag: tag!.trim(), q: q ? Number(q.slice(2)) : 1, i };
    })
    .filter((x) => x.tag && x.tag !== "*" && Number.isFinite(x.q) && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const r of ranked) {
    const m = matchLang(r.tag, available);
    if (m) return m;
  }
  return undefined;
}

type Args<K extends MessageKey> = [MessageParams[K]] extends [never]
  ? [params?: Record<string, never>]
  : [params: { [P in MessageParams[K]]: string | number }];

/** Text by key in one language (with the fallback pack behind it). */
export interface Translate {
  <K extends MessageKey>(key: K, ...params: Args<K>): string;
  /** The language it speaks. */
  readonly lang: Lang;
  /** A key built at run time (`cli.local.${name}.summary`): untyped. */
  dynamic(key: string, params?: Record<string, unknown>): string;
  /** Whether the key exists in this language or the fallback. */
  has(key: string): boolean;
}

/**
 * The text for `key` in `lang`: that pack, else the fallback pack, else
 * the key itself (never throws — a missing key is a test failure, not a
 * crash in front of the owner).
 */
export function lookup(packs: Packs, lang: Lang, key: string): string | undefined {
  return packs[lang]?.[key] ?? packs[FALLBACK_LANG]?.[key];
}

export function translator(packs: Packs, lang: Lang): Translate {
  const dynamic = (key: string, params?: Record<string, unknown>) => {
    const own = packs[lang]?.[key];
    // A text from the fallback pack takes the fallback's plural rules.
    return interpolate(own ?? packs[FALLBACK_LANG]?.[key] ?? key, params, own !== undefined ? lang : FALLBACK_LANG);
  };
  const t = ((key: string, params?: Record<string, unknown>) => dynamic(key, params)) as Translate;
  Object.defineProperty(t, "lang", { value: lang });
  (t as any).dynamic = dynamic;
  (t as any).has = (key: string) => lookup(packs, lang, key) !== undefined;
  return t;
}

/** The languages present, the fallback first, then by tag. */
export const languagesOf = (packs: Packs): Lang[] =>
  Object.keys(packs).sort((a, b) => (a === FALLBACK_LANG ? -1 : b === FALLBACK_LANG ? 1 : a.localeCompare(b)));

/** A language's own name (`common.language.name` in its pack). */
export const languageName = (packs: Packs, lang: Lang): string =>
  packs[lang]?.["common.language.name"] ?? lang;
