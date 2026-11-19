/**
 * P6-11 review (ADR-156): rules for the start settings' commands and files,
 * shared by the start (packages/daisy/src/platform/settings.ts, loaded
 * before the harness table) and the harness table itself
 * (acp-harnesses.ts). Only the browser-safe default translator is
 * imported (i18n-default.ts): either may load it first.
 *
 * P6-23b (ADR-159): the reasons are message keys (`server-contracts.*`),
 * said with the caller's translator (the start's: the owner's language).
 */
import type { Translate } from "./i18n.ts";
import { defaultTranslate } from "./i18n-default.ts";

/**
 * A harness command Daisy may run: an absolute path, or a bare name looked
 * up on PATH. A relative path (`./x`, `bin/x`, `x\y`) is refused — the
 * harness is started in the session's workspace, so it would run a file
 * planted there.
 */
export function commandShapeOk(cmd: string): boolean {
  if (!cmd || /[\0\r\n]/.test(cmd)) return false;
  if (cmd.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(cmd) || cmd.startsWith("\\\\")) return true;
  return !/[\\/]/.test(cmd);
}
/**
 * P6-13: the one rule for a port the owner gives — runner.json `port`,
 * DAISY_PORT (or PORT), `daisy start --port`, the outside face's setting:
 * an integer 1024–65535. Daisy never needs root, and below 1024 a normal
 * account cannot listen on Linux anyway.
 */
export const PORT_MIN = 1024;
export const PORT_MAX = 65535;
/** The port rule in words ("an integer from 1024 to 65535"). */
export const portRule = (t: Translate = defaultTranslate()): string =>
  t("server-contracts.port.rule", { min: PORT_MIN, max: PORT_MAX });
export const portOk = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= PORT_MIN && n <= PORT_MAX;

/** What a harness command must look like, in words. */
export const commandShape = (t: Translate = defaultTranslate()): string => t("server-contracts.command.shape");

/**
 * Why a settings file must not be used, or null: it belongs to another
 * account, or others can write it (group / world write bit). Windows
 * (no uid): not judged here (null).
 */
export function untrustedFile(
  st: { uid: number; mode: number },
  uid: number | undefined,
  t: Translate = defaultTranslate(),
): string | null {
  if (uid === undefined) return null;
  if (st.uid !== uid) return t("server-contracts.file.otherAccount");
  if (st.mode & 0o022) return t("server-contracts.file.othersCanWrite", { mode: (st.mode & 0o777).toString(8) });
  return null;
}

/** A JSON.parse failure, without the file's text: only where it is. */
export function jsonErrorWhere(e: unknown, t: Translate = defaultTranslate()): string {
  const m = String((e as Error)?.message ?? "");
  const lc = /line (\d+) column (\d+)/.exec(m);
  if (lc) return t("server-contracts.json.atLineColumn", { line: lc[1]!, column: lc[2]! });
  const pos = /position (\d+)/.exec(m);
  if (pos) return t("server-contracts.json.atPosition", { position: pos[1]! });
  if (/Unexpected end/i.test(m)) return t("server-contracts.json.unfinished");
  const code = (e as any)?.code;
  if (typeof code === "string") return t("server-contracts.json.unreadable", { code });
  return t("server-contracts.json.invalid");
}
