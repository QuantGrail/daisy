import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./fixtures/scheduler-harness.ts";
import {
  A2A_TOOL_NAMES,
  SCHEDULER_TOOL_NAMES,
} from "../packages/contracts/src/native-tools.ts";
/**
 * P4N-3 (ADR-127 note): Codex takes Daisy's dynamic tools only at
 * thread/start, so a conversation started before a tool existed never gets
 * it. Daisy records the names a thread started with; on resume the owner
 * is told once, in that conversation, which ones it lacks and that /new
 * has them, and the model is told not to pretend (fake Codex app-server).
 */
test("P4N-3: Codex — a thread records the tools it started with; one resumed without the A2A tools tells the owner once and the model which ones it lacks", async () => {
  const h = await setup();
  try {
    const s = await h.create("codex");
    await h.turn(s.id, "你好");
    const start = h.lines(h.thread).find((x) => x.via === "thread/start");
    // ADR-154: a new thread gets Daisy's names and records version 2.
    assert.ok(start.dynamicTools.includes("daisy_agents"));
    let snap = await h.c.snapshot(s.id);
    const thread = snap.session.nativeId!;
    // The names, for good.
    assert.deepEqual(snap.session.nativeTools, {
      thread,
      version: 2,
      names: [...SCHEDULER_TOOL_NAMES, ...A2A_TOOL_NAMES],
    });
    // A resume of a thread that has them all: no notice, no line.
    await h.restartRunner();
    await h.turn(s.id, "再来");
    let resume = h.lines(h.thread).filter((x) => x.via === "thread/resume").at(-1);
    assert.ok(resume, "resumed");
    assert.ok(!resume.developerInstructions.includes("缺少的 Daisy 工具"));
    snap = await h.c.snapshot(s.id);
    assert.ok(!snap.items.some((i) => i.id.endsWith(":tools-missing")));

    // The thread as one started before phase 4: the timers, not the A2A
    // tools — and (version 1) by the old names, which it keeps (ADR-154).
    const old = h.ctx.store.session(s.id)!;
    old.nativeTools = { thread, version: 1, names: [...SCHEDULER_TOOL_NAMES] };
    h.ctx.store.save(old);
    await h.restartRunner();
    await h.turn(s.id, "找一下别的智能体");
    resume = h.lines(h.thread).filter((x) => x.via === "thread/resume").at(-1);
    // Nothing Codex would refuse: resume carries no tools.
    assert.deepEqual(resume.dynamicTools, []);
    // The model: the timers note stays, and which tools it lacks.
    assert.match(resume.developerInstructions, /harbor_wakeup/);
    assert.match(
      resume.developerInstructions,
      /【这段对话缺少的 Daisy 工具】.*：harbor_agents、harbor_call_agent、harbor_call_result。不要假装调用/,
    );
    snap = await h.c.snapshot(s.id);
    const notices = snap.items.filter((i) => i.id.endsWith(":tools-missing"));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, "notice");
    assert.match(notices[0].text!, /发现智能体、调用智能体、查询调用结果/);
    assert.match(notices[0].text!, /输入 \/new 开一段新对话/);
    assert.match(notices[0].text!, /这段对话会保留/);
    assert.deepEqual(snap.session.nativeToolsNotice, {
      thread,
      names: [...A2A_TOOL_NAMES],
    });
    // The record of what the thread has is not rewritten by a resume.
    assert.deepEqual(snap.session.nativeTools!.names, [...SCHEDULER_TOOL_NAMES]);

    // Once: the next resume tells the model again, the owner not.
    await h.restartRunner();
    await h.turn(s.id, "还是没有吗");
    resume = h.lines(h.thread).filter((x) => x.via === "thread/resume").at(-1);
    assert.match(resume.developerInstructions, /harbor_call_agent/);
    snap = await h.c.snapshot(s.id);
    assert.equal(
      snap.items.filter((i) => i.id.endsWith(":tools-missing")).length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("P4N-3: Codex — a thread recorded before the names were kept: 'may lack' to the owner (once) and the model; a new conversation starts with every tool", async () => {
  const h = await setup();
  try {
    const s = await h.create("codex");
    await h.turn(s.id, "你好");
    const thread = (await h.c.snapshot(s.id)).session.nativeId!;
    const old = h.ctx.store.session(s.id)!;
    old.nativeTools = { thread, version: 1 };
    h.ctx.store.save(old);
    await h.restartRunner();
    await h.turn(s.id, "再来");
    const resume = h.lines(h.thread).filter((x) => x.via === "thread/resume").at(-1);
    // ADR-154: a version 1 thread keeps the old names its tools go by.
    assert.match(resume.developerInstructions, /^【Daisy 定时与后台】.*harbor_wakeup/);
    assert.match(
      resume.developerInstructions,
      /【这段对话可能缺少的 Daisy 工具】.*harbor_agents、harbor_call_agent、harbor_call_result。以你实际能调用的工具为准/,
    );
    const snap = await h.c.snapshot(s.id);
    const notice = snap.items.find((i) => i.id.endsWith(":tools-missing"));
    assert.match(notice!.text!, /可能没有：发现智能体、调用智能体、查询调用结果/);
    // A fresh conversation (another session, as /new makes): all tools, no notice.
    const fresh = await h.create("codex", "新对话");
    await h.turn(fresh.id, "你好");
    const starts = h.lines(h.thread).filter((x) => x.via === "thread/start");
    assert.ok(starts.at(-1).dynamicTools.includes("daisy_call_agent"));
    const fs = await h.c.snapshot(fresh.id);
    assert.ok(!fs.items.some((i) => i.id.endsWith(":tools-missing")));
  } finally {
    await h.close();
  }
});
