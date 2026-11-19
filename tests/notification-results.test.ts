// 「一轮结束」 notifications (LATEST_AGENT_RESULTS_SQL): the latest turn per
// owned session. P1-01: the 群聊's notification routes that served them
// are gone (the local web page / event outlet read them later), so the
// rule is checked on the query itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { Store } from "../packages/daisy/src/store/index.ts";
import { LATEST_AGENT_RESULTS_SQL } from "../packages/daisy/src/sessions/notifications.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "daisy-notification-results-"));
  const ctx = await createApp({ pinGate: false, dataDir: dir, bootstrap: false });
  const { store } = ctx;
  const headers = { authorization: "Bearer " + ctx.issueToken() };
  const session = (sid: string, extra: Record<string, unknown> = {}) => {
    const data = { id: sid, ownerId: OWNER_ID, title: sid, ...extra };
    store.run(
      "INSERT INTO sessions(id,owner_id,data) VALUES(?,?,?)",
      sid,
      data.ownerId,
      JSON.stringify(data),
    );
  };
  const job = (sid: string, jid: string, status = "completed", created = 1) =>
    store.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,lease_until) VALUES(?,?,?,?,?,?,?,?,?)",
      jid,
      sid,
      "node",
      jid,
      "private prompt",
      "[]",
      status,
      created,
      Date.now() + 60_000,
    );
  return {
    ...ctx,
    dir,
    session,
    job,
    close: async () => {
      await ctx.app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("notification results preserve latest turn, merges, timestamp ties and owner privacy", async () => {
  const f = await fixture();
  try {
    for (const status of [
      "completed",
      "error",
      "interrupted",
      "queued",
      "running",
      "pending",
      "appended",
    ]) {
      f.session(status);
      f.job(status, status + "-old");
      f.job(status, status + "-latest", status, 2);
    }
    f.session("tie");
    f.job("tie", "z-first", "completed", 5);
    f.job("tie", "a-second", "error", 5);
    f.session("merged");
    f.job("merged", "survivor", "completed", 3);
    f.job("merged", "merged-away", "completed", 4);
    f.store.run(
      "INSERT INTO queue_merges(job_id,session_id,into_job,created) VALUES(?,?,?,?)",
      "merged-away",
      "merged",
      "survivor",
      4,
    );
    f.session("empty");
    f.session("deleted", { deleting: true });
    f.job("deleted", "deleted-result");
    f.session("archived", { archived: true });
    f.job("archived", "archived-result");
    const expected = [
      "completed-latest",
      "error-latest",
      "interrupted-latest",
      "a-second",
      "survivor",
      "archived-result",
    ].sort();
    const rows = f.store.all(LATEST_AGENT_RESULTS_SQL, OWNER_ID);
    assert.deepEqual(rows.map((x: any) => x.id).sort(), expected);
    assert.equal(rows.find((x: any) => x.id === "error-latest").status, "error");
    assert.equal(
      rows.find((x: any) => x.id === "completed-latest").status,
      "completed",
    );
    assert.ok(!JSON.stringify(rows).includes("private prompt"));
  } finally {
    await f.close();
  }
});

test("notification query seeks the newest job per session without scanning jobs or sorting history", async () => {
  const f = await fixture();
  try {
    f.store.atomic(() => {
      for (let s = 0; s < 30; s++) {
        f.session("history-" + s);
        for (let j = 0; j < 200; j++)
          f.job("history-" + s, `job-${s}-${j}`, "completed", j);
      }
    });
    const plan = f.store
      .all("EXPLAIN QUERY PLAN " + LATEST_AGENT_RESULTS_SQL, OWNER_ID)
      .map((x) => x.detail)
      .join("\n");
    assert.match(plan, /SEARCH jobs USING INDEX jobs_session_created/);
    assert.doesNotMatch(plan, /SCAN (?:jobs|j)\b|USE TEMP B-TREE/);
    const rows = f.store.all(LATEST_AGENT_RESULTS_SQL, OWNER_ID);
    assert.deepEqual(
      rows.map((x) => x.id).sort(),
      Array.from({ length: 30 }, (_, s) => `job-${s}-199`).sort(),
    );
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "created",
      "id",
      "session_id",
      "status",
      "title",
    ]);
  } finally {
    await f.close();
  }
});

test("the latest-job index is part of the structure; rows survive reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-job-index-"));
  try {
    const first = new Store(dir);
    first.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created) VALUES('old','session','node','request','preserved','[]','completed',42)",
    );
    first.close();
    for (let n = 0; n < 2; n++) {
      const store = new Store(dir);
      try {
        assert.deepEqual(
          store
            .all("PRAGMA index_info(jobs_session_created)")
            .map((r) => r.name),
          ["session_id", "created"],
        );
        assert.equal(
          store.one("SELECT text FROM jobs WHERE id='old'").text,
          "preserved",
        );
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
