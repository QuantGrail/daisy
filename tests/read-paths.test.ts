// U2 harbor-perf: conditional GETs (ETag / 304) on the server and
// in DaisyClient. P1-01: the 群聊 page's read paths (the pushed session
// row, `/communication/windows`) went with 群聊.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { id } from "../packages/daisy/src/store/index.ts";
import { etagFor, ifNoneMatch } from "../packages/daisy/src/app/etag.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "daisy-read-paths-"));
  const ctx = await createApp({ pinGate: false, dataDir: dir, bootstrap: false });
  // P1-03: one owner (no other accounts to compare with).
  const people: Record<string, { id: string; token: string }> = {
    alice: { id: OWNER_ID, token: ctx.issueToken() },
  };
  const get = (who: string, url: string, headers: any = {}) =>
    ctx.app.inject({
      method: "GET",
      url: "/api" + url,
      headers: { authorization: "Bearer " + people[who].token, ...headers },
    });
  const session = (owner: string, title = "agent") => {
    const sid = "sess-" + id();
    ctx.store.save({
      id: sid,
      ownerId: owner,
      title,
      agent: "codex",
      nodeId: "n",
      workspaceId: "w",
      profileId: "p",
      nativeId: null,
      task: null,
      status: "idle",
      archived: false,
      context: { big: "x".repeat(100) },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);
    return sid;
  };
  return { ctx, dir, people, get, session };
}

test("ifNoneMatch: weak comparison, lists and *", () => {
  const tag = etagFor("{}");
  assert.match(tag, /^W\/"[\w-]{22}"$/);
  assert.equal(ifNoneMatch(tag, tag), true);
  assert.equal(ifNoneMatch(tag.slice(2), tag), true);
  assert.equal(ifNoneMatch(`W/"other", ${tag}`, tag), true);
  assert.equal(ifNoneMatch("*", tag), true);
  assert.equal(ifNoneMatch(`W/"other"`, tag), false);
  assert.equal(ifNoneMatch(undefined, tag), false);
});

test("JSON GETs carry an ETag; a matching If-None-Match gets 304 without a body", async () => {
  const { ctx, dir, people, get, session } = await fixture();
  try {
    const sid = session(people.alice.id);
    const first = await get("alice", "/sessions");
    assert.equal(first.statusCode, 200);
    const tag = first.headers.etag as string;
    assert.ok(tag?.startsWith('W/"'));
    assert.equal(first.headers["cache-control"], "private, no-store");
    assert.equal(tag, etagFor(first.body));
    const again = await get("alice", "/sessions", { "if-none-match": tag });
    assert.equal(again.statusCode, 304);
    assert.equal(again.body, "");
    assert.equal(again.headers.etag, tag);
    assert.equal(again.headers["cache-control"], "private, no-store");
    // Changed → a full answer with a new tag.
    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/api/sessions/${sid}`,
      payload: { title: "renamed" },
      headers: { authorization: "Bearer " + people.alice.token },
    });
    assert.equal(patch.statusCode, 200);
    assert.equal(patch.headers.etag, undefined, "no ETag on writes");
    const changed = await get("alice", "/sessions", { "if-none-match": tag });
    assert.equal(changed.statusCode, 200);
    assert.notEqual(changed.headers.etag, tag);
    assert.equal(changed.json()[0].title, "renamed");
    // Errors are never 304.
    const missing = await get("alice", "/sessions/nope", {
      "if-none-match": "*",
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.headers.etag, undefined);
    // P1-03 (W-1): another origin's page gets nothing — no CORS, the
    // guard refuses it (it used to be told it may read the tag).
    const cors = await ctx.app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: {
        authorization: "Bearer " + people.alice.token,
        origin: "http://localhost:8081",
      },
    });
    assert.equal(cors.statusCode, 403);
    assert.equal(cors.json().code, "cross_site");
    assert.equal(cors.headers["access-control-expose-headers"], undefined);
    assert.equal(cors.headers["access-control-allow-origin"], undefined);
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DaisyClient revalidates with the kept ETag and hands out a fresh copy on 304", async () => {
  const { ctx, dir, people, session } = await fixture();
  const url = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const sent: (string | null)[] = [];
  const statuses: number[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    sent.push(init?.headers?.["If-None-Match"] ?? null);
    const r = await real(input, init);
    statuses.push(r.status);
    return r;
  }) as any;
  try {
    session(people.alice.id, "one");
    const client = new DaisyClient(url, people.alice.token);
    const a = await client.sessions();
    const b = await client.sessions();
    assert.deepEqual(statuses, [200, 304]);
    assert.equal(sent[0], null);
    assert.ok(sent[1]?.startsWith('W/"'));
    assert.deepEqual(b, a);
    assert.notEqual(b, a, "every caller gets its own objects");
    (b as any)[0].title = "mutated by a caller";
    const c = await client.sessions();
    assert.equal(c[0].title, "one");
    // A change: 200 and the new body is kept.
    session(people.alice.id, "two");
    const d = await client.sessions();
    assert.equal(statuses.at(-1), 200);
    assert.equal(d.length, 2);
    assert.equal((await client.sessions()).length, 2);
    assert.equal(statuses.at(-1), 304);
    // Errors are not kept; writes send no If-None-Match.
    await assert.rejects(client.request("/sessions/nope"));
    await assert.rejects(client.request("/sessions/nope"));
    assert.equal(sent.at(-1), null);
    await client.request("/sessions/" + d[0].id, "PATCH", { title: "x" });
    assert.equal(sent.at(-1), null);
  } finally {
    globalThis.fetch = real;
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DaisyClient ETag memory: bytes counted as held (2 per UTF-16 unit), cleared on another token / server", async () => {
  const real = globalThis.fetch;
  const sent: (string | null)[] = [];
  let body = JSON.stringify([{ t: "ok" }]);
  globalThis.fetch = (async (_u: any, init: any) => {
    sent.push(init?.headers?.["If-None-Match"] ?? null);
    if (init?.headers?.["If-None-Match"] === 'W/"t"')
      return new Response(null, { status: 304 });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json", etag: 'W/"t"' },
    });
  }) as any;
  try {
    const c = new DaisyClient("http://x", "tok-a");
    await c.request("/a");
    await c.request("/a");
    assert.deepEqual(sent, [null, 'W/"t"']);
    // Another login on the same client: nothing kept is reused.
    c.token = "tok-b";
    await c.request("/a");
    assert.equal(sent.at(-1), null);
    c.forgetCached();
    await c.request("/a");
    assert.equal(sent.at(-1), null);
    // 1.1 M CJK units = 2.2 MB held: above the per-body cap (8 MB / 4).
    body = JSON.stringify("数".repeat(1_100_000));
    sent.length = 0;
    await c.request("/big");
    await c.request("/big");
    assert.deepEqual(sent, [null, null]);
  } finally {
    globalThis.fetch = real;
  }
});

test("equal updatedAt: the server list orders by id", async () => {
  const { ctx, dir, people, get } = await fixture();
  try {
    for (const sid of ["sess-c", "sess-a", "sess-b"])
      ctx.store.save({
        id: sid,
        ownerId: people.alice.id,
        title: sid,
        updatedAt: 7,
        createdAt: 7,
      } as any);
    assert.deepEqual(
      (await get("alice", "/sessions")).json().map((x: any) => x.id),
      ["sess-a", "sess-b", "sess-c"],
    );
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
