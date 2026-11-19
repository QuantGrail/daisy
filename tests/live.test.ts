import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { pidsWithEnv } from "./fixtures/proc-env.ts";
import { runNode, type NodeConfig } from "../packages/daisy/src/turns/worker.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import type { Snapshot } from "../packages/contracts/src/index.ts";
import { runnerConfig } from "./fixtures/runner-calls.ts";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, accept: (x: T) => boolean) {
  for (let i = 0; i < 150; i++) {
    const x = await read();
    if (accept(x)) return x;
    await delay(100);
  }
  throw Error("State timed out");
}
/** Agent processes of a conversation: the test plugin tags them DAISY_TEST_SESSION=<id>. */
const agentPids = (sid: string) => pidsWithEnv("DAISY_TEST_SESSION", sid);
const idle = (x: Snapshot) =>
  !["queued", "running", "waiting"].includes(x.session.status);
async function setup(extra: Partial<NodeConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-live-"));
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
    // Agent processes / spawn records are told apart by DAISY_TEST_SESSION
    // (P4-13: the test-only plugin tests/plugins/session-tag).
    plugins: ["session-tag"],
    ...extra,
  };
  const spawns = join(dir, "spawns.jsonl"),
    record = join(dir, "record.jsonl");
  for (const a of ["CLAUDE", "CODEX", "KIMI"])
    process.env[`DAISY_${a}_BIN`] = resolve("tests/fixtures/agent.cjs");
  process.env.DAISY_FIXTURE_ENV_FILE = spawns;
  process.env.DAISY_FIXTURE_RECORD = record;
  let controller = new AbortController();
  // Runner state (result journal, restart requests) under the test dir.
  config.identityRoot ??= join(dir, "runner-state-root");
  let worker = runNode(config, controller.signal);
  const cat = await c.catalog();
  const create = (agent: "claude" | "codex" | "kimi", title: string) =>
    c.create({
      agent,
      title,
      profileId: cat.profiles.find((p) => p.agent === agent)!.id,
      workspaceId: cat.workspaces[0].id,
    });
  /** Send, approve the fixture's tool request, wait for the turn to end. */
  const turn = async (sid: string, text: string) => {
    await c.send(sid, text);
    const waiting = await until(
      () => c.snapshot(sid),
      (x) => x.approvals.some((a) => a.status === "pending") || idle(x),
    );
    const a = waiting.approvals.find((a) => a.status === "pending");
    if (a) await c.approve(sid, a.id, a.options[0].id);
    return until(
      () => c.snapshot(sid),
      (x) => idle(x) && !x.approvals.some((a) => a.status === "pending"),
    );
  };
  /** Agent processes started for this session (fixture env records). */
  const started = (sid: string) =>
    existsSync(spawns)
      ? readFileSync(spawns, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
          .filter(
            (x) =>
              x.DAISY_TEST_SESSION === sid &&
              !x.argv.includes("auth") &&
              (x.argv.includes("-p") ||
                x.argv.includes("app-server") ||
                x.argv.includes("acp")),
          )
      : [];
  const recorded = () =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  const restartRunner = async () => {
    controller.abort();
    await worker.catch(() => {});
    controller = new AbortController();
    // Runner state (result journal, restart requests) under the test dir.
    config.identityRoot ??= join(dir, "runner-state-root");
    worker = runNode(config, controller.signal);
  };
  const close = async () => {
    controller.abort();
    await worker.catch(() => {});
    await ctx.app.close();
    for (const k of [
      "DAISY_CLAUDE_BIN",
      "DAISY_CODEX_BIN",
      "DAISY_KIMI_BIN",
      "DAISY_FIXTURE_ENV_FILE",
      "DAISY_FIXTURE_RECORD",
    ])
      delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  };
  return { c, ctx, create, turn, started, recorded, restartRunner, close };
}

test(
  "Claude and Codex in one directory both execute while the other awaits approval",
  { timeout: 30000 },
  async () => {
    const t = await setup({ concurrency: 4 });
    try {
      const a = await t.create("claude", "shared-a");
      const b = await t.create("codex", "shared-b");
      await t.c.send(a.id, "First shared task");
      const first = await until(
        () => t.c.snapshot(a.id),
        (x) => x.approvals.some((p) => p.status === "pending"),
      );
      await t.c.send(b.id, "Second shared task");
      const second = await until(
        () => t.c.snapshot(b.id),
        (x) => x.approvals.some((p) => p.status === "pending"),
      );
      assert.equal(
        (await t.c.snapshot(a.id)).approvals.some(
          (p) => p.status === "pending",
        ),
        true,
      );
      for (const [sid, snapshot] of [
        [a.id, first],
        [b.id, second],
      ] as const) {
        assert.equal(
          snapshot.items.some((i) => i.text?.includes("等待工作区")),
          false,
        );
        const approval = snapshot.approvals.find(
          (p) => p.status === "pending",
        )!;
        await t.c.approve(sid, approval.id, approval.options[0].id);
        await until(() => t.c.snapshot(sid), idle);
      }
      assert.equal(t.started(a.id).length, 1);
      assert.equal(t.started(b.id).length, 1);
    } finally {
      await t.close();
    }
  },
);

test(
  "native background work and timers continue while another shared session awaits approval",
  { timeout: 60000 },
  async () => {
    process.env.DAISY_FIXTURE_WAKE_MS = "4000";
    const t = await setup({ concurrency: 4 });
    try {
      const a = await t.create("claude", "native-background");
      const b = await t.create("codex", "shared-editor");
      await t.c.send(a.id, "BG_TEST");
      await until(
        () => t.c.snapshot(a.id),
        (x) =>
          idle(x) && !!x.session.live?.pending?.some((p) => p.kind === "task"),
      );
      await t.c.send(
        b.id,
        "Work while the other session runs a background task",
      );
      await until(
        () => t.c.snapshot(b.id),
        (x) => x.approvals.some((p) => p.status === "pending"),
      );
      await until(
        () => t.c.snapshot(a.id),
        (x) =>
          idle(x) &&
          x.items.some((i) => i.text === "Background build finished"),
      );
      await t.c.send(a.id, "WAKE_TEST");
      await until(
        () => t.c.snapshot(a.id),
        (x) => idle(x) && x.items.some((i) => i.text === "Woke up by timer"),
      );
      const other = await t.c.snapshot(b.id);
      const approval = other.approvals.find((p) => p.status === "pending")!;
      assert.ok(
        approval,
        "the other session remains active throughout native background completion and timer wakeup",
      );
      await t.c.approve(b.id, approval.id, approval.options[0].id);
      await until(() => t.c.snapshot(b.id), idle);
      assert.equal(
        t.started(a.id).length,
        1,
        "native session was not restarted to release a workspace",
      );
    } finally {
      delete process.env.DAISY_FIXTURE_WAKE_MS;
      await t.close();
    }
  },
);

test(
  "online session: one Claude process serves turn after turn, settings apply live or restart, the user can take it offline",
  { timeout: 60000 },
  async () => {
    const t = await setup();
    try {
      const s = await t.create("claude", "live");
      await t.turn(s.id, "Hello");
      const online = await until(
        () => t.c.snapshot(s.id),
        (x) => !!x.session.live?.online && !x.session.live.busy,
      );
      assert.ok(online.session.live!.since! > 0);
      // what the Agent reported it runs with.
      assert.equal(online.session.runtime?.model, "fixture-model");
      const pid = agentPids(s.id);
      assert.ok(pid.length >= 1, "the Claude process stays up between turns");
      // Second turn: same process, no new spawn.
      const second = await t.turn(s.id, "Again");
      assert.equal(t.started(s.id).length, 1);
      assert.deepEqual(agentPids(s.id), pid);
      assert.ok(
        second.items.some(
          (i) => i.kind === "tool" && i.name === "沿用在线的 Claude Code 进程",
        ),
      );
      // A model for this conversation only: applied live (set_model).
      await t.c.updateSession(s.id, { settings: { model: "other-model" } });
      await t.turn(s.id, "With another model");
      assert.ok(
        t
          .recorded()
          .some((r) => r.via === "set_model" && r.text === "other-model"),
      );
      assert.equal(t.started(s.id).length, 1);
      // Effort is a launch flag: the process restarts and resumes.
      await t.c.updateSession(s.id, { settings: { reasoningEffort: "high" } });
      await t.turn(s.id, "Think harder");
      const runs = t.started(s.id);
      assert.equal(runs.length, 2);
      assert.ok(runs[1].argv.includes("--resume"));
      assert.equal(runs[1].argv[runs[1].argv.indexOf("--effort") + 1], "high");
      assert.ok(runs[1].argv.includes("other-model"));
      // Offline on request: the process ends, history stays.
      await t.c.goOffline(s.id);
      const off = await until(
        () => t.c.snapshot(s.id),
        (x) => x.session.live?.online === false,
      );
      assert.match(off.session.live!.reason!, /按你的要求下线/);
      await until(
        async () => agentPids(s.id),
        (p) => p.length === 0,
      );
      // The next message brings it back online (a third process).
      await t.turn(s.id, "Back");
      await until(
        () => t.c.snapshot(s.id),
        (x) => !!x.session.live?.online,
      );
      assert.equal(t.started(s.id).length, 3);
    } finally {
      await t.close();
    }
  },
);

test(
  "Agent-started turns: a ScheduleWakeup timer and a background task wake Claude up, each as its own turn in the conversation",
  { timeout: 60000 },
  async () => {
    process.env.DAISY_FIXTURE_WAKE_MS = "3000";
    const t = await setup();
    try {
      const s = await t.create("claude", "wake");
      await t.c.send(s.id, "WAKE_TEST");
      // The turn ends; the timer is pending, the session stays online.
      const pending = await until(
        () => t.c.snapshot(s.id),
        (x) =>
          idle(x) &&
          !!x.session.live?.pending?.some((p) => p.kind === "wakeup"),
      );
      assert.equal(
        pending.session.live!.pending!.find((p) => p.kind === "wakeup")!.label,
        "检查构建",
      );
      // The timer fires: a new turn, marked as the Agent's own.
      const woke = await until(
        () => t.c.snapshot(s.id),
        (x) =>
          idle(x) &&
          x.items.some(
            (i) => i.kind === "assistant" && i.text === "Woke up by timer",
          ),
      );
      const marker = woke.items.find((i) => i.category === "wake")!;
      assert.equal(marker.kind, "notice");
      assert.equal(marker.text, "定时器到点：检查构建");
      const jid = marker.id.slice("wake:".length);
      assert.equal(
        t.ctx.store.one("SELECT origin FROM jobs WHERE id=?", jid).origin,
        "agent",
      );
      // The reply belongs to the wake turn, after its marker.
      const at = woke.items.indexOf(marker);
      assert.ok(
        woke.items.findIndex((i) => i.text === "Woke up by timer") > at,
      );
      // A fired timer is no longer pending (next state report).
      await until(
        () => t.c.snapshot(s.id),
        (x) => !x.session.live?.pending?.some((p) => p.kind === "wakeup"),
      );

      // Background task: pending while it runs, its item finishes between
      // turns, its report starts the next turn.
      await t.c.send(s.id, "BG_TEST");
      const running = await until(
        () => t.c.snapshot(s.id),
        (x) =>
          idle(x) &&
          !!x.session.live?.pending?.some(
            (p) => p.kind === "task" && p.label === "后台构建",
          ),
      );
      const taskItem = running.items.find((i) => i.id.endsWith(":task:bg-1"))!;
      assert.equal(taskItem.status, "running");
      // what it is (type, command, start) in the live state, what it
      // is doing (the end of its output, plain text) on demand.
      const bg = running.session.live!.pending!.find((p) => p.kind === "task")!;
      assert.equal(bg.type, "local_bash");
      assert.equal(bg.command, "sleep 1");
      assert.ok(bg.since && bg.since <= Date.now());
      const act = await until(
        () => t.c.liveActivity(s.id),
        (x) => x.items.some((a) => a.id === bg.id && !!a.output),
      );
      const out = act.items.find((a) => a.id === bg.id)!;
      assert.equal(out.output, "compiling 2/2\nlinking\n");
      assert.equal(out.outputBytes, 9000);
      const reported = await until(
        () => t.c.snapshot(s.id),
        (x) =>
          idle(x) &&
          x.items.some((i) => i.text === "Background build finished"),
      );
      assert.equal(
        reported.items.find((i) => i.id === taskItem.id)!.status,
        "complete",
        "the earlier turn's task item is finished in place",
      );
      assert.ok(
        reported.items.some(
          (i) => i.category === "wake" && i.text === "后台任务完成：构建完成",
        ),
      );
      await until(
        () => t.c.snapshot(s.id),
        (x) => !!x.session.live?.online && !x.session.live.pending?.length,
      );
    } finally {
      delete process.env.DAISY_FIXTURE_WAKE_MS;
      await t.close();
    }
  },
);

test(
  "/compact runs in the online process and reports the new context size; stopping a turn keeps the session online",
  { timeout: 60000 },
  async () => {
    const t = await setup();
    try {
      const s = await t.create("claude", "compact");
      await t.turn(s.id, "Hello");
      const op = await t.c.operation(s.id, "compact");
      const done = await until(
        () => t.c.operationStatus(s.id, op.id),
        (r) => !!r.result,
      );
      assert.equal(done.result.completed, true);
      assert.equal(done.result.preTokens, 50000);
      assert.equal(done.result.postTokens, 5000);
      const snap = await until(
        () => t.c.snapshot(s.id),
        (x) => idle(x) && x.items.some((i) => i.category === "compact"),
      );
      const notice = snap.items.find((i) => i.category === "compact")!;
      assert.equal(notice.kind, "notice");
      assert.match(notice.text, /已压缩上下文：50\.0K → 5\.0K tokens/);
      const ring = snap.items.filter((i) => i.id.endsWith(":context")).at(-1)!;
      assert.equal((ring.input as any).used, 5000);
      assert.equal(t.started(s.id).length, 1, "compacted in the same process");

      // Stop a turn waiting for approval: interrupted, process stays.
      await t.c.send(s.id, "Wait for me");
      await until(
        () => t.c.snapshot(s.id),
        (x) => x.approvals.some((a) => a.status === "pending"),
      );
      const pid = agentPids(s.id);
      await t.c.cancel(s.id);
      const stopped = await until(
        () => t.c.snapshot(s.id),
        (x) => x.session.status === "interrupted",
      );
      assert.ok(stopped.session.live?.online);
      assert.deepEqual(agentPids(s.id), pid);
      await t.turn(s.id, "Continue");
      assert.equal(t.started(s.id).length, 1);
    } finally {
      await t.close();
    }
  },
);

test(
  "offline: idle sessions go offline after the idle limit unless something is pending; a runner restart marks them offline",
  { timeout: 60000 },
  async () => {
    process.env.DAISY_FIXTURE_WAKE_MS = "3000";
    const t = await setup({ liveIdleMs: 800 });
    try {
      const a = await t.create("codex", "idle");
      await t.turn(a.id, "Hello");
      const off = await until(
        () => t.c.snapshot(a.id),
        (x) => x.session.live?.online === false,
      );
      assert.match(off.session.live!.reason!, /空闲超过/);
      await until(
        async () => agentPids(a.id),
        (p) => p.length === 0,
      );
      // A pending timer keeps a session online past the idle limit.
      const b = await t.create("claude", "timer");
      await t.c.send(b.id, "WAKE_TEST");
      await until(
        () => t.c.snapshot(b.id),
        (x) => idle(x) && !!x.session.live?.pending?.length,
      );
      await delay(1500);
      assert.ok((await t.c.snapshot(b.id)).session.live?.online);
      await until(
        () => t.c.snapshot(b.id),
        (x) => x.items.some((i) => i.text === "Woke up by timer"),
      );
      // Runner restart: processes are gone, sessions show offline.
      const c = await t.create("kimi", "restart");
      await t.turn(c.id, "Hello");
      await until(
        () => t.c.snapshot(c.id),
        (x) => !!x.session.live?.online,
      );
      await t.restartRunner();
      const after = await until(
        () => t.c.snapshot(c.id),
        (x) => x.session.live?.online === false,
      );
      assert.match(after.session.live!.reason!, /重启|退出/);
    } finally {
      delete process.env.DAISY_FIXTURE_WAKE_MS;
      await t.close();
    }
  },
);

test(
  "slots are online Agents: an online session takes its next turn in its own slot, a new one waits until a slot is free",
  { timeout: 60000 },
  async () => {
    const t = await setup({ concurrency: 1, liveEvictIdleMs: 3_600_000 });
    try {
      const a = await t.create("claude", "a"),
        b = await t.create("claude", "b");
      await t.turn(a.id, "first");
      assert.equal((await t.c.snapshot(a.id)).session.live?.online, true);
      // A is online and holds the only slot: B waits.
      await t.c.send(b.id, "waiting for a slot");
      await delay(1500);
      assert.equal((await t.c.snapshot(b.id)).session.status, "queued");
      // A still runs its own next turn (it already has a slot).
      await t.turn(a.id, "second");
      assert.equal((await t.c.snapshot(b.id)).session.status, "queued");
      // A goes offline: its slot is free, B runs.
      await t.c.goOffline(a.id);
      const done = await until(
        () => t.c.snapshot(b.id),
        (x) => idle(x) || x.approvals.some((p) => p.status === "pending"),
      );
      assert.notEqual(done.session.status, "queued");
      await until(
        () => t.c.snapshot(a.id),
        (x) => x.session.live?.online === false,
      );
    } finally {
      await t.close();
    }
  },
);

test(
  "slots full: the longest-idle Agent with nothing in the background goes offline for a new session",
  { timeout: 60000 },
  async () => {
    const t = await setup({ concurrency: 1, liveEvictIdleMs: 0 });
    try {
      const a = await t.create("claude", "a"),
        b = await t.create("claude", "b");
      await t.turn(a.id, "first");
      await t.turn(b.id, "needs a slot");
      const left = await until(
        () => t.c.snapshot(a.id),
        (x) => x.session.live?.online === false,
      );
      assert.match(left.session.live!.reason!, /让出名额/);
      assert.equal((await t.c.snapshot(b.id)).session.live?.online, true);
    } finally {
      await t.close();
    }
  },
);
