/**
 * Native append (user feedback: 「要停就按停止，插入消息时不该打断」):
 * 「插队发送」 while a turn runs goes into the agent's own input
 * queue (Claude Code `priority:"next"`, read at the next tool boundary in
 * the same turn) and never interrupts; Daisy wakes go the same way by
 * themselves; Daisy's queue stays the source of truth (given back →
 * first in line again; 「移除」 → cancel_async_message).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { id } from "../packages/daisy/src/store/index.ts";
import { runNode, type NodeConfig } from "../packages/daisy/src/turns/worker.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import type { Snapshot } from "../packages/contracts/src/index.ts";
import { runnerConfig } from "./fixtures/runner-calls.ts";

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
  "DAISY_CODEX_BIN",
  "DAISY_FIXTURE_CODEX_UNREAD",
  "DAISY_FIXTURE_CLI_VERSION",
  "DAISY_FIXTURE_CANCEL_REPLY_MS",
  "DAISY_FIXTURE_RECORD",
  "DAISY_FIXTURE_RECORD_CONTROL",
  "DAISY_FIXTURE_SUBAGENT_MS",
  "DAISY_FIXTURE_STEER",
  "DAISY_FIXTURE_CODEX_STALL_AFTER_STEER",
  "DAISY_CODEX_STEER_STALL_MS",
  "DAISY_FIXTURE_RECORD_STOP",
];

async function setup(
  env: Record<string, string> = {},
  agent: "claude" | "codex" = "claude",
) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-native-append-"));
  const ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
  });
  const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const c = new DaisyClient(
    url,
    ctx.issueToken(),
  );
  const config: NodeConfig = {
    ...runnerConfig(ctx, join(dir, "runner.json")),
  };
  config.identityRoot = join(dir, "runner-state-root");
  const controls = join(dir, "controls.jsonl"),
    record = join(dir, "record.jsonl"),
    stops = join(dir, "stops.jsonl");
  process.env.DAISY_CLAUDE_BIN = resolve("tests/fixtures/agent.cjs");
  process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
  // Review L1: native append is reported from the measured CLI versions.
  process.env.DAISY_FIXTURE_CLI_VERSION = "2.1.316";
  process.env.DAISY_FIXTURE_RECORD_CONTROL = controls;
  process.env.DAISY_FIXTURE_RECORD = record;
  process.env.DAISY_FIXTURE_RECORD_STOP = stops;
  Object.assign(process.env, env);
  const controller = new AbortController();
  const worker = runNode(config, controller.signal);
  const cat = await c.catalog();
  const s = await c.create({
    agent,
    title: "native-append",
    profileId: cat.profiles.find((p) => p.agent === agent)!.id,
    workspaceId: cat.workspaces[0].id,
  });
  const lines = (f: string) =>
    existsSync(f)
      ? readFileSync(f, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  const interrupts = () =>
    lines(controls).filter((l) => l.via === "interrupt").length;
  const job = (jid: string) =>
    ctx.store.one("SELECT * FROM jobs WHERE id=?", jid);
  const close = async () => {
    controller.abort();
    await worker.catch(() => {});
    await ctx.app.close();
    for (const k of ENV) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  };
  /** The Runner reported its capabilities (agentFeatures) to the node. */
  await until(
    async () =>
      JSON.parse(
        ctx.store.one("SELECT capabilities FROM nodes WHERE id=?", s.nodeId)
          ?.capabilities || "{}",
      ),
    (caps: any) =>
      caps.agentFeatures?.[agent]?.input?.steer?.support === "native",
  );
  return {
    c,
    ctx,
    s,
    controls: () => lines(controls),
    record: () => lines(record),
    /** Codex turn/interrupt requests. */
    stops: () => lines(stops),
    interrupts,
    job,
    close,
  };
}
const subagentRunning = (x: Snapshot) =>
  x.items.some((i) => i.category === "subagent" && i.status === "running");

test("插队 while a subagent runs → priority next into the same turn, never an interrupt; the job is done once read", async () => {
  const t = await setup({ DAISY_FIXTURE_SUBAGENT_MS: "2500" });
  try {
    await t.c.send(t.s.id, "SUBAGENT_TEST");
    await until(() => t.c.snapshot(t.s.id), subagentRunning);
    const q = await t.c.send(t.s.id, "JUMPED_TEXT", [], "na-jump-1", "queue");
    const r = await t.c.jumpQueued(t.s.id, q.id);
    assert.equal(r.mode, "appended");
    // Shown as appended, first in the queue, no jump button.
    const queue = await t.c.queue(t.s.id);
    assert.equal(queue[0].id, q.id);
    assert.equal(queue[0].appended, true);
    assert.equal(queue[0].appendLabel, "已追加，等待 AI 读取");
    assert.equal(queue[0].runningSubagents, undefined);
    await until(
      () => t.c.snapshot(t.s.id),
      (x) =>
        x.items.some((i) => i.id === `user:${q.id}` && i.status === "appended"),
    );
    const done = await until(() => t.c.snapshot(t.s.id), idle);
    assert.equal(t.interrupts(), 0, "a jump never interrupts");
    const sent = t.record().find((l) => l.text?.includes("JUMPED_TEXT"));
    assert.equal(sent?.priority, "next");
    assert.ok(
      done.items.some(
        (i) => i.kind === "assistant" && i.text === "SUBDONE, and the steer: 1",
      ),
      "read at the tool boundary, in the same turn",
    );
    assert.equal(
      done.items.find(
        (i) => i.category === "subagent" && i.id.includes("sub-1"),
      )?.status,
      "complete",
      "the subagent finished",
    );
    assert.equal(t.job(q.id).status, "completed");
    assert.equal(
      done.items.find((i) => i.id === `user:${q.id}`)?.status,
      "accepted",
    );
    // Follow-up 2026-11-09: read (lifecycle started) → 「Agent 已读取」.
    assert.equal(
      done.items.find((i) => i.id === `user:${q.id}`)?.delivery,
      "read",
    );
    // One Daisy job ran (the jumped message was not a turn of its own).
    assert.equal(
      t.ctx.store.one(
        "SELECT COUNT(*) n FROM jobs WHERE session_id=? AND status='completed'",
        t.s.id,
      ).n,
      2,
    );
    assert.equal((await t.c.queue(t.s.id)).length, 0);
  } finally {
    await t.close();
  }
});

test("a Daisy wake arriving while a turn runs goes in by itself, keeps its provenance text, and is no turn of its own", async () => {
  const t = await setup({ DAISY_FIXTURE_SUBAGENT_MS: "2500" });
  try {
    await t.c.send(t.s.id, "SUBAGENT_TEST");
    await until(() => t.c.snapshot(t.s.id), subagentRunning);
    const jid = id(),
      text =
        "【Daisy 转来的外部回调】构建检查已完成（由 Daisy 转达，不是主人的消息）";
    t.ctx.store.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,origin,wake) VALUES(?,?,?,?,?,?,?,?,?,?)",
      jid,
      t.s.id,
      t.s.nodeId,
      `schedule:callback:ping:P1:${jid}`,
      text,
      "[]",
      "pending",
      Date.now(),
      "schedule",
      "外部回调",
    );
    t.ctx.store.append(t.s.id, "item", {
      id: `wake:${jid}`,
      kind: "notice",
      category: "wake",
      text: "外部回调",
      status: "complete",
      createdAt: Date.now(),
    });
    await until(
      async () => t.job(jid).status,
      (st) => st === "appended",
    );
    await until(() => t.c.snapshot(t.s.id), idle);
    assert.equal(t.interrupts(), 0);
    const sent = t.record().find((l) => l.text?.includes("构建检查已完成"));
    assert.equal(sent?.priority, "next");
    assert.ok(sent.text.includes("由 Daisy 转达，不是主人的消息"));
    assert.equal(t.job(jid).status, "completed");
    const row = t.ctx.store.one(
      "SELECT * FROM native_appends WHERE job_id=?",
      jid,
    );
    assert.deepEqual([row.state, row.own_turn, row.auto], ["completed", 0, 1]);
    const marker = (await t.c.snapshot(t.s.id)).items.find(
      (i) => i.id === `wake:${jid}`,
    );
    assert.match(marker!.text, /已并入正在运行的一轮/);
  } finally {
    await t.close();
  }
});

test("移除 of an appended row not read yet → cancel_async_message; Claude gives it back and it is never sent again", async () => {
  const t = await setup({ DAISY_FIXTURE_SUBAGENT_MS: "4000" });
  try {
    await t.c.send(t.s.id, "SUBAGENT_TEST");
    await until(() => t.c.snapshot(t.s.id), subagentRunning);
    const q = await t.c.send(t.s.id, "REMOVE_ME", [], "na-remove", "queue");
    assert.equal((await t.c.jumpQueued(t.s.id, q.id)).mode, "appended");
    await until(
      async () =>
        t.ctx.store.one(
          "SELECT status FROM live_inputs WHERE source_job=?",
          q.id,
        )?.status,
      (st) => st === "accepted",
    );
    const r = await t.c.removeQueued(t.s.id, q.id);
    assert.equal(r.withdrawing, true);
    await until(
      async () => t.job(q.id).status,
      (st) => st === "interrupted",
    );
    assert.ok(
      t.controls().some((l) => l.via === "cancel_async_message"),
      "asked Claude for it back",
    );
    const done = await until(() => t.c.snapshot(t.s.id), idle);
    assert.equal(
      done.items.find((i) => i.id === `user:${q.id}`)?.status,
      "cancelled",
    );
    assert.ok(
      done.items.some((i) => i.kind === "assistant" && i.text === "SUBDONE"),
      "not read in the turn",
    );
    assert.equal(t.interrupts(), 0);
    assert.equal((await t.c.queue(t.s.id)).length, 0);
  } finally {
    await t.close();
  }
});

test("Claude cancels an appended row → it is first in Daisy's queue again and runs next, once", async () => {
  const t = await setup({
    DAISY_FIXTURE_SUBAGENT_MS: "1500",
    DAISY_FIXTURE_STEER: "cancel",
  });
  try {
    await t.c.send(t.s.id, "SUBAGENT_TEST");
    await until(() => t.c.snapshot(t.s.id), subagentRunning);
    const other = await t.c.send(
      t.s.id,
      "QUEUED_FIRST",
      [],
      "na-queued-1",
      "queue",
    );
    const q = await t.c.send(
      t.s.id,
      "HANDED_BACK",
      [],
      "na-handed-back",
      "queue",
    );
    assert.equal((await t.c.jumpQueued(t.s.id, q.id)).mode, "appended");
    // Given back: pending again, ahead of the message queued before it.
    await until(
      async () => t.job(q.id).status,
      (st) => st !== "appended",
    );
    // Its own turn asks the fixture's tool approval: answer it.
    const done = await until(
      async () => {
        const x = await t.c.snapshot(t.s.id);
        const a = x.approvals.find((a) => a.status === "pending");
        if (a) await t.c.approve(t.s.id, a.id, a.options[0].id);
        return x;
      },
      (x) =>
        idle(x) &&
        t.job(q.id).status === "completed" &&
        t.job(other.id).status === "completed",
      300,
    );
    assert.ok(done.items.some((i) => i.id.startsWith("append-back:")));
    const runs = t.record().filter((l) => l.text?.includes("HANDED_BACK"));
    // Once appended (cancelled by Claude), once as its own turn.
    assert.equal(runs.length, 2);
    assert.equal(runs[1].priority, undefined, "the second is a turn");
    const order = t.record().map((l) => l.text);
    assert.ok(
      order.map((x) => !!x?.includes("HANDED_BACK")).lastIndexOf(true) <
        order.findIndex((x: string) => x?.includes("QUEUED_FIRST")),
      "first in line",
    );
    assert.equal(t.interrupts(), 0);
  } finally {
    await t.close();
  }
});

test("停止 withdraws appended rows first, then interrupts; the stopped row stays stopped (no turn of its own)", async () => {
  const t = await setup({ DAISY_FIXTURE_SUBAGENT_MS: "5000" });
  try {
    await t.c.send(t.s.id, "SUBAGENT_TEST");
    await until(() => t.c.snapshot(t.s.id), subagentRunning);
    const q = await t.c.send(t.s.id, "STOP_ME", [], "na-stop-1", "queue");
    assert.equal((await t.c.jumpQueued(t.s.id, q.id)).mode, "appended");
    await until(
      async () =>
        t.ctx.store.one(
          "SELECT status FROM live_inputs WHERE source_job=?",
          q.id,
        )?.status,
      (st) => st === "accepted",
    );
    await t.c.request(`/sessions/${t.s.id}/cancel`, "POST", {});
    await until(() => t.c.snapshot(t.s.id), idle);
    await delay(800);
    const controls = t.controls().map((l) => l.via);
    const cancel = controls.indexOf("cancel_async_message"),
      stop = controls.indexOf("interrupt");
    assert.ok(cancel >= 0 && stop > cancel, "withdrawn before the interrupt");
    assert.equal(t.job(q.id).status, "interrupted");
    assert.equal(
      t.record().filter((l) => l.text?.includes("STOP_ME")).length,
      1,
      "never run again",
    );
    // N-6: the stop reads 「本轮已停止」, never Claude Code's raw
    // `[ede_diagnostic] …` (that goes to the log), filed under its turn.
    const x = await t.c.snapshot(t.s.id);
    const end = x.items.find((i) => i.id.endsWith(":turn-end"));
    assert.equal(end?.text, "本轮已停止");
    assert.equal(end?.status, "interrupted");
    assert.ok(!x.items.some((i) => /ede_diagnostic/.test(i.text || "")));
  } finally {
    await t.close();
  }
});

const approveAll = (t: Awaited<ReturnType<typeof setup>>) => async () => {
  const x = await t.c.snapshot(t.s.id);
  const a = x.approvals.find((a) => a.status === "pending");
  if (a) await t.c.approve(t.s.id, a.id, a.options[0].id);
  return x;
};

test("Codex: 插队 while live → turn/steer with clientUserMessageId; read when its userMessage echoes it; never an interrupt", async () => {
  const t = await setup({}, "codex");
  try {
    await t.c.send(t.s.id, "WAIT_UNTIL_CANCEL", [], "codex-hold-1");
    await until(
      () => t.c.snapshot(t.s.id),
      (x) => x.items.some((i) => i.name === "输入已交给 Codex"),
    );
    const q = await t.c.send(
      t.s.id,
      "CODEX_APPENDED FINISH_HELD_TURN",
      [],
      "codex-jump-1",
      "queue",
    );
    assert.equal((await t.c.jumpQueued(t.s.id, q.id)).mode, "appended");
    await until(
      approveAll(t),
      (x) => idle(x) && t.job(q.id).status === "completed",
    );
    const sent = t.record().find((l) => l.text?.includes("CODEX_APPENDED"));
    assert.equal(sent?.via, "turn/steer");
    assert.ok(sent?.clientUserMessageId, "a client id to match its ack");
    assert.ok(!t.stops().some((l) => l.method === "turn/interrupt"));
    assert.equal(
      t.ctx.store.one("SELECT state FROM native_appends WHERE job_id=?", q.id)
        .state,
      "completed",
    );
    // Follow-up 2026-11-09: read when its userMessage echoed the id.
    assert.equal(
      (await t.c.snapshot(t.s.id)).items.find((i) => i.id === `user:${q.id}`)
        ?.delivery,
      "read",
    );
  } finally {
    await t.close();
  }
});

test("N-2a Codex: 乙 queued, 丙 steered into 甲 — the turn after the steer that shows nothing is interrupted and 乙 sent again, once; 乙 completes", async () => {
  const t = await setup(
    {
      DAISY_FIXTURE_CODEX_STALL_AFTER_STEER: "1",
      DAISY_CODEX_STEER_STALL_MS: "600",
    },
    "codex",
  );
  try {
    await t.c.send(t.s.id, "WAIT_UNTIL_CANCEL 甲", [], "n2a-req-a");
    await until(
      () => t.c.snapshot(t.s.id),
      (x) => x.items.some((i) => i.name === "输入已交给 Codex"),
    );
    const b = await t.c.send(t.s.id, "N2A_YI", [], "n2a-req-b", "queue");
    const c = await t.c.send(
      t.s.id,
      "N2A_BING FINISH_HELD_TURN",
      [],
      "n2a-req-c",
      "queue",
    );
    assert.equal((await t.c.jumpQueued(t.s.id, c.id)).mode, "appended");
    const done = await until(
      approveAll(t),
      (x) =>
        idle(x) &&
        t.job(c.id).status === "completed" &&
        t.job(b.id).status === "completed",
      300,
    );
    // 丙 went into 甲 (no interrupt for that); 乙's first turn stalled, was
    // interrupted (only that one) and 乙 started again.
    const yi = t.record().filter((l) => l.text?.includes("N2A_YI"));
    assert.deepEqual(
      yi.map((l) => l.via),
      ["turn/start", "turn/start"],
    );
    const interrupts = t.stops().filter((l) => l.method === "turn/interrupt");
    assert.equal(interrupts.length, 1);
    assert.equal(
      t.record().find((l) => l.text?.includes("N2A_BING"))?.via,
      "turn/steer",
    );
    assert.ok(
      done.items.some(
        (i) => i.id === `${b.id}:codex-restart` && i.status === "complete",
      ),
      "the trace says it was sent again",
    );
    // The bubble names the turn that ran.
    const bubble: any = done.items.find((i) => i.id === `user:${b.id}`);
    assert.ok(bubble?.native?.turnId && bubble.native.turnId !== interrupts[0].params.turnId);
  } finally {
    await t.close();
  }
});

test("Codex: the turn ends before the steer is read → handed back, first in line, runs as the next turn", async () => {
  // N-2a: the turn after a steer that does progress is never restarted
  // (a short stall window, and still exactly one turn/start).
  const t = await setup(
    { DAISY_FIXTURE_CODEX_UNREAD: "1", DAISY_CODEX_STEER_STALL_MS: "300" },
    "codex",
  );
  try {
    await t.c.send(t.s.id, "WAIT_UNTIL_CANCEL", [], "codex-hold-2");
    await until(
      () => t.c.snapshot(t.s.id),
      (x) => x.items.some((i) => i.name === "输入已交给 Codex"),
    );
    const q = await t.c.send(
      t.s.id,
      "CODEX_UNREAD FINISH_HELD_TURN",
      [],
      "codex-jump-2",
      "queue",
    );
    assert.equal((await t.c.jumpQueued(t.s.id, q.id)).mode, "appended");
    const done = await until(
      approveAll(t),
      (x) => idle(x) && t.job(q.id).status === "completed",
      300,
    );
    assert.ok(done.items.some((i) => i.id.startsWith("append-back:")));
    const runs = t.record().filter((l) => l.text?.includes("CODEX_UNREAD"));
    assert.deepEqual(
      runs.map((l) => l.via),
      ["turn/steer", "turn/start"],
    );
    assert.ok(!t.stops().some((l) => l.method === "turn/interrupt"));
    assert.ok(!done.items.some((i) => i.id.endsWith(":codex-restart")));
  } finally {
    await t.close();
  }
});

test("an appended message with an image goes in as image content", async () => {
  const t = await setup({ DAISY_FIXTURE_SUBAGENT_MS: "2000" });
  try {
    await t.c.send(t.s.id, "SUBAGENT_TEST");
    await until(() => t.c.snapshot(t.s.id), subagentRunning);
    const file = await t.c.request<any>("/attachments", "POST", {
      name: "shot.png",
      mime: "image/png",
      data: Buffer.from("png").toString("base64"),
    });
    const q = await t.c.send(
      t.s.id,
      "WITH_IMAGE",
      [file.id],
      "na-image-1",
      "queue",
    );
    assert.equal((await t.c.jumpQueued(t.s.id, q.id)).mode, "appended");
    await until(() => t.c.snapshot(t.s.id), idle);
    const sent = t.record().find((l) => l.text?.includes("WITH_IMAGE"));
    assert.deepEqual([sent?.priority, sent?.images], ["next", 1]);
    assert.match(sent.text, /shot\.png/, "its path is in the text too");
    assert.equal(t.job(q.id).status, "completed");
  } finally {
    await t.close();
  }
});

test("停止 whose turn ends while Claude answers the withdraw never interrupts (or kills) the next turn", async () => {
  const t = await setup({
    DAISY_FIXTURE_SUBAGENT_MS: "3000",
    DAISY_FIXTURE_CANCEL_REPLY_MS: "3000",
  });
  try {
    await t.c.send(t.s.id, "SUBAGENT_TEST");
    await until(() => t.c.snapshot(t.s.id), subagentRunning);
    const q = await t.c.send(t.s.id, "LATE_ANSWER", [], "na-late-1", "queue");
    assert.equal((await t.c.jumpQueued(t.s.id, q.id)).mode, "appended");
    await until(
      async () =>
        t.ctx.store.one(
          "SELECT status FROM live_inputs WHERE source_job=?",
          q.id,
        )?.status,
      (st) => st === "accepted",
    );
    await t.c.request(`/sessions/${t.s.id}/cancel`, "POST", {});
    // The first turn ends by itself (its subagent) before the answer; the
    // next message starts a turn that is still running when it comes.
    await until(() => t.c.snapshot(t.s.id), idle);
    await t.c.send(t.s.id, "SUBAGENT_TEST", [], "na-late-next");
    await delay(3000);
    const done = await until(() => t.c.snapshot(t.s.id), idle);
    assert.equal(t.interrupts(), 0, "nothing interrupted after the fact");
    assert.equal(
      done.items.filter((i) => i.kind === "assistant" && i.text === "SUBDONE")
        .length,
      2,
      "the next turn finished normally",
    );
  } finally {
    await t.close();
  }
});
