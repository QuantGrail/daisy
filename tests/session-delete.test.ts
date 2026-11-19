import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { pidsWithEnv } from "./fixtures/proc-env.ts";
import { runNode, type NodeConfig } from "../packages/daisy/src/turns/worker.ts";
import { DaisyClient, DaisyError } from "../packages/client/src/index.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, accept: (x: T) => boolean) {
  for (let i = 0; i < 150; i++) {
    const x = await read();
    if (accept(x)) return x;
    await delay(100);
  }
  throw Error("State timed out");
}
/** Agent processes of a conversation: the test plugin tags them DAISY_TEST_SESSION=<id>. */
const agentPids = (sid: string) => pidsWithEnv("DAISY_TEST_SESSION", sid);

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "daisy-delete-"));
  const ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
  });
  const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const c = new DaisyClient(
    url,
    ctx.issueToken(),
  );
  const config: NodeConfig = JSON.parse(
    readFileSync(join(dir, "runner.json"), "utf8"),
  );
  config.api = ctx.runnerApi(config.nodeId);
  // The processes are found by DAISY_TEST_SESSION (P4-13: the test-only plugin).
  config.plugins = ["session-tag"];
  const controller = new AbortController();
  process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
  // Runner state (result journal, restart requests) under the test dir.
  config.identityRoot ??= join(dir, "runner-state-root");
  const worker = runNode(config, controller.signal);
  const cat = await c.catalog();
  const start = async (title: string) => {
    const s = await c.create({
      agent: "codex",
      title,
      profileId: cat.profiles.find((p) => p.agent === "codex")!.id,
      workspaceId: cat.workspaces[0].id,
    });
    // The fixture asks for a tool approval every turn: the agent process
    // stays alive, waiting — the case that piles up agents if a close only
    // hides the conversation.
    await c.send(s.id, "Hello", [], `${title}-1`);
    await until(
      () => c.snapshot(s.id),
      (x) => x.approvals.some((a) => a.status === "pending"),
    );
    assert.ok(agentPids(s.id).length >= 1, "agent process should be running");
    return s;
  };
  const close = async () => {
    controller.abort();
    await worker.catch(() => {});
    await ctx.app.close();
    delete process.env.DAISY_CODEX_BIN;
    rmSync(dir, { recursive: true, force: true });
  };
  return { c, ctx, start, close };
}

test(
  "deleting a conversation kills its running agent and purges every row",
  { timeout: 40000 },
  async () => {
    const { c, ctx, start, close } = await setup();
    try {
      const s = await start("delete-me");
      const r = await c.deleteSession(s.id);
      assert.equal(r.stopping, true);
      // Gone from the list and unreadable at once.
      assert.ok(!(await c.sessions()).some((x) => x.id === s.id));
      await assert.rejects(
        () => c.snapshot(s.id),
        (e: unknown) => e instanceof DaisyError && e.status === 404,
      );
      // The runner kills the agent's process group on its next pulse.
      await until(
        async () => agentPids(s.id),
        (p) => p.length === 0,
      );
      // ... and once the turn has ended every row of it is purged.
      const count = () =>
        ["sessions", "jobs", "items", "events", "approvals"].reduce(
          (n, t) =>
            n +
            ctx.store.one(
              `SELECT COUNT(*) n FROM ${t} WHERE ${t === "sessions" ? "id" : "session_id"}=?`,
              s.id,
            ).n,
          0,
        );
      await until(async () => count(), (n) => n === 0);
      // Deleting again: 404 (nothing left).
      await assert.rejects(
        () => c.deleteSession(s.id),
        (e: unknown) => e instanceof DaisyError && e.status === 404,
      );
    } finally {
      await close();
    }
  },
);

test(
  "archiving a conversation stops its running agent but keeps it",
  { timeout: 40000 },
  async () => {
    const { c, start, close } = await setup();
    try {
      const s = await start("archive-me");
      await c.updateSession(s.id, { archived: true });
      await until(
        async () => agentPids(s.id),
        (p) => p.length === 0,
      );
      const snap = await until(
        () => c.snapshot(s.id),
        (x) => x.session.status !== "running" && x.session.status !== "waiting",
      );
      assert.equal(snap.session.archived, true);
      assert.ok(!snap.approvals.some((a) => a.status === "pending"));
    } finally {
      await close();
    }
  },
);
