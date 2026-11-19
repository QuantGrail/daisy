import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { journalRoot, migrateStateKey } from "../packages/daisy/src/turns/worker.ts";
import { stateKey } from "../packages/daisy/src/update/restart.ts";

// P1-02: start-up of the one process.

// P1-03 (D-31): the local face listens on 127.0.0.1 only; another address
// is the outside face (settings, with the PIN), never HOST.
test("HOST other than 127.0.0.1 is refused at start-up, pointing to the outside face", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-start-"));
  try {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", resolve("packages/daisy/src/main.ts")],
      {
        env: {
          ...process.env,
          DAISY_DATA: join(dir, "data"),
          HOST: "192.0.2.50",
          PORT: "1",
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /listens on 127\.0\.0\.1 only/);
    assert.match(r.stderr, /outside face/);
    assert.equal(existsSync(join(dir, "data")), false, "nothing created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state of an older runner.json (keyed by server URL + node) moves to the node's key once — journal and plugin state, never over newer", () => {
  const root = mkdtempSync(join(tmpdir(), "daisy-statekey-"));
  try {
    const nodeId = "0b5c3c2e-1111-4222-8333-944445555666",
      url = "http://127.0.0.1:8787/";
    const key = (u: string) =>
      createHash("sha256").update(u + "|" + nodeId).digest("hex");
    // The journal under the trimmed URL's key (2026-11-01 on), a plugin's
    // cursor under the URL as configured (before that).
    const oldJournal = join(root, "result-journal", key(url.slice(0, -1)));
    mkdirSync(oldJournal, { recursive: true });
    writeFileSync(join(oldJournal, "results.sqlite"), "journal");
    mkdirSync(join(root, "some-plugin"));
    writeFileSync(
      join(root, "some-plugin", `${key(url)}.json`),
      '{"cursor":7}',
    );
    const config = { nodeId, identityRoot: root, serverUrl: url };
    const moved = migrateStateKey(config);
    assert.equal(moved.length, 2);
    const next = stateKey(nodeId);
    assert.equal(
      readFileSync(join(journalRoot(config as any), "results.sqlite"), "utf8"),
      "journal",
    );
    assert.equal(journalRoot(config as any), join(root, "result-journal", next));
    assert.equal(
      readFileSync(join(root, "some-plugin", `${next}.json`), "utf8"),
      '{"cursor":7}',
    );
    assert.equal(existsSync(oldJournal), false);
    // Once: nothing left to move; a newer state is never overwritten.
    assert.deepEqual(migrateStateKey(config), []);
    mkdirSync(join(root, "result-journal", key(url.slice(0, -1))));
    assert.deepEqual(migrateStateKey(config), []);
    assert.equal(
      readFileSync(join(journalRoot(config as any), "results.sqlite"), "utf8"),
      "journal",
    );
    // A new runner.json (no serverUrl): nothing to do.
    assert.deepEqual(migrateStateKey({ nodeId, identityRoot: root }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
