/**
 * Browser harness for scripts/e2e-context.cjs: a minimal host page that
 * embeds DaisyChat with a host page `context` (fb3), the way an embedding
 * platform's AI drawer does. Bundled with esbuild (react-native → react-native-web).
 * Never part of the app build.
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { View, Text } from "react-native";
import { DaisyClient } from "@daisy-ai/client";
import { DaisyChat } from "../packages/ui/src/chat";
import { loadUiLanguage } from "../packages/ui/src/i18n";
import type { MessageContextInput } from "@daisy-ai/contracts";

const params = new URLSearchParams(location.hash.slice(1));
const client = new DaisyClient(location.origin, params.get("token") || "");
const contexts: Record<string, MessageContextInput> = {
  A: {
    key: "tasks/T-1",
    label: "任务 T-1 · 修复导出口径",
    url: "/tasks?t=T-1",
    text: Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行：任务正文`).join(
      "\n",
    ),
    refs: [{ kind: "task", id: "T-1", title: "修复导出口径" }],
  },
  B: {
    key: "tasks/T-1/timeline",
    label: "时间线 · 修复导出口径",
    text: "时间线正文",
    refs: [{ kind: "task", id: "T-1", title: "修复导出口径" }],
  },
  // Over the schema limits (review G1): long key, label, text and URL.
  LONG: {
    key: "route:/academy?q=" + "x".repeat(320),
    label: "学院搜索 · " + "很长的标题".repeat(60),
    url: "/academy?q=" + "x".repeat(2100),
    text: "页面正文".repeat(6000),
  },
};
(window as any).sent = [] as string[];
function Host() {
  const [name, setName] = useState<string | null>(params.get("ctx") || "A");
  (window as any).setContext = setName;
  const width = Number(params.get("width") || 420);
  return (
    <View style={{ height: "100vh" as any, flexDirection: "row" }}>
      <View
        testID="chat-column"
        style={{ width, borderRightWidth: 1, borderColor: "#ddd" }}
      >
        <DaisyChat
          client={client}
          sessionId={params.get("sid") || ""}
          chrome={(params.get("chrome") as any) || "compact"}
          context={name ? contexts[name] : null}
          onContextSent={(c) => (window as any).sent.push(c.key)}
          autoFocus={params.get("autofocus") === "1"}
        />
      </View>
      <Text testID="host-context" style={{ padding: 8 }}>
        {name || "-"}
      </Text>
    </View>
  );
}
// ADR-159 §4: an embedding host loads the UI's language pack once (the owner's, from health).
fetch(location.origin + "/api/health")
  .then((r) => r.json())
  .catch(() => ({}))
  .then((h: any) => loadUiLanguage(client, h?.language))
  .then(() => createRoot(document.getElementById("root")!).render(<Host />));
