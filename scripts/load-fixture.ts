/** Reproducible control-plane concurrency smoke. No real agents or model charges. */
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { runNode } from "../packages/daisy/src/turns/worker.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
const dir = mkdtempSync(join(tmpdir(), "daisy-load-"));
const { app, store, issueToken } = await createApp({
  // A fixture for UI work, not about the PIN (D-36 gate off).
  pinGate: false,
  dataDir: join(dir, "data"),
  workspaceHome: dir,
  workspaceRoots: [dir],
});
const url = await app.listen({ host: "127.0.0.1", port: 0 }),
  c = new DaisyClient(url, issueToken());
const config = JSON.parse(readFileSync(join(dir, "data/runner.json"), "utf8"));
config.serverUrl = url;
config.concurrency = 8;
process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
const abort = new AbortController(),
  runner = runNode(config, abort.signal),
  start = Date.now(),
  latencies: number[] = [];
let maxRunning = 0;
try {
  const cat = await c.catalog(),
    p = cat.profiles.find((p) => p.agent === "codex")!;
  const sessions = await Promise.all(
    Array.from({ length: 24 }, async (_, i) => {
      const path = join(dir, `w${i}`);
      mkdirSync(path);
      const w = await c.request("/workspaces", "POST", {
        nodeId: p.nodeId,
        path,
        label: `load ${i}`,
      });
      const s = await c.create({
        agent: "codex",
        profileId: p.id,
        workspaceId: w.id,
        title: `load ${i}`,
      });
      const t = performance.now();
      const a = await c.send(s.id, `fixture ${i}`, [], `load-request-${i}`);
      const b = await c.send(s.id, `fixture ${i}`, [], `load-request-${i}`);
      if (a.id !== b.id) throw Error("Duplicate execution");
      latencies.push(performance.now() - t);
      return s;
    }),
  );
  const pending = new Set(sessions.map((s) => s.id));
  while (pending.size && Date.now() - start < 120000) {
    maxRunning = Math.max(
      maxRunning,
      store.one("SELECT COUNT(*) n FROM jobs WHERE status='running'").n,
    );
    await Promise.all(
      [...pending].map(async (id) => {
        const snap = await c.snapshot(id);
        for (const a of snap.approvals.filter((a) => a.status === "pending"))
          await c.approve(id, a.id, "accept");
        if (snap.session.status === "idle") {
          if (
            !snap.items.some(
              (i) => i.kind === "assistant" && i.text === "Hello",
            )
          )
            throw Error("Missing output");
          pending.delete(id);
        }
        if (["error", "interrupted"].includes(snap.session.status))
          throw Error("Unexpected failure");
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
  }
  if (pending.size) throw Error("Load timeout");
  latencies.sort((a, b) => a - b);
  const result = {
    fixture: true,
    sessions: sessions.length,
    jobs: store.one("SELECT COUNT(*) n FROM jobs").n,
    maxRunning,
    durationMs: Date.now() - start,
    duplicateSendPairP50Ms: Math.round(latencies[12]),
    duplicateSendPairP95Ms: Math.round(latencies[22]),
    failures: 0,
  };
  mkdirSync("artifacts", { recursive: true });
  writeFileSync("artifacts/load-fixture.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  abort.abort();
  await runner;
  await app.close();
  delete process.env.DAISY_CODEX_BIN;
  rmSync(dir, { recursive: true, force: true });
}
