import { test } from "node:test";
import assert from "node:assert/strict";
import { DaisyClient } from "../packages/client/src/index.ts";
import { setup, tool, until } from "./fixtures/scheduler-harness.ts";
import {
  bothTimes,
  CronError,
  cronText,
  parseCron,
} from "../packages/contracts/src/scheduler.ts";
import { clip, isRedeliveryWake } from "../packages/daisy/src/schedule/scheduler.ts";
import { toolsFor } from "../packages/daisy/src/tools/daisy-tools.ts";
import { promptT } from "../packages/contracts/src/prompt-i18n.ts";
/**
 * P6-24 (ADR-159 §6): Daisy's scheduler and tools speak the session's
 * language to its model — tool descriptions, tool results, wake heads —
 * and the owner's language on the owner routes. Chinese stays as it was
 * (the other scheduler tests); these are the English side, and the
 * markers a reader matches in every language and in their old forms.
 */
const job = (session: Record<string, unknown>) =>
  ({ session: { kind: "ordinary", agent: "codex", ...session }, daisyTools: { version: 2 } }) as any;

test("tool descriptions follow the session's language; a session from before P6-24 (no lang) stays Chinese", () => {
  const en = toolsFor(job({ lang: "en" }));
  const wake = en.find((t) => t.name === "wakeup")!;
  assert.match(wake.description, /wake-up/);
  assert.match(wake.description, /instead of sleep/);
  assert.match(JSON.stringify(wake.inputSchema), /at least 60/);
  assert.ok(en.every((t) => !/[一-鿿]/.test(JSON.stringify(t))), "no Chinese in an English session's tools");
  const say = toolsFor(job({ lang: "en", kind: "resident" })).find((t) => t.name === "say")!;
  assert.match(say.description, /resident Agent/);
  // Same tools, same parameters, either language.
  const zh = toolsFor(job({ lang: "zh-CN" }));
  assert.deepEqual(
    zh.map((t) => [t.name, Object.keys((t.inputSchema as any).properties)]),
    en.map((t) => [t.name, Object.keys((t.inputSchema as any).properties)]),
  );
  assert.match(zh.find((t) => t.name === "wakeup")!.description, /^Daisy 定时唤醒（一次）/);
  assert.match(toolsFor(job({})).find((t) => t.name === "wakeup")!.description, /^Daisy 定时唤醒（一次）/);
});

test("redelivery wakes are recognised in every language and in their old spellings", () => {
  for (const head of [
    "[Daisy: delivering background reports late]x",
    "[Daisy: delivering external callbacks late]x",
    "【Daisy 补送后台回报】x",
    "【Daisy 补送外部回调】x",
    "【Harbor 补送后台回报】x",
    "【Harbor 补送外部回调】x",
  ])
    assert.ok(isRedeliveryWake(head), head);
  assert.ok(!isRedeliveryWake("[Daisy timer due] x"));
  assert.ok(!isRedeliveryWake("hello"));
});

test("cron words and errors in English; Chinese by default", () => {
  assert.equal(cronText("0 9 * * *", 0, "UTC", "en"), "Every day 09:00 (UTC)");
  assert.equal(cronText("0 22 * * 1-5", -300, "America/New_York", "en"), "Weekdays (Mon–Fri) 22:00 (America/New_York) · UTC the day after 03:00");
  assert.equal(cronText("30 9 * * 1,3", 0, "UTC", "en"), "Every Mon, Wed 09:30 (UTC)");
  assert.equal(cronText("*/15 * * * *", 0, "UTC", "en"), "Every 15 minutes");
  assert.equal(cronText("0 9 * * *", 0, "UTC"), "每天 09:00（UTC）");
  const at = Date.UTC(2026, 10, 5, 1, 0);
  assert.equal(bothTimes(at, { name: "UTC", offsetMinutes: 0 }, "en"), "11-05 Thu 01:00 (UTC)");
  assert.throws(() => parseCron("* * * *", "en"), /needs 5 fields/);
  assert.throws(() => parseCron("* * * *"), /5 段/);
  try {
    parseCron("61 * * * *");
    assert.fail("parsed");
  } catch (e) {
    // A caller says it in its own language.
    assert.ok(e instanceof CronError);
    assert.match(promptT("en").dynamic(e.key, e.params), /out of the range 0-59/);
  }
  assert.match(clip("a".repeat(5000), 1000, promptT("en")), /middle part left out/);
  assert.match(clip("a".repeat(5000), 1000), /中间省略/);
});

test("an English session: tool results and the wake head in English; the owner's errors in the request's language", async () => {
  const h = await setup();
  const kept = process.env.DAISY_LANG;
  try {
    // The owner's language when the session is created decides (newSessionLang).
    process.env.DAISY_LANG = "en";
    const s = await h.create("codex");
    process.env.DAISY_LANG = kept;
    assert.equal(h.ctx.store.session(s.id)!.lang, "en");
    await h.turn(s.id, tool("wakeup", { delaySeconds: 120, prompt: "check the build", reason: "build" }));
    const r = h.toolResults()[0].result.text;
    assert.match(r, /^Timer .+ set: it wakes you at /);
    const [wakeup] = await h.schedules(s.id);
    h.due(wakeup.id);
    await until(
      () => h.c.snapshot(s.id),
      (x) => x.items.some((i) => i.id.startsWith("wake:")),
    );
    await h.settle(s.id);
    const told = h
      .lines(h.record)
      .filter((x) => x.via === "turn/start")
      .at(-1);
    assert.match(told.text, /\[Daisy timer due\] build/);
    assert.match(told.text, /\(timer ID /);
    // The owner adds a timer with a bad cron: her language, the stable code.
    const bad = { kind: "cron", cron: "* * * * * *", prompt: "x" };
    DaisyClient.language = "en";
    await assert.rejects(h.c.request(`/sessions/${s.id}/schedules`, "POST", bad), (e: any) => {
      assert.match(String(e.message), /Invalid cron: a cron expression needs 5 fields/);
      assert.equal(e.code, "cron_invalid");
      return true;
    });
    DaisyClient.language = "zh-CN";
    await assert.rejects(h.c.request(`/sessions/${s.id}/schedules`, "POST", bad), /cron 无效：cron 需要 5 段/);
  } finally {
    DaisyClient.language = undefined;
    process.env.DAISY_LANG = kept;
    await h.close();
  }
});
