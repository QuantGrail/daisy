import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { schedulerLimits } from "../packages/daisy/src/schedule/scheduler.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import { BackgroundManager } from "../packages/daisy/src/schedule/background.ts";
import { RestartDrain } from "../packages/daisy/src/update/restart-drain.ts";
import { DaisyToolHost } from "../packages/daisy/src/tools/daisy-tools.ts";
import { SCHEDULE_LIMITS } from "../packages/contracts/src/scheduler.ts";
import { delay, setup, tool, until } from "./fixtures/scheduler-harness.ts";
import { runnerFetch, runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";
/**
 * Background results are never dropped (kept, retried, carried by the next turn), per-node /
 * per-session limits, monitor wakes throttled in step with the daily
 * budget, and background work no longer holds a Runner restart forever.
 */

/** A control plane without a Runner: jobs stay where the scheduler put them. */
async function plane(app: Partial<Parameters<typeof createApp>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-robust-"));
  const ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
    ...app,
  });
  const inject = runnerInject(ctx.app, ctx.runnerApi);
  const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const uid = OWNER_ID;
  const c = new DaisyClient(url, ctx.issueToken());
  const rc = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
  const cat = await c.catalog();
  const create = (title = "robust") =>
    c.create({
      agent: "codex",
      title,
      profileId: cat.profiles.find((p) => p.agent === "codex")!.id,
      workspaceId: cat.workspaces[0].id,
    });
  /** The Runner's side of the API (its node token). */
  const runner = runnerFetch(ctx.runnerApi(rc.nodeId));
  const bg = async (sid: string, kind: "bash" | "monitor" = "bash") =>
    (
      await runner(`/sessions/${sid}/schedules`, {
        kind,
        command: kind === "bash" ? "make test" : "tail -f log",
        description: kind === "bash" ? "跑测试" : "看日志",
      })
    ).schedule;
  const event = (sid: string, rid: string, body: any) =>
    runner(`/sessions/${sid}/schedules/${rid}/event`, body);
  const row = (rid: string) =>
    ctx.store.one("SELECT * FROM agent_schedules WHERE id=?", rid);
  const schedules = async (sid: string) =>
    (await c.request(`/sessions/${sid}/schedules`)).schedules as any[];
  const jobs = (sid: string) =>
    ctx.store.all(
      "SELECT * FROM jobs WHERE session_id=? ORDER BY created, rowid",
      sid,
    );
  const fill = (sid: string, n = 20) =>
    ctx.store.atomic(() => {
      for (let i = 0; i < n; i++)
        ctx.store.run(
          "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created) VALUES(?,?,?,?,?,?,?,?)",
          `filler-${sid}-${i}`,
          sid,
          rc.nodeId,
          `filler-${sid}-${i}`,
          "x",
          "[]",
          "pending",
          Date.now(),
        );
    });
  const unfill = (sid: string) =>
    ctx.store.run("DELETE FROM jobs WHERE id LIKE ?", `filler-${sid}-%`);
  /**
   * The Runner claims the next queued turn (/api/runner/claim): the text it
   * is given (kept reports are taken at this moment, R2 review N-M1).
   */
  const take = async () => {
    const r = await runner("/claim", {});
    return r.job as any;
  };
  /** The Agent's turn for these jobs ran (they no longer wait). */
  const ran = (sid: string) =>
    ctx.store.run(
      "UPDATE jobs SET status='completed',lease=COALESCE(lease,'ran') WHERE session_id=? AND status IN ('queued','pending','running')",
      sid,
    );
  const due = (rid: string) =>
    ctx.store.run(
      "UPDATE agent_schedules SET report_at=? WHERE id=?",
      Date.now() - 1,
      rid,
    );
  const close = async () => {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    ctx,
    c,
    uid,
    rc,
    create,
    runner,
    bg,
    event,
    row,
    schedules,
    jobs,
    fill,
    unfill,
    ran,
    take,
    due,
    url,
    close,
  };
}

test("limits: env / options / defaults", () => {
  assert.deepEqual(schedulerLimits({}, {}), {
    sessionBackground: SCHEDULE_LIMITS.background,
    nodeBackground: SCHEDULE_LIMITS.nodeBackground,
    monitorMinIntervalMs: SCHEDULE_LIMITS.monitorMinIntervalMs,
  });
  assert.deepEqual(
    schedulerLimits(
      {},
      {
        DAISY_BACKGROUND_PER_SESSION: "3",
        DAISY_BACKGROUND_PER_NODE: "5",
        DAISY_MONITOR_MIN_INTERVAL_S: "90",
      },
    ),
    { sessionBackground: 3, nodeBackground: 5, monitorMinIntervalMs: 90_000 },
  );
  // Invalid values fall back; options win over env.
  assert.equal(
    schedulerLimits({}, { DAISY_BACKGROUND_PER_NODE: "-1" }).nodeBackground,
    SCHEDULE_LIMITS.nodeBackground,
  );
  assert.equal(
    schedulerLimits({ nodeBackground: 2 }, { DAISY_BACKGROUND_PER_NODE: "9" })
      .nodeBackground,
    2,
  );
});

test("queue full: a background exit is kept (listed as undelivered, never pruned), then delivered once the queue has room", async () => {
  const p = await plane();
  try {
    const s = await p.create();
    const b = await p.bg(s.id);
    p.fill(s.id);
    const r = await p.event(s.id, b.id, {
      type: "exit",
      exitCode: 0,
      text: "all 42 tests passed",
      outputPath: "/tmp/x.log",
    });
    assert.equal(r.result, "full");
    // Ended, but its report is kept: visible to its owner and to the Agent.
    const listed = (await p.schedules(s.id)).find((x) => x.id === b.id);
    assert.equal(listed.status, "done");
    assert.equal(listed.undelivered.reason, "full");
    assert.equal(listed.undelivered.attempts, 0);
    assert.ok(listed.undelivered.retryAt > Date.now());
    assert.equal(listed.undelivered.text, undefined, "the text is the Agent's");
    const agentList = (await p.runner(`/sessions/${s.id}/schedules/list`))
      .schedules;
    assert.equal(
      agentList.find((x: any) => x.id === b.id).undelivered.reason,
      "full",
    );
    // The Agent's `schedules` tool says so.
    const host = new DaisyToolHost(
      async () => ({ schedules: agentList }),
      {} as any,
    );
    const said = await host.call(
      { job: { session: { id: s.id } } } as any,
      "schedules",
      {},
    );
    assert.match(said.text, /结果未送达（排队已满，已保存/);
    // 30 newer ended rows do not prune it away.
    for (let i = 0; i < 31; i++) {
      const x = await p.bg(s.id);
      await p.runner(`/sessions/${s.id}/schedules/${x.id}/cancel`);
    }
    assert.ok(p.row(b.id), "kept while undelivered");
    // Still full when it is due: tried again later, attempts counted.
    p.due(b.id);
    await until(
      () => p.row(b.id),
      (x: any) => JSON.parse(x.data).undelivered?.attempts === 1,
    );
    assert.ok(p.row(b.id).report_at > Date.now());
    assert.ok(!p.jobs(s.id).some((j) => j.origin === "schedule"));
    // Room again: the next attempt wakes the Agent with the report.
    p.unfill(s.id);
    p.due(b.id);
    const job = await until(
      () => p.jobs(s.id).find((j) => j.origin === "schedule"),
      (j) => !!j,
    );
    assert.match(job.text, /补送后台回报/);
    // Still kept while the wake waits: taken when it is claimed.
    assert.ok(p.row(b.id).report_at > Date.now(), "not again every second");
    const sent = await p.take();
    assert.equal(sent.id, job.id);
    assert.match(sent.text, /all 42 tests passed/);
    assert.match(sent.text, /完整输出：\/tmp\/x\.log/);
    assert.equal(p.row(b.id).report_at, null);
    assert.equal(JSON.parse(p.row(b.id).data).undelivered, undefined);
    const snap = await p.c.snapshot(s.id);
    assert.ok(
      snap.items.some(
        (i) => i.category === "wake" && /补送后台回报/.test(i.text || ""),
      ),
    );
  } finally {
    await p.close();
  }
});

test("queue full: a background command lost with the Runner (sync and an exit marked lost) is kept as well", async () => {
  const p = await plane();
  try {
    const s = await p.create();
    const a = await p.bg(s.id),
      b = await p.bg(s.id);
    p.fill(s.id);
    // The Runner reports one stopped for its restart (with its output) …
    await p.event(s.id, a.id, {
      type: "exit",
      lost: true,
      exitCode: null,
      reason: "执行节点的 Runner 重启，这个后台任务随之结束（没有自动重跑）",
      text: "step 3/9",
    });
    assert.equal(p.row(a.id).status, "lost");
    // … and the next start no longer has the other one.
    p.ctx.store.run("UPDATE agent_schedules SET created=0 WHERE id=?", b.id);
    await p.runner("/schedules/sync", { running: [], since: Date.now() });
    assert.equal(p.row(b.id).status, "lost");
    for (const id of [a.id, b.id])
      assert.equal(JSON.parse(p.row(id).data).undelivered.reason, "full");
    // Room: one wake carries both.
    p.unfill(s.id);
    p.due(a.id);
    const job = await until(
      () => p.jobs(s.id).find((j) => j.origin === "schedule"),
      (j) => !!j,
    );
    const sent = await p.take();
    assert.equal(sent.id, job.id);
    assert.match(sent.text, /后台命令中断/);
    assert.match(sent.text, /step 3\/9/);
    assert.match(sent.text, /没有自动重跑/);
    assert.match(sent.text, new RegExp(b.id));
    assert.equal(p.jobs(s.id).filter((j) => j.origin === "schedule").length, 1);
    assert.equal(p.row(b.id).report_at, null);
  } finally {
    await p.close();
  }
});

test("monitor high-frequency output: one wake per interval and session, the lines in between kept and delivered together; an exit carries them", async () => {
  const p = await plane({ scheduler: { monitorMinIntervalMs: 60_000 } });
  try {
    const s = await p.create();
    const m = await p.bg(s.id, "monitor");
    const out = (text: string) => p.event(s.id, m.id, { type: "output", text });
    assert.equal((await out("line 1")).result, "queued");
    // Still waiting to run: merged into that wake (no extra turn).
    assert.equal((await out("line 2")).result, "merged");
    p.ran(s.id);
    // The turn ran; a burst right after it waits out the interval.
    for (let i = 3; i <= 40; i++)
      assert.equal((await out(`line ${i}`)).result, "throttled");
    assert.equal(p.jobs(s.id).length, 1, "one turn for 40 outputs");
    const kept = JSON.parse(p.row(m.id).data).undelivered;
    assert.equal(kept.reason, "throttle");
    const last = JSON.parse(p.row(m.id).data).lastFiredAt;
    assert.equal(p.row(m.id).report_at, last + 60_000);
    // Its time: one wake with all of them.
    p.due(m.id);
    const job = await until(
      () => p.jobs(s.id).find((j) => /补送/.test(j.text)),
      (j) => !!j,
    );
    assert.match(job.text, /监视的唤醒间隔还没到/);
    const sent = await p.take();
    assert.match(sent.text, /line 3\n/);
    assert.match(sent.text, /line 40/);
    p.ran(s.id);
    // The interval counts from that wake: the next line waits again.
    assert.equal((await out("line 41")).result, "throttled");
    // The monitor ends: the exit is not throttled and carries line 41.
    const end = await p.event(s.id, m.id, {
      type: "exit",
      exitCode: 0,
      text: "bye",
    });
    assert.equal(end.result, "queued");
    const exit = await p.take();
    assert.match(exit.text, /监视结束/);
    assert.match(exit.text, /line 41/);
    assert.equal(p.row(m.id).report_at, null);
  } finally {
    await p.close();
  }
});

test("limits: per node across sessions and per session, configurable (429 with a reason)", async () => {
  const p = await plane({
    scheduler: { nodeBackground: 3, sessionBackground: 2 },
  });
  try {
    const s1 = await p.create("one"),
      s2 = await p.create("two");
    await p.bg(s1.id);
    await p.bg(s1.id);
    await assert.rejects(p.bg(s1.id), (e: any) => {
      assert.equal(e.status, 429);
      assert.equal(e.data.code ?? "schedule_limit", "schedule_limit");
      assert.match(e.message, /最多同时运行 2 个/);
      return true;
    });
    await p.bg(s2.id);
    // The node's three are taken: another session is refused too.
    await assert.rejects(p.bg(s2.id), (e: any) => {
      assert.equal(e.status, 429);
      assert.match(e.message, /每个节点最多 3 个/);
      assert.match(e.message, /wakeup，稍后再试/);
      return true;
    });
    // Timers are not background work.
    await p.runner(`/sessions/${s2.id}/schedules`, {
      kind: "wakeup",
      delaySeconds: 600,
      prompt: "x",
    });
    // One ends: room again.
    const [first] = (await p.schedules(s1.id)).filter(
      (x) => x.status === "running",
    );
    await p.event(s1.id, first.id, { type: "exit", exitCode: 0, text: "" });
    await p.bg(s2.id);
  } finally {
    await p.close();
  }
});

test("Runner background: its own cap and a draining restart refuse new work; a restart stops each one and reports it lost with its output", async () => {
  const sent: any[] = [];
  const api = async (path: string, body: any) => {
    sent.push({ path, body });
    return {};
  };
  const dir = mkdtempSync(join(tmpdir(), "daisy-bgm-"));
  const m = new BackgroundManager(api, 2);
  const spec = (id: string, command: string): any => ({
    id,
    sessionId: "s1",
    kind: "bash",
    command,
    cwd: dir,
    env: process.env,
    wrap: [],
    timeoutMs: 60_000,
    logPath: join(dir, `${id}.log`),
  });
  try {
    assert.equal(m.refusal(), null);
    m.start(spec("a", "echo started-a; sleep 30"));
    m.start(spec("b", "echo started-b; sleep 30"));
    assert.match(m.refusal()!, /本节点最多 2 个/);
    m.draining = "执行节点的 Runner 即将重启更新";
    assert.match(m.refusal()!, /即将重启/);
    // The tool refuses before creating any row.
    const host = new DaisyToolHost(async () => {
      throw Error("no row may be created");
    }, m);
    const r = await host.call(
      {
        job: {
          session: { id: "s1", agent: "claude" },
          profile: {},
        },
        cwd: dir,
      } as any,
      "bash",
      { command: "true", description: "x" },
    );
    assert.equal(r.ok, false);
    assert.match(r.text, /即将重启/);
    await delay(300); // the output reached the log
    await m.stopAll("Runner 重启");
    const exits = sent.filter((x) => x.body.type === "exit");
    assert.equal(exits.length, 2);
    for (const e of exits) {
      assert.equal(e.body.lost, true);
      assert.equal(e.body.reason, "Runner 重启");
      assert.match(e.body.text, /started-[ab]/);
    }
    assert.equal(m.size, 0);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart drain: only time idle but for background work counts (review M4); reset when no restart is pending", () => {
  const logs: string[] = [];
  const d = new RestartDrain(1000, (l) => logs.push(l));
  assert.equal(d.tick(false, true, true, 0), false);
  assert.equal(d.remaining(), null);
  // Pending, a turn running (not idle but for background): no time counts.
  assert.equal(d.tick(true, false, true, 100), false);
  assert.equal(d.tick(true, false, true, 5000), false);
  assert.equal(d.remaining(), 1000, "a long turn uses none of the wait");
  // Idle but for background work: counts.
  assert.equal(d.tick(true, true, true, 5000), false);
  assert.match(logs[0], /at most \d+ min/);
  assert.equal(d.tick(true, true, true, 5600), false);
  // A short wake in between pauses the clock, does not restart it.
  assert.equal(d.tick(true, false, true, 5700), false);
  assert.equal(d.tick(true, true, true, 9000), false);
  assert.equal(d.remaining(), 300);
  assert.equal(d.tick(true, true, true, 9299), false);
  assert.equal(d.tick(true, true, true, 9300), true);
  assert.equal(d.expired(), true);
  // The restart is no longer wanted: back to waiting from scratch.
  assert.equal(d.tick(false, true, true, 9400), false);
  assert.equal(d.tick(true, true, true, 9500), false);
  assert.equal(d.tick(true, true, true, 10499), false);
  assert.equal(d.tick(true, true, true, 10500), true);
});

test(
  "a restart with a long background command running: waits restartWaitMs, stops it (reported lost with its output), restarts; the next Runner wakes the Agent with it",
  { timeout: 60_000 },
  async () => {
    const h = await setup({
      selfRestart: true,
      restartIdleMs: 300,
      releaseSettleMs: 200,
      restartWaitMs: 2500,
    });
    const release = join(h.dir, ".release");
    writeFileSync(release, "rel-1\n");
    // The fixture's Runner started without a release file: start one that has it.
    h.config.releaseFile = release;
    await h.restartRunner();
    try {
      const s = await h.create("codex");
      await h.turn(
        s.id,
        tool("bash", {
          command: "echo long-job-started; sleep 120",
          description: "很久的任务",
        }),
      );
      const b = (await h.schedules(s.id)).find((x) => x.kind === "bash");
      assert.equal(b.status, "running");
      let exited: any = null;
      void h.worker().then((r) => (exited = r ?? "stopped"));
      writeFileSync(release, "rel-2\n");
      // Before the wait is over it keeps running (and the Runner too).
      await delay(1500);
      assert.equal(exited, null);
      assert.equal(
        (await h.schedules(s.id)).find((x) => x.id === b.id).status,
        "running",
      );
      // Then: stopped and reported lost with its output; the wake that
      // report queued may run here first (a turn is still waited for), then
      // the Runner exits.
      for (let i = 0; i < 150 && !exited; i++) {
        const x = await h.c.snapshot(s.id);
        const a = x.approvals.find((a) => a.status === "pending");
        if (a) await h.c.approve(s.id, a.id, a.options[0].id);
        await delay(100);
      }
      assert.deepEqual(exited, { restart: "rel-2", from: "rel-1" });
      const ended = (await h.schedules(s.id)).find((x) => x.id === b.id);
      assert.equal(ended.status, "lost");
      assert.match(ended.endedReason, /要重启更新：已等待后台任务/);
      // What systemd does next: the new Runner runs the queued wake (if the
      // old one did not get to it).
      await h.restartRunner();
      await until(
        () => h.c.snapshot(s.id),
        (x) => x.items.some((i) => /后台命令中断/.test(i.text || "")),
      );
      await h.settle(s.id);
      const told = h
        .lines(h.record)
        .filter((x) => x.via === "turn/start")
        .at(-1);
      assert.match(told.text, /后台命令中断/);
      assert.match(told.text, /long-job-started/);
      assert.match(told.text, /没有自动重跑/);
    } finally {
      await h.close();
    }
  },
);

// ------------------------------------------------ independent review (R)

test("review H1: eight kept 4000-character exits — every one is named, the ones that do not fit stay kept and come with a later turn", async () => {
  const p = await plane({ scheduler: { nodeBackground: 100 } });
  try {
    const s = await p.create();
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await p.bg(s.id)).id);
    p.fill(s.id);
    for (const [i, id] of ids.entries())
      await p.event(s.id, id, {
        type: "exit",
        exitCode: i,
        text: `R${i}:` + "x".repeat(3990),
        outputPath: `/tmp/out-${i}.log`,
      });
    p.unfill(s.id);
    await p.c.send(s.id, "hi");
    const sent = await p.take();
    // Every row has its line (ID, status, exit code, output file).
    for (const [i, id] of ids.entries()) {
      assert.ok(sent.text.includes(id), `line for ${id}`);
      assert.ok(sent.text.includes(`/tmp/out-${i}.log`));
    }
    const taken = ids.filter((id) => p.row(id).report_at === null),
      kept = ids.filter((id) => p.row(id).report_at !== null);
    assert.ok(taken.length >= 1 && kept.length >= 1);
    // A taken body is whole (its own cut only), a kept one is not in it.
    for (const id of taken) assert.match(sent.text, new RegExp(`ID ${id}）`));
    for (const id of kept) {
      assert.ok(!sent.text.includes(`ID ${id}）`));
      assert.match(
        JSON.parse(p.row(id).data).undelivered.text,
        /x{3000}/,
        "kept whole",
      );
      // Not due again at once (R2 N-M3).
      assert.ok(p.row(id).report_at > Date.now());
    }
    assert.match(sent.text, /这次放不下，稍后另行补送/);
    // The rest arrive with the next turn.
    p.ran(s.id);
    for (const id of kept) p.due(id);
    await until(
      () => p.jobs(s.id).find((j) => /补送后台回报/.test(j.text)),
      (j) => !!j,
    );
    const next = await p.take();
    for (const id of kept) assert.match(next.text, new RegExp(`ID ${id}）`));
  } finally {
    await p.close();
  }
});

test("R2 N-M1 (P1 / P5): nothing is taken at enqueue — a turn stopped or left in a paused queue takes no report; the next claimed turn has it", async () => {
  const p = await plane();
  try {
    const s = await p.create();
    const b = await p.bg(s.id);
    p.fill(s.id);
    await p.event(s.id, b.id, {
      type: "exit",
      exitCode: 0,
      text: "IMPORTANT RESULT",
    });
    p.unfill(s.id);
    // A turn is running: the owner's message waits (pending).
    p.ctx.store.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,lease) VALUES('act',?,?,'act','x','[]','running',?,'l')",
      s.id,
      p.rc.nodeId,
      Date.now(),
    );
    await p.c.send(s.id, "first", [], undefined, "queue");
    const first = p.jobs(s.id).at(-1);
    assert.equal(first.status, "pending");
    assert.ok(!/IMPORTANT/.test(first.preamble || ""), "not at enqueue");
    assert.ok(p.row(b.id).report_at !== null);
    // P1: the running turn fails, the queue pauses (first stays pending);
    // the owner types again and that turn runs: it has the report.
    p.ctx.store.run("UPDATE jobs SET status='error' WHERE id='act'");
    await p.c.send(s.id, "second");
    const sent = await p.take();
    assert.match(sent.text, /IMPORTANT RESULT[\s\S]*second$/);
    assert.equal(p.row(b.id).report_at, null);
    // P5: another one; the turn it would go with is stopped before it ran.
    const c2 = await p.bg(s.id);
    p.fill(s.id);
    await p.event(s.id, c2.id, { type: "exit", exitCode: 0, text: "SECOND" });
    p.unfill(s.id);
    await p.c.send(s.id, "third", [], undefined, "queue");
    await p.c.request(`/sessions/${s.id}/cancel`, "POST", {});
    assert.ok(p.row(c2.id).report_at !== null, "still kept after the stop");
    // Nothing queued or running: the sweep makes a turn of its own.
    p.ctx.store.run(
      "UPDATE jobs SET status='interrupted' WHERE session_id=? AND status IN ('running','pending','queued')",
      s.id,
    );
    p.due(c2.id);
    const again = await until(
      () => p.jobs(s.id).find((j) => /补送后台回报/.test(j.text)),
      (j) => !!j,
    );
    assert.equal(again.status, "queued");
    const got = await p.take();
    assert.equal(got.id, again.id);
    assert.match(got.text, /SECOND/);
    assert.equal(p.row(c2.id).report_at, null);
    // Claimed once = delivered: a re-claim of the same turn (lease expired)
    // sends the same text, nothing is kept or doubled.
    p.ctx.store.run(
      "UPDATE jobs SET status='queued',lease_until=0 WHERE id=?",
      got.id,
    );
    const re = await p.take();
    assert.equal(re.id, got.id);
    assert.equal((re.text.match(/SECOND/g) || []).length, 1);
  } finally {
    await p.close();
  }
});

test("R2 N-M3 (P3): a due report whose own wake is waiting is not appended to it every second (no cut of what it holds)", async () => {
  const p = await plane();
  try {
    const s = await p.create();
    const x = await p.bg(s.id, "monitor");
    p.ctx.store.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,lease) VALUES('act',?,?,'act','x','[]','running',?,'l')",
      s.id,
      p.rc.nodeId,
      Date.now(),
    );
    p.ctx.store.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,origin,wake) VALUES('W',?,?,?,?,'[]','pending',?,'schedule','w')",
      s.id,
      p.rc.nodeId,
      `schedule:${x.id}:W`,
      "CARRIED-BODY-START " + "y".repeat(59500),
      Date.now(),
    );
    const d = JSON.parse(p.row(x.id).data);
    d.undelivered = {
      reason: "full",
      since: Date.now(),
      attempts: 0,
      head: "h",
      text: "KEPT " + "k".repeat(3000),
    };
    p.ctx.store.run(
      "UPDATE agent_schedules SET data=?,report_at=? WHERE id=?",
      JSON.stringify(d),
      Date.now() - 1,
      x.id,
    );
    const t0 = p.ctx.store.one("SELECT text FROM jobs WHERE id='W'").text;
    await delay(3500);
    const t1 = p.ctx.store.one("SELECT text FROM jobs WHERE id='W'").text;
    assert.equal(t1, t0, "the waiting wake is untouched");
    assert.equal(p.jobs(s.id).length, 2, "no extra wake while a turn runs");
    assert.ok(p.row(x.id).report_at > Date.now(), "pushed back, not due");
    assert.match(JSON.parse(p.row(x.id).data).undelivered.text, /^KEPT/);
  } finally {
    await p.close();
  }
});

test("review L12 / L7: canceling an ended row keeps its report; reports go to the Agent's next claimed turn, not to whoever's message it is", async () => {
  const p = await plane();
  try {
    const s = await p.create();
    const b = await p.bg(s.id);
    p.fill(s.id);
    await p.event(s.id, b.id, {
      type: "exit",
      exitCode: 0,
      text: "OWNER ONLY",
    });
    p.unfill(s.id);
    // L12: the Agent cancels the ended row: its report stays.
    await p.runner(`/sessions/${s.id}/schedules/${b.id}/cancel`);
    assert.ok(p.row(b.id).report_at !== null);
    // (L7 — an admin's message not taking them — went with the admins, P1-03.)
    // A slash command's turn does not take them.
    p.ran(s.id);
    await p.c.send(s.id, "/status");
    const slash = await p.take();
    assert.ok(!/OWNER ONLY/.test(slash.text));
    assert.ok(p.row(b.id).report_at !== null);
  } finally {
    await p.close();
  }
});

test("review L3: cutting kept text never splits a surrogate pair", async () => {
  const p = await plane();
  try {
    const s = await p.create();
    const b = await p.bg(s.id, "monitor");
    p.fill(s.id);
    for (let i = 0; i < 8; i++)
      await p.event(s.id, b.id, { type: "output", text: "😀".repeat(2999) });
    p.unfill(s.id);
    await p.c.send(s.id, "hi");
    const sent = await p.take();
    assert.match(sent.text, /中间省略/);
    assert.ok(
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        sent.text,
      ),
    );
  } finally {
    await p.close();
  }
});

test("review M2 / L1: a child systemd signals while the Runner stops is reported lost, not failed; one that exited by itself keeps its exit code", async () => {
  for (const before of [true, false]) {
    const sent: any[] = [];
    const m = new BackgroundManager(async (_p, body) => {
      sent.push(body);
      return {};
    });
    const proc = m.start({
      id: "a",
      sessionId: "s",
      kind: "bash",
      command: "echo hi; sleep 30",
      cwd: tmpdir(),
      env: process.env,
      wrap: [],
      timeoutMs: 60_000,
      logPath: join(tmpdir(), `m2-${before}.log`),
    });
    await delay(300);
    // KillMode=control-group: the child and the Runner get SIGTERM at once;
    // the Runner's handler (signal abort) may run just before or after.
    if (before) m.stopping = true;
    process.kill(-proc.child.pid!, "SIGTERM");
    if (!before) {
      await delay(50);
      m.stopping = true;
    }
    await delay(600);
    await m.stopAll("Runner 已停止");
    const exit = sent.find((x) => x.type === "exit");
    assert.equal(exit.lost, true, `before=${before}`);
    assert.equal(exit.exitCode, null);
    assert.match(exit.reason, /Runner 已停止/);
    assert.match(exit.text, /hi/);
  }
  // Not while stopping: a signal of someone else is a failure, as before.
  {
    const sent: any[] = [];
    const m = new BackgroundManager(async (_p, body) => {
      sent.push(body);
      return {};
    });
    const proc = m.start({
      id: "k",
      sessionId: "s",
      kind: "bash",
      command: "sleep 30",
      cwd: tmpdir(),
      env: process.env,
      wrap: [],
      timeoutMs: 60_000,
      logPath: join(tmpdir(), "m2-other.log"),
    });
    await delay(200);
    process.kill(-proc.child.pid!, "SIGKILL");
    await delay(1500);
    const exit = sent.find((x) => x.type === "exit");
    assert.equal(exit.lost, undefined);
    m.close();
  }
  // L1: exited 0 by itself (a grandchild still holds its output): not lost.
  const sent: any[] = [];
  const m = new BackgroundManager(async (_p, body) => {
    sent.push(body);
    return {};
  });
  m.start({
    id: "b",
    sessionId: "s",
    kind: "bash",
    command: "(sleep 1; echo late) & echo done; exit 0",
    cwd: tmpdir(),
    env: process.env,
    wrap: [],
    timeoutMs: 60_000,
    logPath: join(tmpdir(), "l1.log"),
  });
  await delay(200);
  await m.stopAll("Runner 重启");
  const exit = sent.find((x) => x.type === "exit");
  assert.equal(exit.exitCode, 0);
  assert.equal(exit.lost, undefined);
});

test("review M3: an ended command whose exit has not reached the control plane yet is still listed by sync (not taken for lost)", async () => {
  const syncs: any[] = [];
  let up = false;
  const m = new BackgroundManager(async (path, body) => {
    if (path === "/schedules/sync") {
      syncs.push(body);
      return { cancel: [] };
    }
    if (!up) throw Object.assign(Error("down"), { status: 503 });
    return {};
  });
  m.start({
    id: "e",
    sessionId: "s",
    kind: "bash",
    command: "exit 3",
    cwd: tmpdir(),
    env: process.env,
    wrap: [],
    timeoutMs: 60_000,
    logPath: join(tmpdir(), "m3.log"),
  });
  await delay(300);
  await m.sync();
  assert.deepEqual(syncs[0].running, ["e"]);
  up = true;
  await until(
    () => m.size,
    (n) => n === 0,
  );
  await m.sync();
  assert.deepEqual(syncs[1].running, []);
  m.close();
  // Control plane: listed → its row stays running, then the real exit lands.
  const p = await plane();
  try {
    const s = await p.create();
    const b = await p.bg(s.id);
    p.ctx.store.run("UPDATE agent_schedules SET created=0 WHERE id=?", b.id);
    await p.runner("/schedules/sync", { running: [b.id], since: Date.now() });
    assert.equal(p.row(b.id).status, "running");
    await p.event(s.id, b.id, { type: "exit", exitCode: 3, text: "" });
    assert.equal(p.row(b.id).status, "failed");
    assert.equal(JSON.parse(p.row(b.id).data).exitCode, 3);
  } finally {
    await p.close();
  }
});

test("R2 N-L1: a command killed by someone else's signal stays listed (sync, stopAll) until its exit is queued", async () => {
  const syncs: any[] = [];
  const sent: any[] = [];
  const m = new BackgroundManager(async (path, body) => {
    if (path === "/schedules/sync") {
      syncs.push(body);
      return { cancel: [] };
    }
    sent.push(body);
    return {};
  });
  const proc = m.start({
    id: "x",
    sessionId: "s",
    kind: "monitor",
    command: "echo tick; sleep 30",
    cwd: tmpdir(),
    env: process.env,
    wrap: [],
    timeoutMs: 60_000,
    logPath: join(tmpdir(), "nl1.log"),
  });
  await delay(300);
  process.kill(-proc.child.pid!, "SIGKILL");
  // Within the grace: output sent, exit not yet — still listed.
  await delay(400);
  assert.ok(!sent.some((x) => x.type === "exit"));
  assert.equal(m.size, 1);
  await m.sync();
  assert.deepEqual(syncs[0].running, ["x"]);
  await until(
    () => m.size,
    (n) => n === 0,
  );
  const exit = sent.find((x) => x.type === "exit");
  assert.ok(exit, "the exit is reported");
  assert.equal(exit.lost, undefined);
  m.close();
});

test("R2 N-L2: once the wait ran out, only background work that was there (or ran waitMs by itself) is stopped — not one started later while busy", async () => {
  const d = new RestartDrain(1000, () => {});
  d.tick(true, true, true, 0);
  assert.equal(d.stopBefore(500), -Infinity);
  d.tick(true, true, true, 1000);
  assert.equal(d.expiredAt, 1000);
  assert.equal(d.stopBefore(1200), 1000);
  // One started at 1500 (busy meanwhile) may be stopped from 2500 on.
  assert.equal(d.stopBefore(2499) <= 1500, true);
  assert.equal(d.stopBefore(2500) > 1500, true);
  d.tick(false, true, true, 3000);
  assert.equal(d.expiredAt, null);
  // BackgroundManager: only the older one is stopped.
  const sent: any[] = [];
  const m = new BackgroundManager(async (_p, body) => {
    sent.push(body);
    return {};
  });
  const spec = (id: string): any => ({
    id,
    sessionId: "s",
    kind: "bash",
    command: "sleep 30",
    cwd: tmpdir(),
    env: process.env,
    wrap: [],
    timeoutMs: 60_000,
    logPath: join(tmpdir(), `nl2-${id}.log`),
  });
  m.start(spec("old"));
  await delay(20);
  const cut = Date.now();
  await delay(20);
  m.start(spec("new"));
  assert.equal(m.interruptAll("Runner 要重启更新", cut), 1);
  await until(
    () => sent.find((x) => x.type === "exit"),
    (x) => !!x,
  );
  await delay(200);
  assert.deepEqual(m.running(), ["new"]);
  assert.equal(sent.filter((x) => x.type === "exit").length, 1);
  assert.equal(sent.find((x) => x.type === "exit").lost, true);
  m.close();
});
