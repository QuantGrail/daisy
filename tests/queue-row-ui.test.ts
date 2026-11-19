// User feedback 2026-11-08 (「看不到排队的内容」): a queued row's text is one
// line until tapped; opened, the full queued text and the Daisy wakes it
// carries. Rendered statically with react-native-web (as
// tests/wake-marker-ui.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { PRODUCT_NAME } from "../packages/contracts/src/names.ts";
import { uiMessages } from "./ui-pack.ts";

const root = path.resolve(import.meta.dirname, "..");
const esbuild = createRequire(import.meta.url)("esbuild");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-row-ui-"));
const bundle = path.join(dir, "row.cjs");
const harness = `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueueRowText } from "./packages/ui/src/queue-row";
import { setUiPack } from "./packages/ui/src/i18n";
const h = React.createElement;
const long = "第一行内容。" + "很长的回调正文".repeat(60) + "结尾在这里";
const q = { id: "j1", text: long, carriedItems: [{ id: "w1", from: "定时 / 回调唤醒", text: "【外部回调】PING-1 已完成", truncated: true }] };
const r = (expanded) => renderToStaticMarkup(h(QueueRowText, { q, prefix: "插队 · ", expanded, onToggle: () => {} }));
// P6-22: English first, then Chinese (the assertions below).
setUiPack("en", ${JSON.stringify(uiMessages("en"))});
const en = { folded: r(false), open: r(true) };
setUiPack("zh-CN", ${JSON.stringify(uiMessages("zh-CN"))});
process.stdout.write(JSON.stringify({ folded: r(false), open: r(true), en }));
`;
await esbuild.build({
  absWorkingDir: root,
  stdin: {
    contents: harness,
    resolveDir: root,
    loader: "tsx",
    sourcefile: "queue-row-harness.tsx",
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

test("a queued row is one line until opened; the toggle keeps its own test id", () => {
  assert.match(out.folded, /data-testid="queue-text-j1"/);
  assert.match(out.folded, /aria-label="展开这条排队内容"/);
  // Carried wakes only counted while folded.
  assert.match(text(out.folded), /插队 · 第一行内容。/);
  assert.match(text(out.folded), new RegExp(`带 1 条 ${PRODUCT_NAME} 事件`));
  assert.doesNotMatch(out.folded, /queue-carried-w1/);
});

test("opened, it shows the full text and what rides along", () => {
  assert.match(out.open, /aria-label="收起这条排队内容"/);
  // numberOfLines=1 → react-native-web's one-line clamp classes, gone once open.
  const cls = (h: string) => /<div dir="auto" class="([^"]+)"/.exec(h)![1];
  assert.notEqual(cls(out.folded), cls(out.open));
  assert.ok(
    cls(out.folded).split(" ").length > cls(out.open).split(" ").length,
  );
  assert.match(text(out.open), /结尾在这里/);
  assert.match(out.open, /data-testid="queue-carried-w1"/);
  assert.match(
    text(out.open),
    /随它一起送达 · 定时 \/ 回调唤醒： 【外部回调】PING-1 已完成 …（过长，只显示开头）/,
  );
});

test("P6-22: the row's own words in English", () => {
  assert.match(out.en.folded, /aria-label="Expand this queued message"/);
  assert.match(text(out.en.folded), new RegExp(`with 1 ${PRODUCT_NAME} events`));
  assert.match(out.en.open, /aria-label="Collapse this queued message"/);
  assert.match(text(out.en.open), /Delivered with it · 定时 \/ 回调唤醒:/);
  assert.match(text(out.en.open), /too long, showing the start only/);
});
