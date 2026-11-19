import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { id } from "../packages/daisy/src/store/index.ts";
import { runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";

test("durable commands, isolation, leases and one-shot approvals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-test-"));
  const { app, store, issueToken, runnerApi } = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
  });
  const inject = runnerInject(app, runnerApi);
  try {
    const token = issueToken(),
      headers = { authorization: `Bearer ${token}` };
    const node = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
    const nh = runnerHeaders(node.nodeId);
    const call = async (
      method: any,
      url: string,
      payload?: any,
      h: any = headers,
    ) => inject({ method, url, payload, headers: h });
    const c = (await call("GET", "/api/catalog")).json();
    const s = (
      await call("POST", "/api/sessions", {
        title: "Test",
        agent: "claude",
        workspaceId: c.workspaces[0].id,
        profileId: c.profiles.find((p: any) => p.agent === "claude").id,
        task: { id: "t1", title: "Task context" },
      })
    ).json();
    assert.ok(s.id);
    const command = { requestId: "request-123456", text: "Hello" };
    const first = (
      await call("POST", `/api/sessions/${s.id}/messages`, command)
    ).json();
    assert.equal(first.duplicate, false);
    const dup = (
      await call("POST", `/api/sessions/${s.id}/messages`, command)
    ).json();
    assert.equal(dup.id, first.id);
    assert.equal(dup.duplicate, true);
    assert.equal(
      (
        await call("POST", `/api/sessions/${s.id}/messages`, {
          ...command,
          requestId: "request-234567",
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await call("GET", `/api/sessions/${s.id}`)).json().items.length,
      1,
    );
    // P1-03: no other accounts — a caller without a valid credential of
    // this Daisy's is refused.
    const oh = { authorization: "Bearer dweb_not-a-session-of-this-daisy" };
    assert.equal(
      (await call("GET", `/api/sessions/${s.id}`, undefined, oh)).statusCode,
      401,
    );
    const job = (await call("POST", "/api/runner/claim", {}, nh)).json().job;
    assert.equal(job.id, first.id);
    const jh = { ...nh, "x-lease": job.lease };
    assert.equal(
      (await call("POST", `/api/runner/jobs/${job.id}/pulse`, {}, nh))
        .statusCode,
      409,
    );
    const aid = id(),
      eid = id(),
      approval = {
        events: [
          {
            id: eid,
            type: "approval",
            data: {
              id: aid,
              title: "Run command?",
              input: { command: "pwd" },
              options: [
                { id: "allow", label: "Allow" },
                { id: "deny", label: "Deny" },
              ],
            },
          },
        ],
      };
    assert.equal(
      (await call("POST", `/api/runner/jobs/${job.id}/events`, approval, jh))
        .statusCode,
      200,
    );
    // a permission prompt is not answered in the chat …
    assert.equal(
      (
        await call("POST", `/api/sessions/${s.id}/approvals/${aid}`, {
          optionId: "allow",
        })
      ).statusCode,
      409,
    );
    // … but on the 「审批」 page.
    assert.equal(
      (
        await call("POST", `/api/approvals/perm:${aid}/respond`, {
          decision: "allow",
        })
      ).statusCode,
      200,
    );
    await call("POST", `/api/runner/jobs/${job.id}/events`, approval, jh); // retransmit must not resurrect approval
    assert.equal(
      (
        await call("POST", `/api/sessions/${s.id}/approvals/${aid}`, {
          optionId: "deny",
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await call("POST", `/api/runner/jobs/${job.id}/pulse`, {}, jh)).json()
        .approvals[0].decision.optionId,
      "allow",
    );
    await call(
      "POST",
      `/api/runner/jobs/${job.id}/complete`,
      { status: "idle" },
      jh,
    );
    assert.equal(
      (await call("GET", `/api/sessions/${s.id}`)).json().session.status,
      "idle",
    );
    assert.equal(
      (
        await call(
          "POST",
          `/api/runner/jobs/${job.id}/complete`,
          { status: "idle" },
          jh,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await call("POST", `/api/runner/jobs/${job.id}/events`, approval, jh))
        .statusCode,
      409,
    );
    const encrypted = store.encrypt("secret-key");
    assert.ok(!encrypted.includes("secret-key"));
    assert.equal(store.decrypt(encrypted), "secret-key");
    const events = (
      await call("GET", `/api/sessions/${s.id}/events?after=0`)
    ).json().events;
    assert.equal(new Set(events.map((x: any) => x.id)).size, events.length);
    // Atomic rollback covers both event log and materialized state.
    assert.throws(() =>
      store.atomic(() => {
        store.append(s.id, "status", { status: "error" });
        throw Error("rollback");
      }),
    );
    assert.equal(store.session(s.id)?.status, "idle");
    const next = (
      await call("POST", `/api/sessions/${s.id}/messages`, {
        ...command,
        requestId: "request-345678",
      })
    ).json();
    await call("POST", "/api/runner/claim", {}, nh);
    store.run("UPDATE jobs SET lease_until=0 WHERE id=?", next.id);
    await call("POST", "/api/runner/claim", {}, nh);
    assert.equal(store.session(s.id)?.status, "interrupted");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted snapshots survive a control-plane restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-persist-"));
  let ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
  });
  const s: any = {
    id: id(),
    ownerId: "u",
    title: "persist",
    agent: "codex",
    nodeId: "n",
    workspaceId: "w",
    profileId: "p",
    nativeId: null,
    task: null,
    status: "idle",
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  ctx.store.save(s);
  ctx.store.append(s.id, "native", { nativeId: "native-session" });
  ctx.store.append(s.id, "item", {
    id: "assistant-1",
    kind: "assistant",
    text: "durable",
    createdAt: Date.now(),
  });
  await ctx.app.close();
  ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
    bootstrap: false,
  });
  assert.equal(ctx.store.snapshot(s.id).items[0].text, "durable");
  assert.equal(ctx.store.session(s.id)?.nativeId, "native-session");
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});
