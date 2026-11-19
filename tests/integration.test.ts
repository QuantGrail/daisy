import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { createApp } from "../packages/daisy/src/app.ts";
import { runNode, type NodeConfig } from "../packages/daisy/src/turns/worker.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => Promise<T>, accept: (x: T) => boolean) {
  for (let i = 0; i < 140; i++) {
    const x = await f();
    if (accept(x)) return x;
    await sleep(100);
  }
  throw Error("Timed out waiting for integration state");
}
test(
  "HTTP + in-process Runner + subprocess + WS: approval, disconnect, artifacts, cancellation",
  { timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "daisy-integrated-"));
    const ctx = await createApp({ pinGate: false,
      workspaceHome: dir,
      workspaceRoots: [dir],
      dataDir: dir,
    });
    const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const c = new DaisyClient(url, ctx.issueToken());
    const config: NodeConfig = JSON.parse(
      readFileSync(join(dir, "runner.json"), "utf8"),
    );
    config.api = ctx.runnerApi(config.nodeId);
    const controller = new AbortController();
    for (const a of ["CLAUDE", "CODEX", "KIMI"])
      process.env[`DAISY_${a}_BIN`] = resolve("tests/fixtures/agent.cjs");
    // Runner state (result journal, restart requests) under the test dir.
    config.identityRoot ??= join(dir, "runner-state-root");
    const worker = runNode(config, controller.signal);
    try {
      const cat = await c.catalog(),
        p = cat.profiles.find((p) => p.agent === "codex")!,
        w = cat.workspaces[0];
      writeFileSync(
        join(w.path, "daisy-test.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SVEAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      const s = await c.create({
        agent: "codex",
        title: "End-to-end",
        profileId: p.id,
        workspaceId: w.id,
        task: { id: "T42", title: "Task context" },
      });
      const ws = new WebSocket(url.replace("http", "ws") + "/api/live");
      await new Promise<void>((ok, bad) => {
        ws.on("error", bad);
        ws.on("open", () =>
          ws.send(
            JSON.stringify({
              type: "subscribe",
              sessionId: s.id,
              token: c.token,
            }),
          ),
        );
        ws.once("message", () => ok());
      });
      const attachment = await c.upload(
        "input.txt",
        "text/plain",
        Buffer.from("Input context").toString("base64"),
      );
      await c.send(s.id, "Hello", [attachment.id], "integration-command");
      const waiting = await until(
        () => c.snapshot(s.id),
        (x) => x.session.status === "waiting",
      );
      assert.equal(waiting.approvals.length, 1);
      ws.close();
      await sleep(200);
      assert.equal((await c.snapshot(s.id)).session.status, "waiting");
      // P1-02: no control-plane restart under a running turn any more —
      // control plane and Runner are one process, a restart ends the turn
      // (marked 中断, not replayed: tests/reliability.test.ts, R-1).
      assert.equal((await c.snapshot(s.id)).session.status, "waiting");
      await c.approve(s.id, waiting.approvals[0].id, "accept");
      const done = await until(
        () => c.snapshot(s.id),
        (x) => x.session.status === "idle",
      );
      assert.equal(done.session.nativeId, "codex-native");
      assert.ok(
        done.items.some(
          (i) => i.kind === "assistant" && i.text.includes("Hello"),
        ),
      );
      const artifact = done.items
        .flatMap((i) => i.attachments || [])
        .find((a) => a.mime === "image/png");
      assert.ok(artifact);
      assert.ok((await c.attachment(artifact!)).size > 0);
      assert.equal(done.items.filter((i) => i.kind === "assistant").length, 1);
      // P1-08: the turn's end and the answered card are notifications.
      const notes = await c.notifications({ sessionId: s.id });
      assert.equal(
        notes.items.find((n) => n.notificationId === `turn:${s.id}`)?.kind,
        "ai_private_message",
      );
      assert.equal(
        notes.items.find((n) => n.category === "approval")?.state,
        "handled",
      );
      const again = await c.send(
        s.id,
        "Hello",
        [attachment.id],
        "integration-command",
      );
      assert.equal(again.duplicate, true);
      assert.equal((await c.snapshot(s.id)).session.status, "idle");
      await c.send(s.id, "WAIT_UNTIL_CANCEL");
      await until(
        () => c.snapshot(s.id),
        (x) => x.session.status === "running",
      );
      await c.cancel(s.id);
      const cancelled = await until(
        () => c.snapshot(s.id),
        (x) => x.session.status === "interrupted",
      );
      assert.equal(cancelled.session.nativeId, "codex-native");
    } finally {
      controller.abort();
      await worker;
      await ctx.app.close();
      for (const a of ["CLAUDE", "CODEX", "KIMI"])
        delete process.env[`DAISY_${a}_BIN`];
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
