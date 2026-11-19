import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DaisyClient } from "../packages/client/src/index.ts";
import { setup, tool, until } from "./fixtures/scheduler-harness.ts";
import { nativeTimerArgs } from "../packages/daisy/src/harness/claude.ts";
import {
  cronGap,
  everyCron,
  nextCron,
  parseCron,
} from "../packages/contracts/src/scheduler.ts";
/**
 * Daisy's scheduler — timers in the control plane (persisted,
 * fired into the session as origin "schedule" turns), background commands
 * and monitors on the Runner, served to Codex as dynamic tools and to
 * Claude Code as the in-process MCP server "harbor" (fake CLIs).
 */
test("cron: parse, next firing, gap and every-N", () => {
  const at = new Date(2026, 10, 3, 10, 7, 30).getTime();
  assert.equal(
    nextCron("*/15 * * * *", at),
    new Date(2026, 10, 3, 10, 15).getTime(),
  );
  assert.equal(
    nextCron("0 9 * * 1-5", at),
    new Date(2026, 10, 4, 9, 0).getTime(),
  );
  // Day of month and weekday both given: either matches (vixie cron).
  assert.equal(
    nextCron("0 0 1 * 0", new Date(2026, 10, 3).getTime()),
    new Date(2026, 10, 8, 0, 0).getTime(),
  );
  assert.equal(nextCron("0 0 30 2 *", at), null);
  assert.throws(() => parseCron("* * * *"), /5 段/);
  assert.throws(() => parseCron("61 * * * *"), /范围/);
  assert.equal(cronGap("*/5 * * * *", at), 5 * 60_000);
  assert.equal(everyCron(30), "*/30 * * * *");
  assert.equal(everyCron(120), "0 */2 * * *");
  assert.throws(() => everyCron(90));
});

test("Codex: Daisy's dynamic tools set a timer kept by the control plane; it fires into a new turn (no user bubble) and survives a Runner restart", async () => {
  const h = await setup();
  try {
    const s = await h.create("codex");
    await h.turn(
      s.id,
      `${tool("wakeup", { delaySeconds: 120, prompt: "检查构建结果", reason: "检查构建" })}\n${tool("cron", { cron: "*/30 * * * *", prompt: "例行检查", label: "每半小时" })}`,
    );
    // thread/start carried the tools (no say: not a resident).
    const start = h.lines(h.thread).find((x) => x.via === "thread/start");
    assert.ok(start.dynamicTools.includes("daisy_wakeup"));
    assert.ok(start.dynamicTools.includes("daisy_monitor"));
    assert.ok(!start.dynamicTools.includes("daisy_say"));
    // The short note on the tools, as developer instructions.
    assert.match(start.developerInstructions, /daisy_wakeup/);
    const results = h.toolResults();
    assert.equal(results.length, 2);
    assert.match(results[0].result.text, /已设定定时器/);
    assert.equal(results[0].result.isError, false);
    let list = await h.schedules(s.id);
    assert.deepEqual(list.map((x) => [x.kind, x.status]).sort(), [
      ["cron", "active"],
      ["wakeup", "active"],
    ]);
    const snap = await h.c.snapshot(s.id);
    // 「后台」 sees them while the process is offline too.
    assert.equal(snap.session.schedulerPending?.length, 2);
    assert.ok(
      snap.session.schedulerPending!.every(
        (t) => t.source === "scheduler" && t.id.startsWith("scheduler:"),
      ),
    );
    // The thread is marked as having the tools.
    assert.equal(snap.session.nativeTools?.version, 2); // ADR-154: by Daisy's names
    // A Runner restart does not lose a timer: the control plane has it.
    await h.restartRunner();
    const wakeup = list.find((x) => x.kind === "wakeup");
    h.due(wakeup.id);
    const woken = await until(
      () => h.c.snapshot(s.id),
      (x) => x.items.some((i) => i.id.startsWith("wake:")),
    );
    const marker = woken.items.find((i) => i.id.startsWith("wake:"))!;
    assert.equal(marker.category, "wake");
    assert.match(marker.text, /Daisy 定时器到点/);
    await h.settle(s.id);
    const after = await h.c.snapshot(s.id);
    const jid = marker.id.slice("wake:".length);
    assert.ok(!after.items.some((i) => i.id === `user:${jid}`));
    // The Agent was told why, with the timer's prompt.
    const told = h
      .lines(h.record)
      .filter((x) => x.via === "turn/start")
      .at(-1);
    assert.match(told.text, /Daisy 定时器到点/);
    assert.match(told.text, /检查构建结果/);
    list = await h.schedules(s.id);
    assert.equal(list.find((x) => x.id === wakeup.id).status, "done");
    assert.equal(list.find((x) => x.id === wakeup.id).fires, 1);
    // Recurring: fires again, stays active with a later next time.
    const cron = list.find((x) => x.kind === "cron");
    h.due(cron.id);
    await until(
      () => h.schedules(s.id),
      (l) => l.find((x) => x.id === cron.id).fires === 1,
    );
    await h.settle(s.id);
    list = await h.schedules(s.id);
    const c2 = list.find((x) => x.id === cron.id);
    assert.equal(c2.status, "active");
    assert.ok(c2.nextAt > Date.now());
    // Cancel through the tool: gone from 「后台」.
    await h.turn(s.id, tool("cancel", { id: cron.id }));
    list = await h.schedules(s.id);
    assert.equal(list.find((x) => x.id === cron.id).status, "canceled");
    assert.ok(!(await h.c.snapshot(s.id)).session.schedulerPending);
  } finally {
    await h.close();
  }
});

test("Codex: a background command runs under the session's sandbox and its exit wakes the Agent with the code and output; a monitor's lines wake it", async () => {
  const h = await setup();
  try {
    const s = await h.create("codex");
    await h.turn(
      s.id,
      tool("bash", {
        command: "echo hello-from-bg; exit 3",
        description: "试跑",
      }),
    );
    assert.match(h.toolResults()[0].result.text, /已在后台运行/);
    // Codex's own sandbox (workspace-write → :workspace) wraps it.
    const sandbox = await until(
      () => h.lines(h.record).find((x) => x.via === "sandbox"),
      (x) => !!x,
    );
    assert.equal(sandbox.profile, ":workspace");
    const bg = (await h.schedules(s.id)).find((x) => x.kind === "bash");
    await until(
      () => h.schedules(s.id),
      (l) => l.find((x) => x.id === bg.id).status === "failed",
    );
    await until(
      () => h.c.snapshot(s.id),
      (x) => x.items.some((i) => /后台命令结束/.test(i.text || "")),
    );
    await h.settle(s.id);
    const told = h
      .lines(h.record)
      .filter((x) => x.via === "turn/start")
      .at(-1);
    assert.match(told.text, /退出码 3/);
    assert.match(told.text, /hello-from-bg/);
    const ended = (await h.schedules(s.id)).find((x) => x.id === bg.id);
    assert.equal(ended.exitCode, 3);
    assert.ok(existsSync(ended.outputPath));
    // Monitor: only matching lines, batched.
    await h.turn(
      s.id,
      tool("monitor", {
        command: "for i in 1 2 3; do echo tick$i; echo noise; done; sleep 0.3",
        description: "看 tick",
        pattern: "^tick",
      }),
    );
    await until(
      () => h.c.snapshot(s.id),
      (x) => x.items.some((i) => /监视有新输出/.test(i.text || "")),
    );
    await h.settle(s.id);
    const lines = h
      .lines(h.record)
      .filter((x) => x.via === "turn/start")
      .map((x) => x.text as string)
      .find((t) => /监视有新输出/.test(t))!;
    // The lines that matched, batched into one wake; not the others.
    const block = lines.split("监视有新输出")[1].split("【")[0];
    assert.match(block, /tick1\ntick2\ntick3/);
    assert.ok(!/noise/.test(block));
  } finally {
    await h.close();
  }
});

test("A background command the Runner loses in a restart is reported lost (not re-run) and wakes the Agent", async () => {
  const h = await setup();
  try {
    const s = await h.create("codex");
    await h.turn(
      s.id,
      tool("bash", { command: "sleep 30", description: "很久的任务" }),
    );
    const bg = (await h.schedules(s.id)).find((x) => x.kind === "bash");
    assert.equal(bg.status, "running");
    await h.restartRunner();
    await until(
      () => h.schedules(s.id),
      (l) => l.find((x) => x.id === bg.id).status === "lost",
    );
    await until(
      () => h.c.snapshot(s.id),
      (x) => x.items.some((i) => /后台命令中断/.test(i.text || "")),
    );
    await h.settle(s.id);
    const told = h
      .lines(h.record)
      .filter((x) => x.via === "turn/start")
      .at(-1);
    assert.match(told.text, /没有自动重跑/);
    // Never started again.
    assert.equal(
      h.lines(h.record).filter((x) => x.via === "sandbox").length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("Limits and validation: timers per session, delays, cron, owner-only, background only by the Agent", async () => {
  const h = await setup();
  try {
    const s = await h.create("codex");
    const add = (body: any) =>
      h.c.request(`/sessions/${s.id}/schedules`, "POST", body);
    await assert.rejects(
      add({ kind: "wakeup", delaySeconds: 10, prompt: "太快" }),
      (e: any) => e.status === 400,
    );
    await assert.rejects(
      add({ kind: "cron", cron: "61 * * * *", prompt: "x" }),
      /cron 无效/,
    );
    await assert.rejects(
      add({ kind: "bash", command: "ls", description: "x" }),
      (e: any) => e.status === 400 || e.status === 403,
    );
    for (let i = 0; i < 20; i++)
      await add({ kind: "wakeup", delaySeconds: 3600, prompt: `第 ${i} 个` });
    await assert.rejects(
      add({ kind: "wakeup", delaySeconds: 3600, prompt: "第 21 个" }),
      (e: any) => e.status === 429,
    );
    assert.equal((await h.c.snapshot(s.id)).session.schedulerPending?.length, 20);
    // Without the owner's credential: cannot list (P1-03: no other users).
    const other = new DaisyClient(h.url, "");
    await assert.rejects(
      other.request(`/sessions/${s.id}/schedules`),
      (e: any) => e.status === 401,
    );
    // Archiving ends them all.
    await h.c.updateSession(s.id, { archived: true });
    const list = await h.schedules(s.id);
    assert.ok(list.every((x) => x.status === "canceled"));
    assert.ok(!(await h.c.snapshot(s.id)).session.schedulerPending);
  } finally {
    await h.close();
  }
});

test("Claude Code: Daisy's tools are the in-process MCP server 「daisy」 — listed at start, timers allowed without asking, background commands checked like Bash; native timers off", async () => {
  const h = await setup({ plugins: ["session-tag"] });
  try {
    const s = await h.create("claude");
    await h.turn(
      s.id,
      `${tool("wakeup", { delaySeconds: 600, prompt: "回来看看" })}\n${tool("schedules", {})}`,
    );
    const init = h.lines(h.record).find((x) => x.via === "initialize");
    assert.deepEqual(init.sdkMcpServers, ["daisy"]);
    assert.match(init.allowedTools, /mcp__daisy__wakeup/);
    assert.ok(!/mcp__daisy__bash/.test(init.allowedTools));
    assert.match(init.text, /mcp__daisy__wakeup/);
    const listed = h.lines(h.record).find((x) => x.via === "daisy-tools-list");
    assert.equal(
      listed.text,
      // P4-08: the A2A client tools follow (ADR-127).
      "wakeup,cron,bash,monitor,output,schedules,cancel,agents,call_agent,call_result",
    );
    // call_agent sends this AI's words to someone else: checked like Bash.
    assert.match(init.allowedTools, /mcp__daisy__call_result/);
    assert.ok(!/mcp__daisy__call_agent/.test(init.allowedTools));
    const [set, shown] = h.toolResults();
    assert.match(set.result.text, /已设定定时器/);
    assert.match(shown.result.text, /定时器/);
    assert.match(shown.result.text, /回来看看|下次/);
    // with Daisy's tools, the native in-process timers are
    // disallowed online too (they die with the process); native background
    // Bash / Monitor stay.
    const argv: string[] = h
      .lines(h.spawns)
      .find((x) => x.argv.includes("-p") && x.DAISY_TEST_SESSION === s.id).argv;
    const i = argv.indexOf("--disallowed-tools");
    assert.ok(i > 0);
    assert.equal(argv[i + 1], "ScheduleWakeup,CronCreate,CronDelete,CronList");
    assert.equal(argv.filter((a) => a === "--disallowed-tools").length, 1);
    assert.ok(!/\b(Bash|Monitor)\b/.test(argv[i + 1]));
    // Daisy pending and native pending are separate lists; both count.
    const snap = await h.c.snapshot(s.id);
    assert.equal(snap.session.schedulerPending?.length, 1);
    assert.equal(snap.session.schedulerPending![0].kind, "wakeup");
  } finally {
    await h.close();
  }
});

test("Claude Code's native timers are disallowed whenever Daisy's tools are there (online and offline), and offline always; sidecars untouched", async () => {
  const deny = [
    "--disallowed-tools",
    "ScheduleWakeup,CronCreate,CronDelete,CronList",
  ];
  assert.deepEqual(
    nativeTimerArgs({ live: true, sidecar: false, daisyTools: true }),
    deny,
  );
  assert.deepEqual(
    nativeTimerArgs({ live: false, sidecar: false, daisyTools: true }),
    deny,
  );
  assert.deepEqual(
    nativeTimerArgs({ live: false, sidecar: false, daisyTools: false }),
    deny,
  );
  // Online without Daisy's tools (an older control plane): native stay.
  assert.deepEqual(
    nativeTimerArgs({ live: true, sidecar: false, daisyTools: false }),
    [],
  );
  // a sidecar's own --tools Read,Grep,Glob list already excludes them.
  assert.deepEqual(
    nativeTimerArgs({ live: true, sidecar: true, daisyTools: false }),
    [],
  );
  assert.deepEqual(
    nativeTimerArgs({ live: false, sidecar: true, daisyTools: false }),
    [],
  );
  // Offline launch end to end: Daisy's tools listed, native timers denied.
  const h = await setup({ live: false, plugins: ["session-tag"] });
  try {
    const s = await h.create("claude");
    await h.turn(s.id, tool("schedules", {}));
    const init = h.lines(h.record).find((x) => x.via === "initialize");
    assert.deepEqual(init.sdkMcpServers, ["daisy"]);
    const argv: string[] = h
      .lines(h.spawns)
      .find((x) => x.argv.includes("-p") && x.DAISY_TEST_SESSION === s.id).argv;
    const i = argv.indexOf("--disallowed-tools");
    assert.ok(i > 0);
    assert.deepEqual(argv.slice(i, i + 2), deny);
  } finally {
    await h.close();
  }
});
