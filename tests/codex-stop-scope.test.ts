// 「停止」 stops the current turn and everything it started in the
// foreground. Codex 0.157.1 (measured): root `turn/interrupt` ends only the
// root turn — subagent threads run on to completion and running
// unified-exec commands run on as background terminals. The fixture speaks
// that; Daisy interrupts each subagent turn and terminates this turn's
// commands, leaving terminals an earlier turn left running.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codexAgent } from "../packages/daisy/src/harness/codex.ts";
import {
  noHooks,
  type Runtime,
} from "../packages/daisy/src/harness/shared.ts";
import { AGENT_STOP } from "../packages/contracts/src/agent-stop.ts";

const ENV = [
  "DAISY_CODEX_BIN",
  "DAISY_CODEX_POLL_MS",
  "DAISY_CODEX_STOP_KILL_MS",
  "DAISY_FIXTURE_RECORD_STOP",
  "DAISY_FIXTURE_SUBAGENTS",
  "DAISY_FIXTURE_CHILD_DEAF",
];
const dirs: string[] = [];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codex-stop-"));
  dirs.push(dir);
  const record = join(dir, "stop.jsonl");
  process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
  process.env.DAISY_CODEX_POLL_MS = "40";
  process.env.DAISY_FIXTURE_RECORD_STOP = record;
  Object.assign(process.env, env);
  const job = (id: string) =>
    ({
      id,
      session: { id: "s1", agent: "codex", nativeId: null },
      profile: { id: "p1", label: "Codex", authMode: "subscription" },
      attachments: [],
    }) as any;
  const items = new Map<string, any>();
  // Between turns (a stop finishing after its turn ended) items go out on
  // the session channel.
  const agent = codexAgent(
    job("first"),
    process.cwd(),
    {
      ...noHooks,
      emit: (type, data: any) => {
        if (type === "item") items.set(data.id, data);
      },
    },
    true,
  );
  const rt = (id: string, prompt: string, signal: AbortSignal): Runtime => ({
    job: job(id),
    cwd: process.cwd(),
    prompt,
    files: [],
    signal,
    emit: (type, data) => {
      if (type === "item") items.set(data.id, data);
    },
    flush: async () => {},
    approve: async () => ({ optionId: "accept" }),
  });
  const sent = () =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  return { agent, items, rt, sent };
}
const until = async (ok: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

for (const via of ["activity", "collab"] as const)
  test(`停止 interrupts the parent turn, its subagent turns and this turn's commands (subagent via ${via})`, async () => {
    const { agent, items, rt, sent } = setup(
      via === "collab" ? { DAISY_FIXTURE_SUBAGENTS: "collab" } : {},
    );
    try {
      const stop = new AbortController();
      const turn = agent.turn(rt("j1", "STOP_SCOPE", stop.signal));
      turn.catch(() => {});
      // The subagent shows as running (the steer counts `child:` rows).
      await until(() => items.get("j1:child:child-a")?.status === "running");
      if (via === "activity")
        assert.equal(items.get("j1:child:child-a").name, "子 Agent · worker");
      stop.abort();
      await assert.rejects(turn, /中断/);
      await until(() =>
        sent().some(
          (r) =>
            r.method === "thread/backgroundTerminals/terminate" &&
            r.params.threadId === "child-a",
        ),
      );
      const calls = sent();
      const interrupts = calls
        .filter((r) => r.method === "turn/interrupt")
        .map((r) => `${r.params.threadId}/${r.params.turnId}`);
      assert.ok(interrupts.some((x) => x.startsWith("codex-native/")));
      assert.ok(interrupts.includes("child-a/ct-a"));
      const terminated = calls
        .filter((r) => r.method === "thread/backgroundTerminals/terminate")
        .map((r) => `${r.params.threadId}/${r.params.processId}`)
        .sort();
      // cmd-old (an earlier turn's) keeps running.
      assert.deepEqual(terminated, ["child-a/p2", "codex-native/p1"]);
      await until(() =>
        /已中断 1 个子 Agent/.test(items.get("j1:stop-scope")?.text || ""),
      );
      assert.match(items.get("j1:stop-scope").text, /已终止 2 个本轮命令/);
      assert.equal(items.get("j1:child:child-a").status, "error");
      assert.match(items.get("j1:child:child-a").text, /已随「停止」中断/);
      assert.equal(agent.closed, false);
    } finally {
      agent.stop();
    }
  });

test("停止: a subagent that ignores its interrupt ends the process after the grace period", async () => {
  const { agent, rt, sent } = setup({
    DAISY_FIXTURE_CHILD_DEAF: "1",
    // Long enough that the root turn's own "interrupted" comes first on a
    // slow runner (a kill before it is stoppedEnd's case, stop-wins.test.ts).
    DAISY_CODEX_STOP_KILL_MS: "1500",
  });
  try {
    const stop = new AbortController();
    const turn = agent.turn(rt("j1", "STOP_SCOPE", stop.signal));
    turn.catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    stop.abort();
    await assert.rejects(turn, /中断/);
    assert.equal(agent.closed, false);
    await until(() => agent.closed, 5000);
    assert.ok(sent().some((r) => r.params?.threadId === "child-a"));
  } finally {
    agent.stop();
  }
});

test("停止 with everything stopped keeps the online process", async () => {
  // As above: the grace period is not what this test races.
  const { agent, rt, sent } = setup({ DAISY_CODEX_STOP_KILL_MS: "1000" });
  try {
    const stop = new AbortController();
    const turn = agent.turn(rt("j1", "STOP_SCOPE", stop.signal));
    turn.catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    stop.abort();
    await assert.rejects(turn, /中断/);
    // Past the grace period: the subagent / command check found nothing running.
    await new Promise((r) => setTimeout(r, 1400));
    assert.ok(sent().some((r) => r.method === "turn/interrupt"));
    assert.equal(agent.closed, false);
  } finally {
    agent.stop();
  }
});

test("subAgentActivity: a subagent shows by its agentPath name and the job waits for it to finish", async () => {
  const { agent, items, rt } = setup();
  try {
    await agent.turn(rt("j1", "SUBAGENT_DONE", new AbortController().signal));
    const row = items.get("j1:child:child-a");
    assert.equal(row?.category, "subagent");
    assert.equal(row?.name, "子 Agent · worker");
    assert.equal(row?.status, "complete");
    assert.equal(row?.parentId, "codex-native");
    // The activity items themselves are not separate trace rows.
    assert.ok(![...items.keys()].some((k) => k.includes("act-")));
    assert.equal(items.get("j1:child-a:child-msg")?.text, "Child done");
  } finally {
    agent.stop();
  }
});

test("agentStop capability: Codex stops subagents and commands by Daisy, Claude natively", () => {
  assert.deepEqual(
    [AGENT_STOP.codex.subagents, AGENT_STOP.codex.commands],
    ["fallback", "fallback"],
  );
  assert.deepEqual(
    [AGENT_STOP.claude.subagents, AGENT_STOP.claude.commands],
    ["native", "native"],
  );
  for (const a of Object.values(AGENT_STOP)) {
    assert.ok(a.survives.includes("backgroundTasks"));
    assert.equal(a.killAfterMs, 5000);
  }
});

// the reap selection on a fake process table (no real processes).
test("sandbox reap: only the children of a bwrap that the terminate ended, by pid + start time", async () => {
  const { sandboxesFor, orphansToKill } =
    await import("../packages/daisy/src/platform/sandbox-reap.ts");
  const P = (
    parent: number,
    comm: string,
    cmdline = "",
    start = `s${parent}`,
  ) => ({ parent, comm, cmdline, start });
  // 100 = codex app-server; 110/120 = bwrap per terminal; 111/121 = the
  // sandbox wrapper; 112/122 = the commands; 130 = an unsandboxed command.
  const before = new Map(
    Object.entries({
      100: P(1, "codex"),
      110: P(100, "bwrap", "bwrap --new-session"),
      111: P(110, "codex-linux-sandbox"),
      112: P(111, "bash", "/bin/bash -c sleep 61 && echo parent-done"),
      120: P(100, "bwrap", "bwrap --new-session"),
      121: P(120, "codex-linux-sandbox"),
      122: P(121, "bash", "/bin/bash -c npm run dev"),
      130: P(100, "bash", "/bin/bash -c sleep 61 && echo parent-done"),
      200: P(1, "bwrap", "bwrap"),
      201: P(200, "bash", "/bin/bash -c sleep 61 && echo parent-done"),
    }).map(([k, v]) => [Number(k), v]),
  );
  const noted = sandboxesFor(before, 100, "sleep 61 && echo parent-done");
  // Only the bwrap under this app-server running that command.
  assert.deepEqual(
    noted.map((b) => b.pid),
    [110],
  );
  assert.deepEqual([...noted[0].children.keys()], [111]);
  assert.deepEqual(sandboxesFor(before, 100, ""), []);
  // After the terminate: 110 gone, 111 reparented and still running.
  const after = new Map(before);
  after.delete(110);
  after.set(111, { ...before.get(111)!, parent: 1 });
  assert.deepEqual(orphansToKill(noted, after).sort(), [111, 112]);
  // A bwrap the terminate did not end: nothing.
  assert.deepEqual(orphansToKill(noted, before), []);
  // The pid reused by another process (other start time): nothing.
  const reused = new Map(after);
  reused.set(111, { ...before.get(111)!, parent: 1, start: "other" });
  reused.delete(112);
  assert.deepEqual(orphansToKill(noted, reused), []);
  // bwrap pid reused by something else counts as gone.
  const bwrapReused = new Map(after);
  bwrapReused.set(110, P(1, "node", "", "new"));
  assert.deepEqual(orphansToKill(noted, bwrapReused).sort(), [111, 112]);
  // The other terminal's sandbox (122) and the unsandboxed 130 never.
  assert.ok(
    !orphansToKill(noted, after).some((p) => [120, 121, 122, 130].includes(p)),
  );
});
