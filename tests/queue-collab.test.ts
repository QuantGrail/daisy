/**
 * Queue robustness (user report, 2026-11-05): 「多条协作消息排队好像会卡死，我的任务执行完
 * 以后排队的提示词也进不来」 · 「最好还是想插就插」 — the queue goes on after a
 * group request ends badly, jumps line up one after another, and a jump that
 * cannot start says why instead of failing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { capabilitiesFor } from "../packages/contracts/src/agent-capabilities.ts";
import { id } from "../packages/daisy/src/store/index.ts";
import { jumpNotice } from "../packages/ui/src/queue-jump.ts";
import { runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";
import { uiLang } from "./ui-pack.ts";

// ADR-159 §8: the UI speaks Chinese in these assertions.
uiLang("zh-CN");

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "daisy-queue-collab-"));
  const ctx = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  const inject = runnerInject(ctx.app, ctx.runnerApi);
  const { app, store, issueToken } = ctx;
  const cfg = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
  const uh = {
      authorization: `Bearer ${issueToken()}`,
    },
    nh = runnerHeaders(cfg.nodeId);
  const post = (url: string, payload: any = {}, headers: any = uh) =>
    inject({ method: "POST", url, payload, headers });
  const call = async (url: string, payload: any = {}, headers: any = uh) =>
    (await post(url, payload, headers)).json();
  const get = async (url: string) =>
    (await inject({ method: "GET", url, headers: uh })).json();
  const cat = await get("/api/catalog"),
    p = cat.profiles.find((p: any) => p.agent === "claude");
  const s = await call("/api/sessions", {
    title: "queue-collab",
    agent: "claude",
    profileId: p.id,
    workspaceId: cat.workspaces[0].id,
  });
  // an updated Runner whose agent has no way into a running turn
  // (steer `none`) — every jump goes through Daisy's queue (the merge
  // rules under test). A CLI below the measured version (steer `fallback`)
  // takes Daisy's 立即追加 (hotfix 3), a Runner not updated at all steers
  // her plain text (native-append-rules).
  store.run(
    "UPDATE nodes SET capabilities=? WHERE id=?",
    JSON.stringify({
      agentFeatures: {
        claude: (() => {
          const c = capabilitiesFor("claude", "1.0.0");
          return { ...c, input: { ...c.input, steer: { support: "none" } } };
        })(),
      },
    }),
    s.nodeId,
  );
  let n = 0;
  const send = (text: string, delivery = "queue") =>
    call(`/api/sessions/${s.id}/messages`, {
      text,
      requestId: `queue-collab-${++n}-${text}`.slice(0, 90),
      delivery,
    });
  const claim = async () => (await call("/api/runner/claim", {}, nh)).job;
  const complete = (job: any, status: string) =>
    call(
      `/api/runner/jobs/${job.id}/complete`,
      { status },
      { ...nh, "x-lease": job.lease },
    );
  const status = (jid: string) =>
    store.one("SELECT status FROM jobs WHERE id=?", jid).status;
  /** A queued job that is not the owner's: a group request (`chat:`) … */
  const others = (rid: string, origin: string | null = null) => {
    const jid = id();
    store.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,origin) VALUES(?,?,?,?,?,?,?,?,?)",
      jid,
      s.id,
      s.nodeId,
      rid.replace("$", jid),
      "【协作】请看一下",
      "[]",
      "pending",
      Date.now(),
      origin,
    );
    return jid;
  };
  const queue = async () => (await get(`/api/sessions/${s.id}/queue`)) as any[];
  return {
    ctx,
    inject,
    s,
    call,
    post,
    get,
    send,
    claim,
    complete,
    status,
    others,
    queue,
    close: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a group request withdrawn or failing mid-turn does not strand the owner's queued prompts", async () => {
  const f = await fixture();
  try {
    const { store } = f.ctx;
    const first = await f.send("my task", "normal");
    const mine = await f.claim();
    assert.equal(mine.id, first.id);
    // Two group requests and a wake queue behind it, then the owner's prompts.
    const g1 = f.others("chat:m1:s:$"),
      g2 = f.others("chat:m2:s:$"),
      w = f.others("schedule:cron:$", "schedule");
    const u1 = await f.send("prompt 1"),
      u2 = await f.send("prompt 2");
    const q = await f.queue();
    assert.deepEqual(
      q.map((r) => r.id),
      [g1, g2, w, u1.id, u2.id],
      "in the order they came",
    );
    assert.equal(q[0].from, "群里的协作请求");
    assert.equal(q[2].from, "定时 / 回调唤醒");
    assert.equal(q[3].from, undefined, "the owner's own words");
    // 「我的任务执行完以后」: the owner's turn ends, the first request runs …
    await f.complete(mine, "idle");
    const r1 = await f.claim();
    assert.equal(r1.id, g1);
    // … and its asker withdraws it mid-turn (cancel=1): before this fix the
    // queue paused here and the owner's prompts never came in.
    store.run("UPDATE jobs SET cancel=1 WHERE id=?", g1);
    await f.complete(r1, "interrupted");
    assert.equal(f.status(g1), "interrupted");
    const r2 = await f.claim();
    assert.ok(r2, "the queue goes on");
    assert.equal(r2.id, g2);
    // A failing group request / wake does not pause it either.
    await f.complete(r2, "error");
    const r3 = await f.claim();
    assert.equal(r3.id, w);
    await f.complete(r3, "interrupted");
    const r4 = await f.claim();
    assert.equal(r4.id, u1.id, "the owner's prompts come in, in order");
    // The owner's own turn failing still pauses for the owner (unchanged).
    await f.complete(r4, "error");
    assert.equal(await f.claim(), null, "paused after the owner's failure");
    assert.equal(f.status(u2.id), "pending");
    await f.call(`/api/sessions/${f.s.id}/queue/resume`);
    assert.equal((await f.claim()).id, u2.id);
  } finally {
    await f.close();
  }
});

test("several jumps line up one after another; a group request running is not stopped", async () => {
  const f = await fixture();
  try {
    const { store } = f.ctx;
    // A group request is running.
    const g = f.others("chat:m9:s:$");
    store.run("UPDATE jobs SET status='queued' WHERE id=?", g);
    const running = await f.claim();
    assert.equal(running.id, g);
    const a = await f.send("A"),
      b = await f.send("B"),
      c = await f.send("C");
    // A group request queued behind can jump too.
    const g2 = f.others("chat:m10:s:$");
    // never stopped for a jump — first after it (this node's
    // Runner reports no native append).
    const r1 = await f.call(`/api/sessions/${f.s.id}/queue/${c.id}/jump`);
    assert.equal(r1.mode, "next");
    assert.match(jumpNotice(r1.mode, r1.reason), /这一轮结束后发出$/);
    assert.equal(store.one("SELECT cancel FROM jobs WHERE id=?", g).cancel, 0);
    // A second jump: right after the first, not instead; a group request
    // cannot share the owner's message (nor go into a turn natively).
    const r2 = await f.call(`/api/sessions/${f.s.id}/queue/${g2}/jump`);
    assert.equal(r2.mode, "next");
    assert.match(
      jumpNotice(r2.mode, r2.reason),
      /协作请求按自己的一轮运行：前面插队的那一轮结束后发出/,
    );
    const r3 = await f.call(`/api/sessions/${f.s.id}/queue/${a.id}/jump`);
    assert.equal(r3.mode, "next");
    const q = await f.queue();
    assert.deepEqual(
      q.map((x) => [x.id, !!x.jump]),
      [
        [c.id, true],
        [g2, true],
        [a.id, true],
        [b.id, false],
      ],
    );
    await f.complete(running, "idle");
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const j = await f.claim();
      assert.ok(j, `job ${i + 1} runs`);
      order.push(j.id);
      await f.complete(j, "idle");
    }
    assert.deepEqual(order, [c.id, g2, a.id, b.id]);
    // The first jumped message removed while it waits: the next one that
    // jumped goes first instead. A second owner's message merges
    // into the first, so here the second is a wake.
    const run = await f.send("run", "normal");
    const job = await f.claim();
    assert.equal(job.id, run.id);
    const d = await f.send("D"),
      e = f.others("collab:x:$", "collab");
    await f.call(`/api/sessions/${f.s.id}/queue/${d.id}/jump`);
    await f.call(`/api/sessions/${f.s.id}/queue/${e}/jump`);
    await f.inject({
      method: "DELETE",
      url: `/api/sessions/${f.s.id}/queue/${d.id}`,
      headers: {
        authorization: `Bearer ${f.ctx.issueToken()}`,
      },
    });
    assert.equal(
      f.ctx.store.one("SELECT cancel FROM jobs WHERE id=?", job.id).cancel,
      0,
    );
    await f.complete(job, "idle");
    assert.equal((await f.claim()).id, e);
  } finally {
    await f.close();
  }
});

test("a jump that cannot start says why on the card (native operation running)", async () => {
  const f = await fixture();
  try {
    const { store } = f.ctx;
    const op = id();
    store.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,lease,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?)",
      op,
      f.s.id,
      f.s.nodeId,
      `op:${op}`,
      "/compact",
      "[]",
      "running",
      Date.now(),
      "l",
      Date.now() + 60000,
    );
    store.run(
      "INSERT INTO job_operations(job_id,data) VALUES(?,?)",
      op,
      JSON.stringify({ name: "compact" }),
    );
    const a = await f.send("A");
    const [row] = await f.queue();
    assert.equal(row.id, a.id);
    assert.match(row.jumpBlocked, /原生操作/);
    const r = await f.post(`/api/sessions/${f.s.id}/queue/${a.id}/jump`);
    assert.equal(r.statusCode, 409);
    // Done: the card offers 插队 again.
    await f.complete({ id: op, lease: "l" }, "idle");
    store.run("UPDATE jobs SET status='pending' WHERE id=?", a.id);
    assert.equal((await f.queue())[0].jumpBlocked, undefined);
  } finally {
    await f.close();
  }
});

test("a failed native operation still pauses; a stopping owner's turn becomes a jump's stop", async () => {
  const f = await fixture();
  try {
    const { store } = f.ctx;
    // (1) rewind / compact fails or is stopped: the next prompt must not run
    // on the un-rewound context.
    for (const end of ["error", "interrupted"]) {
      const op = id();
      store.run(
        "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,lease,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?)",
        op,
        f.s.id,
        f.s.nodeId,
        `op:${op}`,
        "/rewind",
        "[]",
        "running",
        Date.now(),
        "l",
        Date.now() + 60000,
      );
      store.run(
        "INSERT INTO job_operations(job_id,data) VALUES(?,?)",
        op,
        JSON.stringify({ name: "rewind" }),
      );
      const a = await f.send(`after ${end}`);
      await f.complete({ id: op, lease: "l" }, end);
      assert.equal(await f.claim(), null, `paused after a ${end} operation`);
      assert.equal(f.status(a.id), "pending");
      await f.call(`/api/sessions/${f.s.id}/queue/resume`);
      await f.complete(await f.claim(), "idle");
    }
    // (2) The owner's turn is already stopping (cancel=1): a jump upgrades
    // it to a jump's stop and the jumped message runs when it ends.
    const run = await f.send("long", "normal");
    const job = await f.claim();
    assert.equal(job.id, run.id);
    const b = await f.send("B");
    store.run("UPDATE jobs SET cancel=1 WHERE id=?", job.id);
    const r = await f.call(`/api/sessions/${f.s.id}/queue/${b.id}/jump`);
    assert.equal(r.mode, "interrupting");
    assert.equal(
      store.one("SELECT cancel FROM jobs WHERE id=?", job.id).cancel,
      2,
    );
    await f.complete(job, "interrupted");
    assert.equal((await f.claim()).id, b.id);
  } finally {
    await f.close();
  }
});

test("a removed jump is forgotten; the queue goes on after someone else's turn", async () => {
  const f = await fixture();
  try {
    const { store } = f.ctx;
    const g = f.others("chat:m20:s:$");
    store.run("UPDATE jobs SET status='queued' WHERE id=?", g);
    const running = await f.claim();
    assert.equal(running.id, g);
    const d = await f.send("D"),
      e = await f.send("E");
    // the group request is not stopped; D waits first in line.
    assert.equal(
      (await f.call(`/api/sessions/${f.s.id}/queue/${d.id}/jump`)).mode,
      "next",
    );
    await f.inject({
      method: "DELETE",
      url: `/api/sessions/${f.s.id}/queue/${d.id}`,
      headers: { authorization: `Bearer ${f.ctx.issueToken()}` },
    });
    assert.equal(
      store.one("SELECT count(*) n FROM queue_jump_order WHERE job_id=?", d.id)
        .n,
      0,
    );
    assert.equal(
      store.one("SELECT count(*) n FROM queue_jumps WHERE job_id=?", d.id).n,
      0,
    );
    await f.complete(running, "idle");
    assert.equal((await f.claim()).id, e.id, "not paused");
  } finally {
    await f.close();
  }
});
