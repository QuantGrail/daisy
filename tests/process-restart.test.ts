import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { runNode, type NodeConfig } from "../packages/daisy/src/turns/worker.ts";
import {
  ProcessRestart,
  RestartRefused,
  describeBusy,
  supervision,
} from "../packages/daisy/src/update/restart.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import type { Snapshot } from "../packages/contracts/src/index.ts";
import { runnerConfig } from "./fixtures/runner-calls.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";

// P1-02: restarting / updating the whole process. Control plane and
// Runner are one process (D-02): a restart ends the harness processes too,
// and a cut-off turn is never replayed (原则 2). So a restart waits until
// nothing runs; the owner may restart now only after being told what it
// interrupts; the interrupted turns end as 「中断」 and nothing reruns.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SUPERVISED = {
  supervised: true,
  manager: "systemd" as const,
  platform: "linux",
};

test("ProcessRestart: no Runner / not supervised refuses; now names what it interrupts and needs confirm; cancel", () => {
  const r = new ProcessRestart(() => {});
  assert.throws(() => r.request("idle"), /没有运行 Runner/);
  let busy: any[] = [];
  const detach = r.attach({
    busy: () => busy,
    supervision: { ...SUPERVISED, supervised: false, reason: "不是常驻服务" },
  });
  assert.throws(() => r.request("idle"), /不是常驻服务/);
  detach();
  r.attach({ busy: () => busy, supervision: SUPERVISED });
  // Nothing runs: now is just a restart.
  assert.equal(r.request("now").mode, "now");
  assert.equal(r.cancel(), true);
  assert.equal(r.requested(), null);
  busy = [
    { kind: "turn", sessionId: "s1", id: "j1" },
    { kind: "turn", sessionId: "s2", id: "j2" },
    { kind: "online", sessionId: "s3" },
    { kind: "login", id: "l1" },
  ];
  let refused: RestartRefused | undefined;
  try {
    r.request("now");
  } catch (e) {
    refused = e as RestartRefused;
  }
  assert.ok(refused instanceof RestartRefused);
  assert.deepEqual(refused.interrupts, busy);
  assert.match(refused.message, /2 个会话正在执行的一轮/);
  assert.match(refused.message, /不会自动重做/);
  assert.equal(r.requested(), null, "an unconfirmed now is not kept");
  // A bare yes is no confirmation: the token of the list seen is.
  assert.throws(() => r.request("now", { confirm: "yes" }), RestartRefused);
  const seen = refused.confirm!;
  // Something new started since that list: refused again, the new list.
  busy = [...busy, { kind: "turn", sessionId: "s4", id: "j4" }];
  let again: RestartRefused | undefined;
  try {
    r.request("now", { confirm: seen });
  } catch (e) {
    again = e as RestartRefused;
  }
  assert.ok(again instanceof RestartRefused);
  assert.match(again.message, /又有新的工作开始/);
  assert.deepEqual(again.interrupts!.map((b) => b.id), ["j1", "j2", undefined, "l1", "j4"]);
  assert.equal(r.requested(), null);
  const now = r.request("now", { confirm: again.confirm, by: "u1" });
  assert.equal(r.requested(), now);
  assert.deepEqual(now.confirmed!.length, 5);
  // Less than confirmed (something ended) is still covered.
  busy = busy.slice(1);
  r.cancel();
  assert.equal(r.request("now", { confirm: again.confirm }).mode, "now");
  r.cancel();
  // An idle request is kept while things run (the loop waits).
  const idle = r.request("idle");
  assert.equal(r.requested(), idle);
  assert.equal(r.status().idle, false);
  assert.equal(
    describeBusy(busy),
    "2 个会话正在执行的一轮、1 个在线 AI 手上的工作、1 个进行中的登录",
  );
  r.done(idle);
  assert.equal(r.requested(), null);
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "daisy-restart-"));
  const restart = new ProcessRestart(() => {});
  const ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
    restart,
  });
  const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const uid = OWNER_ID;
  const c = new DaisyClient(url, ctx.issueToken());
  process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
  const config: NodeConfig = {
    ...runnerConfig(ctx, join(dir, "runner.json")),
    selfRestart: true,
    restartRequestIdleMs: 300,
    autoUpdate: false,
    identityRoot: join(dir, "state"),
  };
  const controller = new AbortController();
  const worker = runNode(config, controller.signal, restart);
  let exited: any = null;
  void worker.then((x) => (exited = x ?? "stopped"));
  const cat = await c.catalog();
  const s = await c.create({
    agent: "codex",
    title: "长任务",
    profileId: cat.profiles.find((p) => p.agent === "codex")!.id,
    workspaceId: cat.workspaces[0].id,
  });
  const until = async (accept: (x: Snapshot) => boolean) => {
    for (let i = 0; i < 150; i++) {
      const x = await c.snapshot(s.id);
      if (accept(x)) return x;
      await delay(100);
    }
    throw Error("State timed out");
  };
  return {
    dir,
    ctx,
    c,
    s,
    until,
    exited: () => exited,
    async close() {
      controller.abort();
      await worker.catch(() => {});
      await ctx.app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test(
  "restart when idle: a running turn holds it (named in GET /api/update), it goes once the turn ends; nothing interrupted",
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    try {
      await f.c.send(f.s.id, "WAIT_UNTIL_CANCEL");
      await f.until((x) => x.session.status === "running");
      const asked = await f.c.request<any>("/update/restart", "POST", {
        mode: "idle",
      });
      assert.equal(asked.request.mode, "idle");
      assert.ok(
        asked.waitingFor.some(
          (b: any) => b.kind === "turn" && b.session?.title === "长任务",
        ),
      );
      await delay(1500);
      assert.equal(f.exited(), null, "never while a turn runs");
      const st = await f.c.request<any>("/update");
      assert.equal(st.idle, false);
      assert.equal(st.request.mode, "idle");
      assert.match(st.summary, /1 个会话正在执行的一轮/);
      // The turn ends (here: its owner stops it) — then the restart goes.
      await f.c.cancel(f.s.id);
      for (let i = 0; i < 100 && !f.exited(); i++) await delay(100);
      assert.equal(f.exited().requested.mode, "idle");
      const job = f.ctx.store.one(
        "SELECT status FROM jobs WHERE session_id=?",
        f.s.id,
      );
      assert.equal(job.status, "interrupted", "stopped by its owner");
      assert.ok(
        f.ctx.store.one(
          "SELECT 1 x FROM audit WHERE action='process.restart.idle'",
        ),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "restart now: refused with the list of what it interrupts; confirmed, the turn ends 「中断」 with a notice and is not replayed",
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    try {
      await f.c.send(f.s.id, "WAIT_UNTIL_CANCEL");
      await f.until((x) => x.session.status === "running");
      const refused = await f.ctx.app.inject({
        method: "POST",
        url: "/api/update/restart",
        headers: { authorization: `Bearer ${f.c.token}` },
        payload: { mode: "now" },
      });
      assert.equal(refused.statusCode, 409);
      const body = refused.json();
      assert.equal(body.code, "restart_interrupts");
      assert.match(body.error, /立即重启会打断 1 个会话正在执行的一轮/);
      assert.deepEqual(
        body.interrupts.map((b: any) => [b.kind, b.sessionId]),
        [["turn", f.s.id]],
      );
      assert.equal(typeof body.confirm, "string");
      await delay(800);
      assert.equal(f.exited(), null, "an unconfirmed now does nothing");
      // A second conversation starts a turn after the owner saw the list:
      // the old confirmation does not cover it — 409 again, the new list.
      const cat = await f.c.catalog();
      const s2 = await f.c.create({
        agent: "codex",
        title: "后来的",
        profileId: cat.profiles.find((p) => p.agent === "codex")!.id,
        workspaceId: cat.workspaces[0].id,
      });
      await f.c.send(s2.id, "WAIT_UNTIL_CANCEL");
      for (let i = 0; i < 100; i++) {
        if ((await f.c.snapshot(s2.id)).session.status === "running") break;
        await delay(100);
      }
      const stale = await f.ctx.app.inject({
        method: "POST",
        url: "/api/update/restart",
        headers: { authorization: `Bearer ${f.c.token}` },
        payload: { mode: "now", confirm: body.confirm },
      });
      assert.equal(stale.statusCode, 409);
      assert.match(stale.json().error, /又有新的工作开始/);
      assert.deepEqual(
        stale.json().interrupts.map((b: any) => b.sessionId).sort(),
        [f.s.id, s2.id].sort(),
      );
      await delay(500);
      assert.equal(f.exited(), null);
      const confirmed = await f.c.request<any>("/update/restart", "POST", {
        mode: "now",
        confirm: stale.json().confirm,
      });
      assert.deepEqual(
        confirmed.interrupts.map((b: any) => b.sessionId).sort(),
        [f.s.id, s2.id].sort(),
      );
      for (let i = 0; i < 100 && !f.exited(); i++) await delay(100);
      assert.equal(f.exited().requested.mode, "now");
      const done = await f.until((x) => x.session.status !== "running");
      const jobs = f.ctx.store.all(
        "SELECT status FROM jobs WHERE session_id=?",
        f.s.id,
      );
      assert.deepEqual(
        jobs.map((j: any) => j.status),
        ["interrupted"],
        "one job, interrupted, no rerun",
      );
      // The conversation says why the turn ended (R-1: 中断, not replayed).
      const why = await f.until((x) =>
        x.items.some((i: any) => /立即重启.*没有重放/.test(i.text || "")),
      );
      assert.ok(why);
      assert.ok(
        f.ctx.store.one(
          "SELECT target FROM audit WHERE action='process.restart.now'",
        ).target.includes(f.s.id),
        "the audit names what was interrupted",
      );
    } finally {
      await f.close();
    }
  },
);

test("restart API: the owner's credential only; a process without a supervisor refuses (exiting would only stop it)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-restart-api-"));
  const restart = new ProcessRestart(() => {});
  const ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
    restart,
  });
  try {
    const admin = OWNER_ID;
    const call = (uid: string | null, method: any, payload?: any) =>
      ctx.app.inject({
        method,
        url: "/api/update/restart",
        headers: uid ? { authorization: `Bearer ${ctx.issueToken()}` } : {},
        payload,
      });
    // P1-03: no other accounts — without a credential it is refused.
    assert.equal((await call(null, "POST", { mode: "idle" })).statusCode, 401);
    // No Runner attached here.
    const none = await call(admin, "POST", { mode: "idle" });
    assert.equal(none.statusCode, 409);
    assert.equal(none.json().code, "restart_unavailable");
    restart.attach({
      busy: () => [],
      supervision: supervision({ env: {}, parentName: () => "bash" }),
    });
    const hand = await call(admin, "POST", { mode: "now" });
    assert.equal(hand.statusCode, 409);
    assert.match(hand.json().error, /不是常驻服务/);
    assert.equal((await call(admin, "DELETE")).json().cancelled, false);
    // A confirmed 立即 dropped by the loop (work started after the
    // confirmation): GET /api/update says when, why and what.
    let busy: any[] = [{ kind: "turn", id: "j1", sessionId: "s1" }];
    restart.attach({
      busy: () => busy,
      supervision: { supervised: true, manager: "systemd", platform: "linux" },
    });
    let token = "";
    try {
      restart.request("now");
    } catch (e: any) {
      token = e.confirm;
    }
    const r = restart.request("now", { confirm: token });
    busy = [...busy, { kind: "online", sessionId: "s2" }];
    restart.dropNow(r, [busy[1]]);
    assert.equal(restart.requested(), null);
    const st = (
      await ctx.app.inject({
        url: "/api/update",
        headers: { authorization: `Bearer ${ctx.issueToken()}` },
      })
    ).json();
    assert.equal(st.request, null);
    assert.equal(st.lastCancelled.mode, "now");
    assert.match(st.lastCancelled.reason, /确认之后又开始了 1 个在线 AI 手上的工作/);
    assert.deepEqual(
      st.lastCancelled.extra.map((b: any) => [b.kind, b.sessionId]),
      [["online", "s2"]],
    );
    assert.ok(st.lastCancelled.at > 0);
    // The next request clears it.
    busy = [];
    restart.request("idle");
    assert.equal(restart.status().lastCancelled, null);
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Moved from tests/node-restart.test.ts (the per-node restart went with
// P1-02; this one is about the process restart that stays).
test("runner supervision: systemd, another supervisor (DAISY_RUNNER_SELF_RESTART=1), or by hand (with why)", () => {
  const sd = supervision({
    env: { INVOCATION_ID: "x" },
    parentName: () => "systemd",
    platform: "linux",
    unit: () => "daisy.service",
  });
  assert.deepEqual(sd, {
    supervised: true,
    manager: "systemd",
    unit: "daisy.service",
    platform: "linux",
  });
  // DAISY_RUNNER_SELF_RESTART=1: some other supervisor. P6-01 (ADR-151):
  // a LaunchAgent label an old launch script used (any label but
  // DAISY_LAUNCHD_LABEL's) is not taken for a launchd unit (P5-04).
  for (const label of ["com.example.agent-node", "com.apple.Terminal"])
    assert.deepEqual(
      supervision({
        env: { DAISY_RUNNER_SELF_RESTART: "1", XPC_SERVICE_NAME: label },
        parentName: () => "sh",
        platform: "darwin",
      }),
      { supervised: true, manager: "supervise", platform: "darwin" },
    );
  const hand = supervision({
    env: {},
    parentName: () => "bash",
    platform: "linux",
  });
  assert.equal(hand.supervised, false);
  assert.equal(hand.manager, "none");
  assert.match(hand.reason!, /不是常驻服务/);
  const off = supervision({
    env: { INVOCATION_ID: "x", DAISY_RUNNER_SELF_RESTART: "0" },
    parentName: () => "systemd",
    unit: () => "daisy.service",
  });
  assert.equal(off.supervised, false);
  assert.match(off.reason!, /已关闭/);
  assert.equal(supervision({ selfRestart: true, env: {} }).supervised, true);
});
