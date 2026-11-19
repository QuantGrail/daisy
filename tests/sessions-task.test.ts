import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";

test("sessions filter by host task id, index-backed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-task-filter-"));
  const { app, store, issueToken } = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const admin = OWNER_ID;
    const client = new DaisyClient(url, issueToken());
    const c = await client.catalog();
    const profile = c.profiles.find((p) => p.agent === "claude")!;
    const make = (title: string, taskId?: string) =>
      client.create({
        title,
        agent: "claude",
        workspaceId: c.workspaces[0].id,
        profileId: profile.id,
        ...(taskId ? { task: { id: taskId, title: "T " + taskId } } : {}),
      });
    const a1 = await make("a1", "T-aaa");
    await new Promise((r) => setTimeout(r, 5));
    const a2 = await make("a2", "T-aaa");
    await make("b", "T-bbb");
    await make("none");
    assert.deepEqual(
      (await client.sessions({ taskId: "T-aaa" })).map((s) => s.id),
      [a2.id, a1.id],
    );
    assert.equal((await client.sessions({ taskId: "T-bbb" })).length, 1);
    assert.deepEqual(await client.sessions({ taskId: "T-none" }), []);
    assert.equal((await client.sessions()).length, 4);
    // Special characters are encoded, not interpreted.
    assert.deepEqual(
      await client.sessions({ taskId: "T-aaa' OR 1=1 --&x=1" }),
      [],
    );
    // (P1-03: no other users to hide them from.)
    const plan = store
      .all(
        "EXPLAIN QUERY PLAN SELECT data FROM sessions WHERE owner_id=? AND json_extract(data,'$.task.id')=?",
        admin,
        "T-aaa",
      )
      .map((r) => r.detail)
      .join(" ");
    assert.match(plan, /sessions_owner_task/);
    assert.equal(
      (
        await app.inject({
          url: "/api/sessions?taskId=" + "x".repeat(201),
          headers: { authorization: `Bearer ${client.token}` },
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session creation is idempotent per requestId (lost response retry)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-create-idem-"));
  const { app, store, issueToken } = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const admin = OWNER_ID;
    const client = new DaisyClient(url, issueToken());
    const c = await client.catalog();
    const claude = c.profiles.find((p) => p.agent === "claude")!;
    const codex = c.profiles.find((p) => p.agent === "codex")!;
    const base = {
      title: "retry",
      agent: "claude" as const,
      workspaceId: c.workspaces[0].id,
      profileId: claude.id,
      task: { id: "T-idem", title: "Idem" },
    };
    const first = await client.create({ ...base, requestId: "req-00000001" });
    assert.equal(first.duplicate, false);
    // The response was "lost": the retry returns the same session.
    const again = await client.create({ ...base, requestId: "req-00000001" });
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
    assert.equal((await client.sessions()).length, 1);
    // Later updates (rename) keep the key.
    await client.request(`/sessions/${first.id}`, "PATCH", {
      title: "renamed",
    });
    const third = await client.create({ ...base, requestId: "req-00000001" });
    assert.equal(third.id, first.id);
    assert.equal(third.title, "renamed");
    // Concurrent duplicates still create one session.
    const [x, y] = await Promise.all([
      client.create({ ...base, requestId: "req-00000002" }),
      client.create({ ...base, requestId: "req-00000002" }),
    ]);
    assert.equal(x.id, y.id);
    assert.deepEqual([x.duplicate, y.duplicate].sort(), [false, true]);
    assert.equal((await client.sessions()).length, 2);
    // Same key, different parameters: a client bug, refused.
    for (const changed of [
      { agent: "codex" as const, profileId: codex.id },
      { task: { id: "T-other", title: "Other" } },
      { task: undefined },
    ])
      await assert.rejects(
        client.create({ ...base, ...changed, requestId: "req-00000001" }),
        (e: any) => e.status === 409 && e.code === "request_id_conflict",
      );
    // Without a key every call creates a new session.
    await client.create(base);
    await client.create(base);
    assert.equal((await client.sessions()).length, 4);
    // Keys are validated like message requestIds.
    await assert.rejects(client.create({ ...base, requestId: "short" }));
    // (P1-03: "keys are per user" — one owner; another page of hers
    // retrying the same key gets the same session.)
    assert.equal(
      (
        await new DaisyClient(url, issueToken()).create({
          ...base,
          requestId: "req-00000001",
        })
      ).id,
      first.id,
    );
    assert.equal(
      store.one(
        "SELECT COUNT(*) AS n FROM sessions WHERE request_id='req-00000001'",
      ).n,
      1,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
