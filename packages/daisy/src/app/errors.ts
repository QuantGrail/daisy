/**
 * P1-00: moved from app.ts, which re-exports it.
 * P6-23b (ADR-159 §3): `LocalizedError` lives here too (language.ts
 * re-exports it), so modules deep in the server can throw an error whose
 * text the error handler says in the request's language.
 */
import { FALLBACK_LANG, translator, type MessageKey, type Translate } from "../../../contracts/src/i18n.ts";
import { shippedPacks } from "../../../contracts/src/i18n-node.ts";

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    /** Stable machine-readable reason, sent as `code` next to `error`. */
    public code?: string,
  ) {
    super(message);
  }
}

/**
 * Params of a message: name → value (numbers printed as they are). A value
 * may itself be a message (`{ key, params }`): it is said first, in the
 * same language (a rule's reason inside "… Choose another one").
 */
export type MsgParams = Record<string, string | number | Msg>;

/**
 * A message not yet said: its key and params. What a check returns
 * instead of a sentence ("why it was refused"), so the caller can say it
 * in whichever language its reader speaks (`t.dynamic(m.key, m.params)`)
 * or throw it (`LocalizedError.of`).
 */
export interface Msg {
  key: MessageKey;
  params?: MsgParams;
}
export const msg = (key: MessageKey, params?: MsgParams): Msg => (params ? { key, params } : { key });

/** A key and its params said by `t`, nested messages first. */
export function sayMsg(t: Translate, key: string, params?: MsgParams): string {
  if (!params) return t.dynamic(key);
  const flat: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params))
    flat[k] = v && typeof v === "object" ? sayMsg(t, v.key, v.params) : v;
  return t.dynamic(key, flat);
}

/** The English text of a key (`message` of a localized error: for logs and code that reads it). */
export const englishText = (key: string, params?: MsgParams): string =>
  sayMsg(translator(shippedPacks(), FALLBACK_LANG), key, params);

/**
 * An error whose text is a message key: the error handler (app/http.ts)
 * says it — and `fixKey`, as `fix` — in the request's language. `message`
 * is the English text. `localized` marks it for code that cannot import
 * this class (any error with `localized: true`, a string `key` and
 * optional `params` / `fixKey` is said the same way).
 */
export class LocalizedError extends HttpError {
  readonly localized = true;
  constructor(
    statusCode: number,
    code: string,
    public key: MessageKey,
    public params: MsgParams = {},
    public fixKey?: MessageKey,
  ) {
    super(statusCode, englishText(key, params), code);
  }
  /** A `Msg` (what a check returned) as an error. */
  static of(statusCode: number, code: string, m: Msg, fixKey?: MessageKey): LocalizedError {
    return new LocalizedError(statusCode, code, m.key, m.params ?? {}, fixKey);
  }
}

/** Whether an error carries a message key (LocalizedError or a look-alike from a shared package). */
export function isLocalized(e: unknown): e is { key: string; params?: MsgParams; fixKey?: string; code?: unknown } {
  return !!e && typeof e === "object" && (e as any).localized === true && typeof (e as any).key === "string";
}
