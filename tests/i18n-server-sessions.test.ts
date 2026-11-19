/**
 * P6-23b (ADR-159 §3, §11): the server's words about approvals, call
 * requests, sessions, the queue and the database — in both shipped
 * languages. The Chinese texts are pinned by the existing tests (tests
 * default to zh-CN); these check the English side and that the stable
 * `code`s do not change with the language.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { translator } from "../packages/contracts/src/i18n.ts";
import { shippedPacks } from "../packages/contracts/src/i18n-node.ts";
import { rewindNotice } from "../packages/daisy/src/sessions/commands.ts";
import { midTurnMarker, wakeBase } from "../packages/daisy/src/sessions/native-append.ts";
import { openDatabase } from "../packages/daisy/src/store/open.ts";
import { setOwnerDataDir, setOwnerLanguage } from "../packages/daisy/src/platform/language.ts";

const en = translator(shippedPacks(), "en");
const zh = translator(shippedPacks(), "zh-CN");

test("P6-23b: an approval error answers in the request's language with the same code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-i18n-approvals-"));
  const ctx = await createApp({ pinGate: false, dataDir: dir, bootstrap: false, workspaceHome: dir, workspaceRoots: [dir] });
  try {
    const h = { authorization: "Bearer " + ctx.issueToken() };
    const ask = (lang: string) =>
      ctx.app.inject({ method: "GET", url: "/api/approvals/ask:nope", headers: { ...h, "accept-language": lang } });
    const a = await ask("en");
    assert.equal(a.statusCode, 404);
    assert.equal(a.json().code, "approval_not_found");
    assert.equal(a.json().error, "No such approval");
    assert.equal(a.headers["content-language"], "en");
    const b = await ask("zh-CN");
    assert.equal(b.json().code, "approval_not_found");
    assert.equal(b.json().error, "审批不存在");
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P6-23b: the rewind notice and the mid-turn line in English", () => {
  const r = rewindNotice(2, { files: { reverted: true, via: "fallback", filesChanged: ["a", "b"], notRestored: [{ path: "x.bin", why: "too-large" }] } }, "codex", en);
  assert.match(r, /^Rewound 2 turns/);
  assert.match(r, /2 files the AI changed/);
  assert.match(r, /x\.bin \(file too large/);
  assert.ok(!/[一-鿿]/.test(r), r);
  assert.match(rewindNotice(1, { completed: true }, "kimi", en), /Kimi Code cannot undo file changes/);
  assert.match(rewindNotice(1, { completed: true }, "kimi", zh), /Kimi Code 不支持/);
  const at = Date.UTC(2026, 0, 1, 1, 0);
  assert.equal(
    midTurnMarker(at, at, en),
    "(Your owner added this while you were working, sent at 01:00, time zone UTC; you were already working on this turn's task)",
  );
});

test("P6-23b: a wake item's delivery tail is cut off in any language, and the old Chinese tails still are", () => {
  assert.equal(wakeBase({ text: "callback A (appended to the running turn, waiting for the AI to read it)", tail: " (appended to the running turn, waiting for the AI to read it)" }), "callback A");
  assert.equal(wakeBase({ text: "回调 A（已追加进正在运行的一轮，等待 AI 读取）" }), "回调 A");
  assert.equal(wakeBase({ text: "回调 A（没被本轮读取，下一轮送达）" }), "回调 A");
  assert.equal(wakeBase({ text: "plain" }), "plain");
});

test("P6-23b: a start problem from the database is said in the owner's language", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-i18n-store-"));
  try {
    writeFileSync(join(dir, "daisy.sqlite"), "not a database at all, long enough to have a header ".repeat(4));
    setOwnerLanguage(dir, "en");
    setOwnerDataDir(dir);
    assert.throws(() => openDatabase(dir), (e: Error) => /is not a Daisy database/.test(e.message) && !/[一-鿿]/.test(e.message));
    setOwnerLanguage(dir, "zh-CN");
    setOwnerDataDir(dir);
    assert.throws(() => openDatabase(dir), /不是 Daisy 的数据库/);
  } finally {
    setOwnerDataDir(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
