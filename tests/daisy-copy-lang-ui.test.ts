// P6-22 (ADR-159): DaisyCopy's defaults are the language pack's (`ui-copy.*`)
// and follow a language switch — the default copy, the tool-authorization
// preset a host's branding picks, the status labels — while a host's own
// overrides still win. Bundled with react-native → react-native-web and
// rendered statically (as tests/queue-row-ui.test.ts).
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-copy-lang-"));
const bundle = path.join(dir, "copy.cjs");
const harness = `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DaisyHostProvider, defaultDaisyCopy, toolAuthorizationCopy, useDaisyCopy } from "./packages/ui/src/host";
import { hostBrandingProps } from "./packages/ui/src/branding";
import { labels } from "./packages/ui/src/primitives";
import { setUiPack } from "./packages/ui/src/i18n";
const h = React.createElement;
const Show = () => {
  const c = useDaisyCopy();
  return h("span", null, [c.approvalBadge, c.labels.running, c.composerPlaceholder, c.traceRanCommand, c.loginNoNode].join("|"));
};
const branded = hostBrandingProps({ copy: "tool-authorization" }).copy;
const page = (copy) => renderToStaticMarkup(copy ? h(DaisyHostProvider, { copy }, h(Show)) : h(Show));
const view = () => ({
  plain: page(),
  preset: page(branded),
  host: page({ composerPlaceholder: "Ask the team AI" }),
  badge: defaultDaisyCopy.approvalBadge,
  presetBadge: toolAuthorizationCopy.approvalBadge,
  label: labels.running,
  claude: labels.claude,
});
setUiPack("zh-CN", ${JSON.stringify(uiMessages("zh-CN"))});
const zh = view();
setUiPack("en", ${JSON.stringify(uiMessages("en"))});
const en = view();
process.stdout.write(JSON.stringify({ zh, en }));
`;
await esbuild.build({
  absWorkingDir: root,
  stdin: { contents: harness, resolveDir: root, loader: "tsx", sourcefile: "copy-harness.tsx" },
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
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

test("P6-22: the default copy is the pack's, in the UI's language", () => {
  assert.equal(text(out.zh.plain), `需要确认|执行中|说说你想完成什么…|运行了 {command}|${PRODUCT_NAME} 的执行部分还没有就绪，就绪后即可登录。`);
  assert.equal(
    text(out.en.plain),
    `Needs your OK|Running|What would you like to get done…|Ran {command}|${PRODUCT_NAME}'s execution side isn't ready yet; you can sign in once it is.`,
  );
  // The live compatibility objects read the language of the moment.
  assert.equal(out.zh.badge, "需要确认");
  assert.equal(out.en.badge, "Needs your OK");
  assert.equal(out.zh.label, "执行中");
  assert.equal(out.en.label, "Running");
  assert.equal(out.en.claude, "Claude Code");
});

test("P6-22: the tool-authorization preset (branding) follows the language; a host's own words win", () => {
  assert.match(text(out.zh.preset), /^工具授权\|运行中\|/);
  assert.match(text(out.en.preset), /^Tool authorization\|Running\|/);
  assert.equal(out.zh.presetBadge, "工具授权");
  assert.equal(out.en.presetBadge, "Tool authorization");
  assert.match(text(out.zh.host), /^需要确认\|执行中\|Ask the team AI\|/);
  assert.match(text(out.en.host), /^Needs your OK\|Running\|Ask the team AI\|/);
});
