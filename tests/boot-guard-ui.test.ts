/**
 * P6-27 (phase-5 2nd re-acceptance P5N-7): the page never stays blank.
 * A render error shows a message, the error's text and a reload button
 * (packages/ui/src/boot-guard.tsx, around the whole app in
 * apps/app/index.ts); the first load stops waiting after BOOT_LIMIT_MS and
 * says why (apps/app/App.tsx). Before any language pack is loaded only
 * signs are shown — never a raw key.
 */
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-guard-ui-"));
const bundle = path.join(dir, "guard.cjs");

const harness = `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BootGuard, withinBoot } from "./packages/ui/src/boot-guard";
import { setUiPack } from "./packages/ui/src/i18n";
const crashed = () => {
  const g = new BootGuard({});
  g.state = BootGuard.getDerivedStateFromError(new Error("Cannot read properties of undefined (reading 'items')"));
  return renderToStaticMarkup(g.render());
};
const fine = renderToStaticMarkup(
  React.createElement(BootGuard, null, React.createElement("p", null, "the app")),
);
const noPack = crashed();
setUiPack("zh-CN", ${JSON.stringify(uiMessages("zh-CN"))});
const zh = crashed();
setUiPack("en", ${JSON.stringify(uiMessages("en"))});
const en = crashed();
(async () => {
  const late = await withinBoot(new Promise(() => {}), 50);
  const done = await withinBoot(Promise.resolve(1), 50);
  const failed = await withinBoot(Promise.reject(new Error("x")), 50);
  process.stdout.write(JSON.stringify({ fine, noPack, zh, en, late, done, failed }));
})();
`;
await esbuild.build({
  absWorkingDir: root,
  stdin: { contents: harness, resolveDir: root, loader: "tsx", sourcefile: "guard-harness.tsx" },
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
const out = JSON.parse(execFileSync(process.execPath, [bundle], { maxBuffer: 64 << 20 }).toString());
fs.rmSync(dir, { recursive: true, force: true });
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

test("P5N-7 BootGuard: nothing thrown — the app as it is", () => {
  assert.equal(text(out.fine), "the app");
});

test("P5N-7 BootGuard: a render error shows a message, the error's text and a reload button, in the page's language", () => {
  const zh = text(out.zh);
  assert.match(zh, /页面出错了/);
  assert.match(zh, /Cannot read properties of undefined \(reading 'items'\)/);
  assert.match(zh, /重新加载/);
  assert.match(out.zh, /data-testid="boot-reload"/);
  const en = text(out.en);
  assert.match(en, /Something went wrong/);
  assert.match(en, /Reload/);
  assert.doesNotMatch(en, /[一-鿿]/);
});

test("P5N-7 BootGuard: before any language pack, signs only — never a raw key", () => {
  const t = text(out.noPack);
  assert.match(t, /⚠/);
  assert.match(t, /↻/);
  assert.match(t, /reading 'items'/);
  assert.doesNotMatch(t, /ui\.app\./);
});

test("P5N-7 withinBoot: late after its bound; done when the load settles either way", () => {
  assert.equal(out.late, "late");
  assert.equal(out.done, "done");
  assert.equal(out.failed, "done");
});

test("P5N-7 the app: the whole page is guarded; the first load is bounded and says why; a paired device's first check is bounded", () => {
  const index = fs.readFileSync(path.join(root, "apps/app/index.ts"), "utf8");
  assert.match(index, /createElement\(BootGuard, null, React\.createElement\(App\)\)/);
  assert.match(index, /registerRootComponent\(Root\)/);
  const app = fs.readFileSync(path.join(root, "apps/app/App.tsx"), "utf8");
  assert.match(app, /withinBoot\(booting\)/);
  assert.match(app, /uiText\("ui\.app\.bootSlow"\)/);
  assert.match(app, /setReady\(true\)/);
  const session = fs.readFileSync(path.join(root, "packages/ui/src/device-session.ts"), "utf8");
  assert.match(session, /within\(d\.client\.request\("\/me"\), ms\)/);
});
