/**
 * 审批讨论串 (2026-11-05, 「审批…可聊天可以修改」): the
 * owner asks a question on an approval card and the AI that raised it is
 * woken with the question. P1-01: the AI used to answer through the 群聊
 * CLI's credential (and raise 「ask」 cards with it); both went with that
 * CLI, so the cards here are interception cards.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";
import { ownNode, runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";

async function fixture(names = ["alice"]) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-approval-thread-"));
  const ctx = await createApp({ pinGate: false,
    dataDir: dir,
    bootstrap: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  const inject = runnerInject(ctx.app, ctx.runnerApi);
  const people: Record<string, any> = {};
  for (const name of names) {
    const uid = OWNER_ID;
    const h = { authorization: "Bearer " + ctx.issueToken() };
    const call = (method: any, url: string, payload?: any, headers: any = h) =>
      inject({ method, url: "/api" + url, payload, headers });
    const node = ownNode(ctx.store, uid, name, "remote");
    const nh = runnerHeaders(node.nodeId);
    await call("POST", "/runner/sync", { capabilities: {} }, nh);
    const w = (
      await call("POST", "/workspaces", {
        nodeId: node.id,
        label: "w",
        path: dir,
      })
    ).json();
    const p = (
      await call("POST", "/profiles", {
        nodeId: node.id,
        agent: "codex",
        label: "local",
        authMode: "subscription",
      })
    ).json();
    const create = async () =>
      (
        await call("POST", "/sessions", {
          title: name + " agent",
          agent: "codex",
          workspaceId: w.id,
          profileId: p.id,
        })
      ).json();
    people[name] = { uid, h, nh, call, create };
  }
  return {
    ctx,
    people,
    store: ctx.store,
    close: async () => {
      await ctx.app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function claimed(owner: any, session: any, key: string) {
  await owner.call("POST", `/sessions/${session.id}/messages`, {
    requestId: key,
    text: "work",
  });
  const job = (await owner.call("POST", "/runner/claim", {}, owner.nh)).json()
    .job;
  return { job };
}
/** Auto mode refused a tool call in `job`: its interception card. */
async function blockCard(owner: any, job: any, key: string) {
  await owner.call(
    "POST",
    `/runner/jobs/${job.id}/events`,
    {
      events: [
        {
          id: "evt-" + key,
          type: "item",
          data: {
            id: `${job.id}:denied:${key}`,
            kind: "tool",
            category: "interception",
            name: "Bash",
            text: "Permission denied by auto mode",
            status: "error",
            input: { toolName: "Bash", reason: "删除目录", request: {} },
          },
        },
      ],
    },
    { ...owner.nh, "x-lease": job.lease },
  );
  const items = (await owner.call("GET", "/approvals?status=pending")).json()
    .items;
  const card = items.find((x: any) => x.kind === "interception");
  assert.ok(card, JSON.stringify(items));
  return card;
}

test("review M2: questions within 30 s are one wake; 10 per 10 min per poster; 64 KiB per thread", async () => {
  const f = await fixture(),
    { alice } = f.people;
  try {
    const a1 = await alice.create();
    const { job } = await claimed(alice, a1, "thread-work-0009");
    const card = await blockCard(alice, job, "thread-0009");
    for (const q of ["第一问", "第二问"])
      assert.equal(
        (
          await alice.call("POST", `/approvals/${card.id}/comments`, {
            body: q,
          })
        ).statusCode,
        200,
      );
    const wakes = f.store.all(
      "SELECT * FROM wakes WHERE session_id=? AND request_id LIKE 'approval-comment:%'",
      a1.id,
    );
    assert.equal(wakes.length, 1, "one wake for both");
    assert.ok(wakes[0].next_at > Date.now() + 20_000, "due in 30 s");
    assert.match(
      wakes[0].prompt,
      /> 第一问[\s\S]*对方追加提问（#2[\s\S]*> 第二问/,
    );
    for (let i = 3; i <= 10; i++)
      await alice.call("POST", `/approvals/${card.id}/comments`, {
        body: "问 " + i,
      });
    assert.equal(
      (
        await alice.call("POST", `/approvals/${card.id}/comments`, {
          body: "第 11 问",
        })
      ).statusCode,
      429,
    );
    f.store.run(
      "UPDATE approval_comments SET body=?, at=0 WHERE aid=?",
      "x".repeat(7000),
      card.id,
    );
    const big = await alice.call("POST", `/approvals/${card.id}/comments`, {
      body: "y".repeat(100),
    });
    assert.equal(big.statusCode, 413, big.body);
  } finally {
    await f.close();
  }
});

test("permission prompts cannot take questions (the AI is blocked in that tool call); control characters are refused", async () => {
  const f = await fixture(),
    { alice } = f.people;
  try {
    const a1 = await alice.create();
    const { job } = await claimed(alice, a1, "perm-thread-0001");
    await alice.call(
      "POST",
      `/runner/jobs/${job.id}/events`,
      {
        events: [
          {
            id: "evt-perm-t1",
            type: "approval",
            data: {
              id: "perm-t1",
              title: "Bash",
              input: { command: "ls" },
              options: [
                { id: "allow", label: "允许" },
                { id: "deny", label: "拒绝" },
              ],
              category: "permission",
            },
          },
        ],
      },
      { ...alice.nh, "x-lease": job.lease },
    );
    const r = await alice.call("POST", "/approvals/perm:perm-t1/comments", {
      body: "这是干嘛的？",
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.match(r.json().error || r.body, /唤不醒/);
    const ask = await blockCard(alice, job, "thread-0002");
    const bad = await alice.call("POST", `/approvals/${ask.id}/comments`, {
      body: "a‮b",
    });
    assert.equal(bad.statusCode, 422);
  } finally {
    await f.close();
  }
});

