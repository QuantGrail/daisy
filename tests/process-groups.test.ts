import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureProcessGroups,
  procInfo,
  sameCommand,
  sweepOrphans,
  trackGroup,
} from "../packages/daisy/src/platform/process-groups.ts";

// P1-02 follow-up: the start-up sweep of what a killed process left
// signals only what is provably the recorded group.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const record = (file: string, groups: unknown[]) =>
  writeFileSync(file, JSON.stringify({ owner: 1, groups }));

test(
  "procInfo: start time, group, parent and command of a process (fixed locale / zone on ps; /proc on Linux)",
  { skip: process.platform === "win32" && "no process groups on Windows" },
  () => {
    const me = procInfo(process.pid)!;
    assert.ok(me.start && /^\d+$/.test(me.start), JSON.stringify(me));
    assert.equal(me.ppid, process.ppid);
    assert.ok(me.pgid > 0);
    assert.match(me.command, /node/);
    // The same answer twice (comparable, not locale-dependent text).
    assert.deepEqual(procInfo(process.pid), me);
    assert.equal(procInfo(2 ** 22 + 12345), null);
  },
);

test(
  "sweep: never this process's group, nor its parent's or any ancestor's — even when a record names them exactly",
  { skip: process.platform === "win32" && "no process groups on Windows" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "daisy-pg-"));
    try {
      const file = join(dir, "process-groups.json");
      const me = procInfo(process.pid)!,
        parent = procInfo(process.ppid)!;
      const entries = [
        { pgid: me.pgid, ...procInfo(me.pgid) },
        { pgid: process.pid, start: me.start, command: me.command },
        { pgid: parent.pgid, ...procInfo(parent.pgid) },
        { pgid: process.ppid, start: parent.start, command: parent.command },
      ].filter((e) => e.start);
      record(file, entries);
      const sent = await sweepOrphans(file, 200);
      assert.deepEqual(sent, [], "nothing signalled");
      assert.ok(alive(process.pid) && alive(process.ppid));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "sweep: a living leader is ended only when start time and command are the recorded ones",
  { skip: process.platform === "win32" && "no process groups on Windows" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "daisy-pg-"));
    const kids: ChildProcess[] = [];
    try {
      const file = join(dir, "process-groups.json");
      const start = () => {
        const c = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
        kids.push(c);
        return c;
      };
      const a = start(),
        b = start();
      await delay(200);
      const ia = procInfo(a.pid!)!,
        ib = procInfo(b.pid!)!;
      assert.equal(ia.pgid, a.pid, "its own group");
      record(file, [
        // Another command line under that pid: not ours.
        { pgid: a.pid, start: ia.start, command: "something else" },
        // Another start time: a reused pid.
        { pgid: b.pid, start: String(Number(ib.start) - 1000), command: ib.command },
      ]);
      assert.deepEqual(await sweepOrphans(file, 200), []);
      assert.ok(alive(a.pid!) && alive(b.pid!));
      record(file, [{ pgid: a.pid, start: ia.start, command: ia.command }]);
      assert.deepEqual(await sweepOrphans(file, 2000), [-a.pid!]);
      if (a.exitCode === null && a.signalCode === null)
        await new Promise((r) => a.once("exit", r));
      assert.equal(a.signalCode, "SIGTERM");
      assert.ok(alive(b.pid!));
    } finally {
      for (const k of kids)
        try {
          process.kill(-k.pid!, "SIGKILL");
        } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "sweep: the leader exited, its children live on in the group — they are ended (started after it); others of another group are not",
  { skip: process.platform === "win32" && "no process groups on Windows" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "daisy-pg-"));
    const kids: ChildProcess[] = [];
    try {
      const file = join(dir, "process-groups.json");
      // A leader that starts a child in its group and exits.
      const leader = spawn(
        "sh",
        ["-c", "sleep 30 & echo $!; sleep 0.3"],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      kids.push(leader);
      let out = "";
      leader.stdout!.on("data", (d) => (out += d));
      await delay(100);
      const li = procInfo(leader.pid!)!;
      await new Promise((r) => leader.once("exit", r));
      const child = Number(out.trim());
      assert.ok(alive(child), "the child outlives its leader");
      assert.equal(procInfo(child)!.pgid, leader.pid);
      const other = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
      kids.push(other);
      record(file, [{ pgid: leader.pid, start: li.start, command: li.command }]);
      const sent = await sweepOrphans(file, 2000);
      assert.deepEqual(sent, [child]);
      await delay(200);
      assert.equal(procInfo(child), null, "ended");
      assert.ok(alive(other.pid!));
      try {
        process.kill(child, "SIGKILL");
      } catch {}
    } finally {
      for (const k of kids)
        try {
          process.kill(-k.pid!, "SIGKILL");
        } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "an exec chain (`#!/usr/bin/env node`): the recorded command is read again once it settled, and the sweep takes `env x` ↔ `x` as the same",
  { skip: process.platform === "win32" && "no process groups on Windows" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "daisy-pg-"));
    const kids: ChildProcess[] = [];
    try {
      assert.equal(sameCommand("/usr/bin/env node /x/a.cjs run", "node /x/a.cjs run"), true);
      assert.equal(sameCommand("node /x/a.cjs run", "/usr/bin/env node /x/a.cjs run"), true);
      assert.equal(sameCommand("node /x/a.cjs run", "node /x/b.cjs run"), false);
      assert.equal(sameCommand("sleep 30", "xsleep 30"), false, "a word boundary");
      assert.equal(sameCommand("", "sleep 30"), false);
      // A script run through env, as the harness CLIs are.
      const script = join(dir, "orphan.sh");
      writeFileSync(script, "#!/usr/bin/env sh\nexec sleep 30\n", { mode: 0o755 });
      const file = join(dir, "process-groups.json");
      configureProcessGroups(file);
      const c = spawn(script, [], { detached: true, stdio: "ignore" });
      kids.push(c);
      trackGroup(c.pid);
      await delay(2500);
      const rec = JSON.parse(readFileSync(file, "utf8")).groups;
      assert.equal(rec.length, 1);
      assert.equal(rec[0].command, procInfo(c.pid!)!.command, "the settled command");
      // A record taken before the chain settled still matches.
      writeFileSync(
        file,
        JSON.stringify({
          owner: 1,
          groups: [{ ...rec[0], command: `/usr/bin/env ${rec[0].command}` }],
        }),
      );
      configureProcessGroups(null);
      assert.deepEqual(await sweepOrphans(file, 2000), [-c.pid!]);
    } finally {
      configureProcessGroups(null);
      for (const k of kids)
        try {
          process.kill(-k.pid!, "SIGKILL");
        } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "P5-04: the process table reads the same on Linux (/proc) and macOS (ps): parent, group, start time, name, zombies; Codex's sandbox reaper sees it too",
  { skip: process.platform === "win32" && "P5-05" },
  async () => {
    const { readProcTable, processName, commandLines, descendants, parsePs } = await import(
      "../packages/daisy/src/platform/proc-table.ts"
    );
    const { readProcs } = await import("../packages/daisy/src/platform/sandbox-reap.ts");
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await delay(200);
      const t = readProcTable();
      const me = t.get(process.pid)!;
      assert.ok(me, "this process is listed");
      assert.equal(me.ppid, process.ppid);
      assert.equal(me.start, procInfo(process.pid)!.start, "the same start time procInfo reads");
      assert.equal(me.pgid, procInfo(process.pid)!.pgid);
      assert.equal(me.zombie, false);
      assert.equal(t.get(child.pid!)!.ppid, process.pid);
      assert.equal(t.get(child.pid!)!.comm, "sleep");
      assert.ok(descendants(t, process.pid).has(child.pid!));
      assert.ok(processName(process.pid), "its short name");
      assert.match(commandLines([child.pid!]).get(child.pid!) ?? "", /^sleep 30\s*$/);
      // The stop scope's reaper: a real table (it was empty off Linux), command lines under the root.
      const procs = readProcs(process.pid);
      assert.equal(procs.get(child.pid!)!.parent, process.pid);
      assert.match(procs.get(child.pid!)!.cmdline, /sleep 30/);
      assert.equal(procs.get(process.ppid)?.cmdline ?? "", "", "command lines only under the root");
    } finally {
      child.kill("SIGKILL");
    }
    // macOS's ps lines: a command name with spaces, a zombie, a bad line.
    const ps = parsePs(
      [
        "  101     1   101 Ss   Tue Nov 17 10:00:00 2026     Google Chrome Helper",
        "  102   101   101 Z    Tue Nov 17 10:00:01 2026     sh",
        "garbage",
      ].join("\n"),
    );
    assert.equal(ps.get(101)!.comm, "Google Chrome Helper");
    assert.equal(ps.get(101)!.start, String(Date.parse("Tue Nov 17 10:00:00 2026 UTC")));
    assert.equal(ps.get(102)!.zombie, true);
    assert.equal(ps.size, 2);
  },
);
