/**
 * P6-20 (ADR-159, D-44 ①): language packs — the packs themselves (both
 * shipped languages complete, params alike, keys typed), the mechanism
 * (interpolation, matching, fallback, a dropped-in language), choosing the
 * language (command line, local API, owner setting, system locale), the
 * converted slice in both languages (`daisy --help`, `daisy status`, the
 * command line's errors, the API's invalid-input error, the language
 * routes, the web UI's pack), and the ratchet on Chinese left in source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FALLBACK_LANG,
  interpolate,
  languagesOf,
  matchLang,
  paramsOf,
  parseAcceptLanguage,
  translator,
} from "../packages/contracts/src/i18n.ts";
import { loadPacks, packsFor, promptText, SHIPPED_LOCALES } from "../packages/contracts/src/i18n-node.ts";
import { resolveLanguage, setOwnerLanguage, systemLanguage } from "../packages/daisy/src/platform/language.ts";
import { keysSource, KEYS_FILE } from "../scripts/gen-i18n-keys.ts";
import { cjkLines, KEPT_FILE, PENDING_FILE, readKept, scan, stripComments } from "../scripts/i18n-scan.ts";
import { daisy, fakeDaisy, testIo } from "./cli-fixture.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "daisy-i18n-"));
/** P6-22: the web UI (every source file of packages/ui and the web shell) and the contracts files it reads. */
const P6_22_FILES = [
  ...readdirSync("packages/ui/src")
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => `packages/ui/src/${f}`),
  "apps/app/App.tsx",
  "apps/app/app.config.js",
  ...["commands", "agent-features", "agent-label", "model-options", "notifications", "context-usage", "profile", "branding"].map(
    (f) => `packages/contracts/src/${f}.ts`,
  ),
];
const shipped = loadPacks();

// ── the packs ────────────────────────────────────────────────────────────

test("ADR-159: the shipped packs load without problems; English and Chinese are there, found by directory", () => {
  assert.deepEqual(shipped.problems, []);
  const langs = languagesOf(shipped.packs);
  assert.equal(langs[0], FALLBACK_LANG);
  assert.ok(langs.includes("zh-CN"));
  for (const l of langs) assert.ok(shipped.packs[l]!["common.language.name"], `${l}: common.language.name`);
});

test("ADR-159: every shipped language has exactly the reference pack's keys (100% complete, nothing extra)", () => {
  const ref = Object.keys(shipped.packs[FALLBACK_LANG]!).sort();
  for (const l of languagesOf(shipped.packs)) {
    const keys = Object.keys(shipped.packs[l]!).sort();
    const missing = ref.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !ref.includes(k));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${l}: missing or extra keys`);
    for (const k of keys) assert.ok(shipped.packs[l]![k]!.trim(), `${l}: ${k} is empty`);
  }
});

test("ADR-159: a key's {params} are the same in every language", () => {
  const ref = shipped.packs[FALLBACK_LANG]!;
  for (const l of languagesOf(shipped.packs))
    for (const [k, v] of Object.entries(shipped.packs[l]!))
      assert.deepEqual(paramsOf(v), paramsOf(ref[k]!), `${l}: ${k} has other params than ${FALLBACK_LANG}`);
});

test("ADR-159: the typed keys are generated from the reference pack (npm run gen:i18n)", () => {
  assert.equal(readFileSync(KEYS_FILE, "utf8").replace(/\r\n/g, "\n"), keysSource(), `${KEYS_FILE} is stale: npm run gen:i18n`);
});

test("ADR-159: every key named literally in source (t(\"…\")) is in the packs", () => {
  const files = [
    "packages/daisy/src/cli/main.ts",
    "packages/daisy/src/cli/daisy.ts",
    "packages/daisy/src/cli/errors.ts",
    "packages/daisy/src/cli/local/commands.ts",
    "packages/daisy/src/app/http.ts",
    "packages/daisy/src/app/language.ts",
    "packages/ui/src/settings.tsx",
    "packages/ui/src/language-settings.tsx",
    "apps/app/App.tsx",
    // P6-22: the whole web UI and the contracts files it reads.
    ...P6_22_FILES,
  ];
  const ref = shipped.packs[FALLBACK_LANG]!;
  for (const f of files)
    for (const m of readFileSync(f, "utf8").matchAll(/(?<![\w.])(?:t|uiText)\(\s*"([a-z][\w.-]*)"/g))
      assert.ok(m[1]! in ref, `${f}: ${m[1]} is not in the packs`);
});

// ── the mechanism ────────────────────────────────────────────────────────

test("ADR-159: interpolation is {name} only; the product's names are always filled; an unknown {name} stays", () => {
  assert.equal(interpolate("{product} on {port}", { port: 29311 }), "Daisy on 29311");
  assert.equal(interpolate("run {command} start"), "run daisy start");
  assert.equal(interpolate("{missing} {a}", { a: 0 }), "{missing} 0");
  assert.deepEqual(paramsOf("{b} {a} {b} {product}"), ["a", "b", "product"]);
});

test("ADR-159: a tag as systems and browsers write it reaches the closest pack", () => {
  const av = ["en", "zh-CN"];
  for (const [tag, want] of [
    ["zh_CN.UTF-8", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh-TW", "zh-CN"],
    ["zh", "zh-CN"],
    ["en_US.UTF-8", "en"],
    ["en-GB", "en"],
    ["EN", "en"],
    ["C", undefined],
    ["POSIX", undefined],
    ["C.UTF-8", undefined],
    ["fr_FR.UTF-8", undefined],
    ["", undefined],
  ] as const)
    assert.equal(matchLang(tag, av), want, tag);
  assert.equal(matchLang("zh-TW", ["en", "zh-CN", "zh-TW"]), "zh-TW");
  assert.equal(parseAcceptLanguage("fr-FR,fr;q=0.9,zh-CN;q=0.8,en;q=0.7", av), "zh-CN");
  assert.equal(parseAcceptLanguage("en;q=0.5, zh;q=0.6", av), "zh-CN");
  assert.equal(parseAcceptLanguage("*", av), undefined);
  assert.equal(parseAcceptLanguage("de", av), undefined);
});

test("ADR-159: a missing key falls back to English, then to the key itself — never a throw", () => {
  const t = translator({ en: { "x.a": "A {n}", "x.b": "B" }, xx: { "x.a": "αλφα {n}" } }, "xx");
  assert.equal(t.dynamic("x.a", { n: 1 }), "αλφα 1");
  assert.equal(t.dynamic("x.b"), "B");
  assert.equal(t.dynamic("x.c"), "x.c");
  assert.equal(t.has("x.b"), true);
  assert.equal(t.has("x.c"), false);
  assert.equal(t.lang, "xx");
});

test("ADR-159: adding a language is adding a directory — a dropped-in pack is found, falls back per key, never replaces a shipped one", () => {
  const dir = tmp();
  try {
    const loc = join(dir, "locales");
    mkdirSync(join(loc, "fr"), { recursive: true });
    mkdirSync(join(loc, "en"), { recursive: true });
    mkdirSync(join(loc, "Not A Tag"), { recursive: true });
    writeFileSync(join(loc, "fr", "common.json"), JSON.stringify({ "common.language.name": "Français", "cli.wrong.area": "x" }));
    writeFileSync(join(loc, "fr", "cli.json"), JSON.stringify({ "cli.status.notRunning": "{product} ne tourne pas" }));
    writeFileSync(join(loc, "en", "cli.json"), JSON.stringify({ "cli.status.notRunning": "hijacked" }));
    const r = loadPacks([SHIPPED_LOCALES, loc]);
    assert.ok(languagesOf(r.packs).includes("fr"));
    assert.match(r.problems.join("\n"), /cli\.wrong\.area is outside its area/);
    assert.match(r.problems.join("\n"), /Not A Tag: not a language tag/);
    const fr = translator(r.packs, "fr");
    assert.equal(fr("cli.status.notRunning"), "Daisy ne tourne pas");
    assert.equal(fr("cli.status.startHint"), "Start it: daisy start");
    assert.equal(translator(r.packs, "en")("cli.status.notRunning"), "Daisy is not running");
    // The data directory's packs, through the command line.
    assert.ok(languagesOf(packsFor(dir)).includes("fr"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADR-159 §6: a model-facing prompt is a per-language file, the fallback's when a language has none", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "en", "prompts"), { recursive: true });
    mkdirSync(join(root, "zh-CN", "prompts"), { recursive: true });
    writeFileSync(join(root, "en", "prompts", "wake.md"), "Wake up.\n");
    writeFileSync(join(root, "en", "prompts", "only-en.md"), "English only.\n");
    writeFileSync(join(root, "zh-CN", "prompts", "wake.md"), "醒来。\n");
    assert.equal(promptText("wake", "zh-CN", [root]), "醒来。\n");
    assert.equal(promptText("wake", "en", [root]), "Wake up.\n");
    assert.equal(promptText("only-en", "zh-CN", [root]), "English only.\n");
    assert.equal(promptText("none", "en", [root]), undefined);
    assert.throws(() => promptText("../x", "en", [root]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── choosing the language ────────────────────────────────────────────────

test("ADR-159 §2: the system locale — DAISY_LANG, LC_ALL, LC_MESSAGES, LANG, LANGUAGE, macOS AppleLanguages, Intl; C says nothing", () => {
  const av = ["en", "zh-CN"];
  const none = { apple: () => [], intl: () => undefined };
  assert.equal(systemLanguage({ env: { LANG: "zh_CN.UTF-8" }, platform: "linux", ...none }, av), "zh-CN");
  assert.equal(systemLanguage({ env: { LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }, platform: "linux", ...none }, av), "en");
  assert.equal(systemLanguage({ env: { LC_ALL: "C", LANG: "zh_CN.UTF-8" }, platform: "linux", ...none }, av), "zh-CN");
  assert.equal(systemLanguage({ env: { LANGUAGE: "fr:zh_CN" }, platform: "linux", ...none }, av), "zh-CN");
  assert.equal(systemLanguage({ env: {}, platform: "darwin", apple: () => ["zh-Hans-CN", "en-CN"], intl: () => "en-US" }, av), "zh-CN");
  // launchd gives no LANG; AppleLanguages is only asked on macOS.
  assert.equal(systemLanguage({ env: {}, platform: "linux", apple: () => ["zh-Hans-CN"], intl: () => "en-US" }, av), "en");
  assert.equal(systemLanguage({ env: {}, platform: "win32", apple: () => [], intl: () => "zh-CN" }, av), "zh-CN");
  assert.equal(systemLanguage({ env: { LANG: "de_DE.UTF-8" }, platform: "linux", ...none }, av), undefined);
  assert.equal(systemLanguage({ env: { DAISY_LANG: "en", LANG: "zh_CN.UTF-8" }, platform: "linux", ...none }, av), "en");
});

test("ADR-159 §2: --lang > DAISY_LANG > the owner setting > the system > English", () => {
  const dir = tmp();
  try {
    const base = { platform: "linux", apple: () => [], intl: () => undefined, dataDir: dir, useEnv: true };
    assert.deepEqual(resolveLanguage({ ...base, env: {} }), { lang: "en", source: "default" });
    assert.deepEqual(resolveLanguage({ ...base, env: { LANG: "zh_CN.UTF-8" } }), { lang: "zh-CN", source: "system" });
    setOwnerLanguage(dir, "en");
    assert.deepEqual(resolveLanguage({ ...base, env: { LANG: "zh_CN.UTF-8" } }), { lang: "en", source: "setting" });
    assert.deepEqual(resolveLanguage({ ...base, env: { DAISY_LANG: "zh-CN" } }), { lang: "zh-CN", source: "env" });
    assert.deepEqual(resolveLanguage({ ...base, env: { DAISY_LANG: "zh-CN" }, explicit: "en" }), { lang: "en", source: "flag" });
    // The server: DAISY_LANG is part of the system's word, below the owner setting.
    assert.deepEqual(resolveLanguage({ ...base, useEnv: false, env: { DAISY_LANG: "zh-CN" } }), { lang: "en", source: "setting" });
    // The setting lives in config.json next to the access settings (kept).
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.equal(cfg.language, "en");
    setOwnerLanguage(dir, null);
    assert.equal("language" in JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the command line ─────────────────────────────────────────────────────

test("ADR-159: daisy --help in English and in Chinese (--lang, DAISY_LANG); route summaries from the packs", async () => {
  const dir = tmp();
  try {
    let r = await daisy(testIo(), dir, "--lang", "en", "--help");
    assert.equal(r.code, 0);
    assert.match(r.out, /^daisy — the Daisy command line/);
    assert.match(r.out, /Local commands \(manage the Daisy process/);
    assert.match(r.out, /status {6}Whether Daisy is running/);
    assert.match(r.out, /whoami {6}Who am I: the owner/);
    assert.match(r.out, /--lang <language>/);
    assert.doesNotMatch(r.out.split("API commands")[0]!, /[一-鿿]/);
    r = await daisy(testIo({ env: { DAISY_LANG: "zh-CN" } }), dir, "--help");
    assert.match(r.out, /^daisy —— Daisy 的命令行/);
    assert.match(r.out, /whoami {6}我是谁/);
    r = await daisy(testIo({ env: { DAISY_LANG: "en" } }), dir, "status", "--help");
    assert.match(r.out, /^Usage: daisy status \[--json\]/);
    assert.match(r.out, /Exit code: 0 running; 3 not running/);
    r = await daisy(testIo({ env: { DAISY_LANG: "en" } }), dir, "language", "--help");
    assert.match(r.out, /set\s+Set the display language/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADR-159: the owner setting in config.json decides when nothing on the command line does; --lang=<tag> and a wrong tag", async () => {
  const dir = tmp();
  try {
    setOwnerLanguage(dir, "en");
    const io = testIo({ env: { DAISY_LANG: "" } });
    let r = await daisy(io, dir, "status");
    assert.equal(r.code, 3);
    assert.match(r.out, /^Daisy is not running\n {2}Data dir {5}/);
    r = await daisy(testIo({ env: { DAISY_LANG: "" } }), dir, "--lang=zh-CN", "status");
    assert.match(r.out, /^Daisy 没在运行\n {2}数据目录 {2}/);
    r = await daisy(testIo({ env: { DAISY_LANG: "" } }), dir, "--lang", "xx", "status");
    assert.equal(r.code, 2);
    assert.match(r.err, /✗ No such language: xx\n {2}What to do: Available languages: en, zh-CN/);
    r = await daisy(testIo({ env: { DAISY_LANG: "" } }), dir, "statu");
    assert.match(r.err, /✗ No such command: daisy statu\n {2}What to do: Did you mean: start, status\? All commands: daisy --help/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADR-159: daisy status of a running Daisy, in both languages; the API's language goes as Accept-Language", async () => {
  const d = await fakeDaisy((r) => {
    if (r.path === "/api/pin") return { json: { set: false } };
    if (r.path === "/api/access")
      return { json: { external: { enabled: false }, passcode: { mode: "auto", effective: false, sharedHost: false } } };
    if (r.path === "/api/relay") return { json: { enabled: false } };
    if (r.path === "/api/update") return { json: { supervised: false } };
    if (r.path === "/api/catalog") return { json: { nodes: [] } };
    return undefined;
  });
  try {
    let r = await daisy(testIo({ env: { DAISY_LANG: "en" } }), d.dataDir, "status");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Daisy is running \(pid \d+, up \d+s\)/);
    assert.match(r.out, /\n {2}Local {8}http:\/\/127\.0\.0\.1:\d+ \(port: derived from the account's uid\)/);
    assert.match(r.out, /\n {2}Outside {6}off \(to open it from other machines: daisy access external on, needs the PIN\)/);
    assert.match(r.out, /\n {2}Relay {8}none chosen/);
    assert.match(r.out, /\n {2}PIN {10}not set/);
    assert.match(r.out, /running in the foreground: an installed new version does not switch in by itself/);
    assert.match(r.out, /⚠ No PIN is set yet: run daisy pin set first/);
    assert.doesNotMatch(r.out, /[一-鿿]/);
    assert.ok(d.requests.length > 0);
    for (const q of d.requests) assert.equal(q.headers["accept-language"], "en");
    d.requests.length = 0;
    r = await daisy(testIo({ env: { DAISY_LANG: "zh-CN" } }), d.dataDir, "status");
    assert.match(r.out, /^Daisy 正在运行（进程号 \d+，已运行 \d+ 秒）/);
    assert.match(r.out, /\n {2}本机面 {4}http:\/\/127\.0\.0\.1:\d+（端口：按系统账户 uid 派生）/);
    assert.match(r.out, /\n {2}PIN {7}未设置/);
    assert.match(r.out, /⚠ 还没有设置 PIN/);
    for (const q of d.requests) assert.equal(q.headers["accept-language"], "zh-CN");
  } finally {
    await d.close();
  }
});

test("ADR-159: an API error on the command line — the server's message as sent, the 怎么办 in the command's language", async () => {
  const d = await fakeDaisy((r) =>
    r.path === "/api/me" ? { status: 400, json: { error: "Invalid parameters", code: "invalid_input", details: ["x"] } } : undefined,
  );
  try {
    let r = await daisy(testIo({ env: { DAISY_LANG: "en" } }), d.dataDir, "whoami");
    assert.equal(r.code, 2);
    assert.match(r.err, /✗ Invalid parameters: x\n {2}What to do: Wrong arguments: see this command's --help/);
    r = await daisy(testIo({ env: { DAISY_LANG: "zh-CN" } }), d.dataDir, "whoami");
    assert.match(r.err, /怎么办：参数不对：看这条命令的 --help/);
  } finally {
    await d.close();
  }
});

// ── the local API ────────────────────────────────────────────────────────

test("ADR-159: the language routes, the web UI's pack (public), health's language, and the invalid-input error by Accept-Language", async () => {
  const { createApp } = await import("../packages/daisy/src/app.ts");
  const root = tmp();
  const dir = join(root, "data");
  mkdirSync(dir, { recursive: true });
  const ctx = await createApp({ dataDir: dir, workspaceHome: root, workspaceRoots: [root] });
  try {
    const h = { authorization: `Bearer ${ctx.issueToken()}` };
    let r = await ctx.app.inject({ url: "/api/settings/language", headers: h });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().setting, null);
    assert.deepEqual(
      r.json().available.map((a: any) => a.lang),
      ["en", "zh-CN"],
    );
    assert.deepEqual(r.json().available.map((a: any) => a.name), ["English", "简体中文"]);
    // Set: written to config.json; health says it (no session needed).
    r = await ctx.app.inject({ method: "PUT", url: "/api/settings/language", headers: h, payload: { language: "en" } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().setting, "en");
    assert.equal(r.json().effective, "en");
    assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).language, "en");
    r = await ctx.app.inject({ url: "/api/health" });
    assert.equal(r.json().language, "en");
    // No Accept-Language: the owner's language; with one: that.
    r = await ctx.app.inject({ method: "PUT", url: "/api/settings/language", headers: h, payload: { language: 3 } });
    assert.equal(r.statusCode, 400);
    assert.deepEqual([r.json().code, r.json().error], ["invalid_input", "Invalid parameters"]);
    assert.equal(r.headers["content-language"], "en");
    r = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/language",
      headers: { ...h, "accept-language": "zh-CN,zh;q=0.9" },
      payload: { language: 3 },
    });
    assert.deepEqual([r.json().code, r.json().error], ["invalid_input", "参数格式错误"]);
    // An unknown language: a stable code, the text in the asked language.
    r = await ctx.app.inject({ method: "PUT", url: "/api/settings/language", headers: { ...h, "accept-language": "en" }, payload: { language: "fr" } });
    assert.deepEqual([r.statusCode, r.json().code, r.json().error], [400, "language_unknown", "No such language: fr"]);
    r = await ctx.app.inject({ method: "PUT", url: "/api/settings/language", headers: { ...h, "accept-language": "zh-CN" }, payload: { language: "fr" } });
    assert.equal(r.json().error, "没有这个语言：fr");
    // Back to following the system.
    r = await ctx.app.inject({ method: "PUT", url: "/api/settings/language", headers: h, payload: { language: null } });
    assert.equal(r.json().setting, null);
    // The web UI's pack: public, its areas only, matched from a browser's tag.
    r = await ctx.app.inject({ url: "/api/locales/zh-Hans-CN?areas=ui,common" });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().lang, "zh-CN");
    assert.equal(r.json().messages["ui.settings.title"], "设置");
    assert.equal(r.json().messages["common.language.name"], "简体中文");
    assert.ok(Object.keys(r.json().messages).every((k) => /^(ui|ui-[\w-]+|common|common-[\w-]+)\./.test(k)));
    r = await ctx.app.inject({ url: "/api/locales/en" });
    assert.equal(r.json().messages["ui.settings.title"], "Settings");
    assert.ok("cli.status.notRunning" in r.json().messages);
    r = await ctx.app.inject({ url: "/api/locales/fr", headers: { "accept-language": "en" } });
    assert.deepEqual([r.statusCode, r.json().code], [404, "language_unknown"]);
    // The AI's working credential never reaches the setting (daisy:manage).
    r = await ctx.app.inject({ method: "PUT", url: "/api/settings/language", payload: { language: "en" } });
    assert.equal(r.statusCode, 401);
  } finally {
    await ctx.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the web UI ───────────────────────────────────────────────────────────

test("ADR-159: the web UI speaks the pack it loaded, sends its language to the server, and the settings page has the switch", async () => {
  const { languageChoices, setUiPack, t, uiLanguageLoaded } = await import("../packages/ui/src/i18n.ts");
  const { DaisyClient } = await import("../packages/client/src/index.ts");
  const before = DaisyClient.language;
  try {
    const pick = (l: string) =>
      Object.fromEntries(Object.entries({ ...shipped.packs.en, ...shipped.packs[l] }).filter(([k]) => /^(ui|common)\./.test(k)));
    setUiPack("en", pick("en"));
    assert.equal(uiLanguageLoaded(), true);
    assert.equal(t("ui.settings.title"), "Settings");
    assert.equal(t("ui.settings.introHosted", { host: "Host" }), "Profiles, working folders and the PIN. This machine's entry points and updates are managed in Host.");
    assert.equal(DaisyClient.language, "en");
    setUiPack("zh-CN", pick("zh-CN"));
    assert.equal(t("ui.settings.title"), "设置");
    assert.equal(DaisyClient.language, "zh-CN");
    // The client sends it.
    const seen: string[] = [];
    const c = new DaisyClient("http://x", "tok", {
      fetch: async (_u: string, init: any) => {
        seen.push(init.headers["Accept-Language"]);
        return new Response(JSON.stringify({ lang: "zh-CN", fallback: "en", messages: {} }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await c.locales("zh-CN", ["ui"]);
    assert.deepEqual(seen, ["zh-CN"]);
    assert.deepEqual(
      languageChoices({ available: [{ lang: "en", name: "English" }, { lang: "zh-CN", name: "简体中文" }] }).map((x) => x.value),
      [null, "en", "zh-CN"],
    );
  } finally {
    DaisyClient.language = before;
  }
  const settings = readFileSync("packages/ui/src/settings.tsx", "utf8");
  assert.match(settings, /<LanguageSettings client=\{client\} \/>/);
  const app = readFileSync("apps/app/App.tsx", "utf8");
  assert.match(app, /await loadUiLanguage\(new DaisyClient\(url, ""\), h\.language\)/);
});

// ── the ratchet on Chinese in source ─────────────────────────────────────

test("ADR-159 §5: the scanner sees strings, templates and JSX text, not comments or regular expressions", () => {
  const src = [
    "// 注释",
    "/* 块注释 */ const a = 1;",
    'const b = "中文";',
    "const c = `模板 ${x ? `内层 ${y}` : '单引号'}`;",
    "const r = /[一-龥]/.test(s);",
    "const j = <Text>界面文字</Text>;",
    "const k = {/* JSX 注释 */};",
    "const d = a / 2; const e = '中';",
  ].join("\n");
  assert.deepEqual(cjkLines(src), [3, 4, 6, 8]);
  assert.equal(stripComments("x // 中\ny").split("\n").length, 2);
  // P6-25: JSX text starting with `/` after a tag is text, not a pattern; after `=>` it is a pattern.
  assert.deepEqual(cjkLines(["const j = <Text>/compact 压缩</Text>;", "const f = (x) => /中/.test(x);", "const g = a >= /中/.source;"].join("\n")), [1]);
});

test("ADR-159 §5: Chinese left in source only where tests/i18n-pending.json allows it, and the allowance only goes down", () => {
  const pending: Record<string, number> = JSON.parse(readFileSync(PENDING_FILE, "utf8"));
  // P6-24: lines kept for good (with a reason each) are not pending.
  const kept = readKept();
  const scanned = scan();
  const problems: string[] = [];
  for (const [f, k] of Object.entries(kept)) {
    if (!k.why?.trim() || !(k.lines > 0)) problems.push(`${KEPT_FILE}: ${f} needs a positive number of lines and a reason`);
    if ((scanned[f] ?? 0) < k.lines) problems.push(`${f}: ${scanned[f] ?? 0} lines now, ${k.lines} kept — lower it in ${KEPT_FILE}`);
  }
  const now = Object.fromEntries(
    Object.entries(scanned)
      .map(([f, n]) => [f, n - (kept[f]?.lines ?? 0)] as const)
      .filter(([, n]) => n > 0),
  );
  for (const [f, n] of Object.entries(now)) {
    const allowed = pending[f] ?? 0;
    if (n > allowed)
      problems.push(
        allowed
          ? `${f}: ${n} lines with Chinese, ${allowed} allowed — put the new text in the language packs (packages/contracts/locales)`
          : `${f}: ${n} lines with Chinese in a converted file — put the text in the language packs (packages/contracts/locales)`,
      );
  }
  for (const [f, n] of Object.entries(pending)) {
    const actual = now[f] ?? 0;
    if (actual < n) problems.push(`${f}: ${actual} lines now, ${n} allowed — lower it in ${PENDING_FILE} (remove the entry at 0)`);
  }
  assert.deepEqual(problems, []);
  // The converted slice stays converted.
  for (const f of [
    "packages/daisy/src/cli/main.ts",
    "packages/daisy/src/cli/daisy.ts",
    "packages/daisy/src/cli/errors.ts",
    "packages/daisy/src/cli/lang.ts",
    "packages/daisy/src/app/language.ts",
    "packages/daisy/src/platform/language.ts",
    "packages/ui/src/settings.tsx",
    "packages/ui/src/language-settings.tsx",
    "packages/ui/src/i18n.ts",
    // P6-24: the model-facing prompts.
    "packages/daisy/src/prompts/prompt-layers.ts",
    "packages/daisy/src/prompts/source-prompt.ts",
    "packages/daisy/src/a2a/ask-act-prompt.ts",
    "packages/daisy/src/resident/prompt.ts",
    "packages/daisy/src/tools/daisy-tools.ts",
    "packages/daisy/src/turns/transcript-carry.ts",
    "packages/daisy/src/schedule/scheduler.ts",
    "packages/contracts/src/guide.ts",
    "packages/contracts/src/resident-prompt.ts",
    "packages/contracts/src/native-tools.ts",
    "packages/contracts/src/ask-sidecar.ts",
    "packages/contracts/src/title.ts",
    "packages/contracts/src/scheduler.ts",
    ...P6_22_FILES,
  ])
    assert.equal(pending[f], undefined, `${f} is converted: never in ${PENDING_FILE}`);
});
