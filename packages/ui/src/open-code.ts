/**
 * P1-03 (5.12) / P4N-5: the one-time passcode of a `daisy open` link, as
 * plain functions (testable without React Native). The link carries it
 * after `#code=` — read on a fresh load and on a hash change alike (a new
 * link opened in a tab that already shows the page only changes the hash),
 * then cleared from the address bar. The code itself is never logged.
 */
import { t } from "./i18n";

/** The passcode in a URL fragment (`#code=…`); null: none there. */
export function codeFromHash(hash: string | null | undefined): string | null {
  const m = /(?:^#|&)code=([^&]*)/.exec(hash || "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!).trim();
  } catch {
    return "";
  }
}

/**
 * What the passcode field holds, as the code to send: the code itself, or
 * the code in a whole `daisy open` link pasted there.
 */
export function codeFromInput(text: string): string {
  const t = text.trim();
  const at = t.indexOf("#");
  if (at >= 0 && /code=/.test(t.slice(at))) return codeFromHash(t.slice(at)) ?? "";
  return t;
}

/** A passcode `daisy open` gives: base64url, 16 random bytes (22 characters). */
const CODE = /^[A-Za-z0-9_-]{16,200}$/;

/**
 * Why `code` cannot be a passcode `daisy open` gave, in plain words ("" =
 * it can, or there is none and none is `required` — the login screen may
 * then ask without one; a link's empty `#code=` is a problem).
 */
export function codeProblem(code: string, required = false): string {
  if (code ? CODE.test(code) : !required) return "";
  return t("ui-chat.openCode.problem");
}
