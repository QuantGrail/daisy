/**
 * P6-28: what the English outsider acceptance found.
 *
 * - Daisy's own names (this machine's node, the home workspace, each
 *   harness's host-login identity) follow the reader's language: stored
 *   unnamed, rows from before (a default in any language) read as unnamed,
 *   an owner's own name kept as typed.
 * - `daisy language set|show` work while Daisy is not running (config.json).
 * - Plural forms in the packs (`{n, plural, one {…} other {…}}`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpolate, paramsOf, translator } from "../packages/contracts/src/i18n.ts";
import { loadPacks } from "../packages/contracts/src/i18n-node.ts";
import { identityChipText, shownName } from "../packages/contracts/src/default-names.ts";
import { isDefaultName } from "../packages/daisy/src/platform/default-names.ts";
import { daisy, testIo } from "./cli-fixture.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "daisy-p628-"));
const shipped = loadPacks();

// ── default names ────────────────────────────────────────────────────────

test("P6-28: Daisy's own names are stored unnamed and answered in the request's language, flagged as the default", async () => {
  const { createApp } = await import("../packages/daisy/src/app.ts");
  const root = tmp();
  const dir = join(root, "data");
  mkdirSync(dir, { recursive: true });
  const ctx = await createApp({ dataDir: dir, workspaceHome: root, workspaceRoots: [root] });
  try {
    // Stored: no name (an owner's name has at least one character).
    assert.equal(ctx.store.one("SELECT label FROM nodes").label, "");
    assert.equal(ctx.store.one("SELECT label FROM workspaces").label, "");
    for (const r of ctx.store.all("SELECT data FROM profiles")) assert.equal(JSON.parse(r.data).label, "");
    const h = { authorization: `Bearer ${ctx.issueToken()}` };
    const catalog = async (lang: string) => {
      const r = await ctx.app.inject({ url: "/api/catalog", headers: { ...h, "accept-language": lang } });
      assert.equal(r.statusCode, 200, r.body);
      return r.json();
    };
    let c = await catalog("en");
    assert.deepEqual([c.nodes[0].label, c.nodes[0].labelDefault], ["This machine", true]);
    assert.deepEqual([c.workspaces[0].label, c.workspaces[0].labelDefault], ["Home folder", true]);
    const codex = c.profiles.find((p: any) => p.agent === "codex");
    assert.deepEqual([codex.label, codex.labelDefault], ["codex · host login", true]);
    c = await catalog("zh-CN");
    assert.equal(c.nodes[0].label, "本机");
    assert.equal(c.workspaces[0].label, "用户主目录");
    assert.equal(c.profiles.find((p: any) => p.agent === "codex").label, "codex · 主机登录");
    // A profile's settings saved: the answer names it in the request's language too.
    const r = await ctx.app.inject({
      method: "PATCH",
      url: `/api/profiles/${codex.id}`,
      headers: { ...h, "accept-language": "en" },
      payload: { autoAppendWakes: true },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().label, "codex · host login");
    assert.equal(JSON.parse(ctx.store.one("SELECT data FROM profiles WHERE id=?", codex.id).data).label, "", "still unnamed");
  } finally {
    await ctx.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("P6-28: rows from before (a default name in any language) read as default; an owner's own name stays as typed", async () => {
  const { createApp } = await import("../packages/daisy/src/app.ts");
  const root = tmp();
  const dir = join(root, "data");
  mkdirSync(dir, { recursive: true });
  const ctx = await createApp({ dataDir: dir, workspaceHome: root, workspaceRoots: [root] });
  try {
    // As a Daisy before P6-28 wrote them at a Chinese (or English) first start.
    ctx.store.run("UPDATE nodes SET label='本机'");
    ctx.store.run("UPDATE workspaces SET label='用户主目录'");
    const rows = ctx.store.all("SELECT id,data FROM profiles");
    const relabel = (agent: string, label: string) => {
      const r = rows.find((x: any) => JSON.parse(x.data).agent === agent)!;
      ctx.store.run("UPDATE profiles SET data=? WHERE id=?", JSON.stringify({ ...JSON.parse(r.data), label }), r.id);
      return r.id as string;
    };
    relabel("codex", "codex · 主机登录");
    relabel("claude", "claude · host login");
    const mine = relabel("kimi", "My kimi");
    const node = ctx.store.one("SELECT id FROM nodes").id;
    ctx.store.run("INSERT INTO workspaces VALUES(?,?,?,?)", "w-own", node, "Projects", root);
    const h = { authorization: `Bearer ${ctx.issueToken()}`, "accept-language": "en" };
    const c = (await ctx.app.inject({ url: "/api/catalog", headers: h })).json();
    assert.equal(c.nodes[0].label, "This machine");
    const ws = Object.fromEntries(c.workspaces.map((w: any) => [w.label, w.labelDefault ?? false]));
    assert.deepEqual(ws, { "Home folder": true, Projects: false });
    const byAgent = (a: string) => c.profiles.find((p: any) => p.agent === a);
    assert.deepEqual([byAgent("codex").label, byAgent("codex").labelDefault], ["codex · host login", true]);
    assert.equal(byAgent("claude").label, "claude · host login");
    assert.deepEqual([byAgent("kimi").label, byAgent("kimi").labelDefault], ["My kimi", undefined]);
    assert.equal(byAgent("kimi").id, mine);
    // The same rows read by a Chinese reader.
    const zh = (await ctx.app.inject({ url: "/api/catalog", headers: { ...h, "accept-language": "zh-CN" } })).json();
    assert.equal(zh.profiles.find((p: any) => p.agent === "claude").label, "claude · 主机登录");
    assert.equal(zh.profiles.find((p: any) => p.agent === "kimi").label, "My kimi");
    // The rows themselves are left alone (an older Daisy still reads them).
    assert.equal(ctx.store.one("SELECT label FROM nodes").label, "本机");
  } finally {
    await ctx.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("P6-28: every form a Daisy before P6-28 wrote is recognised (changing a default name's words needs its old form kept)", () => {
  for (const label of ["本机", "This machine", ""]) assert.equal(isDefaultName("node", label), true, label);
  for (const label of ["用户主目录", "Home folder"]) assert.equal(isDefaultName("workspace", label), true, label);
  for (const label of ["gemini · 主机登录", "gemini · host login"]) assert.equal(isDefaultName("profile", label, "gemini"), true, label);
  assert.equal(isDefaultName("profile", "codex · host login", "gemini"), false, "another harness's name");
  assert.equal(isDefaultName("workspace", "Projects"), false);
});

test("P6-28: the web UI says a default name in the language it shows now, an owner's name as typed", () => {
  const en = translator(shipped.packs, "en"),
    zh = translator(shipped.packs, "zh-CN");
  // Answered in Chinese, shown after switching to English: the flag decides.
  const p = { label: "codex · 主机登录", labelDefault: true, agent: "codex" };
  assert.equal(shownName("profile", p, en), "codex · host login");
  assert.equal(shownName("node", { label: "本机", labelDefault: true }, en), "This machine");
  assert.equal(shownName("workspace", { label: "Home folder", labelDefault: true }, zh), "用户主目录");
  assert.equal(shownName("workspace", { label: "Projects" }, zh), "Projects");
});

// ── daisy language while Daisy is not running ───────────────────────────

test("P6-28: daisy language set / show work before Daisy ever started — config.json, the same check, said so", async () => {
  const dir = tmp();
  try {
    const io = () => testIo({ env: { DAISY_LANG: "" } });
    let r = await daisy(io(), dir, "--lang", "en", "language", "set", "en");
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).language, "en");
    assert.match(r.err, /not running/);
    assert.match(r.err, /config\.json/);
    assert.equal(JSON.parse(r.out).setting, "en");
    // Show: the setting from the file, the languages available.
    r = await daisy(io(), dir, "language", "show");
    assert.equal(r.code, 0, r.err);
    const v = JSON.parse(r.out);
    assert.equal(v.setting, "en");
    assert.equal(v.effective, "en");
    assert.deepEqual(v.available.map((a: any) => a.lang), ["en", "zh-CN"]);
    // An unknown language: refused as the running Daisy refuses it, nothing written.
    r = await daisy(io(), dir, "language", "set", "fr");
    assert.equal(r.code, 2);
    assert.match(r.err, /No such language: fr/);
    assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).language, "en");
    // A matched tag is stored as the pack's own name; null follows the system again.
    r = await daisy(io(), dir, "--lang", "zh-CN", "language", "set", "zh-cn");
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /没在运行/);
    assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).language, "zh-CN");
    r = await daisy(io(), dir, "language", "set", "null");
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).language, undefined);
    // Other settings in config.json are kept.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ other: { a: 1 } }));
    r = await daisy(io(), dir, "language", "set", "en");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), { other: { a: 1 }, language: "en" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── plurals ──────────────────────────────────────────────────────────────

test("P6-28: a plural choice picks the language's form; # is the number; params inside are filled; a language without plurals is untouched", () => {
  const steps = "{count, plural, one {# step} other {# steps}} done";
  assert.equal(interpolate(steps, { count: 1 }, "en"), "1 step done");
  assert.equal(interpolate(steps, { count: 2 }, "en"), "2 steps done");
  assert.equal(interpolate(steps, { count: 0 }, "en"), "0 steps done");
  assert.equal(interpolate("{n, plural, =0 {none} one {# file in {dir}} other {# files in {dir}}}", { n: 0, dir: "x" }, "en"), "none");
  assert.equal(interpolate("{n, plural, =0 {none} one {# file in {dir}} other {# files in {dir}}}", { n: 1, dir: "x" }, "en"), "1 file in x");
  assert.deepEqual(paramsOf("{n, plural, one {# file in {dir}} other {# files in {dir}}}"), ["dir", "n"]);
  // No number given / not well formed: left as written (never a throw).
  assert.equal(interpolate(steps, {}, "en"), steps);
  assert.equal(interpolate("{count, plural, one {x}", { count: 1 }, "en"), "{count, plural, one {x}");
  // A language with one form, and the Chinese pack's own text.
  assert.equal(interpolate(steps, { count: 1 }, "zh-CN"), "1 steps done");
  const zh = translator(shipped.packs, "zh-CN"),
    en = translator(shipped.packs, "en");
  assert.equal(zh("ui-copy.traceSummarySteps", { count: 1 }), "完成 1 个步骤");
  assert.equal(en("ui-copy.traceSummarySteps", { count: 1 }), "1 step done");
  assert.equal(en("ui-copy.traceExpand", { count: 1 }), "Show activity (1 step)");
  assert.equal(en("ui-copy.traceExpand", { count: 3 }), "Show activity (3 steps)");
  assert.equal(en("ui-copy.traceProgress", { done: 1, total: 1 }), "1 / 1 step done");
  // A key missing from a language reads the fallback's text with the fallback's rules.
  const xx = translator({ en: { "x.a": steps }, xx: {} }, "xx");
  assert.equal(xx.dynamic("x.a", { count: 1 }), "1 step done");
});

test("P6-28: the English pack has no count followed by a bare plural noun (use a plural choice)", () => {
  // Params that hold a count at run time; limits from limits.ts ({max}, {...Max}) are never 1.
  const COUNTS = /\{(n|count|total|done|open|ais|turns|sessions|owners|seconds|s|mins|minutes|hours|bytes)\} (?:[a-z-]+ )?(steps|times|calls|turns|files|entries|folders|seconds|minutes|hours|bytes|tools|sessions|results|timers|tasks|commands|operations|lines|texts|sections|reports|Agents|AIs|people|pieces|subagents)\b/;
  const bad = Object.entries(shipped.packs.en!).filter(([, v]) => COUNTS.test(v.replace(/\{\w+, plural,[^]*?\}\}/g, "")));
  assert.deepEqual(bad.map(([k]) => k), []);
});

test("P6-29: a host-login identity under Daisy's default name does not repeat 'host login' in its chip", () => {
  const en = translator(shipped.packs, "en");
  const host = { agent: "codex", label: "", labelDefault: true };
  const name = shownName("profile", host, en);
  assert.equal(identityChipText(name, host, "Host login"), name);
  assert.equal(identityChipText("work", { label: "work" }, "Host login"), "work · Host login");
  assert.equal(identityChipText("x", { labelDefault: true, configDir: "managed:x" }, "Signed in"), "x · Signed in");
  assert.equal(identityChipText("k", { labelDefault: true, authMode: "apiKey" }, "API key"), "k · API key");
});
