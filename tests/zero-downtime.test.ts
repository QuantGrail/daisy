import { test } from "node:test";
import { serve } from "../packages/daisy/src/app/serve.ts";
import { exempt, group, json, route } from "../packages/contracts/src/api/route.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import WebSocket from "ws";
import { Lifecycle, trackHttp } from "../packages/daisy/src/update/lifecycle.ts";
import { createApp } from "../packages/daisy/src/app.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";

// P1-02: 「排空再退出」 — before the process exits (a restart for
// an update, or a stop) it finishes its requests and tells live sockets to
// reconnect. (The lease hand-over between two control-plane processes went
// with P1-02: one process, no standby — the leadership tests went too.)

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("drain: requests in flight finish with Connection: close, live sockets get 1012", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-drain-"));
  const lifecycle = new Lifecycle();
  const ctx = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    lifecycle,
  });
  let release: () => void = () => {};
  // P1-03: every route outside the table is refused by the guard, so the
  // slow route is registered from a (public) definition of its own.
  serve(
    ctx.app,
    group("system", {
      slow: route({
        method: "GET",
        path: "/test-slow",
        scope: null,
        output: json<{ ok: true }>("{ ok }"),
        cli: exempt(),
      }),
    }).slow,
    async () => {
      await new Promise<void>((r) => (release = r));
      return { ok: true };
    },
  );
  const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const port = Number(new URL(url).port);
  const tracked = trackHttp(ctx.app.server);
  const uid = OWNER_ID;
  const token = ctx.issueToken();
  // A conversation's live socket and a keep-alive connection that is idle
  // at drain time. (P1-01: was the 群聊 push socket, gone with 群聊.)
  ctx.store.save({
    id: "drain-s",
    ownerId: uid,
    title: "drain",
    agent: "claude",
    nodeId: "n",
    workspaceId: "w",
    profileId: "p",
    nativeId: null,
    task: null,
    status: "idle",
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  } as any);
  const ws = new WebSocket(url.replace("http", "ws") + "/api/live");
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "subscribe", sessionId: "drain-s", token }));
  await new Promise((r) => ws.once("message", r));
  const closed = new Promise<number>((r) =>
    ws.once("close", (code) => r(code)),
  );
  // One connection stays idle, the other carries the slow request.
  const idle = new http.Agent({ keepAlive: true, maxSockets: 1 }),
    busy = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const get = (path: string, agent = idle) =>
    new Promise<{ status: number; connection?: string; body: string }>(
      (resolve, reject) =>
        http
          .get({ host: "127.0.0.1", port, path, agent }, (res) => {
            let body = "";
            res.on("data", (d) => (body += d));
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                connection: res.headers.connection,
                body,
              }),
            );
          })
          .on("error", reject),
    );
  assert.equal((await get("/api/health")).connection, "keep-alive");
  const slow = get("/test-slow", busy);
  await delay(50);
  assert.equal(tracked.inflight, 1);
  lifecycle.beginDrain();
  const drained = tracked.drain({ graceMs: 200, timeoutMs: 5000 });
  assert.equal(await closed, 1012, "live socket told to reconnect");
  // During the grace a request on the idle keep-alive connection is still
  // served and closes its connection afterwards.
  const late = await get("/api/health").finally(() => setTimeout(release, 250));
  assert.equal(late.status, 200);
  assert.equal(late.connection, "close");
  const r = await slow;
  assert.equal(r.status, 200);
  assert.equal(r.connection, "close");
  assert.deepEqual(await drained, { stragglers: 0 });
  // Nothing accepts any more.
  await assert.rejects(get("/api/health"));
  idle.destroy();
  busy.destroy();
  // Draining also stops background sweeps (nothing new starts on the way out).
  assert.equal(lifecycle.leading(), false);
  await ctx.app.close();
});
