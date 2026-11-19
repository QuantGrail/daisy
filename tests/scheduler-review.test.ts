import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DaisyToolHost } from "../packages/daisy/src/tools/daisy-tools.ts";
import { everyCron } from "../packages/contracts/src/scheduler.ts";
import { setup } from "./fixtures/scheduler-harness.ts";
/** Review 2026-11-03 (REVIEW-Q-sched.md): the scheduler / resident fixes. */

const job = (over: any = {}): any => ({
  id: "j1",
  session: {
    id: "s1",
    agent: "codex",
    workspaceMode: "read-only",
    ...over.session,
  },
  profile: { id: "p1", authMode: "subscription", ...over.profile },
});

/**
 * P5-04 (ADR-140): Bubblewrap is Linux's. On macOS the node declares no
 * enforced read-only (`workspaceAccess.readOnly: false`, the harness's own
 * read-only mode instead — plan 5.14 / D-28); the test below checks that
 * declaration holds (refused, never run writable).
 */
const NO_BWRAP =
  process.platform !== "linux"
    ? `${process.platform} 没有 Bubblewrap：只读用 harness 自己的模式（5.14、D-28；ADR-140 的打折扣表）`
    : false;
test("read-only scheduler_bash: one bwrap, nothing of the identity writable, no network — and it really runs here", { skip: NO_BWRAP }, () => {
  const cwd = mkdtempSync(join(tmpdir(), "ro-bg-"));
  try {
    const host = new DaisyToolHost(async () => ({}), {} as any);
    for (const agent of ["codex", "claude"]) {
      const wrap = host.wrapFor(job({ session: { agent } }), cwd);
      assert.equal(wrap[0], "/usr/bin/bwrap");
      // Second review 2026-11-03: no nested `codex sandbox` (Ubuntu's
      // apparmor refuses its namespace inside bwrap).
      assert.ok(!wrap.includes("sandbox"), agent);
      assert.ok(wrap.includes("--unshare-net"), agent);
      const binds = wrap.flatMap((x, i) =>
        x === "--bind" ? [wrap[i + 1]] : [],
      );
      assert.ok(
        !binds.some((b) => b.startsWith(join(homedir(), ".codex"))),
        `~/.codex not writable: ${binds}`,
      );
    }
    // Executed for real where bwrap can make its namespaces.
    const probe = spawnSync("/usr/bin/bwrap", ["--ro-bind", "/", "/", "true"]);
    if (probe.status !== 0) return; // no user namespaces on this host
    const wrap = host.wrapFor(job(), cwd);
    const r = spawnSync(
      wrap[0],
      [
        ...wrap.slice(1),
        "/bin/sh",
        "-c",
        `echo ran; touch ./x 2>/dev/null && echo wrote-cwd; touch "$HOME/.codex/daisy-probe" 2>/dev/null && echo wrote-codex; tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d " "`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.split("\n").filter(Boolean);
    assert.equal(out[0], "ran");
    assert.ok(!out.includes("wrote-cwd"), "the workspace stays read-only");
    assert.ok(!out.includes("wrote-codex"), "~/.codex stays read-only");
    assert.deepEqual(out.slice(1), ["lo"], "only loopback: no network");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("read-only scheduler_bash without Bubblewrap (macOS): refused plainly, never run writable", { skip: process.platform === "linux" || process.platform === "win32" ? "Linux has Bubblewrap (the test above); Windows is P5-05" : false }, () => {
  const cwd = mkdtempSync(join(tmpdir(), "ro-bg-"));
  try {
    const host = new DaisyToolHost(async () => ({}), {} as any);
    for (const agent of ["codex", "claude"])
      assert.throws(
        () => host.wrapFor(job({ session: { agent } }), cwd),
        /只读分析需要 Linux Bubblewrap；此节点未提供，未降级为可写执行/,
        agent,
      );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Daisy tools: output only of the session's own command; a wrap that fails creates no row; untrusted Codex asks first", async () => {
  const posts: string[] = [];
  const background: any = {
    started: [] as any[],
    output: (rid: string, _c: number, sid?: string) =>
      rid === "bg-other" && sid === "s1"
        ? null
        : { text: "tail", bytes: 4, running: true, path: "/x" },
    start(spec: any) {
      this.started.push(spec);
    },
  };
  const host = new DaisyToolHost(async (path: string) => {
    posts.push(path);
    return {
      schedule: { id: "sc1", command: "true", nextAt: Date.now() + 60_000 },
    };
  }, background);
  const rt = (j: any, cwd = "/tmp", decision = "allow"): any => ({
    job: j,
    cwd,
    approve: async () => ({ optionId: decision }),
  });
  // Another session's background command: not this session's to read.
  const other = await host.call(
    rt(job({ session: { workspaceMode: "shared" } })),
    "output",
    {
      id: "bg-other",
    },
  );
  assert.equal(other.ok, false);
  // The wrap cannot be built (a read-only workspace inside the private
  // temp dir): refused before any row is made.
  const scratch = `/tmp/daisy-private-${process.getuid!()}`;
  mkdirSync(join(scratch, "inside"), { recursive: true });
  const bad = await host.call(rt(job(), join(scratch, "inside")), "bash", {
    command: "true",
  });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /不能在后台运行/);
  assert.deepEqual(posts, []);
  // Codex untrusted: the owner is asked; a refusal starts nothing.
  const untrusted = job({
    session: { workspaceMode: "shared" },
    profile: { permissionMode: "untrusted", sandboxMode: "workspace-write" },
  });
  const no = await host.call(rt(untrusted, "/tmp", "deny"), "bash", {
    command: "true",
  });
  assert.equal(no.ok, false);
  assert.deepEqual(posts, []);
  const yes = await host.call(rt(untrusted, "/tmp", "allow"), "bash", {
    command: "true",
  });
  assert.equal(yes.ok, true, yes.text);
  assert.equal(posts.length, 1);
  assert.equal(background.started.length, 1);
});

test("everyCron: only intervals cron repeats evenly", () => {
  assert.equal(everyCron(15), "*/15 * * * *");
  assert.equal(everyCron(60), "0 */1 * * *");
  assert.equal(everyCron(360), "0 */6 * * *");
  assert.equal(everyCron(1440), "0 9 * * *");
  for (const bad of [7, 45, 90, 300, 2880]) assert.throws(() => everyCron(bad));
});
