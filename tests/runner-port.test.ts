import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import {
  RunnerCallError,
  RunnerCallTimeout,
  RunnerPort,
} from "../packages/daisy/src/app/runner-port.ts";

// P1-02: the Runner's calls are in process (RunnerPort). The same calls as
// POST /api/runner/<path> had — paths, bodies, answers, errors — and
// nothing of them reachable over HTTP.

/** Every call the Runner made over HTTP before P1-02, but the heartbeat and 「重启」. */
const CALLS = [
  "/claim",
  "/sessions/gone",
  "/jobs/:id/identity-carried",
  "/jobs/:id/artifacts",
  "/jobs/:id/pulse",
  "/jobs/:id/events",
  "/jobs/:id/recover",
  "/jobs/:id/complete",
  "/sessions/:id/title",
  "/inputs/:mid/state",
  "/inputs/:mid/withdraw",
  "/jobs/:id/operation-result",
  "/jobs/:id/input/claim",
  "/jobs/:id/input/:mid/complete",
  "/jobs/:id/input/:mid/requeue",
  "/jobs/:id/terminal/exchange",
  // P4-08 (ADR-127): the A2A client tools.
  "/sessions/:sid/a2a/agents",
  "/sessions/:sid/a2a/call",
  "/sessions/:sid/a2a/result",
  "/sessions/:sid/schedules",
  "/sessions/:sid/schedules/list",
  "/sessions/:sid/schedules/:id/cancel",
  "/sessions/:sid/schedules/:id/event",
  "/schedules/sync",
  "/shell/claim",
  "/shell/:id/complete",
  "/org-guide",
  "/live",
  "/live/:sid/wake",
  "/live/:sid/events",
  "/filesystem/claim",
  "/filesystem/:id/complete",
  "/logins/claim",
  "/logins/:id/pulse",
  "/logins/:id/update",
];

test("every Runner call is there in process, and none of them over HTTP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-port-"));
  const ctx = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  try {
    // The registered calls: the old ones, `/sync` for the heartbeat.
    assert.deepEqual(
      [...ctx.runnerPaths()].sort(),
      [...CALLS, "/sync"].sort(),
    );
    const node = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
    const call = ctx.runnerApi(node.nodeId);
    for (const p of CALLS) {
      const path = p.replace(/:\w+/g, "x");
      const http = await ctx.app.inject({
        method: "POST",
        url: "/api/runner" + path,
        payload: {},
      });
      assert.equal(http.statusCode, 404, `HTTP ${p}`);
    }
    for (const gone of ["/heartbeat", "/restart/x"])
      await assert.rejects(call(gone, {}), (e: RunnerCallError) => {
        assert.equal(e.status, 404);
        return true;
      });
    // The state sync (was the heartbeat): capabilities in, node state out.
    const state = await call("/sync", { capabilities: { probe: 1 } });
    assert.deepEqual(Object.keys(state).sort(), [
      "blocked",
      "ok",
      "retiredIdentities",
    ]);
    assert.equal(
      JSON.parse(
        ctx.store.one("SELECT capabilities FROM nodes WHERE id=?", node.nodeId)
          .capabilities,
      ).probe,
      1,
    );
    // Errors keep their status and message: a bad body, a stale lease.
    await assert.rejects(call("/jobs/x/pulse", {}, "no-lease"), (e: any) => {
      assert.ok(e instanceof RunnerCallError);
      assert.equal(e.status, 404);
      assert.equal(e.message, "任务不存在");
      return true;
    });
    await assert.rejects(call("/sync", { capabilities: 5 }), (e: any) => {
      assert.equal(e.status, 400);
      return true;
    });
    // Another node's call is refused like a bad token was; so is a revoked node.
    await assert.rejects(ctx.runnerApi("no-such-node")("/claim", {}), (e: any) =>
      e.status === 401,
    );
    ctx.store.run(
      "UPDATE nodes SET revoked_at=? WHERE id=?",
      Date.now(),
      node.nodeId,
    );
    await assert.rejects(call("/claim", {}), (e: any) => e.status === 401);
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RunnerPort: params decoded, bodies and answers copied like the wire, 204 is null, unknown errors are 500", async () => {
  const port = new RunnerPort();
  const seen: any[] = [];
  const kept = { list: [1] };
  port.post("/a/:id/b/:x", async (req) => {
    seen.push(req);
    req.body.mutated = true;
    return kept;
  });
  port.post("/off", async (_req, reply) => reply.code(204).send());
  port.post("/boom", async () => {
    throw Error("secret detail");
  });
  assert.throws(() => port.post("/off", async () => 1), /registered twice/);
  assert.throws(() => port.post("/api/runner/x", async () => 1), /has no \/api\/runner/);
  const call = port.connect("n1");
  const body = { v: 1 };
  const out = await call("/a/h%C3%A9/b/2?q=1", body, "L");
  assert.equal(seen[0].params.id, "hé");
  assert.equal(seen[0].params.x, "2");
  assert.equal(seen[0].headers["x-lease"], "L");
  assert.equal(seen[0].nodeId, "n1");
  assert.deepEqual(body, { v: 1 }, "the handler changed its own copy");
  out.list.push(2);
  assert.deepEqual(kept.list, [1], "the answer is a copy");
  assert.equal(await call("/off"), null);
  const errors: string[] = [];
  const log = console.error;
  console.error = (...a: any[]) => void errors.push(a.join(" "));
  try {
    await assert.rejects(call("/boom"), (e: any) => {
      assert.equal(e.status, 500);
      assert.ok(!e.message.includes("secret"));
      return true;
    });
  } finally {
    console.error = log;
  }
  assert.ok(errors.some((e) => e.includes("secret detail")));
  await assert.rejects(call("/nope"), (e: any) => e.status === 404);
  assert.ok(port.paths().includes("/a/:id/b/:x"));
});

test("RunnerPort: a handler that hangs times out (like the fetch did) instead of hanging the Runner", async () => {
  const port = new RunnerPort(100);
  port.post("/hang", () => new Promise(() => {}));
  port.post("/quick", async () => ({ ok: 1 }));
  const call = port.connect("n1");
  const log = console.error;
  console.error = () => {};
  const t0 = Date.now();
  try {
    await assert.rejects(call("/hang"), (e: any) => {
      assert.ok(e instanceof RunnerCallTimeout);
      // Not a refusal: no status, so the Runner retries as on a network error.
      assert.equal("status" in e, false);
      assert.match(e.message, /超过/);
      return true;
    });
  } finally {
    console.error = log;
  }
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(await call("/quick"), { ok: 1 });
});
