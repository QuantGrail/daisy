import { Platform } from "react-native";
import { t } from "./i18n";

/**
 * Copy text (P1-08; was node-table.tsx's). The host's adapter wins; then
 * the asynchronous Clipboard API, which browsers give only to a secure
 * context (https, or http://127.0.0.1 / localhost) — over plain HTTP on a
 * network address (the outside face without TLS, docs/WEB-ORIGINS.md) it
 * is missing, so the old `execCommand("copy")` on a hidden text area is
 * the fallback; failing both, the caller tells the owner to select it.
 */
export async function copyText(
  text: string,
  adapter?: (t: string) => Promise<void>,
): Promise<void> {
  if (adapter) return adapter(text);
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText)
    try {
      return await navigator.clipboard.writeText(text);
    } catch {
      /* denied (no user gesture, policy): try the old way */
    }
  if (Platform.OS === "web" && typeof document !== "undefined") {
    const t = document.createElement("textarea");
    t.value = text;
    t.setAttribute("readonly", "");
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    if (ok) return;
  }
  throw Error(t("ui-chat.clipboard.denied"));
}
