/**
 * P6-22 (ADR-159 §11.2): the translator a shared contracts helper uses when
 * its caller passes none (`unsupportedMessage(agent, k, t?)`,
 * `settingsError(…, t?)` …). The web UI always passes its own `t`
 * (`useT()`); server and command-line code should pass the request's or
 * the command's translator. For code that does not (yet), a Node process
 * registers a default — `i18n-node.ts` does on import: the shipped packs in
 * the process's language (`DAISY_LANG`, then the POSIX locale variables,
 * else English). With nothing registered (a browser) a key reads as itself.
 *
 * Browser-safe: no Node imports here.
 */
import { translator, type Translate } from "./i18n.ts";

let factory: (() => Translate) | undefined;
let made: Translate | undefined;
const keys = translator({}, "en");

/** A Node process's default translator, built on first use. */
export function setDefaultTranslate(make: (() => Translate) | undefined): void {
  factory = make;
  made = undefined;
}

/** Whether a process registered a default (a standalone bundle registers its own when not). */
export const hasDefaultTranslate = (): boolean => !!factory;

/** The registered default, or one that answers each key as itself. */
export function defaultTranslate(): Translate {
  if (!factory) return keys;
  return (made ??= factory());
}
