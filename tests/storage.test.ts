import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../packages/daisy/src/app.ts";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  STORAGE,
  Store,
  StorageError,
  openDatabase,
  ownerOnly,
  restrictToOwner,
} from "../packages/daisy/src/store/index.ts";
import { pruneBackups } from "../packages/daisy/src/store/open.ts";
import type { Migration } from "../packages/daisy/src/store/schema.ts";

// P1-04 (ADR-108): one database file in the data directory, owner-only
// (S-3); a clean start (D-06: the old system's database is refused, never
// touched); numbered steps, a backup before an upgrade, the way back when
// it fails (R-5); old code on a newer file (launch.sh's guard rolled the
// code back).

const posix = process.platform !== "win32";
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `daisy-${p}-`));
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
const sha = (p: string) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
const backupsOf = (dir: string) =>
  existsSync(join(dir, STORAGE.backups))
    ? readdirSync(join(dir, STORAGE.backups)).sort()
    : [];
const version = (db: DatabaseSync) =>
  Number((db.prepare("PRAGMA user_version").get() as any).user_version);
/** Read a file as it is on disk, without opening it for writing. */
const peek = <T>(file: string, f: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return f(db);
  } finally {
    db.close();
  }
};
/** The real step 1 plus test steps 2..n (additive). */
const steps = (...extra: Omit<Migration, "version">[]): Migration[] => [
  ...MIGRATIONS,
  ...extra.map((m, i) => ({ ...m, version: MIGRATIONS.length + 1 + i })),
];
const addNotes: Omit<Migration, "version"> = {
  note: "测试：加一张表、一列",
  sql: "CREATE TABLE notes(id TEXT PRIMARY KEY, body TEXT NOT NULL); ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
};
const addMore = (n: number): Omit<Migration, "version"> => ({
  note: `测试：第 ${n} 张表`,
  sql: `CREATE TABLE more_${n}(x TEXT);`,
});
/** Some data at the current structure. */
function seed(dir: string) {
  const s = new Store(dir);
  s.run(
    "INSERT INTO sessions(id,owner_id,data) VALUES('s1','u1','{\"title\":\"旧会话\"}')",
  );
  s.audit("u1", "test.seed", "s1");
  s.close();
}

test("a new data directory: daisy.sqlite at the current structure, marked as Daisy's, no backup", () => {
  const dir = join(tmp("fresh"), "data");
  try {
    const s = new Store(dir);
    assert.equal(s.schema.version, SCHEMA_VERSION);
    assert.equal(
      Number(s.one("PRAGMA user_version").user_version),
      SCHEMA_VERSION,
    );
    assert.equal(
      Number(s.one("PRAGMA application_id").application_id),
      STORAGE.applicationId,
    );
    assert.deepEqual(
      s
        .all(
          "SELECT version, readable_from FROM schema_migrations ORDER BY version",
        )
        .map((r) => [r.version, r.readable_from]),
      MIGRATIONS.map((m) => [m.version, 1]),
    );
    assert.equal(s.one("PRAGMA journal_mode").journal_mode, "wal");
    s.close();
    assert.ok(existsSync(join(dir, STORAGE.file)));
    assert.ok(!existsSync(join(dir, STORAGE.legacyFile)));
    assert.deepEqual(backupsOf(dir), []);
    // Opening again changes nothing.
    new Store(dir).close();
    assert.deepEqual(backupsOf(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "S-3: the data directory, the database (and its -wal / -shm), backups and credential files are owner-only",
  { skip: !posix && "Windows: see the next test" },
  async () => {
    const root = tmp("perm");
    const dir = join(root, "data");
    try {
      const ctx = await createApp({ pinGate: false,
        dataDir: dir,
        workspaceHome: root,
        workspaceRoots: [root],
      });
      // A write, so the WAL files exist.
      ctx.store.audit("u", "test", "t");
      const files = [
        STORAGE.file,
        `${STORAGE.file}-wal`,
        `${STORAGE.file}-shm`,
        "master.key",
        // P1-03: no ACCESS.md (no accounts); the credentials are in keys/.
        "keys/cli-credential",
        "keys/identity-key.json",
        "runner.json",
      ];
      assert.equal(mode(dir), "700");
      for (const f of files) {
        assert.ok(existsSync(join(dir, f)), f);
        assert.equal(mode(join(dir, f)), "600", f);
        assert.equal(ownerOnly(join(dir, f)), true, f);
      }
      await ctx.app.close();

      // Loosened by hand (or by an old umask): tightened at the next start.
      chmodSync(dir, 0o755);
      chmodSync(join(dir, STORAGE.file), 0o644);
      chmodSync(join(dir, "master.key"), 0o644);
      seed(dir);
      assert.equal(mode(dir), "700");
      assert.equal(mode(join(dir, STORAGE.file)), "600");
      assert.equal(mode(join(dir, "master.key")), "600");

      // A backup and its directory too.
      const o = openDatabase(dir, { migrations: steps(addNotes) });
      o.db.close();
      assert.equal(mode(join(dir, STORAGE.backups)), "700");
      assert.equal(mode(o.backup!), "600");

      // Everything else that holds credentials or data, loosened, is
      // tightened at the next start: runner.json, RECOVERY.md,
      // backups/ and the copies in it, attachments/ and its files.
      writeFileSync(join(dir, "RECOVERY.md"), "secret", { mode: 0o644 });
      mkdirSync(join(dir, "attachments"), { recursive: true });
      writeFileSync(join(dir, "attachments", "a1"), "bytes", { mode: 0o644 });
      // (P1-03's keys/ files are not tightened but refused when loose:
      // tests/access.test.ts S-3.)
      const loose = [
        "runner.json",
        "RECOVERY.md",
        join(STORAGE.backups, o.backup!.split("/").pop()!),
        join("attachments", "a1"),
      ];
      for (const f of loose) chmodSync(join(dir, f), 0o644);
      chmodSync(join(dir, STORAGE.backups), 0o755);
      chmodSync(join(dir, "attachments"), 0o755);
      openDatabase(dir, { migrations: steps(addNotes) }).db.close();
      for (const f of loose) assert.equal(mode(join(dir, f)), "600", f);
      assert.equal(mode(join(dir, STORAGE.backups)), "700");
      assert.equal(mode(join(dir, "attachments")), "700");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("S-3 on Windows: owner-only ACL (P5-05, ADR-141) — set through the helper there; elsewhere the Windows branch changes nothing and says it cannot tell", () => {
  const dir = tmp("win");
  try {
    if (process.platform === "win32") {
      assert.equal(restrictToOwner(dir, "win32"), true);
      assert.equal(ownerOnly(dir, "win32"), true);
    } else {
      assert.equal(restrictToOwner(dir, "win32"), false);
      assert.equal(ownerOnly(dir, "win32"), null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the old version's database is refused with what to do, and never touched", () => {
  const dir = tmp("legacy");
  try {
    // An old data directory as the old version left it.
    const old = new DatabaseSync(join(dir, STORAGE.legacyFile));
    old.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT); INSERT INTO users VALUES('u','admin'); PRAGMA user_version=12;",
    );
    old.close();
    chmodSync(dir, 0o755);
    chmodSync(join(dir, STORAGE.legacyFile), 0o644);
    const before = {
      sha: sha(join(dir, STORAGE.legacyFile)),
      files: readdirSync(dir).sort(),
      mtime: statSync(join(dir, STORAGE.legacyFile)).mtimeMs,
    };
    assert.throws(
      () => new Store(dir),
      (e: any) =>
        e instanceof StorageError &&
        /旧版的数据库/.test(e.message) &&
        /不导入/.test(e.message) &&
        /新的数据目录/.test(e.message) &&
        /DAISY_DATA/.test(e.message),
    );
    // Nothing written: no daisy.sqlite, no master.key, the old file as it was.
    assert.deepEqual(readdirSync(dir).sort(), before.files);
    assert.equal(sha(join(dir, STORAGE.legacyFile)), before.sha);
    assert.equal(statSync(join(dir, STORAGE.legacyFile)).mtimeMs, before.mtime);
    if (posix) {
      assert.equal(mode(dir), "755", "not even the directory's mode");
      assert.equal(mode(join(dir, STORAGE.legacyFile)), "644");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an old database renamed to daisy.sqlite (or any foreign SQLite file) is refused; files, list and modes untouched", () => {
  const listing = (d: string) =>
    readdirSync(d)
      .sort()
      .map((f) => `${f}:${posix ? mode(join(d, f)) : ""}`);
  for (const live of [false, true]) {
    const dir = tmp(live ? "foreign-wal" : "foreign");
    let old: DatabaseSync | undefined;
    try {
      const file = join(dir, STORAGE.file);
      old = new DatabaseSync(file);
      old.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE nodes(id TEXT); INSERT INTO nodes VALUES('n'); PRAGMA user_version=12;",
      );
      // live: still open elsewhere, its newest pages only in the -wal file.
      if (!live) {
        old.close();
        old = undefined;
      } else assert.ok(existsSync(`${file}-wal`));
      chmodSync(dir, 0o755);
      const before = { list: listing(dir), sha: sha(file), dir: mode(dir) };
      assert.throws(
        () => new Store(dir),
        /不是 Daisy 的数据库[\s\S]*新的数据目录/,
        live ? "with -wal" : "header",
      );
      assert.deepEqual(listing(dir), before.list);
      assert.equal(sha(file), before.sha);
      if (posix) assert.equal(mode(dir), before.dir);
    } finally {
      old?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Not SQLite at all.
  const dir = tmp("garbage");
  try {
    writeFileSync(join(dir, STORAGE.file), "not a database ".repeat(20));
    assert.throws(() => new Store(dir), /不是 Daisy 的数据库/);
    assert.deepEqual(readdirSync(dir), [STORAGE.file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the process refuses to start on the old system's data directory and says what to do", () => {
  const dir = tmp("legacy-main");
  try {
    const old = new DatabaseSync(join(dir, STORAGE.legacyFile));
    old.exec("CREATE TABLE users(id TEXT)");
    old.close();
    const before = sha(join(dir, STORAGE.legacyFile));
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "packages/daisy/src/main.ts"],
      {
        env: {
          ...process.env,
          DAISY_DATA: dir,
          HARBOR_DATA: "",
          PORT: "0",
          DAISY_LOCAL_RUNNER: "0",
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /✗ .*旧版的数据库.*新的数据目录/);
    assert.equal(sha(join(dir, STORAGE.legacyFile)), before);
    assert.deepEqual(readdirSync(dir), [STORAGE.legacyFile]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R-5: an upgrade backs the database up first (VACUUM INTO, backups/), then every old row is still there", () => {
  const dir = tmp("upgrade");
  try {
    seed(dir);
    const file = join(dir, STORAGE.file);
    const o = openDatabase(dir, { migrations: steps(addNotes) });
    try {
      assert.equal(o.from, SCHEMA_VERSION);
      assert.equal(o.to, SCHEMA_VERSION + 1);
      assert.equal(version(o.db), SCHEMA_VERSION + 1);
      // Old data, new structure.
      const row = o.db
        .prepare("SELECT data, pinned FROM sessions WHERE id='s1'")
        .get() as any;
      assert.deepEqual({ ...row }, { data: '{"title":"旧会话"}', pinned: 0 });
      assert.equal(
        (o.db.prepare("SELECT count(*) n FROM audit").get() as any).n,
        1,
      );
      o.db.prepare("INSERT INTO notes VALUES('n1','新表能用')").run();
      assert.deepEqual(
        (
          o.db
            .prepare(
              "SELECT version, note FROM schema_migrations ORDER BY version",
            )
            .all() as any[]
        ).map((r) => r.version),
        [...MIGRATIONS.map((m) => m.version), SCHEMA_VERSION + 1],
      );
    } finally {
      o.db.close();
    }
    // The backup: in backups/, named by the structure versions, the old
    // structure with the old rows.
    assert.ok(o.backup);
    assert.equal(join(dir, STORAGE.backups, backupsOf(dir)[0]), o.backup);
    assert.match(
      o.backup!,
      new RegExp(
        `daisy-schema${SCHEMA_VERSION}-to${SCHEMA_VERSION + 1}-\\d{8}T\\d{9}Z\\.sqlite$`,
      ),
    );
    peek(o.backup!, (b) => {
      assert.equal(version(b), SCHEMA_VERSION);
      assert.equal(
        (b.prepare("SELECT data FROM sessions WHERE id='s1'").get() as any)
          .data,
        '{"title":"旧会话"}',
      );
      assert.equal(
        b.prepare("SELECT 1 FROM sqlite_master WHERE name='notes'").get(),
        undefined,
      );
    });
    // Reopening at the same version: no new backup.
    openDatabase(dir, { migrations: steps(addNotes) }).db.close();
    assert.equal(backupsOf(dir).length, 1);
    // And the real code still opens it (additive: newer than it knows).
    const s = new Store(dir);
    assert.equal(s.schema.newer, true);
    assert.equal(s.session("s1")?.title, "旧会话");
    s.close();
    assert.ok(existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R-5: from any older version, several steps at once — one backup, one transaction", () => {
  const dir = tmp("multi");
  try {
    seed(dir);
    const o = openDatabase(dir, {
      migrations: steps(addNotes, addMore(3), addMore(4)),
    });
    o.db.close();
    assert.equal(o.from, SCHEMA_VERSION);
    assert.equal(o.to, SCHEMA_VERSION + 3);
    assert.equal(backupsOf(dir).length, 1);
    // A database at step 2 goes to step 4 the same way.
    const dir2 = tmp("multi2");
    try {
      seed(dir2);
      openDatabase(dir2, { migrations: steps(addNotes) }).db.close();
      const o2 = openDatabase(dir2, {
        migrations: steps(addNotes, addMore(3), addMore(4)),
      });
      assert.equal(o2.from, SCHEMA_VERSION + 1);
      assert.equal(version(o2.db), SCHEMA_VERSION + 3);
      o2.db.close();
      assert.equal(backupsOf(dir2).length, 2);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R-5: backups keep the newest 3 (STORAGE.keepBackups), and only Daisy's own files are removed", () => {
  const dir = tmp("keep");
  try {
    assert.equal(STORAGE.keepBackups, 3);
    seed(dir);
    mkdirSync(join(dir, STORAGE.backups), { recursive: true });
    writeFileSync(
      join(dir, STORAGE.backups, "mine.sqlite"),
      "the owner's own copy",
    );
    let t = Date.parse("2026-11-17T08:00:00Z");
    const extra: Omit<Migration, "version">[] = [];
    const made: string[] = [];
    for (let n = 0; n < 5; n++) {
      extra.push(addMore(n));
      const o = openDatabase(dir, {
        migrations: steps(...extra),
        now: () => new Date((t += 60_000)),
      });
      o.db.close();
      made.push(o.backup!);
    }
    const left = backupsOf(dir);
    assert.deepEqual(
      left.filter((f) => f !== "mine.sqlite"),
      made
        .slice(-3)
        .map((p) => basename(p))
        .sort(),
    );
    assert.ok(left.includes("mine.sqlite"));
    // The prune itself: oldest by the time in the name.
    pruneBackups(join(dir, STORAGE.backups), 1);
    assert.deepEqual(
      backupsOf(dir),
      ["mine.sqlite", basename(made[4]!)].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R-5: a failing step rolls the whole upgrade back — the database is as it was, start-up stops and says what to do", () => {
  const dir = tmp("fail");
  try {
    seed(dir);
    const file = join(dir, STORAGE.file);
    const schemaBefore = peek(file, (db) =>
      db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(),
    );
    const failing = steps(addNotes, {
      note: "测试：一步会失败的迁移",
      sql: "CREATE TABLE half_done(x TEXT); INSERT INTO sessions(id,owner_id,data) VALUES('s2','u','{}'); SELECT no_such_function();",
    });
    assert.throws(
      () => openDatabase(dir, { migrations: failing }),
      (e: any) =>
        e instanceof StorageError &&
        new RegExp(
          `从第 ${SCHEMA_VERSION} 版升到第 ${SCHEMA_VERSION + 2} 版失败`,
        ).test(e.message) &&
        /测试：一步会失败的迁移/.test(e.message) &&
        /no_such_function/.test(e.message) &&
        /已经退回：整个升级在一个事务里回滚，数据库仍是第 \d+ 版，结构没有改动/.test(e.message) &&
        /换回上一版 Daisy/.test(e.message),
    );
    // As it was: version, structure (not even step 2's table), rows.
    peek(file, (db) => {
      assert.equal(version(db), SCHEMA_VERSION);
      assert.deepEqual(
        db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(),
        schemaBefore,
      );
      assert.deepEqual(
        (db.prepare("SELECT id FROM sessions ORDER BY id").all() as any[]).map(
          (r) => r.id,
        ),
        ["s1"],
      );
    });
    // The copy taken before is the file as it is: not kept.
    assert.deepEqual(backupsOf(dir), []);
    // This code still works on it, and the fixed upgrade goes through later.
    const s = new Store(dir);
    assert.equal(s.session("s1")?.title, "旧会话");
    s.close();
    const fixed = openDatabase(dir, {
      migrations: steps(addNotes, addMore(3)),
    });
    assert.equal(version(fixed.db), SCHEMA_VERSION + 2);
    fixed.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R-5: failing again and again does not push the useful backups out", () => {
  const dir = tmp("fail-repeat");
  try {
    seed(dir);
    let t = Date.parse("2026-11-17T08:00:00Z");
    const now = () => new Date((t += 60_000));
    // Two good upgrades: two useful copies.
    openDatabase(dir, { migrations: steps(addNotes), now }).db.close();
    openDatabase(dir, { migrations: steps(addNotes, addMore(3)), now }).db.close();
    const good = backupsOf(dir);
    assert.equal(good.length, 2);
    const failing = steps(addNotes, addMore(3), {
      note: "测试：总是失败",
      sql: "CREATE TABLE never(x TEXT); SELECT no_such_function();",
    });
    for (let n = 0; n < 5; n++)
      assert.throws(
        () => openDatabase(dir, { migrations: failing, now }),
        /已经退回/,
      );
    assert.deepEqual(backupsOf(dir), good);
    // The fixed upgrade then prunes as usual (keeps 3).
    for (let n = 4; n < 7; n++)
      openDatabase(dir, {
        migrations: steps(
          addNotes,
          addMore(3),
          ...Array.from({ length: n - 3 }, (_, i) => addMore(i + 4)),
        ),
        now,
      }).db.close();
    assert.equal(backupsOf(dir).length, STORAGE.keepBackups);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restore cut off half way (daisy.sqlite.restore) is cleaned up at start", () => {
  const dir = tmp("restore-left");
  try {
    seed(dir);
    writeFileSync(join(dir, `${STORAGE.file}.restore`), "partial copy");
    const s = new Store(dir);
    assert.equal(s.session("s1")?.title, "旧会话");
    s.close();
    assert.ok(!existsSync(join(dir, `${STORAGE.file}.restore`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R-5: when the rollback cannot undo a step (it committed on its own), the backup is put back", () => {
  const dir = tmp("restore");
  try {
    seed(dir);
    const file = join(dir, STORAGE.file);
    const rogue = steps({
      note: "测试：自己提交后失败",
      sql: "CREATE TABLE escaped(x TEXT); INSERT INTO sessions(id,owner_id,data) VALUES('s9','u','{}'); COMMIT; SELECT no_such_function();",
    });
    assert.throws(
      () => openDatabase(dir, { migrations: rogue }),
      /事务没能完全回滚，已从升级前的备份恢复：数据库回到第 \d+ 版/,
    );
    peek(file, (db) => {
      assert.equal(version(db), SCHEMA_VERSION);
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name='escaped'").get(),
        undefined,
      );
      assert.deepEqual(
        (db.prepare("SELECT id FROM sessions ORDER BY id").all() as any[]).map(
          (r) => r.id,
        ),
        ["s1"],
      );
    });
    if (posix) assert.equal(mode(file), "600");
    const s = new Store(dir);
    assert.equal(s.schema.version, SCHEMA_VERSION);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R-5: no backup, no upgrade — when the backup cannot be written the database is left alone", () => {
  const dir = tmp("nobackup");
  try {
    seed(dir);
    const file = join(dir, STORAGE.file);
    // Where backups/ should be there is a file: nothing can be written.
    writeFileSync(join(dir, STORAGE.backups), "in the way");
    const before = sha(file);
    assert.throws(
      () => openDatabase(dir, { migrations: steps(addNotes) }),
      (e: any) =>
        e instanceof StorageError &&
        /升级数据库结构（第 \d+ 版 → 第 \d+ 版）之前的备份没有写成/.test(
          e.message,
        ) &&
        /没有升级，数据库没有改动/.test(e.message),
    );
    peek(file, (db) => {
      assert.equal(version(db), SCHEMA_VERSION);
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name='notes'").get(),
        undefined,
      );
    });
    assert.equal(sha(file), before);
    assert.equal(
      readFileSync(join(dir, STORAGE.backups), "utf8"),
      "in the way",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code rolled back (launch.sh's guard): older code runs on a newer, additive structure as it is — no downgrade, no backup", () => {
  const dir = tmp("older-code");
  try {
    seed(dir);
    openDatabase(dir, { migrations: steps(addNotes) }).db.close();
    const backups = backupsOf(dir);
    // The previous release knows only the steps before.
    const o = openDatabase(dir, { migrations: MIGRATIONS });
    try {
      assert.equal(o.newer, true);
      assert.equal(version(o.db), SCHEMA_VERSION + 1, "left as it is");
      // It reads and writes what it knows; the new column's default fills in.
      o.db
        .prepare("INSERT INTO sessions(id,owner_id,data) VALUES('s3','u','{}')")
        .run();
      assert.equal(
        (o.db.prepare("SELECT pinned FROM sessions WHERE id='s3'").get() as any)
          .pinned,
        0,
      );
    } finally {
      o.db.close();
    }
    assert.deepEqual(backupsOf(dir), backups);
    // Back to the new code: nothing to do.
    const again = openDatabase(dir, { migrations: steps(addNotes) });
    assert.equal(again.backup, undefined);
    again.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code rolled back past a breaking step: refused, pointing at the backup taken before it; the file is not touched", () => {
  const dir = tmp("breaking");
  try {
    seed(dir);
    const file = join(dir, STORAGE.file);
    const breaking = steps(addNotes, {
      note: "测试：不兼容的一步",
      sql: "ALTER TABLE notes RENAME TO notes_v2;",
      breaking: "测试用：改名后旧代码找不到 notes 表",
    });
    const up = openDatabase(dir, { migrations: breaking });
    up.db.close();
    assert.equal(
      peek(
        file,
        (db) =>
          (
            db
              .prepare("SELECT max(readable_from) v FROM schema_migrations")
              .get() as any
          ).v,
      ),
      SCHEMA_VERSION + 2,
    );
    const before = peek(file, (db) =>
      db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(),
    );
    // Code from before the breaking step (it knows step 2, not 3).
    for (const older of [steps(addNotes), MIGRATIONS])
      assert.throws(
        () => openDatabase(dir, { migrations: older }),
        (e: any) =>
          e instanceof StorageError &&
          /旧代码不能用/.test(e.message) &&
          /数据库没有改动/.test(e.message) &&
          /换回新版本的 Daisy/.test(e.message) &&
          /backups.*备份.*替换 daisy\.sqlite/.test(e.message) &&
          /会丢失/.test(e.message),
      );
    peek(file, (db) => {
      assert.equal(version(db), SCHEMA_VERSION + 2);
      assert.deepEqual(
        db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(),
        before,
      );
    });
    // The new code itself opens it.
    openDatabase(dir, { migrations: breaking }).db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a migration list with a gap is a programming error, caught before the file is opened", () => {
  const dir = tmp("gap");
  try {
    assert.throws(
      () =>
        openDatabase(dir, {
          migrations: [
            ...MIGRATIONS,
            { ...addMore(9), version: SCHEMA_VERSION + 2 },
          ],
        }),
      /without gaps/,
    );
    assert.ok(!existsSync(join(dir, STORAGE.file)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
