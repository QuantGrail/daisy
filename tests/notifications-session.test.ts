// P1-01: the notifications that belong to sessions — a turn ended, an
// approval card, a call waiting for approval, an AI that failed — kept
// when the chat's kinds (@ me, waiting for my reply, group mutes, unread
// badges) went. The writer, the approval card's notice, the preferences
// (kind × device) and their routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { Store, id } from "../packages/daisy/src/store/index.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";
import {
  LATEST_AGENT_RESULTS_SQL,
  approvalNotices,
  notificationWriter,
  rowNotificationId,
} from "../packages/daisy/src/sessions/notifications.ts";
import {
  NOTIFICATION_KINDS,
  defaultNotificationMatrix,
  notificationAlert,
  notificationCategory,
} from "../packages/contracts/src/notifications.ts";

const rows = (store: Store, uid: string) =>
  store
    .all(
      "SELECT kind,op,item_key,revision,session_id,subject,action_required,close_state FROM notification_events WHERE user_id=? ORDER BY seq",
      uid,
    )
    .map((r: any) => ({ ...r }));

test("the registry has the session kinds only (P6-14: a plugin's kinds are declared by the plugin)", () => {
  assert.deepEqual(
    [...NOTIFICATION_KINDS],
    ["approval", "task", "ai_private_message", "ai_failed"],
  );
  for (const gone of [
    "mention",
    "needs_reply",
    "reply_to_me",
    "dm_message",
    "group_message",
  ])
    assert.equal(notificationCategory(gone), null, gone);
  assert.equal(notificationCategory("approval"), "approval");
});

test("writer: idempotent by key, one stable item per notificationId, retract closes it once", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-notify-"));
  const store = new Store(dir);
  try {
    const n = notificationWriter(store);
    assert.equal(n, notificationWriter(store));
    const w = {
      userId: "u1",
      kind: "ai_failed" as const,
      key: "k1",
      title: "研究：出错了",
      sessionId: "s1",
      subject: "job-1",
    };
    assert.ok(n.emit(w));
    assert.equal(n.emit(w), null);
    n.emit({ ...w, key: "k2", notificationId: "ai_failed:job-1" });
    assert.ok(n.retract({ userId: "u1", notificationId: "ai_failed:job-1" }));
    assert.equal(
      n.retract({ userId: "u1", notificationId: "ai_failed:job-1" }),
      null,
    );
    const r = rows(store, "u1");
    assert.deepEqual(
      r.map((x) => [x.op, x.item_key, x.revision, x.session_id]),
      [
        ["create", "ai_failed:job-1", 1, "s1"],
        ["update", "ai_failed:job-1", 2, "s1"],
        ["retract", "ai_failed:job-1", 3, ""],
      ],
    );
    assert.equal(r[2].close_state, "handled");
    assert.equal(rowNotificationId({ kind: "x", subject: "", event_key: "e" }), "x:e");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approval card: opens as action required for its owner, closes by how it ended", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-notify-"));
  const store = new Store(dir);
  try {
    const notice = approvalNotices(store);
    notice("u1", "perm:a1", "pending", "AI 请求权限：Bash", "s1");
    notice("u1", "perm:a1", "approved", "已允许");
    notice("u1", "block:b1", "pending", "拦截");
    notice("u1", "block:b1", "expired", "过期");
    notice("u1", "call-1", "pending", "bob 请求调用你的 AI");
    notice("u1", "call-1", "canceled", "撤回");
    // Closing something not open does nothing.
    notice("u1", "never", "rejected", "x");
    const r = rows(store, "u1");
    assert.deepEqual(
      r.map((x) => [x.op, x.item_key, x.action_required, x.close_state]),
      [
        ["create", "approval:perm:a1", 1, ""],
        ["retract", "approval:perm:a1", 0, "handled"],
        ["create", "approval:block:b1", 1, ""],
        ["retract", "approval:block:b1", 0, "expired"],
        ["create", "approval:call-1", 1, ""],
        ["retract", "approval:call-1", 0, "canceled"],
      ],
    );
    assert.equal(r[0].kind, "approval");
    assert.equal(r[0].subject, "perm:a1");
    assert.equal(r[0].session_id, "s1");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("一轮结束: the latest finished turn per owned session, never an older one under a running turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-notify-"));
  const store = new Store(dir);
  try {
    const save = (sid: string) =>
      store.save({
        id: sid,
        ownerId: "u1",
        title: sid,
        agent: "claude",
        nodeId: "n",
        workspaceId: "w",
        profileId: "p",
        nativeId: null,
        task: null,
        status: "idle",
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      } as any);
    save("s1");
    save("s2");
    let t = 1000;
    const job = (sid: string, status: string) =>
      store.run(
        "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created) VALUES(?,?,?,?,?,?,?,?)",
        id(),
        sid,
        "n",
        id(),
        "x",
        "[]",
        status,
        t++,
      );
    job("s1", "completed");
    job("s2", "completed");
    job("s2", "running");
    const got = store
      .all(LATEST_AGENT_RESULTS_SQL, "u1")
      .map((r: any) => [r.session_id, r.status]);
    assert.deepEqual(got, [["s1", "completed"]]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("alert rule: kind × device, retracts and expired items never alert", () => {
  const p = { matrix: defaultNotificationMatrix() };
  assert.deepEqual(
    notificationAlert(p, { category: "approval", device: "web" }),
    { alert: true, reason: "ok" },
  );
  p.matrix.ai_failed.mobile = false;
  assert.equal(
    notificationAlert(p, { category: "ai_failed", device: "mobile" }).reason,
    "kind-off",
  );
  assert.equal(
    notificationAlert(p, { category: "ai_failed", device: "web" }).alert,
    true,
  );
  assert.equal(
    notificationAlert(p, { category: "approval", device: "web", op: "retract" })
      .reason,
    "retract",
  );
  assert.equal(
    notificationAlert(p, { category: null, device: "web", expiresAt: 1 }, 2)
      .reason,
    "expired",
  );
});

test("preferences routes: /api/notification-preferences — own record, revision guard, platform mirror, check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-notify-"));
  const ctx = await createApp({ pinGate: false, dataDir: dir, bootstrap: false });
  try {
    const uid = OWNER_ID;
    const h = { authorization: "Bearer " + ctx.issueToken() };
    const call = (method: any, url: string, payload?: any) =>
      ctx.app.inject({ method, url: "/api" + url, payload, headers: h });
    const base = "/notification-preferences";
    const v = (await call("GET", base)).json();
    assert.equal(v.revision, 0);
    assert.deepEqual(
      v.kinds.map((k: any) => k.id),
      [...NOTIFICATION_KINDS],
    );
    assert.equal(v.groups, undefined);
    assert.equal(v.mentionsOnly, undefined);
    const p = await call("PATCH", base, {
      revision: 0,
      device: "mobile",
      matrix: { ai_failed: { mobile: false } },
    });
    assert.equal(p.statusCode, 200);
    assert.equal(p.json().revision, 1);
    assert.equal(p.json().matrix.ai_failed.mobile, false);
    assert.equal(p.json().updatedFrom, "mobile");
    // Lost update refused; chat fields are not accepted any more.
    assert.equal((await call("PATCH", base, { revision: 0 })).statusCode, 409);
    for (const body of [
      { mentionsOnly: true },
      { mutedGroups: [{ id: "g", muted: true }] },
      { badgeMode: "all" },
      { matrix: { mention: { web: false } } },
    ])
      assert.equal((await call("PATCH", base, body)).statusCode, 400);
    // the platform mirrors, then lets go.
    const m = await call("PUT", base + "/platform", {
      revision: 1,
      matrix: { approval: { web: false } },
      platformRevision: 7,
      settingsUrl: "/settings/notifications",
    });
    assert.equal(m.statusCode, 200);
    assert.equal(m.json().managedBy.revision, 7);
    assert.equal(
      (await call("DELETE", base + "/platform?revision=2")).json().managedBy,
      null,
    );
    const c = (
      await call("POST", base + "/check", {
        device: "mobile",
        items: [
          { category: "ai_failed" },
          { category: "approval", expiresAt: 1 },
        ],
      })
    ).json();
    assert.deepEqual(
      c.results.map((r: any) => [r.alert, r.reason, r.permanent]),
      [
        [false, "kind-off", true],
        [false, "expired", true],
      ],
    );
    // The chat's notification routes are gone.
    for (const url of [
      "/communication/notification-preferences",
      "/communication/notifications",
      "/communication/notifications/history",
    ])
      assert.equal((await call("GET", url)).statusCode, 404, url);
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
