#!/usr/bin/env node
// Behavior tests for continuous integration on Linux, macOS and Windows (P0-01).
//
//   node scripts/ci-test.mjs                 run the tests, compare against the markers
//   node scripts/ci-test.mjs --write-pending mark this platform's current failures (bootstrap only)
//   node scripts/ci-test.mjs --shrink-check <git-ref>
//                                            fail when any platform has more markers than at <git-ref>
//
// tests/platform-pending.json lists, per platform, the tests marked "not yet
// supported on this system" (docs/DAISY-BUILD-PLAN.md P0-01, 9.1):
//   { "test": "tests/x.test.ts :: <top-level test name>", "reason": "..." }
//       the test still runs; a failure is tolerated, a pass is reported so the marker can go.
//   { "test": "tests/x.test.ts :: *", "reason": "..." }
//       the whole file is not run on that system (used on Windows, where many
//       tests hang until their timeout; P5-05 removes these).
// A failure that is not marked fails the run. The number of markers may only go down.
//
// Env: CI_TEST_TIMEOUT (ms per test, default 300000); CI_RESULTS_OUT (write failures as JSON);
// CI_TEST_FILES (comma-separated test files, e.g. tests/a.test.ts,tests/b.test.ts: run only those);
// CI_RUN_MARKED=1 (also run the files marked whole-file on this system — their failures stay
// tolerated, and a marked file whose every test passed is reported, so its marker can go: P5-05).
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pendingPath = join(root, "tests", "platform-pending.json");
const PLATFORMS = ["linux", "darwin", "win32"];
const WHOLE_FILE = " :: *";
const args = process.argv.slice(2);

function loadPending(text) {
  const data = JSON.parse(text);
  for (const p of PLATFORMS) data[p] ??= [];
  return data;
}

const rel = (file) => relative(root, file).split(sep).join("/");
const keyOf = (file, name) => `${rel(file)} :: ${name}`;

if (args[0] === "--shrink-check") {
  const ref = args[1];
  if (!ref || /^0+$/.test(ref)) {
    console.log("shrink-check: no base to compare with, skipped.");
    process.exit(0);
  }
  let baseText;
  try {
    baseText = execFileSync("git", ["show", `${ref}:tests/platform-pending.json`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    console.log(`shrink-check: ${ref} has no tests/platform-pending.json, skipped.`);
    process.exit(0);
  }
  const base = loadPending(baseText);
  const head = loadPending(readFileSync(pendingPath, "utf8"));
  // G-4: a platform's first baseline (written once with --write-pending from a
  // CI run) may add markers; after that it is listed in `bootstrapped` and its
  // markers may only go down. A base without the list counts every platform
  // that already had markers as bootstrapped.
  const wasBootstrapped = (p) =>
    Array.isArray(base.bootstrapped) ? base.bootstrapped.includes(p) : base[p].length > 0;
  let grew = false;
  for (const p of PLATFORMS) {
    const before = base[p].length;
    const after = head[p].length;
    const first = !wasBootstrapped(p) && Array.isArray(head.bootstrapped) && head.bootstrapped.includes(p);
    console.log(`${p}: ${before} -> ${after}${first && after > before ? " (first baseline)" : ""}`);
    if (after > before && !first) grew = true;
  }
  for (const p of Array.isArray(base.bootstrapped) ? base.bootstrapped : [])
    if (!(Array.isArray(head.bootstrapped) && head.bootstrapped.includes(p))) grew = true;
  if (grew) {
    console.error(
      "The number of 'not yet supported' markers went up. Markers may only be removed. " +
        "Fix the test on that system instead of marking it, or ask the dispatcher (DAISY-BUILD-PLAN 9.1).",
    );
    process.exit(1);
  }
  process.exit(0);
}

const platform = process.platform;
const pending = loadPending(existsSync(pendingPath) ? readFileSync(pendingPath, "utf8") : "{}");
const skippedFiles = new Set(
  pending[platform].filter((e) => e.test.endsWith(WHOLE_FILE)).map((e) => e.test.slice(0, -WHOLE_FILE.length)),
);
// P4-13: a plugin package's own tests (packages/<name>/tests) run
// too — when that package is there; the core's tests must pass without it.
const pluginTests = readdirSync(join(root, "packages"))
  .filter((p) => existsSync(join(root, "packages", p, "tests")))
  .sort()
  .flatMap((p) =>
    readdirSync(join(root, "packages", p, "tests"))
      .filter((f) => f.endsWith(".test.ts"))
      .sort()
      .map((f) => `packages/${p}/tests/${f}`),
  );
const files = readdirSync(join(root, "tests"))
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => `tests/${f}`)
  .concat(pluginTests)
  .filter((f) => process.env.CI_RUN_MARKED === "1" || !skippedFiles.has(f));
// Only these, when asked (debugging one file on a CI system).
const only = (process.env.CI_TEST_FILES || "")
  .split(",")
  .map((f) => f.trim().replace(/^\.\//, ""))
  .filter(Boolean);
for (const f of only)
  if (!files.includes(f)) {
    console.error(`CI_TEST_FILES: ${f} is not a test file here (or is skipped on ${platform}).`);
    process.exit(1);
  }
if (only.length) {
  files.splice(0, files.length, ...only);
  console.log(`CI_TEST_FILES: running only ${only.join(", ")}`);
}

// CI_RAW_OUT: results are appended as they arrive, so a run cut off by a timeout still leaves them.
const out = process.env.CI_RAW_OUT || join(mkdtempSync(join(tmpdir(), "daisy-ci-")), "results.jsonl");
const nodeArgs = [
  "--import",
  "tsx",
  "--test",
  // A test file that leaves handles open must not hold the whole run.
  "--test-force-exit",
  `--test-timeout=${Number(process.env.CI_TEST_TIMEOUT) || 300000}`,
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
  `--test-reporter=${pathToFileURL(join(root, "scripts", "ci-test-reporter.mjs")).href}`,
  `--test-reporter-destination=${out}`,
  ...files,
];
// P5-02 review L-4: no test reaches the network — the guard is preloaded in
// this run and in every process it starts (NODE_OPTIONS reaches the test
// files' processes and whatever they spawn). Refusals are listed at the end.
const guard = pathToFileURL(join(root, "tests", "no-network.mjs")).href;
// P6-20 (ADR-159): the tests' default language (zh-CN unless DAISY_LANG is set).
const testEnv = pathToFileURL(join(root, "tests", "test-env.mjs")).href;
const noNetLog = join(mkdtempSync(join(tmpdir(), "daisy-no-net-")), "refused.log");
const child = spawn(process.execPath, nodeArgs, {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${guard} --import ${testEnv}`.trim(), NO_NET_LOG: noNetLog },
});
const code = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1)));

const results = existsSync(out)
  ? readFileSync(out, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];
if (results.length === 0) {
  console.error(`No test results were recorded (node --test exited ${code}).`);
  process.exit(1);
}
const failedResults = results.filter((r) => r.status === "fail");
const failed = [...new Set(failedResults.map((r) => keyOf(r.file, r.name)))];
const passed = new Set(results.filter((r) => r.status === "pass").map((r) => keyOf(r.file, r.name)));

if (process.env.CI_RESULTS_OUT)
  writeFileSync(
    process.env.CI_RESULTS_OUT,
    JSON.stringify({ platform, failed, failedFiles: [...new Set(failedResults.map((r) => rel(r.file)))].sort() }, null, 2),
  );

if (args[0] === "--write-pending") {
  const known = new Map(pending[platform].map((e) => [e.test, e]));
  const reason = "baseline: fails on this system before the Daisy rebuild";
  const tests =
    platform === "win32"
      ? [...new Set(failedResults.map((r) => rel(r.file) + WHOLE_FILE)), ...skippedFiles.values().map((f) => f + WHOLE_FILE)]
      : failed;
  pending[platform] = [...new Set(tests)].sort().map((test) => known.get(test) ?? { test, reason });
  writeFileSync(pendingPath, JSON.stringify(pending, null, 2) + "\n");
  console.log(`Wrote ${pending[platform].length} ${platform} markers to tests/platform-pending.json`);
  process.exit(0);
}

const marked = new Map(pending[platform].map((e) => [e.test, e]));
const isMarked = (t) => marked.has(t) || marked.has(t.split(" :: ")[0] + WHOLE_FILE);
const unmarked = failed.filter((t) => !isMarked(t));
// A whole-file marker (run with CI_RUN_MARKED=1): the file ran and nothing in it failed.
const ranFiles = new Set(results.map((r) => rel(r.file)));
const failedFiles = new Set(failedResults.map((r) => rel(r.file)));
const nowPassing = [...marked.values()]
  .filter((e) =>
    e.flaky
      ? false
      : e.test.endsWith(WHOLE_FILE)
        ? ranFiles.has(e.test.slice(0, -WHOLE_FILE.length)) && !failedFiles.has(e.test.slice(0, -WHOLE_FILE.length))
        : passed.has(e.test),
  )
  .map((e) => e.test);

console.log("\n==== CI summary (" + platform + ") ====");
console.log(
  `top-level results: ${results.length}; failed: ${failed.length}; markers: ${marked.size} ` +
    `(whole files not run: ${skippedFiles.size})`,
);
if (nowPassing.length) {
  console.log(`\nMarked but now passing — remove these markers (${nowPassing.length}):`);
  for (const t of nowPassing) console.log(`  ${t}`);
}
// P5-02 review L-4: a test that tried to reach the network fails the run (fix it, or keep it on loopback).
const refusals = existsSync(noNetLog) ? readFileSync(noNetLog, "utf8").split("\n").filter((l) => /no-network guard/.test(l)) : [];
if (refusals.length) {
  console.error(`\nNetwork access refused by the no-network guard (${refusals.length}; details in ${noNetLog}):`);
  for (const l of [...new Set(refusals.map((l) => l.replace(/^\d+ /, "")))].slice(0, 20)) console.error(`  ${l}`);
}
if (unmarked.length) {
  console.error(`\nFailures without a marker (${unmarked.length}):`);
  for (const t of unmarked) console.error(`  ${t}`);
  process.exit(1);
}
if (refusals.length) process.exit(1);
console.log("\nNo unmarked failures.");
