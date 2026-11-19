// P6-14 (ADR-157 § P6-14): the notification kinds are the core's own plus
// the ones an installed plugin declares through the public seam
// (`notificationKinds` of DaisyServerPlugin). Without the plugin its kind is
// not offered anywhere (not in GET's kinds, not in the matrix, not
// writable), but what a person stored for it is kept untouched and counts
// again the moment the plugin is back — no data loss.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { Store } from "../packages/daisy/src/store/index.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";
import { notificationPreferences } from "../packages/daisy/src/sessions/notification-preferences.ts";
import {
  NOTIFICATION_KINDS,
  defaultNotificationMatrix,
  notificationKinds,
  kindInLanguage,
  pluginText,
} from "../packages/contracts/src/notifications.ts";
import { packT } from "./ui-pack.ts";

const CORE = ["approval", "task", "ai_private_message", "ai_failed"];
/** A plugin's kind, as the test plugin tests/plugins/session-tag declares it. */
const TAG = { id: "tag_review", label: "标签复核", hint: "测试插件的通知", default: false };

const stored = (store: Store, uid: string) =>
  JSON.parse(
    store.one("SELECT body FROM notification_preferences WHERE user_id=?", uid)
      ?.body ?? "{}",
  );

test("P6-14: the core's kinds name no plugin; a plugin's declared kinds follow them", () => {
  assert.deepEqual([...NOTIFICATION_KINDS], CORE);
  assert.deepEqual(notificationKinds().map((k) => k.id), CORE);
  assert.deepEqual(Object.keys(defaultNotificationMatrix()), CORE);
  const all = notificationKinds([TAG]);
  assert.deepEqual(all.map((k) => k.id), [...CORE, "tag_review"]);
  assert.deepEqual(all.at(-1), { ...TAG, declared: { label: TAG.label, hint: TAG.hint } });
  // A declared kind without `hint` / `default`: "" and on.
  assert.deepEqual(notificationKinds([{ id: "x1", label: "X" }]).at(-1), {
    id: "x1",
    label: "X",
    hint: "",
    default: true,
    declared: { label: "X" },
  });
  assert.deepEqual(defaultNotificationMatrix(all).tag_review, { web: false, mobile: false });
  // Refused: a core kind, a duplicate, a bad id, no label.
  for (const bad of [
    [{ id: "approval", label: "x" }],
    [TAG, { ...TAG }],
    [{ id: "Bad-Id", label: "x" }],
    [{ id: "retract", label: "x" }],
    [{ id: "ok", label: "" }],
    [{ id: "ok", label: "x".repeat(41) }],
    // P6-28: per-language words — each a non-empty text, keyed by a language tag.
    [{ id: "ok", label: {} }],
    [{ id: "ok", label: { en: "" } }],
    [{ id: "ok", label: { "not a tag": "x" } }],
    [{ id: "ok", label: { en: "x".repeat(41) } }],
    [{ id: "ok", label: "x", hint: { en: 3 } }],
  ])
    assert.throws(() => notificationKinds(bad as any), /通知种类/);
  // P6-22: the core kinds' names and the refusals in English (the UI passes its translator).
  const en = packT("en");
  assert.deepEqual(notificationKinds([], en).map((k) => k.label), ["Approvals", "Tasks", "AI sessions", "AI errors"]);
  assert.equal(notificationKinds([], packT("zh-CN"))[0]!.label, "审批");
  assert.throws(() => notificationKinds([{ id: "approval", label: "x" }], en), /Notification kind "approval" already exists/);
});

test("P6-28: a plugin declares its kind's words per language; each reader gets theirs (the closest tag, else English, else the first)", () => {
  const decl = { id: "hello_ping", label: { en: "Greeting", "zh-CN": "问候" }, hint: { en: "A greeting", "zh-CN": "问候一下" } };
  const [k] = notificationKinds([decl], packT("en")).slice(-1);
  assert.deepEqual([k!.label, k!.hint], ["Greeting", "A greeting"]);
  assert.deepEqual(kindInLanguage(k!, packT("zh-CN")), { id: "hello_ping", label: "问候", hint: "问候一下" });
  assert.deepEqual(kindInLanguage(k!, packT("en")), { id: "hello_ping", label: "Greeting", hint: "A greeting" });
  assert.equal(pluginText({ "zh-CN": "问候", en: "Greeting" }, "zh-Hans-CN"), "问候");
  assert.equal(pluginText({ "zh-CN": "问候", en: "Greeting" }, "fr"), "Greeting");
  assert.equal(pluginText({ "zh-CN": "问候" }, "fr"), "问候");
  // One string (as before P6-28): the same words in every language.
  const [one] = notificationKinds([{ id: "x1", label: "X" }]).slice(-1);
  assert.equal(kindInLanguage(one!, packT("en")).label, "X");
  // The core's kinds follow the reader too.
  assert.equal(kindInLanguage(notificationKinds([], packT("zh-CN"))[0]!, packT("en")).label, "Approvals");
});

test("P6-14: a stored preference for an undeclared kind is kept but ignored, and counts again once declared", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-notify-kinds-"));
  const store = new Store(dir);
  try {
    const uid = "u1";
    // Written while a plugin declared `tag_review` (and an older Daisy's `sudo`).
    const withTag = notificationPreferences(store, notificationKinds([TAG]));
    withTag.save(uid, { matrix: { tag_review: { web: true, mobile: false } } as any });
    store.run(
      "UPDATE notification_preferences SET body=json_set(body,'$.matrix.sudo',json('{\"web\":false,\"mobile\":true}')) WHERE user_id=?",
      uid,
    );
    // The plugin is gone: its kind is not in the matrix …
    const core = notificationPreferences(store);
    assert.deepEqual(Object.keys(core.load(uid).matrix), CORE);
    // … and a change made meanwhile keeps what was stored for it.
    core.save(uid, { matrix: { approval: { web: false } } });
    const body = stored(store, uid);
    assert.deepEqual(body.matrix.tag_review, { web: true, mobile: false });
    assert.deepEqual(body.matrix.sudo, { web: false, mobile: true });
    assert.equal(body.matrix.approval.web, false);
    // Writing it without the plugin: refused (400), nothing changes.
    assert.throws(
      () => core.save(uid, { matrix: { tag_review: { web: false } } as any }),
      (e: any) => e.statusCode === 400 && /tag_review/.test(e.message),
    );
    assert.deepEqual(stored(store, uid).matrix.tag_review, { web: true, mobile: false });
    // The plugin is back: its stored cells count again.
    const back = notificationPreferences(store, notificationKinds([TAG])).load(uid);
    assert.deepEqual(back.matrix.tag_review, { web: true, mobile: false });
    assert.equal(back.matrix.approval.web, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withApp(plugins: string[], run: (call: (method: string, url: string, payload?: any) => Promise<any>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-notify-kinds-"));
  const ctx = await createApp({ pinGate: false, dataDir: dir, bootstrap: false, plugins });
  try {
    const h = { authorization: "Bearer " + ctx.issueToken() };
    await run((method, url, payload) =>
      ctx.app.inject({ method: method as any, url: "/api/notification-preferences" + url, payload, headers: h }),
    );
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("P6-14: without a plugin no plugin kind is offered — GET, PATCH, the platform mirror and check", async () => {
  await withApp([], async (call) => {
    const v = (await call("GET", "")).json();
    assert.deepEqual(v.kinds.map((k: any) => k.id), CORE);
    assert.deepEqual(Object.keys(v.matrix), CORE);
    assert.ok(!JSON.stringify(v).includes("sudo"), "no sudo anywhere");
    const p = await call("PATCH", "", { matrix: { sudo: { web: false } } });
    assert.equal(p.statusCode, 400);
    assert.match(p.json().error ?? p.json().message ?? "", /sudo/);
    // The platform mirrors the kinds Daisy has; others are left out (not stored).
    const m = await call("PUT", "/platform", {
      revision: 0,
      matrix: { sudo: { web: false }, approval: { mobile: false } },
      platformRevision: 1,
      settingsUrl: "/settings/notifications",
    });
    assert.equal(m.statusCode, 200);
    assert.equal(m.json().matrix.approval.mobile, false);
    assert.equal(m.json().matrix.sudo, undefined);
    // An undeclared category is an unknown kind: alerts unless expired.
    const c = (
      await call("POST", "/check", { device: "web", items: [{ category: "sudo" }, { category: "sudo", expiresAt: 1 }] })
    ).json();
    assert.deepEqual(c.results.map((r: any) => r.reason), ["ok", "expired"]);
  });
});

test("P6-14: an installed plugin's declared kind is offered with its label and default, writable and honoured", async () => {
  await withApp(["session-tag"], async (call) => {
    const v = (await call("GET", "")).json();
    assert.deepEqual(v.kinds.map((k: any) => k.id), [...CORE, "tag_review"]);
    assert.deepEqual(v.kinds.at(-1), { id: "tag_review", label: TAG.label, hint: TAG.hint });
    assert.deepEqual(v.matrix.tag_review, { web: false, mobile: false });
    const p = await call("PATCH", "", { revision: 0, matrix: { tag_review: { web: true } } });
    assert.equal(p.statusCode, 200);
    assert.deepEqual(p.json().matrix.tag_review, { web: true, mobile: false });
    const c = (
      await call("POST", "/check", { device: "mobile", items: [{ category: "tag_review" }] })
    ).json();
    assert.deepEqual(c.results.map((r: any) => r.reason), ["kind-off"]);
  });
});
