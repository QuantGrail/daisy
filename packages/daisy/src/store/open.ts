/**
 * P1-04 (ADR-108): opening the one database file in the data directory —
 * refusing the old system's data, owner-only permissions, the structure
 * version, the backup before an upgrade and the way back when it fails.
 */
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  openSync,
  readSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ownerT } from "../platform/language.ts";
import { isOwnerOnly, setOwnerOnly } from "../platform/windows/acl.ts";
import { MIGRATIONS, destructiveStatements, type Migration } from "./schema.ts";
import { identityHomes, ownerOnlyTree, type PermsReport } from "../platform/data-perms.ts";

/** Storage settings, in one place (ADR-104 decision 3, ADR-108). */
export const STORAGE = {
  /** The database (plan 3.5 principle 8: one file). */
  file: "daisy.sqlite",
  /** The old version's database: never imported, never touched (D-06). */
  legacyFile: "harbor.sqlite",
  /** Copies taken before a structure upgrade (VACUUM INTO). */
  backups: "backups",
  /** How many copies are kept (newest first). */
  keepBackups: 3,
  /** PRAGMA application_id of a Daisy database: "Dais". */
  applicationId: 0x44616973,
} as const;

/** Start-up stops with this: what happened and what to do (plan 3.7). */
/** What the data directory's owner is told (start problems): in the owner's language. */
const say = (dir: string) => ownerT(dir);

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

/**
 * Only the owner may read it (plan 3.7, S-3): 0700 for a directory, 0600
 * for a file. Windows (P5-05, ADR-141): a protected owner-only DACL (this
 * account, SYSTEM, Administrators; inheritable on a folder) through the
 * helper — false when the helper is not there (nothing changed).
 */
export function restrictToOwner(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return process.platform === "win32" && setOwnerOnly(path);
  chmodSync(path, statSync(path).isDirectory() ? 0o700 : 0o600);
  return true;
}

/** True when group and others have no access (Windows: the DACL); null where it cannot be told. */
export function ownerOnly(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean | null {
  if (platform === "win32") return process.platform === "win32" ? isOwnerOnly(path) : null;
  return (statSync(path).mode & 0o077) === 0;
}

export interface OpenOptions {
  /** The steps this code knows (tests pass their own). */
  migrations?: readonly Migration[];
  keepBackups?: number;
  now?: () => Date;
}

export interface Opened {
  db: DatabaseSync;
  /** Structure version found / now. */
  from: number;
  to: number;
  /** The copy taken before upgrading, if one was needed. */
  backup?: string;
  /** The file is newer than this code and was opened as it is (additive steps only). */
  newer?: boolean;
  /** P6-15: what the start's walk over the data directory found and tightened (POSIX). */
  perms?: PermsReport;
}

const DB_PRAGMAS =
  "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;";

/**
 * Open (creating if new) `<dir>/daisy.sqlite` at the structure the
 * migrations describe. Throws StorageError — start-up must stop — when the
 * directory holds the old system's database, the file is not a Daisy
 * database, it needs newer code, or an upgrade failed (then rolled back).
 */
export function openDatabase(dir: string, opts: OpenOptions = {}): Opened {
  const migrations = opts.migrations ?? MIGRATIONS;
  checkMigrations(migrations);
  // Nothing is written to the directory before this (D-06: an old one is
  // left exactly as it was — files, modes).
  checkDataDir(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictToOwner(dir);
  const perms = tightenDataDir(dir);
  const file = join(dir, STORAGE.file);
  // A restore cut off half way (killed): the file itself is either the
  // old one or already replaced; the partial copy goes.
  rmSync(`${file}.restore`, { force: true });
  // A new file is created owner-only before SQLite opens it; SQLite gives
  // its -wal / -shm files the same mode.
  if (!existsSync(file)) writeFileSync(file, "", { mode: 0o600, flag: "wx" });
  for (const f of [file, `${file}-wal`, `${file}-shm`])
    if (existsSync(f)) restrictToOwner(f);
  let db = new DatabaseSync(file);
  db.exec(DB_PRAGMAS);
  let result: Omit<Opened, "db">;
  try {
    result = migrate(db, dir, migrations, opts);
  } catch (e) {
    try {
      db.close();
    } catch {}
    if (e instanceof UpgradeFailed) throw new StorageError(recover(file, e));
    throw e;
  }
  for (const f of [`${file}-wal`, `${file}-shm`])
    if (existsSync(f)) restrictToOwner(f);
  return { db, ...result, ...(perms ? { perms } : {}) };
}

/**
 * Before anything is written: the old system's database, or a file that is
 * not a Daisy database, stops start-up. Writes nothing (start-up calls it
 * before taking the data directory's lock, too).
 */
export function checkDataDir(dir: string) {
  refuseLegacy(dir);
  const file = join(dir, STORAGE.file);
  if (existsSync(file) && statSync(file).size > 0) inspect(file);
}

/**
 * Every start (S-3): what holds credentials or data, owner-only — besides
 * the database and master.key (handled where they are opened). P6-15
 * (ADR-158, P5N-1): on Linux / macOS every entry, all the way down
 * (platform/data-perms.ts); Windows: the listed ones (the DACL).
 */
function tightenDataDir(dir: string): PermsReport | undefined {
  // keys/ is left to its own checks: a loose credential refuses start-up
  // (S-3, readSecretFile — it may already have been read); the outside
  // face's certificate and key are tightened where they are read (tls.ts).
  // Review L3: the AI command lines' homes as folders only (as doctor does).
  if (process.platform !== "win32") {
    const homes = identityHomes(dir);
    // P6-16 review M1: a loose runner.json stays loose (and distrusted —
    // the Daisy process does not start on it); tightening would launder it.
    return ownerOnlyTree(dir, { fix: true, opaque: (rel) => rel === "keys" || homes.has(rel), leave: (rel, st) => rel === "runner.json" && (st.mode & 0o022) !== 0 });
  }
  for (const f of ["ACCESS.md", "RECOVERY.md", "runner.json", "master.key"])
    if (existsSync(join(dir, f))) restrictToOwner(join(dir, f));
  for (const sub of [STORAGE.backups, "attachments"]) {
    const d = join(dir, sub);
    if (!existsSync(d) || !statSync(d).isDirectory()) continue;
    restrictToOwner(d);
    for (const e of readdirSync(d, { withFileTypes: true }))
      if (e.isFile() || e.isDirectory()) restrictToOwner(join(d, e.name));
  }
}

function refuseLegacy(dir: string) {
  const legacy = join(dir, STORAGE.legacyFile);
  if (existsSync(legacy))
    throw new StorageError(
      say(dir)("server-store.legacyDatabase", { dir, file: STORAGE.legacyFile }),
    );
}

const SQLITE_MAGIC = "SQLite format 3\0";

/**
 * An existing file must be a Daisy database. Read from its header (bytes
 * 0–15 the format, 40 the schema cookie, 60 user_version, 68
 * application_id) without opening it. Only when a -wal file beside it may
 * hold newer pages is it opened read-only — and the -wal / -shm that open
 * created are removed again.
 */
function inspect(file: string) {
  const notDaisy = new StorageError(
    say(dirname(file))("server-store.notDaisy", { file }),
  );
  const head = Buffer.alloc(100);
  let n = 0;
  try {
    const fd = openSync(file, "r");
    try {
      n = readSync(fd, head, 0, 100, 0);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    throw new StorageError(
      say(dirname(file))("server-store.unreadable", { file, error: (e as Error).message }),
    );
  }
  if (n < 100 || head.toString("latin1", 0, 16) !== SQLITE_MAGIC) throw notDaisy;
  let appId = head.readUInt32BE(68),
    version = head.readUInt32BE(60),
    cookie = head.readUInt32BE(40);
  if (appId === STORAGE.applicationId) return;
  if (existsSync(`${file}-wal`)) {
    // The header may be older than the log: look through SQLite.
    const had = [`${file}-wal`, `${file}-shm`].filter((f) => existsSync(f));
    try {
      const ro = new DatabaseSync(file, { readOnly: true });
      try {
        appId = Number(
          (ro.prepare("PRAGMA application_id").get() as any).application_id,
        );
        version = Number(
          (ro.prepare("PRAGMA user_version").get() as any).user_version,
        );
        cookie = Number(
          (ro.prepare("SELECT count(*) n FROM sqlite_master").get() as any).n,
        );
      } finally {
        ro.close();
      }
    } catch (e) {
      throw new StorageError(
        say(dirname(file))("server-store.unopenable", { file, error: (e as Error).message }),
      );
    } finally {
      for (const f of [`${file}-wal`, `${file}-shm`])
        if (!had.includes(f)) rmSync(f, { force: true });
    }
    if (appId === STORAGE.applicationId) return;
  }
  // Not marked: only a database with nothing in it yet may become Daisy's.
  if (version > 0 || cookie > 0) throw notDaisy;
}

/** Versions 1..n without gaps; no destructive statement without a reason. */
function checkMigrations(migrations: readonly Migration[]) {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1)
      throw Error(
        `Migration versions must be 1, 2, 3… without gaps: step ${i + 1} says ${m.version}`,
      );
    const bad = destructiveStatements(m.sql);
    if (bad.length && !(m.breaking && m.breaking.trim().length >= 10))
      throw Error(
        `Migration step ${m.version} has ${bad.join(", ")}: structure is additive only (ADR-108); when it is really needed, give the step a breaking reason`,
      );
  });
}

class UpgradeFailed extends Error {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly step: Migration,
    readonly cause: unknown,
    readonly backup: string | undefined,
    readonly intact: boolean,
  ) {
    super("upgrade failed");
  }
}

const userVersion = (db: DatabaseSync) =>
  Number((db.prepare("PRAGMA user_version").get() as any).user_version);
const readableFrom = (db: DatabaseSync) =>
  Number(
    (
      db
        .prepare("SELECT max(readable_from) v FROM schema_migrations")
        .get() as any
    )?.v ?? 1,
  );
/**
 * What a rollback must leave as it was: the version and every object's
 * SQL — the structure only. Rows are not compared: the steps' writes are
 * undone by the same ROLLBACK, which is what SQLite guarantees.
 */
const fingerprint = (db: DatabaseSync) =>
  JSON.stringify([
    userVersion(db),
    db
      .prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")
      .all(),
  ]);

function migrate(
  db: DatabaseSync,
  dir: string,
  migrations: readonly Migration[],
  opts: OpenOptions,
): Omit<Opened, "db"> {
  const target = migrations[migrations.length - 1].version;
  const from = userVersion(db);
  if (from === target) return { from, to: from };
  if (from > target) {
    // Code rolled back (the update's start guard) or started by hand: newer
    // structure. Additive steps (the rule) leave it readable as it is.
    const need = readableFrom(db);
    if (need > target)
      throw new StorageError(
        say(dir)("server-store.tooNew", {
          file: join(dir, STORAGE.file),
          from,
          need,
          target,
          backups: join(dir, STORAGE.backups),
          name: STORAGE.file,
        }),
      );
    return { from, to: from, newer: true };
  }
  // Only an upgrade of an existing database is backed up (ADR-104 C1).
  const backup =
    from > 0 ? backupDatabase(db, dir, from, target, opts) : undefined;
  const before = from > 0 ? fingerprint(db) : "";
  let step = migrations[0];
  db.exec("BEGIN IMMEDIATE");
  try {
    let readable = from > 0 ? readableFrom(db) : 1;
    for (step of migrations) {
      if (step.version <= from) continue;
      db.exec(step.sql);
      if (step.breaking) readable = step.version;
      db.prepare(
        "INSERT INTO schema_migrations(version,applied_at,readable_from,note) VALUES(?,?,?,?)",
      ).run(
        step.version,
        (opts.now?.() ?? new Date()).getTime(),
        readable,
        step.note,
      );
      db.exec(`PRAGMA user_version=${step.version}`);
    }
    if (from === 0) db.exec(`PRAGMA application_id=${STORAGE.applicationId}`);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    let intact = false;
    try {
      intact = from === 0 ? userVersion(db) === 0 : fingerprint(db) === before;
    } catch {}
    // Rolled back cleanly: the copy just taken is the file as it is — not
    // kept (repeated failures would otherwise fill backups/).
    if (intact && backup) rmSync(backup, { force: true });
    throw new UpgradeFailed(
      from,
      target,
      step,
      e,
      intact ? undefined : backup,
      intact,
    );
  }
  if (backup)
    pruneBackups(
      join(dir, STORAGE.backups),
      opts.keepBackups ?? STORAGE.keepBackups,
    );
  return { from, to: target, ...(backup ? { backup } : {}) };
}

/**
 * `VACUUM INTO` a consistent copy (WAL included), owner-only. Older copies
 * are pruned only after the upgrade committed (a failing upgrade, tried
 * again and again, must not push the useful copies out).
 */
function backupDatabase(
  db: DatabaseSync,
  dir: string,
  from: number,
  to: number,
  opts: OpenOptions,
): string {
  const backups = join(dir, STORAGE.backups);
  const stamp = (opts.now?.() ?? new Date())
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(".", "");
  let path = join(backups, `daisy-schema${from}-to${to}-${stamp}.sqlite`);
  for (let n = 2; existsSync(path); n++)
    path = join(backups, `daisy-schema${from}-to${to}-${stamp}-${n}.sqlite`);
  try {
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    restrictToOwner(backups);
    // VACUUM INTO accepts an empty file; created owner-only first.
    writeFileSync(path, "", { mode: 0o600, flag: "wx" });
    db.prepare("VACUUM INTO ?").run(path);
    restrictToOwner(path);
    const copy = new DatabaseSync(path, { readOnly: true });
    try {
      if (userVersion(copy) !== from) throw Error("the backup has the wrong structure version");
    } finally {
      copy.close();
    }
  } catch (e) {
    try {
      rmSync(path, { force: true });
    } catch {}
    throw new StorageError(
      say(dir)("server-store.backupFailed", { from, to, error: (e as Error).message, backups }),
    );
  }
  return path;
}

/**
 * P5-06 (ADR-145): the copy taken before Daisy itself is updated — every
 * update, whether or not the new code changes the structure (plan 7.6
 * P5-06 「更新前备份数据库」; a structure upgrade still takes its own copy
 * above). `VACUUM INTO` from a read-only connection of its own: consistent
 * while the running Daisy keeps its connection (WAL), and nothing in the
 * database changes. Owner-only, named after the two releases; the newest
 * `keep` stay. No database yet (a fresh data directory): null.
 */
export function backupForUpdate(
  dir: string,
  from: string | null,
  to: string,
  opts: { keep?: number; now?: () => Date } = {},
): string | null {
  const file = join(dir, STORAGE.file);
  if (!existsSync(file)) return null;
  const backups = join(dir, STORAGE.backups);
  const safe = (s: string | null) => (s ?? "unknown").replace(/[^\w.-]/g, "_").slice(0, 60);
  const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[-:]/g, "").replace(".", "");
  const base = `daisy-update-${safe(from)}-to-${safe(to)}-${stamp}`;
  let path = join(backups, `${base}.sqlite`);
  for (let n = 2; existsSync(path); n++) path = join(backups, `${base}-${n}.sqlite`);
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  restrictToOwner(backups);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    writeFileSync(path, "", { mode: 0o600, flag: "wx" });
    db.prepare("VACUUM INTO ?").run(path);
    restrictToOwner(path);
  } catch (e) {
    rmSync(path, { force: true });
    throw new StorageError(
      say(dir)("server-store.updateBackupFailed", { error: (e as Error).message, backups }),
    );
  } finally {
    db.close();
  }
  const ours = readdirSync(backups)
    .filter((f) => UPDATE_BACKUP_NAME.test(f))
    .sort((a, b) => stampOfUpdate(b).localeCompare(stampOfUpdate(a), "en", { numeric: true }));
  for (const f of ours.slice(Math.max(opts.keep ?? STORAGE.keepBackups, 1)))
    rmSync(join(backups, f), { force: true });
  return path;
}
const UPDATE_BACKUP_NAME = /^daisy-update-.+-\d{8}T\d{9}Z(?:-\d+)?\.sqlite$/;
const stampOfUpdate = (f: string) => /(\d{8}T\d{9}Z(?:-\d+)?)\.sqlite$/.exec(f)?.[1] ?? "";

const BACKUP_NAME = /^daisy-schema\d+-to\d+-\d{8}T\d{9}Z(?:-\d+)?\.sqlite$/;

/** The newest `keep` copies stay (by the time in the name); only our own files are removed. */
export function pruneBackups(
  backups: string,
  keep: number = STORAGE.keepBackups,
) {
  const stampOf = (f: string) => f.replace(/^daisy-schema\d+-to\d+-/, "");
  const ours = readdirSync(backups)
    .filter((f) => BACKUP_NAME.test(f))
    .sort((a, b) =>
      stampOf(b).localeCompare(stampOf(a), "en", { numeric: true }),
    );
  for (const f of ours.slice(Math.max(keep, 1)))
    rmSync(join(backups, f), { force: true });
}

/**
 * After a failed upgrade: the transaction was rolled back. If anything is
 * still different, the copy taken before goes back in place. Returns the
 * message start-up stops with.
 */
function recover(file: string, e: UpgradeFailed): string {
  const t = say(dirname(file));
  const head = t("server-store.upgrade.head", {
    from: e.from,
    to: e.to,
    step: e.step.version,
    note: e.step.note,
    error: String((e.cause as Error)?.message ?? e.cause),
  });
  const what = t("server-store.upgrade.what");
  const where = e.backup ? t("server-store.upgrade.where", { backup: e.backup }) : "";
  if (e.intact) return t("server-store.upgrade.rolledBack", { head, from: e.from, what });
  if (e.backup)
    try {
      for (const f of [`${file}-wal`, `${file}-shm`])
        rmSync(f, { force: true });
      const tmp = `${file}.restore`;
      copyFileSync(e.backup, tmp);
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
      const check = new DatabaseSync(file, { readOnly: true });
      try {
        if (userVersion(check) !== e.from) throw Error("the restored database has the wrong structure version");
      } finally {
        check.close();
      }
      return t("server-store.upgrade.restored", { head, from: e.from, where, what });
    } catch (r) {
      return t("server-store.upgrade.restoreFailed", {
        head,
        error: (r as Error).message,
        backup: e.backup,
        file,
        name: STORAGE.file,
        what,
      });
    }
  return t("server-store.upgrade.newFailed", { head, file });
}
