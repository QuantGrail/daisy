import React, { useEffect, useRef } from "react";
import { t } from "./i18n";
/**
 * Web terminal: a fixed document served by the control plane
 * (/terminal-assets/terminal.html) instead of an inline srcDoc, so it runs
 * under Daisy's strict CSP and never inherits the host page's origin with
 * interpolated data. A Bearer token (non-host mode) is handed over by
 * postMessage to that exact origin after the frame says it is ready; in host
 * mode the gateway cookie authenticates and no token exists.
 *
 * `allow-same-origin` stays: cookie authentication (host mode) needs the
 * frame's real origin. The sandbox still blocks popups, forms and top-level
 * navigation, and the document content is fixed by the server.
 */
export function TerminalFrame({
  src,
  token,
}: {
  html: string;
  src: string;
  token: string;
  baseUrl: string;
  background: string;
}) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    if (!token) return;
    const origin = new URL(src, window.location.href).origin;
    const onMessage = (e: MessageEvent) => {
      const frame = ref.current?.contentWindow;
      // P6-03 (ADR-153): daisy-terminal-*; a terminal page of an older
      // Daisy says harbor-terminal-* (answered in its own words; the page
      // takes the first token it gets).
      const prefix = /^(daisy|harbor)-terminal-ready$/.exec(
        String(e.data?.type ?? ""),
      )?.[1];
      if (!frame || e.source !== frame || e.origin !== origin || !prefix)
        return;
      frame.postMessage({ type: `${prefix}-terminal-token`, token }, origin);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [src, token]);
  return React.createElement("iframe", {
    ref,
    title: t("ui-chat.terminal.frameTitle"),
    src,
    referrerPolicy: "no-referrer",
    style: { border: 0, width: "100%", height: "100%" },
    sandbox: "allow-scripts allow-same-origin",
  });
}
