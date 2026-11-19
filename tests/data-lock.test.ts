import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCK_FILE,
  acquireDataLock,
  lockHeld,
} from "../packages/daisy/src/store/data-lock.ts";
import { procInfo } from "../packages/daisy/src/platform/process-groups.ts";

// P1-04 review (ADR-102 decision 4): one Daisy per data directory.

const posix = process.platform !== "win32";
const tmp = () => mkdtempSync(join(tmpdir(), "daisy-lock-"));
/** Another live process (its pid and start time). */
async function other(): Promise<ChildProcess> {
  const p = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  await new Promise((r) => p.once("spawn", r));
  return p;
}
const holder = (pid: number, start: string | null) =>
  JSON.stringify({ pid, start, at: Date.parse("2026-11-17T08:00:00Z") });

test("the lock: taken, owner-only, names this process, released", () => {
  const dir = join(tmp(), "data");
  try {
    const release = acquireDataLock(dir);
    const file = join(dir, LOCK_FILE);
    const h = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(h.pid, process.pid);
    if (posix) {
      assert.equal((statSync(file).mode & 0o777).toString(8), "600");
      assert.equal((statSync(dir).mode & 0o777).toString(8), "700");
    }
    release();
    assert.ok(!existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second Daisy on the same data directory is refused and told who holds it", async () => {
  const dir = tmp();
  const p = await other();
  try {
    writeFileSync(
      join(dir, LOCK_FILE),
      holder(p.pid!, procInfo(p.pid!)?.start ?? null),
    );
    assert.ok(lockHeld(JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8"))));
    assert.throws(
      () => acquireDataLock(dir),
      new RegExp(`已经有一个 Daisy 在运行（进程号 ${p.pid}[\\s\\S]*DAISY_DATA`),
    );
    // The process itself refuses to start, before touching anything else.
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "packages/daisy/src/main.ts"],
      {
        env: { ...process.env, DAISY_DATA: dir, PORT: "0", DAISY_LOCAL_RUNNER: "0" },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`✗ .*已经有一个 Daisy 在运行（进程号 ${p.pid}`));
    assert.ok(!existsSync(join(dir, "daisy.sqlite")));
    assert.equal(JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")).pid, p.pid);
  } finally {
    p.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale lock is taken over: the process is gone, the pid was reused, or the file is half written", async () => {
  // Gone.
  const gone = spawnSync(process.execPath, ["-e", "process.pid"]);
  const deadPid = gone.pid!;
  const p = await other();
  try {
    for (const content of [
      holder(deadPid, null),
      // pid alive but started at another time: someone else's now.
      ...(procInfo(p.pid!) ? [holder(p.pid!, "1999-01-01T00:00:00.000Z")] : []),
      "",
    ]) {
      const dir = tmp();
      try {
        writeFileSync(join(dir, LOCK_FILE), content);
        const release = acquireDataLock(dir);
        assert.equal(
          JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")).pid,
          process.pid,
          content || "(empty)",
        );
        release();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    p.kill();
  }
});
