// C-1 device acceptance (2026-11-17, coordinator): the Daisy log's first
// lines — the whole release id on 「listening on」, and no Node
// 「ExperimentalWarning: SQLite is an experimental feature」 (only that
// warning is dropped; every other one still prints).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  QUIET_WARNINGS,
  serverCommand,
} from "../packages/daisy/src/platform/autostart.ts";

const SQLITE_WARNING = /SQLite is an experimental feature/;
const quiet = { encoding: "utf8" as const, env: { ...process.env, NODE_OPTIONS: "" } };

test("the daemon drops only Node's SQLite ExperimentalWarning", async (t) => {
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(QUIET_WARNINGS).href,
      "--input-type=module",
      "-e",
      [
        'import { DatabaseSync } from "node:sqlite";',
        'new DatabaseSync(":memory:");',
        // The warning as the Node versions that have it word it — emitted by
        // hand too, so the check means something on a Node that no longer
        // warns (node:sqlite is no longer experimental on 24.22, CI run 44103553516).
        'process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");',
        'process.emitWarning("another experiment", "ExperimentalWarning");',
        'process.emitWarning("old thing", "DeprecationWarning", "DEP_X");',
        'process.emitWarning(Object.assign(new Error("as object"), { name: "ExperimentalWarning" }));',
        'process.emitWarning("SQLite is an experimental feature, said someone else", "UserWarning");',
      ].join("\n"),
    ],
    quiet,
  );
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning: SQLite is an experimental feature/);
  assert.match(r.stderr, /ExperimentalWarning: another experiment/);
  assert.match(r.stderr, /DeprecationWarning: old thing/);
  assert.match(r.stderr, /ExperimentalWarning: as object/);
  assert.match(r.stderr, /UserWarning: SQLite is an experimental feature, said someone else/);
  // Without the preload this Node's own warning is there (the check means
  // something here) — on a Node that no longer prints it there is nothing
  // to compare with, and the preload has nothing to drop.
  const plain = spawnSync(process.execPath, ["--input-type=module", "-e", 'import "node:sqlite";'], quiet);
  assert.equal(plain.status, 0, plain.stderr);
  const warns = SQLITE_WARNING.test(plain.stderr);
  await t.test("without the preload this Node prints it", { skip: warns ? false : `Node ${process.version} no longer prints the SQLite ExperimentalWarning` }, () => {
    assert.match(plain.stderr, SQLITE_WARNING);
  });
});

test("the start command preloads it before tsx and the entry", () => {
  const c = serverCommand();
  assert.deepEqual(c.args.slice(0, 2), [
    "--import",
    pathToFileURL(QUIET_WARNINGS).href,
  ]);
  assert.equal(c.args[2], "--import");
  assert.match(c.args.at(-1)!, /main\.ts$/);
});

test("「listening on」 names the whole release id (0.1.0+97a438c807b8), not its first 7 characters", () => {
  const src = readFileSync("packages/daisy/src/daemon.ts", "utf8");
  const line = src.split("\n").find((l) => l.includes("listening on"))!;
  assert.match(line, /\$\{release \?\? "\(dev\)"\} listening on/);
  assert.doesNotMatch(line, /slice\(/);
});
