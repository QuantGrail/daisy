import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../packages/daisy/src/app.ts";
import {
  Store,
  STORAGE,
  SCHEMA_VERSION,
  MIGRATIONS,
  VISIBLE_ITEM_SQL,
  openDatabase,
} from "../packages/daisy/src/store/index.ts";
import {
  destructiveStatements,
  type Migration,
} from "../packages/daisy/src/store/schema.ts";

// P1-04 (ADR-108; ADR-104 before it): the structure lives in
// packages/daisy/src/store/schema.ts as numbered steps, and only grows.
// During an update the old release may run on the new structure (the
// guard rolls the code back, the database stays), so:
//   - no DROP / RENAME of a table, column or view — unless the step says
//     `breaking` and why (old code then refuses the file, store/open.ts);
//   - DROP INDEX / DROP TRIGGER only to recreate the same name in the step;
//   - ADD COLUMN NOT NULL needs a DEFAULT (SQLite enforces it);
//   - never add a column to a table that released code writes with a
//     positional `INSERT INTO t VALUES(...)` (frozen below);
//   - step 1 (the clean start, D-06) is frozen;
//   - no DDL anywhere else in the control plane.

/** Every .ts under a directory, recursively. */
function sources(
  dir: string,
  skip: RegExp = /node_modules/,
): { f: string; text: string }[] {
  const out: { f: string; text: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (skip.test(p)) continue;
    if (e.isDirectory()) out.push(...sources(p, skip));
    else if (e.name.endsWith(".ts"))
      out.push({ f: p, text: readFileSync(p, "utf8") });
  }
  return out;
}
// The Daisy process's code (P1-02b: the control plane and the Runner are one
// package, and the Runner's result journal is in daisy.sqlite, step 5).
const SERVER = sources("packages/daisy/src");
const SCHEMA_FILE = join("packages/daisy/src/store/schema.ts");

const DDL =
  /\b(CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW))\b/gi;

test("schema: the control plane's structure is written only in store/schema.ts", () => {
  for (const { f, text } of SERVER) {
    if (f === SCHEMA_FILE) continue;
    const found = text.match(DDL);
    assert.equal(
      found,
      null,
      `${f}: ${found?.join(", ")} — structure changes are a numbered step in ${SCHEMA_FILE} (ADR-108)`,
    );
  }
});

test("schema: steps are numbered 1, 2, 3… and only add (a destructive step needs `breaking` and a reason)", () => {
  MIGRATIONS.forEach((m, i) => {
    assert.equal(m.version, i + 1);
    assert.ok(m.note.trim(), `step ${m.version}: note`);
    const bad = destructiveStatements(m.sql);
    if (bad.length)
      assert.ok(
        m.breaking && m.breaking.trim().length >= 10,
        `step ${m.version}: ${bad.join(", ")} takes something away from the previous release; only add (ADR-108), or set breaking with the reason`,
      );
    // A dropped index / trigger comes back in the same step.
    for (const d of m.sql.matchAll(
      /DROP\s+(INDEX|TRIGGER)\s+(?:IF\s+EXISTS\s+)?(\w+)/gi,
    ))
      assert.match(
        m.sql,
        new RegExp(
          `CREATE\\s+(UNIQUE\\s+)?${d[1]}\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${d[2]}\\b`,
          "i",
        ),
        `step ${m.version}: ${d[1]} ${d[2]} is dropped without being created again`,
      );
  });
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
});

test("schema: the destructive-statement check itself", () => {
  for (const sql of [
    "DROP TABLE users",
    "drop  table if exists x",
    "ALTER TABLE t DROP COLUMN c",
    "ALTER TABLE t DROP c",
    "ALTER TABLE t RENAME TO u",
    "ALTER TABLE t RENAME COLUMN a TO b",
    "DROP VIEW v",
  ])
    assert.ok(destructiveStatements(sql).length, sql);
  for (const sql of [
    "CREATE TABLE dropbox(x TEXT)",
    "-- DROP TABLE users (a comment)\nCREATE INDEX i ON t(x)",
    "ALTER TABLE t ADD COLUMN dropped INTEGER DEFAULT 0",
    "DROP INDEX i; CREATE INDEX i ON t(y)",
  ])
    assert.deepEqual(destructiveStatements(sql), [], sql);
  // And the code refuses to run such a step without a reason.
  const dir = mkdtempSync(join(tmpdir(), "daisy-drop-"));
  try {
    const steps: Migration[] = [
      ...MIGRATIONS,
      { version: SCHEMA_VERSION + 1, note: "删表", sql: "DROP TABLE audit" },
    ];
    assert.throws(() => openDatabase(dir, { migrations: steps }), /additive only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema: no destructive statement in any other code (plugins, the Runner's journal)", () => {
  for (const { f, text } of [
    ...sources("packages/daisy/src", /node_modules/),
    // P4-13: plugin packages' code (a peer dependency on @daisy-ai/daisy),
    // those this checkout has.
    ...readdirSync("packages")
      .filter(
        (p) =>
          existsSync(`packages/${p}/src`) &&
          existsSync(`packages/${p}/package.json`) &&
          JSON.parse(readFileSync(`packages/${p}/package.json`, "utf8")).peerDependencies?.["@daisy-ai/daisy"],
      )
      .flatMap((p) => sources(`packages/${p}/src`, /node_modules/)),
  ]) {
    if (f === SCHEMA_FILE) continue;
    const bad = destructiveStatements(text);
    assert.deepEqual(bad, [], `${f}: ${bad.join(", ")}`);
  }
});

/**
 * Step 1 is the clean start (D-06): once merged, a database may already be
 * at it. Changing it would leave those databases with a structure the
 * code does not describe — append a step instead. (Before step 1 was ever
 * used, an edit is allowed: update the hash and say why in the commit.)
 */
const V1_SHA256 =
  "92c6d77a5565a1b0887df9e8f46aa6bb42a60bb798a8e7cab15dd28ad85391df";
test("schema: step 1 is frozen", () => {
  const sha = createHash("sha256").update(MIGRATIONS[0].sql).digest("hex");
  assert.equal(
    sha,
    V1_SHA256,
    "step 1 changed: append a numbered step to MIGRATIONS instead (ADR-108)",
  );
});

test("schema: items_visible is the same SQL as the queries' VISIBLE_ITEM_SQL", () => {
  assert.ok(
    MIGRATIONS.some((m) =>
      m.sql.includes(
        `CREATE INDEX items_visible ON items(session_id) WHERE ${VISIBLE_ITEM_SQL};`,
      ),
    ),
    "VISIBLE_ITEM_SQL changed: re-create items_visible in a new step (DROP INDEX + CREATE INDEX)",
  );
});

/**
 * Tables released code inserts into positionally, and their column count
 * then. Adding a column to one of these breaks that INSERT in the previous
 * release (rollback, overlap): switch every INSERT into it to an explicit
 * column list first and keep the old count here until no release that
 * still inserts positionally can be rolled back to.
 */
const POSITIONAL: Record<string, number> = {
  attachments: 6,
  audit: 5,
  job_recoveries: 4,
  profiles: 5,
  retired_identities: 3,
  terminal_input: 5,
  workspaces: 4,
};
// P1-03 (ADR-110): `users` and `tokens` are gone (single owner) — the one
// sanctioned drop; nothing inserts into them any more.

test("P1-03: the accounts' tables are gone; the owner owns every row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-schema-p103-"));
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, workspaceRoots: [dir] });
  const tables = ctx.store
    .all("SELECT name FROM sqlite_master WHERE type='table'")
    .map((r: any) => r.name);
  assert.ok(!tables.includes("users") && !tables.includes("tokens"));
  for (const r of ctx.store.all("SELECT owner_id FROM profiles"))
    assert.equal(r.owner_id, "owner");
  // Step 1 itself (P1-03 changed it before any database was built with it):
  // no accounts' tables, no network-gate column.
  assert.doesNotMatch(MIGRATIONS[0].sql, /CREATE TABLE (users|tokens)\b|network_device/);
  // Review L-6: what is kept per person is kept for the owner.
  const h = { authorization: `Bearer ${ctx.issueToken()}` };
  const put = await ctx.app.inject({ method: "PUT", url: "/api/me/prompt", headers: h, payload: { note: "p1-03" } });
  assert.equal(put.statusCode, 200, put.body);
  const pref = await ctx.app.inject({ method: "PATCH", url: "/api/notification-preferences", headers: h, payload: {} });
  assert.ok(pref.statusCode < 300, pref.body);
  assert.deepEqual(
    ctx.store.all("SELECT DISTINCT user_id FROM user_prompt_prefs").map((r: any) => r.user_id),
    ["owner"],
  );
  for (const r of ctx.store.all("SELECT user_id FROM notification_preferences"))
    assert.equal(r.user_id, "owner");
  await ctx.app.close();
});

test("schema: tables written positionally keep their columns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-schema-"));
  const ctx = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  const cols = (t: string) => ctx.store.all(`PRAGMA table_info(${t})`).length;
  const positional = new Set<string>();
  for (const { text } of SERVER)
    for (const m of text.matchAll(
      /INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)\s+VALUES/gi,
    ))
      positional.add(m[1]);
  for (const t of positional)
    assert.ok(
      t in POSITIONAL,
      `${t} is now inserted positionally: write the column list instead (or add it to POSITIONAL with its column count)`,
    );
  for (const [t, n] of Object.entries(POSITIONAL))
    assert.equal(
      cols(t),
      n,
      `${t}: released code inserts into it positionally; a new column breaks that code (see POSITIONAL)`,
    );
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("schema: a database upgraded by newer code (additive steps) still opens, as it is", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-newer-"));
  try {
    new Store(dir).close();
    const db = new DatabaseSync(join(dir, STORAGE.file));
    const v = SCHEMA_VERSION + 1;
    db.exec(
      `CREATE TABLE future_table(x TEXT); ALTER TABLE nodes ADD COLUMN future_col TEXT;
       INSERT INTO schema_migrations(version,applied_at,readable_from,note) VALUES(${v},0,1,'future');
       PRAGMA user_version=${v}`,
    );
    db.close();
    const s = new Store(dir);
    assert.equal(Number(s.one("PRAGMA user_version").user_version), v);
    assert.deepEqual(
      { version: s.schema.version, code: s.schema.code, newer: s.schema.newer },
      { version: v, code: SCHEMA_VERSION, newer: true },
    );
    assert.ok(s.one("SELECT 1 FROM sqlite_master WHERE name='future_table'"));
    s.close();
    assert.equal(
      readdirSync(dir).includes(STORAGE.backups),
      false,
      "no upgrade, no backup",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
