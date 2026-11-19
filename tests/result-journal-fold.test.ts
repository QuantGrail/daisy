// P1-02b (gate G-2, ADR-108): the Runner's result journal is in daisy.sqlite
// (schema step 5). An install from before keeps it in
// `<runner state>/result-journal/<node key>/results.sqlite`: its rows are
// imported once on the first start after the upgrade, then the file is
// renamed (never deleted). Fresh installs never have the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../packages/daisy/src/store/open.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "../packages/daisy/src/store/schema.ts";
import {
  ResultJournal,
  importLegacyJournal,
  recoverJournal,
} from "../packages/daisy/src/turns/result-journal.ts";
import {
  journalRoot,
  openJournal,
  runNode,
  type NodeConfig,
} from "../packages/daisy/src/turns/worker.ts";
import { createApp } from "../packages/daisy/src/app.ts";
import { DaisyClient } from "../packages/client/src/index.ts";

const JOURNAL_TABLES = [
  "runner_journal_events",
  "runner_journal_imports",
  "runner_journal_jobs",
];
const tables = (db: DatabaseSync) =>
  (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'runner_journal%' ORDER BY name")
      .all() as any[]
  ).map((r) => r.name);

/**
 * The previous release's file, exactly as its ResultJournal created it
 * (`blocked` was added by ALTER TABLE; `withBlocked: false` is a file from
 * before that).
 */
function legacyJournal(
  dir: string,
  rows: {
    jobs: { id: string; lease: string; result?: unknown; updated: number; blocked?: string }[];
    events: { job: string; e: any }[];
  },
  withBlocked = true,
) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "results.sqlite"));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,lease TEXT NOT NULL,result TEXT,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,job TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS result_events_job ON events(job,seq);`);
  if (withBlocked) db.exec("ALTER TABLE jobs ADD COLUMN blocked TEXT");
  for (const j of rows.jobs) {
    db.prepare("INSERT INTO jobs(id,lease,result,updated) VALUES(?,?,?,?)").run(
      j.id,
      j.lease,
      j.result === undefined ? null : JSON.stringify(j.result),
      j.updated,
    );
    if (j.blocked) db.prepare("UPDATE jobs SET blocked=? WHERE id=?").run(j.blocked, j.id);
  }
  for (const { job, e } of rows.events)
    db.prepare("INSERT OR REPLACE INTO events(id,job,data) VALUES(?,?,?)").run(
      e.id,
      job,
      JSON.stringify(e),
    );
  db.close();
}

test("fresh install: daisy.sqlite has the journal tables at step 5, no results.sqlite is made, and nothing is imported", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-fold-fresh-"));
  try {
    const db = openDatabase(dir).db;
    // Step 5 and any later step (P4-01 added 6).
    assert.ok(SCHEMA_VERSION >= 5);
    assert.equal(MIGRATIONS[4]!.version, 5);
    assert.deepEqual(tables(db), JOURNAL_TABLES);
    const config = {
      nodeId: "node-1",
      identityRoot: join(dir, "runner"),
      api: Object.assign(async () => ({}), { journal: db }),
    } as unknown as NodeConfig;
    const j = openJournal(config);
    j.start("job", "lease");
    j.event("job", { id: "e1", type: "item", data: {} });
    j.finish("job", { status: "idle" });
    assert.equal(j.pending().length, 1);
    // The journal is rows in the one database; no file of its own.
    assert.equal(existsSync(join(journalRoot(config), "results.sqlite")), false);
    assert.equal(
      (db.prepare("SELECT count(*) n FROM runner_journal_imports").get() as any).n,
      0,
    );
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.endsWith(".sqlite")),
      ["daisy.sqlite"],
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upgrade: a version-4 database gains the journal tables (after a backup), the old results.sqlite is imported once and renamed, not deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-fold-upgrade-"));
  try {
    // The previous release: structure version 4, its journal in a file.
    openDatabase(dir, { migrations: MIGRATIONS.slice(0, 4) }).db.close();
    const legacy = join(dir, "runner", "result-journal", "key");
    legacyJournal(legacy, {
      jobs: [
        { id: "done", lease: "lease-done", result: { status: "idle" }, updated: 3 },
        { id: "cut", lease: "lease-cut", updated: 1 },
        { id: "refused", lease: "lease-old", result: { status: "idle" }, updated: 2, blocked: "403 old receipt" },
      ],
      events: [
        { job: "cut", e: { id: "cut-1", type: "item", data: { n: 1 } } },
        { job: "done", e: { id: "done-1", type: "item", data: { n: 2 } } },
        { job: "cut", e: { id: "cut-2", type: "item", data: { n: 3 } } },
      ],
    });
    const before = readFileSync(join(legacy, "results.sqlite"));

    const opened = openDatabase(dir);
    const db = opened.db;
    assert.equal(opened.from, 4);
    assert.equal(opened.to, SCHEMA_VERSION);
    // The backup taken before the step is the version-4 file as it was.
    assert.ok(opened.backup && existsSync(opened.backup));
    const b = new DatabaseSync(opened.backup!, { readOnly: true });
    assert.deepEqual(tables(b), []);
    b.close();
    assert.deepEqual(tables(db), JOURNAL_TABLES);

    const r = importLegacyJournal(db, legacy, "node-1", () => 42);
    assert.deepEqual(r, {
      file: join(legacy, "results.sqlite"),
      jobs: 3,
      events: 3,
      renamedTo: join(legacy, "results.sqlite.migrated"),
    });
    // Renamed, not deleted, and not changed (no -wal / -shm left beside it).
    assert.equal(existsSync(join(legacy, "results.sqlite")), false);
    assert.deepEqual(readFileSync(join(legacy, "results.sqlite.migrated")), before);
    assert.deepEqual(
      readdirSync(legacy).sort(),
      ["results.sqlite.migrated"],
    );
    const j = new ResultJournal(db, "node-1");
    // Same rows: pending (blocked one left out, as before), by `updated`.
    assert.deepEqual(
      j.pending().map((p) => [p.id, p.lease, p.result && JSON.parse(p.result).status]),
      [
        ["cut", "lease-cut", null],
        ["done", "lease-done", "idle"],
      ],
    );
    assert.equal(
      (db.prepare("SELECT blocked FROM runner_journal_jobs WHERE id='refused'").get() as any).blocked,
      "403 old receipt",
    );
    // Evidence keeps its order and its ids.
    assert.deepEqual(j.evidence("cut").map((e) => e.id), ["cut-1", "cut-2"]);
    assert.deepEqual(j.evidence("done"), [{ id: "done-1", type: "item", data: { n: 2 } }]);
    // Recorded once.
    assert.deepEqual(
      db.prepare("SELECT path,node,jobs,events,imported_at FROM runner_journal_imports").all().map((x) => ({ ...x })),
      [{ path: join(legacy, "results.sqlite"), node: "node-1", jobs: 3, events: 3, imported_at: 42 }],
    );
    // Second start: nothing there any more.
    assert.equal(importLegacyJournal(db, legacy, "node-1"), null);
    // The file back (a rename that failed after the import, or a copy put
    // back by hand): never imported twice; renamed out of the way again.
    copyFileSync(join(legacy, "results.sqlite.migrated"), join(legacy, "results.sqlite"));
    assert.deepEqual(importLegacyJournal(db, legacy, "node-1"), {
      file: join(legacy, "results.sqlite"),
      jobs: 0,
      events: 0,
      renamedTo: join(legacy, "results.sqlite.migrated-2"),
    });
    assert.equal(j.evidence("cut").length, 2);
    assert.equal(
      (db.prepare("SELECT count(*) n FROM runner_journal_jobs").get() as any).n,
      3,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upgrade: a journal file from before `blocked`, and one with nothing in it, import too", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-fold-old-"));
  try {
    const db = openDatabase(dir).db;
    const a = join(dir, "a"),
      empty = join(dir, "empty");
    legacyJournal(a, { jobs: [{ id: "x", lease: "l", updated: 1 }], events: [] }, false);
    mkdirSync(empty);
    new DatabaseSync(join(empty, "results.sqlite")).close();
    assert.equal(importLegacyJournal(db, a, "n1")?.jobs, 1);
    assert.deepEqual(new ResultJournal(db, "n1").pending().map((p) => [p.id, p.blocked]), [["x", null]]);
    assert.deepEqual(
      { ...importLegacyJournal(db, empty, "n2") },
      { file: join(empty, "results.sqlite"), jobs: 0, events: 0, renamedTo: join(empty, "results.sqlite.migrated") },
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upgrade: imported evidence is delivered by the usual recovery, with the original lease, then removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-fold-recover-"));
  try {
    const db = openDatabase(dir).db;
    const legacy = join(dir, "legacy");
    legacyJournal(legacy, {
      jobs: [{ id: "cut", lease: "lease-cut", updated: 1 }],
      events: [
        { job: "cut", e: { id: "cut-1", type: "item", data: { n: 1 } } },
        { job: "cut", e: { id: "cut-2", type: "item", data: { n: 2 } } },
      ],
    });
    importLegacyJournal(db, legacy, "node-1");
    const j = new ResultJournal(db, "node-1");
    const sent: any[] = [];
    await recoverJournal(j, new Set(), async (id, lease, body) => {
      sent.push({ id, lease, final: body.final, status: body.result.status, events: body.events.map((e: any) => e.id) });
      return body.final ? { recorded: true } : { chunkReceived: true };
    });
    assert.deepEqual(sent, [
      { id: "cut", lease: "lease-cut", final: false, status: "interrupted", events: ["cut-1", "cut-2"] },
      { id: "cut", lease: "lease-cut", final: true, status: "interrupted", events: [] },
    ]);
    assert.equal(j.pending().length, 0);
    assert.equal(
      (db.prepare("SELECT count(*) n FROM runner_journal_events").get() as any).n,
      0,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backups cover the journal: an upgrade's VACUUM INTO copy has its rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-fold-backup-"));
  try {
    const db = openDatabase(dir).db;
    const j = new ResultJournal(db, "node-1");
    j.start("job", "lease");
    j.event("job", { id: "e1", type: "item", data: { text: "kept" } });
    db.close();
    const next = [
      ...MIGRATIONS,
      { version: SCHEMA_VERSION + 1, note: "测试", sql: "CREATE TABLE fold_probe(x)" },
    ];
    const o = openDatabase(dir, { migrations: next });
    o.db.close();
    const b = new DatabaseSync(o.backup!, { readOnly: true });
    assert.deepEqual(
      b.prepare("SELECT node,id,job FROM runner_journal_events").all().map((r) => ({ ...r })),
      [{ node: "node-1", id: "e1", job: "job" }],
    );
    assert.equal((b.prepare("SELECT count(*) n FROM runner_journal_jobs").get() as any).n, 1);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first start after the upgrade (in process): runNode imports the old file before any work, and the turn it cut is settled from that evidence", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-fold-run-"));
  for (const a of ["CLAUDE", "CODEX", "KIMI"])
    process.env[`DAISY_${a}_BIN`] = resolve("tests/fixtures/agent.cjs");
  // The previous release's data directory: structure version 4.
  openDatabase(dir, { migrations: MIGRATIONS.slice(0, 4) }).db.close();
  const ctx = await createApp({
    pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  const controller = new AbortController();
  let worker: Promise<unknown> | undefined;
  try {
    assert.equal(ctx.store.schema.version, SCHEMA_VERSION);
    assert.ok(ctx.store.schema.backup, "upgraded after a backup");
    const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const c = new DaisyClient(url, ctx.issueToken());
    const config: NodeConfig = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
    config.api = ctx.runnerApi(config.nodeId);
    assert.equal(config.api.journal, ctx.store.db, "the Runner's journal is in daisy.sqlite");
    config.identityRoot = join(dir, "runner");
    const cat = await c.catalog();
    const s = await c.create({
      agent: "codex",
      title: "fold",
      profileId: cat.profiles.find((p) => p.agent === "codex")!.id,
      workspaceId: cat.workspaces[0].id,
    });
    await c.send(s.id, "Hello", [], "fold-turn-1");
    // The previous release's Runner had claimed the turn and written its
    // answer to its own file when the process was killed.
    const { job } = await config.api("/claim", {});
    assert.ok(job?.lease);
    const legacy = journalRoot(config);
    legacyJournal(legacy, {
      jobs: [{ id: job.id, lease: job.lease, result: { status: "idle" }, updated: Date.now() }],
      events: [
        {
          job: job.id,
          e: {
            id: `${job.id}:answer`,
            type: "item",
            data: { id: `${job.id}:answer`, kind: "assistant", text: "from the old journal", status: "complete", createdAt: Date.now() },
          },
        },
      ],
    });
    worker = runNode(config, controller.signal);
    const deadline = Date.now() + 30_000;
    let snap: any;
    for (;;) {
      snap = await c.snapshot(s.id);
      if (snap.items.some((i: any) => i.text === "from the old journal")) break;
      if (Date.now() > deadline) throw Error(`not delivered: ${JSON.stringify(snap.items)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(existsSync(join(legacy, "results.sqlite")), false);
    assert.ok(existsSync(join(legacy, "results.sqlite.migrated")));
    // Delivered: nothing left in the journal.
    for (let i = 0; i < 50; i++) {
      if (!(ctx.store.db.prepare("SELECT count(*) n FROM runner_journal_jobs").get() as any).n) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(
      (ctx.store.db.prepare("SELECT count(*) n FROM runner_journal_jobs").get() as any).n,
      0,
    );
  } finally {
    controller.abort();
    await worker?.catch(() => {});
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
