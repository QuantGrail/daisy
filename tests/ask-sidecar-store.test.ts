// P1-01: what stays of 「只问」 without the chat's routing —
// sidecar storage, limits and the summaries that ride the main session's
// next turn (packages/daisy/src/sessions/ask-sidecar.ts). Stage 4 routes 「问」 from
// the A2A entry onto this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, id } from "../packages/daisy/src/store/index.ts";
import { askSidecars } from "../packages/daisy/src/sessions/ask-sidecar.ts";
import { ASK_SIDECAR } from "../packages/contracts/src/ask-sidecar.ts";
import type { Session } from "../packages/contracts/src/index.ts";

function fixture(limits = {}) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-sidecar-"));
  const store = new Store(dir);
  store.run(
    "INSERT INTO nodes(id,label,token_hash,capabilities) VALUES(?,?,?,?)",
    "n1",
    "n1",
    "h",
    JSON.stringify({ askSidecar: { version: 1 } }),
  );
  const now = Date.now();
  const main: Session = {
    id: id(),
    ownerId: "u1",
    title: "研究",
    agent: "claude",
    nodeId: "n1",
    workspaceId: "w1",
    profileId: "p1",
    nativeId: "native-main",
    task: { id: "T-1", title: "任务" },
    status: "idle",
    archived: false,
    settings: { model: "opus", askSidecar: true },
    createdAt: now,
    updatedAt: now,
  } as Session;
  store.save(main);
  const sidecars = askSidecars(store, { limits });
  const job = (sid: string, o: Record<string, unknown> = {}) => {
    const jid = id();
    store.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,origin) VALUES(?,?,?,?,?,?,?,?,?)",
      jid,
      sid,
      "n1",
      (o.request_id as string) || jid,
      (o.text as string) || "继续",
      "[]",
      (o.status as string) || "pending",
      (o.created as number) || Date.now(),
      (o.origin as string) || null,
    );
    return store.one("SELECT * FROM jobs WHERE id=?", jid);
  };
  return {
    store,
    main,
    sidecars,
    job,
    done: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("limits: defaults from the contract, overridable; why a main session falls back", () => {
  const f = fixture({ concurrent: 5, daily: 0 });
  try {
    assert.equal(f.sidecars.limits.concurrent, 5);
    // A non-positive override is ignored.
    assert.equal(f.sidecars.limits.daily, ASK_SIDECAR.daily);
    assert.equal(f.sidecars.limits.idleMs, ASK_SIDECAR.idleMs);
    assert.equal(f.sidecars.fallback(f.main), null);
    assert.equal(
      f.sidecars.fallback({ ...f.main, settings: { askSidecar: false } }),
      "disabled",
    );
    assert.equal(
      f.sidecars.fallback({ ...f.main, agent: "kimi" } as Session),
      "unsupported",
    );
    f.store.run("UPDATE nodes SET capabilities='{}' WHERE id='n1'");
    assert.equal(f.sidecars.fallback(f.main), "runner");
  } finally {
    f.done();
  }
});

test("storage: one open sidecar per main session × conversation, a hidden read-only fork", () => {
  const f = fixture();
  try {
    const a = f.sidecars.sidecarFor(f.main, "conv-1", "root-1");
    assert.equal(a.created, true);
    const s = a.session;
    assert.equal(f.sidecars.isSidecar(s.id), true);
    assert.equal(f.sidecars.isSidecar(f.main.id), false);
    assert.deepEqual(
      { ...s.sidecar },
      {
        parent: f.main.id,
        threadId: "conv-1",
        root: "root-1",
        forkFrom: "native-main",
        createdAt: s.sidecar!.createdAt,
      },
    );
    assert.equal(s.ownerId, f.main.ownerId);
    assert.equal(s.task, null);
    assert.equal(s.contextDelivered, true);
    assert.deepEqual(s.settings, { model: "opus" });
    // The same conversation resumes it; another gets its own.
    assert.equal(f.sidecars.sidecarFor(f.main, "conv-1", "root-1").created, false);
    assert.equal(f.sidecars.open(f.main.id, "root-1")?.id, s.id);
    const b = f.sidecars.sidecarFor(f.main, "conv-1", "root-2").session;
    assert.notEqual(b.id, s.id);
    // Counting: active turns, turns in 24 hours.
    f.job(s.id, { status: "running" });
    f.job(b.id, { status: "queued" });
    f.job(b.id, { status: "completed", created: Date.now() - 2 * 86400_000 });
    assert.equal(f.sidecars.active(f.main.id), 2);
    assert.equal(f.sidecars.today(f.main.id), 2);
    // History of earlier questions.
    f.sidecars.remember(s.id, { question: "q1", response: "a1", via: "fork" });
    assert.deepEqual(
      f.sidecars.history(s.id).map((h) => h.question),
      ["q1"],
    );
  } finally {
    f.done();
  }
});

test("summaries ride the main session's next turn once, as external data; given back when it fails", () => {
  const f = fixture();
  try {
    const sc = f.sidecars.sidecarFor(f.main, "conv-1", "root-1").session;
    f.sidecars.keep({
      main: f.main.id,
      sidecar: sc.id,
      tid: "conv-1",
      mid: "q-1",
      text: "问了什么：<b>回测</b>\n待主线处理：无",
    });
    // Not into: a sidecar's own turn, a / command, an Agent-started turn.
    assert.equal(f.sidecars.carry(f.job(sc.id)).preamble ?? null, null);
    assert.equal(
      f.sidecars.carry(f.job(f.main.id, { text: "/compact" })).preamble ?? null,
      null,
    );
    assert.equal(
      f.sidecars.carry(f.job(f.main.id, { origin: "agent" })).preamble ?? null,
      null,
    );
    const j = f.sidecars.carry(f.job(f.main.id));
    assert.match(j.preamble, /^【支线回答摘要（1 条）】别人「只问」了你/);
    assert.match(j.preamble, /<external_message>\n问了什么：\\u003cb\\u003e回测/);
    assert.equal(
      f.store.one("SELECT preamble FROM jobs WHERE id=?", j.id).preamble,
      j.preamble,
    );
    // Carried once.
    assert.equal(f.sidecars.waiting(f.main.id).length, 0);
    assert.equal(f.sidecars.carry(f.job(f.main.id)).preamble ?? null, null);
    // That turn failed: waiting again; the next one ends well: gone.
    f.sidecars.settled(j.id, false);
    assert.equal(f.sidecars.waiting(f.main.id).length, 1);
    const k = f.sidecars.carry(f.job(f.main.id));
    assert.ok(k.preamble);
    f.sidecars.settled(k.id, true);
    assert.equal(
      f.store.one("SELECT count(*) n FROM sidecar_summaries").n,
      0,
    );
  } finally {
    f.done();
  }
});

test("cleanup: idle sidecars close (archived, kept), and all close with their main session", () => {
  const f = fixture({ idleMs: 1000 });
  try {
    const s1 = f.sidecars.sidecarFor(f.main, "c", "r1").session;
    const s2 = f.sidecars.sidecarFor(f.main, "c", "r2").session;
    f.job(s2.id, { status: "queued" });
    // s2 has a turn waiting: not closed.
    assert.deepEqual(f.sidecars.sweep(Date.now() + 5000), [s1.id]);
    assert.equal(f.store.session(s1.id)?.archived, true);
    assert.equal(f.sidecars.open(f.main.id, "r1"), null);
    f.sidecars.closeAll(f.main.id);
    assert.equal(f.store.session(s2.id)?.archived, true);
    assert.equal(f.sidecars.open(f.main.id, "r2"), null);
  } finally {
    f.done();
  }
});
