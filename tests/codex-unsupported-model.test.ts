// P6-17 (phase-6 outsider acceptance): a fresh install's first Codex turn
// failed with "The 'gpt-6.2-sol' model is not supported when using Codex
// with a ChatGPT account." Daisy's host-login identity names no model
// (bootstrap writes model ""), so the model was the host Codex config's.
// - No model chosen in Daisy + the config's model is not in the account's
//   own model list: the thread starts on the list's default instead, and
//   the conversation says so.
// - A model the owner chose is sent as chosen; when Codex refuses it the
//   error says what to do (model picker → 读取原生模型列表).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  codexModelInstead,
  runCodex,
} from "../packages/daisy/src/harness/codex.ts";
import { unsupportedModelHint } from "../packages/daisy/src/harness/model-switch.ts";
import type { Runtime } from "../packages/daisy/src/harness/shared.ts";
import { translator } from "../packages/contracts/src/i18n.ts";
import { shippedPacks } from "../packages/contracts/src/i18n-node.ts";

const catalogFile = resolve("tests/fixtures/codex-model-list.json");
const catalog = JSON.parse(readFileSync(catalogFile, "utf8"));
const MEASURED =
  "The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account.";
const ENV = [
  "DAISY_CODEX_BIN",
  "DAISY_FIXTURE_RECORD_THREAD",
  "DAISY_FIXTURE_CODEX_CATALOG",
  "DAISY_FIXTURE_CODEX_CONFIG_MODEL",
  "DAISY_FIXTURE_CODEX_UNSUPPORTED",
];
const dirs: string[] = [];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("codexModelInstead: only an unlisted model on a complete list is replaced, by the list's default", () => {
  // Listed (also hidden ones, by id or model name): kept.
  assert.equal(codexModelInstead(catalog, "gpt-6-luna"), undefined);
  assert.equal(codexModelInstead(catalog, "gpt-reserve"), undefined);
  // Not listed: the visible default.
  assert.equal(codexModelInstead(catalog, "gpt-6.2-sol"), "gpt-6-astra");
  // No default marked: the first visible one.
  const noDefault = {
    data: catalog.data.map((m: any) => ({ ...m, isDefault: false })),
  };
  assert.equal(codexModelInstead(noDefault, "gpt-6.2-sol"), "gpt-6-astra");
  // Unknown: no list, an empty one, a partial page, nothing visible.
  for (const list of [
    undefined,
    null,
    {},
    { data: [] },
    { ...catalog, nextCursor: "more" },
    { data: [{ id: "x", model: "x", hidden: true }] },
  ])
    assert.equal(codexModelInstead(list, "gpt-6.2-sol"), undefined);
  // Nothing configured: nothing to replace.
  assert.equal(codexModelInstead(catalog, ""), undefined);
});

test("unsupportedModelHint: Codex's model refusals get the way out; other errors stay as they are", () => {
  const hint = unsupportedModelHint(MEASURED)!;
  assert.match(hint, /gpt-6\.2-sol/);
  assert.match(hint, /读取原生模型列表/);
  assert.ok(hint.endsWith(MEASURED), "the engine's own words are kept");
  for (const raw of [
    "The model `gpt-x` does not exist or you do not have access to it.",
    '{"detail":"Unsupported model"}',
    "model_not_found: gpt-x",
  ])
    assert.match(unsupportedModelHint(raw) ?? "", /读取原生模型列表/, raw);
  // English (ADR-159): the same way out, the engine's words kept.
  const en = unsupportedModelHint(MEASURED, translator(shippedPacks(), "en"))!;
  assert.match(en, /can't use the model gpt-6\.2-sol/);
  assert.match(en, /Read native model list/);
  assert.ok(en.endsWith(MEASURED));
  assert.match(
    unsupportedModelHint("model_not_found", translator(shippedPacks(), "en"))!,
    /can't use the current model/,
  );
  for (const raw of [
    "Codex turn failed",
    "stream disconnected before completion",
    "Method not found",
    "",
  ])
    assert.equal(unsupportedModelHint(raw), null, raw);
});

function fakeCodex(configModel: string) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-codex-model-"));
  dirs.push(dir);
  const record = join(dir, "record.jsonl");
  process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
  process.env.DAISY_FIXTURE_RECORD_THREAD = record;
  process.env.DAISY_FIXTURE_CODEX_CATALOG = catalogFile;
  process.env.DAISY_FIXTURE_CODEX_CONFIG_MODEL = configModel;
  process.env.DAISY_FIXTURE_CODEX_UNSUPPORTED = "gpt-6.2-sol";
  return () =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
}
function runtime(model: string, events: any[]): Runtime {
  return {
    job: {
      id: "first-turn",
      session: { agent: "codex", nativeId: null },
      profile: { authMode: "subscription", model },
      attachments: [],
    } as any,
    cwd: process.cwd(),
    prompt: "用一句话介绍你自己",
    files: [],
    signal: new AbortController().signal,
    emit: (type, data) => events.push({ type, data }),
    flush: async () => {},
    approve: async () => ({ optionId: "accept" }),
  };
}

test("host login, no model chosen, the host config's model not on the account's list: the first turn runs on the list's default", async () => {
  const records = fakeCodex("gpt-6.2-sol"),
    events: any[] = [];
  await runCodex(runtime("", events));
  const start = records().find((r) => r.via === "thread/start");
  assert.equal(start.model, "gpt-6-astra");
  // What the session runs with, as reported.
  const models = events
    .filter((e) => e.type === "native" && e.data.model)
    .map((e) => e.data.model);
  assert.ok(models.length);
  assert.ok(models.every((m) => m === "gpt-6-astra"), models.join());
  // The conversation says what happened, once.
  const notices = events.filter(
    (e) => e.type === "item" && e.data.kind === "notice" && /gpt-6\.2-sol/.test(e.data.text),
  );
  assert.ok(notices.length >= 1);
  assert.match(notices[0].data.text, /gpt-6-astra/);
  assert.equal(notices[0].data.name, "换了模型");
});

test("the notice speaks the process's language (DAISY_LANG=en)", async () => {
  fakeCodex("gpt-6.2-sol");
  const was = process.env.DAISY_LANG,
    events: any[] = [];
  process.env.DAISY_LANG = "en";
  try {
    await runCodex(runtime("", events));
  } finally {
    process.env.DAISY_LANG = was;
  }
  const notice = events.find(
    (e) => e.type === "item" && e.data.kind === "notice" && /gpt-6\.2-sol/.test(e.data.text),
  );
  assert.equal(notice.data.name, "Model changed");
  assert.match(notice.data.text, /not in this account's native model list, so this session uses gpt-6-astra/);
});

test("host config's model on the account's list: no model is sent (Codex's own choice stands)", async () => {
  const records = fakeCodex("gpt-6-luna"),
    events: any[] = [];
  await runCodex(runtime("", events));
  const start = records().find((r) => r.via === "thread/start");
  assert.equal(start.model, undefined);
  assert.ok(
    !events.some(
      (e) => e.type === "item" && e.data.kind === "notice" && /gpt-6-luna/.test(e.data.text),
    ),
  );
});

test("a model the owner chose is sent as chosen; Codex refusing it fails the turn with the way out", async () => {
  const records = fakeCodex(""),
    events: any[] = [];
  await assert.rejects(
    () => runCodex(runtime("gpt-6.2-sol", events)),
    (e: Error) =>
      /读取原生模型列表/.test(e.message) &&
      e.message.includes(MEASURED),
  );
  const start = records().find((r) => r.via === "thread/start");
  assert.equal(start.model, "gpt-6.2-sol");
});
