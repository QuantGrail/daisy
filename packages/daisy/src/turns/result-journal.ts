import { turnT } from "../harness/model-switch.ts";
import { DatabaseSync } from "node:sqlite";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { V5_RUNNER_JOURNAL } from "../store/schema.ts";

/**
 * Private local write-ahead journal. Recovery transports evidence, never reruns work.
 *
 * P1-02b (ADR-108, gate G-2): its rows live in the process's database
 * (daisy.sqlite, tables `runner_journal_*`, schema step 5), keyed by the
 * node they belong to — no longer a file of its own. The database is the
 * control plane's connection (`createApp(...).runnerApi(nodeId).journal`):
 * the journal never opens or closes it.
 */
export class ResultJournal {
  constructor(
    readonly db: DatabaseSync,
    readonly node: string,
  ) {}
  private size(cast: boolean) {
    return Number(
      (
        this.db
          .prepare(
            cast
              ? "SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) n FROM runner_journal_events WHERE node=?"
              : "SELECT COALESCE(SUM(length(data)),0) n FROM runner_journal_events WHERE node=?",
          )
          .get(this.node) as any
      ).n,
    );
  }
  start(id: string, lease: string) {
    if (this.size(false) > 100 * 1024 * 1024)
      throw Error(turnT()("server-turns.journal.full"));
    this.db
      .prepare(
        "INSERT OR IGNORE INTO runner_journal_jobs(node,id,lease,result,updated) VALUES(?,?,?,NULL,?)",
      )
      .run(this.node, id, lease, Date.now());
  }
  event(job: string, e: any) {
    const encoded = JSON.stringify(e);
    if (
      Buffer.byteLength(encoded) > 1200000 ||
      this.size(true) + Buffer.byteLength(encoded) > 100 * 1024 * 1024
    )
      throw Error(turnT()("server-turns.journal.capacity"));
    this.db
      .prepare(
        "INSERT OR REPLACE INTO runner_journal_events(node,id,job,data) VALUES(?,?,?,?)",
      )
      .run(this.node, e.id, job, encoded);
  }
  ack(ids: string[]) {
    const q = this.db.prepare(
      "DELETE FROM runner_journal_events WHERE node=? AND id=?",
    );
    for (const i of ids) q.run(this.node, i);
  }
  finish(id: string, result: unknown) {
    this.db
      .prepare(
        "UPDATE runner_journal_jobs SET result=?,updated=? WHERE node=? AND id=?",
      )
      .run(JSON.stringify(result), Date.now(), this.node, id);
  }
  pending() {
    return this.db
      .prepare(
        "SELECT id,lease,result,updated,blocked FROM runner_journal_jobs WHERE node=? AND blocked IS NULL ORDER BY updated LIMIT 50",
      )
      .all(this.node) as any[];
  }
  block(id: string, reason: string) {
    this.db
      .prepare("UPDATE runner_journal_jobs SET blocked=? WHERE node=? AND id=?")
      .run(reason.slice(0, 1000), this.node, id);
  }
  evidence(id: string) {
    return this.db
      .prepare(
        "SELECT data FROM runner_journal_events WHERE node=? AND job=? ORDER BY seq",
      )
      .all(this.node, id)
      .map((r: any) => JSON.parse(r.data));
  }
  remove(id: string) {
    atomically(this.db, () => {
      this.db
        .prepare("DELETE FROM runner_journal_events WHERE node=? AND job=?")
        .run(this.node, id);
      this.db
        .prepare("DELETE FROM runner_journal_jobs WHERE node=? AND id=?")
        .run(this.node, id);
    });
  }
  /** The database is the process's: nothing to close (kept for callers). */
  close() {}
}

/**
 * One transaction on a connection the control plane shares: inside its
 * own (store.atomic is synchronous, so only when called from one) the
 * statements simply join it.
 */
function atomically(db: DatabaseSync, fn: () => void) {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** The file each node's journal used to be (`<journal dir>/results.sqlite`). */
export const LEGACY_JOURNAL_FILE = "results.sqlite";

export interface LegacyImport {
  file: string;
  /** Rows taken over (0 / 0 when an earlier start had imported it already). */
  jobs: number;
  events: number;
  /** Where the old file is now. */
  renamedTo: string;
}

/**
 * P1-02b: an install from before this step kept node `node`'s journal in
 * `<dir>/results.sqlite` — unsent results and evidence a restart must
 * still deliver. On the first start after the upgrade its rows are copied
 * into daisy.sqlite (one transaction, recorded in runner_journal_imports
 * so they are never copied twice), then the file is renamed to
 * `results.sqlite.migrated` (with its -wal / -shm, if any) — not deleted.
 * Nothing there: null. A file that cannot be read stops the start (the
 * evidence in it would otherwise be lost silently).
 */
export function importLegacyJournal(
  db: DatabaseSync,
  dir: string,
  node: string,
  now: () => number = Date.now,
): LegacyImport | null {
  const file = join(dir, LEGACY_JOURNAL_FILE);
  if (!existsSync(file)) return null;
  let jobs = 0,
    events = 0;
  const done = db
    .prepare("SELECT 1 FROM runner_journal_imports WHERE path=?")
    .get(file);
  if (!done) {
    let old: DatabaseSync;
    try {
      old = new DatabaseSync(file);
    } catch (e) {
      throw Error(
        turnT()("server-turns.journal.unreadable", { file, error: (e as Error).message }),
      );
    }
    try {
      const tables = new Set(
        (
          old
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all() as any[]
        ).map((r) => r.name),
      );
      const blocked =
        tables.has("jobs") &&
        (old.prepare("PRAGMA table_info(jobs)").all() as any[]).some(
          (r) => r.name === "blocked",
        );
      const oldJobs = tables.has("jobs")
        ? (old
            .prepare(
              `SELECT id,lease,result,updated,${blocked ? "blocked" : "NULL AS blocked"} FROM jobs`,
            )
            .all() as any[])
        : [];
      const oldEvents = tables.has("events")
        ? (old
            .prepare("SELECT id,job,data FROM events ORDER BY seq")
            .all() as any[])
        : [];
      atomically(db, () => {
        const j = db.prepare(
          "INSERT OR IGNORE INTO runner_journal_jobs(node,id,lease,result,updated,blocked) VALUES(?,?,?,?,?,?)",
        );
        for (const r of oldJobs)
          jobs += Number(
            j.run(node, r.id, r.lease, r.result, r.updated, r.blocked).changes,
          );
        const e = db.prepare(
          "INSERT OR IGNORE INTO runner_journal_events(node,id,job,data) VALUES(?,?,?,?)",
        );
        for (const r of oldEvents)
          events += Number(e.run(node, r.id, r.job, r.data).changes);
        db.prepare(
          "INSERT INTO runner_journal_imports(path,node,jobs,events,imported_at) VALUES(?,?,?,?,?)",
        ).run(file, node, jobs, events, now());
      });
    } finally {
      old.close();
    }
  }
  let to = `${file}.migrated`;
  for (let n = 2; existsSync(to); n++) to = `${file}.migrated-${n}`;
  renameSync(file, to);
  for (const side of ["-wal", "-shm"])
    if (existsSync(file + side)) renameSync(file + side, to + side);
  return { file, jobs, events, renamedTo: to };
}

/**
 * A journal for a Runner without the process's database (a test's
 * stand-in for the control plane): in memory, one per journal directory,
 * same tables (schema step 5). Production always has the database
 * (main.ts: `ctx.runnerApi`).
 */
const standIns = new Map<string, DatabaseSync>();
export function standInJournalDb(dir: string): DatabaseSync {
  let db = standIns.get(dir);
  if (!db) {
    db = new DatabaseSync(":memory:");
    db.exec(V5_RUNNER_JOURNAL);
    standIns.set(dir, db);
  }
  return db;
}

/** Bound each pass; a permanently rejected record cannot block other results or new work. */
export async function recoverJournal(
  journal: ResultJournal,
  active: Set<string>,
  send: (id: string, lease: string, body: any) => Promise<any>,
  onError: (id: string, error: unknown) => void = () => {},
) {
  for (const entry of journal
    .pending()
    .filter((r) => !active.has(r.id))
    .slice(0, 5)) {
    try {
      const events = journal.evidence(entry.id).slice(0, 20);
      const result = entry.result
        ? JSON.parse(entry.result)
        : {
            status: "interrupted",
            // P1-02: the whole process restarted (crash, kill, forced update)
            // under this turn; R-1: 中断, never replayed.
            detail: turnT()("server-turns.journal.interrupted"),
          };
      if (events.length) {
        const chunk = await send(entry.id, entry.lease, {
          result,
          events,
          final: false,
        });
        if (!chunk.chunkReceived) throw Error(turnT()("server-turns.journal.chunkUnconfirmed"));
        journal.ack(events.map((e) => e.id));
        if (journal.evidence(entry.id).length) continue;
      }
      const receipt = await send(entry.id, entry.lease, {
        result,
        events: [],
        final: true,
      });
      if (receipt.recorded) journal.remove(entry.id);
    } catch (error: any) {
      if (
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 401 &&
        error.status !== 429
      )
        journal.block(entry.id, String(error.message));
      onError(entry.id, error);
    }
  }
}
