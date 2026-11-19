import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ensureUserBins } from "../packages/daisy/src/platform/agent-path.ts";

test("user CLI directories missing from the service PATH are appended once (CLI installed after enrolment)", () => {
  const home = mkdtempSync(join(tmpdir(), "ah-path-"));
  const env = { PATH: ["/opt/node/bin", "/usr/bin"].join(delimiter) };
  // Nothing installed yet: PATH unchanged.
  assert.deepEqual(ensureUserBins(env, home), []);
  assert.equal(env.PATH, ["/opt/node/bin", "/usr/bin"].join(delimiter));
  // Claude installed later creates ~/.local/bin.
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, "bin"), "not a directory");
  assert.deepEqual(ensureUserBins(env, home), [join(home, ".local/bin")]);
  assert.equal(env.PATH, ["/opt/node/bin", "/usr/bin", join(home, ".local/bin")].join(delimiter));
  // Idempotent; the configured order keeps precedence.
  assert.deepEqual(ensureUserBins(env, home), []);
  const env2 = { PATH: [join(home, ".local/bin"), "/usr/bin"].join(delimiter) };
  assert.deepEqual(ensureUserBins(env2, home), []);
  assert.equal(env2.PATH, [join(home, ".local/bin"), "/usr/bin"].join(delimiter));
});
