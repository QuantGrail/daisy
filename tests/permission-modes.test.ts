import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
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

test(
  "automatic modes: claude auto, codex auto = auto_review, kimi yolo",
  { timeout: 40000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "daisy-modes-")),
      record = join(dir, "record.jsonl");
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
    const controller = new AbortController();
    process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
    process.env.DAISY_FIXTURE_RECORD_THREAD = record;
    // Runner state (result journal, restart requests) under the test dir.
    config.identityRoot ??= join(dir, "runner-state-root");
    const worker = runNode(config, controller.signal);
    try {
      const cat = await c.catalog();
      const pid = (a: string) => cat.profiles.find((p) => p.agent === a)!.id;
      // PATCH saves the model settings as a whole: carry model / effort along.
      const patch = (id: string, body: object) => {
        const p = cat.profiles.find((x) => x.id === id) as any;
        return c.request(`/profiles/${id}`, "PATCH", {
          model: p.model ?? "",
          reasoningEffort: p.reasoningEffort ?? "",
          ...body,
        });
      };
      await patch(pid("claude"), { permissionMode: "auto" });
      await patch(pid("codex"), { permissionMode: "auto" });
      await patch(pid("kimi"), { permissionMode: "yolo" });
      for (const [agent, mode] of [
        ["claude", "auto"],
        ["codex", "auto"],
        ["kimi", "yolo"],
      ])
        assert.equal(
          ((await c.catalog()).profiles.find((p) => p.id === pid(agent)) as any)
            .permissionMode,
          mode,
        );
      // Unknown modes are still refused.
      await assert.rejects(
        () => patch(pid("codex"), { permissionMode: "yolo" }),
        (e: unknown) => e instanceof DaisyError && e.status === 400,
      );
      // Codex "auto" reaches Codex as on-request + auto_review, sandboxed.
      const s = await c.create({
        agent: "codex",
        title: "auto review",
        profileId: pid("codex"),
        workspaceId: cat.workspaces[0].id,
      });
      await c.send(s.id, "Hello", [], "auto-review-1");
      const start = await until(
        async () =>
          existsSync(record)
            ? readFileSync(record, "utf8")
                .split("\n")
                .filter(Boolean)
                .map((l) => JSON.parse(l))
                .find((r) => r.via === "thread/start")
            : undefined,
        (r) => !!r,
      );
      assert.equal(start.approvalPolicy, "on-request");
      assert.equal(start.approvalsReviewer, "auto_review");
      assert.equal(start.sandbox, "workspace-write");
      await c.cancel(s.id);
    } finally {
      controller.abort();
      await worker.catch(() => {});
      await ctx.app.close();
      delete process.env.DAISY_CODEX_BIN;
      delete process.env.DAISY_FIXTURE_RECORD_THREAD;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
