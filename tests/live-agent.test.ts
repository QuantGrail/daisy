import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { claudeAgent } from "../packages/daisy/src/harness/claude.ts";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cwd = tmpdir();
const job = (id: string, text: string, extra: any = {}) =>
  ({
    id,
    text,
    attachments: [],
    lease: "l",
    session: { id: "s1", agent: "claude", nativeId: "", task: null },
    profile: {
      id: "p",
      authMode: "apiKey",
      apiKey: "x",
      permissionMode: "manual",
    },
    workspace: { path: cwd },
    ...extra,
  }) as any;
const rt = (j: any, log: string[], signal = new AbortController().signal) =>
  ({
    job: j,
    cwd,
    prompt: j.text,
    files: [],
    signal,
    emit: (t: string, d: any) => {
      if (t === "item" && d.kind === "assistant" && d.status === "complete")
        log.push(`${j.id}:${d.text}`);
    },
    flush: async () => {},
    approve: async () => ({ optionId: "allow" }),
    onInput: () => {},
  }) as any;
async function withAgent(
  fn: (a: ReturnType<typeof claudeAgent>, wakes: string[]) => Promise<void>,
) {
  process.env.DAISY_CLAUDE_BIN = resolve("tests/fixtures/agent.cjs");
  process.env.DAISY_FIXTURE_WAKE_MS = "200";
  const wakes: string[] = [];
  const a = claudeAgent(
    job("j0", ""),
    cwd,
    {
      wake: (r) => wakes.push(r),
      emit: () => {},
      changed: () => {},
      closed: () => {},
    },
    true,
  );
  try {
    await fn(a, wakes);
  } finally {
    a.stop();
    delete process.env.DAISY_CLAUDE_BIN;
    delete process.env.DAISY_FIXTURE_WAKE_MS;
  }
}
test("a message taking over an Agent-started turn is answered in its own job, not cut short (review r1 #1)", async () => {
  await withAgent(async (a, wakes) => {
    const log: string[] = [];
    await a.turn(rt(job("j1", "WAKE_TEST"), log));
    await delay(500);
    // The timer turn ran completely while nobody was attached.
    assert.deepEqual(wakes, ["定时器到点：检查构建"]);
    assert.ok(a.busy());
    await a.turn(rt(job("j2", "hello"), log));
    assert.deepEqual(log, [
      "j1:I will wake up later",
      "j2:Woke up by timer",
      "j2:Hello",
    ]);
    await delay(300);
    assert.equal(wakes.length, 1, "the reply did not become another wake");
    assert.ok(!a.busy());
  });
});
test("an Agent-started turn whose job stops early does not leave the process stuck busy (review r1 #2)", async () => {
  await withAgent(async (a) => {
    await a.turn(rt(job("j1", "WAKE_TEST"), []));
    await delay(500);
    assert.ok(a.busy());
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(
      a.turn(
        rt(job("j2", "", { origin: "agent", wake: "x" }), [], stop.signal),
      ),
    );
    assert.ok(!a.busy());
    // The process still serves the next message.
    await a.turn(rt(job("j3", "hello"), []));
    assert.ok(!a.busy());
  });
});

// Title sync: only the user's own title (titleStage "manual") is
// sent; DAISY_FIXTURE_RECORD lists every rename the fixture received, with
// its current transcript and the error it answered.
const titled = (
  id: string,
  title: string,
  extra: any = { titleAuto: false, titleStage: "manual" },
  text = "hello",
  nativeId = "claude-native",
) =>
  job(id, text, {
    session: {
      id: "s1",
      agent: "claude",
      nativeId,
      task: null,
      title,
      ...extra,
    },
  });
async function withRecord(
  env: Record<string, string>,
  fn: (renames: () => any[], inputs: () => string[]) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-title-"));
  const file = join(dir, "requests.jsonl");
  Object.assign(process.env, { DAISY_FIXTURE_RECORD: file, ...env });
  const lines = () =>
    readFileSync(file, { encoding: "utf8", flag: "a+" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x));
  try {
    await fn(
      () =>
        lines()
          .filter((x) => x.via === "rename_session")
          .map((x) => [x.title, x.session_id, x.error || "ok"]),
      () =>
        lines()
          .filter((x) => x.via === "user")
          .map((x) => x.text),
    );
  } finally {
    for (const k of ["DAISY_FIXTURE_RECORD", ...Object.keys(env)])
      delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  }
}
const watched = (r: any) => {
  const events: any[] = [];
  const emit = r.emit;
  r.emit = (type: string, data: any) => {
    events.push({ type, data });
    emit(type, data);
  };
  return {
    r,
    titleStages: () =>
      events
        .filter((e) => e.data?.id?.endsWith(":stage:title"))
        .map((e) => e.data),
  };
};
test("App titles reach only the bound native Claude session and update after a rename", async () => {
  await withRecord({}, async (renames) => {
    await withAgent(async (a) => {
      await a.turn(rt(titled("j1", "项目计划"), []));
      await a.turn(rt(titled("j2", "项目计划"), []));
      await a.turn(rt(titled("j3", "发布计划"), []));
      await a.turn(rt(titled("j4", "自动摘要", { titleAuto: true }), []));
      // /clear moves the CLI to a new transcript; Daisy follows its init.
      await a.turn(rt(titled("j5", "发布计划", undefined, "/clear"), []));
      // This job was built before the server saw the new id: the process's
      // own binding is used, not the job's stale nativeId.
      const log: string[] = [];
      await a.turn(rt(titled("j6", "发布计划"), log));
      assert.deepEqual(log, ["j6:Hello"]);
      assert.deepEqual(renames(), [
        ["项目计划", "claude-native", "ok"],
        ["发布计划", "claude-native", "ok"],
        ["发布计划", "claude-native-cleared", "ok"],
      ]);
    });
  });
  // A CLI that has already left the bound transcript refuses the rename:
  // nothing is renamed there, the message is still answered, and the title
  // goes to the transcript the CLI then reports.
  await withRecord(
    { DAISY_FIXTURE_SESSION: "claude-elsewhere" },
    async (renames) => {
      await withAgent(async (a) => {
        const log: string[] = [];
        const w = watched(rt(titled("j1", "发布计划"), log));
        await a.turn(w.r);
        assert.deepEqual(log, ["j1:Hello"]);
        assert.deepEqual(
          w.titleStages().map((x) => [x.status, x.text.split("\n")[0]]),
          [["error", "session_id is not the current session"]],
        );
        await a.turn(rt(titled("j2", "发布计划"), []));
        assert.deepEqual(renames(), [
          [
            "发布计划",
            "claude-native",
            "session_id is not the current session",
          ],
          ["发布计划", "claude-elsewhere", "ok"],
        ]);
      });
    },
  );
});

test("an AI title is never sent to Claude Code as the user's rename (titleStage final)", async () => {
  await withRecord({}, async (renames) => {
    await withAgent(async (a) => {
      // The server's one-time AI title: titleAuto false, titleStage final.
      await a.turn(
        rt(
          titled("j1", "AI 起的标题", {
            titleAuto: false,
            titleStage: "final",
          }),
          [],
        ),
      );
      // A placeholder, and an isolated fork named by the AI (no stage).
      await a.turn(rt(titled("j2", "第一句话", { titleAuto: true }), []));
      await a.turn(rt(titled("j3", "派生会话", {}), []));
      assert.deepEqual(renames(), []);
      await a.turn(rt(titled("j4", "用户改的名"), []));
      assert.deepEqual(renames(), [["用户改的名", "claude-native", "ok"]]);
    });
  });
});

test("an unsupported native rename leaves the chat usable, says why and is not asked again", async () => {
  await withRecord({ DAISY_FIXTURE_RENAME_FAIL: "1" }, async (renames) => {
    await withAgent(async (a) => {
      const log: string[] = [];
      const w = watched(rt(titled("j1", "发布计划"), log));
      await a.turn(w.r);
      assert.deepEqual(log, ["j1:Hello"]);
      const [s] = w.titleStages();
      assert.equal(s.name, "原生会话名未同步");
      assert.equal(s.status, "error");
      assert.match(s.text, /^unsupported rename\n/);
      const again = watched(rt(titled("j2", "发布计划"), log));
      await a.turn(again.r);
      assert.deepEqual(again.titleStages(), []);
      await a.turn(rt(titled("j3", "新标题"), log));
      assert.deepEqual(log, ["j1:Hello", "j2:Hello", "j3:Hello"]);
      assert.deepEqual(
        renames().map((x) => x[0]),
        ["发布计划", "新标题"],
      );
    });
  });
});

test("a rename Claude Code never answers holds the prompt at most 5 s, once", async () => {
  await withRecord({ DAISY_FIXTURE_RENAME_SILENT: "1" }, async (renames) => {
    await withAgent(async (a) => {
      const log: string[] = [];
      let t0 = Date.now();
      const w = watched(rt(titled("j1", "发布计划"), log));
      await a.turn(w.r);
      const first = Date.now() - t0;
      assert.ok(first >= 4500 && first < 8000, `first turn took ${first} ms`);
      assert.deepEqual(log, ["j1:Hello"]);
      assert.deepEqual(
        w.titleStages().map((x) => [x.status, x.text.split("\n")[0]]),
        [["error", "Agent protocol timeout: rename_session"]],
      );
      t0 = Date.now();
      await a.turn(rt(titled("j2", "发布计划"), log));
      assert.ok(
        Date.now() - t0 < 2000,
        "the timed-out title is not asked again",
      );
      assert.deepEqual(log, ["j1:Hello", "j2:Hello"]);
      assert.equal(renames().length, 1);
    });
  });
});

test("Stop during the rename ends the turn before the prompt and keeps the process", async () => {
  await withRecord(
    { DAISY_FIXTURE_RENAME_SILENT: "1" },
    async (renames, inputs) => {
      await withAgent(async (a) => {
        await a.turn(rt(titled("j1", "", { titleAuto: true }), []));
        const stop = new AbortController();
        setTimeout(() => stop.abort(), 150);
        const t0 = Date.now();
        await assert.rejects(
          a.turn(
            rt(
              titled("j2", "发布计划", undefined, "不该发出"),
              [],
              stop.signal,
            ),
          ),
          /本轮已停止/,
        );
        assert.ok(Date.now() - t0 < 2000, "Stop ends the wait at once");
        assert.equal(renames().length, 1);
        assert.ok(!inputs().includes("不该发出"), "the prompt was not sent");
        assert.ok(!a.closed && !a.busy());
        // The process still serves the next message; the rename still out
        // is not sent a second time.
        const log: string[] = [];
        const t1 = Date.now();
        await a.turn(rt(titled("j3", "发布计划"), log));
        assert.ok(Date.now() - t1 < 2000);
        assert.deepEqual(log, ["j3:Hello"]);
        assert.equal(renames().length, 1);
      });
    },
  );
});
