import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dataDir, runtimeFile, startDataDir } from "../packages/daisy/src/platform/paths.ts";

test("the data directory follows each system's convention; DAISY_DATA wins; HARBOR_DATA is ignored (P1-04)", () => {
  assert.equal(dataDir({}, "linux", "/home/a"), "/home/a/.local/share/daisy");
  assert.equal(dataDir({ XDG_DATA_HOME: "/x/data" }, "linux", "/home/a"), "/x/data/daisy");
  // A relative XDG_DATA_HOME is invalid per the spec and ignored.
  assert.equal(dataDir({ XDG_DATA_HOME: "rel" }, "linux", "/home/a"), "/home/a/.local/share/daisy");
  assert.equal(dataDir({}, "darwin", "/Users/a"), "/Users/a/Library/Application Support/Daisy");
  assert.equal(
    dataDir({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a"),
    "C:\\Users\\a\\AppData\\Local\\Daisy",
  );
  assert.equal(dataDir({}, "win32", "C:\\Users\\a"), "C:\\Users\\a\\AppData\\Local\\Daisy");
  assert.ok(!dataDir({}, "linux", "/home/a").includes("/.daisy"), "not ~/.daisy (daisy-sdk)");
  assert.equal(dataDir({ DAISY_DATA: "/d", HARBOR_DATA: "/h" }, "linux", "/home/a"), "/d");
  // P1-02's launch.sh still exports HARBOR_DATA=<launcher>/data (the old
  // system's harbor.sqlite): not followed.
  assert.equal(dataDir({ HARBOR_DATA: "/h" }, "linux", "/home/a"), "/home/a/.local/share/daisy");
  assert.match(runtimeFile("/d"), /runtime\.json$/);
});

test("P1-04: a development checkout keeps <repo>/.data unless DAISY_DATA; a release or a package uses the convention", () => {
  const root = mkdtempSync(join(tmpdir(), "daisy-root-"));
  try {
    const env = { HOME: "/home/a", XDG_DATA_HOME: "/x" };
    // No .git (an installed package): the convention.
    assert.deepEqual(startDataDir(root, env), { dir: dataDir(env), dev: false });
    mkdirSync(join(root, ".git"));
    assert.deepEqual(startDataDir(root, env), { dir: join(root, ".data"), dev: true });
    assert.deepEqual(startDataDir(root, { ...env, DAISY_DATA: "/d" }), { dir: resolve("/d"), dev: false });
    // A release (it may carry .git too): never the checkout default.
    writeFileSync(join(root, ".release"), "abc\n");
    assert.deepEqual(startDataDir(root, env), { dir: dataDir(env), dev: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
