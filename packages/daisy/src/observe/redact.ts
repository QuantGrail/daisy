/**
 * P1-11 (3.7 安全基线, S-1): no credential, token, PIN, passcode, grant or
 * API key in a log line, an error message or the audit. Every log line
 * (observe/log.ts), every error answer (app/http.ts) and every audit row
 * (store.audit) passes through `redact`.
 *
 * Two layers:
 * 1. Exact values: every secret Daisy makes or is handed registers itself
 *    here when it is made or first read (the command-line credential, web
 *    sessions, one-time codes, AI working credentials, PIN grants, a
 *    harness's API key, a harness login's pasted code). Any occurrence is
 *    replaced, whatever the text around it.
 * 2. Shapes: what a secret of a known kind looks like, for those never
 *    registered (a key in a harness's error output, a header echoed by a
 *    library): `Bearer …`, JWTs, `sk-…` API keys, Daisy's own `dcli_` /
 *    `dweb_` / `ddev_` prefixes, common vendor tokens, `key=value` / `"key": "value"`
 *    where the key names a secret, URL userinfo and `#code=` / `?code=` / `#pair=`.
 *
 * Over-masking is preferred to a leak; nothing here ever throws.
 */
// P6-23b: one fixed, language-neutral mark (logs are English; an answer may carry it too).
export const MASK = "[redacted]";

/** Shorter values are not registered (they would mask ordinary words and numbers). */
const MIN_SECRET = 8;
/** Most recent secrets kept (a web session lives 30 days; the shapes cover the rest). */
const MAX_SECRETS = 4096;
const secrets = new Map<string, true>();
let sorted: string[] | null = null;

/** Remember a secret value: from now on it never appears in a log line, error or audit row. */
export function registerSecret(value: unknown): void {
  if (typeof value !== "string") return;
  const v = value.trim();
  if (v.length < MIN_SECRET) return;
  if (secrets.has(v)) secrets.delete(v);
  secrets.set(v, true);
  if (secrets.size > MAX_SECRETS) secrets.delete(secrets.keys().next().value!);
  sorted = null;
}
/** Every string leaf of a JSON-like value (a harness's secret settings). */
export function registerSecrets(value: unknown): void {
  if (typeof value === "string") return registerSecret(value);
  if (Array.isArray(value)) for (const v of value) registerSecrets(v);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) registerSecrets(v);
}
/** Tests: forget every registered value. */
export function resetSecrets(): void {
  secrets.clear();
  sorted = null;
}

/** Key names whose value is a secret (`key=value`, `"key": "value"`, `key: value`). */
const SECRET_KEY =
  "(?:[A-Za-z0-9_.-]*?(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|passphrase|credential|authorization|private[_-]?key|session[_-]?key)|pin|old[_-]?pin|new[_-]?pin|grant|pin[_-]?grant|daisy-pin-grant|cookie|set-cookie)";
const SHAPES: [RegExp, string | ((...m: string[]) => string)][] = [
  // Authorization schemes.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, (_m, s) => `${s} ${MASK}`],
  // JWT / JWS (header.payload.signature; an unsigned one too).
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, MASK],
  // Daisy's own credentials.
  // P5-03: a paired device's credential (`ddev_`).
  [/\bd(?:cli|web|dev)_[A-Za-z0-9_-]{8,}/g, MASK],
  // API keys: Anthropic / OpenAI style, and other common vendors.
  [/\bsk-[A-Za-z0-9_-]{12,}/g, MASK],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK],
  // URL userinfo: scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, (_m, pre) => `${pre}${MASK}@`],
  // One-time codes and OAuth codes in a link.
  // P5-03: a pairing code in its link (`#pair=`).
  [/([#?&](?:code|pair|token|access_token|id_token|key|grant)=)[^&\s#"']+/gi, (_m, pre) => `${pre}${MASK}`],
  // "key": "value"  /  'key': 'value'
  [
    new RegExp(`(["'])(${SECRET_KEY})\\1(\\s*:\\s*)(["'])(?:\\\\.|(?!\\4).)*\\4`, "gi"),
    (_m, q, k, sep, q2) => `${q}${k}${q}${sep}${q2}${MASK}${q2}`,
  ],
  // key = 'value with spaces'  (unquoted key, quoted value)
  [
    new RegExp(`(^|[^A-Za-z0-9_.-])(${SECRET_KEY})(\\s*[=:]\\s*)(["'])(?:\\\\.|(?!\\4).)*\\4`, "gim"),
    (_m, pre, k, sep, q) => `${pre}${k}${sep}${q}${MASK}${q}`,
  ],
  // key=value  /  key: value  (unquoted; headers, env, query strings)
  [
    new RegExp(`(^|[^A-Za-z0-9_.-])(${SECRET_KEY})(\\s*[=:]\\s*)(?!${MASK.replace(/[[\]]/g, "\\$&")}|(?:true|false|null|undefined)\\b)([^\\s"',;&}\\]]+)`, "gim"),
    (_m, pre, k, sep) => `${pre}${k}${sep}${MASK}`,
  ],
];

/** `text` with every secret replaced by MASK. */
export function redact(text: string): string {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  try {
    if (secrets.size) {
      sorted ??= [...secrets.keys()].sort((a, b) => b.length - a.length);
      for (const s of sorted) if (out.includes(s)) out = out.split(s).join(MASK);
    }
    for (const [re, to] of SHAPES) out = out.replace(re, to as any);
  } catch {
    return MASK;
  }
  return out;
}
