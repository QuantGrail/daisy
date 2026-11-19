import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, tool } from "./fixtures/scheduler-harness.ts";
import {
  bareToolName,
  DAISY_TOOLSET_VERSION,
  jobToolsField,
  sessionToolNames,
  toolId,
  toolNamesFor,
} from "../packages/contracts/src/native-tools.ts";
import {
  coreKnowsInjection,
  guideSidecarHead,
  guideUpdateHead,
  INJECT_MARK,
  orgHead,
  timersText,
} from "../packages/contracts/src/guide.ts";
import {
  ASK_NEEDS_FILES,
  sideQuestionNeedsFiles,
  sideQuestionText,
} from "../packages/contracts/src/ask-sidecar.ts";
import { forkTitle, isDaisyForkTitle } from "../packages/contracts/src/title.ts";
import { isSystemSender, systemSender } from "../packages/contracts/src/items.ts";
import { translator } from "../packages/contracts/src/i18n.ts";
import { shippedPacks } from "../packages/contracts/src/i18n-node.ts";
import {
  bothTimes,
  cronText,
  localTimeZone,
  templateCron,
  zoneName,
} from "../packages/contracts/src/scheduler.ts";
import { defaultSectionText } from "../packages/contracts/src/resident-prompt.ts";
import { isRedeliveryWake } from "../packages/daisy/src/schedule/scheduler.ts";
import { midTurnMarker } from "../packages/daisy/src/sessions/native-append.ts";
import { when } from "../packages/daisy/src/prompts/source-prompt.ts";
import { jobToolNames, toolsFor } from "../packages/daisy/src/tools/daisy-tools.ts";
import "../packages/contracts/src/i18n-node.ts";
import { promptT } from "../packages/contracts/src/prompt-i18n.ts";
const ZH = promptT("zh-CN");
/**
 * ADR-154 (P6-04): what the model reads says Daisy, not Daisy; the marks
 * Daisy matches against stored data are read in both spellings; Daisy's
 * tools go by `daisy` (`mcp__daisy__*`, `daisy_*`) — except for a native
 * conversation started with the old names, which keeps them so its tools
 * keep working; times are the machine's own zone, named.
 */

test("marks: the new spelling is written, the old one still recognised", () => {
  // 「只问」's fallback marker.
  assert.equal(ASK_NEEDS_FILES, "[[DAISY_NEEDS_FILES]]");
  assert.ok(sideQuestionText("问").includes("[[DAISY_NEEDS_FILES]]"));
  assert.ok(!/Harbor/.test(sideQuestionText("问")));
  for (const a of [
    "[[DAISY_NEEDS_FILES]]",
    "`[[ DAISY_NEEDS_FILES ]]`",
    "[[HARBOR_NEEDS_FILES]]",
    "HARBOR_NEEDS_FILES",
  ])
    assert.equal(sideQuestionNeedsFiles(a), true, a);
  assert.equal(sideQuestionNeedsFiles("答案是 42。"), false);
  // Claude copies' title markers.
  assert.equal(forkTitle({ title: "占位" }, false), "Daisy fork");
  assert.equal(forkTitle({ title: "占位" }, true), "Daisy rewind");
  for (const t of ["Daisy fork", "Daisy rewind", "Harbor fork", " Harbor rewind "])
    assert.equal(isDaisyForkTitle(t), true, t);
  assert.equal(isDaisyForkTitle("我的标题"), false);
  // The sender of Daisy's own items.
  const zh = translator(shippedPacks(), "zh-CN"),
    en = translator(shippedPacks(), "en");
  assert.equal(systemSender(zh), "Daisy 系统");
  assert.equal(systemSender(en), "Daisy system");
  // P6-23b: a reader takes every language's form and the old ones, whatever it speaks.
  for (const t of [zh, en])
    assert.ok(isSystemSender("Daisy 系统", t) && isSystemSender("Harbor 系统", t) && isSystemSender("Daisy system", t));
  assert.ok(!isSystemSender("某个成员") && !isSystemSender("Daisy") && !isSystemSender("system"));
  // 补送 wakes queued before and after.
  for (const t of ["【Daisy 补送后台回报】x", "【Harbor 补送后台回报】x", "【Daisy 补送外部回调】y", "【Harbor 补送外部回调】y"])
    assert.ok(isRedeliveryWake(t), t);
  assert.ok(!isRedeliveryWake("【Daisy 定时器到点】x"));
});

test("the injection mark: still written 「Harbor 注入」; a core keyed on either spelling is recognised", () => {
  assert.equal(INJECT_MARK, "Harbor 注入");
  const head = orgHead({ docId: "D", version: 3, level: 1, fetchedAt: 0, source: "control-plane", sha256: "a".repeat(64) }, 0);
  assert.ok(head.includes("Harbor 注入"));
  assert.ok(guideUpdateHead(ZH).startsWith("【Daisy 系统层说明已更新（Harbor 注入；"));
  assert.ok(guideSidecarHead(ZH).startsWith("【Daisy 只问支线说明（Harbor 注入；"));
  assert.ok(coreKnowsInjection("…带「Harbor 注入」标记的…"));
  assert.ok(coreKnowsInjection("…带「Daisy 注入」标记的…"));
  assert.ok(!coreKnowsInjection("长版本核心"));
});

test("tool names: ids in both spellings, which a session gets, what a job says", () => {
  assert.equal(DAISY_TOOLSET_VERSION, 2);
  assert.equal(toolId("claude", "wakeup"), "mcp__daisy__wakeup");
  assert.equal(toolId("codex", "wakeup"), "daisy_wakeup");
  assert.equal(toolId("claude", "wakeup", "legacy"), "mcp__harbor__wakeup");
  assert.equal(toolId("codex", "wakeup", "legacy"), "harbor_wakeup");
  for (const id of ["wakeup", "daisy_wakeup", "harbor_wakeup", "mcp__daisy__wakeup", "mcp__harbor__wakeup"])
    assert.equal(bareToolName(id), "wakeup", id);
  assert.equal(bareToolName("call_agent"), "call_agent");
  // A new conversation: the new names.
  assert.equal(sessionToolNames({ agent: "codex", nativeId: null }), "daisy");
  assert.equal(sessionToolNames({ agent: "claude", nativeId: null }), "daisy");
  // Codex: by the record of this thread.
  assert.equal(sessionToolNames({ agent: "codex", nativeId: "t", nativeTools: { thread: "t", version: 2, names: [] } }), "daisy");
  assert.equal(sessionToolNames({ agent: "codex", nativeId: "t", nativeTools: { thread: "t", version: 1, names: [] } }), "legacy");
  assert.equal(sessionToolNames({ agent: "codex", nativeId: "t", nativeTools: { thread: "t", version: 1 } }), "legacy");
  // …no record of this thread: it has no Daisy tools at all.
  assert.equal(sessionToolNames({ agent: "codex", nativeId: "t" }), "daisy");
  // Claude Code: a conversation that recorded version 2 (also under an
  // earlier native id: a rewind), else one from before — the old names.
  assert.equal(sessionToolNames({ agent: "claude", nativeId: "c" }), "legacy");
  assert.equal(sessionToolNames({ agent: "claude", nativeId: "c2", nativeTools: { thread: "c", version: 2 } }), "daisy");
  assert.equal(sessionToolNames({ agent: "claude", nativeId: "c", nativeTools: { thread: "c", version: 1 } }), "legacy");
  // A Runner before ADR-154 serves the old names only.
  const fresh = { agent: "codex" as const, nativeId: null };
  assert.equal(toolNamesFor(fresh, {}), "legacy");
  assert.equal(toolNamesFor(fresh, { daisyTools: { version: 2 } }), "daisy");
  assert.deepEqual(jobToolsField(fresh, {}), { harborTools: { version: 1 } });
  assert.deepEqual(jobToolsField(fresh, { daisyTools: { version: 2 } }), { daisyTools: { version: 2 } });
  assert.deepEqual(
    jobToolsField({ agent: "claude", nativeId: "c" }, { daisyTools: { version: 2 } }),
    { daisyTools: { version: 2, legacyNames: true } },
  );
  // The Runner's reading of a job.
  assert.equal(jobToolNames({ daisyTools: { version: 2 } }), "daisy");
  assert.equal(jobToolNames({ daisyTools: { version: 2, legacyNames: true } }), "legacy");
  assert.equal(jobToolNames({ harborTools: { version: 1 } }), "legacy");
  assert.equal(jobToolNames({}), null);
  assert.equal(toolsFor({ session: { kind: "ordinary" } as any }).length, 0);
  // The note names them as the conversation knows them.
  assert.match(timersText("codex"), /^【Daisy 定时与后台】.*daisy_wakeup.*这些由 Daisy 保存/);
  assert.match(timersText("claude", "legacy"), /^【Daisy 定时与后台】.*mcp__harbor__wakeup/);
  assert.ok(!/harbor/i.test(timersText("claude")));
});

test("Codex: a new thread gets daisy_* and records version 2; a thread started with harbor_* keeps them and its tools still work", async () => {
  const h = await setup();
  try {
    const s = await h.create("codex");
    await h.turn(s.id, tool("daisy_wakeup", { delaySeconds: 600, prompt: "新名字" }));
    const start = h.lines(h.thread).find((x) => x.via === "thread/start");
    assert.ok(start.dynamicTools.includes("daisy_wakeup"));
    assert.ok(!start.dynamicTools.some((n: string) => n.startsWith("harbor_")));
    assert.match(start.developerInstructions, /daisy_wakeup/);
    let snap = await h.c.snapshot(s.id);
    const thread = snap.session.nativeId!;
    assert.equal(snap.session.nativeTools?.version, 2);
    assert.match(h.toolResults().at(-1).result.text, /已设定定时器/);
    // The same thread as one started before ADR-154 (its record says 1).
    const old = h.ctx.store.session(s.id)!;
    old.nativeTools = { ...old.nativeTools!, version: 1 };
    h.ctx.store.save(old);
    await h.restartRunner();
    await h.turn(s.id, tool("harbor_wakeup", { delaySeconds: 600, prompt: "旧名字" }));
    const resume = h.lines(h.thread).filter((x) => x.via === "thread/resume").at(-1);
    assert.equal(resume.threadId, thread);
    // Its text names the tools it has; the call by the old name works.
    assert.match(resume.developerInstructions, /harbor_wakeup/);
    assert.ok(!resume.developerInstructions.includes("daisy_wakeup"));
    const r = h.toolResults().at(-1);
    assert.equal(r.tool, "harbor_wakeup");
    assert.equal(r.result.isError, false);
    assert.match(r.result.text, /已设定定时器/);
    snap = await h.c.snapshot(s.id);
    // Nothing is missing and the record is not rewritten.
    assert.ok(!snap.items.some((i) => i.id.endsWith(":tools-missing")));
    assert.equal(snap.session.nativeTools?.version, 1);
    assert.equal((await h.schedules(s.id)).filter((x) => x.kind === "wakeup").length, 2);
  } finally {
    await h.close();
  }
});

test("Claude Code: a new session gets the server 「daisy」; one resumed from before ADR-154 gets 「harbor」 and its tools work", async () => {
  const h = await setup();
  try {
    const s = await h.create("claude");
    await h.turn(s.id, tool("wakeup", { delaySeconds: 600, prompt: "新" }));
    let init = h.lines(h.record).filter((x) => x.via === "initialize").at(-1);
    assert.deepEqual(init.sdkMcpServers, ["daisy"]);
    assert.match(init.allowedTools, /mcp__daisy__wakeup/);
    assert.ok(!init.allowedTools.includes("harbor"));
    assert.match(init.text, /mcp__daisy__wakeup/);
    let snap = await h.c.snapshot(s.id);
    assert.equal(snap.session.nativeTools?.version, 2);
    assert.equal(snap.session.nativeTools?.thread, snap.session.nativeId);
    assert.match(h.toolResults().at(-1).result.text, /已设定定时器/);
    // Resumed with the new names, too.
    await h.restartRunner();
    await h.turn(s.id, "接着来");
    init = h.lines(h.record).filter((x) => x.via === "initialize").at(-1);
    assert.deepEqual(init.sdkMcpServers, ["daisy"]);
    // The same conversation as one started before ADR-154: no record.
    const old = h.ctx.store.session(s.id)!;
    delete old.nativeTools;
    h.ctx.store.save(old);
    await h.restartRunner();
    await h.turn(s.id, tool("wakeup", { delaySeconds: 600, prompt: "旧" }));
    init = h.lines(h.record).filter((x) => x.via === "initialize").at(-1);
    assert.deepEqual(init.sdkMcpServers, ["harbor"]);
    assert.match(init.allowedTools, /mcp__harbor__wakeup/);
    assert.ok(!init.allowedTools.includes("mcp__daisy__"));
    assert.match(init.text, /^【Daisy 定时与后台】.*mcp__harbor__wakeup/);
    const listed = h.lines(h.record).filter((x) => x.via === "daisy-tools-list").at(-1);
    assert.match(listed.text, /^wakeup,cron,/);
    const r = h.toolResults().at(-1);
    assert.equal(r.result.isError, false);
    assert.match(r.result.text, /已设定定时器/);
    snap = await h.c.snapshot(s.id);
    assert.equal(snap.session.nativeTools, undefined, "a resume records nothing");
  } finally {
    await h.close();
  }
});

/** Runs `f` with the process in time zone `tz`. */
function inZone(tz: string, f: () => void) {
  const was = process.env.TZ;
  process.env.TZ = tz;
  try {
    f();
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
}

test("times: the machine's own zone, named — never a fixed Beijing time (TZ=UTC and others)", () => {
  const at = Date.UTC(2026, 10, 5, 1, 0); // Thursday 01:00 UTC
  inZone("UTC", () => {
    assert.equal(zoneName(), "UTC");
    assert.equal(bothTimes(at), "11-05 周四 01:00（UTC）");
    assert.equal(cronText("0 9 * * *", 0), "每天 09:00（UTC）");
    assert.equal(midTurnMarker(at), "（主人在你工作中途追加，发出于 01:00，时区 UTC；此前你已在处理本轮任务）");
    assert.equal(when(at), "2026-11-05 01:00 UTC");
  });
  inZone("America/New_York", () => {
    const tz = localTimeZone(at);
    assert.deepEqual(tz, { name: "America/New_York", offsetMinutes: -300 });
    assert.equal(bothTimes(at), "11-04 周三 20:00（America/New_York）· 11-05 01:00 UTC");
    assert.equal(cronText("0 9 * * *", -300), "每天 09:00（America/New_York）· UTC 14:00");
    assert.equal(cronText("0 22 * * 1-5", -300), "工作日（周一至周五）22:00（America/New_York）· UTC 后一天 03:00");
    assert.equal(midTurnMarker(at, at + 15 * 60_000), "（主人在你工作中途追加，发出于 20:00，追加于 20:15，时区 America/New_York；此前你已在处理本轮任务）");
    assert.equal(when(at), "2026-11-04 20:00 America/New_York");
    const time = defaultSectionText("time", "codex");
    assert.match(time, /按服务器所在时区 America\/New_York/);
    assert.ok(!time.includes("北京"));
  });
  inZone("Asia/Kolkata", () => {
    const name = zoneName();
    assert.equal(name, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(cronText("30 9 * * 1-5", 330), `工作日（周一至周五）09:30（${name}）· UTC 04:00`);
    // A zone the caller names wins (a Runner writing the control plane's).
    assert.equal(cronText("0 9 * * *", 0, "UTC"), "每天 09:00（UTC）");
    assert.match(defaultSectionText("time", "claude", "daisy", "Europe/Berlin"), /按服务器所在时区 Europe\/Berlin/);
  });
  // A template's time of day is the server's own: no shift, in any zone.
  for (const tz of ["UTC", "America/New_York", "Asia/Kolkata"])
    inZone(tz, () => {
      assert.equal(templateCron({ kind: "daily", time: "09:00" }), "0 9 * * *");
      assert.equal(templateCron({ kind: "weekly", days: [1, 3], time: "23:30" }), "30 23 * * 1,3");
      assert.equal(templateCron({ kind: "hours", every: 6, minute: 5 }), "5 */6 * * *");
    });
});
