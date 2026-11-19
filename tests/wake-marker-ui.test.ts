// A Daisy wake (timer, monitor end, plugin callback …) still queued behind
// the running turn is not delivered yet: its marker reads 「等待发送」
// (muted, ⏳), like a queued user message, not 「AI 自己继续」 (reported
// 2026-11-08: the queue panel and the transcript both showed it, as if it
// had already gone to the AI). Started / merged / cancelled / kept markers
// (the queue-merge tails on the text) read as before. Bundled with react-native →
// react-native-web and rendered statically (as tests/unread-badge-ui.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { uiMessages } from "./ui-pack.ts";

const root = path.resolve(import.meta.dirname, "..");
const esbuild = createRequire(import.meta.url)("esbuild");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-marker-ui-"));
const bundle = path.join(dir, "marker.cjs");
const harness = `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WakeMarker } from "./packages/ui/src/tracebar";
import { setUiPack } from "./packages/ui/src/i18n";
// ADR-159 §8: the bundle speaks Chinese (its own copy of the UI's language).
setUiPack("zh-CN", ${JSON.stringify(uiMessages("zh-CN"))});
const h = React.createElement;
const item = (text, status) => ({ id: "wake:j1", kind: "notice", category: "wake", text, status, createdAt: 0 });
const r = (text, waiting, status = "complete") => renderToStaticMarkup(h(WakeMarker, { item: item(text, status), waiting }));
process.stdout.write(JSON.stringify({
  waiting: r("后台任务结束：build", true),
  started: r("后台任务结束：build", false),
  timer: r("定时 9:00", undefined),
  merged: r("构建检查 PING-c1（已合并进插队的一轮，一起送达）", false),
  cancelled: r("构建检查 PING-c1（已与插队的一轮一起取消）", false),
  kept: r("构建检查 PING-c1（已保留，随下一轮送达）", false),
  removed: r("后台任务结束：build（不会送达）", false, "cancelled"),
  // The server's own heads (prompt-schedule.fire.*), each language.
  timerZh: r("【Daisy 定时器到点】喝水", undefined),
  cronZh: r("【Daisy 定时任务触发】日报 · cron 0 9 * * * · 第 2 次", undefined),
  ...(setUiPack("en", ${JSON.stringify(uiMessages("en"))}), {}),
  timerEn: r("[Daisy timer due] drink water", undefined),
  cronEn: r("[Daisy scheduled task fired] report · cron 0 9 * * * · run 2", undefined),
  bgEn: r("[Daisy background command ended] build · exit 0", undefined),
}));
`;
await esbuild.build({
  absWorkingDir: root,
  stdin: {
    contents: harness,
    resolveDir: root,
    loader: "tsx",
    sourcefile: "wake-marker-harness.tsx",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundle,
  alias: {
    "react-native": "react-native-web",
    "@daisy-ai/client": path.join(root, "packages/client/src/index.ts"),
    "@daisy-ai/contracts": path.join(root, "packages/contracts/src/index.ts"),
  },
  resolveExtensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".js"],
  define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" },
  jsx: "automatic",
  loader: { ".js": "jsx", ".png": "dataurl", ".ttf": "dataurl" },
  logLevel: "error",
});
const out = JSON.parse(
  execFileSync(process.execPath, [bundle], { maxBuffer: 64 << 20 }).toString(),
);
fs.rmSync(dir, { recursive: true, force: true });
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

test("a wake still queued reads 「等待发送」, muted — not 「AI 自己继续」", () => {
  assert.match(out.waiting, /data-testid="wake-marker"/);
  assert.match(out.waiting, /data-testid="wake-marker-waiting"/);
  assert.match(text(out.waiting), /⏳ 等待发送 · 后台任务结束：build/);
  assert.doesNotMatch(text(out.waiting), /AI 自己继续/);
  assert.match(out.waiting, /尚未送达 AI/);
});

test("once started it is 「AI 自己继续」 as before; a timer keeps ◷", () => {
  assert.match(text(out.started), /↩ AI 自己继续 · 后台任务结束：build/);
  assert.doesNotMatch(out.started, /wake-marker-waiting|等待发送/);
  assert.match(text(out.timer), /◷ AI 自己继续 · 定时 9:00/);
});

test("P6-25: the server's timer heads keep ◷ in either language; a background report does not", () => {
  for (const k of ["timerZh", "cronZh", "timerEn", "cronEn"]) assert.match(text(out[k]), /^◷ /, k);
  assert.match(text(out.timerEn), /\[Daisy timer due\] drink water/);
  assert.doesNotMatch(text(out.timerEn), /[\u4e00-\u9fff]/, "the English marker has no Chinese");
  assert.doesNotMatch(text(out.bgEn), /◷/);
});

test("merged / cancelled / kept markers still render their tail", () => {
  assert.match(
    text(out.merged),
    /AI 自己继续 · .*（已合并进插队的一轮，一起送达）/,
  );
  assert.match(text(out.cancelled), /（已与插队的一轮一起取消）/);
  assert.match(text(out.kept), /（已保留，随下一轮送达）/);
  for (const k of ["merged", "cancelled", "kept"])
    assert.doesNotMatch(out[k], /wake-marker-waiting/);
});

test("a wake removed from the queue reads 「已移除」, muted", () => {
  assert.match(out.removed, /data-testid="wake-marker-removed"/);
  assert.match(text(out.removed), /✕ 已移除 · 后台任务结束：build（不会送达）/);
  assert.doesNotMatch(text(out.removed), /AI 自己继续|等待发送/);
});
