/**
 * P6-23b (ADR-159 §3, §11): the server's own words — LocalizedError (and
 * look-alikes from shared packages) said in the request's language, and
 * `ownerT()` for what the server says outside a request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { englishText, isLocalized, LocalizedError, msg } from "../packages/daisy/src/app/errors.ts";
import { ownerT, setOwnerDataDir, setOwnerLanguage } from "../packages/daisy/src/platform/language.ts";

test("ADR-159 §3: a LocalizedError keeps its code and key; its message is the English text", () => {
  const e = new LocalizedError(404, "language_unknown", "api.error.languageUnknown", { lang: "fr" });
  assert.equal(e.statusCode, 404);
  assert.equal(e.code, "language_unknown");
  assert.equal(e.message, englishText("api.error.languageUnknown", { lang: "fr" }));
  assert.match(e.message, /fr/);
  assert.equal(isLocalized(e), true);
  const m = msg("api.error.languageUnknown", { lang: "de" });
  const of = LocalizedError.of(400, "language_unknown", m);
  assert.deepEqual([of.key, of.params], ["api.error.languageUnknown", { lang: "de" }]);
  // A look-alike from a package that cannot import the class.
  assert.equal(isLocalized({ localized: true, key: "api.error.invalidInput" }), true);
  assert.equal(isLocalized(new Error("x")), false);
});

test("ADR-159 §11: ownerT — the owner's setting, else the system locale (DAISY_LANG counts), re-read without a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-owner-lang-"));
  const saved = process.env.DAISY_LANG;
  try {
    process.env.DAISY_LANG = "zh-CN";
    setOwnerDataDir(dir);
    assert.equal(ownerT().lang, "zh-CN");
    setOwnerLanguage(dir, "en");
    setOwnerDataDir(dir); // drops the one-second cache, as a new start would
    assert.equal(ownerT().lang, "en");
    assert.equal(ownerT()("common.language.name"), "English");
  } finally {
    if (saved === undefined) delete process.env.DAISY_LANG;
    else process.env.DAISY_LANG = saved;
    setOwnerDataDir(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADR-159 §6: inSessionT — the session's language when it has one, else the owner's", async () => {
  const { inSessionT: sessionT } = await import("../packages/daisy/src/platform/language.ts");
  const { turnT } = await import("../packages/daisy/src/harness/model-switch.ts");
  const dir = mkdtempSync(join(tmpdir(), "daisy-session-lang-"));
  try {
    setOwnerLanguage(dir, "zh-CN");
    setOwnerDataDir(dir);
    assert.equal(sessionT("en").lang, "en");
    assert.equal(sessionT("en-GB").lang, "en");
    assert.equal(sessionT("xx").lang, "zh-CN");
    assert.equal(sessionT(null).lang, "zh-CN");
    // The Runner's words (P6-17 turnT) follow the owner's setting, not only the system's.
    setOwnerLanguage(dir, "en");
    setOwnerDataDir(dir);
    assert.equal(turnT().lang, "en");
    assert.equal(turnT("zh-CN").lang, "zh-CN");
  } finally {
    setOwnerDataDir(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P6-23b: a local command's language reaches the server modules it uses (autostart / update hints) and contracts' helpers", async () => {
  const { setCliLanguage, t } = await import("../packages/daisy/src/cli/lang.ts");
  const { setProcessLanguage } = await import("../packages/daisy/src/platform/language.ts");
  const { launchdHint } = await import("../packages/daisy/src/platform/autostart.ts");
  const { noSourceText } = await import("../packages/daisy/src/update/package.ts");
  const { defaultTranslate } = await import("../packages/contracts/src/i18n-default.ts");
  const was = t.lang;
  try {
    setCliLanguage("en");
    assert.equal(ownerT().lang, "en");
    assert.equal(defaultTranslate().lang, "en");
    assert.doesNotMatch(launchdHint() + noSourceText(), /[一-鿿]/);
    setCliLanguage("zh-CN");
    assert.match(launchdHint(), /[一-鿿]/);
  } finally {
    setCliLanguage(was);
    setProcessLanguage(undefined);
  }
});
