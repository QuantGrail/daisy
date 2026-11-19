// Native terminal surface. Web uses terminal-frame.web.tsx (iframe), so web
// hosts never need react-native-webview.
import React from "react";
import { WebView } from "react-native-webview";
export function TerminalFrame({
  html,
  baseUrl,
  background,
}: {
  html: string;
  /** Web only (server-served terminal page). */
  src?: string;
  token?: string;
  baseUrl: string;
  background: string;
}) {
  return (
    <WebView
      source={{ html, baseUrl }}
      originWhitelist={["*"]}
      onShouldStartLoadWithRequest={(r) =>
        r.url === "about:blank" || r.url.startsWith(baseUrl + "/")
      }
      javaScriptEnabled
      style={{ flex: 1, backgroundColor: background }}
    />
  );
}
