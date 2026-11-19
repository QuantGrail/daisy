import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { isolatedWorkspace } from "../packages/daisy/src/turns/worktrees.ts";
import { readOnlyLaunch } from "../packages/daisy/src/platform/read-only.ts";
import { preparePrompt } from "../packages/daisy/src/harness/shared.ts";
const signal = () => new AbortController().signal;

test("committed-only worktrees preserve dirty source and attachments stay private", async () => {
  const root = mkdtempSync(join(tmpdir(), "daisy-trees-")),
    src = join(root, "source");
  mkdirSync(src);
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", src, ...a], { stdio: "pipe" });
  try {
    git("init");
    writeFileSync(join(src, "file"), "committed");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "-m",
      "base",
    );
    writeFileSync(join(src, "file"), "dirty");
    const tree = await isolatedWorkspace(
      src,
      "reader",
      signal(),
      () => {},
      true,
    );
    assert.equal(readFileSync(join(tree.path, "file"), "utf8"), "committed");
    assert.equal(readFileSync(join(src, "file"), "utf8"), "dirty");
    mkdirSync(join(src, "sub"));
    assert.notEqual(src, tree.path);
    const p = preparePrompt(
      {
        id: "job",
        text: "review",
        attachments: [
          { id: "a", name: "a.txt", mime: "text/plain", data: "eA==" },
        ],
        session: {},
      } as any,
      src,
      join(root, "private"),
    );
    assert.ok(p.files[0].path.startsWith(join(root, "private")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "real kernel read-only isolation denies source and symlink writes while allowing private state/temp",
  { skip: process.platform !== "linux" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "daisy-readonly-"));
    const repo = join(root, "repo"),
      state = join(root, "state");
    mkdirSync(repo);
    mkdirSync(state);
    writeFileSync(join(repo, "file"), "original");
    symlinkSync(join(repo, "file"), join(state, "alias"));
    const job = {
      session: { workspaceMode: "read-only", agent: "claude" },
      profile: { configDir: state },
    } as any;
    try {
      const args = readOnlyLaunch(job, repo)!;
      const code = `const fs=require('node:fs'), assert=require('node:assert/strict');
      for(const p of ${JSON.stringify([join(repo, "file"), join(state, "alias")])})
        assert.throws(()=>fs.writeFileSync(p,'bad'), e=>e.code==='EROFS'||e.code==='EACCES');
      fs.writeFileSync(${JSON.stringify(join(state, "session"))},'ok');
      fs.writeFileSync(process.env.TMPDIR+'/scratch','ok');`;
      const r = spawnSync(
        "/usr/bin/bwrap",
        [...args, process.execPath, "-e", code],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(join(repo, "file"), "utf8"), "original");
      assert.throws(() => readOnlyLaunch(job, root), /重叠/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "all three adapters start inside enforced read-only execution (protocol fixtures)",
  { skip: process.platform !== "linux", timeout: 15000 },
  async () => {
    const { runClaude } =
      await import("../packages/daisy/src/harness/claude.ts");
    const { runCodex } =
      await import("../packages/daisy/src/harness/codex.ts");
    const { runKimi } = await import("../packages/daisy/src/harness/kimi.ts");
    const root = mkdtempSync(join(tmpdir(), "daisy-read-adapters-"));
    const state = join(root, "state"),
      repo = join(root, "repo");
    mkdirSync(state);
    mkdirSync(repo);
    try {
      for (const [agent, run] of Object.entries({
        claude: runClaude,
        codex: runCodex,
        kimi: runKimi,
      })) {
        const env = `DAISY_${agent.toUpperCase()}_BIN`,
          old = process.env[env];
        process.env[env] = join(process.cwd(), "tests/fixtures/agent.cjs");
        const events: any[] = [];
        try {
          await run({
            job: {
              id: "readonly-protocol",
              session: {
                id: "read",
                agent,
                workspaceMode: "read-only",
                nativeId: null,
              },
              profile: { authMode: "subscription", configDir: state },
              attachments: [],
            } as any,
            cwd: repo,
            prompt: "Hello",
            files: [],
            signal: signal(),
            emit: (type, data) => {
              events.push({ type, data });
            },
            flush: async () => {},
            approve: async () => ({
              optionId: agent === "codex" ? "accept" : "allow",
            }),
          });
          assert.ok(
            events.some((e) => e.type === "item" && e.data.text === "Hello"),
            agent,
          );
        } finally {
          if (old === undefined) delete process.env[env];
          else process.env[env] = old;
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
