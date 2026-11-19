// 换身份's server rules without a Runner process (node
// capability, the switch transaction, identity-carried, 不带历史继续,
// delete / transfer while the old identity may still run, wake refusal),
// and the Runner's LiveRegistry with fake processes (another identity's
// process is never reused; retireOther fails rather than copy too early).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../packages/daisy/src/app.ts";
import { id, STORAGE } from "../packages/daisy/src/store/index.ts";
import {
  LiveRegistry,
  otherIdentityBusy,
  otherIdentityStuck,
  retireReason,
} from "../packages/daisy/src/turns/live.ts";
import { carryClaudeTranscript } from "../packages/daisy/src/turns/transcript-carry.ts";
import { runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";

const SID = "0a2676ac-9a17-4d4e-9be7-b64e20f6d48c";

test("换身份 server rules: capability, transaction, carried report, 不带历史继续, delete / transfer, wake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-switch-rules-"));
  // Inside the switch's transaction another connection cannot write: the
  // read and the write cannot be split by a concurrent switch.
  const hookSaw: string[] = [];
  const { app, store, issueToken, runnerApi } = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    identitySwitchHook: (sid) => {
      const other = new DatabaseSync(join(dir, STORAGE.file));
      try {
        other.exec("PRAGMA busy_timeout=0");
        other.prepare("UPDATE sessions SET data=data WHERE id=?").run(sid);
        hookSaw.push("wrote");
      } catch (e: any) {
        hookSaw.push(/locked|busy/i.test(e.message) ? "locked" : e.message);
      } finally {
        other.close();
      }
    },
  });
  const inject = runnerInject(app, runnerApi);
  try {
    const runner = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });
    const req = (
      url: string,
      method: any = "GET",
      payload?: any,
      token = issueToken(),
    ) =>
      inject({ url: "/api" + url, method, payload, headers: auth(token) });
    const runnerReq = (url: string, payload: any, lease?: string) =>
      inject({
        url: "/api/runner" + url,
        method: "POST",
        payload,
        headers: {
          ...runnerHeaders(runner.nodeId),
          ...(lease ? { "x-lease": lease } : {}),
        },
      });
    const mk = async (label: string) =>
      (
        await req("/profiles", "POST", {
          nodeId: runner.nodeId,
          agent: "claude",
          authMode: "subscription",
          label,
          configDir: join(dir, label),
        })
      ).json().id as string;
    const [a, b, c] = [await mk("A"), await mk("B"), await mk("C")];
    const cat = (await req("/catalog")).json();
    const s = (
      await req("/sessions", "POST", {
        agent: "claude",
        title: "rules",
        profileId: a,
        workspaceId: cat.workspaces[0].id,
      })
    ).json();
    store.save({ ...store.session(s.id)!, nativeId: SID });
    const sw = (profileId: string, token?: string) =>
      req(`/sessions/${s.id}/identity`, "POST", { profileId }, token);

    // An older Runner (no identityCarry capability): refused, upgrade first.
    const old = await sw(b);
    assert.equal(old.statusCode, 409);
    assert.equal(old.json().code, "runner_outdated");
    store.run(
      "UPDATE nodes SET capabilities=? WHERE id=?",
      JSON.stringify({ identityCarry: { version: 1 } }),
      runner.nodeId,
    );

    const first = await sw(b);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(hookSaw, ["locked"]);
    assert.equal(first.json().identityMove.from, a);
    assert.deepEqual(first.json().identityPrev, [a]);
    // A→B→C before any carry: the transcript is still A's.
    assert.equal((await sw(c)).json().identityMove.from, a);
    const at = store.session(s.id)!.identityMove!.at;

    // Delete A: its directory still holds the transcript. (P1-03: the
    // transfer to another member is gone with the accounts.)
    const del = await req(`/profiles/${a}`, "DELETE");
    assert.equal(del.statusCode, 409);
    assert.match(del.json().error, /对话记录还没带到新身份/);

    // identity-carried: only for a job this node holds with its lease, and
    // only the switch it was carried for.
    const job = (sid: string, node = runner.nodeId) => {
      const jid = id(),
        lease = id();
      store.run(
        "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,context,terminal,lease,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        jid,
        sid,
        node,
        "r-" + jid,
        "x",
        "[]",
        "running",
        Date.now(),
        null,
        null,
        lease,
        Date.now() + 60_000,
      );
      return { jid, lease };
    };
    const j1 = job(s.id);
    assert.equal(
      (await runnerReq(`/jobs/${j1.jid}/identity-carried`, { at }, "wrong"))
        .statusCode,
      409,
    );
    const foreign = job("s-foreign", "another-node");
    assert.equal(
      (
        await runnerReq(
          `/jobs/${foreign.jid}/identity-carried`,
          { at },
          foreign.lease,
        )
      ).statusCode,
      404,
    );
    const stale = await runnerReq(
      `/jobs/${j1.jid}/identity-carried`,
      { at: at - 1 },
      j1.lease,
    );
    assert.equal(stale.json().cleared, false);
    assert.ok(store.session(s.id)!.identityMove);
    const ok = await runnerReq(
      `/jobs/${j1.jid}/identity-carried`,
      { at },
      j1.lease,
    );
    assert.equal(ok.json().cleared, true);
    assert.equal(store.session(s.id)!.identityMove, undefined);
    store.run("DELETE FROM jobs WHERE session_id=?", s.id);

    // An online process that does not say its identity (older Runner): A
    // may still be the one running — no delete until it is offline.
    store.run(
      "INSERT INTO live_sessions(session_id,node_id,data,updated,stop) VALUES(?,?,?,?,0)",
      s.id,
      runner.nodeId,
      JSON.stringify({ online: true, at: Date.now() }),
      Date.now(),
    );
    const unknown = await req(`/profiles/${a}`, "DELETE");
    assert.equal(unknown.statusCode, 409);
    assert.match(unknown.json().error, /旧身份的 AI 进程还没结束/);

    // Wake: the busy check first; then the asking process's own identity
    // (B's process is not mistaken for A's), the last report only without.
    store.run(
      "UPDATE live_sessions SET data=? WHERE session_id=?",
      JSON.stringify({ online: true, profileId: a, at: Date.now() }),
      s.id,
    );
    const wake = (profileId?: string) =>
      runnerReq(`/live/${s.id}/wake`, {
        reason: "timer",
        ...(profileId ? { profileId } : {}),
      });
    const busy = job(s.id);
    assert.equal((await wake(a)).statusCode, 409);
    store.run("DELETE FROM jobs WHERE id=?", busy.jid);
    const refused = await wake(a);
    assert.equal(refused.statusCode, 410);
    assert.match(refused.json().error, /已换身份/);
    assert.equal((await wake()).statusCode, 410);
    const own = await wake(c);
    assert.equal(own.statusCode, 200, own.body);
    store.run("DELETE FROM jobs WHERE session_id=?", s.id);
    store.run("DELETE FROM live_sessions WHERE session_id=?", s.id);

    // 不带历史继续: only with a carry pending; clears it.
    assert.equal(
      (await req(`/sessions/${s.id}/identity/fresh`, "POST", {})).statusCode,
      409,
    );
    await sw(a);
    await sw(b);
    assert.ok(store.session(s.id)!.identityMove);
    const fresh = await req(`/sessions/${s.id}/identity/fresh`, "POST", {});
    assert.equal(fresh.statusCode, 200, fresh.body);
    const after = store.session(s.id)!;
    assert.equal(after.identityMove, undefined);
    assert.equal(after.nativeId, null);
    assert.equal(after.contextDelivered, false);
    assert.ok(
      store
        .events(s.id, 0)
        .some((e: any) => /已放弃旧身份里的对话记录/.test(e.data?.text || "")),
    );
    // Nothing pending and nothing running: A can go now.
    assert.equal((await req(`/profiles/${a}`, "DELETE")).statusCode, 200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fake online process: busy / stopping behaviour under test control. */
function fake(state: { busy?: boolean; stopsIn?: number | null }) {
  let closed = false;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((r) => (resolveStopped = r));
  return {
    since: Date.now(),
    lastActivity: Date.now(),
    get closed() {
      return closed;
    },
    busy: () => !!state.busy,
    pending: () => [],
    turn: async () => ({}),
    stop() {
      closed = true;
      if (state.stopsIn !== null)
        setTimeout(resolveStopped, state.stopsIn ?? 0);
    },
    stopped: () => stopped,
  };
}
const liveJob = (profileId: string) =>
  ({
    id: id(),
    session: { id: "s1", agent: "claude" },
    profile: { id: profileId, authMode: "subscription" },
    workspace: {},
    attachments: [],
    text: "",
    lease: "l",
  }) as any;

test("LiveRegistry: another identity's process is never reused; retireOther waits or fails", async () => {
  const made: any[] = [];
  let next: { busy?: boolean; stopsIn?: number | null } = {};
  const registry = new LiveRegistry({
    api: async () => ({}),
    runWake: () => {},
    enabled: true,
    idleMs: 60_000,
    make: () => {
      const a = fake(next);
      made.push({ agent: a, state: next });
      return a as any;
    },
  });
  const sessions = () => registry.sessions();
  // A's process; B's job while it is busy (an Agent-started turn): refused.
  next = { busy: true };
  registry.acquire(liveJob("A"), "/w");
  assert.throws(() => registry.acquire(liveJob("B"), "/w"), {
    message: otherIdentityBusy(),
  });
  // Even as an Agent-started job: never attached to A's process.
  assert.throws(
    () => registry.acquire({ ...liveJob("B"), origin: "agent" }, "/w"),
    { message: otherIdentityBusy() },
  );
  await assert.rejects(registry.retireOther("s1", "B"), {
    message: otherIdentityBusy(),
  });
  // Idle: A's process ends and B gets a new one.
  made[0].state.busy = false;
  next = {};
  const b = registry.acquire(liveJob("B"), "/w");
  assert.equal(made[0].agent.closed, true);
  assert.notEqual(b, made[0].agent);
  assert.deepEqual(sessions(), ["s1"]);

  // retireOther: A's process (again) that does not let go in time.
  registry.close("s1", "");
  next = { stopsIn: null };
  registry.acquire(liveJob("A"), "/w");
  await assert.rejects(registry.retireOther("s1", "B", 50), {
    message: otherIdentityStuck(),
  });
  // One that stops: waited for, then gone.
  next = { stopsIn: 10 };
  registry.acquire(liveJob("A"), "/w");
  await registry.retireOther("s1", "B", 1000);
  assert.deepEqual(sessions(), []);
  // Same identity: nothing to do.
  next = {};
  registry.acquire(liveJob("B"), "/w");
  await registry.retireOther("s1", "B");
  assert.deepEqual(sessions(), ["s1"]);
  registry.closeAll();
  assert.ok(retireReason());
});

test("carry limit: files already the same do not count", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "daisy-carry-limit-")));
  try {
    const a = join(root, "a"),
      b = join(root, "b"),
      proj = "-w";
    mkdirSync(join(a, "projects", proj, SID), { recursive: true });
    mkdirSync(join(b, "projects", proj, SID), { recursive: true });
    const big = "x".repeat(4096);
    writeFileSync(join(a, "projects", proj, `${SID}.jsonl`), big);
    writeFileSync(join(b, "projects", proj, `${SID}.jsonl`), big);
    writeFileSync(join(a, "projects", proj, SID, "small.json"), "{}");
    // 4 KiB transcript already there + 2 bytes to copy, under a 1 KiB limit.
    const r = await carryClaudeTranscript({
      fromDir: a,
      toDir: b,
      sessionId: SID,
      limit: 1024,
    });
    assert.deepEqual(r, { copied: 1, kept: [] });
    // A leftover temporary file of an interrupted carry is cleared; a file
    // kept aside earlier (crash before the notice) is reported again.
    const dst = join(b, "projects", proj);
    writeFileSync(join(dst, `${SID}.jsonl.${crypto.randomUUID()}.carry`), "x");
    writeFileSync(join(dst, `${SID}.jsonl.before-switch-old`), "old");
    writeFileSync(join(a, "projects", proj, `${SID}.jsonl`), big + "more");
    const again = await carryClaudeTranscript({
      fromDir: a,
      toDir: b,
      sessionId: SID,
      limit: 1 << 20,
    });
    assert.equal(again.copied, 1);
    assert.deepEqual(again.kept, [join(dst, `${SID}.jsonl.before-switch-old`)]);
    assert.ok(
      !(await import("node:fs"))
        .readdirSync(dst)
        .some((f) => f.endsWith(".carry")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
