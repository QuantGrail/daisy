/**
 * The command reference (docs/guide/zh-CN/commands.md) is generated from
 * the `daisy` command's own tables by scripts/gen-cli-docs.mjs; like the
 * local API docs (tests/api-defs.test.ts), the committed file must match.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("docs/guide/zh-CN/commands.md matches the command table (node scripts/gen-cli-docs.mjs)", () => {
  const env = { ...process.env };
  delete env.DAISY_ACP_HARNESSES;
  // A child process: the script registers tsx itself and prints nothing on success.
  const out = execFileSync(process.execPath, ["scripts/gen-cli-docs.mjs", "--check"], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(out, "");
});
