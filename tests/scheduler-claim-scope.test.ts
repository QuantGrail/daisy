import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { schedulerLimits } from "../packages/daisy/src/schedule/scheduler.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import { BackgroundManager } from "../packages/daisy/src/schedule/background.ts";
import { RestartDrain } from "../packages/daisy/src/update/restart-drain.ts";
import { DaisyToolHost } from "../packages/daisy/src/tools/daisy-tools.ts";
import { SCHEDULE_LIMITS } from "../packages/contracts/src/scheduler.ts";
import { delay, setup, tool, until } from "./fixtures/scheduler-harness.ts";
import { runnerFetch, runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";
/**
 * Background results are never dropped (kept, retried, carried by the next turn), per-node /
 * per-session limits, monitor wakes throttled in step with the daily
 * budget, and background work no longer holds a Runner restart forever.
 */

/** A control plane without a Runner: jobs stay where the scheduler put them. */
async function plane(app: Partial<Parameters<typeof createApp>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-claimscope-"));
  const ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
    ...app,
  });
  const inject = runnerInject(ctx.app, ctx.runnerApi);
  const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const uid = OWNER_ID;
  const c = new DaisyClient(url, ctx.issueToken());
  const rc = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
  const cat = await c.catalog();
  const create = (title = "robust") =>
    c.create({
      agent: "codex",
      title,
      profileId: cat.profiles.find((p) => p.agent === "codex")!.id,
      workspaceId: cat.workspaces[0].id,
    });
  /** The Runner's side of the API (its node token). */
  const runner = runnerFetch(ctx.runnerApi(rc.nodeId));
  const bg = async (sid: string, kind: "bash" | "monitor" = "bash") =>
    (
      await runner(`/sessions/${sid}/schedules`, {
        kind,
        command: kind === "bash" ? "make test" : "tail -f log",
        description: kind === "bash" ? "跑测试" : "看日志",
      })
    ).schedule;
  const event = (sid: string, rid: string, body: any) =>
    runner(`/sessions/${sid}/schedules/${rid}/event`, body);
  const row = (rid: string) =>
    ctx.store.one("SELECT * FROM agent_schedules WHERE id=?", rid);
  const schedules = async (sid: string) =>
    (await c.request(`/sessions/${sid}/schedules`)).schedules as any[];
  const jobs = (sid: string) =>
    ctx.store.all(
      "SELECT * FROM jobs WHERE session_id=? ORDER BY created, rowid",
      sid,
    );
  const fill = (sid: string, n = 20) =>
    ctx.store.atomic(() => {
      for (let i = 0; i < n; i++)
        ctx.store.run(
          "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created) VALUES(?,?,?,?,?,?,?,?)",
          `filler-${sid}-${i}`,
          sid,
          rc.nodeId,
          `filler-${sid}-${i}`,
          "x",
          "[]",
          "pending",
          Date.now(),
        );
    });
  const unfill = (sid: string) =>
    ctx.store.run("DELETE FROM jobs WHERE id LIKE ?", `filler-${sid}-%`);
  /**
   * The Runner claims the next queued turn (/api/runner/claim): the text it
   * is given (kept reports are taken at this moment, R2 review N-M1).
   */
  const take = async () => {
    const r = await runner("/claim", {});
    return r.job as any;
  };
  /** The Agent's turn for these jobs ran (they no longer wait). */
  const ran = (sid: string) =>
    ctx.store.run(
      "UPDATE jobs SET status='completed',lease=COALESCE(lease,'ran') WHERE session_id=? AND status IN ('queued','pending','running')",
      sid,
    );
  const due = (rid: string) =>
    ctx.store.run(
      "UPDATE agent_schedules SET report_at=? WHERE id=?",
      Date.now() - 1,
      rid,
    );
  const close = async () => {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    ctx,
    c,
    uid,
    rc,
    create,
    runner,
    bg,
    event,
    row,
    schedules,
    jobs,
    fill,
    unfill,
    ran,
    take,
    due,
    url,
    close,
  };
}

test("R3 review: an Agent-started turn (origin agent) leaves kept reports on the row", async () => {
  const p = await plane();
  try {
    const s = await p.create();
    const b = await p.bg(s.id);
    p.fill(s.id);
    await p.event(s.id, b.id, {
      type: "exit",
      exitCode: 0,
      text: "IMPORTANT RESULT",
    });
    p.unfill(s.id);
    p.ctx.store.run(
      "INSERT INTO live_sessions(session_id,node_id,data,updated) VALUES(?,?,?,?)",
      s.id,
      p.rc.nodeId,
      JSON.stringify({}),
      Date.now(),
    );
    const r: any = await p.runner(`/live/${s.id}/wake`, {
      reason: "后台任务完成",
    });
    assert.equal(r.job.origin, "agent");
    assert.doesNotMatch(
      String(r.job.preamble || "") + String(r.job.text || ""),
      /IMPORTANT/,
    );
    assert.ok(
      JSON.parse(p.row(b.id).data).undelivered,
      "report kept on the row",
    );
  } finally {
    await p.close();
  }
});

test("R3 review: a collaboration request turn (chat:) does not carry the owner's kept reports", async () => {
  const p = await plane();
  try {
    const s = await p.create();
    const b = await p.bg(s.id);
    p.fill(s.id);
    await p.event(s.id, b.id, {
      type: "exit",
      exitCode: 0,
      text: "PRIVATE RESULT",
    });
    p.unfill(s.id);
    p.ctx.store.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created) VALUES('c1',?,?,'chat:m1:x:c1','群里 bob 问你一个问题','[]','queued',?)",
      s.id,
      p.rc.nodeId,
      Date.now(),
    );
    const j: any = await p.take();
    assert.equal(j?.id, "c1");
    assert.doesNotMatch(
      String(j?.preamble || "") + String(j?.text || ""),
      /PRIVATE RESULT/,
    );
    assert.ok(
      JSON.parse(p.row(b.id).data).undelivered,
      "report kept on the row",
    );
  } finally {
    await p.close();
  }
});
