import type { DaisyColors } from "./theme";
/**
 * Web: the control plane's fixed terminal page; only non-secret query data.
 * `lang` (P6-25, ADR-159): the page says its few words in the UI's
 * language instead of asking the server for the owner's.
 */
export function terminalPageUrl(
  baseUrl: string,
  token: string,
  sid: string,
  jid: string,
  C: Pick<DaisyColors, "terminalBg" | "terminalInk" | "terminalMuted" | "terminalKey" | "terminalKeyInk">,
  lang?: string,
) {
  const q = new URLSearchParams({
    sid,
    jid,
    auth: token ? "bearer" : "cookie",
    bg: C.terminalBg,
    ink: C.terminalInk,
    muted: C.terminalMuted,
    key: C.terminalKey,
    keyInk: C.terminalKeyInk,
    ...(lang ? { lang } : {}),
  });
  return `${baseUrl}/terminal-assets/terminal.html?${q}`;
}
