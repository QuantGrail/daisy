/**
 * P6-22 (ADR-159): the layered-prompt screens (packages/ui/src/prompt-layers.tsx:
 * 设置 › AI 提示词, 会话设置 › 提示词, 本会话的提示词) speak the UI's language pack —
 * Chinese as before, English when chosen. The file keeps no Chinese and names
 * only keys that exist; a layer card and the "compact now" block are bundled
 * with react-native → react-native-web and rendered statically in both
 * languages (as tests/wake-marker-ui.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { cjkLines } from "../scripts/i18n-scan.ts";
import { t } from "../packages/ui/src/i18n.ts";
import { inUiLang, uiLang, uiMessages } from "./ui-pack.ts";

uiLang("zh-CN");
const FILE = "packages/ui/src/prompt-layers.tsx";

test("P6-22: prompt-layers.tsx keeps no Chinese and names only keys that exist (fixed key sets complete)", () => {
  const src = fs.readFileSync(FILE, "utf8");
  assert.deepEqual(cjkLines(src), [], `${FILE} still has Chinese text`);
  for (const lang of ["en", "zh-CN"]) {
    const m = uiMessages(lang);
    for (const x of src.matchAll(/(?<![\w.])t\(\s*"([a-z][\w.-]*)"/g)) assert.ok(x[1]! in m, `${lang}: ${x[1]}`);
    for (const k of [1, 2, 3, 4]) assert.ok(`ui-prompts.level.${k}` in m);
    for (const k of ["off", "allowlist", "all"]) assert.ok(`ui-prompts.mode.${k}` in m && `ui-prompts.modeButton.${k}` in m);
    for (const k of ["org", "session", "owner", "safety"]) assert.ok(`ui-prompts.layer.${k}` in m);
    for (const k of ["default", "overridden", "disabled", "locked", "derived", "custom"]) assert.ok(`ui-prompts.guideState.${k}` in m);
    for (const k of ["waiting", "running", "done", "failed", "skipped", "cancelled"]) assert.ok(`ui-prompts.applyState.${k}` in m);
    for (const k of ["launch", "injected", "recorded", "unknown"]) assert.ok(`ui-prompts.delivery.${k}` in m);
  }
});

test("P6-22: the prompt screens' sentences — Chinese as before, English when chosen", async () => {
  assert.equal(t("ui-prompts.my.title"), "AI 提示词");
  assert.equal(t("ui-prompts.countOver", { n: 9, max: 8 }), "9 / 8 字符（超出上限，无法保存）");
  assert.equal(t("ui-prompts.admin.modeNow", { mode: t("ui-prompts.mode.all") }).slice(0, 9), "现在：对所有会话。");
  assert.equal(t("ui-prompts.dialog.statusOn", { chars: 10, max: 20 }), "这个会话的系统层由 Daisy 分四层追加，共 10 字符（主人保存时的上限 20）。安全规则永远在最后。");
  await inUiLang("en", () => {
    assert.equal(t("ui-prompts.my.title"), "AI prompts");
    assert.equal(t("ui-prompts.countOver", { n: 9, max: 8 }), "9 / 8 characters (over the limit, cannot be saved)");
    assert.match(t("ui-prompts.admin.modeNow", { mode: t("ui-prompts.mode.all") }), /^Now: Every session\. When on/);
    assert.match(t("ui-prompts.dialog.statusOn", { chars: 10, max: 20 }), /Daisy adds this session's system layer in four layers, 10 characters/);
    assert.equal(t("ui-prompts.session.stateFollow", { state: t("ui-prompts.state.on") }), "On · follows your default");
    assert.match(t("ui-prompts.estimate.some", { sessions: 3, owners: 2, people: "a: 2, b: 1", immediate: 1, truncated: "" }), /^This compacts 3 Claude sessions belonging to 2 people/);
  });
});

// ── rendered ─────────────────────────────────────────────────────────────

const root = path.resolve(import.meta.dirname, "..");
const esbuild = createRequire(import.meta.url)("esbuild");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-layers-ui-"));
const bundle = path.join(dir, "prompt-layers.cjs");
const harness = `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplyNow, GuideLayerCard } from "./packages/ui/src/prompt-layers";
import { setUiPack } from "./packages/ui/src/i18n";
const packs = { "zh-CN": ${JSON.stringify(uiMessages("zh-CN"))}, en: ${JSON.stringify(uiMessages("en"))} };
const h = React.createElement;
const layer = { id: "safety:core", layer: "safety", title: "Safety", state: "locked", chars: 42, source: "daisy", text: "rules", toggle: false, editable: false };
const owner = { id: "owner:note", layer: "owner", title: "Note", state: "disabled", chars: 7, source: "owner", text: "x", toggle: true, editable: false };
const out = {};
for (const lang of ["zh-CN", "en"]) {
  setUiPack(lang, packs[lang]);
  out[lang] = {
    safety: renderToStaticMarkup(h(GuideLayerCard, { x: layer })),
    owner: renderToStaticMarkup(h(GuideLayerCard, { x: owner })),
    apply: renderToStaticMarkup(h(ApplyNow, { state: { apply: { available: true, state: "waiting", note: "n1" } }, onPress() {} })),
  };
}
process.stdout.write(JSON.stringify(out));
`;
await esbuild.build({
  absWorkingDir: root,
  stdin: { contents: harness, resolveDir: root, loader: "tsx", sourcefile: "prompt-layers-harness.tsx" },
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
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

test("P6-22: a layer card and the compact-now block render in Chinese", () => {
  const zh = out["zh-CN"];
  assert.match(text(zh.safety), /锁定 · 42 字符 · 来源：daisy · 收起/);
  assert.match(text(zh.safety), /谁能改：只能走 Daisy 代码评审。/);
  assert.match(text(zh.owner), /已关闭，不进提示词 · 7 字符/);
  assert.match(text(zh.owner), /主人可以开关（文字是 Daisy 的默认，不能改写）。/);
  assert.match(text(zh.apply), /已排队，等这段对话空闲时压缩 （n1）|已排队，等这段对话空闲时压缩（n1）/);
  assert.match(text(zh.apply), /立即压缩并生效/);
});

test("P6-22: a layer card and the compact-now block render in English", () => {
  const en = out.en;
  assert.match(text(en.safety), /Locked · 42 characters · source: daisy · Hide/);
  assert.match(text(en.safety), /Who can change it: only through Daisy's code review\./);
  assert.match(text(en.owner), /Off, not in the prompt · 7 characters/);
  assert.match(text(en.apply), /Queued: compacts when this conversation is idle/);
  assert.match(text(en.apply), /Compact now and apply/);
  assert.doesNotMatch(text(en.safety) + text(en.owner) + text(en.apply), /[一-龥]/);
});
