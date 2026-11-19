// C1-c (C-1 device acceptance, macOS): 「停止」 on a Daisy background command
// must end everything it started — also a child that left its process
// group (its own session: a daemon, `setsid`), which the group signal
// misses. Read through `ps` on macOS and /proc on Linux; runs on both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundManager } from "../packages/daisy/src/schedule/background.ts";
import {
  processTree,
  signalTree,
} from "../packages/daisy/src/platform/process-groups.ts";
import { uiLang } from "./ui-pack.ts";

// ADR-159 §8: the UI speaks Chinese in these assertions.
uiLang("zh-CN");

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(ok: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await delay(50);
  }
  return ok();
}
// The command: a node that starts `sleep` in a session of its own (not in
// the command's group), prints its pid, and waits.
const script = `const c=require("child_process").spawn("sleep",["67"],{detached:true,stdio:"ignore"});console.log("ESCAPED "+c.pid);setInterval(()=>{},1000)`;
const command = `'${process.execPath}' -e '${script}'`;

test(
  "C1-c: stopping a background command ends a child that left its group too (macOS ps / Linux /proc)",
  { skip: process.platform === "win32" && "no process groups on Windows" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-tree-"));
    const events: any[] = [];
    const bg = new BackgroundManager(async (_path, body) => {
      events.push(body);
      return {};
    });
    let escaped = 0;
    try {
      const p = bg.start({
        id: "bg-tree",
        sessionId: "s1",
        kind: "bash",
        command,
        cwd: dir,
        env: process.env,
        wrap: [],
        timeoutMs: 60_000,
        logPath: join(dir, "bg.log"),
      });
      assert.ok(
        await until(() => /ESCAPED \d+/.test(bg.output("bg-tree")?.text || "")),
        "the command started its child",
      );
      escaped = Number(/ESCAPED (\d+)/.exec(bg.output("bg-tree")!.text)![1]);
      assert.ok(alive(escaped));
      // It really left the group: a group signal alone would miss it.
      const tree = processTree(p.child.pid);
      assert.ok(
        tree.some((t) => t.pid === escaped),
        "found by parent",
      );
      assert.ok(tree.some((t) => t.pid === p.child.pid));
      assert.ok(!tree.some((t) => t.pid === process.pid), "never this process");

      bg.kill("bg-tree", "主人在「后台」里停止了它", true);
      // SIGTERM reaches both at once (well before the SIGKILL grace).
      assert.ok(
        await until(() => !alive(escaped) && !alive(p.child.pid!), 3000),
        "both ended",
      );
      assert.ok(await until(() => events.some((e) => e.type === "exit")));
      assert.equal(
        events.find((e) => e.type === "exit").reason,
        "主人在「后台」里停止了它",
      );
    } finally {
      if (escaped && alive(escaped)) process.kill(escaped, "SIGKILL");
      bg.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "signalTree signals only the processes noted (same start time), nothing else",
  { skip: process.platform === "win32" && "no process groups on Windows" },
  () => {
    assert.equal(signalTree([], "SIGTERM"), 0);
    // A pid that is not running (or whose start time differs) is skipped.
    assert.equal(signalTree([{ pid: 2 ** 22 + 7, start: "0" }], "SIGTERM"), 0);
    assert.equal(
      signalTree([{ pid: process.pid, start: "not-it" }], "SIGTERM"),
      0,
    );
    assert.ok(
      !processTree(process.pid).some((t) => t.pid === process.pid),
      "never this process",
    );
    assert.deepEqual(processTree(undefined), []);
  },
);

test(
  "C1-c end to end: a Codex session's Daisy background command (codex sandbox → sh → sleep) is listed as Daisy's with 停止, and 停止 ends its processes",
  { skip: process.platform === "win32" && "no process groups on Windows" },
  async () => {
    const {
      setup,
      tool,
      until: untilAsync,
    } = await import("./fixtures/scheduler-harness.ts");
    const { backgroundStop, offlineEffect } =
      await import("../packages/ui/src/present.ts");
    const h = await setup();
    const marker = `sleep 59.${process.pid % 1000}`;
    const running = () =>
      execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
        .split("\n")
        .filter((l) => l.includes(marker) && !l.includes("ps -axo"));
    try {
      const s = await h.create("codex");
      await h.turn(s.id, tool("bash", { command: marker, description: "等" }));
      assert.ok(await until(() => running().length > 0), "it runs");
      const snap = await h.c.snapshot(s.id);
      const item = (snap.session.schedulerPending || []).find(
        (p: any) => p.type === "scheduler_bash",
      )!;
      assert.equal(item.source, "scheduler");
      assert.match(item.id, /^scheduler:/);
      // The UI's 「停止」 for it, and 下线 says it would not end it.
      assert.deepEqual(backgroundStop(item), { label: "停止", busy: false });
      assert.match(offlineEffect(0, [item]), /1 个后台命令不会结束/);
      await h.c.stopBackground(s.id, item.id);
      // The Runner's next sync (≤ 5 s while something runs) kills the tree.
      assert.ok(await until(() => running().length === 0, 15_000), "ended");
      await untilAsync(
        () => h.schedules(s.id),
        (l: any[]) =>
          l.find((x) => `scheduler:${x.id}` === item.id)?.status ===
          "canceled",
      );
    } finally {
      for (const l of running())
        try {
          process.kill(Number(l.trim().split(/\s+/)[0]), "SIGKILL");
        } catch {}
      await h.close();
    }
  },
);

test("下线 says what it ends and what it does not (C1-c)", async () => {
  const { offlineEffect, daisyOfflineNote } =
    await import("../packages/ui/src/present.ts");
  const bash = {
    id: "scheduler:1",
    kind: "task",
    source: "scheduler",
    label: "x",
  } as any;
  const timer = {
    id: "scheduler:2",
    kind: "wakeup",
    source: "scheduler",
    label: "y",
  } as any;
  assert.equal(offlineEffect(0, []), "");
  assert.equal(offlineEffect(2, []), "（Agent 自己的后台会一起结束）");
  assert.match(
    offlineEffect(1, [bash, timer]),
    /一起结束；.* 1 个后台命令不会结束/,
  );
  assert.equal(offlineEffect(0, [timer]), "", "a timer is not running work");
  assert.match(daisyOfflineNote([bash]), /下线不会结束它们/);
  assert.match(daisyOfflineNote([bash]), /「停止」/);
  assert.doesNotMatch(daisyOfflineNote([bash]), /定时器/);
  assert.match(daisyOfflineNote([timer]), /定时器到点照常触发/);
  // The tracebar: 下线 opens the list first whenever anything is in it,
  // and an Agent task that cannot be stopped alone says so.
  const src = readFileSync("packages/ui/src/tracebar.tsx", "utf8");
  assert.match(
    src,
    /onPress=\{\(\) => \(pending\.length \? setOpen\(true\) : offline\(\)\)\}/,
  );
  assert.match(src, /testID="live-pending-no-stop"/);
});

test(
  "P5-04: stopping a harness process (JsonProcess.stop) ends a descendant that left its group — on macOS too, not just the group",
  { skip: process.platform === "win32" && "no process groups on Windows" },
  async () => {
    const { JsonProcess } = await import("../packages/daisy/src/turns/transport.ts");
    const dir = mkdtempSync(join(tmpdir(), "harness-tree-"));
    let escaped = 0;
    // A "harness" that starts a child in a session of its own and ignores SIGTERM itself.
    const harness = `process.on("SIGTERM",()=>{});const c=require("child_process").spawn("sleep",["68"],{detached:true,stdio:"ignore"});console.log(JSON.stringify({escaped:c.pid}));setInterval(()=>{},1000)`;
    const p = new JsonProcess(process.execPath, ["-e", harness], { cwd: dir, env: process.env });
    try {
      escaped = await new Promise<number>((resolve) => {
        p.onMessage = (m: any) => m?.escaped && resolve(m.escaped);
      });
      assert.ok(alive(escaped));
      const since = Date.now();
      p.stop();
      // The escaped child gets SIGTERM at once (it does not ignore it).
      assert.ok(await until(() => !alive(escaped), 1000), "the escaped child ended with the SIGTERM");
      await p.whenStopped();
      assert.equal(alive(p.child.pid!), false, "the harness itself (SIGKILL after 1.5 s)");
      assert.ok(Date.now() - since >= 1400, "SIGKILL only after the grace");
    } finally {
      if (escaped && alive(escaped)) process.kill(escaped, "SIGKILL");
      try {
        process.kill(p.child.pid!, "SIGKILL");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
