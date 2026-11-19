// Codex stalls (2026-11-06, user reports): 「有的时候会遇到 压缩上下文 然后提示失败，
// 但是再发送一条新的消息 窗口就被成功压缩」 and 「有的时候会陷入 无限的执行中状态
// 却没有任何输出」. The fixture speaks Codex 0.157.1 as measured: /compact is a
// turn of its own (contextCompaction item + turn/completed, no
// thread/compacted), turn/start during it fails with ActiveTurnNotSteerable
// { turn_kind: Compact }, and Codex may send nothing for minutes.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codexAgent } from "../packages/daisy/src/harness/codex.ts";
import {
  noHooks,
  type Runtime,
} from "../packages/daisy/src/harness/shared.ts";

const ENV = [
  "DAISY_CODEX_BIN",
  "DAISY_FIXTURE_COMPACT",
  "DAISY_FIXTURE_COMPACT_MS",
  "DAISY_FIXTURE_COMPACT_DEAF",
  "DAISY_FIXTURE_SILENT_END",
  "DAISY_FIXTURE_SILENT_ITEM",
  "DAISY_FIXTURE_SILENT_CHILD",
  "DAISY_FIXTURE_NO_STATUS",
  "DAISY_FIXTURE_NO_TURNS",
  "DAISY_FIXTURE_NO_TURN_STARTED",
  "DAISY_FIXTURE_RECORD",
  "DAISY_CODEX_QUIET_MS",
  "DAISY_CODEX_STALL_MS",
  "DAISY_CODEX_COMPACT_CHECK_MS",
  "DAISY_CODEX_COMPACT_MAX_MS",
  "DAISY_CODEX_POLL_MS",
];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

function setup(env: Record<string, string> = {}) {
  process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
  process.env.DAISY_CODEX_POLL_MS = "40";
  Object.assign(process.env, env);
  const job = (id: string, operation?: string) =>
    ({
      id,
      session: { id: "s1", agent: "codex", nativeId: null },
      profile: { id: "p1", label: "Codex", authMode: "subscription" },
      attachments: [],
      ...(operation ? { operation: { name: operation } } : {}),
    }) as any;
  const agent = codexAgent(job("first"), process.cwd(), noHooks, true);
  const items = new Map<string, any>(),
    /** Every version of every item, in order. */
    log: string[] = [];
  const rt = (
    id: string,
    prompt: string,
    operation?: string,
    signal = new AbortController().signal,
  ): Runtime => ({
    job: job(id, operation),
    cwd: process.cwd(),
    prompt,
    files: [],
    signal,
    emit: (type, data) => {
      if (type === "item") {
        items.set(data.id, data);
        log.push(`${data.name || ""}｜${data.text || ""}`);
      }
    },
    flush: async () => {},
    approve: async () => ({ optionId: "accept" }),
  });
  return { agent, items, log, rt };
}

test("/compact is confirmed by Codex 0.157's own events (no thread/compacted)", async () => {
  const { agent, items, rt } = setup();
  try {
    // N-4: a turn first (Codex counts 31K), then /compact (5K after).
    await agent.turn(rt("t0", "Hello"));
    const out = await agent.turn(rt("c1", "/compact", "compact"));
    assert.equal(out.compact?.trigger, "manual");
    assert.equal(out.compact?.preTokens, 31000);
    assert.equal(out.compact?.postTokens, 5000);
    assert.ok((out.compact?.durationMs ?? -1) >= 0);
    assert.match(
      items.get("c1:compact:codex")?.text,
      /^已压缩上下文：31\.0K → 5\.0K tokens（[\d.]+ 秒 · 手动压缩）$/,
    );
    assert.equal(items.get("c1:compacting")?.text, "success");
    // The compaction turn's own item does not show twice.
    assert.ok(![...items.keys()].some((k) => k.includes(":cc")));
  } finally {
    agent.stop();
  }
});

test("/compact still answers the deprecated thread/compacted (older Codex)", async () => {
  const { agent, items, rt } = setup({ DAISY_FIXTURE_COMPACT: "legacy" });
  try {
    // N-4: no count before or after: no 「? → ?」.
    const out = await agent.turn(rt("c1", "/compact", "compact"));
    assert.equal(out.compact?.preTokens, undefined);
    assert.equal(out.compact?.postTokens, undefined);
    assert.match(
      items.get("c1:compact:codex")?.text,
      /^已压缩上下文（[\d.]+ 秒 · 手动压缩）$/,
    );
  } finally {
    agent.stop();
  }
});

test("/compact slower than the first check is not a failure: the thread is asked and Daisy keeps waiting", async () => {
  const { agent, items, rt } = setup({
    DAISY_FIXTURE_COMPACT: "slow",
    DAISY_FIXTURE_COMPACT_MS: "500",
    DAISY_CODEX_COMPACT_CHECK_MS: "60",
  });
  const seen: string[] = [];
  try {
    const r = rt("c1", "/compact", "compact"),
      emit = r.emit;
    r.emit = (type, data) => {
      if (type === "item" && data.id === "c1:compacting") seen.push(data.text);
      emit(type, data);
    };
    assert.equal((await agent.turn(r)).compact?.postTokens, 5000);
    assert.ok(
      seen.some((t) => /Codex 仍在压缩/.test(t)),
      `progress shown: ${seen}`,
    );
    assert.equal(items.get("c1:compacting")?.status, "complete");
  } finally {
    agent.stop();
  }
});

test("/compact that never ends is interrupted after the limit with a clear message; the next message runs", async () => {
  const { agent, items, rt } = setup({
    DAISY_FIXTURE_COMPACT: "stuck",
    DAISY_CODEX_COMPACT_CHECK_MS: "40",
    DAISY_CODEX_COMPACT_MAX_MS: "200",
  });
  try {
    await assert.rejects(
      () => agent.turn(rt("c1", "/compact", "compact")),
      /压缩 .* 仍未完成，已中断这次压缩/,
    );
    await agent.turn(rt("t2", "Hello"));
    assert.ok([...items.values()].some((i) => i.text === "Hello"));
  } finally {
    agent.stop();
  }
});

test("a message sent while Codex still compacts waits for the compaction instead of failing, and its end is not taken for the message's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-codex-stall-"));
  const record = join(dir, "inputs.jsonl");
  appendFileSync(record, "");
  // The compaction outlives the /compact job (Codex ignores the interrupt
  // here, as a compaction Daisy stopped waiting for keeps running).
  const { agent, items, log, rt } = setup({
    DAISY_FIXTURE_COMPACT: "slow",
    DAISY_FIXTURE_COMPACT_MS: "700",
    DAISY_FIXTURE_COMPACT_DEAF: "1",
    DAISY_FIXTURE_RECORD: record,
    DAISY_CODEX_COMPACT_CHECK_MS: "40",
    DAISY_CODEX_COMPACT_MAX_MS: "100",
  });
  try {
    await assert.rejects(() => agent.turn(rt("c1", "/compact", "compact")));
    process.env.DAISY_CODEX_COMPACT_MAX_MS = "5000";
    await agent.turn(rt("t2", "After compaction"));
    const sent = readFileSync(record, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).text);
    // turn/start was refused once, then sent again after the compaction.
    assert.deepEqual(sent, ["After compaction", "After compaction"]);
    assert.ok(log.some((t) => /压缩完成后再把这条消息交给它/.test(t)));
    // The message's own turn ran to its end (its reply, not cut off by the
    // compaction turn's turn/completed).
    assert.ok([...items.values()].some((i) => i.text === "Hello"));
  } finally {
    agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a turn whose turn/completed never arrives ends from the thread's record", async () => {
  const { agent, items, rt } = setup({
    DAISY_FIXTURE_SILENT_END: "missed",
    DAISY_CODEX_QUIET_MS: "300",
  });
  try {
    await agent.turn(rt("t1", "SILENT_TURN"));
    assert.ok(
      [...items.values()].some(
        (i) => i.kind === "assistant" && i.text === "Answer never notified",
      ),
    );
    assert.match(items.get("t1:codex-quiet")?.name, /没有发出轮次结束通知/);
  } finally {
    agent.stop();
  }
});

test("a turn Codex no longer runs fails with a clear message instead of hanging", async () => {
  const { agent, rt } = setup({
    DAISY_FIXTURE_SILENT_END: "idle",
    DAISY_CODEX_QUIET_MS: "300",
  });
  try {
    await assert.rejects(
      () => agent.turn(rt("t1", "SILENT_TURN")),
      /Codex 已不在运行这一轮（线程状态 idle）/,
    );
  } finally {
    agent.stop();
  }
});

test("a silent turn shows 「Codex 无响应」 in the trace, then is interrupted and fails after the stall limit", async () => {
  const { agent, items, rt } = setup({
    DAISY_CODEX_QUIET_MS: "150",
    DAISY_CODEX_STALL_MS: "600",
  });
  const shown: string[] = [];
  try {
    const r = rt("t1", "SILENT_TURN"),
      emit = r.emit;
    r.emit = (type, data) => {
      if (type === "item" && data.id === "t1:codex-quiet")
        shown.push(data.text);
      emit(type, data);
    };
    await assert.rejects(() => agent.turn(r), /Codex 无响应 .*已结束这一轮/);
    assert.ok(
      shown.some((t) => /^Codex 无响应 .*线程仍在运行/.test(t)),
      `${shown}`,
    );
    // Codex was asked to stop the turn: the next message runs normally.
    await agent.turn(rt("t2", "Hello"));
    assert.ok([...items.values()].some((i) => i.text === "Hello"));
  } finally {
    agent.stop();
  }
});

// Review 2026-11-06: the stall limit fails a turn only when it is known
// that nothing executes; otherwise 「Codex 无响应」 is only shown.
for (const [name, env, says] of [
  [
    "the thread status is unknown (older Codex)",
    { DAISY_FIXTURE_NO_STATUS: "1" },
    /线程状态未知/,
  ],
  [
    "the turn's items cannot be listed (no thread/turns/list)",
    { DAISY_FIXTURE_NO_TURNS: "1" },
    /线程仍在运行/,
  ],
  [
    "a command started and has not ended (Codex 0.157 lists no in-progress items)",
    { DAISY_FIXTURE_SILENT_ITEM: "1" },
    /commandExecution 仍在执行/,
  ],
  [
    "a subagent still runs",
    { DAISY_FIXTURE_SILENT_CHILD: "1" },
    /子 Agent 仍在运行/,
  ],
] as const)
  test(`silence never fails the turn when ${name}`, async () => {
    const { agent, rt } = setup({
      ...env,
      DAISY_CODEX_QUIET_MS: "100",
      DAISY_CODEX_STALL_MS: "250",
    });
    const stop = new AbortController(),
      shown: string[] = [];
    try {
      const r = rt("t1", "SILENT_TURN", undefined, stop.signal),
        emit = r.emit;
      r.emit = (type, data) => {
        if (type === "item" && data.id === "t1:codex-quiet")
          shown.push(data.text);
        emit(type, data);
      };
      setTimeout(() => stop.abort(), 1200);
      // Only the owner's stop ends it.
      await assert.rejects(() => agent.turn(r), /Codex 轮次已中断/);
      assert.ok(
        shown.some((t) => says.test(t)),
        `${shown}`,
      );
    } finally {
      agent.stop();
    }
  });

test("stopping a message that waits for a compaction leaves the process and the compaction running", async () => {
  const { agent, items, rt } = setup({
    DAISY_FIXTURE_COMPACT: "slow",
    DAISY_FIXTURE_COMPACT_MS: "900",
    DAISY_FIXTURE_COMPACT_DEAF: "1",
    DAISY_CODEX_COMPACT_CHECK_MS: "40",
    DAISY_CODEX_COMPACT_MAX_MS: "100",
  });
  try {
    await assert.rejects(() => agent.turn(rt("c1", "/compact", "compact")));
    process.env.DAISY_CODEX_COMPACT_MAX_MS = "5000";
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 150);
    await assert.rejects(
      () => agent.turn(rt("t2", "Stopped", undefined, stop.signal)),
      /本轮已停止/,
    );
    assert.equal(agent.closed, false);
    // The compaction's end is no message's: no notice in the stopped job.
    await agent.turn(rt("t3", "Hello"));
    assert.ok([...items.values()].some((i) => i.text === "Hello"));
    assert.ok(![...items.keys()].some((k) => k.startsWith("t2:compact:")));
  } finally {
    agent.stop();
  }
});

test("/compact on a Codex that cannot be asked keeps the old rule: not confirmed in time = failure", async () => {
  const { agent, rt } = setup({
    DAISY_FIXTURE_COMPACT: "stuck",
    DAISY_FIXTURE_NO_TURN_STARTED: "1",
    DAISY_CODEX_COMPACT_CHECK_MS: "60",
  });
  try {
    await assert.rejects(
      () => agent.turn(rt("c1", "/compact", "compact")),
      /压缩未确认完成，请查看原生会话后重试/,
    );
  } finally {
    agent.stop();
  }
});
