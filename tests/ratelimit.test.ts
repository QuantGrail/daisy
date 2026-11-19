import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";

test("rate limits bucket by credential; a refused request uses nobody's bucket; X-Forwarded-For is never trusted (P1-03)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-ratelimit-"));
  const { app, issueToken } = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    rateLimit: { user: 5 },
  });
  try {
    // Two web sessions of the owner: each its own bucket.
    const A = { authorization: `Bearer ${issueToken()}` },
      B = { authorization: `Bearer ${issueToken()}` };
    const get = (headers: any, url = "/api/me", remoteAddress?: string) =>
      app.inject({ url, headers, remoteAddress });
    const codes = async (n: number, f: () => Promise<any>) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await f()).statusCode);
      return out;
    };
    // Requests without a credential are refused by the guard (401) before
    // the rate limit: they use up no one's bucket.
    assert.deepEqual(
      await codes(8, () => get({})),
      [401, 401, 401, 401, 401, 401, 401, 401],
    );
    // Same source address, separate credentials.
    assert.deepEqual(
      await codes(6, () => get(A)),
      [200, 200, 200, 200, 200, 429],
    );
    assert.equal((await get(B)).statusCode, 200);
    // Still refused (not counted, not 429) once A is out.
    assert.equal((await get({})).statusCode, 401);
    // P1-02: the Runner's calls are in process — a former Runner path is
    // just an unknown route.
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/runner/sync",
          headers: B,
          payload: { capabilities: {} },
        })
      ).statusCode,
      404,
    );
    // Unknown bearer tokens on a public route do not mint buckets: they
    // share the client IP.
    const junk = await codes(6, () =>
      get(
        { authorization: "Bearer junk-" + Math.random() },
        "/api/health",
        "10.9.9.9",
      ),
    );
    assert.equal(junk[5], 429);
    // P1-03: no gateway in front — X-Forwarded-For is ignored even from
    // loopback: a changing header does not get fresh buckets.
    let n = 0;
    const via = await codes(6, () =>
      get({ "x-forwarded-for": "203.0.113." + n++ }, "/api/health", "127.0.0.2"),
    );
    assert.equal(via[5], 429);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
