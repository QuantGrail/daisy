/**
 * P6-20 (ADR-159): the language of the local API's answers, the owner's
 * language setting, and the web UI's language pack.
 *
 * A request's language: `Accept-Language` (the web UI and the command
 * line send the language they show) > the owner setting > the system
 * locale > English. Error answers keep their stable `code`; their `error`
 * (and `fix`) text is in that language when the error was raised with a
 * message key (`LocalizedError`).
 */
import type { FastifyInstance } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import {
  FALLBACK_LANG,
  languagesOf,
  matchLang,
  parseAcceptLanguage,
  translator,
  type Lang,
  type MessageKey,
  type Translate,
} from "../../../contracts/src/i18n.ts";
import { packsFor } from "../../../contracts/src/i18n-node.ts";
import { chooseLanguage, currentOwnerDataDir, languageView, resolveLanguage } from "../platform/language.ts";
import { LocalizedError } from "./errors.ts";
import { serve } from "./serve.ts";
import type { AppContext } from "./context.ts";

export { LocalizedError } from "./errors.ts";

/** The language a request is answered in. */
export function requestLanguage(
  req: { headers?: Record<string, unknown> } | undefined,
  dataDir: string | undefined = currentOwnerDataDir(),
): Lang {
  const packs = packsFor(dataDir);
  const header = req?.headers?.["accept-language"];
  const asked = parseAcceptLanguage(typeof header === "string" ? header : undefined, languagesOf(packs));
  if (asked) return asked;
  return resolveLanguage({ env: process.env, platform: process.platform, dataDir, packs }).lang;
}

/** A request's translator. */
export const requestT = (req: any, dataDir: string | undefined = currentOwnerDataDir()): Translate =>
  translator(packsFor(dataDir), requestLanguage(req, dataDir));

/** What GET / PUT /api/settings/language answer (platform/language.ts). */
export { languageView } from "../platform/language.ts";

export function registerLanguageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const dataDir = ctx.opts.dataDir;
  const S = api.settings;
  serve(app, S.languageShow, async () => languageView(dataDir));
  serve(app, S.languageSet, async (req) => {
    const b = S.languageSet.body.parse(req.body);
    if (!chooseLanguage(dataDir, b.language))
      throw new LocalizedError(400, "language_unknown", "api.error.languageUnknown", { lang: b.language! });
    return languageView(dataDir);
  });
  serve(app, api.system.locales, async (req: any) => {
    const packs = packsFor(dataDir);
    // A tag as a browser writes it reaches its pack (`zh-Hans-CN` → `zh-CN`); nothing close → 404.
    const lang = matchLang(String(req.params.lang), languagesOf(packs));
    if (!lang) throw new LocalizedError(404, "language_unknown", "api.error.languageUnknown", { lang: String(req.params.lang).slice(0, 40) });
    const q = api.system.locales.query.parse(req.query ?? {});
    const areas = q.areas ? q.areas.split(",").map((a) => a.trim()).filter(Boolean) : null;
    // `ui` takes the `ui` area and its parts (`ui-chat`, `ui-settings` …).
    const wanted = (area: string) => !areas || areas.some((a) => area === a || area.startsWith(a + "-"));
    const pick = (l: Lang) => Object.fromEntries(Object.entries(packs[l] ?? {}).filter(([k]) => wanted(k.split(".")[0]!)));
    // The fallback's text under the language's own: a missing key reads in English, never as its key.
    return { lang, fallback: FALLBACK_LANG, messages: { ...pick(FALLBACK_LANG), ...pick(lang) } };
  });
}
