/**
 * P6-15 (ADR-158, P5N-1): inside the data directory everything is
 * owner-only — the process masks 077 from its first line, every start
 * takes group / other bits off what is already there (lstat, never through
 * a link, only ours, a hard-linked file left alone), and `daisy doctor`
 * reports what is left. The AI's programs keep the mask Daisy was started
 * with (they work in the owner's folders).
 */
import { stopGracefully } from "./fixtures/stop-daisy.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { identityHomes, ownerOnlyTree } from "../packages/daisy/src/platform/data-perms.ts";
import { underUmask } from "../packages/daisy/src/platform/spawn.ts";
import { dataPermsCheck } from "../packages/daisy/src/cli/local/doctor.ts";
import { openDatabase } from "../packages/daisy/src/store/open.ts";

const posix = process.platform !== "win32";
const mode = (p: string) => statSync(p).mode & 0o777;

/** A data directory as an install from before this change left it: 0755 / 0644 inside a 0700 root. */
function looseDataDir() {
  const base = mkdtempSync(join(tmpdir(), "daisy-perms-"));
  const dir = join(base, "data");
  mkdirSync(join(dir, "runner", "node-1", "prof-1", "sessions"), { recursive: true, mode: 0o755 });
  mkdirSync(join(dir, "plugins", "p", "bin"), { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o700);
  for (const d of ["runner", "runner/node-1", "runner/node-1/prof-1", "runner/node-1/prof-1/sessions", "plugins", "plugins/p", "plugins/p/bin"])
    chmodSync(join(dir, d), 0o755);
  writeFileSync(join(dir, "runner", "node-1", "prof-1", "sessions", "s.jsonl"), "{}\n", { mode: 0o644 });
  writeFileSync(join(dir, "plugins", "p", "state.json"), "{}", { mode: 0o644 });
  writeFileSync(join(dir, "plugins", "p", "bin", "tool"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(dir, "runner.json"), JSON.stringify({ nodeId: "node-1" }), { mode: 0o644 });
  // Outside the data directory: never changed through a link or a hard link.
  const outside = join(base, "outside.txt");
  writeFileSync(outside, "x", { mode: 0o644 });
  chmodSync(outside, 0o644);
  symlinkSync(outside, join(dir, "plugins", "p", "link"));
  const shared = join(base, "shared.txt");
  writeFileSync(shared, "y", { mode: 0o644 });
  chmodSync(shared, 0o644);
  linkSync(shared, join(dir, "plugins", "p", "hard"));
  for (const f of ["runner/node-1/prof-1/sessions/s.jsonl", "plugins/p/state.json", "runner.json"]) chmodSync(join(dir, f), 0o644);
  chmodSync(join(dir, "plugins", "p", "bin", "tool"), 0o755);
  return { base, dir, outside, shared };
}

test("the walk: loose entries of ours tightened (owner bits kept), links and hard-linked files left alone; doctor before and after", { skip: !posix }, () => {
  const { base, dir, outside, shared } = looseDataDir();
  try {
    // Doctor: what is loose, the AI's homes looked at as folders only.
    const before = dataPermsCheck(dir);
    assert.equal(before.level, "warn");
    assert.match(before.detail, /组或其他账户有权限/);
    assert.match(before.detail, /AI 命令行自己的 1 个目录只查目录本身/);
    assert.match(before.fix!, /stop && .* start/);
    const dry = ownerOnlyTree(dir, { fix: false });
    assert.ok(dry.loose >= 10, JSON.stringify(dry));
    assert.equal(dry.tightened, 0);
    assert.equal(mode(join(dir, "plugins", "p", "state.json")), 0o644, "a dry run changes nothing");
    const r = ownerOnlyTree(dir, { fix: true });
    assert.equal(r.tightened, r.loose);
    assert.equal(r.linked, 1);
    assert.equal(mode(join(dir, "plugins", "p", "state.json")), 0o600);
    assert.equal(mode(join(dir, "plugins", "p", "bin", "tool")), 0o700, "a program stays runnable");
    assert.equal(mode(join(dir, "plugins", "p")), 0o700);
    assert.equal(mode(join(dir, "runner", "node-1", "prof-1", "sessions", "s.jsonl")), 0o600);
    assert.equal(mode(outside), 0o644, "never through a link");
    assert.equal(mode(shared), 0o644, "never a file another name shares");
    const again = ownerOnlyTree(dir, { fix: true });
    assert.equal(again.loose, 0);
    assert.equal(again.tightened, 0);
    // Doctor after: only the hard link is left (said, not a warning).
    const after = dataPermsCheck(dir);
    assert.equal(after.level, "info", after.detail);
    assert.match(after.detail, /硬链接/);
    rmSync(join(dir, "plugins", "p", "hard"));
    assert.equal(dataPermsCheck(dir).level, "ok");
    // Bounded.
    chmodSync(join(dir, "plugins", "p", "state.json"), 0o644);
    const capped = ownerOnlyTree(dir, { fix: false, maxEntries: 3 });
    assert.equal(capped.truncated, true);
    assert.equal(capped.checked, 3);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("review M1: a data directory that is itself a link is walked where it really is; doctor does not say OK", { skip: !posix }, () => {
  const { base, dir } = looseDataDir();
  try {
    const link = join(base, "data-link");
    symlinkSync(dir, link);
    const before = dataPermsCheck(link);
    assert.equal(before.level, "warn", before.detail);
    const r = ownerOnlyTree(link, { fix: true });
    assert.ok(r.tightened >= 10, JSON.stringify(r));
    assert.equal(mode(join(dir, "plugins", "p", "state.json")), 0o600);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("review L1: a folder swapped for a link during the walk is not walked into; nothing outside is changed", { skip: !posix }, () => {
  const { base, dir } = looseDataDir();
  try {
    const outsideDir = join(base, "outside-dir");
    mkdirSync(outsideDir);
    chmodSync(outsideDir, 0o755);
    writeFileSync(join(outsideDir, "victim.txt"), "v");
    chmodSync(join(outsideDir, "victim.txt"), 0o644);
    const target = join(realpathSync(dir), "plugins", "p");
    const r = ownerOnlyTree(dir, {
      fix: true,
      beforeReaddir: (d) => {
        if (d !== target) return;
        renameSync(target, `${target}.moved`);
        symlinkSync(outsideDir, target);
      },
    });
    assert.ok(r.failed >= 1, JSON.stringify(r));
    assert.equal(mode(join(outsideDir, "victim.txt")), 0o644);
    assert.equal(mode(outsideDir), 0o755);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("opening the database tightens the data directory (every start) and says what it did", { skip: !posix }, () => {
  const { base, dir } = looseDataDir();
  try {
    const o = openDatabase(dir);
    o.db.close();
    assert.ok(o.perms && o.perms.tightened >= 8, JSON.stringify(o.perms));
    // Review L3: an AI command line's home is tightened as a folder; what is inside is not walked at start.
    const homes = identityHomes(dir);
    assert.deepEqual([...homes], ["runner/node-1/prof-1"]);
    assert.equal(mode(join(dir, "runner", "node-1", "prof-1")), 0o700);
    assert.equal(mode(join(dir, "runner", "node-1", "prof-1", "sessions", "s.jsonl")), 0o644);
    assert.equal(ownerOnlyTree(dir, { fix: false, opaque: (rel) => homes.has(rel) }).loose, 0);
    assert.equal(mode(join(dir, "runner.json")), 0o600);
    // keys/: not touched here — a loose credential still refuses start-up (S-3).
    mkdirSync(join(dir, "keys"), { mode: 0o700 });
    writeFileSync(join(dir, "keys", "cli-credential"), "x", { mode: 0o644 });
    chmodSync(join(dir, "keys", "cli-credential"), 0o644);
    openDatabase(dir).db.close();
    assert.equal(mode(join(dir, "keys", "cli-credential")), 0o644);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the mask: Daisy's own files 0600 / 0700; a program the AI runs keeps the start's mask; carried to a successor", { skip: !posix }, () => {
  const base = mkdtempSync(join(tmpdir(), "daisy-umask-"));
  try {
    const script = join(base, "probe.mts");
    writeFileSync(
      script,
      [
        `import { mkdirSync, writeFileSync } from "node:fs";`,
        `import { once } from "node:events";`,
        `import { ownerOnlyUmask, startUmaskEnv } from ${JSON.stringify(resolve("packages/daisy/src/platform/umask.ts"))};`,
        `import { spawnTree } from ${JSON.stringify(resolve("packages/daisy/src/platform/spawn.ts"))};`,
        `const dir = process.argv[2];`,
        `const u = ownerOnlyUmask();`,
        `const left = process.env.DAISY_START_UMASK ?? null;`,
        `writeFileSync(dir + "/own.txt", "x");`,
        `mkdirSync(dir + "/own-dir");`,
        `const c = spawnTree("sh", ["-c", 'touch "$0"/ai.txt && mkdir "$0"/ai-dir && echo "$DAISY_START_UMASK"', dir], { stdio: ["ignore", "pipe", "inherit"] });`,
        `let out = ""; c.stdout!.on("data", (b) => (out += b));`,
        `await once(c, "exit");`,
        `process.stdout.write(JSON.stringify({ start: u.start, note: u.note ?? null, left, child: out.trim(), successor: startUmaskEnv() }));`,
      ].join("\n"),
    );
    const run = (mask: string, env: Record<string, string> = {}) => {
      const d = mkdtempSync(join(base, "d-"));
      const r = spawnSync("/bin/sh", ["-c", `umask ${mask} && exec "$0" --import tsx "$1" "$2"`, process.execPath, script, d], {
        env: { ...process.env, DAISY_START_UMASK: "", DAISY_RESPAWN_AFTER: "", ...env },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      return { d, out: JSON.parse(r.stdout) };
    };
    // `daisy start` from a shell with 022.
    const a = run("022");
    assert.equal(a.out.start, 0o022);
    assert.equal(a.out.left, null, "never left in the environment");
    assert.equal(a.out.child, "", "no child sees it");
    assert.deepEqual(a.out.successor, { DAISY_START_UMASK: "0022" }, "handed to a successor only");
    assert.equal(mode(join(a.d, "own.txt")), 0o600);
    assert.equal(mode(join(a.d, "own-dir")), 0o700);
    assert.equal(mode(join(a.d, "ai.txt")), 0o644, "the AI's program: the start's mask");
    assert.equal(mode(join(a.d, "ai-dir")), 0o755);
    // launchd / systemd already said 077: nothing changes for anyone.
    const b = run("077");
    assert.equal(mode(join(b.d, "ai.txt")), 0o600);
    // A successor started by a process that already masked 077 keeps the first one's.
    const c = run("077", { DAISY_START_UMASK: "0022", DAISY_RESPAWN_AFTER: "1" });
    assert.equal(c.out.start, 0o022);
    assert.equal(c.out.left, null);
    assert.equal(mode(join(c.d, "own.txt")), 0o600);
    assert.equal(mode(join(c.d, "ai.txt")), 0o644);
    // Review M2: refused first — not a successor: the variable is ignored (and removed).
    const d = run("077", { DAISY_START_UMASK: "0022" });
    assert.equal(d.out.start, 0o077);
    assert.equal(d.out.left, null);
    assert.equal(mode(join(d.d, "ai.txt")), 0o600);
    // A mask that lets group / others write is never handed on: 022 added back, said.
    for (const [mask, env] of [["000", {}], ["077", { DAISY_START_UMASK: "0002", DAISY_RESPAWN_AFTER: "1" }], ["020", {}]] as const) {
      const e = run(mask, env as Record<string, string>);
      assert.equal(e.out.start & 0o022, 0o022, `${mask} ${JSON.stringify(env)}`);
      assert.match(e.out.note, /lets the group or other accounts write/);
      assert.equal(mode(join(e.d, "ai.txt")) & 0o022, 0);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a program that is not installed is started as asked (the caller still sees ENOENT)", { skip: !posix }, () => {
  assert.deepEqual(underUmask("no-such-program-p6-15", ["a"], 0o022, "/nonexistent"), ["no-such-program-p6-15", ["a"]]);
  // Review L2: relative PATH entries and relative paths are not resolved here: started unwrapped.
  assert.deepEqual(underUmask("sh", ["x"], 0o022, "bin:."), ["sh", ["x"]]);
  assert.deepEqual(underUmask("./tool", ["x"], 0o022, "/bin"), ["./tool", ["x"]]);
  const [file, args] = underUmask("sh", ["-c", "true"], 0o022, "/bin:/usr/bin");
  assert.equal(file, "/bin/sh");
  assert.equal(args[1], 'umask 0022 && exec "$0" "$@"');
  assert.match(args[2]!, /\/sh$/);
  assert.deepEqual(args.slice(3), ["-c", "true"]);
});

test("the real start under a 022 shell: what was loose is tightened and nothing Daisy writes is readable by others", { skip: !posix }, async () => {
  const { base, dir, outside } = looseDataDir();
  // The fixture's AI home (the start may write its own runner.json).
  const homes = identityHomes(dir);
  const child = spawn("/bin/sh", ["-c", 'umask 022 && exec "$0" --import tsx "$1"', process.execPath, resolve("packages/daisy/src/main.ts")], {
    env: { ...process.env, DAISY_DATA: dir, DAISY_PORT: "", PORT: "", HOST: "", DAISY_LOCAL_RUNNER: "0", DAISY_START_UMASK: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  try {
    const runtime = join(dir, "runtime.json");
    for (let i = 0; i < 600 && !existsSync(runtime); i++) await sleep(100);
    assert.ok(existsSync(runtime), out);
    await sleep(300);
    const r = ownerOnlyTree(dir, { fix: false, opaque: (rel) => homes.has(rel) });
    assert.equal(r.loose, 0, `${JSON.stringify(r)}\n${out}`);
    assert.equal(mode(outside), 0o644);
    assert.match(out, /tightened so only you can read and write/);
    assert.ok(!readFileSync(runtime, "utf8").includes("BEGIN"), "nothing secret in the runtime file");
  } finally {
    stopGracefully(child, dir);
    await new Promise((ok) => child.once("exit", ok));
    rmSync(base, { recursive: true, force: true });
  }
});
