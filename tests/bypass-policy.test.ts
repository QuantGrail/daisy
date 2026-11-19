// bypassPermissions (packages/daisy/src/approvals/bypass-policy.ts) on the
// P1-01 rules: until stage 4 rebuilds call authorization nobody else can
// reach a session — every new one is recorded private — so only residents
// (and turns their owner did not start) are kept out of bypass. The cases
// that turned on visibility / 群聊 are on tag baseline/pre-daisy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";
import { ownNode, runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";

const BYPASS = { permissionMode: "never", sandboxMode: "danger-full-access" };
const options = (dir: string) => ({
  pinGate: false,
  dataDir: dir,
  bootstrap: false,
  workspaceHome: dir,
  workspaceRoots: [dir],
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "daisy-bypass-"));
  const f: any = { dir };
  f.ctx = await createApp(options(dir));
  const uid = OWNER_ID;
  f.uid = uid;
  // Always the current app (restart() swaps it).
  f.call = (method: any, url: string, payload?: any, headers?: any) =>
    runnerInject(f.ctx.app, f.ctx.runnerApi)({
      method,
      url: "/api" + url,
      payload,
      headers: headers ?? {
        authorization: "Bearer " + f.ctx.issueToken(),
      },
    });
  // P1-02: no enrolment — alice's own node goes in directly.
  const node = ownNode(f.ctx.store, uid, "alice", "remote");
  f.nh = runnerHeaders(node.id);
  await f.call("POST", "/runner/sync", { capabilities: {} }, f.nh);
  f.w = (
    await f.call("POST", "/workspaces", {
      nodeId: node.id,
      label: "work",
      path: dir,
    })
  ).json();
  f.profile = async (label: string, agent = "codex") =>
    (
      await f.call("POST", "/profiles", {
        nodeId: node.id,
        agent,
        label,
        authMode: "subscription",
      })
    ).json();
  /** Claude Code offers no bypass in Daisy: a row older code or a hand edit left. */
  f.claudeBypass = (pid: string) =>
    f.ctx.store.run(
      "UPDATE profiles SET data=json_set(data,'$.permissionMode','bypassPermissions') WHERE id=?",
      pid,
    );
  f.create = async (profileId: string, extra: any = {}, agent = "codex") => {
    const r = await f.call("POST", "/sessions", {
      title: "solo",
      agent,
      workspaceId: f.w.id,
      profileId,
      ...extra,
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  /** A resident's record, written directly (no resident routes until stage 4). */
  f.resident = async (profileId: string, agent = "codex") => {
    const s = await f.create(profileId, {}, agent);
    f.ctx.store.save({
      ...f.ctx.store.session(s.id),
      kind: "resident",
      resident: {
        purpose: "盯构建",
        autoCompactTokens: null,
        maxTurnMinutes: null,
        dailyTurns: null,
        scope: { tasks: "bound" },
        createdAt: Date.now(),
      },
    });
    return f.ctx.store.session(s.id);
  };
  f.claim = async () =>
    (await f.call("POST", "/runner/claim", {}, f.nh)).json().job;
  f.finish = (job: any) =>
    f.call(
      "POST",
      `/runner/jobs/${job.id}/complete`,
      { status: "idle" },
      { ...f.nh, "x-lease": job.lease },
    );
  f.send = (sid: string, requestId: string) =>
    f.call("POST", `/sessions/${sid}/messages`, { requestId, text: "go" });
  f.data = (pid: string) =>
    JSON.parse(f.ctx.store.one("SELECT data FROM profiles WHERE id=?", pid).data);
  f.restart = async () => {
    await f.ctx.app.close();
    f.ctx = await createApp(options(dir));
  };
  f.close = async () => {
    await f.ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return f;
}

test("a bypass identity: sessions are created without saying private, recorded private, and their owner's turns run as configured", async () => {
  const f = await fixture();
  try {
    const p = await f.profile("wild");
    const patched = await f.call("PATCH", `/profiles/${p.id}`, BYPASS);
    assert.equal(patched.statusCode, 200, patched.body);
    // No visibility (the page no longer asks), and one that asks public:
    // both created, both private.
    const s = await f.create(p.id);
    const asked = await f.create(p.id, {
      visibility: "public",
      requestId: "bypass-public-01",
    });
    for (const x of [s, asked])
      assert.deepEqual(f.ctx.store.session(x.id).initialVisibility, {
        visibility: "private",
        visibleTo: [],
      });
    // The same requestId replays the same session.
    const again = await f.call("POST", "/sessions", {
      title: "solo",
      agent: "codex",
      workspaceId: f.w.id,
      profileId: p.id,
      visibility: "public",
      requestId: "bypass-public-01",
    });
    assert.equal(again.json().id, asked.id);
    assert.equal(again.json().duplicate, true);
    await f.send(s.id, "bypass-owner-01");
    const job = await f.claim();
    assert.equal(job.session.id, s.id);
    assert.equal(job.profile.permissionMode, "never");
    assert.equal(job.profile.sandboxMode, "danger-full-access");
    await f.finish(job);
    // Switching a private session to a bypass identity is not refused for it.
    const plainC = await f.profile("plain-c", "claude"),
      wildC = await f.profile("wild-c", "claude");
    f.claudeBypass(wildC.id);
    const s2 = await f.create(plainC.id, {}, "claude");
    const sw = await f.call("POST", `/sessions/${s2.id}/identity`, {
      profileId: wildC.id,
    });
    // Past the bypass check: it stops at the next one (this fake node's
    // Runner did not declare the identity carry).
    assert.doesNotMatch(sw.body, /跳过所有权限确认/);
    assert.equal(sw.json().code, "runner_outdated");
  } finally {
    await f.close();
  }
});

test("a turn its owner did not start (a Daisy wake) launches without bypass", async () => {
  const f = await fixture();
  try {
    const p = await f.profile("wild");
    await f.call("PATCH", `/profiles/${p.id}`, BYPASS);
    const s = await f.create(p.id);
    f.ctx.wakes.queue(s.id, "owner-approval:x:expired", "【事件】过期", null);
    const job = await f.claim();
    assert.equal(job.session.id, s.id);
    assert.equal(job.profile.permissionMode, undefined);
    assert.equal(job.profile.sandboxMode, undefined);
  } finally {
    await f.close();
  }
});

test("a resident never: its identity cannot be put in bypass, nor switched to one; a row that says so anyway launches without it", async () => {
  const f = await fixture();
  try {
    const plain = await f.profile("plain");
    const res = await f.resident(plain.id);
    const patch = await f.call("PATCH", `/profiles/${plain.id}`, BYPASS);
    assert.equal(patch.statusCode, 409, patch.body);
    assert.match(patch.json().error, /常驻 Agent/);
    // Claude Code (the identity switch is Claude Code's).
    const plainC = await f.profile("plain-c", "claude"),
      wildC = await f.profile("wild-c", "claude");
    f.claudeBypass(wildC.id);
    const resC = await f.resident(plainC.id, "claude");
    const sw = await f.call("POST", `/sessions/${resC.id}/identity`, {
      profileId: wildC.id,
    });
    assert.equal(sw.statusCode, 409, sw.body);
    assert.match(sw.json().error, /任务常驻 Agent 一律不能使用/);
    // Older code or a hand edit left the row in bypass: stripped at launch.
    f.ctx.store.run(
      "UPDATE profiles SET data=json_set(data,'$.permissionMode','never','$.sandboxMode','danger-full-access') WHERE id=?",
      plain.id,
    );
    await f.send(res.id, "bypass-res-msg-1");
    const job = await f.claim();
    assert.equal(job.session.id, res.id);
    assert.equal(job.profile.permissionMode, undefined);
    assert.equal(job.profile.sandboxMode, undefined);
  } finally {
    await f.close();
  }
});

test("at start: a bypass identity a resident uses goes back to the default once and its owner is told; unused ones are left alone", async () => {
  const f = await fixture();
  try {
    const used = await f.profile("used"),
      unused = await f.profile("unused");
    await f.resident(used.id);
    await f.call("PATCH", `/profiles/${unused.id}`, BYPASS);
    f.ctx.store.run(
      "UPDATE profiles SET data=json_set(data,'$.permissionMode','never','$.sandboxMode','danger-full-access') WHERE id=?",
      used.id,
    );
    await f.restart();
    assert.equal(f.data(used.id).permissionMode, undefined);
    assert.equal(f.data(used.id).sandboxMode, undefined);
    assert.equal(f.data(unused.id).permissionMode, "never", "unused: left alone");
    const downgrades = () =>
      f.ctx.store.all(
        "SELECT * FROM audit WHERE action='profile.bypass.downgrade'",
      ).length;
    assert.equal(downgrades(), 1);
    const notice = f.ctx.store.one(
      "SELECT * FROM notification_events WHERE user_id=? AND subject=?",
      f.uid,
      `notice:bypass:${used.id}`,
    );
    assert.equal(notice.kind, "approval");
    assert.equal(notice.action_required, 0);
    assert.match(notice.title, /已改回默认模式/);
    await f.restart();
    assert.equal(downgrades(), 1, "once");
  } finally {
    await f.close();
  }
});
