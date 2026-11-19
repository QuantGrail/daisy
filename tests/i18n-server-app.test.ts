/**
 * P6-23b (ADR-159 §3, §11): the server's own words — the local API's
 * errors (`LocalizedError`, by Accept-Language, the `code` unchanged),
 * restart / update / autostart refusals said in any language, the owner's
 * language for words outside a request (`ownerT`), stored results said
 * in the reader's language, and the Chinese of older stored text still
 * recognised. Both languages; the Chinese ones stay asserted elsewhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { translator } from "../packages/contracts/src/i18n.ts";
import { shippedPacks } from "../packages/contracts/src/i18n-node.ts";
import { LocalizedError } from "../packages/daisy/src/app/errors.ts";
import { ownerT, setOwnerLanguage, textsInEveryLanguage } from "../packages/daisy/src/platform/language.ts";
import { describeBusy, ProcessRestart, RestartRefused } from "../packages/daisy/src/update/restart.ts";
import { targetRefusal, UpdateRefused, validSource } from "../packages/daisy/src/update/package.ts";
import { sayAutostart } from "../packages/daisy/src/platform/autostart.ts";

const en = translator(shippedPacks(), "en");
const zh = translator(shippedPacks(), "zh-CN");
const tmp = () => mkdtempSync(join(tmpdir(), "daisy-i18n-server-"));

test("P6-23b: a LocalizedError's message is English (logs), its code stable; the API says it by Accept-Language", async () => {
  const e = new LocalizedError(404, "session_not_found", "server-app.session.notFound");
  assert.equal(e.message, "No such session");
  assert.equal(e.code, "session_not_found");
  const { createApp } = await import("../packages/daisy/src/app.ts");
  const root = tmp();
  const dir = join(root, "data");
  mkdirSync(dir, { recursive: true });
  const ctx = await createApp({ dataDir: dir, workspaceHome: root, workspaceRoots: [root] });
  try {
    const h = { authorization: `Bearer ${ctx.issueToken()}` };
    let r = await ctx.app.inject({ url: "/api/sessions/nope", headers: { ...h, "accept-language": "en" } });
    assert.deepEqual([r.statusCode, r.json().code, r.json().error], [404, "session_not_found", "No such session"]);
    assert.equal(r.headers["content-language"], "en");
    r = await ctx.app.inject({ url: "/api/sessions/nope", headers: { ...h, "accept-language": "zh-CN" } });
    assert.deepEqual([r.statusCode, r.json().code, r.json().error], [404, "session_not_found", "会话不存在"]);
    // A refused attachment: the size limit as a param.
    r = await ctx.app.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { ...h, "accept-language": "en" },
      payload: { name: "a", mime: "text/plain", data: "%%%" },
    });
    assert.deepEqual([r.statusCode, r.json().code], [400, "attachment_encoding"]);
    assert.match(r.json().error, /not encoded correctly/);
    // The update status: the busy summary and why it cannot restart, in the request's language.
    r = await ctx.app.inject({ url: "/api/update", headers: { ...h, "accept-language": "en" } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().summary, "nothing");
    r = await ctx.app.inject({ url: "/api/update", headers: { ...h, "accept-language": "zh-CN" } });
    assert.equal(r.json().summary, "没有");
    // No npm updater here: refused with its code, said in English.
    r = await ctx.app.inject({ method: "POST", url: "/api/update/check", headers: { ...h, "accept-language": "en" } });
    if (r.statusCode === 409) {
      assert.equal(r.json().code, "update_unavailable");
      assert.doesNotMatch(r.json().error, /[一-鿿]/);
    }
  } finally {
    await ctx.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("P6-23b: restart and update refusals are said in the reader's language; ownerT follows the owner's setting", () => {
  const busy = [
    { kind: "turn", sessionId: "s1", id: "j1" },
    { kind: "login", id: "l1" },
  ] as any[];
  assert.equal(describeBusy(busy, en), "a running turn in 1 session(s), 1 sign-in(s) in progress");
  assert.equal(describeBusy(busy, zh), "1 个会话正在执行的一轮、1 个进行中的登录");
  const r = new ProcessRestart(() => {});
  r.attach({ busy: () => busy, supervision: { supervised: true, manager: "systemd" } as any });
  try {
    r.request("now");
    assert.fail("refused");
  } catch (e) {
    assert.ok(e instanceof RestartRefused);
    assert.match(e.say(en), /^Restarting now would interrupt a running turn in 1 session/);
    assert.match(e.say(zh), /^立即重启会打断 1 个会话正在执行的一轮/);
  }
  const refusal = targetRefusal({ version: "1.0.0", release: "r1" } as any, "r1", false);
  assert.ok(refusal);
  assert.equal(refusal(en), "r1 is the running release");
  assert.equal(refusal(zh), "r1 就是正在运行的版本");
  try {
    validSource("relative/dir");
    assert.fail("refused");
  } catch (e) {
    assert.ok(e instanceof UpdateRefused);
    assert.match(e.say(en), /must be an absolute path/);
    assert.match(e.say(zh), /要写绝对路径/);
  }
  const a = sayAutostart(
    { key: "server-platform.autostart.noUserManager", fixKey: "server-platform.autostart.fixUserSession", failed: { stderr: "", code: 3 } },
    en,
  );
  assert.equal(a.why, "Cannot reach your systemd user instance (systemctl --user: exit code 3)");
  assert.match(a.fix, /normal login session/);

  // Outside a request: the owner's setting wins over the system's (tests run zh-CN).
  const plain = tmp();
  const english = tmp();
  try {
    assert.equal(ownerT(plain).lang, "zh-CN");
    setOwnerLanguage(english, "en");
    assert.equal(ownerT(english).lang, "en");
    assert.equal(ownerT(english)("server-update.busy.none"), "nothing");
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(english, { recursive: true, force: true });
  }
});

test("P6-23b: stored text is recognised in every language (the queue's wake suffix)", () => {
  const all = textsInEveryLanguage("server-app.queue.wakeExpiredSuffix");
  assert.ok(all.includes("（没被读取，已过期）"));
  assert.ok(all.includes(" (not read, expired)"));
});
