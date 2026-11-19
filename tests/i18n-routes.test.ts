/**
 * P6-23a (ADR-159 §7, D-44 ①): the route table's text lives in the
 * language packs — every route's summary, its reasons (no command, not
 * letting anyone in, not audited, planned removal), every field
 * description, answer name and validation message is a pack key, complete
 * in English and Chinese. The generated command help and docs/api come out
 * in the reader's language (docs/api: English only), and the generated
 * commands speak English with `--lang en`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  API_GROUPS,
  API_ROUTES,
  apiMarkdown,
  cliCommands,
  cliHelp,
  documentedBody,
  exemptText,
  inputJsonSchema,
  isExempt,
  routeText,
  type AnyRoute,
} from "../packages/contracts/src/api/index.ts";
import { API_VERSION } from "../packages/contracts/src/index.ts";
import { translator } from "../packages/contracts/src/i18n.ts";
import { loadPacks } from "../packages/contracts/src/i18n-node.ts";
import { pinRuleError, PIN_RULE_PARAMS } from "../packages/contracts/src/api/pin.ts";
import { cjkLines } from "../scripts/i18n-scan.ts";
import { apiDocFiles, API_DOC_LANG } from "../scripts/gen-api-docs.ts";
import { daisy, testIo } from "./cli-fixture.ts";

const packs = loadPacks().packs;
const en = translator(packs, "en");
const zh = translator(packs, "zh-CN");
const LANGS = ["en", "zh-CN"] as const;
const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/;
const has = (key: string) => LANGS.every((l) => key in packs[l]!);

/** Every `description` in a JSON Schema, nested ones too. */
function descriptions(js: unknown, out: string[] = []): string[] {
  if (Array.isArray(js)) for (const x of js) descriptions(x, out);
  else if (js && typeof js === "object")
    for (const [k, v] of Object.entries(js)) {
      if (k === "description" && typeof v === "string") out.push(v);
      else descriptions(v, out);
    }
  return out;
}
const schemasOf = (r: AnyRoute) =>
  [r.params, r.query, documentedBody(r), r.body, r.output.schema].filter((s): s is NonNullable<typeof s> => !!s);

test("P6-23a: every route's text is a key in both packs — summary, reasons, field descriptions, answer names", () => {
  for (const r of API_ROUTES) {
    assert.ok(has(`api.route.${r.id}.summary`), `${r.id}: no summary in the packs`);
    if (isExempt(r.cli)) {
      const key = typeof r.cli.exempt === "string" ? r.cli.exempt : `api.route.${r.id}.exempt`;
      assert.ok(has(key), `${r.id}: no reason for having no command (${key})`);
    }
    if (r.notLetIn) assert.ok(has(`api.route.${r.id}.notLetIn`), `${r.id}: notLetIn without its reason`);
    if (r.removal) assert.ok(has(`api.route.${r.id}.removal`), `${r.id}: removal without its reason`);
    for (const s of schemasOf(r))
      for (const d of descriptions(inputJsonSchema(s)))
        assert.ok(/^api\./.test(d) && has(d), `${r.id}: field description is not a pack key: ${d.slice(0, 60)}`);
    if (/^api\./.test(r.output.name)) assert.ok(has(r.output.name), `${r.id}: answer name ${r.output.name}`);
    assert.ok(!CJK.test(r.output.name), `${r.id}: answer name in Chinese`);
  }
});

test("P6-23a: no stale route text — every api.route.<id>.<part> key belongs to a route that has that part", () => {
  const ids = new Map(API_ROUTES.map((r) => [r.id, r]));
  for (const key of Object.keys(packs.en!).filter((k) => k.startsWith("api.route."))) {
    const m = /^api\.route\.([a-z0-9]+\.[A-Za-z0-9]+)\.(summary|description|exempt|notLetIn|auditWhy|removal|field\..+)$/.exec(key);
    assert.ok(m, `${key}: not a route text key`);
    const r = ids.get(m[1]!);
    assert.ok(r, `${key}: no route ${m[1]}`);
    if (m[2] === "exempt") assert.equal(r.cli && isExempt(r.cli) && r.cli.exempt, true, `${key}: the route has a command or a shared reason`);
    if (m[2] === "notLetIn") assert.ok(r.notLetIn, `${key}: the route does not say notLetIn`);
    if (m[2] === "auditWhy") assert.equal(r.audit, false, `${key}: the route is audited`);
    if (m[2] === "removal") assert.ok(r.removal, `${key}: the route has no planned removal`);
  }
  // Every quoted limit param is one the table fills.
  for (const r of API_ROUTES)
    for (const part of ["summary", "description"] as const) {
      const text = routeText(r.id, part, en) ?? "";
      assert.doesNotMatch(text, /\{[A-Za-z_]\w*\}/, `${r.id}.${part}: an unfilled {param}`);
    }
});

test("P6-23a: the route table's sources hold no Chinese", () => {
  for (const f of [
    "packages/contracts/src/api/route.ts",
    "packages/contracts/src/api/cli.ts",
    "packages/contracts/src/api/docs.ts",
    "packages/contracts/src/api/schema-info.ts",
    "packages/contracts/src/api/let-in.ts",
    "packages/contracts/src/api/index.ts",
    "packages/contracts/src/api/sessions.ts",
    "packages/contracts/src/api/settings.ts",
    "packages/contracts/src/api/devices.ts",
    "packages/contracts/src/api/pin.ts",
    "packages/daisy/src/cli/table.ts",
    "packages/daisy/src/cli/io.ts",
    "packages/daisy/src/cli/routes.ts",
    "packages/daisy/src/cli/local/doctor.ts",
    "packages/daisy/src/cli/local/process.ts",
    "scripts/gen-api-docs.ts",
    "scripts/gen-cli-docs.mjs",
  ])
    assert.deepEqual(cjkLines(readFileSync(f, "utf8")), [], `${f}: Chinese left in source`);
  // …and every key the command line's converted files name literally is in both packs.
  for (const f of [
    "packages/contracts/src/api/cli.ts",
    "packages/contracts/src/api/docs.ts",
    "packages/daisy/src/cli/table.ts",
    "packages/daisy/src/cli/io.ts",
    "packages/daisy/src/cli/routes.ts",
    "packages/daisy/src/cli/local/doctor.ts",
    "packages/daisy/src/cli/local/process.ts",
  ])
    for (const m of readFileSync(f, "utf8").matchAll(/(?<![\w])(?:t|t\.dynamic)\(\s*"([a-z][\w.-]*)"/g))
      assert.ok(has(m[1]!), `${f}: ${m[1]} is not in both packs`);
});

test("P6-23a: a command's --help in both languages — the same structure, the pack's words", () => {
  const byRoute = new Map(cliCommands(API_ROUTES).map((c) => [c.route, c]));
  const c = byRoute.get("profile.loginInput")!;
  const helpEn = cliHelp(c, en);
  assert.match(helpEn, /^Usage: daisy /);
  assert.match(helpEn, /--code\s+.*read from standard input or a prompt, never from the command line/);
  assert.match(helpEn, /API: POST /);
  assert.match(cliHelp(c, zh), /--code\s+授权码（从标准输入或提示读取，不接受命令行里的值，/);
  for (const cmd of byRoute.values()) {
    const text = cliHelp(cmd, en);
    assert.ok(!CJK.test(text), `${cmd.route}: Chinese in the English help:\n${text}`);
    assert.doesNotMatch(text, /\bapi\.(route|field)\./, `${cmd.route}: a key shown instead of its text`);
  }
});

test("P6-23a: exempt reasons, let-in rows and group titles are the packs' words in each language", () => {
  const r = API_ROUTES.find((x) => x.id === "settings.autostartStatus")!;
  assert.match(exemptText(r, zh)!, /由本地命令 daisy autostart/);
  assert.match(exemptText(r, en)!, /local command daisy autostart/);
  const md = apiMarkdown({ routes: API_ROUTES, groups: API_GROUPS, apiVersion: API_VERSION, t: en });
  assert.match(md, /^# Local API/);
  assert.match(md, /## Call grants/);
  assert.match(md, /> Lets someone in \(/);
  assert.ok(!CJK.test(md), "docs/api in English has no Chinese");
  const mdZh = apiMarkdown({ routes: API_ROUTES, groups: API_GROUPS, apiVersion: API_VERSION, t: zh });
  assert.match(mdZh, /^# 本机接口/);
  assert.match(mdZh, /> 放别人进来（/);
});

test("ADR-159 §7: docs/api is written in English only", () => {
  assert.equal(API_DOC_LANG, "en");
  for (const [rel, text] of Object.entries(apiDocFiles())) assert.ok(!CJK.test(text), `${rel} has Chinese`);
});

test("P6-23a: the PIN rule and the route schemas' own messages are pack keys", () => {
  assert.equal(pinRuleError("123"), "api.pin.rule.length");
  assert.equal(pinRuleError("1234567\n"), "api.pin.rule.control");
  assert.equal(pinRuleError("12345678"), null);
  assert.match(en("api.pin.rule.length", PIN_RULE_PARAMS), /6 to 128 characters/);
  assert.match(zh("api.pin.rule.length", PIN_RULE_PARAMS), /PIN 要 6 到 128 位/);
  for (const k of Object.keys(packs.en!).filter((k) => k.startsWith("api.validation."))) assert.ok(has(k), k);
});

test("P6-23a: a generated command speaks English with --lang en — usage errors and its help", async () => {
  const io = () => testIo({ env: { DAISY_LANG: "en" } });
  let r = await daisy(io(), "/nonexistent-daisy-data", "session", "list", "--bogus");
  assert.equal(r.code, 2);
  assert.match(r.err, /daisy session list has no option --bogus/);
  assert.ok(!CJK.test(r.err), r.err);
  r = await daisy(io(), "/nonexistent-daisy-data", "session", "show");
  assert.match(r.err, /missing argument <id>/);
  r = await daisy(io(), "/nonexistent-daisy-data", "session", "show", "s1", "--tail", "x");
  assert.match(r.err, /--tail takes a number/);
  r = await daisy(io(), "/nonexistent-daisy-data", "session", "create", "--help");
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage: daisy session create \[options\]/);
  assert.match(r.out, /Create a session/);
  assert.match(r.out, /Common options:/);
  assert.match(r.out, /--idempotency-key <key>/);
  assert.ok(!CJK.test(r.out), r.out);
  // The same in Chinese (the tests' default language).
  r = await daisy(testIo(), "/nonexistent-daisy-data", "session", "list", "--bogus");
  assert.match(r.err, /daisy session list 没有选项 --bogus/);
});

test("P6-23a: doctor and the pairing code speak English with --lang en", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "daisy-i18n-doctor-"));
  try {
    // Nothing real runs: no harness on PATH or in this HOME, every program "missing".
    const env = { PATH: "", HOME: dir, DAISY_CLAUDE_BIN: join(dir, "no-claude"), DAISY_CODEX_BIN: join(dir, "no-codex") };
    const exec = () => ({ code: 127, stdout: "", stderr: "", missing: true });
    const r = await daisy(testIo({ env: { ...env, DAISY_LANG: "en" }, exec }), dir, "doctor");
    assert.match(r.out, /^Daisy self-check \(read-only: changes nothing, shows no credential\)/);
    assert.match(r.out, /Data directory: /);
    assert.match(r.out, /Claude Code: not installed/);
    assert.match(r.out, /What to do: to use it, install it first: npm install -g @anthropic-ai\/claude-code \(or the official install script\)/);
    const zhOut = (await daisy(testIo({ env, exec }), dir, "doctor")).out;
    assert.match(zhOut, /^Daisy 自检（只读/);
    assert.match(zhOut, /Claude Code：没有安装/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const { renderPairingCode } = await import("../packages/daisy/src/cli/table.ts");
  const { setCliLanguage } = await import("../packages/daisy/src/cli/lang.ts");
  const lines: string[] = [];
  setCliLanguage("en");
  try {
    renderPairingCode(
      { code: "ABCD-EFGH", url: "https://example.test/#code=ABCD-EFGH", expiresAt: Date.now() + 10 * 60_000 },
      { io: { ...testIo(), out: (s: string) => lines.push(s) } } as any,
    );
  } finally {
    setCliLanguage("zh-CN");
  }
  const text = lines.join("\n");
  assert.match(text, /Pairing code: ABCD-EFGH/);
  assert.match(text, /Valid for 10 minutes, once/);
  assert.ok(!CJK.test(text), text);
});
