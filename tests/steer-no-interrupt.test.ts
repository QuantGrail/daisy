/**
 * 立即追加 never stops the running turn or
 * its subagents; a steer is settled by Claude Code's own command_lifecycle
 * (queued → merged at the next tool boundary, one result — 2.1.316,
 * measured), and one the turn did not take becomes the next turn instead
 * of being lost. 插队 shows how many subagents it would stop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { runningSubagents } from "../packages/daisy/src/sessions/queue-jump.ts";
import { runNode, type NodeConfig } from "../packages/daisy/src/turns/worker.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import type { Snapshot } from "../packages/contracts/src/index.ts";
import { runnerConfig } from "./fixtures/runner-calls.ts";
import { runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  read: () => Promise<T>,
  accept: (x: T) => boolean,
  tries = 150,
) {
  for (let i = 0; i < tries; i++) {
    const x = await read();
    if (accept(x)) return x;
    await delay(100);
  }
  throw Error("State timed out");
}
const idle = (x: Snapshot) =>
  !["queued", "running", "waiting"].includes(x.session.status);
const ENV = [
  "DAISY_CLAUDE_BIN",
  "DAISY_FIXTURE_RECORD_CONTROL",
  "DAISY_FIXTURE_SUBAGENT_MS",
  "DAISY_FIXTURE_STEER",
  "DAISY_CLAUDE_STEER_ACK_MS",
  "DAISY_FIXTURE_STEER_LATE_MS",
  "DAISY_CLAUDE_STEER_IDLE_MS",
  "DAISY_FIXTURE_STEER_START_MS",
];

async function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-steer-"));
  const ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
  });
  const inject = runnerInject(ctx.app, ctx.runnerApi);
  const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const c = new DaisyClient(
    url,
    ctx.issueToken(),
  );
  const config: NodeConfig = {
    ...runnerConfig(ctx, join(dir, "runner.json")),
  };
  config.identityRoot = join(dir, "runner-state-root");
  const controls = join(dir, "controls.jsonl");
  process.env.DAISY_CLAUDE_BIN = resolve("tests/fixtures/agent.cjs");
  process.env.DAISY_FIXTURE_RECORD_CONTROL = controls;
  Object.assign(process.env, env);
  const controller = new AbortController();
  const worker = runNode(config, controller.signal);
  const cat = await c.catalog();
  const s = await c.create({
    agent: "claude",
    title: "steer",
    profileId: cat.profiles.find((p) => p.agent === "claude")!.id,
    workspaceId: cat.workspaces[0].id,
  });
  const interrupts = () =>
    existsSync(controls)
      ? readFileSync(controls, "utf8")
          .trim()
          .split("\n")
          .filter((l) => l.includes('"interrupt"')).length
      : 0;
  /** Answer the fixture's tool request(s) until the session is idle. */
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      const x = await until(
        () => c.snapshot(s.id),
        (x) => x.approvals.some((a) => a.status === "pending") || idle(x),
      );
      const a = x.approvals.find((a) => a.status === "pending");
      if (!a) {
        // A promoted (requeued) turn may start right after.
        await delay(600);
        const y = await c.snapshot(s.id);
        if (idle(y) && !y.approvals.some((a) => a.status === "pending"))
          return y;
        continue;
      }
      await c.approve(s.id, a.id, a.options[0].id);
      await delay(200);
    }
    return c.snapshot(s.id);
  };
  const close = async () => {
    controller.abort();
    await worker.catch(() => {});
    await ctx.app.close();
    for (const k of ENV) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  };
  return { c, ctx, inject, s, interrupts, settle, close, config };
}

test("立即追加 while a subagent runs: acknowledged at once, merged at the tool boundary, nothing interrupted, the job ends on the turn's one result", async () => {
  const t = await setup({ DAISY_FIXTURE_SUBAGENT_MS: "2500" });
  try {
    await t.c.send(t.s.id, "SUBAGENT_TEST");
    await until(
      () => t.c.snapshot(t.s.id),
      (x) =>
        x.items.some(
          (i) => i.category === "subagent" && i.status === "running",
        ),
    );
    // 插队 never stops the turn now (native append), so the
    // queue no longer warns about the subagent it would have stopped.
    const q = await t.c.send(t.s.id, "later", [], "queue-later-1", "queue");
    const queue = await t.c.queue(t.s.id);
    assert.equal(
      (queue.find((r) => r.id === q.id) as any).runningSubagents,
      undefined,
    );
    await t.c.removeQueued(t.s.id, q.id);
    const sentAt = Date.now();
    const live = await t.c.steer(t.s.id, "also say PINEAPPLE", "steer-sub");
    // `queued` is the acknowledgement: long before the subagent is done.
    const acked = await until(
      () => t.c.snapshot(t.s.id),
      (x) =>
        x.items.some(
          (i) => i.id === `input:${live.id}` && i.status === "accepted",
        ),
    );
    assert.ok(Date.now() - sentAt < 2000, "acknowledged before the boundary");
    // Follow-up 2026-11-09: handed over, not read yet — the
    // bubble says 「已交给 Agent，到下一个工具边界读取」, not 「已接收」.
    assert.equal(
      acked.items.find((i) => i.id === `input:${live.id}`)?.delivery,
      "handed",
    );
    const done = await until(
      () => t.c.snapshot(t.s.id),
      (x) => idle(x),
    );
    assert.equal(done.session.status, "idle");
    // Read at the tool boundary (command_lifecycle started): 「Agent 已读取」.
    assert.equal(
      done.items.find((i) => i.id === `input:${live.id}`)?.delivery,
      "read",
    );
    // Review L1: a repeated read report adds no event.
    const events = () =>
      t.ctx.store.one(
        "SELECT COUNT(*) n FROM events WHERE session_id=? AND json_extract(data,'$.id')=?",
        t.s.id,
        `input:${live.id}`,
      ).n;
    const before = events();
    const again = await t.inject({
      method: "POST",
      url: `/api/runner/inputs/${live.id}/state`,
      headers: runnerHeaders(t.config.nodeId),
      payload: { state: "started" },
    });
    assert.equal(again.statusCode, 200);
    assert.equal(events(), before);
    assert.equal(t.interrupts(), 0, "a steer never interrupts");
    const sub = done.items.find(
      (i) => i.category === "subagent" && i.id.includes(":task:sub-1"),
    );
    assert.equal(sub?.status, "complete", "the subagent finished");
    assert.ok(
      done.items.some(
        (i) => i.kind === "assistant" && i.text === "SUBDONE, and the steer: 1",
      ),
      "the steer was answered inside the same turn",
    );
    // Nothing requeued.
    assert.equal((await t.c.queue(t.s.id)).length, 0);
    assert.ok(!done.items.some((i) => i.id.startsWith("requeue:")));
  } finally {
    await t.close();
  }
});

test("a steer Claude cancels is handed back and runs as the next turn, with a note (never lost)", async () => {
  const t = await setup({ DAISY_FIXTURE_STEER: "cancel" });
  try {
    await t.c.send(t.s.id, "hello");
    await until(
      () => t.c.snapshot(t.s.id),
      (x) => x.approvals.some((a) => a.status === "pending"),
    );
    const live = await t.c.steer(t.s.id, "STEER_TEXT_CANCEL", "steer-cancel");
    await until(
      () => t.c.snapshot(t.s.id),
      (x) =>
        x.items.some(
          (i) => i.id === `input:${live.id}` && i.status === "accepted",
        ),
    );
    const end = await t.settle();
    const bubble = end.items.find((i) => i.id === `input:${live.id}`)!;
    assert.equal(bubble.status, "requeued");
    const jid = (bubble as any).requeuedAs as string;
    assert.ok(jid);
    assert.ok(
      end.items.some(
        (i) =>
          i.kind === "notice" &&
          i.text.startsWith("追加未被本轮接收，已改为下一轮发送"),
      ),
    );
    const next = end.items.find((i) => i.id === `user:${jid}`);
    assert.equal(next?.text, "STEER_TEXT_CANCEL");
    assert.equal(next?.status, "accepted", "it ran as the next turn");
    assert.equal(end.session.status, "idle");
    assert.equal(t.interrupts(), 0);
  } finally {
    await t.close();
  }
});

/** Steer while the fixture waits for its tool approval; then finish. */
async function steerAtBoundary(
  t: Awaited<ReturnType<typeof setup>>,
  text: string,
  requestId: string,
  wait: number,
) {
  await t.c.send(t.s.id, "hello");
  await until(
    () => t.c.snapshot(t.s.id),
    (x) => x.approvals.some((a) => a.status === "pending"),
  );
  const live = await t.c.steer(t.s.id, text, requestId);
  await delay(wait);
  const mid = await t.c.snapshot(t.s.id);
  return { live, mid, end: await t.settle() };
}

test("a steer never acknowledged: no false 「未确认」, held until the turn ends, then the next turn (review 1)", async () => {
  const t = await setup({
    DAISY_FIXTURE_STEER: "deaf",
    DAISY_CLAUDE_STEER_ACK_MS: "400",
  });
  try {
    const { live, mid, end } = await steerAtBoundary(
      t,
      "STEER_TEXT_DEAF",
      "steer-deaf",
      2500,
    );
    // Past the acknowledgement time, the turn still running: not decided.
    const before = mid.items.find((i) => i.id === `input:${live.id}`)!;
    assert.equal(before.status, "accepted");
    assert.ok(!mid.items.some((i) => i.id.startsWith("requeue:")));
    const bubble = end.items.find((i) => i.id === `input:${live.id}`)!;
    assert.equal(bubble.status, "requeued");
    assert.ok(
      end.items.some(
        (i) => i.kind === "notice" && i.text.includes("仍未确认收到"),
      ),
    );
    const next = end.items.find(
      (i) => i.id === `user:${(bubble as any).requeuedAs}`,
    );
    assert.equal(next?.status, "accepted");
  } finally {
    await t.close();
  }
});

test("a late `queued` reclaims the steer: merged into the turn, not sent again (review 1)", async () => {
  const t = await setup({
    DAISY_FIXTURE_STEER: "late",
    DAISY_FIXTURE_STEER_LATE_MS: "900",
    DAISY_CLAUDE_STEER_ACK_MS: "300",
  });
  try {
    const { live, end } = await steerAtBoundary(
      t,
      "STEER_TEXT_LATE",
      "steer-late",
      2500,
    );
    assert.equal(
      end.items.find((i) => i.id === `input:${live.id}`)?.status,
      "accepted",
    );
    assert.ok(!end.items.some((i) => i.id.startsWith("requeue:")));
    assert.equal((await t.c.queue(t.s.id)).length, 0);
    assert.equal(
      end.items.filter((i) => i.kind === "user" && i.id.startsWith("user:"))
        .length,
      1,
      "no second turn",
    );
  } finally {
    await t.close();
  }
});

test("an older CLI without command_lifecycle keeps replay-only behaviour: a late replay, never sent again (review 1)", async () => {
  const t = await setup({
    DAISY_FIXTURE_STEER: "legacy",
    DAISY_CLAUDE_STEER_ACK_MS: "300",
  });
  try {
    const { live, end } = await steerAtBoundary(
      t,
      "STEER_TEXT_LEGACY",
      "steer-legacy",
      800,
    );
    assert.equal(end.session.status, "idle");
    assert.equal(
      end.items.find((i) => i.id === `input:${live.id}`)?.status,
      "accepted",
    );
    assert.ok(!end.items.some((i) => i.id.startsWith("requeue:")));
    assert.equal(
      end.items.filter((i) => i.kind === "user" && i.id.startsWith("user:"))
        .length,
      1,
    );
  } finally {
    await t.close();
  }
});

test("a steer cancelled after it started is said, not sent again (review 2)", async () => {
  const t = await setup({ DAISY_FIXTURE_STEER: "cancel-started" });
  try {
    const { end } = await steerAtBoundary(
      t,
      "STEER_TEXT_STARTED",
      "steer-started",
      300,
    );
    assert.ok(!end.items.some((i) => i.id.startsWith("requeue:")));
    assert.ok(
      end.items.some(
        (i) =>
          i.kind === "notice" &&
          i.text === "这条追加已开始处理后被取消，不会自动重发",
      ),
    );
    assert.equal(end.session.status, "idle");
  } finally {
    await t.close();
  }
});

test("Stop with a subagent running: the interrupt kills it (measured CLI behaviour); a queued steer still runs, by Claude itself", async () => {
  const t = await setup({ DAISY_FIXTURE_SUBAGENT_MS: "20000" });
  try {
    await t.c.send(t.s.id, "SUBAGENT_TEST");
    await until(
      () => t.c.snapshot(t.s.id),
      (x) =>
        x.items.some(
          (i) => i.category === "subagent" && i.status === "running",
        ),
    );
    const live = await t.c.steer(t.s.id, "after stop", "steer-stop");
    await until(
      () => t.c.snapshot(t.s.id),
      (x) =>
        x.items.some(
          (i) => i.id === `input:${live.id}` && i.status === "accepted",
        ),
    );
    await t.c.cancel(t.s.id);
    const end = await until(
      () => t.c.snapshot(t.s.id),
      (x) =>
        idle(x) &&
        x.items.some(
          (i) =>
            i.kind === "assistant" &&
            i.text === "Steer ran after the interrupt",
        ),
    );
    assert.equal(t.interrupts(), 1);
    const sub = end.items.find(
      (i) => i.category === "subagent" && i.id.includes(":task:sub-1"),
    );
    assert.equal(sub?.status, "error", "the interrupt stopped the subagent");
    // Not handed back a second time: Claude ran it.
    assert.ok(!end.items.some((i) => i.id.startsWith("requeue:")));
    assert.ok(end.session.live?.online, "the process was not killed");
  } finally {
    await t.close();
  }
});

test("a steer left only queued when Claude reports idle is settled as the next turn (review 4: session_state_changed)", async () => {
  // No quiet fallback here: Claude's own idle decides.
  const t = await setup({ DAISY_FIXTURE_STEER: "stuck" });
  try {
    const { live, end } = await steerAtBoundary(
      t,
      "STEER_TEXT_STUCK",
      "steer-stuck",
      1500,
    );
    const bubble = end.items.find((i) => i.id === `input:${live.id}`)!;
    assert.equal(bubble.status, "requeued");
    assert.equal(
      end.items.find((i) => i.id === `user:${(bubble as any).requeuedAs}`)
        ?.status,
      "accepted",
    );
    assert.equal(end.session.status, "idle");
  } finally {
    await t.close();
  }
});

test("a queued steer Claude starts 11 s after the result is not handed back: the job waits for it (no idle before)", async () => {
  const t = await setup({
    DAISY_FIXTURE_STEER: "late-start",
    DAISY_FIXTURE_STEER_START_MS: "11000",
  });
  try {
    const { live, end } = await steerAtBoundary(
      t,
      "STEER_TEXT_LATE_START",
      "steer-late-start",
      300,
    );
    // settle() returns once idle: the late turn ran inside the same job.
    const done = await until(
      () => t.c.snapshot(t.s.id),
      (x) =>
        idle(x) &&
        x.items.some(
          (i) => i.kind === "assistant" && i.text === "Late steer ran",
        ),
      200,
    );
    assert.ok(!done.items.some((i) => i.id.startsWith("requeue:")));
    assert.equal(
      done.items.find((i) => i.id === `input:${live.id}`)?.status,
      "accepted",
    );
    assert.equal(
      done.items.filter((i) => i.kind === "user" && i.id.startsWith("user:"))
        .length,
      1,
    );
    void end;
  } finally {
    await t.close();
  }
});

test("a handed-back steer Claude then starts is withdrawn while its requeued turn waits (no double run)", async () => {
  const t = await setup({
    DAISY_FIXTURE_STEER: "late-start",
    DAISY_FIXTURE_STEER_START_MS: "3500",
    // The last-resort quiet fallback, short here.
    DAISY_CLAUDE_STEER_IDLE_MS: "500",
  });
  try {
    await t.c.send(t.s.id, "hello");
    await until(
      () => t.c.snapshot(t.s.id),
      (x) => x.approvals.some((a) => a.status === "pending"),
    );
    // Queued first: it runs before the requeued steer, which then waits.
    await t.c.send(t.s.id, "queued first", [], "queued-first-1", "queue");
    const live = await t.c.steer(t.s.id, "STEER_TEXT_WITHDRAW", "steer-wd");
    await delay(1500);
    const a = (await t.c.snapshot(t.s.id)).approvals.find(
      (a) => a.status === "pending",
    )!;
    await t.c.approve(t.s.id, a.id, a.options[0].id);
    const handed = await until(
      () => t.c.snapshot(t.s.id),
      (x) =>
        x.items.some(
          (i) => i.id === `input:${live.id}` && i.status === "requeued",
        ),
    );
    const jid = (handed.items.find((i) => i.id === `input:${live.id}`) as any)
      .requeuedAs;
    const back = await until(
      () => t.c.snapshot(t.s.id),
      (x) =>
        x.items.some((i) => i.id === `user:${jid}` && i.status === "cancelled"),
    );
    assert.ok(
      back.items.some(
        (i) => i.kind === "notice" && i.text.includes("已撤回改发的下一轮"),
      ),
    );
    assert.equal(
      back.items.find((i) => i.id === `input:${live.id}`)?.status,
      "accepted",
    );
    const end = await t.settle();
    assert.equal(
      end.items.find((i) => i.id === `user:${jid}`)?.status,
      "cancelled",
      "the requeued turn never ran",
    );
    assert.equal((await t.c.queue(t.s.id)).length, 0);
  } finally {
    await t.close();
  }
});

test("control plane: a handed-back steer named in the job's completion is requeued once; runningSubagents counts foreground Agent calls only (review 3, 5)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-steer-cp-"));
  const ctx = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  const inject = runnerInject(ctx.app, ctx.runnerApi);
  try {
    const { app, store, issueToken } = ctx;
    const cfg = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
    const uh = {
        authorization: `Bearer ${issueToken()}`,
      },
      nh = runnerHeaders(cfg.nodeId);
    const call = async (url: string, payload: any = {}, headers: any = uh) =>
      (await inject({ method: "POST", url, payload, headers })).json();
    const get = async (url: string) =>
      (await inject({ method: "GET", url, headers: uh })).json();
    const cat = await get("/api/catalog");
    const s = await call("/api/sessions", {
      title: "cp",
      agent: "claude",
      profileId: cat.profiles.find((p: any) => p.agent === "claude").id,
      workspaceId: cat.workspaces[0].id,
    });
    await call(`/api/sessions/${s.id}/messages`, {
      text: "first",
      requestId: "steer-cp-first",
    });
    const job = (await call("/api/runner/claim", {}, nh)).job;
    const lh = { ...nh, "x-lease": job.lease };
    // A queued message: GET /queue rows carry the count of the running turn.
    await call(`/api/sessions/${s.id}/messages`, {
      text: "second",
      requestId: "steer-cp-second",
      delivery: "queue",
    });
    // no longer on GET /queue (a jump stops nothing); the count
    // itself is kept for the record.
    const count = async () => runningSubagents(store, s.id);
    assert.equal(await count(), 0);
    const item = (key: string, data: any) =>
      store.run(
        "INSERT OR REPLACE INTO items(id,session_id,data) VALUES(?,?,?)",
        `${job.id}:${key}`,
        s.id,
        JSON.stringify({ id: `${job.id}:${key}`, kind: "tool", ...data }),
      );
    item("tool-a", { name: "Agent", status: "running", input: {} });
    item("tool-bg", {
      name: "Agent",
      status: "running",
      input: { run_in_background: true },
    });
    item("tool-b", {
      name: "Bash",
      status: "running",
      input: { command: "sleep 9" },
    });
    item("task:bg-1", { category: "subagent", status: "running" });
    item("tool-done", { name: "Task", status: "complete", input: {} });
    assert.equal(await count(), 1, "only the foreground Agent call");
    // A steer, claimed and acknowledged, then handed back twice over.
    const steer = await call(`/api/sessions/${s.id}/steer`, {
      text: "STEER_CP",
      requestId: "steer-cp-steer",
    });
    const claimed = await call(
      `/api/runner/jobs/${job.id}/input/claim`,
      {},
      lh,
    );
    assert.equal(claimed.input.id, steer.id);
    await call(`/api/runner/jobs/${job.id}/input/${steer.id}/complete`, {}, lh);
    await call(
      `/api/runner/jobs/${job.id}/input/${steer.id}/requeue`,
      { reason: "测试" },
      lh,
    );
    await call(
      `/api/runner/jobs/${job.id}/complete`,
      { status: "idle", requeue: [{ id: steer.id, reason: "测试" }] },
      lh,
    );
    const jobs = store.all(
      "SELECT id,text FROM jobs WHERE session_id=? AND request_id=?",
      s.id,
      `steer:${steer.id}`,
    );
    assert.equal(jobs.length, 1, "requeued exactly once");
    assert.equal(jobs[0].text, "STEER_CP");
    assert.equal(
      store.one("SELECT status FROM live_inputs WHERE id=?", steer.id).status,
      "requeued",
    );
    // A steer whose requeue POST never landed: the completion alone does it.
    const job2 = (await call("/api/runner/claim", {}, nh)).job;
    const lh2 = { ...nh, "x-lease": job2.lease };
    const steer2 = await call(`/api/sessions/${s.id}/steer`, {
      text: "STEER_CP_2",
      requestId: "steer-cp-steer-2",
    });
    await call(`/api/runner/jobs/${job2.id}/input/claim`, {}, lh2);
    await call(
      `/api/runner/jobs/${job2.id}/input/${steer2.id}/complete`,
      {},
      lh2,
    );
    await call(
      `/api/runner/jobs/${job2.id}/complete`,
      { status: "idle", requeue: [{ id: steer2.id, reason: "租约已失效" }] },
      lh2,
    );
    assert.ok(
      store.one("SELECT 1 FROM jobs WHERE request_id=?", `steer:${steer2.id}`),
    );
    // Nothing runs: no count.
    assert.equal(
      (await get(`/api/sessions/${s.id}/queue`)).every(
        (r: any) => !r.runningSubagents,
      ),
      true,
    );
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
