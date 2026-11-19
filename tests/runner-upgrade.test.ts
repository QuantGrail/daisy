import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { runNode, type NodeConfig } from "../packages/daisy/src/turns/worker.ts";
import {
  UpgradeWatch,
  readRelease,
  supervisedBySystemd,
} from "../packages/daisy/src/update/upgrade.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import type { Snapshot } from "../packages/contracts/src/index.ts";
import { runnerConfig } from "./fixtures/runner-calls.ts";

// A Runner whose installed release changed restarts itself once it is idle
// (no release has to catch it idle), and never in the middle of any work.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("upgrade watch: only outdated, settled and continuously idle", () => {
  let installed: string | null = "rel-1";
  const w = new UpgradeWatch({
    enabled: true,
    read: () => installed,
    idleMs: 1000,
    settleMs: 500,
    checkMs: 0,
  });
  assert.equal(w.started, "rel-1");
  // Same release: never, however long it idles.
  for (let t = 0; t <= 5000; t += 500) assert.equal(w.due(true, t), null);
  // A new release, busy: never.
  installed = "rel-2";
  for (let t = 6000; t <= 9000; t += 500) assert.equal(w.due(false, t), null);
  assert.equal(w.outdated(9000), "rel-2");
  // Idle, but not yet for idleMs.
  assert.equal(w.due(true, 9500), null);
  assert.equal(w.due(true, 10000), null);
  // A moment of work resets the idle clock.
  assert.equal(w.due(false, 10400), null);
  assert.equal(w.due(true, 10500), null);
  assert.equal(w.due(true, 11000), null);
  assert.equal(w.due(true, 11500), "rel-2");
  // The directory mid-swap (no marker) or a changing release: wait to settle.
  const v = new UpgradeWatch({
    enabled: true,
    read: () => installed,
    idleMs: 0,
    settleMs: 500,
    checkMs: 0,
  });
  installed = null;
  assert.equal(v.due(true, 0), null);
  installed = "rel-3";
  assert.equal(v.due(true, 100), null);
  installed = "rel-4"; // swapped back / again: the clock restarts
  assert.equal(v.due(true, 400), null);
  assert.equal(v.due(true, 700), null);
  assert.equal(v.due(true, 900), "rel-4");
});

test("upgrade watch: off without a release marker, when disabled, or by hand", () => {
  const unknown = new UpgradeWatch({
    enabled: true,
    read: () => null,
    idleMs: 0,
    settleMs: 0,
  });
  assert.equal(unknown.enabled, false);
  const off = new UpgradeWatch({
    enabled: false,
    read: () => String(Math.random()),
    idleMs: 0,
    settleMs: 0,
    checkMs: 0,
  });
  assert.equal(off.due(true, 0), null);
  assert.equal(off.due(true, 10_000), null);
  // Only a systemd service restarts after exiting; `npm run runner` does not.
  assert.equal(
    supervisedBySystemd({}, () => "systemd"),
    false,
  );
  assert.equal(
    supervisedBySystemd({ INVOCATION_ID: "x" }, () => "bash"),
    false,
  );
  assert.equal(
    supervisedBySystemd({ INVOCATION_ID: "x" }, () => "systemd"),
    true,
  );
  assert.equal(
    supervisedBySystemd(
      { INVOCATION_ID: "x", DAISY_RUNNER_SELF_RESTART: "0" },
      () => "systemd",
    ),
    false,
  );
  assert.equal(
    supervisedBySystemd({ DAISY_RUNNER_SELF_RESTART: "1" }, () => "bash"),
    true,
  );
  const dir = mkdtempSync(join(tmpdir(), "daisy-release-"));
  try {
    writeFileSync(join(dir, ".release"), "a892426d8850\n");
    assert.equal(readRelease(join(dir, ".release")), "a892426d8850");
    writeFileSync(join(dir, ".release"), "not a release; rm -rf\n");
    assert.equal(readRelease(join(dir, ".release")), null);
    assert.equal(readRelease(join(dir, "missing")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "runner restarts into a new release only once idle: a running turn finishes first, sessions resume",
  { timeout: 60000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "daisy-upgrade-"));
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
    const release = join(dir, ".release");
    writeFileSync(release, "rel-1\n");
    const config: NodeConfig = {
      ...runnerConfig(ctx, join(dir, "runner.json")),
      selfRestart: true,
      releaseFile: release,
      restartIdleMs: 1500,
      releaseSettleMs: 300,
    };
    process.env.DAISY_CLAUDE_BIN = resolve("tests/fixtures/agent.cjs");
    let controller = new AbortController();
    // Runner state (result journal, restart requests) under the test dir.
    config.identityRoot ??= join(dir, "runner-state-root");
    let worker = runNode(config, controller.signal);
    let exited: any = null;
    void worker.then((r) => (exited = r ?? "stopped"));
    try {
      const cat = await c.catalog();
      const s = await c.create({
        agent: "claude",
        title: "长任务",
        profileId: cat.profiles.find((p) => p.agent === "claude")!.id,
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
      // Unchanged release: an idle Runner stays.
      await delay(2500);
      assert.equal(exited, null);
      const caps = JSON.parse(
        ctx.store.one("SELECT capabilities FROM nodes").capabilities,
      );
      const {
        autoUpdate,
        process: proc,
        restart: rcap,
        inputReads,
        ...runner
      } = caps.runner;
      assert.deepEqual(runner, { release: "rel-1", selfRestart: true });
      // Follow-up 2026-11-09: it reports 立即追加 reads.
      assert.equal(inputReads, true);
      // which process this is, and that it restarts on request.
      assert.match(proc.id, /^[0-9a-f-]{36}$/);
      assert.equal(rcap.version, 2);
      assert.equal(rcap.supervised, true);
      // Also how it updates: P6-01 (ADR-151) only the npm update (P5-06) —
      // a Runner without it says so, never a git checkout's launcher.
      // D-34: on by default — runner.json says nothing, and it is not
      // "disabled".
      assert.equal(autoUpdate.state, "unsupported");
      assert.equal(autoUpdate.mode, "package");
      assert.match(autoUpdate.reason, /没有接上更新/);
      assert.equal(caps.sessionTitles.version, 2);

      // A turn is running (waiting for the user's approval) when the new
      // release lands: the Runner keeps it, however long it takes.
      await c.send(s.id, "Hello");
      const waiting = await until((x) =>
        x.approvals.some((a) => a.status === "pending"),
      );
      writeFileSync(release, "rel-2\n");
      await delay(4000);
      assert.equal(exited, null);
      assert.equal((await c.snapshot(s.id)).session.status, "waiting");
      const a = waiting.approvals.find((a) => a.status === "pending")!;
      await c.approve(s.id, a.id, a.options[0].id);
      const done = await until((x) => x.session.status === "idle");
      assert.ok(
        done.items.some((i) => i.kind === "assistant" && /Hello/.test(i.text)),
      );
      // Idle now: it exits for the restart within the idle window.
      for (let i = 0; i < 80 && !exited; i++) await delay(100);
      assert.deepEqual(exited, { restart: "rel-2", from: "rel-1" });
      const job = ctx.store.one(
        "SELECT status FROM jobs WHERE session_id=?",
        s.id,
      );
      assert.equal(job.status, "completed");
      const offline = await until((x) => x.session.live?.online === false);
      assert.match(offline.session.live!.reason!, /自动更新/);

      // What systemd does next: the installed release starts and the
      // conversation simply continues (resumed in a new process).
      controller = new AbortController();
      // Runner state (result journal, restart requests) under the test dir.
      config.identityRoot ??= join(dir, "runner-state-root");
      worker = runNode(config, controller.signal);
      await c.send(s.id, "Hello again");
      const w2 = await until(
        (x) =>
          x.approvals.some((a) => a.status === "pending") ||
          x.items.filter((i) => i.kind === "assistant").length > 1,
      );
      const a2 = w2.approvals.find((a) => a.status === "pending");
      if (a2) await c.approve(s.id, a2.id, a2.options[0].id);
      await until(
        (x) =>
          x.session.status === "idle" &&
          ctx.store.one(
            "SELECT count(*) n FROM jobs WHERE session_id=? AND status='completed'",
            s.id,
          ).n === 2,
      );
      const caps2 = JSON.parse(
        ctx.store.one("SELECT capabilities FROM nodes").capabilities,
      );
      assert.equal(caps2.runner.release, "rel-2");
    } finally {
      controller.abort();
      await worker.catch(() => {});
      await ctx.app.close();
      delete process.env.DAISY_CLAUDE_BIN;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
